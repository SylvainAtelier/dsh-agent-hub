/**
 * Qoder remote control for the glasses: one `qoderclicn remote-control`
 * daemon per configured workspace, run by DSH for as long as DSH runs. The
 * glasses (and the Qoder app, and qoder.cn/agents) send tasks to it through
 * the Qoder CN account; each runs on this machine in the workspace itself
 * (`--spawn same-dir`): no worktree unless the task asks for one, which the
 * agent then makes in DSH's worktree folder (`<repo>/.worktrees/qoder/<name>`,
 * through the hooks worktree.ts writes before each start).
 *
 * The daemon is read from its output (`--verbose`): its status block (online,
 * the environment id, the sessions it holds) and each worker's stream-json
 * lines (the task, the tool in progress, the answer, a failure).
 * Measured against Qoder CLI CN 1.1.73:
 * - Every task has a worker process of its own (some 250 MB), kept after it
 *   answers, for follow-ups, until it is archived in the app. A worker holds
 *   nothing of its own: a follow-up to a task without one has the service
 *   dispatch it again, and a new worker restores the conversation from the
 *   server in a few seconds. Yet a daemon that starts restores a worker for
 *   every task its workers file lists. So every start begins with that file
 *   emptied (cli.ts), once the last run's workers have exited: DSH starting,
 *   a crash, a reclaim alike bring up no idle worker. Reclaiming is then a
 *   restart, once every task has been answered and idle for `idleMinutes`.
 *   Killing a worker alone would not do: the daemon takes that for a crash,
 *   retries, then blocks the task.
 * - A worker can fail on the service's side ("Remote projection queue is
 *   unavailable"): the app may keep showing it as running, so the failure
 *   is surfaced here.
 * - Workers run in the CLI's `auto` permission mode (decided by the service).
 *
 * A daemon that exits, or loses its connection, starts again by itself with a
 * growing delay; one stopped here stays stopped until started again.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename } from 'node:path'
import { killTree } from '../exec.ts'
import { clearWorkers, INSTALL_HINT, type Cleared } from './cli.ts'
import type { Probe, ProcSample } from './probe.ts'
import { sessionUrl, type DaemonPhase, type ProcView, type QoderStatus, type QoderUpdate, type TaskPhase, type TaskView, type WorkspaceView } from './types.ts'

export interface QoderSettings {
  workspaces: readonly string[]
  /** Answered tasks' workers are reclaimed after this many idle minutes; 0 keeps them. */
  idleMinutes: number
  autoStart: boolean
}

/** Tasks kept per workspace, newest first. */
const KEEP_TASKS = 30
/** Archived tasks stay listed this long. */
const KEEP_CLOSED_MS = 6 * 60 * 60_000
/** Delays before starting a daemon again; online for a while resets them. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000]
const STEADY_MS = 120_000
/** How long a lookup of the CLI is trusted; a start always looks again. */
const FIND_TTL_MS = 60_000

// Terminal colours and cursor moves.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const SESSION_PREFIX = /^\[(qs_[A-Za-z0-9]+)\] /
/** How a worker's tool-result and token-delta lines start (stream-json writes the keys in this order). */
const TOOL_RESULT = '{"type":"user","message":{"role":"user","content":[{"type":"tool_result"'
const STREAM_EVENT = '{"type":"stream_event"'
/** A line longer than this is dropped unread: nothing the panel shows is ever that long. */
const MAX_LINE = 1 << 20
/** Changes within this window wake a long poll once. */
const WAKE_MS = 100
/** How long a status read waits for a change; under the Desktop update lock, which drains requests for at most 10s. */
const WAIT_MS = 5_000
/** Processes are sampled while a status read came this recently (a panel shown). */
const WATCH_MS = 15_000
const MB = 1 << 20
/** Before a start: how often, and how many times, to wait for the last run's workers to exit and its workers file to take the change. */
const SETTLE_MS = 500
const SETTLE_TRIES = 20

/**
 * Split a stream into lines in one pass per chunk, handing each to `line`. A
 * line past MAX_LINE is dropped as it arrives instead of being buffered.
 */
export function lineReader(line: (text: string) => void): (chunk: string) => void {
  let rest = ''
  let skipping = false
  return (chunk) => {
    let start = 0
    let end: number
    while ((end = chunk.indexOf('\n', start)) >= 0) {
      if (!skipping) line(rest === '' ? chunk.slice(start, end) : rest + chunk.slice(start, end))
      rest = ''
      skipping = false
      start = end + 1
    }
    if (skipping) return
    rest += chunk.slice(start)
    if (rest.length > MAX_LINE) {
      rest = ''
      skipping = true
    }
  }
}
const BULLET = /^·\s+https?:\/\/\S+\/session\/(qs_[A-Za-z0-9]+)/

/** A tool call on one line: `Edit: README.md`, `Bash: npm test`. */
export function toolOf(name: string, input: Record<string, unknown> | undefined): string {
  const path = input?.file_path ?? input?.path ?? input?.notebook_path
  const detail = typeof path === 'string' ? basename(path)
    : typeof input?.command === 'string' ? input.command
      : typeof input?.pattern === 'string' ? input.pattern
        : typeof input?.description === 'string' ? input.description : ''
  const line = detail.replace(/\s+/g, ' ').trim()
  return line === '' ? name : `${name}: ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`
}

const firstText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content.find((part): part is { type: 'text'; text: string } => (part as { type?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
  return text?.text
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What a daemon's output says, line by line. Pure: the supervisor below feeds it. */
export class DaemonLog {
  phase: DaemonPhase = 'starting'
  error: string | undefined
  env: string | undefined
  /** Bumped whenever something the panel shows changes; a line that changes nothing leaves it. */
  revision = 0
  private tasks = new Map<string, TaskView>()
  /** The sessions the last status block listed: the ones with a worker. */
  private listed = new Set<string>()
  /** The session list being read from a status block: active and starting ones. */
  private listing: Set<string> | undefined
  private listingStarting = false
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  feed(raw: string): void {
    // A worker's stream-json line, the bulk of a verbose log: no colours to strip, and often long.
    // Token deltas and tool results (most of it, and the longest lines) are dropped by their prefix,
    // before anything of the line is copied.
    if (raw.startsWith('[qs_')) {
      const session = SESSION_PREFIX.exec(raw)
      if (session !== null) {
        const at = session[0].length
        if (raw.startsWith(STREAM_EVENT, at) || raw.startsWith(TOOL_RESULT, at)) return
        this.session(session[1]!, raw.slice(at).trimEnd())
        return
      }
    }
    const line = raw.replace(ANSI, '').trim()
    if (line === '') return
    const before = `${this.phase}|${this.error}|${this.env}`
    this.status(line)
    if (`${this.phase}|${this.error}|${this.env}` !== before) this.revision++
  }

  /** A line of the daemon's own status block. */
  private status(line: string): void {
    const bullet = BULLET.exec(line)
    if (this.listing !== undefined) {
      if (bullet !== null) {
        this.listing.add(bullet[1]!)
        const task = this.task(bullet[1]!)
        if (this.listingStarting && (task.phase === 'closed' || task.phase === 'dormant')) this.set(task, 'starting')
        else if (task.phase === 'dormant') this.set(task, 'idle')
        return
      }
      if (line === '(none)') return
      if (line.startsWith('Starting/retrying sessions')) {
        this.listingStarting = true
        return
      }
      this.reconcile()
    }
    if (line.startsWith('Active sessions')) {
      this.listing = new Set()
      this.listingStarting = false
      return
    }
    if (line.startsWith('Starting/retrying sessions')) {
      this.listing = new Set()
      this.listingStarting = true
      return
    }
    const env = /envId=(env_[A-Za-z0-9]+)/.exec(line)
    if (env !== null) this.env = env[1]
    if (/\bConnected\b/.test(line) && !/disconnected/i.test(line)) {
      this.phase = 'online'
      this.error = undefined
    } else if (/disconnected|reconnecting|connection (lost|closed)/i.test(line)) {
      this.phase = 'retrying'
      this.error = clip(line, 200)
    } else if (/^(error|fatal)\b|not logged in|authentication required/i.test(line)) {
      this.error = clip(line, 200)
    }
  }

  /**
   * A status block's session list ended: what it no longer lists has no
   * worker. An answered task sleeps (reclaimed, or archived in the app), one
   * still at work is gone.
   */
  private reconcile(): void {
    const listed = this.listing
    this.listing = undefined
    this.listingStarting = false
    if (listed === undefined) return
    this.listed = listed
    for (const task of this.tasks.values()) {
      if (listed.has(task.id)) continue
      if (task.phase === 'idle') this.set(task, 'dormant')
      else if (task.phase === 'starting' || task.phase === 'running') this.set(task, 'closed')
      task.worker = undefined
    }
  }

  /** The daemon exited, its workers with it. */
  detach(): void {
    this.listed = new Set()
    this.listing = undefined
    for (const task of this.tasks.values()) {
      if (task.phase === 'idle') this.set(task, 'dormant')
      task.worker = undefined
    }
  }

  /**
   * The workers that could be reclaimed now, and since when they all sit
   * idle: every listed task answered (or failed), none at work.
   */
  reapable(): { sessions: string[]; since: number } | undefined {
    // A task at work may not be listed yet: it holds them all.
    for (const task of this.tasks.values()) if (task.phase === 'starting' || task.phase === 'running') return undefined
    const sessions: string[] = []
    let since = 0
    for (const id of this.listed) {
      const task = this.tasks.get(id)
      if (task === undefined || (task.phase !== 'idle' && task.phase !== 'failed')) continue
      sessions.push(id)
      since = Math.max(since, task.updatedAt)
    }
    return sessions.length === 0 ? undefined : { sessions, since }
  }

  /** The tasks' live workers, for the process samples to fill in. */
  workers(): ProcView[] {
    return [...this.tasks.values()].flatMap((task) => (task.worker === undefined ? [] : [task.worker]))
  }

  worker(id: string): ProcView | undefined {
    return this.tasks.get(id)?.worker
  }

  private task(id: string): TaskView {
    let task = this.tasks.get(id)
    if (task === undefined) {
      const at = this.now()
      task = { id, phase: 'starting', url: sessionUrl(id), startedAt: at, updatedAt: at }
      this.tasks.set(id, task)
      this.revision++
    }
    return task
  }

  private set(task: TaskView, phase: TaskPhase): void {
    task.phase = phase
    task.updatedAt = this.now()
    this.revision++
  }

  private session(id: string, rest: string): void {
    const failed = /^\[remote-control\] status=failed(?: error=(.*))?$/.exec(rest)
    if (failed !== null) {
      const task = this.task(id)
      task.error = clip(failed[1] ?? 'failed', 240)
      this.set(task, 'failed')
      return
    }
    // The bulk of a verbose log is token deltas, and the longest lines are tool results (a whole
    // file read): neither says anything the panel shows, so both are skipped before parsing.
    if (!rest.startsWith('{') || rest.startsWith(TOOL_RESULT) || rest.includes('"type":"stream_event"')) return
    let event: { type?: string; subtype?: string; parent_tool_use_id?: unknown; message?: { content?: unknown }; result?: unknown; is_error?: unknown; errors?: unknown; pid?: unknown; hydrated_messages?: unknown }
    try {
      event = JSON.parse(rest)
    } catch {
      return
    }
    const task = this.task(id)
    if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) {
      // A subagent's step: the task is busy.
      if (task.phase === 'starting' || task.phase === 'idle') this.set(task, 'running')
      return
    }
    switch (event.type) {
      case 'system': {
        if (event.subtype !== 'remote_worker_init') return
        if (typeof event.pid === 'number') task.worker = { pid: event.pid, startedAt: this.now() }
        // A worker started again for an earlier task (after a reclaim, or the daemon starting again) restores
        // its conversation and waits for the next message; a new one starts on its task.
        const restored = typeof event.hydrated_messages === 'number' ? event.hydrated_messages : 0
        if (restored > 0) task.restored = restored
        if (task.phase === 'starting' || task.phase === 'dormant' || task.phase === 'closed') this.set(task, restored > 0 ? 'idle' : 'running')
        else this.revision++
        return
      }
      case 'user': {
        const content = event.message?.content
        if (Array.isArray(content) && content.some((part) => (part as { type?: unknown })?.type === 'tool_result')) return
        const text = firstText(content)
        if (text === undefined || text.startsWith('[Request interrupted')) return
        if (task.prompt === undefined) task.prompt = clip(text, 400)
        task.summary = undefined
        task.error = undefined
        this.set(task, 'running')
        return
      }
      case 'assistant': {
        const content = event.message?.content
        if (!Array.isArray(content)) return
        const tool = task.tool
        for (const part of content) {
          const call = part as { type?: unknown; name?: unknown; input?: unknown }
          if (call.type === 'tool_use' && typeof call.name === 'string') task.tool = toolOf(call.name, call.input as Record<string, unknown> | undefined)
        }
        if (task.phase !== 'running') this.set(task, 'running')
        else {
          task.updatedAt = this.now()
          if (task.tool !== tool) this.revision++
        }
        return
      }
      case 'result': {
        if (event.is_error === true) {
          const errors = Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === 'string') : []
          task.error ??= clip(errors[0] ?? event.subtype ?? 'failed', 240)
          this.set(task, 'failed')
        } else {
          if (typeof event.result === 'string' && event.result.trim() !== '') task.summary = clip(event.result, 280)
          this.set(task, 'idle')
        }
        return
      }
      default:
    }
  }

  /** The tasks, newest first; long-archived ones dropped. */
  view(): TaskView[] {
    const now = this.now()
    for (const [id, task] of this.tasks) if (task.phase === 'closed' && now - task.updatedAt > KEEP_CLOSED_MS) this.tasks.delete(id)
    const tasks = [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
    for (const task of tasks.slice(KEEP_TASKS)) this.tasks.delete(task.id)
    return tasks.slice(0, KEEP_TASKS).map((task) => ({ ...task, ...(task.worker === undefined ? {} : { worker: { ...task.worker } }) }))
  }
}

export interface DaemonHost {
  settings(): QoderSettings
  find(): string | undefined
  log(message: string): void
  /** Ready a repository before its daemon starts (worktree.ts: Qoder's worktrees in DSH's folder). */
  prepare(repo: string): Promise<void>
  /** Environment the daemon (and so its workers' shells) starts with, on top of DSH's: the `dsh` command on PATH. */
  env?(): NodeJS.ProcessEnv
  /**
   * Whether something in the workspace waits on a worker staying up (a `dsh ask` in flight, the
   * glasses' inbox): reclaiming restarts the daemon and would end it. Re-checked on `refresh()`.
   */
  held?(path: string): boolean
  /** What the processes cost, sampled while the panel is shown (probe.ts); none without it. */
  probe?: Probe
  /** Test seams. */
  spawn?(command: string, args: readonly string[], cwd: string): ChildProcess
  kill?(child: ChildProcess): void
  /** Empty the workers files of `path`'s daemons (cli.ts `clearWorkers`). */
  clear?(path: string): Cleared
  /** Whether a process still runs. */
  alive?(pid: number): boolean
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The name the glasses and the app show for a workspace's environment: the
 * machine and the folder. ASCII only: the CLI garbles other characters on a
 * Windows command line, so a folder named otherwise leaves the machine alone.
 */
export function daemonName(path: string, host = hostname()): string {
  const ascii = (text: string): string => text.replace(/[^\x20-\x7e]/g, '').trim()
  const machine = ascii(host.replace(/\.local$/i, '')) || 'DSH'
  const folder = ascii(basename(path))
  return folder === '' ? machine : `${machine} / ${folder}`
}

interface Daemon {
  path: string
  log: DaemonLog
  child: ChildProcess | undefined
  /** The running daemon's process. */
  proc: ProcView | undefined
  /** When its idle workers will be reclaimed, and the timer that does it. */
  reapAt: number | undefined
  reapTimer: NodeJS.Timeout | undefined
  /** A reclaim under way: the workers it ends and the memory they held, counted once the next start begins without them. */
  reaping: { workers: number; bytes: number } | undefined
  /** The last run's workers: a start waits for them to exit (they hold the workers file and the broker). */
  exiting: number[]
  /** Its workers file is in a format this does not know (or never took the change): no more reclaims this run. */
  unreapable: boolean
  reaped: { workers: number; bytes: number; at?: number }
  /** Stopped here: no automatic start until started again. */
  held: boolean
  stopping: boolean
  attempt: number
  timer: NodeJS.Timeout | undefined
  onlineSince: number | undefined
  /** A start waiting on its preparation; a newer start, or a stop, replaces it. */
  launching: object | undefined
}

/** End the daemon with its workers (on Windows ending the parent alone leaves them running); escalate if it lingers. */
function endTree(child: ChildProcess): void {
  const cancel = killTree(child)
  child.once('exit', cancel)
}

export class RemoteWorkspaces {
  private daemons = new Map<string, Daemon>()
  private host: DaemonHost
  private disposed = false
  /** Whether the CLI was found, and when: the panel polls status, and finding it walks PATH synchronously. */
  private found: { at: number; installed: boolean } | undefined

  private installed(): boolean {
    if (this.found === undefined || Date.now() - this.found.at > FIND_TTL_MS) this.found = { at: Date.now(), installed: this.host.find() !== undefined }
    return this.found.installed
  }

  constructor(host: DaemonHost) {
    this.host = host
  }

  /** This host run, and how many changes it has seen: a panel waits on them instead of polling. */
  private readonly boot = randomUUID()
  private epoch = 0
  private waiters = new Set<() => void>()
  private wakeTimer: NodeJS.Timeout | undefined

  private listeners = new Set<() => void>()

  /** Call `listener` on every change the panel would show; returns the stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Something the panel shows changed: wake the waiting reads once the burst settles. */
  private changed(): void {
    this.epoch++
    for (const listener of this.listeners) listener()
    if (this.wakeTimer !== undefined || this.waiters.size === 0) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      for (const wake of [...this.waiters]) wake()
    }, WAKE_MS)
  }

  private update(): QoderUpdate {
    return { boot: this.boot, epoch: this.epoch, status: this.status() }
  }

  /**
   * The state now when it changed after \`since\` (or the host restarted), else
   * once it changes or WAIT_MS passes.
   */
  wait(boot: unknown, since: unknown): Promise<QoderUpdate> {
    // A fresh read (a panel opening, a refresh): look for the CLI again.
    if (boot === undefined) this.found = undefined
    this.watch()
    if (boot !== this.boot || since !== this.epoch || this.disposed) return Promise.resolve(this.update())
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(this.update())
      }
      const timer = setTimeout(wake, WAIT_MS)
      this.waiters.add(wake)
    })
  }

  /** Follow the settings: daemons for new workspaces (started when auto-start is on), none for removed ones. */
  sync(): void {
    if (this.disposed) return
    const settings = this.host.settings()
    const wanted = new Set(settings.workspaces.map((path) => path.trim()).filter((path) => path !== ''))
    for (const [path, daemon] of this.daemons) {
      if (!wanted.has(path)) {
        this.halt(daemon)
        this.daemons.delete(path)
      }
    }
    for (const path of wanted) {
      let daemon = this.daemons.get(path)
      if (daemon === undefined) {
        daemon = {
          path, log: new DaemonLog(), child: undefined, proc: undefined, reapAt: undefined, reapTimer: undefined, reaping: undefined, exiting: [], unreapable: false,
          reaped: { workers: 0, bytes: 0 }, held: !settings.autoStart, stopping: false, attempt: 0, timer: undefined, onlineSince: undefined, launching: undefined,
        }
        daemon.log.phase = 'stopped'
        this.daemons.set(path, daemon)
      }
      if (daemon.child === undefined && daemon.timer === undefined && daemon.launching === undefined && !daemon.held) this.launch(daemon)
      else this.schedule(daemon)
    }
    this.changed()
  }

  status(): QoderStatus {
    const idleMinutes = this.idleMinutes()
    return {
      installed: this.installed(),
      workspaces: [...this.daemons.values()].map((daemon): WorkspaceView => ({
        path: daemon.path,
        name: daemonName(daemon.path),
        phase: daemon.log.phase,
        ...(daemon.log.error === undefined ? {} : { error: daemon.log.error }),
        ...(daemon.log.env === undefined ? {} : { env: daemon.log.env }),
        ...(daemon.proc === undefined ? {} : { daemon: { ...daemon.proc } }),
        idleMinutes,
        ...(daemon.reapAt === undefined ? {} : { reapAt: daemon.reapAt }),
        ...(this.host.held?.(daemon.path) === true ? { held: true } : {}),
        ...(daemon.unreapable ? { unreapable: true } : {}),
        reaped: { ...daemon.reaped },
        tasks: daemon.log.view(),
      })),
    }
  }

  start(path: string): QoderUpdate {
    const daemon = this.daemons.get(path)
    if (daemon === undefined) throw new Error('Not a configured workspace')
    daemon.held = false
    daemon.attempt = 0
    if (daemon.timer !== undefined) {
      clearTimeout(daemon.timer)
      daemon.timer = undefined
    }
    if (daemon.child === undefined) this.launch(daemon)
    this.changed()
    return this.update()
  }

  stop(path: string): QoderUpdate {
    const daemon = this.daemons.get(path)
    if (daemon === undefined) throw new Error('Not a configured workspace')
    daemon.held = true
    this.halt(daemon)
    this.changed()
    return this.update()
  }

  /** Reclaim a workspace's idle workers now; nothing when a task is at work. */
  reap(path: string): QoderUpdate {
    const daemon = this.daemons.get(path)
    if (daemon === undefined) throw new Error('Not a configured workspace')
    this.reclaim(daemon)
    return this.update()
  }

  private idleMinutes(): number {
    const minutes = Number(this.host.settings().idleMinutes)
    return Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0
  }

  private reapable(daemon: Daemon): ReturnType<DaemonLog['reapable']> {
    if (this.host.held?.(daemon.path) === true) return undefined
    return daemon.child !== undefined && !daemon.stopping && !daemon.unreapable && daemon.log.phase === 'online' ? daemon.log.reapable() : undefined
  }

  /** What `held` answers changed: time the reclaims again. */
  refresh(): void {
    if (this.disposed) return
    for (const daemon of this.daemons.values()) this.schedule(daemon)
    this.changed()
  }

  /** Time the reclaim of a daemon's workers: idleMinutes after the last of them went idle, none while one is at work. */
  private schedule(daemon: Daemon): void {
    clearTimeout(daemon.reapTimer)
    daemon.reapTimer = undefined
    daemon.reapAt = undefined
    const minutes = this.idleMinutes()
    const idle = minutes > 0 ? this.reapable(daemon) : undefined
    if (idle === undefined) return
    daemon.reapAt = idle.since + minutes * 60_000
    daemon.reapTimer = setTimeout(() => {
      daemon.reapTimer = undefined
      this.reclaim(daemon)
    }, Math.max(0, daemon.reapAt - Date.now()))
    daemon.reapTimer.unref()
  }

  /** Restart the daemon: every start begins without idle workers. */
  private reclaim(daemon: Daemon): void {
    const idle = this.reapable(daemon)
    if (idle === undefined) return
    const workers = idle.sessions.flatMap((id) => { const worker = daemon.log.worker(id); return worker === undefined ? [] : [worker] })
    daemon.reaping = { workers: idle.sessions.length, bytes: workers.reduce((sum, worker) => sum + (worker.rss ?? 0), 0) }
    this.host.log(`Qoder daemon in ${daemon.path} restarting to reclaim ${idle.sessions.length} idle worker(s)`)
    this.halt(daemon)
    this.changed()
  }

  private launch(daemon: Daemon): void {
    if (this.disposed) return
    const command = this.host.find()
    this.found = { at: Date.now(), installed: command !== undefined }
    if (command === undefined) {
      daemon.log.phase = 'stopped'
      daemon.log.error = INSTALL_HINT
      return
    }
    daemon.stopping = false
    const log = daemon.log
    log.phase = 'starting'
    log.error = undefined
    const token = {}
    daemon.launching = token
    void (async () => {
      // Without its hooks Qoder still works, its trees in its own folder: start anyway.
      await this.host.prepare(daemon.path).catch((error: unknown) => this.host.log(`Qoder worktree hooks not set in ${daemon.path}: ${(error as Error).message}`))
      const cleared = await this.clear(daemon, token)
      if (daemon.launching !== token) return
      daemon.launching = undefined
      this.account(daemon, cleared)
      if (!this.disposed && !daemon.held && daemon.child === undefined) this.spawnDaemon(daemon, command)
    })()
  }

  /** Wait for the last run's workers to exit, then empty the workspace's workers files, a file not ready tried again. */
  private async clear(daemon: Daemon, token: object): Promise<Cleared> {
    const alive = this.host.alive ?? isAlive
    const clear = this.host.clear ?? ((path: string) => clearWorkers(path, alive, (message) => this.host.log(message)))
    for (let attempt = 0; ; attempt++) {
      if (daemon.launching !== token || this.disposed) return 'retry'
      const last = attempt >= SETTLE_TRIES
      const result = !last && daemon.exiting.some((pid) => alive(pid)) ? 'retry' : clear(daemon.path)
      if (result !== 'retry' || last) {
        daemon.exiting = []
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS).unref())
    }
  }

  /** What a start's emptied workers file means: a reclaim done, or its workers back (and no more reclaims). */
  private account(daemon: Daemon, cleared: Cleared): void {
    const reaping = daemon.reaping
    daemon.reaping = undefined
    if (cleared === 'cleared') {
      if (reaping !== undefined) daemon.reaped = { workers: daemon.reaped.workers + reaping.workers, bytes: daemon.reaped.bytes + reaping.bytes, at: Date.now() }
      return
    }
    // It starts with the workers its file lists; a reclaim would only restart it again.
    if (!daemon.unreapable) this.host.log(`Qoder workers in ${daemon.path} restored: ${cleared === 'unknown' ? 'its workers file is in a format this does not know' : 'its workers file could not be changed'}`)
    daemon.unreapable = true
    this.changed()
  }

  private spawnDaemon(daemon: Daemon, command: string): void {
    const log = daemon.log
    // No --capacity: the CLI's own cap (32) is never near, with idle workers reclaimed.
    const args = ['remote-control', '--name', daemonName(daemon.path), '--spawn', 'same-dir', '--directory', daemon.path, '--verbose']
    let child: ChildProcess
    try {
      child = this.host.spawn?.(command, args, daemon.path)
        ?? spawn(command, args, { cwd: daemon.path, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, ...this.host.env?.() } })
    } catch (error) {
      log.phase = 'retrying'
      log.error = (error as Error).message
      this.changed()
      this.retry(daemon)
      return
    }
    daemon.child = child
    daemon.proc = child.pid === undefined ? undefined : { pid: child.pid, startedAt: Date.now() }
    const lines = (stream: NodeJS.ReadableStream | null): void => {
      if (stream === null) return
      stream.setEncoding?.('utf8')
      const reader = lineReader((line) => this.read(daemon, line))
      stream.on('data', (data: string | Buffer) => reader(String(data)))
    }
    lines(child.stdout)
    lines(child.stderr)
    child.once('error', (error) => {
      log.error = error.message
      this.exited(daemon, child, null)
    })
    child.once('exit', (code) => this.exited(daemon, child, code))
  }

  private read(daemon: Daemon, line: string): void {
    // A daemon being stopped may still print its last status block.
    if (daemon.stopping) return
    const before = daemon.log.phase
    const revision = daemon.log.revision
    daemon.log.feed(line)
    if (daemon.log.phase === 'online' && before !== 'online') daemon.onlineSince = Date.now()
    if (daemon.log.phase === 'online' && daemon.onlineSince !== undefined && Date.now() - daemon.onlineSince > STEADY_MS) daemon.attempt = 0
    if (daemon.log.revision !== revision) {
      this.schedule(daemon)
      this.changed()
    }
  }

  private exited(daemon: Daemon, child: ChildProcess, code: number | null): void {
    if (daemon.child !== child) return
    daemon.child = undefined
    daemon.proc = undefined
    daemon.onlineSince = undefined
    // Its workers may outlive it a moment, holding the workers file and the broker: the next start waits for them.
    daemon.exiting = daemon.log.workers().map((worker) => worker.pid)
    daemon.log.detach()
    this.changed()
    if (daemon.stopping || this.disposed) {
      daemon.log.phase = 'stopped'
      // Started again while it was stopping.
      if (!daemon.held && !this.disposed) this.launch(daemon)
      return
    }
    daemon.log.phase = 'retrying'
    daemon.log.error ??= `remote-control exited${code === null ? '' : ` with code ${code}`}`
    this.retry(daemon)
    this.host.log(`Qoder daemon in ${daemon.path} exited unexpectedly (code ${code}), retry ${daemon.attempt}: ${daemon.log.error}`)
  }

  private retry(daemon: Daemon): void {
    if (daemon.held || this.disposed || daemon.timer !== undefined) return
    const delay = BACKOFF_MS[Math.min(daemon.attempt, BACKOFF_MS.length - 1)]!
    daemon.attempt++
    daemon.timer = setTimeout(() => {
      daemon.timer = undefined
      if (!daemon.held && daemon.child === undefined) {
        this.launch(daemon)
        this.changed()
      }
    }, delay)
    daemon.timer.unref()
  }

  private halt(daemon: Daemon): void {
    daemon.launching = undefined
    if (daemon.timer !== undefined) {
      clearTimeout(daemon.timer)
      daemon.timer = undefined
    }
    clearTimeout(daemon.reapTimer)
    daemon.reapTimer = undefined
    daemon.reapAt = undefined
    const child = daemon.child
    daemon.stopping = true
    daemon.log.phase = 'stopped'
    if (child !== undefined) (this.host.kill ?? endTree)(child)
  }

  private watchedAt = 0
  private unprobe: (() => void) | undefined
  /** Each process's previous sample and when it was read, for its CPU over the interval. */
  private samples = new Map<number, ProcSample & { at: number }>()

  /** A panel is reading: sample the processes until it stops. */
  watch(): void {
    this.watchedAt = Date.now()
    if (this.unprobe !== undefined || this.host.probe === undefined || ![...this.daemons.values()].some((daemon) => daemon.child !== undefined)) return
    this.unprobe = this.host.probe((samples) => this.sampled(samples))
  }

  private unwatch(): void {
    this.unprobe?.()
    this.unprobe = undefined
    this.samples.clear()
  }

  /** Fill each running process's cost in; wake the panel when what it shows moved. */
  private sampled(samples: Map<number, ProcSample>): void {
    const at = Date.now()
    const running = [...this.daemons.values()].filter((daemon) => daemon.child !== undefined)
    if (this.disposed || at - this.watchedAt > WATCH_MS || running.length === 0) {
      this.unwatch()
      return
    }
    let moved = false
    const shown = (view: ProcView): string => `${Math.round((view.rss ?? 0) / MB)}|${view.cpu === undefined ? '' : Math.round(view.cpu)}`
    const fill = (view: ProcView): void => {
      const sample = samples.get(view.pid)
      if (sample === undefined) return
      const before = shown(view)
      const last = this.samples.get(view.pid)
      view.rss = sample.rss
      if (last !== undefined && at > last.at) view.cpu = Math.max(0, ((sample.cpuMs - last.cpuMs) / (at - last.at)) * 100)
      if (sample.startedAt !== undefined) view.startedAt = sample.startedAt
      if (shown(view) !== before) moved = true
    }
    for (const daemon of running) {
      if (daemon.proc !== undefined) fill(daemon.proc)
      for (const worker of daemon.log.workers()) fill(worker)
    }
    this.samples = new Map([...samples].map(([pid, sample]) => [pid, { ...sample, at }]))
    if (moved) this.changed()
  }

  dispose(): void {
    this.disposed = true
    this.unwatch()
    for (const daemon of this.daemons.values()) this.halt(daemon)
    this.daemons.clear()
    this.listeners.clear()
    clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    for (const wake of [...this.waiters]) wake()
  }
}
