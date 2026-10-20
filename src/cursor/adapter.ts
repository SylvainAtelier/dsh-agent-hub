/**
 * The `cursor-agent` model route. Picking one of its models in DSH's model
 * selector hands each conversation turn to the Cursor CLI's agent over ACP
 * (acp.ts): Cursor runs the turn with its own tools, rules, MCP servers and
 * login, its permission prompts appear as DSH approval dialogs, and its reply
 * streams back as text, thinking and one-line tool notes (translate.ts).
 *
 * - Reasoning: each model's knobs fold into DSH's reasoning picker (models.ts)
 *   and are set on the session before the turn, in place.
 * - Continuity: replies name their ACP session; the next turn loads it (also
 *   after a host restart) and sends only what Cursor has not seen. A session
 *   that cannot be loaded starts over with the conversation as context.
 * - Usage: the turn's tokens and cost come from Cursor's usage events for
 *   that session (usage.ts) and close the reply as a note.
 * - Like Claude Agent, it only answers conversation turns; DSH's background
 *   requests (titles, compaction) go to another model through `delegate`.
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { within } from '../git/service.ts'
import { createHash } from 'node:crypto'
import { LlmAdapter, LlmError, ReasoningEffortId, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Channel } from '../claude/conversation.ts'
import { isResumedConversationRequest, pendingInput, skillNote, type HarnessMessage, type ReferenceSpill } from '../claude/translate.ts'
import { AcpAgent, AcpError, spawnAgent, type ConfigOption, type PermissionRequest, type SessionUpdate } from './acp.ts'
import { configFile, cursorEnv, findCursorAgent } from './cli.ts'
import { CursorCatalog, effortChanges, effortsOf, modelsOf, thoughtSpec, type Prober } from './models.ts'
import { addTotals, cursorReplay, CursorTurn, toolLine, type Chunk, type CursorReplay } from './translate.ts'
import { conversationUsage, type TurnUsage } from './usage.ts'
import { cursorBilling } from './billing.ts'

export const CURSOR_PROVIDER = 'cursor-agent'
const PROVIDER_NAME = 'Cursor'
/** Failure code for a signed-out CLI; outside DSH's retryable set, like Claude Agent's. */
export const CURSOR_AUTH = 'CURSOR_AUTH'
/** Cursor manages its own context; a large window keeps DSH from compacting on top of it. */
const CONTEXT_WINDOW = 1_000_000
/** The CLI process closes after this long without a turn; the next turn loads its session again. */
const IDLE_MS = 30 * 60_000
/** How often a running turn checks for heartbeat notes (translate.ts shows them at coarser marks). */
const TICK_MS = 15_000

/** The DSH host services this adapter borrows, read at call time. */
export interface CursorHost {
  agents(): { currentInitiator?(): unknown } | undefined
  approval(): { request(request: object): Promise<string> } | undefined
  log(message: string): void
  /** Background requests (compaction, titles) for another model; without it they fail. */
  delegate?(options: StreamOptions): AsyncIterable<object>
  /** Global instructions for this session, sent with the first prompt Cursor sees. */
  instructions?(sessionId: string): string | undefined
  /** Why a shell command must not run in this session (guard.ts); the permission is refused. */
  blocked?(command: unknown, sessionId: string): string | undefined
  /** A tool call that runs without the approval dialog (an unattended review session's safe ones). */
  trusted?(tool: string, input: Record<string, unknown>, sessionId: string, cwd?: string): boolean
  /** A turn finished: the plan's usage moved. */
  turnFinished?(): void
  /** Where an @session snapshot too large for the prompt is saved. */
  references?: ReferenceSpill
  catalogFile?: string
  /** Test seams. */
  acp?: AcpAgent
  usage?(conversation: string, after: number, from: number, signal?: AbortSignal): Promise<TurnUsage | undefined>
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

/** One DSH session's ACP session in the running CLI process. */
interface Live {
  session: string
  generation: number
  cwd: string
  options: ConfigOption[]
  busy: boolean
}

const AUTH_TEXT = /not (logged|signed) in|log ?in first|unauthenticated|authenticat|run .?agent login/i

function launch() {
  const found = findCursorAgent()
  if (found === undefined) throw new LlmError('Cursor CLI not found: install it (https://cursor.com/cli) and run `agent login` first', 'MISSING_CREDENTIAL')
  return found
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

export class CursorAgentAdapter extends LlmAdapter {
  private acp: AcpAgent
  private catalog: CursorCatalog
  private live = new Map<string, Live>()
  private sweeper: NodeJS.Timeout
  private host: CursorHost
  private probeDir = join(tmpdir(), 'dsh-agent-hub-cursor-probe')

  constructor(host: CursorHost) {
    super()
    this.host = host
    this.acp = host.acp ?? new AcpAgent({
      start: () => {
        const { command, args } = launch()
        return spawnAgent(command, args, cursorEnv())
      },
      configFile: configFile(),
      log: (message) => host.log(message),
    })
    this.catalog = new CursorCatalog(() => this.prober(), host.catalogFile, (message) => host.log(message))
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: PROVIDER_NAME }
  }

  override async listModels(provider: string) {
    return (await this.catalog.models()).map((model) => ({ provider, id: model.id, name: model.name, billing: cursorBilling(model.id) }))
  }

  override async resolveModel(provider: string, model: string) {
    const name = (await this.catalog.models().catch(() => [])).find((entry) => entry.id === model)?.name
    const spec = await this.catalog.thought(model).catch(() => undefined)
    const efforts = spec === undefined ? [] : effortsOf(spec)
    return {
      provider,
      id: model,
      name: name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
      ...(efforts.length === 0 ? {} : {
        reasoning: {
          efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
          defaultEffort: ReasoningEffortId(spec?.defaultEffort !== undefined && efforts.some((effort) => effort.id === spec.defaultEffort) ? spec.defaultEffort : efforts.at(-1)!.id),
        },
      }),
    }
  }

  /** A probe session in a scratch folder: lists models and reads each one's knobs, without a prompt. */
  private prober(): Prober {
    let session: string | undefined
    return {
      open: async () => {
        await mkdir(this.probeDir, { recursive: true })
        const info = await this.acp.newSession(this.probeDir)
        session = info.sessionId
        return modelsOf(info.configOptions)
      },
      options: (model) => this.acp.configure(session!, 'model', model),
      close: async () => {
        // Cursor keeps every ACP session on disk; the probe's own is removed.
        if (session === undefined) return
        const dir = join(dirname(configFile()), 'acp-sessions', session)
        try {
          const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as { cwd?: unknown }
          if (typeof meta.cwd === 'string' && relative(meta.cwd, this.probeDir) === '') await rm(dir, { recursive: true, force: true })
        } catch {
          // Not written (yet): nothing to tidy.
        }
      },
    }
  }

  async *stream(options: StreamOptions): AsyncGenerator<object> {
    if (options.provider !== CURSOR_PROVIDER) throw new LlmError('Cursor only answers conversation turns', 'UNSUPPORTED_REQUEST')
    if (options.purpose !== undefined || options.sessionId === undefined
      || (!isAgentLoopRequest(options) && !isResumedConversationRequest(options))) {
      if (this.host.delegate === undefined) throw new LlmError('Cursor only answers conversation turns', 'UNSUPPORTED_REQUEST')
      yield* this.host.delegate(options)
      return
    }
    const agent = this.host.agents()?.currentInitiator?.() as { session?: { header?: { cwd?: string } } } | undefined
    const key = String(options.sessionId)
    const cwd = agent?.session?.header?.cwd ?? homedir()
    const previous = lastReplay(options.messages)
    let input = pendingInput(options.messages, CURSOR_PROVIDER, (state) => cursorReplay(state)?.session, this.host.references)
    if (input.prompt === '') throw new LlmError('Nothing new to send to Cursor', 'EMPTY_RESPONSE')

    let live: Live
    let fresh: boolean
    try {
      ({ live, fresh } = await this.session(key, cwd, input.resume))
    } catch (error) {
      throw this.failure(error, 'Cursor CLI could not start a session')
    }
    if (live.busy) throw new LlmError('Cursor is already answering a turn in this session', 'UNSUPPORTED_REQUEST')
    live.busy = true
    try {
      // A new ACP session has seen nothing: hand it the whole conversation.
      if (fresh && input.resume !== undefined) input = pendingInput(options.messages, CURSOR_PROVIDER, () => undefined, this.host.references)
      const since = fresh || previous?.session !== live.session ? Date.now() : previous.since
      const carried = fresh || previous?.session !== live.session ? undefined : previous

      await this.prepare(live, options.model, options.reasoningEffort)
      const context = [options.persona, this.host.instructions?.(key)].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n')
      const contextHash = context === '' ? undefined : digest(context)
      const preface = contextHash !== undefined && (fresh || carried?.context !== contextHash) ? `<system-reminder>\n${context}\n</system-reminder>\n\n` : ''

      const translator = new CursorTurn()
      const chunks = new Channel<Chunk[]>()
      for (const name of input.skills ?? []) chunks.push(translator.note(skillNote(name)))
      const signal = options.signal
      const cancel = (): void => this.acp.cancel(live.session)
      signal?.addEventListener('abort', cancel, { once: true })
      // ACP reports no progress of its own: a clock reads the translator's heartbeats.
      const clock = setInterval(() => {
        const next = translator.tick()
        if (next.length > 0) chunks.push(next)
      }, TICK_MS)
      clock.unref()
      const turn = this.acp.prompt(live.session, [{ type: 'text', text: preface + input.prompt }], {
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
          throw new LlmError('Cursor turn aborted', 'ABORTED')
        }
        if (stop === 'refusal') throw new LlmError('Cursor refused to answer this turn', 'PROVIDER')
      } catch (error) {
        if (error instanceof LlmError) throw error
        if (signal?.aborted) throw new LlmError('Cursor turn aborted', 'ABORTED', { cause: error })
        throw this.failure(error, 'Cursor failed')
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
      this.host.turnFinished?.()

      // Usage events land a second or two after the turn; later ones are read by the next turn.
      const after = carried?.through ?? 0
      const usage = await (this.host.usage ?? ((conversation, from, start, abort) => conversationUsage(conversation, from, start, { ...(abort === undefined ? {} : { signal: abort }) })))(live.session, after, since, signal).catch(() => undefined)
      const state: CursorReplay['cursor'] = { session: live.session, since }
      const through = usage?.through ?? carried?.through
      if (through !== undefined) state.through = through
      // Always present, even empty: the token ledger reads a reply without totals as a pre-totals record.
      state.total = usage === undefined ? carried?.total ?? {} : addTotals(carried?.total, usage)
      const cents = (carried?.cents ?? 0) + (usage?.cents ?? 0)
      if (cents > 0) state.cents = cents
      if (contextHash !== undefined) state.context = contextHash
      const replay: CursorReplay = { cursor: state }
      yield* translator.finish(replay, usage)
    } finally {
      live.busy = false
    }
  }

  /**
   * The ACP session for a DSH session: the live one, else the one its last
   * Cursor reply names (loaded from Cursor's store), else a new one. A forked
   * DSH session carries its parent's ACP session; that one stays with the
   * parent and the fork starts its own.
   */
  private async session(key: string, cwd: string, resume: string | undefined): Promise<{ live: Live; fresh: boolean }> {
    const current = this.live.get(key)
    if (current !== undefined && current.generation === this.acp.generation && relative(current.cwd, cwd) === '' && (resume === undefined || resume === current.session)) {
      return { live: current, fresh: false }
    }
    if (current?.busy) return { live: current, fresh: false }
    this.live.delete(key)
    await this.acp.start()
    const taken = resume !== undefined && [...this.live.entries()].some(([other, entry]) => other !== key && entry.session === resume && entry.generation === this.acp.generation)
    if (resume !== undefined && !taken) {
      try {
        const info = await this.acp.loadSession(resume, cwd)
        const live: Live = { session: resume, generation: this.acp.generation, cwd, options: info.configOptions, busy: false }
        this.live.set(key, live)
        return { live, fresh: false }
      } catch (error) {
        this.host.log(`Cursor session ${resume} could not be loaded, starting a new one: ${(error as Error).message}`)
      }
    }
    const info = await this.acp.newSession(cwd)
    const live: Live = { session: info.sessionId, generation: this.acp.generation, cwd, options: info.configOptions, busy: false }
    this.live.set(key, live)
    return { live, fresh: true }
  }

  /** Put the session on the picked model and reasoning level; unchanged knobs are left alone. */
  private async prepare(live: Live, model: string, effort: string | undefined): Promise<void> {
    const current = live.options.find((option) => option.id === 'model')?.currentValue
    if (current !== model) {
      live.options = await this.acp.configure(live.session, 'model', model)
      this.catalog.learn(model, live.options)
    }
    if (effort === undefined) return
    const spec = thoughtSpec(live.options)
    if (spec === undefined) return
    for (const [id, value] of effortChanges(spec, effort, live.options)) live.options = await this.acp.configure(live.session, id, value)
  }

  /** A Cursor permission request, answered through DSH's approval dialog (and the blocked-command rules). */
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
      toolName: line.split(':')[0] ?? 'Cursor',
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
    if (AUTH_TEXT.test(message + detail)) {
      return new LlmError('Cursor CLI is not signed in, so this turn was not sent. Run `agent login` in a terminal, then send again.', CURSOR_AUTH, { cause: error })
    }
    return new LlmError(`${prefix}: ${message}${detail}`, 'TRANSPORT', { cause: error })
  }

  /** Close the CLI process after a while without turns; the next turn loads its session again. */
  private sweep(): void {
    if (!this.acp.running || [...this.live.values()].some((live) => live.busy)) return
    if (Date.now() - this.acp.lastUsed < IDLE_MS) return
    this.acp.close()
    this.live.clear()
  }

  /**
   * A worktree is about to be removed: Windows will not delete a folder a
   * process works in, so the CLI closes if any session works there. Its
   * sessions load again on their next turn.
   */
  release(dir: string): number {
    const affected = [...this.live.values()].filter((live) => within(dir, live.cwd)).length
    if (affected > 0) {
      this.acp.close()
      this.live.clear()
    }
    return affected
  }

  dispose(): void {
    clearInterval(this.sweeper)
    this.acp.close()
    this.live.clear()
  }
}

/** The replay state of the last Cursor reply in the conversation. */
function lastReplay(messages: readonly HarnessMessage[]): CursorReplay['cursor'] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || message.source?.provider !== CURSOR_PROVIDER) continue
    const replay = cursorReplay(message.source?.replayState)
    if (replay !== undefined) return replay
  }
  return undefined
}
