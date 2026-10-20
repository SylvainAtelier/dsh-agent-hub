/**
 * Qoder CLI CN's own record of its sessions: one JSON-lines file each, under
 * `~/.qoder-cn/projects/<folder>/<session>.jsonl`, whoever started it (the
 * remote-control daemon for the glasses, the app and qoder.cn; the terminal;
 * DSH's ACP route). Read only, and parsed again only when a file changed.
 * Measured against Qoder CLI CN 1.1.73: a line per prompt, answer part, tool
 * call and tool result (`user` / `assistant`, with `cwd`, `gitBranch`,
 * `entrypoint`, a `timestamp` in ms or ISO), plus bookkeeping lines.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { toolOf } from '../qoder/daemon.ts'
import type { Turn } from './types.ts'

export interface QoderSession {
  id: string
  /** Who started it: `remote-control`, `cli`, … (its first prompt's entrypoint). */
  entrypoint?: string
  cwd?: string
  branch?: string
  /** The model id its last prompt went to (`auto`, `qmodel_38max`, …). */
  model?: string
  /** Its first prompt. */
  title?: string
  startedAt: number
  updatedAt: number
  prompts: number
  /** An answer is under way: the last line is a prompt, a tool call or its result. */
  waiting: boolean
  /** The last answer's opening. */
  last?: string
}

export interface QoderFile {
  id: string
  file: string
  mtime: number
  size: number
}

/** Files read for the list, newest first. */
const KEEP_FILES = 80
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const TEXT_MAX = 8000

const time = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** An answer's opening on one line: its Markdown marks (headings, emphasis, code, quotes, table bars) dropped. */
export const preview = (text: string, max = 200): string => clip(text.replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/[*`|]+/g, ' ').replace(/^-{3,}$/gm, ''), max)

const long = (text: string): string => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text)

interface Line {
  type?: unknown
  timestamp?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  entrypoint?: unknown
  cwd?: unknown
  gitBranch?: unknown
  businessModelKey?: unknown
  model?: unknown
  message?: { content?: unknown }
}

/** A prompt's text, without the reminders a harness put in front; undefined for a tool result. */
export function promptText(content: unknown): string | undefined {
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some((part) => (part as { type?: unknown })?.type === 'tool_result')) return undefined
    text = content.map((part) => ((part as { type?: unknown })?.type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('\n')
  } else return undefined
  const stripped = text.replace(REMINDER, '').trim()
  return stripped === '' || stripped.startsWith('[Request interrupted') ? undefined : stripped
}

/** A session file: what the list shows and, with `turns`, the conversation. */
export function parseQoder(id: string, text: string, turns?: Turn[]): QoderSession | undefined {
  const session: QoderSession = { id, startedAt: 0, updatedAt: 0, prompts: 0, waiting: false }
  let any = false
  const add = (turn: Turn): void => {
    if (turns === undefined) return
    const previous = turns[turns.length - 1]
    // An answer streams as one line per part: its text parts join up.
    if (turn.role === 'assistant' && previous?.role === 'assistant') previous.text += turn.text
    else turns.push(turn)
  }
  for (const raw of text.split('\n')) {
    if (raw === '' || raw[0] !== '{') continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    if (line.type === 'runtime-config' && typeof line.model === 'string') session.model = line.model
    if (line.type !== 'user' && line.type !== 'assistant') continue
    if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true) continue
    const at = time(line.timestamp)
    if (at !== undefined) {
      if (session.startedAt === 0) session.startedAt = at
      session.updatedAt = Math.max(session.updatedAt, at)
    }
    if (typeof line.cwd === 'string') session.cwd ??= line.cwd
    if (typeof line.gitBranch === 'string' && line.gitBranch !== '') session.branch = line.gitBranch
    const content = line.message?.content
    if (line.type === 'user') {
      const prompt = promptText(content)
      session.waiting = true
      if (prompt === undefined) continue
      any = true
      session.prompts++
      if (typeof line.entrypoint === 'string') session.entrypoint ??= line.entrypoint
      if (typeof line.businessModelKey === 'string') session.model = line.businessModelKey
      session.title ??= clip(prompt, 160)
      add({ role: 'user', text: long(prompt), ...(at === undefined ? {} : { at }) })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content as Array<{ type?: unknown; text?: unknown; name?: unknown; input?: unknown }>) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
        session.waiting = false
        session.last = preview(part.text)
        add({ role: 'assistant', text: part.text, ...(at === undefined ? {} : { at }) })
      } else if (part?.type === 'tool_use' && typeof part.name === 'string') {
        session.waiting = true
        add({ role: 'tool', text: toolOf(part.name, part.input as Record<string, unknown> | undefined), ...(at === undefined ? {} : { at }) })
      }
    }
  }
  if (turns !== undefined) for (const turn of turns) if (turn.role === 'assistant') turn.text = long(turn.text.trim())
  return any ? session : undefined
}

const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class QoderSessions {
  private cache = new Map<string, { stamp: string; session: QoderSession | undefined }>()
  private readonly root: string
  private readonly scratch: string

  constructor(root = join(homedir(), '.qoder-cn', 'projects'), scratch = tmpdir()) {
    this.root = root
    this.scratch = process.platform === 'win32' ? scratch.toLowerCase() : scratch
  }

  /** Every session file, newest first. */
  async files(): Promise<QoderFile[]> {
    const found: QoderFile[] = []
    let folders: string[]
    try {
      folders = await readdir(this.root)
    } catch {
      return []
    }
    await Promise.all(folders.map(async (folder) => {
      let names: string[]
      try {
        names = await readdir(join(this.root, folder))
      } catch {
        return
      }
      await Promise.all(names.filter((name) => name.endsWith('.jsonl')).map(async (name) => {
        const file = join(this.root, folder, name)
        try {
          const info = await stat(file)
          found.push({ id: name.slice(0, -'.jsonl'.length), file, mtime: info.mtimeMs, size: info.size })
        } catch { /* Gone meanwhile. */ }
      }))
    }))
    return found.sort((a, b) => b.mtime - a.mtime)
  }

  /** The newest sessions; ones run in a scratch folder (probes) left out. */
  async list(files?: QoderFile[]): Promise<QoderSession[]> {
    const all = (files ?? await this.files()).slice(0, KEEP_FILES)
    const sessions: QoderSession[] = []
    const seen = new Set<string>()
    for (const entry of all) {
      seen.add(entry.file)
      const stamp = `${entry.mtime}:${entry.size}`
      let cached = this.cache.get(entry.file)
      if (cached?.stamp !== stamp) {
        let session: QoderSession | undefined
        try {
          session = parseQoder(entry.id, await readFile(entry.file, 'utf8'))
        } catch { /* Unreadable for now: left out. */ }
        cached = { stamp, session }
        this.cache.set(entry.file, cached)
      }
      const session = cached.session
      if (session === undefined) continue
      const cwd = session.cwd === undefined ? undefined : process.platform === 'win32' ? session.cwd.toLowerCase() : session.cwd
      if (cwd !== undefined && inside(this.scratch, cwd)) continue
      // A session's last line may be older than the file (a bookkeeping line): the file says when it moved.
      sessions.push({ ...session, updatedAt: Math.max(session.updatedAt, entry.mtime) })
    }
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file)
    return sessions
  }

  /** A session's conversation, or undefined when there is no such file. */
  async read(id: string): Promise<{ session: QoderSession; turns: Turn[] } | undefined> {
    const entry = (await this.files()).find((file) => file.id === id)
    if (entry === undefined) return undefined
    const turns: Turn[] = []
    const session = parseQoder(id, await readFile(entry.file, 'utf8'), turns)
    return session === undefined ? undefined : { session: { ...session, updatedAt: Math.max(session.updatedAt, entry.mtime) }, turns }
  }
}
