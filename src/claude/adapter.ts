/**
 * The `claude-agent` model route. Picking one of its models in DSH's model
 * selector hands each conversation turn to a long-lived Claude Code session:
 * Claude Code runs the turn with its own tools, settings and login, its
 * permission prompts appear as DSH approval dialogs, and its reply streams
 * back as text, thinking and one-line tool notes.
 *
 * Only conversation turns a person started reach Claude Code. Auxiliary
 * requests (session titles, compaction summaries) are refused so DSH falls
 * back to its own handling, keeping the subscription to ordinary Claude Code
 * use.
 */

import { readFile } from 'node:fs/promises'
import { jsonWriter } from '../persistence.ts'
import { homedir } from 'node:os'
import { relative } from 'node:path'
import { within } from '../git/service.ts'
import { LlmAdapter, LlmError, ReasoningEffortId, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { query, type EffortLevel, type ModelInfo, type SDKAssistantMessageError, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { AUTH_CODE, authMessage, isAuthText } from './auth.ts'
import { NATIVE_TEAM_TOOLS, bridges, type ToolRegistry } from './bridge.ts'
import { claudeEnv, findClaudeExecutable, probeDir } from './cli.ts'
import { ClaudeAccounts } from './accounts.ts'
import { appendedPrompt } from '../prompt.ts'
import { Channel, Conversation, type Approve } from './conversation.ts'
import { isResumedConversationRequest, pendingInput, remoteEchoes, skillNote, summarizeTool, TurnTranslator, type HarnessMessage, type ReferenceSpill } from './translate.ts'

export const PROVIDER = 'claude-agent'
/** Branding guidelines: third-party surfaces say "Claude Agent", never "Claude Code". */
const PROVIDER_NAME = 'Claude Agent'
/** Claude Code compacts its own context; a large window keeps DSH from compacting on top of it. */
const CONTEXT_WINDOW = 1_000_000
const CATALOG_TTL_MS = 10 * 60_000
/** A failed catalog read is retried no sooner than this, not on every lookup. */
const CATALOG_RETRY_MS = 60_000
const HOUR_MS = 60 * 60_000
const EFFORT_NAMES: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/** The DSH host services this adapter borrows, read at call time. */
export interface AdapterHost {
  accounts: ClaudeAccounts
  agents(): { currentInitiator?(): unknown; get?(id: string): unknown } | undefined
  /** DSH's tool registry: the session's team tools are bridged into Claude Code from it. */
  tools?(): ToolRegistry | undefined
  /** The connected connectors a session working in `cwd` may use, whose tools are bridged too. */
  connectors?(cwd: string): Promise<readonly string[]> | readonly string[]
  approval(): { request(request: object): Promise<string> } | undefined
  log(message: string): void
  /** A turn failed because the CLI is signed out; the browser shows a re-sign-in prompt. */
  authFailed?(detail: string, account: string): void
  /** A turn finished (the subscription's quota moved). */
  turnFinished?(account: string): void
  /** Lifecycle events of Claude Code processes (conversation.ts `trace`), plus the adapter's own disposal. */
  trace?(event: string, fields: Record<string, unknown>): void
  /** Where the model catalog persists, so a restarted host lists models without starting Claude Code. */
  catalogFile?: string
  /**
   * Answer a request that is not a conversation turn (DSH compacting the session, titling it)
   * with another model; see helper.ts. Without it such requests fail.
   */
  delegate?(options: StreamOptions): AsyncIterable<object>
  /** The global instructions (prompt.ts) and a review session's own, appended to Claude Code's system prompt after a bot's persona. */
  instructions?(sessionId: string): string | undefined
  /** Why a Bash or PowerShell command must not run in this session (guard.ts, review/guard.ts); Claude Code refuses it through a PreToolUse hook. */
  blocked?(command: unknown, sessionId: string): string | undefined
  /** Why a file tool must not write this file in this session (review/guard.ts), likewise refused. */
  refused?(tool: string, input: Record<string, unknown>, sessionId: string, cwd: string): string | undefined
  /** A tool call that runs without the approval dialog (an unattended review session's safe ones). */
  trusted?(tool: string, input: Record<string, unknown>, sessionId: string, cwd: string): boolean
  /** Where an @session snapshot too large for the prompt is saved; Claude Code may read that folder. */
  references?: ReferenceSpill
}

/** The plugin's Claude settings (`Config.claude` in index.ts). */
export interface AdapterSettings {
  /** Open each Claude Code session to Remote Control. */
  remoteControl: boolean
  /** Start each Claude Code session with full permissions (bypass mode): its tools run without approval prompts. */
  fullAccess: boolean
  /** With Remote Control on, how many of the most recently active sessions are never closed for idleness. */
  keepOnline: number
  /** A session idle this many hours is closed (and leaves Remote Control) unless kept online; the next turn resumes it. */
  idleHours: number
  /** Models DSH's selectors offer; empty offers all. Applied by visibility.ts, not here. */
  models: readonly string[]
  /** The model background requests go to (compaction, titles); blank = the default model. Read by index.ts. */
  helperProvider?: string
  helperModel?: string
}

export interface StreamOptions {
  provider: string
  model: string
  reasoningEffort?: string
  purpose?: string
  sessionId?: unknown
  /** A bot's persona (team/route.ts), appended to Claude Code's system prompt. */
  persona?: string
  messages: readonly HarnessMessage[]
  signal?: AbortSignal
}

/**
 * Claude Code's assistant error → a stable dsh-llm failure code. Sign-in
 * failures get their own code rather than the shared `AUTH`, which DSH shows
 * as a fixed "invalid API key" line with the message dropped.
 */
const ERROR_CODES: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: AUTH_CODE,
  oauth_org_not_allowed: AUTH_CODE,
  account_on_hold: AUTH_CODE,
  verification_required: AUTH_CODE,
  rate_limit: 'RATE_LIMIT',
  billing_error: 'QUOTA',
  overloaded: 'OVERLOADED',
  model_not_found: 'MODEL_NOT_FOUND',
  max_output_tokens: 'MAX_TOKENS',
}

function executable(): string {
  const file = findClaudeExecutable()
  if (file === undefined) throw new LlmError('Claude Code CLI not found: install it and sign in with `claude` first', 'MISSING_CREDENTIAL')
  return file
}

export class ClaudeAgentAdapter extends LlmAdapter {
  private conversations = new Map<string, Conversation>()
  /** The latest catalog read (maybe in flight) and when it started. */
  private catalog: { at: number; models: Promise<ModelInfo[]> } | undefined
  /** The last catalog that arrived: served at once while a newer one is read. */
  private known: ModelInfo[] | undefined
  private catalogAccount = 'default'
  private accountCatalogs = new Map<string, { catalog?: { at: number; models: Promise<ModelInfo[]> }; known?: ModelInfo[] }>()
  private restored: Promise<void>
  private sweeper: NodeJS.Timeout
  private host: AdapterHost
  private writeCatalog: ((value: unknown) => Promise<void>) | undefined
  /** Read on use: the settings page edits these without remounting the plugin. */
  private settings: () => AdapterSettings

  constructor(host: AdapterHost, settings: () => AdapterSettings) {
    super()
    this.host = host
    this.settings = settings
    if (host.catalogFile !== undefined) this.writeCatalog = jsonWriter(host.catalogFile)
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
    this.restored = this.restoreCatalog()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: PROVIDER_NAME }
  }

  override async listModels(provider: string) {
    return (await this.models()).map((model) => ({ provider, id: model.value, name: model.displayName, description: model.description }))
  }

  override async resolveModel(provider: string, model: string) {
    const info = (await this.models().catch(() => [])).find((entry) => entry.value === model)
    const levels = info?.supportsEffort ? info.supportedEffortLevels ?? [] : []
    return {
      provider,
      id: model,
      name: info?.displayName ?? model,
      inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
      ...(levels.length === 0 ? {} : {
        reasoning: {
          efforts: levels.map((level) => ({ id: ReasoningEffortId(level), name: EFFORT_NAMES[level] })),
          defaultEffort: ReasoningEffortId(levels.includes('high') ? 'high' : levels[0]),
        },
      }),
    }
  }

  /**
   * Claude Code's own model list. Stale-while-revalidate: once any list is
   * known (persisted across restarts), lookups answer at once and a stale list
   * is refreshed in the background, so a turn never waits on a probe process.
   */
  private async models(): Promise<ModelInfo[]> {
    await this.restored
    await this.host.accounts.ready
    if (this.catalogAccount !== this.host.accounts.selected) {
      this.accountCatalogs.set(this.catalogAccount, { catalog: this.catalog, known: this.known })
      this.catalogAccount = this.host.accounts.selected
      const previous = this.accountCatalogs.get(this.catalogAccount)
      this.catalog = previous?.catalog
      this.known = previous?.known
    }
    const cached = this.catalog
    if (cached === undefined || Date.now() - cached.at >= CATALOG_TTL_MS) this.catalog = { at: Date.now(), models: this.readModels() }
    return this.known ?? this.catalog!.models
  }

  /** Read the list from a live session, else from a short-lived one that only initializes (no model turn, no usage). */
  private readModels(): Promise<ModelInfo[]> {
    const account = this.host.accounts.selected
    const live = [...this.conversations.values()].find((conversation) => !conversation.closed && conversation.account === account)
    const models = live !== undefined ? live.query.supportedModels() : (async () => {
      const idle = new Channel<never>()
      // No MCP servers: the probe only initializes, and the user's servers would start and stop for nothing.
      const probe = query({ prompt: idle, options: { cwd: probeDir(), pathToClaudeCodeExecutable: executable(), env: claudeEnv(this.host.accounts.dir(account)), persistSession: false, strictMcpConfig: true } })
      try {
        return await probe.supportedModels()
      } finally {
        idle.end()
        probe.close()
      }
    })()
    models.then((list) => {
      if (account !== this.host.accounts.selected) {
        const previous = this.accountCatalogs.get(account) ?? {}
        this.accountCatalogs.set(account, { ...previous, known: list })
        return
      }
      this.known = list
      if (account === 'default') this.saveCatalog(list)
    }, () => {
      const entry = this.catalog
      if (account === this.host.accounts.selected && entry?.models === models) entry.at = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS
    })
    return models
  }

  private async restoreCatalog(): Promise<void> {
    const file = this.host.catalogFile
    if (file === undefined) return
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { at?: unknown; models?: unknown }
      if (typeof saved.at !== 'number' || !Array.isArray(saved.models) || saved.models.length === 0) return
      const models = saved.models as ModelInfo[]
      this.known = models
      this.catalog = { at: saved.at, models: Promise.resolve(models) }
    } catch {
      // Nothing saved yet: the first lookup reads it live.
    }
  }

  private saveCatalog(models: ModelInfo[]): void {
    this.writeCatalog?.({ at: Date.now(), models })
      .catch((error: unknown) => this.host.log(`Claude model catalog save failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private approve: Approve = async (agent, toolName, input, context) => {
    const approval = this.host.approval()
    if (approval === undefined || agent === undefined) return { behavior: 'deny', message: 'DeepSeek Harness has no approval channel for this turn' }
    const outcome = await approval.request({
      agent,
      toolName,
      ...(context.toolUseID === undefined ? {} : { callId: context.toolUseID }),
      reason: context.title ?? context.decisionReason ?? summarizeTool(toolName, input),
      signal: context.signal,
    })
    return outcome === 'allowed-once'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: outcome === 'rejected' ? 'The user rejected this tool call' : `Approval ${outcome}` }
  }

  /**
   * The live Claude Code session for one DSH session. Effort, the appended prompt (bot persona, global instructions),
   * account, cwd, permissions and bridged DSH tools are fixed when a process starts, so a change
   * resumes into a fresh process when it is safe; a changed model switches in place.
   */
  private async conversation(key: string, cwd: string, model: string, effort: EffortLevel | undefined, persona: string | undefined, resume: string | undefined, initiator: unknown, account: string): Promise<Conversation> {
    const registry = this.host.tools?.()
    const connectors = registry === undefined ? [] : await this.host.connectors?.(cwd) ?? []
    const teammate = (initiator as { session?: { header?: { parentSession?: string } } } | undefined)?.session?.header?.parentSession !== undefined
    const bridge = registry === undefined
      ? undefined
      : bridges(registry, () => this.host.agents()?.get?.(key) ?? initiator, { eager: teammate, connectors })
    const settings = this.settings()
    let conversation = this.conversations.get(key)
    // Never close (or change the model of) a process still executing/being read.
    // Remote Control echoes adopt that live turn directly, outside this path.
    if (conversation !== undefined && !conversation.closed && conversation.busy) {
      throw new LlmError('Claude Code session is already answering a turn', 'UNSUPPORTED_REQUEST')
    }
    // Revoke bypass at the next safe turn. Enabling still only changes the
    // default for new processes, never silently upgrades an existing normal one.
    if (conversation !== undefined && (conversation.closed || conversation.effort !== effort || conversation.persona !== persona || conversation.bridged !== (bridge?.signature ?? '') || conversation.account !== account || relative(conversation.cwd, cwd) !== '' || (conversation.fullAccess && !settings.fullAccess))) {
      if (conversation.account === account) resume = conversation.session ?? resume
      conversation.close('settings changed')
      conversation = undefined
    }
    if (conversation === undefined) {
      // A forked DSH session carries its parent's Claude Code session; never drive one session from two places.
      const taken = resume !== undefined && [...this.conversations.entries()].some(([other, live]) => other !== key && !live.closed && live.session === resume)
      const served = bridge?.open()
      conversation = new Conversation({
        executable: executable(),
        cwd,
        model,
        account,
        configDir: this.host.accounts.dir(account),
        ...(effort === undefined ? {} : { effort }),
        ...(persona === undefined ? {} : { persona }),
        ...(resume === undefined ? {} : { resume, fork: taken }),
        ...(served === undefined ? {} : { mcpServers: served.servers, trusted: served.trusted, bridged: bridge!.signature }),
        ...(bridge?.team === true ? { disallowedTools: NATIVE_TEAM_TOOLS } : {}),
        ...(this.host.references === undefined ? {} : { additionalDirectories: [this.host.references.dir] }),
        approve: (agent, toolName, input, context) => this.host.trusted?.(toolName, input, key, cwd) === true
          ? Promise.resolve({ behavior: 'allow', updatedInput: input })
          : this.approve(agent, toolName, input, context),
        remoteControl: settings.remoteControl,
        fullAccess: settings.fullAccess,
        ...(this.host.blocked === undefined ? {} : { blocked: (command: unknown) => this.host.blocked?.(command, key) }),
        ...(this.host.refused === undefined ? {} : { refused: (tool: string, input: Record<string, unknown>) => this.host.refused?.(tool, input, key, cwd) }),
        log: (message) => this.host.log(message),
        ...(this.host.trace === undefined ? {} : { trace: (event: string, fields: Record<string, unknown>) => this.host.trace?.(event, { key, ...fields }) }),
      })
      this.conversations.set(key, conversation)
    } else if (conversation.model !== model) {
      await conversation.query.setModel(model)
      conversation.model = model
    }
    return conversation
  }

  async *stream(options: StreamOptions): AsyncGenerator<object> {
    if (options.provider !== PROVIDER) throw new LlmError('Claude Agent only answers conversation turns', 'UNSUPPORTED_REQUEST')
    if (options.purpose !== undefined || options.sessionId === undefined
      || (!isAgentLoopRequest(options) && !isResumedConversationRequest(options))) {
      // Background work for the session (compaction, its title): another model answers it.
      if (this.host.delegate === undefined) throw new LlmError('Claude Agent only answers conversation turns', 'UNSUPPORTED_REQUEST')
      yield* this.host.delegate(options)
      return
    }
    const agent = this.host.agents()?.currentInitiator?.() as { session?: { header?: { cwd?: string } } } | undefined
    const key = String(options.sessionId)
    const echoes = remoteEchoes(options.messages)
    let conversation: Conversation
    let turn: AsyncGenerator<SDKMessage>
    let skills: readonly string[] = []
    if (echoes.length > 0) {
      // Prompts sent from Remote Control: Claude Code is already answering them, so follow that turn as it is.
      const live = this.conversations.get(key)
      if (live === undefined || live.closed) throw new LlmError('The Remote Control turn is no longer running here', 'EMPTY_RESPONSE')
      conversation = live
      turn = live.adopt(echoes, agent, options.signal)
    } else {
      await this.host.accounts.ready
      const account = this.host.accounts.selected
      const input = pendingInput(options.messages, PROVIDER, account, this.host.references)
      const { resume, prompt } = input
      skills = input.skills ?? []
      if (prompt === '') throw new LlmError('Nothing new to send to Claude Code', 'EMPTY_RESPONSE')
      const effort = options.reasoningEffort as EffortLevel | undefined
      conversation = await this.conversation(key, agent?.session?.header?.cwd ?? homedir(), options.model, effort, appendedPrompt(options.persona, this.host.instructions?.(key)), resume, agent, account)
      turn = conversation.run(prompt, agent, options.signal)
    }

    const translator = new TurnTranslator()
    for (const notice of conversation.takeNotices()) yield* translator.note(notice)
    for (const name of skills) yield* translator.note(skillNote(name))
    let error: SDKAssistantMessageError | undefined
    let result: SDKResultMessage | undefined
    try {
      for await (const message of turn) {
        if (message.type === 'result') {
          if (result !== undefined) translator.carry(result)
          result = message
        } else {
          if (message.type === 'assistant' && message.error !== undefined) error = message.error
          yield* translator.push(message)
        }
      }
    } catch (cause) {
      if (options.signal?.aborted) throw new LlmError('Claude Code turn aborted', 'ABORTED', { cause })
      const message = (cause as Error).message
      if (error !== undefined && ERROR_CODES[error] === AUTH_CODE || isAuthText(message)) throw this.signedOut(message, conversation.account, cause)
      throw new LlmError(`Claude Code failed: ${message}`, 'TRANSPORT', { cause })
    }
    if (result !== undefined) this.host.turnFinished?.(conversation.account)
    if (options.signal?.aborted) throw new LlmError('Claude Code turn aborted', 'ABORTED')
    if (result === undefined) throw new LlmError('Claude Code ended without a result', 'STREAM_CLOSED')
    if (result.is_error || result.subtype !== 'success') {
      const detail = result.subtype === 'success' ? result.result : result.errors.join('; ')
      const code = (error === undefined ? undefined : ERROR_CODES[error]) ?? (isAuthText(detail ?? '') ? AUTH_CODE : 'PROVIDER')
      if (code === AUTH_CODE) throw this.signedOut(detail || result.subtype, conversation.account)
      throw new LlmError(`Claude Code: ${detail || result.subtype}`, code)
    }
    yield* translator.finish(result, conversation.session ?? result.session_id, conversation.account)
  }

  /** A sign-in failure: tell the browser (it opens the re-sign-in prompt) and fail the turn with the fix spelled out. */
  private signedOut(detail: string, account: string, cause?: unknown): LlmError {
    if (this.catalogAccount === account) this.catalog = undefined
    this.host.authFailed?.(detail, account)
    return new LlmError(authMessage(detail, account), AUTH_CODE, cause === undefined ? undefined : { cause })
  }

  /**
   * Close sessions idle past `idleHours`; the next turn resumes them from
   * Claude Code's transcript. With Remote Control on, the most recently active
   * ones stay online so they can be continued from a phone.
   */
  private sweep(): void {
    const now = Date.now()
    const settings = this.settings()
    const idle = settings.idleHours * HOUR_MS
    const live = [...this.conversations.values()].filter((conversation) => !conversation.closed)
    const kept = new Set(settings.remoteControl ? live.sort((a, b) => b.lastActive - a.lastActive).slice(0, settings.keepOnline) : [])
    for (const [key, conversation] of this.conversations) {
      if (conversation.closed || (!conversation.busy && !kept.has(conversation) && now - conversation.lastActive > idle)) {
        conversation.close('idle')
        this.conversations.delete(key)
      }
    }
  }

  /**
   * Close the Claude Code processes working in `dir` or below (a worktree about
   * to be removed: Windows will not delete a folder a process runs in). Their
   * next turn resumes them from the transcript, as after an idle close.
   */
  release(dir: string): number {
    let closed = 0
    for (const [key, conversation] of this.conversations) {
      if (!within(dir, conversation.cwd)) continue
      conversation.close(`release ${dir}`)
      this.conversations.delete(key)
      closed++
    }
    return closed
  }

  dispose(): void {
    clearInterval(this.sweeper)
    const open = [...this.conversations.values()].filter((conversation) => !conversation.closed)
    // The caller's stack is what tells a plugin reload from an llm service restart.
    if (open.length > 0) this.host.trace?.('dispose', { open: open.length, busy: open.filter((conversation) => conversation.busy).length, stack: callers() })
    for (const conversation of this.conversations.values()) conversation.close('dispose')
    this.conversations.clear()
  }
}

/** The caller frames of the current stack, compact: package path and line, node internals left out. */
function callers(): string[] {
  return (new Error().stack ?? '').split('\n').slice(2)
    .filter((line) => !line.includes('node:internal'))
    .map((line) => line.trim().replace(/^at /, '').replace(/file:\/\/\/(?:.*\/node_modules\/)?/, ''))
    .slice(0, 12)
}
