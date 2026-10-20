/**
 * A model route whose turns an ACP agent runs: picking one of its models in
 * DSH's model selector hands each conversation turn to the agent CLI (the
 * shared client, client.ts), its permission prompts become DSH approval
 * dialogs, and its reply streams back as text, thinking and one-line tool
 * notes (turn.ts). What differs per agent is an {@link AcpProfile}:
 *
 * - Processes: each model names the process its turns run in. Qoder runs one
 *   process for every model; Hermes runs one per persona (its own
 *   HERMES_HOME), so the route keeps a pool keyed by process. A turn that has
 *   to start its process first says so: Hermes takes some 20 seconds.
 * - Models: listed from a probe session of the agent (stale-while-revalidate,
 *   persisted), or by the profile itself (Hermes' personas are its folders).
 *   A session switches model through its `model` config option, or through
 *   `session/set_model` on agents with the older shape.
 * - Continuity: replies name their ACP session and process; the next turn
 *   loads it (also after a host restart) and sends only what the agent has
 *   not seen. A session that cannot be loaded starts over with the
 *   conversation as context.
 * - Like Claude Agent, it only answers conversation turns; DSH's background
 *   requests (titles, compaction) go to another model through `delegate`.
 *
 * Cursor still runs on its own adapter (cursor/adapter.ts), which shares the
 * client and the translator but adds its reasoning levels and usage.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { LlmAdapter, LlmError, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { within } from '../git/service.ts'
import { jsonWriter } from '../persistence.ts'
import { Channel } from '../claude/conversation.ts'
import { isResumedConversationRequest, pendingInput, skillNote, type HarnessMessage, type ReferenceSpill } from '../claude/translate.ts'
import { AcpAgent, AcpError, modelChoice, spawnAcp, type Child, type ConfigOption, type ModelChoice, type PermissionRequest, type SessionInfo, type SessionUpdate } from './client.ts'
import { AcpTurn, toolLine, type Chunk, type Part } from './turn.ts'

/** How to start one agent process. */
export interface AcpProcess {
  /** Processes are shared by key: every model with the same key runs in one process. */
  key: string
  command: string
  args: readonly string[]
  env: Record<string, string | undefined>
}

/** A model as DSH's selector shows it. */
export interface RouteModel {
  id: string
  name: string
  /** A line on what it is, shown beside it in the settings (a Hermes persona's profile description). */
  description?: string
}

export interface AcpProfile {
  /** The route id in DSH's model selector, e.g. `qoder-agent`. */
  provider: string
  /** The provider's display name, e.g. `Qoder`. */
  name: string
  /** The process a model's turns run in; undefined when the agent is not installed (`missing` says what to do). */
  process(model: string): AcpProcess | undefined
  /** Why there is no process: shown as the turn's error. */
  missing: string
  /** Shown when the agent answers that it is not signed in. */
  signIn: string
  /** Failure code for a signed-out agent; outside DSH's retryable set. */
  authCode: string
  /**
   * The models DSH offers. Without it they are read from a probe session of
   * the process for {@link probeModel}, and {@link present} names them.
   */
  models?(): Promise<RouteModel[]>
  /** The model whose process the probe session runs in. */
  probeModel?: string
  /** A probed model's name in the selector (the agent's description may add to it). */
  present?(model: ModelChoice): RouteModel
  /** The agent-side model to put a session on; undefined leaves the session's own (a persona's configured model). */
  agentModel?(model: string): string | undefined
}

/** The DSH host services the route borrows, read at call time. */
export interface AcpHost {
  agents(): { currentInitiator?(): unknown } | undefined
  approval(): { request(request: object): Promise<string> } | undefined
  log(message: string): void
  /** Background requests (compaction, titles) for another model; without it they fail. */
  delegate?(options: StreamOptions): AsyncIterable<object>
  /**
   * Where a DSH session with no reply from this route yet picks up: one
   * opened to take over a conversation held elsewhere (relay/index.ts).
   */
  seed?(sessionId: string): Promise<AcpSeed | undefined>
  /** Global instructions for this session, sent with the first prompt the agent sees. */
  instructions?(sessionId: string): string | undefined
  /** Why a shell command must not run in this session (guard.ts); the permission is refused. */
  blocked?(command: unknown, sessionId: string): string | undefined
  /** A tool call that runs without the approval dialog. */
  trusted?(tool: string, input: Record<string, unknown>, sessionId: string, cwd?: string): boolean
  turnFinished?(): void
  references?: ReferenceSpill
  /** Where the probed model list persists. */
  catalogFile?: string
  /** Test seam: the process for a key. */
  spawn?(process: AcpProcess): Child
}

/** A conversation held elsewhere that a DSH session continues. */
export interface AcpSeed {
  /** The agent's session to load. */
  resume?: string
  /** Its transcript, for an agent session that starts over (none to load, or it could not be loaded). */
  context?(): Promise<string | undefined>
}

export interface StreamOptions {
  provider: string
  model: string
  reasoningEffort?: string
  purpose?: string
  sessionId?: unknown
  /** A bot's persona (team/route.ts), sent with the instructions. */
  persona?: string
  messages: readonly HarnessMessage[]
  signal?: AbortSignal
}

/**
 * The `replayState` stamped on the route's replies: the ACP session to load,
 * the process it lives in, and a digest of the persona and instructions last
 * sent (a change sends them again).
 */
export interface AcpReplay {
  acp: {
    session: string
    process: string
    context?: string
  }
}

export function acpReplay(state: unknown): AcpReplay['acp'] | undefined {
  const replay = (state as Partial<AcpReplay> | undefined)?.acp
  return typeof replay?.session === 'string' && replay.session !== '' && typeof replay.process === 'string' ? replay : undefined
}

/** One DSH session's ACP session in a running agent process. */
interface Live {
  key: string
  session: string
  generation: number
  cwd: string
  info: Pick<SessionInfo, 'configOptions' | 'models'>
  busy: boolean
}

interface Pooled {
  agent: AcpAgent
  process: AcpProcess
}

const CONTEXT_WINDOW = 1_000_000
/** An agent process closes after this long without a turn; the next turn loads its session again. */
const IDLE_MS = 30 * 60_000
/** How often a running turn checks for heartbeat notes. */
const TICK_MS = 15_000
const CATALOG_TTL_MS = 12 * 60 * 60_000
const CATALOG_RETRY_MS = 60_000
const AUTH_TEXT = /not (logged|signed) in|log ?in first|unauthenticated|authenticat/i

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

export class AcpRoute extends LlmAdapter {
  readonly profile: AcpProfile
  private host: AcpHost
  private pool = new Map<string, Pooled>()
  private live = new Map<string, Live>()
  private sweeper: NodeJS.Timeout
  private probeDir: string
  private catalog: { at: number; models: RouteModel[] } | undefined
  private reading: Promise<void> | undefined
  private failedAt = 0
  private restored: Promise<void>
  private write: ((value: unknown) => Promise<void>) | undefined

  constructor(profile: AcpProfile, host: AcpHost) {
    super()
    this.profile = profile
    this.host = host
    this.probeDir = join(tmpdir(), `dsh-agent-hub-${profile.provider}-probe`)
    this.write = host.catalogFile === undefined ? undefined : jsonWriter(host.catalogFile)
    this.restored = this.restore()
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.profile.name }
  }

  override async listModels(provider: string) {
    return (await this.models()).map((model) => ({ provider, id: model.id, name: model.name, ...(model.description === undefined ? {} : { description: model.description }) }))
  }

  override async resolveModel(provider: string, model: string) {
    const name = (await this.models().catch(() => [])).find((entry) => entry.id === model)?.name
    return { provider, id: model, name: name ?? model, inputModalities: ['text'], context: { contextWindow: CONTEXT_WINDOW } }
  }

  /** The models on offer: the profile's own list, else the probed catalog (answered at once once any is known). */
  async models(): Promise<RouteModel[]> {
    if (this.profile.models !== undefined) return this.profile.models()
    await this.restored
    const stale = this.catalog === undefined || Date.now() - this.catalog.at >= CATALOG_TTL_MS
    if (stale && this.reading === undefined && Date.now() - this.failedAt >= CATALOG_RETRY_MS) {
      this.reading = this.probe().catch((error: unknown) => {
        this.failedAt = Date.now()
        this.host.log(`${this.profile.name} model list unavailable: ${(error as Error).message}`)
      }).finally(() => { this.reading = undefined })
    }
    if (this.catalog === undefined) await this.reading
    return this.catalog?.models ?? []
  }

  /** A probe session in a scratch folder lists the models, without a prompt. */
  private async probe(): Promise<void> {
    const pooled = this.processFor(this.profile.probeModel ?? '')
    await mkdir(this.probeDir, { recursive: true })
    const info = await pooled.agent.newSession(this.probeDir)
    const present = this.profile.present ?? ((model: ModelChoice): RouteModel => ({ id: model.id, name: model.name }))
    const models = modelChoice(info).models.map(present)
    if (models.length === 0) throw new Error('the agent listed no models')
    this.catalog = { at: Date.now(), models }
    this.write?.(this.catalog).catch((error: unknown) => this.host.log(`${this.profile.name} model list save failed: ${(error as Error).message}`))
  }

  private async restore(): Promise<void> {
    if (this.host.catalogFile === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.host.catalogFile, 'utf8')) as { at?: unknown; models?: unknown }
      if (typeof saved.at === 'number' && Array.isArray(saved.models) && saved.models.length > 0) this.catalog = { at: saved.at, models: saved.models as RouteModel[] }
    } catch {
      // Nothing saved yet: the first lookup reads it live.
    }
  }

  /** The pooled process for a model, started on first use. */
  private processFor(model: string): Pooled {
    const process = this.profile.process(model)
    if (process === undefined) throw new LlmError(this.profile.missing, 'MISSING_CREDENTIAL')
    const known = this.pool.get(process.key)
    if (known !== undefined) return known
    const agent = new AcpAgent({
      name: `${this.profile.name} CLI`,
      start: () => (this.host.spawn ?? ((entry: AcpProcess) => spawnAcp(entry.command, entry.args, entry.env)))(process),
      log: (message) => this.host.log(message),
    })
    const pooled = { agent, process }
    this.pool.set(process.key, pooled)
    return pooled
  }

  async *stream(options: StreamOptions): AsyncGenerator<object> {
    const name = this.profile.name
    if (options.provider !== this.profile.provider) throw new LlmError(`${name} only answers conversation turns`, 'UNSUPPORTED_REQUEST')
    if (options.purpose !== undefined || options.sessionId === undefined
      || (!isAgentLoopRequest(options) && !isResumedConversationRequest(options))) {
      if (this.host.delegate === undefined) throw new LlmError(`${name} only answers conversation turns`, 'UNSUPPORTED_REQUEST')
      yield* this.host.delegate(options)
      return
    }
    const agent = this.host.agents()?.currentInitiator?.() as { session?: { header?: { cwd?: string } } } | undefined
    const key = String(options.sessionId)
    const cwd = agent?.session?.header?.cwd ?? homedir()
    const previous = lastReplay(options.messages, this.profile.provider)
    const seed = previous === undefined ? await this.host.seed?.(key).catch(() => undefined) : undefined
    let input = pendingInput(options.messages, this.profile.provider, (state) => acpReplay(state)?.session, this.host.references)
    if (input.prompt === '') throw new LlmError(`Nothing new to send to ${name}`, 'EMPTY_RESPONSE')

    const translator = new AcpTurn(name)
    let pooled: Pooled
    let live: Live
    let fresh: boolean
    try {
      pooled = this.processFor(options.model)
      // A cold start runs before any output: say so rather than sit silent.
      if (!pooled.agent.running) yield* translator.note(`⏳ Starting ${name}…`)
      ;({ live, fresh } = await this.session(key, pooled, cwd, previous?.process === pooled.process.key ? input.resume : seed?.resume))
    } catch (error) {
      throw this.failure(error, `${name} could not start a session`)
    }
    if (live.busy) throw new LlmError(`${name} is already answering a turn in this session`, 'UNSUPPORTED_REQUEST')
    live.busy = true
    try {
      // A new ACP session has seen nothing: hand it the whole conversation.
      if (fresh && input.resume !== undefined) input = pendingInput(options.messages, this.profile.provider, () => undefined, this.host.references)
      const carried = fresh || previous?.session !== live.session ? undefined : previous

      try {
        await this.prepare(pooled, live, options.model)
      } catch (error) {
        throw this.failure(error, `${name} could not switch to ${options.model}`)
      }
      const context = [options.persona, this.host.instructions?.(key)].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n')
      const contextHash = context === '' ? undefined : digest(context)
      // A taken-over conversation the agent starts over: its history comes first.
      const history = fresh ? await seed?.context?.().catch(() => undefined) : undefined
      const preface = [
        ...(history === undefined ? [] : [history]),
        ...(contextHash !== undefined && (fresh || carried?.context !== contextHash) ? [context] : []),
      ].map((part) => `<system-reminder>\n${part}\n</system-reminder>\n\n`).join('')

      const chunks = new Channel<Part[]>()
      for (const skill of input.skills ?? []) chunks.push(translator.note(skillNote(skill)))
      const signal = options.signal
      const cancel = (): void => pooled.agent.cancel(live.session)
      signal?.addEventListener('abort', cancel, { once: true })
      const clock = setInterval(() => {
        const next = translator.tick()
        if (next.length > 0) chunks.push(next)
      }, TICK_MS)
      clock.unref()
      const turn = pooled.agent.prompt(live.session, [{ type: 'text', text: preface + input.prompt }], {
        update: (update: SessionUpdate) => {
          const next = translator.push(update)
          if (next.length > 0) chunks.push(next)
        },
        permission: (request, permissionSignal) => this.permit(request, agent, key, AbortSignal.any([permissionSignal, ...(signal === undefined ? [] : [signal])])),
      }).finally(() => {
        clearInterval(clock)
        chunks.end()
      })
      turn.catch(() => {})
      try {
        for await (const batch of chunks) yield* batch
        const stop = await turn
        if (signal?.aborted || stop === 'cancelled') {
          yield* translator.abort()
          throw new LlmError(`${name} turn aborted`, 'ABORTED')
        }
        if (stop === 'refusal') throw new LlmError(`${name} refused to answer this turn`, 'PROVIDER')
      } catch (error) {
        if (error instanceof LlmError) throw error
        if (signal?.aborted) throw new LlmError(`${name} turn aborted`, 'ABORTED', { cause: error })
        throw this.failure(error, `${name} failed`)
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
      this.host.turnFinished?.()
      const replay: AcpReplay = { acp: { session: live.session, process: live.key, ...(contextHash === undefined ? {} : { context: contextHash }) } }
      yield* translator.end(replay) as Chunk<AcpReplay>[]
    } finally {
      live.busy = false
    }
  }

  /**
   * The ACP session for a DSH session: the live one, else the one its last
   * reply names (loaded from the agent's store), else a new one. A forked DSH
   * session carries its parent's ACP session; that one stays with the parent
   * and the fork starts its own.
   */
  private async session(key: string, pooled: Pooled, cwd: string, resume: string | undefined): Promise<{ live: Live; fresh: boolean }> {
    const { agent, process } = pooled
    const current = this.live.get(key)
    if (current !== undefined && current.key === process.key && current.generation === agent.generation && relative(current.cwd, cwd) === ''
      && (resume === undefined || resume === current.session)) {
      return { live: current, fresh: false }
    }
    if (current?.busy) return { live: current, fresh: false }
    this.live.delete(key)
    await agent.start()
    const taken = resume !== undefined && [...this.live.entries()].some(([other, entry]) => other !== key && entry.session === resume && entry.key === process.key && entry.generation === agent.generation)
    if (resume !== undefined && !taken) {
      try {
        const info = await agent.loadSession(resume, cwd)
        const live: Live = { key: process.key, session: resume, generation: agent.generation, cwd, info, busy: false }
        this.live.set(key, live)
        return { live, fresh: false }
      } catch (error) {
        this.host.log(`${this.profile.name} session ${resume} could not be loaded, starting a new one: ${(error as Error).message}`)
      }
    }
    const info = await agent.newSession(cwd)
    const live: Live = { key: process.key, session: info.sessionId, generation: agent.generation, cwd, info, busy: false }
    this.live.set(key, live)
    return { live, fresh: true }
  }

  /** Put the session on the picked model; an unchanged model is left alone. */
  private async prepare(pooled: Pooled, live: Live, model: string): Promise<void> {
    const wanted = this.profile.agentModel === undefined ? model : this.profile.agentModel(model)
    if (wanted === undefined) return
    const choice = modelChoice(live.info)
    if (choice.current === wanted) return
    if (choice.viaOption) {
      const configOptions: ConfigOption[] = await pooled.agent.configure(live.session, 'model', wanted)
      live.info = { ...live.info, configOptions }
    } else {
      await pooled.agent.setModel(live.session, wanted)
      live.info = { ...live.info, models: { availableModels: live.info.models?.availableModels ?? [], currentModelId: wanted } }
    }
  }

  /** A permission request, answered through DSH's approval dialog (and the blocked-command rules). */
  private async permit(request: PermissionRequest, agent: unknown, key: string, signal: AbortSignal): Promise<string | undefined> {
    const pick = (kind: string): string | undefined => request.options.find((option) => option.kind === kind)?.optionId
    const reject = pick('reject_once') ?? pick('reject_always')
    const call = request.toolCall
    const command = (call.rawInput as { command?: unknown } | undefined)?.command
    if (call.kind === 'execute' && this.host.blocked?.(command, key) !== undefined) return reject
    const input = typeof call.rawInput === 'object' && call.rawInput !== null ? call.rawInput as Record<string, unknown> : {}
    if (this.host.trusted?.(call.kind ?? '', input, key) === true) return pick('allow_once') ?? pick('allow_always')
    const approval = this.host.approval()
    if (approval === undefined || agent === undefined) return reject
    const line = toolLine(call.kind, call.title)
    const outcome = await approval.request({
      agent,
      toolName: line.split(':')[0] ?? this.profile.name,
      ...(call.toolCallId === undefined ? {} : { callId: call.toolCallId }),
      reason: line,
      signal,
    })
    return outcome === 'allowed-once' ? pick('allow_once') ?? pick('allow_always') : reject
  }

  private failure(error: unknown, prefix: string): LlmError {
    if (error instanceof LlmError) return error
    const message = (error as Error).message ?? String(error)
    const detail = error instanceof AcpError && typeof error.data === 'object' && error.data !== null ? ` ${JSON.stringify(error.data).slice(0, 300)}` : ''
    if (AUTH_TEXT.test(message + detail)) return new LlmError(this.profile.signIn, this.profile.authCode, { cause: error })
    return new LlmError(`${prefix}: ${message}${detail}`, 'TRANSPORT', { cause: error })
  }

  /** Close each process after a while without turns; the next turn loads its sessions again. */
  private sweep(): void {
    for (const [processKey, pooled] of this.pool) {
      const busy = [...this.live.values()].some((live) => live.key === processKey && live.busy)
      if (busy || !pooled.agent.running || Date.now() - pooled.agent.lastUsed < IDLE_MS) continue
      this.closeProcess(processKey)
    }
  }

  private closeProcess(processKey: string): void {
    this.pool.get(processKey)?.agent.close()
    for (const [key, live] of this.live) if (live.key === processKey) this.live.delete(key)
  }

  /**
   * A worktree is about to be removed: Windows will not delete a folder a
   * process works in, so a process closes if any of its sessions works there.
   * Its sessions load again on their next turn.
   */
  release(dir: string): number {
    const affected = [...this.live.values()].filter((live) => within(dir, live.cwd))
    for (const processKey of new Set(affected.map((live) => live.key))) this.closeProcess(processKey)
    return affected.length
  }

  dispose(): void {
    clearInterval(this.sweeper)
    for (const processKey of [...this.pool.keys()]) this.closeProcess(processKey)
    this.pool.clear()
  }
}

/** The replay state of the route's last reply in the conversation. */
function lastReplay(messages: readonly HarnessMessage[], provider: string): AcpReplay['acp'] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || message.source?.provider !== provider) continue
    const replay = acpReplay(message.source?.replayState)
    if (replay !== undefined) return replay
  }
  return undefined
}
