/**
 * Telling the glasses something: a message into one of their Qoder sessions,
 * posted the way the Qoder app does (`qoderclicn --remote-session <id> <text>`,
 * a client of the session). Its worker answers on this machine, and the
 * glasses announce the answer like any other.
 *
 * Measured against Qoder CLI CN 1.1.73: that client refuses to run without a
 * terminal ("require interactive mode"), so it runs under a pseudo-terminal:
 * DSH's own node-pty, loaded in a child with the host's runtime (a native
 * module stays out of the host process). A session whose environment has no
 * worker answers `WorkerOffline`. The message has landed once the session's
 * transcript (written by its worker) holds it; the client is closed soon after.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { within } from '../git/service.ts'
import { localized } from '../locale.ts'
import type { WorkspaceView } from '../qoder/types.ts'

export type Posted = 'sent' | 'offline' | 'failed'

/** The header every message starts with: what the worker is asked to do with it, and how the helper finds it in the transcript. */
export const POST_HEADER = '【DSH 通知】'
/** {@link POST_HEADER} for an English UI; the helper finds either. */
export const POST_HEADER_EN = '[DSH notice] '

/** The header in the UI language. */
export function postHeader(): string {
  return localized({ zh: POST_HEADER, en: POST_HEADER_EN })
}

const SCRIPT_NAME = 'qoder-post.cjs'
const TIMEOUT_MS = 90_000

/** The helper, run as `node qoder-post.cjs <node-pty> <cli> <session> <cwd> <transcript> <text> <timeout>`; exit 0 sent, 3 offline, 4 failed. */
export const POST_SCRIPT = `'use strict'
// Written by dsh-agent-hub (src/bridge/post.ts): post a message into a Qoder remote session.
const fs = require('node:fs')
const [ptyPath, cli, session, cwd, transcript, text, timeoutMs] = process.argv.slice(2)
const headers = ${JSON.stringify([POST_HEADER, POST_HEADER_EN])}
const sizeOf = () => { try { return fs.statSync(transcript).size } catch { return 0 } }
const start = sizeOf()
const fresh = () => {
  try {
    const size = sizeOf()
    if (size <= start) return ''
    const length = Math.min(size - start, 1 << 20)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(transcript, 'r')
    fs.readSync(fd, buffer, 0, length, size - length)
    fs.closeSync(fd)
    return buffer.toString('utf8')
  } catch { return '' }
}
let child
let landed = 0
let done = false
const finish = (code) => {
  if (done) return
  done = true
  clearInterval(poll)
  clearTimeout(timer)
  try { child && child.kill() } catch {}
  setTimeout(() => process.exit(code), 300)
}
try {
  child = require(ptyPath).spawn(cli, ['--remote-session', session, text], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env })
} catch (error) {
  process.stderr.write(String(error && error.message || error))
  process.exit(4)
}
let out = ''
child.onData((data) => {
  out = (out + data).slice(-20000)
  if (/WorkerOffline|worker is offline/.test(out)) finish(3)
})
child.onExit(() => finish(landed ? 0 : 4))
const poll = setInterval(() => {
  const tail = fresh()
  const at = Math.min(...headers.map((header) => tail.indexOf(header)).filter((index) => index >= 0))
  if (at === Infinity) return
  landed = landed || Date.now()
  // Its answer begun, or a little while for it: the worker goes on without this client.
  if (tail.indexOf('"type":"assistant"', at) >= 0 || Date.now() - landed > 15000) finish(0)
}, 500)
const timer = setTimeout(() => finish(landed ? 0 : 4), Number(timeoutMs))
`

/**
 * Where a message can go, best first: the glasses' sessions in workspaces online here, those whose
 * worker answered (newest first), then those whose worker was reclaimed, then those only Qoder's own
 * records (`recorded`, newest first) still know: a daemon starts listing none, so after DSH starts
 * these are all there is. For either of the last two the service dispatches a worker again.
 */
export function glassesTargets(workspaces: readonly WorkspaceView[], recorded: ReadonlyArray<{ id: string; cwd: string }>): Array<{ session: string; cwd: string }> {
  const live: Array<{ session: string; cwd: string; at: number }> = []
  const dormant: typeof live = []
  const online = workspaces.filter((workspace) => workspace.phase === 'online')
  for (const workspace of online) {
    for (const task of workspace.tasks) {
      const entry = { session: task.id, cwd: workspace.path, at: task.updatedAt }
      if (task.worker !== undefined && (task.phase === 'idle' || task.phase === 'failed')) live.push(entry)
      else if (task.phase === 'dormant') dormant.push(entry)
    }
  }
  const newest = (a: { at: number }, b: { at: number }): number => b.at - a.at
  const targets = [...live.sort(newest), ...dormant.sort(newest)].map(({ session, cwd }) => ({ session, cwd }))
  // Ones the daemons know, at work or listed, are theirs to place.
  const known = new Set(online.flatMap((workspace) => workspace.tasks.map((task) => task.id)))
  for (const { id, cwd } of recorded) {
    const workspace = known.has(id) ? undefined : online.find((entry) => within(entry.path, cwd))
    if (workspace !== undefined) targets.push({ session: id, cwd: workspace.path })
  }
  return targets
}

/**
 * DSH's node-pty, inside the app's archive next to the runtime (Windows and Linux: `resources/`;
 * macOS: `../Resources/`). Found by its native half, unpacked on disk (a plain stat cannot see
 * into the archive); loaded from the archive path, which the host's runtime reads.
 */
export function findPty(execPath: string = process.execPath, exists: (path: string) => boolean = existsSync): string | undefined {
  const base = dirname(execPath)
  const resources = [join(base, 'resources'), join(base, '..', 'Resources')]
    .find((path) => exists(join(path, 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty')))
  return resources === undefined ? undefined : join(resources, 'app.asar', 'dsh', 'node_modules', 'node-pty')
}

export interface PostOptions {
  /** The runtime that runs the helper: the host's own. */
  node: string
  /** Where the helper is written. */
  script: string
  pty: string
  cli: string
  /** Test seam. */
  spawn?(command: string, args: readonly string[]): ChildProcess
}

/** Write the helper when it changed. */
export async function installPost(script: string): Promise<void> {
  await mkdir(dirname(script), { recursive: true })
  if (await readFile(script, 'utf8').catch(() => '') !== POST_SCRIPT) await writeFile(script, POST_SCRIPT)
}

/** Post `text` (one line, {@link postHeader} first) into `session`; `transcript` is its JSON-lines file. */
export function post(options: PostOptions, target: { session: string; cwd: string; transcript: string }, text: string): Promise<Posted> {
  const args = [options.script, options.pty, options.cli, target.session, target.cwd, target.transcript, text, String(TIMEOUT_MS)]
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = options.spawn?.(options.node, args)
        ?? spawn(options.node, args, { cwd: target.cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true })
    } catch {
      resolve('failed')
      return
    }
    // The helper ends itself; this only guards against one that hangs.
    const guard = setTimeout(() => { child.kill() }, TIMEOUT_MS + 15_000)
    child.once('error', () => { clearTimeout(guard); resolve('failed') })
    child.once('exit', (code) => {
      clearTimeout(guard)
      resolve(code === 0 ? 'sent' : code === 3 ? 'offline' : 'failed')
    })
  })
}
