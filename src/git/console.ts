/**
 * The git pane's command line: one shell command at a time per job, run in the
 * repository root, output streamed to the browser by long-poll. Not a PTY:
 * programs that need a real terminal (full-screen editors, pagers) belong in
 * the sidebar terminal, which the pane opens on request. Pagers and credential
 * prompts are disabled so a command can never hang waiting for a TTY; stdin
 * stays open, so line-based prompts still work through the input field.
 *
 * It also reaches into DSH's terminal controller, which the pane's terminals run on: to
 * tell which of them are running a command, and to start one in a folder of the workspace.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { Gate } from './service.ts'
import { runGit } from './service.ts'
import { killTree } from '../exec.ts'

export const CONSOLE_METHOD = 'agent-hub/console'

export interface ConsoleChunk {
  seq: number
  text: string
  stream: 'out' | 'err'
}

export interface ConsoleRead {
  chunks: ConsoleChunk[]
  /** Exit code once finished (`null` when killed by a signal). */
  exit?: number | null
  /** Older output was dropped to stay under the cap. */
  dropped: boolean
}

export interface ConsoleStart {
  id: string
  cwd: string
  shell: string
}

interface Job {
  id: string
  child: ChildProcess
  chunks: ConsoleChunk[]
  size: number
  seq: number
  dropped: boolean
  exit?: number | null
  finishedAt?: number
  waiters: Set<() => void>
}

const JOB_CAP = 2 << 20
const KEEP_MS = 5 * 60_000
/** A waiting read woken by output lingers this long, so a burst of output goes back in one reply. */
const BATCH_MS = 30
// Long-poll hold; must stay under the Desktop update lock's 10s request-drain deadline.
const POLL_MS = 5_000

let shellCache: { file: string; args: (command: string) => string[]; name: string } | undefined

/** PowerShell 7 if installed, else Windows PowerShell; elsewhere the login shell. */
function shell(): NonNullable<typeof shellCache> {
  if (shellCache !== undefined) return shellCache
  if (process.platform === 'win32') {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    const pwsh = dirs.map((dir) => join(dir, 'pwsh.exe')).find((file) => existsSync(file))
    const file = pwsh ?? 'powershell.exe'
    shellCache = {
      file,
      name: pwsh ? 'pwsh' : 'powershell',
      // UTF-8 out, so Chinese paths and messages survive the pipe.
      args: (command) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}`],
    }
  } else {
    const file = process.env.SHELL || '/bin/sh'
    shellCache = { file, name: file.split('/').pop() ?? 'sh', args: (command) => ['-c', command] }
  }
  return shellCache
}

const running = (child: ChildProcess): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null

export type TerminalActivity = 'busy' | 'idle' | 'unknown'

/** The parts of DSH's terminal controller the activity probe reads; none of them are public API. */
interface ControllerShape {
  owners?: { get(sessionId: string): { terminals?: TerminalMap } | undefined }
}
interface TerminalMap {
  get(id: string): { handle?: TerminalHandle } | undefined
}
/** dsh-subprocess-local's terminal handle, as far as the probe reads it. */
interface TerminalHandle {
  inspectActivity?(): Promise<{ state?: unknown }>
  /** The shell's pid as the handle captured it at spawn. */
  pid?: number
  /** node-pty's process, whose pid is the live one. */
  terminal?: { pid?: number }
  /** DSH's process-table reader. */
  inspector?: { snapshot(): { tree(pid: number): Array<{ pid?: number }> } }
}

/**
 * DSH's own answer, else the same process table read for the live shell pid. With ConPTY on
 * Windows, node-pty reports the shell's pid only after spawn returns, so the handle captured 0
 * and DSH's probe can never see the shell's children (it answers `unknown` for good). The live
 * pid is node-pty's; the shell runs a command exactly when its process tree holds more than itself.
 */
async function probeHandle(handle: TerminalHandle | undefined): Promise<TerminalActivity> {
  const live = handle?.terminal?.pid
  const stale = !(typeof handle?.pid === 'number' && handle.pid > 0) && typeof live === 'number' && live > 0
  if (!stale) {
    const result = typeof handle?.inspectActivity === 'function' ? await handle.inspectActivity() : undefined
    return result?.state === 'busy' || result?.state === 'idle' ? result.state : 'unknown'
  }
  if (live === undefined || typeof handle?.inspector?.snapshot !== 'function') return 'unknown'
  const tree = handle.inspector.snapshot().tree(live)
  if (!tree.some((member) => member.pid === live)) return 'unknown'
  return tree.some((member) => member.pid !== live) ? 'busy' : 'idle'
}

/** Most terminals one probe looks at (DSH allows 8 per Session). */
const PROBE_MAX = 32

/**
 * Whether each of a Session's terminals is running a command, by DSH's own probe: the one its
 * idle reclamation uses (live child processes, the foreground process group on macOS and Linux,
 * prompt hooks in bash and zsh), with its process table read for the live pid where the probe
 * holds a stale one (see `probeHandle`). Anything that cannot be read, a terminal gone or a
 * controller shaped differently, is `unknown`, which the pane treats as not running.
 */
export async function terminalActivity(controller: unknown, sessionId: string, ids: readonly string[]): Promise<Record<string, TerminalActivity>> {
  const out: Record<string, TerminalActivity> = {}
  let terminals: TerminalMap | undefined
  try {
    terminals = (controller as ControllerShape | undefined)?.owners?.get(sessionId)?.terminals
  } catch {
    terminals = undefined
  }
  // One at a time: each probe is a synchronous process-table read on the host's event loop.
  for (const id of ids.slice(0, PROBE_MAX)) {
    let state: TerminalActivity = 'unknown'
    try {
      state = await probeHandle(terminals?.get(id)?.handle)
    } catch {
      // Unreadable: unknown.
    }
    out[id] = state
  }
  return out
}

/** How long a folder waits for the Session's next terminal (see `startIn`). */
const START_MS = 15_000

/** DSH's terminal controller, as far as `startIn` reaches into it; not public API either. */
interface SpawnShape {
  spawn(agent: { id?: string } | undefined, owner: unknown, request: unknown, signal: unknown): Promise<unknown>
  environment(agent: unknown, signal: unknown): { cwd?: string }
}

/** One wrapped controller: the folders its Sessions' next terminals start in, and the undo. */
interface Starts {
  controller: object
  pending: Map<string, { dir: string; until: number }>
  restore(): void
}

/**
 * Wrap the controller's spawn so a Session's next new shell starts in a pending folder instead
 * of the Session folder, which DSH gives every terminal (VS Code passes the folder as the pty's
 * cwd the same way). The rest of the spawn is DSH's own, run against the controller with only
 * its environment's `cwd` replaced. Undefined when the controller is not shaped for it.
 */
export function wrapSpawn(controller: unknown): Starts | undefined {
  const shape = controller as Partial<SpawnShape> | null | undefined
  if (shape == null || typeof shape.spawn !== 'function' || typeof shape.environment !== 'function') return undefined
  const pending: Starts['pending'] = new Map()
  const original = shape.spawn
  const wrapped: SpawnShape['spawn'] = function (this: SpawnShape, agent, owner, request, signal) {
    const id = agent?.id ?? ''
    const start = pending.get(id)
    pending.delete(id)
    if (start === undefined || start.until < Date.now()) return original.call(this, agent, owner, request, signal)
    const self = Object.create(this, {
      environment: { value: (a: unknown, s: unknown) => ({ ...this.environment(a, s), cwd: start.dir }) },
    }) as SpawnShape
    return original.call(self, agent, owner, request, signal)
  }
  shape.spawn = wrapped
  return {
    controller: shape,
    pending,
    restore: () => {
      if (shape.spawn === wrapped) shape.spawn = original
    },
  }
}

export class ConsoleService {
  private readonly jobs = new Map<string, Job>()
  private seq = 0
  private readonly gate: Gate
  private readonly terminals: () => unknown
  private starts: Starts | undefined

  /** @param terminals - DSH's terminal controller, when the host runs one. */
  constructor(gate: Gate, terminals: () => unknown = () => undefined) {
    this.gate = gate
    this.terminals = terminals
  }

  async handle(payload: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }> {
    try {
      switch (payload.op) {
        case 'run': return { ok: true, value: await this.run(payload.cwd, payload.command) }
        case 'read': return { ok: true, value: await this.read(String(payload.id), Number(payload.since ?? 0)) }
        case 'input': this.input(String(payload.id), String(payload.text ?? '')); return { ok: true, value: null }
        case 'kill': this.kill(String(payload.id)); return { ok: true, value: null }
        case 'activity': {
          const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === 'string') : []
          return { ok: true, value: await terminalActivity(this.terminals(), String(payload.sessionId ?? ''), ids) }
        }
        case 'start-in': return { ok: true, value: await this.startIn(String(payload.sessionId ?? ''), payload.dir) }
        default: return { ok: false, error: { code: 'invalid', message: 'unknown console operation' } }
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return { ok: false, error: { code: typeof code === 'string' ? code : 'failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  private async run(cwdValue: unknown, commandValue: unknown): Promise<ConsoleStart> {
    const command = typeof commandValue === 'string' ? commandValue.trim() : ''
    if (command === '' || command.length > 8000) throw Object.assign(new Error('empty command'), { code: 'invalid' })
    const cwd = await this.gate(cwdValue as string)
    if (cwd === undefined) throw Object.assign(new Error('directory is not inside a workspace'), { code: 'denied' })
    // The project folder: the repository root when there is one.
    const top = await runGit(['rev-parse', '--show-toplevel'], cwd, { read: true })
    const root = top.code === 0 && !top.overflow && !top.truncated && !top.timedOut && top.stdout.trim() !== '' ? top.stdout.trim() : cwd
    this.sweep()
    const sh = shell()
    const child = spawn(sh.file, sh.args(command), {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        // Colors even though stdout is a pipe: git, and tools that honor FORCE_COLOR.
        FORCE_COLOR: '1', CLICOLOR_FORCE: '1', TERM: 'xterm-256color',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.ui', GIT_CONFIG_VALUE_0: 'always',
      },
    })
    const id = `c${++this.seq}-${Date.now().toString(36)}`
    const job: Job = { id, child, chunks: [], size: 0, seq: 0, dropped: false, waiters: new Set() }
    this.jobs.set(id, job)
    const push = (stream: 'out' | 'err') => (data: Buffer): void => {
      const text = data.toString('utf8')
      job.chunks.push({ seq: ++job.seq, text, stream })
      job.size += text.length
      while (job.size > JOB_CAP && job.chunks.length > 1) {
        job.size -= job.chunks.shift()!.text.length
        job.dropped = true
      }
      this.wake(job)
    }
    child.stdout!.on('data', push('out'))
    child.stderr!.on('data', push('err'))
    child.stdin!.on('error', () => {})
    child.on('error', (error) => {
      job.chunks.push({ seq: ++job.seq, text: `${error.message}\n`, stream: 'err' })
      job.exit ??= 127
      job.finishedAt = Date.now()
      this.wake(job)
    })
    child.on('close', (code) => {
      job.exit = code
      job.finishedAt = Date.now()
      this.wake(job)
    })
    return { id, cwd: root, shell: sh.name }
  }

  /**
   * The Session's next new terminal starts in `dir`, a folder inside a workspace (once, if it
   * comes within START_MS). False when DSH's controller cannot be made to: it then starts in the
   * Session folder, as always.
   */
  private async startIn(sessionId: string, dirValue: unknown): Promise<boolean> {
    const dir = await this.gate(dirValue as string)
    if (dir === undefined) throw Object.assign(new Error('directory is not inside a workspace'), { code: 'denied' })
    if (!(await stat(dir)).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'invalid' })
    const controller = this.terminals()
    if (this.starts?.controller !== controller) {
      this.starts?.restore()
      this.starts = wrapSpawn(controller)
    }
    this.starts?.pending.set(sessionId, { dir, until: Date.now() + START_MS })
    return this.starts !== undefined
  }

  private wake(job: Job): void {
    for (const wake of [...job.waiters]) wake()
  }

  /** Output after `since`; waits up to POLL_MS when there is none yet and the job is still running. */
  private async read(id: string, since: number): Promise<ConsoleRead> {
    const job = this.jobs.get(id)
    if (job === undefined) throw Object.assign(new Error('this command is no longer available'), { code: 'gone' })
    const collect = (): ConsoleRead => ({
      chunks: job.chunks.filter((chunk) => chunk.seq > since),
      ...(job.exit !== undefined ? { exit: job.exit } : {}),
      dropped: job.dropped,
    })
    if (job.seq > since || job.exit !== undefined) return collect()
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        job.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, POLL_MS)
      job.waiters.add(wake)
    })
    if (job.seq > since && job.exit === undefined) await new Promise((resolve) => setTimeout(resolve, BATCH_MS))
    return collect()
  }

  private input(id: string, text: string): void {
    const job = this.jobs.get(id)
    if (job === undefined || job.exit !== undefined) return
    job.child.stdin?.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  private kill(id: string): void {
    const job = this.jobs.get(id)
    if (job !== undefined && running(job.child)) killTree(job.child)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt > KEEP_MS) this.jobs.delete(id)
    }
  }

  dispose(): void {
    this.starts?.restore()
    this.starts = undefined
    for (const job of this.jobs.values()) {
      if (running(job.child)) killTree(job.child)
      this.wake(job)
    }
    this.jobs.clear()
  }
}
