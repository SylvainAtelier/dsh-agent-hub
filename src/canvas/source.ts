/**
 * The session a canvas came from, read from DSH's session logs. Every model leaves the page's
 * path behind there: a native agent's write call, a `present` call, and the reply that links it
 * (the only trace Claude Agent and Cursor leave, since they run their tools in their own
 * processes). The strongest trace wins, a write over a presentation over a mention; among equals,
 * the one closest in time to the page's last write. A subagent's trace counts for its parent.
 */

import { open, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { completeFrames, eachLimited, listLogs } from '../usage/tokens.ts'
import type { CanvasSource } from './types.ts'

const inflate = promisify(zstdDecompress)

/** A log last written this long before the page cannot hold its write. */
const SLACK_MS = 60_000
const WRITE_TOOL = /write|edit|patch|create/i

interface Trace {
  session: string
  strength: number
  /** Distance from the page's mtime. */
  distance: number
}

/** The ways a path is spelled in a log line: as is, JSON-escaped once (a message) and twice (tool arguments). */
function needles(path: string): string[] {
  const once = JSON.stringify(path).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  return [...new Set([path, path.replaceAll('\\', '/'), once, twice])]
}

/** How strongly an event says its session made the page; 0 when it says nothing. */
function strength(event: { type?: unknown; data?: { name?: unknown } }): number {
  switch (event.type) {
    case 'tool/call': return typeof event.data?.name === 'string' && WRITE_TOOL.test(event.data.name) ? 3 : 1
    case 'deliverables/presented': return 2
    case 'assistant/message': return 1
    default: return 0
  }
}

async function readLog(path: string): Promise<string> {
  const handle = await open(path, 'r')
  let bytes: Buffer
  try {
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const parts: string[] = []
  for (const [start, end] of completeFrames(bytes)) {
    try {
      parts.push((await inflate(bytes.subarray(start, end))).toString('utf8'))
    } catch {
      break
    }
  }
  return parts.join('')
}

interface Header { id?: string; origin?: string; parentSession?: string }

/** The session behind the page at `path` last written at `mtime`, with its title; undefined when no log names it. */
export async function findSource(root: string, path: string, mtime: number, archived: (id: string) => boolean = () => false): Promise<CanvasSource | undefined> {
  const logs = await listLogs(root)
  const marks = needles(path)
  const titles = new Map<string, string>()
  let best: Trace | undefined
  await eachLimited(logs, async ([dir, log]) => {
    try {
      if ((await stat(log)).mtimeMs < mtime - SLACK_MS) return
      const text = await readLog(log)
      let header: Header | undefined
      let title: string | undefined
      let found: Trace | undefined
      for (const line of text.split('\n')) {
        if (header === undefined && line.startsWith('{"type":"session"')) {
          try { header = JSON.parse(line) as Header } catch { /* unreadable header */ }
          continue
        }
        if (line.startsWith('{"type":"session/title"')) {
          try { title = (JSON.parse(line) as { data?: { title?: unknown } }).data?.title as string | undefined } catch { /* keep the last */ }
          continue
        }
        if (!marks.some((mark) => line.includes(mark))) continue
        let event: { type?: unknown; time?: unknown; data?: { name?: unknown } }
        try { event = JSON.parse(line) } catch { continue }
        const level = strength(event)
        if (level === 0) continue
        const distance = Math.abs((typeof event.time === 'number' ? event.time : 0) - mtime)
        if (found === undefined || level > found.strength || (level === found.strength && distance < found.distance)) found = { session: dir, strength: level, distance }
      }
      const id = header?.id ?? dir
      if (typeof title === 'string' && title !== '') titles.set(id, title)
      if (found === undefined) return
      const session = header?.origin === 'subagent' && header.parentSession !== undefined ? header.parentSession : id
      if (archived(session)) return
      found.session = session
      if (best === undefined || found.strength > best.strength || (found.strength === best.strength && found.distance < best.distance)) best = found
    } catch {
      // A log being rotated or deleted: skipped.
    }
  })
  if (best === undefined) return undefined
  const { session } = best as Trace
  const title = titles.get(session)
  return { sessionId: session, ...(title === undefined ? {} : { title }) }
}
