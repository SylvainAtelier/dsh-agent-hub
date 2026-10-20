/**
 * What the `dsh` command and the composer's bell do (types.ts): hand a task
 * to a DSH model in a project and wait for its answer, report sessions, and
 * tell the glasses things (post.ts: a message into their latest session),
 * one batch at a time, held until a session can take it.
 *
 * Sessions are followed from DSH's session events (the ones the Cardputer
 * folds too): a turn's start and end, its answers, approvals asked. Every
 * command that waits on a session (`ask`, `reply`, `approve`, `deny`, `stop`,
 * `wait`) waits for its next stop: the turn ends, or it asks for approval. So
 * an approval comes back to the Qoder conversation that handed the task off,
 * and is only posted to the glasses when nothing waits there.
 */

import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { within } from '../git/service.ts'
import { localized } from '../locale.ts'
import { listModelGroups, type ModelCatalog, type ModelGroup } from '../models.ts'
import { BOT_ROUTE } from '../team/types.ts'
import { postHeader, type Posted } from './post.ts'
import type { GlassesStatus, GlassesUpdate, SessionPhase, SessionReport } from './types.ts'

export interface Route { provider: string; model: string }

/** The slice of DSH sessions a hand-off needs (review/index.ts's SessionHost). */
export interface BridgeSessions {
  start(input: { cwd: string; workspaceId?: string; title: string; route?: Route }): Promise<string>
  send(sessionId: string, text: string, requestId: string): Promise<void>
  cancel(sessionId: string): Promise<void>
}

/** The Cardputer's approvals (device/index.ts), which also hold the ones of sessions the glasses follow. */
export interface BridgeApprovals {
  decide(sessionId: string, allow: boolean): 'ok' | 'none' | 'refused' | 'off'
  waiting(sessionId: string): boolean
}

export interface BridgeHost {
  sessions(): BridgeSessions | undefined
  catalog(): ModelCatalog | undefined
  defaultRoute(): Route | undefined
  bots(): ReadonlyArray<{ id: string; description?: string }>
  workspaces(): ReadonlyArray<{ id: string; path: string; title: string }>
  isDirectory(path: string): boolean
  /** What `held` answers changed (the Qoder daemons time their reclaims again). */
  holdsChanged?(): void
  /** The glasses' sessions a notification can go to, best first; none without a way to post. */
  targets?(): Array<{ session: string; cwd: string }>
  /** Where to open a session when there is none: a workspace online here, by the web's new-task page. */
  opener?(): string | undefined
  /** Post a message into one of them. */
  post?(target: { session: string; cwd: string }, text: string): Promise<Posted>
  /** The branch checked out in `cwd`; none outside a repository or on a detached HEAD. */
  branch?(cwd: string): Promise<string | undefined>
  /** None while the device module is not running. */
  approvals?(): BridgeApprovals | undefined
  now?(): number
}

/** A session event as DSH emits it (device/view.ts reads the same). */
export interface BridgeEvent { type: string; time?: number; data?: Record<string, unknown> }
export interface BridgeSessionRef { header?: { id?: string; cwd?: string; origin?: string } }

/** Spoken names for the agents DSH bridges, to their provider ids. */
const ALIASES: Record<string, string> = {
  claude: 'claude-agent', 'claude-code': 'claude-agent', 'claude-agent': 'claude-agent',
  codex: 'openai-codex', 'openai-codex': 'openai-codex',
  cursor: 'cursor-agent', 'cursor-agent': 'cursor-agent',
  qoder: 'qoder-agent', 'qoder-agent': 'qoder-agent',
  hermes: 'hermes-agent', 'hermes-agent': 'hermes-agent',
}
const KEEP_SESSIONS = 64
const KEEP_NOTES = 20
const NOTE_MAX = 500
/** Sessions tried for one batch: one gone offline is passed over for the next. */
const TRY_TARGETS = 3
/** A batch that found no session, or failed, is tried again this much later (or when the daemons change). */
const RETRY_MS = 60_000
/** How long a status read waits for a change; under the Desktop update lock (10s). */
const WAIT_MS = 5_000
const WAKE_MS = 100

/** A refusal the caller can act on: an ambiguous or unknown name, with what it could have meant. */
export class ChooseError extends Error {
  readonly code = 'choose'
}

/** How a session is named in a note and a choice: its id's last characters, which `dsh` takes back. */
const short = (id: string): string => id.slice(-6)

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** How long a note waits for its branch before going without. */
const BRANCH_MS = 3_000
const TITLE_MAX = 30
const GIST_MAX = 60
/** What the titles of sessions the glasses start begin with. */
const GLASSES = { zh: '眼镜', en: 'Glasses' }
/** Sentences too empty to stand for a whole answer. */
const FILLER = /^(好的|好|ok|okay|done|完成了?|已完成|搞定)$/i

/**
 * The answer's first sentence that says something, as plain text: code, tables and markup dropped,
 * headings kept only when nothing else is there. One line, at most GIST_MAX characters.
 */
export function gist(text: string): string {
  const lines = text.replace(/```[\s\S]*?(```|$)/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('|'))
  const body = lines.filter((line) => !line.startsWith('#'))
  const plain = (body.length > 0 ? body : lines).map((line) => line
    .replace(/^#+\s*/, '')
    .replace(/^(>\s*)+/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|`)/g, ''))
    .join(' ')
  const sentences = plain.split(/(?<=[。！？!?；;])|(?<=\.)\s+/).map((sentence) => sentence.trim().replace(/[：:，,；;]+$/, ''))
  const found = sentences.find((sentence) => !FILLER.test(sentence.replace(/[。.！!？?]+$/, '')) && sentence.length >= 4)
  return clip(found ?? sentences.find((sentence) => sentence !== '') ?? '', GIST_MAX)
}

const textOf = (content: unknown): string => Array.isArray(content)
  ? content.filter((part) => (part as { type?: unknown })?.type === 'text' && typeof (part as { text?: unknown }).text === 'string').map((part) => (part as { text: string }).text).join('\n').trim()
  : ''

/** The one entry `name` picks: exact, else prefix, else substring; several or none refuse with the choices. */
function pick<T>(entries: readonly T[], name: string, keys: (entry: T) => string[], label: (entry: T) => string, what: string): T {
  const wanted = name.trim().toLowerCase()
  const tiers = [
    (key: string) => key === wanted,
    (key: string) => key.startsWith(wanted),
    (key: string) => key.includes(wanted),
  ]
  for (const tier of tiers) {
    const found = entries.filter((entry) => keys(entry).some((key) => tier(key.toLowerCase())))
    if (found.length === 1) return found[0]!
    if (found.length > 1) throw new ChooseError(`"${name}" matches several ${what}: ${found.map(label).join(', ')}`)
  }
  throw new ChooseError(`No ${what} named "${name}". Choose one of: ${entries.map(label).join(', ') || '(none)'}`)
}

interface Track extends SessionReport {
  /** Opened by `dsh ask`: its approvals are told to the glasses. */
  handedOff: boolean
  /** Something about it was told to the glasses: `dsh reply` and the like may mean it. */
  told: boolean
}

export class Bridge {
  private readonly host: BridgeHost
  private readonly now: () => number
  private tracks = new Map<string, Track>()
  /** Who waits for each session's next stop. */
  private stops = new Map<string, Set<() => void>>()
  private armed = new Set<string>()
  private notes: Array<{ id: string; text: string; at: number }> = []
  /** Notes of sessions waiting for their branch, in order. */
  private telling: Promise<void> = Promise.resolve()
  private posting = false
  private retryTimer: NodeJS.Timeout | undefined
  private holds = new Map<object, string>()
  private disposed = false

  readonly boot = randomUUID()
  private epoch = 0
  private waiters = new Set<() => void>()
  private wakeTimer: NodeJS.Timeout | undefined

  constructor(host: BridgeHost) {
    this.host = host
    this.now = host.now ?? Date.now
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  observe(session: BridgeSessionRef, event: BridgeEvent): void {
    const header = session.header
    const id = header?.id
    if (id === undefined || header?.origin === 'subagent') return
    const data = event.data ?? {}
    const at = typeof event.time === 'number' ? event.time : this.now()
    const track = this.track(id, header?.cwd)
    track.updatedAt = Math.max(track.updatedAt, at)
    switch (event.type) {
      case 'turn/start':
        track.phase = 'running'
        delete track.tool
        return
      case 'assistant/message': {
        const text = textOf((data.message as { content?: unknown } | undefined)?.content)
        if (text !== '') track.text = text
        return
      }
      case 'tool/call':
        if (typeof data.name === 'string') track.tool = data.name
        return
      case 'approval/asked':
        track.phase = 'approval'
        if (typeof data.toolName === 'string') track.tool = data.toolName
        // A `dsh` command waiting on it brings it back to its own conversation.
        if (!this.wake(id) && (this.armed.has(id) || track.handedOff)) this.tell(track, localized({ zh: `等审批：${track.tool ?? '工具调用'}`, en: `awaiting approval: ${track.tool ?? 'a tool call'}` }))
        return
      case 'approval/decided':
        if (track.phase === 'approval') track.phase = 'running'
        return
      case 'turn/end': {
        const reason = data.reason as { kind?: unknown; message?: unknown } | undefined
        track.phase = reason?.kind === 'completed' ? 'done'
          : reason?.kind === 'cancelled' || reason?.kind === 'aborted' || reason?.kind === 'interrupted' ? 'stopped' : 'failed'
        delete track.tool
        if (this.armed.delete(id)) {
          const why = typeof reason?.message === 'string' && reason.message !== '' ? gist(reason.message) : ''
          this.tell(track, track.phase === 'done' ? localized({ zh: `已完成：${gist(track.text ?? '') || '没有文字回答'}`, en: `done: ${gist(track.text ?? '') || 'no text answer'}` })
            : track.phase === 'stopped' ? localized({ zh: '已停止', en: 'stopped' })
              : localized({ zh: `失败${why ? `：${why}` : ''}`, en: `failed${why ? `: ${why}` : ''}` }))
          this.changed()
        }
        this.wake(id)
        return
      }
      case 'session/title':
        if (typeof data.title === 'string' && data.title.trim() !== '') track.title = clip(data.title, 80)
        return
      case 'request/context':
      case 'model/selection':
        if (typeof data.provider === 'string' && typeof data.model === 'string') track.model = `${data.provider} / ${data.model}`
        return
      default:
    }
  }

  private track(id: string, cwd?: string): Track {
    let track = this.tracks.get(id)
    if (track === undefined) {
      if (this.tracks.size >= KEEP_SESSIONS) {
        const oldest = [...this.tracks.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
        if (oldest !== undefined) this.tracks.delete(oldest.session)
      }
      track = { session: id, title: id, cwd: cwd ?? '', phase: 'idle', updatedAt: this.now(), handedOff: false, told: false }
      this.tracks.set(id, track)
    }
    if (cwd !== undefined && track.cwd === '') track.cwd = cwd
    return track
  }

  private report(track: Track): SessionReport {
    const { handedOff: _, told: __, ...report } = track
    return { ...report }
  }

  /** The session stopped: wake who waited for it; whether anyone did. */
  private wake(session: string): boolean {
    const waiting = this.stops.get(session)
    this.stops.delete(session)
    for (const wake of waiting ?? []) wake()
    return (waiting?.size ?? 0) > 0
  }

  /** Resolves on the session's next stop, or when `signal` aborts. */
  private nextStop(session: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.stops.get(session)?.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      let waiting = this.stops.get(session)
      if (waiting === undefined) this.stops.set(session, waiting = new Set())
      waiting.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * Do `act` to the session, then report it at its next stop (unless `stopped` says it already is).
   * Listening comes first: a quick turn may end before `act` returns. A caller gone before the stop
   * (its background run killed) turns the bell on, so the turn's end still reaches the glasses.
   */
  private async through(track: Track, act: () => Promise<unknown>, signal?: AbortSignal, stopped?: () => boolean): Promise<SessionReport> {
    const quit = new AbortController()
    const next = this.nextStop(track.session, signal === undefined ? quit.signal : AbortSignal.any([signal, quit.signal]))
    try {
      await act()
      if (stopped?.() !== true) await next
    } finally {
      quit.abort()
    }
    if (signal?.aborted === true && track.phase === 'running' && !this.disposed) {
      this.armed.add(track.session)
      this.changed()
    }
    return this.report(track)
  }

  /** Whether the glasses follow the session: handed off, its bell on, or told about. */
  follows(session: string): boolean {
    const track = this.tracks.get(session)
    return this.armed.has(session) || track?.handedOff === true || track?.told === true
  }

  /**
   * The session `name` means (its id, or a part of one such as a note's); with none, one the glasses
   * follow that `fits`: the latest, or, when `only`, the one (several refuse with the choices).
   */
  private resolve(name: string | undefined, fits: (track: Track) => boolean, what: string, only: boolean): Track {
    const label = (track: Track): string => `${short(track.session)} ${track.title}`
    const tracks = [...this.tracks.values()]
    const wanted = name?.trim() ?? ''
    if (wanted !== '') return pick(tracks, wanted, (track) => [track.session], label, 'DSH sessions')
    const found = tracks.filter((track) => this.follows(track.session) && fits(track)).sort((a, b) => b.updatedAt - a.updatedAt)
    if (found.length === 0) throw new ChooseError(`No DSH session ${what}`)
    if (only && found.length > 1) throw new ChooseError(`Several DSH sessions ${what}: ${found.map(label).join(', ')}`)
    return found[0]!
  }

  /** The agents a hand-off can go to: each provider DSH offers (its visible models) and the bots. */
  async agents(): Promise<{ groups: ModelGroup[]; bots: Array<{ id: string; description?: string }>; fallback?: Route }> {
    const catalog = this.host.catalog()
    const groups = catalog === undefined ? [] : (await listModelGroups(catalog, [BOT_ROUTE])).filter((group) => group.models.length > 0)
    const fallback = this.host.defaultRoute()
    return { groups, bots: this.host.bots().map(({ id, description }) => ({ id, ...(description ? { description } : {}) })), ...(fallback === undefined ? {} : { fallback }) }
  }

  /** The route `agent` and `model` name; DSH's default model when neither is given. */
  async route(agent: string | undefined, model: string | undefined): Promise<Route> {
    const fallback = this.host.defaultRoute()
    const wanted = agent?.trim() ?? ''
    if (wanted === '' && (model?.trim() ?? '') === '') {
      if (fallback === undefined) throw new ChooseError('DSH has no default model: name an agent (dsh agents)')
      return fallback
    }
    const { groups, bots } = await this.agents()
    const botId = /^bot:(.+)$/i.exec(wanted)?.[1]
    if (botId !== undefined || (wanted !== '' && ALIASES[wanted.toLowerCase()] === undefined && bots.some((bot) => bot.id.toLowerCase() === wanted.toLowerCase()))) {
      const bot = pick(bots, botId ?? wanted, (entry) => [entry.id], (entry) => `bot:${entry.id}`, 'bots')
      return { provider: BOT_ROUTE, model: bot.id }
    }
    const group = wanted === ''
      ? groups.find((entry) => entry.provider === fallback?.provider) ?? (() => { throw new ChooseError('Name an agent for that model (dsh agents)') })()
      : groups.find((entry) => entry.provider === ALIASES[wanted.toLowerCase()])
        ?? pick(groups, wanted, (entry) => [entry.provider, entry.name], (entry) => entry.name, 'agents')
    if (model !== undefined && model.trim() !== '') {
      const found = pick(group.models, model, (entry) => [entry.id, entry.name], (entry) => entry.id, `${group.name} models`)
      return { provider: group.provider, model: found.id }
    }
    if (fallback?.provider === group.provider) return fallback
    const first = group.models[0]
    if (first === undefined) throw new ChooseError(`${group.name} offers no model right now`)
    return { provider: group.provider, model: first.id }
  }

  /** The DSH projects a hand-off can go to. */
  projects(): Array<{ title: string; path: string }> {
    return this.host.workspaces().map(({ title, path }) => ({ title: title || basename(path), path }))
  }

  /** Where `project` (a name or a path) is; the caller's own folder when none is given. */
  place(project: string | undefined, cwd: string): { cwd: string; workspaceId?: string } {
    const workspaces = this.host.workspaces()
    const enclosing = (path: string): string | undefined => workspaces
      .filter((entry) => within(entry.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.id
    const wanted = project?.trim() ?? ''
    if (wanted === '' || (isAbsolute(wanted) && this.host.isDirectory(wanted))) {
      const path = wanted === '' ? cwd : wanted
      const id = enclosing(path)
      return { cwd: path, ...(id === undefined ? {} : { workspaceId: id }) }
    }
    const found = pick(workspaces, wanted, (entry) => [entry.title, basename(entry.path)], (entry) => entry.title || basename(entry.path), 'projects')
    return { cwd: found.path, workspaceId: found.id }
  }

  /**
   * A new DSH session on `agent`/`model` in `project`, told `text`. With `wait`, resolves at its next
   * stop (or once `signal` aborts: the session goes on), with the answer.
   */
  async ask(input: { agent?: string; model?: string; project?: string; cwd: string; text: string; wait: boolean }, signal?: AbortSignal): Promise<SessionReport> {
    const text = input.text.trim()
    if (text === '') throw new ChooseError('Say what the agent should do')
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('DSH sessions are not available yet')
    const route = await this.route(input.agent, input.model)
    const place = this.place(input.project, input.cwd)
    const title = `${localized(GLASSES)} · ${clip(text, 40)}`
    const session = await sessions.start({ ...place, title, route })
    const track = this.track(session, place.cwd)
    track.title = title
    track.model = `${route.provider} / ${route.model}`
    track.handedOff = true
    track.phase = 'running'
    const send = (): Promise<void> => sessions.send(session, text, randomUUID())
    if (!input.wait) {
      await send()
      return this.report(track)
    }
    return this.through(track, send, signal)
  }

  /** Tell a session (by default the latest the glasses follow) `text`; resolves at its next stop. */
  async reply(input: { session?: string; text: string }, signal?: AbortSignal): Promise<SessionReport> {
    const text = input.text.trim()
    if (text === '') throw new ChooseError('Say what the agent should do')
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('DSH sessions are not available yet')
    const track = this.resolve(input.session, () => true, 'the glasses follow', false)
    return this.through(track, async () => {
      // At work from now on, as a hand-off is: a caller gone before the turn starts still leaves the bell on.
      const before = track.phase
      track.phase = 'running'
      try {
        await sessions.send(track.session, text, randomUUID())
      } catch (error) {
        track.phase = before
        throw error
      }
    }, signal)
  }

  /**
   * Answer the approval a session waits for (by default the one session waiting), by the Cardputer's
   * rules; resolves at its next stop, or at once when it waits for another.
   */
  async decide(input: { session?: string; allow: boolean }, signal?: AbortSignal): Promise<SessionReport> {
    const approvals = this.host.approvals?.()
    if (approvals === undefined) throw new Error('DSH approvals are not available here: answer on the computer')
    const track = this.resolve(input.session, (entry) => approvals.waiting(entry.session), 'waiting for approval', true)
    return this.through(track, async () => {
      const outcome = approvals.decide(track.session, input.allow)
      if (outcome === 'none') throw new ChooseError(`DSH session ${short(track.session)} waits for no approval`)
      if (outcome === 'off') throw new Error('Approving from a device is off in DSH: only denying works here; approve on the computer')
      if (outcome === 'refused') throw new Error('This one can only be approved on the computer')
    }, signal, () => {
      if (!approvals.waiting(track.session)) return false
      track.phase = 'approval'
      return true
    })
  }

  /** Stop a session's turn (by default the one at work the glasses follow); resolves once it has. */
  async stop(session: string | undefined, signal?: AbortSignal): Promise<SessionReport> {
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('DSH sessions are not available yet')
    const track = this.resolve(session, (entry) => entry.phase === 'running' || entry.phase === 'approval', 'at work', true)
    if (track.phase !== 'running' && track.phase !== 'approval') return this.report(track)
    return this.through(track, () => sessions.cancel(track.session), signal)
  }

  /** A session's report at its next stop (by default the one at work the glasses follow); at once when it is stopped. */
  async wait(session: string | undefined, signal?: AbortSignal): Promise<SessionReport> {
    const track = this.resolve(session, (entry) => entry.phase === 'running', 'at work', true)
    if (track.phase !== 'running') return this.report(track)
    return this.through(track, async () => {}, signal)
  }

  /** One session's report, or the most recent ones, newest first. */
  status(session?: string): SessionReport[] {
    if (session !== undefined && session !== '') return [this.report(this.resolve(session, () => true, '', false))]
    const rank = (phase: SessionPhase): number => (phase === 'approval' ? 0 : phase === 'running' ? 1 : 2)
    return [...this.tracks.values()]
      .sort((a, b) => rank(a.phase) - rank(b.phase) || b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((track) => ({ ...this.report(track), ...(track.text === undefined ? {} : { text: clip(track.text, 160) }) }))
  }

  // ── Holds: a worker some `dsh` command waits on stays up ─────────────

  /** Hold workers in `cwd` until the returned release. */
  hold(cwd: string): () => void {
    const key = {}
    this.holds.set(key, cwd)
    this.host.holdsChanged?.()
    return () => {
      if (this.holds.delete(key)) this.host.holdsChanged?.()
    }
  }

  held(path: string): boolean {
    return [...this.holds.values()].some((cwd) => within(path, cwd))
  }

  // ── Telling the glasses ───────────────────────────────────────────────

  /**
   * Tell the glasses `what` of a session: `<branch> · <title> <what>（<id>）`, the branch read now (a
   * turn may have switched it), the id for a `dsh` command to name it by.
   */
  private tell(track: Track, what: string): void {
    track.told = true
    const title = track.title === track.session ? basename(track.cwd) || localized({ zh: '会话', en: 'session' }) : clip(track.title.replace(/^(眼镜|Glasses) · /, ''), TITLE_MAX)
    const id = localized({ zh: `（${short(track.session)}）`, en: ` (${short(track.session)})` })
    const say = (branch: string | undefined): void => this.notify(`${branch ? `${branch} · ` : ''}${title} ${what}${id}`)
    if (this.host.branch === undefined) return say(undefined)
    const branch = track.cwd === '' ? Promise.resolve(undefined) : this.host.branch(track.cwd)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, BRANCH_MS, undefined) })
    const named = Promise.race([branch.catch(() => undefined), late]).finally(() => clearTimeout(timer))
    // In the order told, whichever branch read ends first.
    this.telling = Promise.all([this.telling, named]).then(([, name]) => say(name))
  }

  /** Tell the glasses `text`, with whatever else waits, as soon as one of their sessions can take it. */
  notify(text: string): void {
    const line = clip(text, NOTE_MAX)
    if (line === '' || this.disposed) return
    this.notes.push({ id: randomUUID(), text: line, at: this.now() })
    if (this.notes.length > KEEP_NOTES) this.notes.splice(0, this.notes.length - KEEP_NOTES)
    this.changed()
    void this.flush()
  }

  /** Try what waits again now: the glasses' sessions changed. */
  retry(): void {
    void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.posting || this.disposed || this.notes.length === 0) return
    const targets = (this.host.post === undefined ? [] : this.host.targets?.() ?? []).slice(0, TRY_TARGETS)
    if (targets.length === 0) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.posting = true
    this.changed()
    const batch = this.notes.slice()
    const notes = batch.map((note) => note.text)
    const text = postHeader() + localized({
      zh: `请把下面的消息按原意简短转告我，每条一句，不要扩写，括号里的会话编号不用念，不要做别的操作：${notes.join('；')}`,
      en: `Relay the messages below to me briefly as they are, one sentence each, without expanding them; skip the session ids in brackets and do nothing else: ${notes.join('; ')}`,
    })
    let result: Posted = 'failed'
    for (const target of targets) {
      // The session's worker stays up while the message goes in.
      const release = this.hold(target.cwd)
      try {
        result = await this.host.post!(target, text)
      } finally {
        release()
      }
      if (result !== 'offline' || this.disposed) break
    }
    this.posting = false
    if (result === 'sent') {
      const sent = new Set(batch.map((note) => note.id))
      this.notes = this.notes.filter((note) => !sent.has(note.id))
    }
    this.changed()
    if (this.disposed) return
    if (result === 'sent') void this.flush()
    else {
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flush() }, RETRY_MS)
      this.retryTimer.unref?.()
    }
  }

  // ── The composer's bell ───────────────────────────────────────────────

  arm(sessionId: string, on: boolean): GlassesUpdate {
    if (on) this.armed.add(sessionId)
    else this.armed.delete(sessionId)
    this.changed()
    return this.update()
  }

  glasses(): GlassesStatus {
    const reachable = this.host.post !== undefined && (this.host.targets?.().length ?? 0) > 0
    const opener = reachable || this.host.post === undefined ? undefined : this.host.opener?.()
    return {
      reachable,
      ...(opener === undefined ? {} : { opener }),
      sending: this.posting,
      queued: this.notes.length,
      armed: [...this.armed],
    }
  }

  private update(): GlassesUpdate {
    return { boot: this.boot, epoch: this.epoch, status: this.glasses() }
  }

  /** The state now when it changed after `since` (or the host restarted), else once it changes or WAIT_MS passes. */
  read(boot: string | undefined, since: number | undefined, signal?: AbortSignal): Promise<GlassesUpdate> {
    if (boot !== this.boot || since !== this.epoch || this.disposed) return Promise.resolve(this.update())
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve(this.update())
      }
      const timer = setTimeout(done, WAIT_MS)
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private changed(): void {
    this.epoch++
    if (this.wakeTimer !== undefined || this.waiters.size === 0) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      for (const wake of [...this.waiters]) wake()
    }, WAKE_MS)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.wakeTimer)
    clearTimeout(this.retryTimer)
    for (const wake of [...this.waiters]) wake()
    for (const waiting of this.stops.values()) for (const wake of waiting) wake()
    this.stops.clear()
  }
}
