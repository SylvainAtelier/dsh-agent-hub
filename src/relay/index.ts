/**
 * The 接力 service: one list of what Qoder and the Hermes personas did
 * elsewhere, newest first, and the way back into each.
 *
 * - The list joins Qoder's session files (qoder.ts), the remote-control
 *   daemons' live tasks (the worker, the tool in progress, a failure the app
 *   may not show), the cloud sessions sent from here, and each persona's
 *   database (hermes.ts). Stores are looked at every few seconds while a page
 *   follows the list, and read again only when they moved.
 * - Taking a thread over opens a DSH session on that agent's route, titled
 *   after it, and links the two (relay.json): taking it over again opens the
 *   same session. Its first turn picks the thread up through {@link Relay.seed}:
 *   Qoder loads the session itself (one the agent cannot load starts over
 *   with the transcript); Hermes loads only its own ACP sessions, so a
 *   Telegram or terminal conversation goes on in a new one that starts from
 *   the transcript. A Qoder task still at work is not taken over: two
 *   processes would write one session.
 * - A thread also goes on in a terminal of this machine (its CLI's resume),
 *   and a task can be sent to a Qoder cloud session (`--remote`).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AcpSeed } from '../acp/route.ts'
import { HERMES_PROVIDER, personaHome } from '../hermes/route.ts'
import { jsonWriter } from '../persistence.ts'
import type { RemoteWorkspaces } from '../qoder/daemon.ts'
import { QODER_PROVIDER } from '../qoder/route.ts'
import { sessionUrl, type TaskPhase, type TaskView } from '../qoder/types.ts'
import type { SessionHost } from '../review/index.ts'
import { dbStamp, hermesSessions, hermesTurns, type HermesSession } from './hermes.ts'
import { QoderSessions, type QoderSession } from './qoder.ts'
import type { Origin, RelayRequest, RelayUpdate, TakeoverResult, ThreadDetail, ThreadPhase, ThreadView, Turn } from './types.ts'

export interface RelayHost {
  workspaces: RemoteWorkspaces
  hermesRoot(): string
  /** The personas' ids (hermes/route.ts listPersonas). */
  personas(): string[]
  findHermes(): string | undefined
  findQoder(): string | undefined
  /** The Qoder route's model ids, for a taken-over session. */
  qoderModels(): Promise<string[]>
  sessions(): SessionHost | undefined
  /** Whether a DSH session was archived: a link to it is dropped. */
  archived?(sessionId: string): boolean
  /** Where the links persist. */
  file: string
  log(message: string): void
  /** Test seams. */
  qoder?: QoderSessions
  spawn?(command: string, args: readonly string[], options: { cwd: string; windowsVerbatimArguments?: boolean; detached?: boolean }): ChildProcess
}

interface Saved {
  /** Thread key → the DSH session it was taken over into. */
  links: Record<string, { session: string; at: number }>
  /** Qoder cloud sessions sent from here, newest first. */
  cloud: Array<{ id: string; title: string; cwd: string; at: number }>
}

/** How long a status read waits for a change; under the Desktop update lock, which drains requests for at most 10s. */
const WAIT_MS = 5_000
/** The stores are looked at this often while a read came this recently. */
const LOOK_MS = 3_000
const WATCH_MS = 15_000
const WAKE_MS = 100
/** A session with an answer under way and nothing written this long is not at work any more. */
const STALE_MS = 10 * 60_000
const KEEP_THREADS = 200
const KEEP_TURNS = 300
const KEEP_CLOUD = 50
/** The transcript a new conversation starts from, at most (its newest part). */
const CONTEXT_MAX = 24_000
const PERSONAS_TTL_MS = 60_000
const CLOUD_TIMEOUT_MS = 120_000
/** How long the request opening a cloud session waits for it: under the Desktop update lock (10s). Later, it is listed once open. */
const CLOUD_WAIT_MS = 8_000
const CLOUD_URL = /https?:\/\/\S+?\/session\/(qs_[A-Za-z0-9]+)/

export const RUNNING = 'This Qoder task is still at work: take it over once it has answered.'

const LIVE_PHASE: Record<TaskPhase, ThreadPhase> = { starting: 'running', running: 'running', idle: 'idle', dormant: 'idle', failed: 'failed', closed: 'ended' }

const HERMES_ORIGIN: Record<string, Origin> = { telegram: 'telegram', cli: 'cli', tui: 'tui', cron: 'cron', api_server: 'api' }

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const quote = (path: string): string => `"${path}"`

/**
 * Where a thread goes on: its folder, else the nearest repository (or
 * folder) above it still there. A worktree removed since leaves its
 * repository, and Qoder finds a session of a repository's worktrees from the
 * repository itself.
 */
export function workingDir(cwd: string | undefined, exists: (path: string) => boolean = existsSync): string {
  let found: string | undefined
  for (let dir = cwd; dir !== undefined; ) {
    if (exists(dir)) {
      if (dir === cwd || exists(join(dir, '.git'))) return dir
      found ??= dir
    }
    const up = dirname(dir)
    dir = up === dir ? undefined : up
  }
  return found ?? homedir()
}

export const qoderKey = (id: string): string => `qoder:${id}`
export const hermesKey = (persona: string, id: string): string => `hermes:${persona}:${id}`

/** Thread key → agent, persona and session id. */
export function parseKey(key: string): { agent: 'qoder'; id: string } | { agent: 'hermes'; persona: string; id: string } | undefined {
  const [agent, ...rest] = key.split(':')
  if (agent === 'qoder' && rest.length >= 1) return { agent, id: rest.join(':') }
  if (agent === 'hermes' && rest.length >= 2) return { agent, persona: rest[0]!, id: rest.slice(1).join(':') }
  return undefined
}

/** The transcript a new conversation is handed, newest part kept. */
export function transcript(thread: ThreadView, turns: readonly Turn[], max = CONTEXT_MAX): string {
  const agent = thread.agent === 'qoder' ? 'Qoder' : `Hermes (persona ${thread.persona})`
  const from = thread.origin === 'other' ? thread.source ?? 'elsewhere' : thread.origin
  const lines = turns.map((turn) => (turn.role === 'tool' ? `(tool) ${turn.text}` : `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`))
  let body = ''
  for (let index = lines.length - 1; index >= 0; index--) {
    const next = `${lines[index]}\n\n${body}`
    if (next.length > max) {
      body = `[… earlier messages left out]\n\n${body}`
      break
    }
    body = next
  }
  return `This conversation takes over a ${agent} conversation that started in ${from} (session ${thread.id}). `
    + `Its transcript so far, oldest first, tool calls one line each; carry on from where it left off.\n\n<transcript>\n${body.trim()}\n</transcript>`
}

export class Relay {
  private host: RelayHost
  private qoder: QoderSessions
  private readonly boot = randomUUID()
  private epoch = 0
  private waiters = new Set<() => void>()
  private wakeTimer: NodeJS.Timeout | undefined
  private saved: Saved = { links: {}, cloud: [] }
  private write: (value: unknown) => Promise<void>
  private ready: Promise<void>
  private disposed = false

  /** What the stores held when last read, and the stamp they were read at. */
  private qoderStore: { stamp: string; sessions: QoderSession[] } = { stamp: '', sessions: [] }
  private hermesStore = new Map<string, { stamp: string; sessions: HermesSession[] }>()
  private personas: { at: number; ids: string[] } | undefined
  private hermesFound: boolean | undefined
  private looking: Promise<void> | undefined
  private lookTimer: NodeJS.Timeout | undefined
  private watchedAt = 0
  private offWorkspaces: () => void

  constructor(host: RelayHost) {
    this.host = host
    this.qoder = host.qoder ?? new QoderSessions()
    this.write = jsonWriter(host.file)
    this.ready = this.restore()
    this.offWorkspaces = host.workspaces.subscribe(() => this.changed())
  }

  private async restore(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.host.file, 'utf8')) as Partial<Saved>
      if (typeof value.links === 'object' && value.links !== null) this.saved.links = value.links
      if (Array.isArray(value.cloud)) this.saved.cloud = value.cloud
    } catch {
      // Nothing saved yet.
    }
  }

  private save(): void {
    this.write(this.saved).catch((error: unknown) => this.host.log(`relay links not saved: ${(error as Error).message}`))
  }

  async handle(request: RelayRequest): Promise<unknown> {
    switch (request.op) {
      case 'thread': return this.thread(String(request.key))
      case 'takeover': return this.takeover(String(request.key), typeof request.text === 'string' ? request.text : undefined)
      case 'terminal': return this.terminal(String(request.key))
      case 'cloud': return this.cloud(String(request.path), String(request.task))
      case 'start': this.host.workspaces.start(String(request.path)); return this.update()
      case 'stop': this.host.workspaces.stop(String(request.path)); return this.update()
      case 'reap': this.host.workspaces.reap(String(request.path)); return this.update()
      default: return this.wait(request.boot, request.since, request.watch === true)
    }
  }

  private changed(): void {
    this.epoch++
    if (this.wakeTimer !== undefined || this.waiters.size === 0) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      for (const wake of [...this.waiters]) wake()
    }, WAKE_MS)
  }

  /** The list now when it changed after `since` (or the host restarted), else once it changes or WAIT_MS passes. */
  async wait(boot: unknown, since: unknown, watch: boolean): Promise<RelayUpdate> {
    await this.ready
    this.watchedAt = Date.now()
    // The panel itself: its processes are sampled. A page only following the list for notices is not.
    if (watch) this.host.workspaces.watch()
    if (boot === undefined) this.hermesFound = undefined
    await this.look()
    this.schedule()
    if (boot !== this.boot || since !== this.epoch || this.disposed) return this.update()
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

  /** Look at the stores every few seconds while a page follows the list. */
  private schedule(): void {
    if (this.lookTimer !== undefined || this.disposed) return
    this.lookTimer = setTimeout(() => {
      this.lookTimer = undefined
      if (Date.now() - this.watchedAt > WATCH_MS) return
      void this.look().then(() => this.schedule())
    }, LOOK_MS)
    this.lookTimer.unref()
  }

  /** Read again what moved since the last look; a change wakes the waiting reads. */
  private look(): Promise<void> {
    this.looking ??= this.lookNow().catch((error: unknown) => this.host.log(`relay read failed: ${(error as Error).message}`)).finally(() => { this.looking = undefined })
    return this.looking
  }

  private async lookNow(): Promise<void> {
    let moved = false
    const files = await this.qoder.files()
    const stamp = files.slice(0, 80).map((file) => `${file.id}:${file.mtime}:${file.size}`).join('|')
    if (stamp !== this.qoderStore.stamp) {
      this.qoderStore = { stamp, sessions: await this.qoder.list(files) }
      moved = true
    }
    this.hermesFound ??= this.host.findHermes() !== undefined
    if (this.personas === undefined || Date.now() - this.personas.at > PERSONAS_TTL_MS) this.personas = { at: Date.now(), ids: this.host.personas() }
    const root = this.host.hermesRoot()
    const ids = new Set(this.personas.ids)
    for (const persona of [...this.hermesStore.keys()]) {
      if (!ids.has(persona)) {
        this.hermesStore.delete(persona)
        moved = true
      }
    }
    await Promise.all([...ids].map(async (persona) => {
      const home = personaHome(root, persona)
      const stamp = await dbStamp(home)
      const known = this.hermesStore.get(persona)
      // A session at work turns idle by time alone: read again while one is.
      if (known?.stamp === stamp && !known.sessions.some((session) => session.waiting)) return
      const sessions = await hermesSessions(persona, home)
      if (known !== undefined && JSON.stringify(known.sessions) === JSON.stringify(sessions)) {
        known.stamp = stamp
        return
      }
      this.hermesStore.set(persona, { stamp, sessions })
      moved = true
    }))
    if (moved) this.changed()
  }

  /** The DSH session a thread was taken over into, unless it was archived since. */
  private linked(key: string): string | undefined {
    const session = this.saved.links[key]?.session
    return session === undefined || this.host.archived?.(session) === true ? undefined : session
  }

  private qoderThread(session: QoderSession | undefined, task: TaskView | undefined, cloud: Saved['cloud'][number] | undefined, now: number): ThreadView | undefined {
    const id = session?.id ?? task?.id ?? cloud?.id
    if (id === undefined) return undefined
    const key = qoderKey(id)
    const entry = session?.entrypoint
    const origin: Origin = cloud !== undefined ? 'cloud' : task !== undefined || entry === 'remote-control' ? 'glasses' : entry === 'cli' ? 'cli' : 'other'
    const linked = this.linked(key)
    // DSH's own conversations on the Qoder route are in DSH already.
    if (origin === 'other' && entry !== undefined && /acp|sdk/i.test(entry) && linked === undefined) return undefined
    const phase: ThreadPhase = task !== undefined ? LIVE_PHASE[task.phase]
      : session === undefined ? 'cloud'
        : session.waiting && now - session.updatedAt < STALE_MS ? 'running' : 'idle'
    const detail = task?.phase === 'failed' ? task.error
      : task !== undefined && (task.phase === 'running' || task.phase === 'starting') ? task.tool ?? session?.last
        : task?.summary ?? session?.last
    const cwd = session?.cwd ?? cloud?.cwd
    const title = session?.title ?? task?.prompt ?? cloud?.title ?? id
    const resume = session === undefined && cloud !== undefined ? `qodercn --teleport ${id}` : `qodercn -r ${id}`
    return {
      key, agent: 'qoder', id, origin, title, phase, takeover: 'load',
      startedAt: session?.startedAt || task?.startedAt || cloud?.at || now,
      updatedAt: Math.max(session?.updatedAt ?? 0, task?.updatedAt ?? 0, cloud?.at ?? 0),
      command: cwd === undefined ? resume : `cd ${quote(cwd)}; ${resume}`,
      ...(origin === 'other' && entry !== undefined ? { source: entry } : {}),
      ...(detail === undefined ? {} : { detail }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(session?.branch === undefined ? {} : { branch: session.branch }),
      ...(session?.model === undefined ? {} : { model: session.model }),
      ...(session === undefined ? {} : { prompts: session.prompts }),
      ...(id.startsWith('qs_') ? { url: task?.url ?? sessionUrl(id) } : {}),
      ...(linked === undefined ? {} : { session: linked }),
      ...(task === undefined ? {} : { task }),
    }
  }

  private hermesThread(session: HermesSession): ThreadView {
    const key = hermesKey(session.persona, session.id)
    const origin = HERMES_ORIGIN[session.source] ?? 'other'
    const linked = this.linked(key)
    const resume = session.persona === 'default' ? `hermes --resume ${session.id}` : `hermes -p ${session.persona} --resume ${session.id}`
    return {
      key, agent: 'hermes', id: session.id, persona: session.persona, origin,
      title: session.title ?? session.last ?? session.id,
      phase: session.waiting ? 'running' : session.ended ? 'ended' : 'idle',
      startedAt: session.startedAt, updatedAt: session.updatedAt, prompts: session.messages, takeover: 'context',
      command: session.cwd === undefined ? resume : `cd ${quote(session.cwd)}; ${resume}`,
      ...(origin === 'other' ? { source: session.source } : {}),
      ...(session.title !== undefined && session.last !== undefined ? { detail: session.last } : {}),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.branch === undefined ? {} : { branch: session.branch }),
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(linked === undefined ? {} : { session: linked }),
    }
  }

  /** Every thread, newest first. */
  threads(): ThreadView[] {
    const now = Date.now()
    const tasks = new Map(this.host.workspaces.status().workspaces.flatMap((workspace) => workspace.tasks.map((task) => [task.id, task] as const)))
    const cloud = new Map(this.saved.cloud.map((entry) => [entry.id, entry]))
    const threads: ThreadView[] = []
    const seen = new Set<string>()
    for (const session of this.qoderStore.sessions) {
      seen.add(session.id)
      const thread = this.qoderThread(session, tasks.get(session.id), cloud.get(session.id), now)
      if (thread !== undefined) threads.push(thread)
    }
    // A task whose session file is not written yet, or a cloud session never brought here.
    for (const task of tasks.values()) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      const thread = this.qoderThread(undefined, task, cloud.get(task.id), now)
      if (thread !== undefined) threads.push(thread)
    }
    for (const entry of this.saved.cloud) {
      if (seen.has(entry.id)) continue
      const thread = this.qoderThread(undefined, undefined, entry, now)
      if (thread !== undefined) threads.push(thread)
    }
    for (const { sessions } of this.hermesStore.values()) for (const session of sessions) threads.push(this.hermesThread(session))
    return threads.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, KEEP_THREADS)
  }

  update(): RelayUpdate {
    return {
      boot: this.boot,
      epoch: this.epoch,
      status: { qoder: this.host.workspaces.status(), hermes: { installed: this.hermesFound ?? false }, threads: this.threads() },
    }
  }

  private async find(key: string): Promise<ThreadView | undefined> {
    await this.ready
    let thread = this.threads().find((entry) => entry.key === key)
    if (thread === undefined) {
      await this.look()
      thread = this.threads().find((entry) => entry.key === key)
    }
    return thread
  }

  private async turns(thread: ThreadView): Promise<Turn[]> {
    if (thread.agent === 'hermes') return await hermesTurns(personaHome(this.host.hermesRoot(), thread.persona!), thread.id) ?? []
    const read = await this.qoder.read(thread.id)
    if (read !== undefined) return read.turns
    // Not written here yet: what the daemon saw.
    const task = thread.task
    return [
      ...(task?.prompt === undefined ? [] : [{ role: 'user' as const, text: task.prompt }]),
      ...(task?.summary === undefined ? [] : [{ role: 'assistant' as const, text: task.summary }]),
    ]
  }

  async thread(key: string): Promise<ThreadDetail> {
    const thread = await this.find(key)
    if (thread === undefined) throw new Error('No such thread')
    const turns = await this.turns(thread)
    return { thread, turns: turns.slice(-KEEP_TURNS), truncated: turns.length > KEEP_TURNS }
  }

  /** The Qoder model a taken-over session runs on: the thread's own when DSH offers it. */
  private async qoderModel(wanted: string | undefined): Promise<string> {
    const models: string[] = await this.host.qoderModels().catch(() => [])
    if (wanted !== undefined && models.includes(wanted)) return wanted
    return models.includes('auto') ? 'auto' : models[0] ?? wanted ?? 'auto'
  }

  async takeover(key: string, text: string | undefined): Promise<TakeoverResult> {
    const thread = await this.find(key)
    if (thread === undefined) throw new Error('No such thread')
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('DSH sessions are not available yet')
    let session = this.linked(key)
    if (session === undefined) {
      if (thread.phase === 'cloud') throw new Error(`This task runs in Qoder's cloud: open it on the web, or continue it in a terminal (${thread.command})`)
      if (thread.agent === 'qoder' && thread.phase === 'running') throw new Error(RUNNING)
      const route = thread.agent === 'qoder'
        ? { provider: QODER_PROVIDER, model: await this.qoderModel(thread.model) }
        : { provider: HERMES_PROVIDER, model: thread.persona! }
      const cwd = workingDir(thread.cwd)
      session = await sessions.start({ cwd, route, title: clip(thread.title, 60) })
      this.saved.links[key] = { session, at: Date.now() }
      this.save()
      this.changed()
    }
    const message = text?.trim() ?? ''
    if (message !== '') await sessions.send(session, message, randomUUID())
    return { session }
  }

  /**
   * Where a DSH session's first turn on an agent route picks up, when it was
   * opened by a takeover: the agent's session to load (Qoder), and the
   * transcript to start from when there is none to load.
   */
  async seed(sessionId: string): Promise<AcpSeed | undefined> {
    await this.ready
    const key = Object.entries(this.saved.links).find(([, link]) => link.session === sessionId)?.[0]
    const parsed = key === undefined ? undefined : parseKey(key)
    if (key === undefined || parsed === undefined) return undefined
    const context = async (): Promise<string | undefined> => {
      const thread = await this.find(key)
      if (thread === undefined) return undefined
      const turns = await this.turns(thread)
      return turns.length === 0 ? undefined : transcript(thread, turns)
    }
    return parsed.agent === 'qoder' ? { resume: parsed.id, context } : { context }
  }

  /** Continue a thread in a terminal window of this machine. */
  async terminal(key: string): Promise<{ command: string }> {
    const thread = await this.find(key)
    if (thread === undefined) throw new Error('No such thread')
    const cwd = workingDir(thread.cwd)
    let program: string
    let args: string[]
    if (thread.agent === 'qoder') {
      const found = this.host.findQoder()
      if (found === undefined) throw new Error('Qoder CLI CN is not installed')
      program = found
      args = thread.phase === 'cloud' ? ['--teleport', thread.id] : ['-r', thread.id]
    } else {
      const acp = this.host.findHermes()
      const exe = acp === undefined ? undefined : join(dirname(acp), process.platform === 'win32' ? 'hermes.exe' : 'hermes')
      program = exe !== undefined && existsSync(exe) ? exe : 'hermes'
      args = [...(thread.persona === 'default' ? [] : ['-p', thread.persona!]), '--resume', thread.id]
    }
    openTerminal(cwd, program, args, this.host.spawn)
    return { command: thread.command }
  }

  /**
   * A new Qoder cloud session for `task`, from a configured workspace; listed
   * until it is brought here. `pending`: the CLI is still at it after a few
   * seconds, and the session is listed once it opens.
   */
  async cloud(path: string, task: string): Promise<{ id: string; url: string } | { pending: true }> {
    await this.ready
    const text = task.trim()
    if (text === '') throw new Error('Nothing to send')
    if (!this.host.workspaces.status().workspaces.some((workspace) => workspace.path === path)) throw new Error('Not a configured workspace')
    const command = this.host.findQoder()
    if (command === undefined) throw new Error('Qoder CLI CN is not installed')
    const opening = this.openCloud(command, path, text)
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([opening, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), CLOUD_WAIT_MS) })])
    clearTimeout(timer)
    if (result !== undefined) return result
    opening.catch((error: unknown) => this.host.log(`cloud session not opened: ${(error as Error).message}`))
    return { pending: true }
  }

  private async openCloud(command: string, path: string, text: string): Promise<{ id: string; url: string }> {
    const output = await run(command, ['--remote', text], path, this.host.spawn, CLOUD_URL)
    const url = CLOUD_URL.exec(output)
    const id = url?.[1] ?? /\b(qs_[A-Za-z0-9]{10,})\b/.exec(output)?.[1]
    if (id === undefined) {
      const said = output.split('\n').map((line) => line.trim()).filter((line) => line !== '').pop()
      throw new Error(said === undefined ? 'Qoder did not open a cloud session' : clip(said, 300))
    }
    this.saved.cloud = [{ id, title: clip(text, 160), cwd: path, at: Date.now() }, ...this.saved.cloud.filter((entry) => entry.id !== id)].slice(0, KEEP_CLOUD)
    this.save()
    this.changed()
    return { id, url: url?.[0] ?? sessionUrl(id) }
  }

  dispose(): void {
    this.disposed = true
    this.offWorkspaces()
    clearTimeout(this.lookTimer)
    clearTimeout(this.wakeTimer)
    for (const wake of [...this.waiters]) wake()
  }
}

type Spawn = NonNullable<RelayHost['spawn']>

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

/** Run a CLI to its end (killed after CLOUD_TIMEOUT_MS), with what it printed; answered early once that matches `until`. */
function run(command: string, args: readonly string[], cwd: string, seam?: Spawn, until?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = seam?.(command, args, { cwd }) ?? spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error as Error)
      return
    }
    let output = ''
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve(plain(output))
    }
    const take = (data: Buffer | string): void => {
      if (output.length < 65_536) output += String(data)
      // What was wanted is out: the CLI goes on to its end on its own.
      if (until?.test(plain(output)) === true) finish()
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => child.kill(), CLOUD_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      if (done) return
      done = true
      reject(error)
    })
    child.once('close', () => {
      clearTimeout(timer)
      finish()
    })
  })
}

/** A terminal window of this machine, in `cwd`, running `program`. */
function openTerminal(cwd: string, program: string, args: readonly string[], seam?: Spawn): void {
  const posix = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
  let child: ChildProcess
  if (process.platform === 'win32') {
    // `start` opens a console window; cmd /k keeps it open once the CLI exits.
    const line = [program, ...args].map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '')}"` : part)).join(' ')
    const startLine = `start "Relay" /D "${cwd}" cmd.exe /k "${line}"`
    child = seam?.('cmd.exe', ['/d', '/c', startLine], { cwd, windowsVerbatimArguments: true, detached: true })
      ?? spawn('cmd.exe', ['/d', '/c', startLine], { cwd, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' })
  } else if (process.platform === 'darwin') {
    const script = `cd ${posix(cwd)} && ${[program, ...args].map(posix).join(' ')}`
    const apple = `tell application "Terminal" to do script ${JSON.stringify(script)}\ntell application "Terminal" to activate`
    child = seam?.('osascript', ['-e', apple], { cwd, detached: true }) ?? spawn('osascript', ['-e', apple], { cwd, detached: true, stdio: 'ignore' })
  } else {
    const script = `${[program, ...args].map(posix).join(' ')}; exec "\${SHELL:-sh}"`
    child = seam?.('x-terminal-emulator', ['-e', 'sh', '-c', script], { cwd, detached: true })
      ?? spawn('x-terminal-emulator', ['-e', 'sh', '-c', script], { cwd, detached: true, stdio: 'ignore' })
  }
  child.on('error', () => {})
  child.unref()
}
