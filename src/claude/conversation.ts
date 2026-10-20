/**
 * One long-lived Claude Code session behind one DSH session. It stays
 * running between turns (streaming input) so Remote Control keeps the
 * session reachable from claude.ai and the Claude app. A turn started there
 * is echoed to the DSH session as a follow-up, and the DSH turn that echo
 * starts follows the Claude Code turn already running instead of sending the
 * prompt again — so both sides show the same conversation.
 */

import { randomUUID } from 'node:crypto'
import {
  getSessionMessages, query, type CanUseTool, type EffortLevel, type HookCallback, type McpServerConfig, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeEnv } from './cli.ts'
import { REMOTE_ECHO, transcriptPrompt } from './translate.ts'
import { CLAUDE_WRITE_TOOLS as WRITE_TOOLS } from '../review/guard.ts'

/** How often the running time of background tasks is reported (the translator shows it at coarser marks). */
const TICK_MS = 20_000

/** A minimal single-consumer async queue. */
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | undefined
  private ended = false
  private finish!: () => void
  /** Settles when the channel ends; buffered items stay readable. */
  readonly done = new Promise<void>((resolve) => { this.finish = resolve })

  push(item: T): void {
    if (this.ended) return
    if (this.waiting === undefined) this.items.push(item)
    else {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: item, done: false })
    }
  }

  end(): void {
    this.ended = true
    this.finish()
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      },
    }
  }
}

/** One Claude Code turn, from its first frame to its result. */
interface Turn {
  /** Client uuids of the user messages it answers; frames naming one of them are its own. */
  ids: Set<string>
  /** The DSH agent reading it, which answers its approvals. Undefined while nobody in DSH is. */
  agent: unknown
  messages: Channel<SDKMessage>
  /** A Remote Control turn's prompt, once read from the transcript and echoed to DSH. */
  prompt?: string
  /** Its own reply is done, but DSH keeps reading it until Claude Code has answered the background tasks it left running. */
  waiting?: boolean
}

/** The slice of a DSH agent that takes the echo of a Remote Control prompt. */
interface Driver {
  followup(message: { role: 'user'; content: Array<{ type: 'text'; text: string }>; source: typeof REMOTE_ECHO }): unknown
}

export type Approve = (agent: unknown, toolName: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]) => Promise<PermissionResult>

export interface ConversationOptions {
  executable: string
  cwd: string
  model: string
  account?: string
  configDir?: string
  effort?: EffortLevel
  /** Appended to Claude Code's own system prompt: a bot's persona and the global instructions. */
  persona?: string
  resume?: string
  /** Resume into a new Claude Code session: another live DSH session already owns `resume`. */
  fork?: boolean
  /**
   * The session's only MCP servers: the in-process DSH bridges (team tools, connectors).
   * Claude Code's own MCP configuration (settings, plugins, claude.ai connectors) is not
   * loaded, so every model reaches external services through the same DSH connectors.
   */
  mcpServers?: Record<string, McpServerConfig>
  /** Tools named with one of these prefixes run without asking: DSH applies its own tool policy when they execute. */
  trusted?: readonly string[]
  /** The bridged tools this process was started with (bridge.ts `signature`). */
  bridged?: string
  /** Claude Code tools this session must not use. */
  disallowedTools?: readonly string[]
  /** Folders outside `cwd` it may read without asking (saved @session snapshots). */
  additionalDirectories?: readonly string[]
  approve: Approve
  remoteControl: boolean
  /** Run with full permissions: Claude Code skips its permission checks, so nothing is asked. */
  fullAccess?: boolean
  /** Why a Bash or PowerShell command must not run (guard.ts), read at each call so a settings change applies at once. */
  blocked?: (command: unknown) => string | undefined
  /** Why a file-writing tool (Edit, Write, MultiEdit, NotebookEdit) must not run with this input. */
  refused?: (tool: string, input: Record<string, unknown>) => string | undefined
  log: (message: string) => void
  /** One line per lifecycle event (the process ended, a turn broke off), for diagnosing turns that end early. */
  trace?: (event: string, fields: Record<string, unknown>) => void
}

/** `enableRemoteControl` ships in the SDK runtime (the VS Code extension's toggle uses it) but not in its typings. */
interface RemoteControl {
  enableRemoteControl?(enabled: boolean): Promise<{ session_url?: string }>
}

function owners(message: SDKMessage): readonly string[] | undefined {
  const tagged = message as { user_message_uuid?: string; user_message_uuids?: string[] }
  return tagged.user_message_uuids ?? (tagged.user_message_uuid === undefined ? undefined : [tagged.user_message_uuid])
}

export class Conversation {
  readonly query: Query
  readonly effort: EffortLevel | undefined
  readonly account: string
  readonly persona: string | undefined
  /** Permission mode fixed when this process started, not the current host setting. */
  readonly fullAccess: boolean
  model: string
  /** The Claude Code session id, known from the first message it sends. */
  session: string | undefined
  closed = false
  /** Who closed this process (close's reason), or why its stream ended; named in a turn it broke off. */
  private ending: string | undefined
  lastActive = Date.now()
  private input = new Channel<SDKUserMessage>()
  /** Unsettled turns, in the order Claude Code runs them (one at a time). */
  private turns: Turn[] = []
  /** Remote Control turns echoed to DSH, oldest first, until a DSH turn follows them. */
  private echoed: Turn[] = []
  /** Whether a DSH turn is reading from this session. */
  private reading = false
  /** The DSH agent of the latest DSH turn; Remote Control prompts are echoed to it. */
  private driver: unknown
  private remoteUrl: string | undefined
  /** Remote Control turns DSH will not show; the next DSH turn mentions them. */
  private remoteTurns = 0
  /** Claude Code's background tasks still running (background_tasks_changed, ambient ones left out), from when first seen. */
  private live = new Map<string, { description: string; since: number }>()
  /** Reports the background tasks' running time to the turn DSH reads (see tick). */
  private clock: NodeJS.Timeout
  /** Summaries of background tasks that ended while no turn was open: the prompt of the turn Claude Code starts to answer them. */
  private ended: string[] = []

  private options: ConversationOptions

  /** The folder Claude Code runs in. */
  get cwd(): string {
    return this.options.cwd
  }

  /** The DSH tools bridged into this process (bridge.ts `signature`). */
  get bridged(): string {
    return this.options.bridged ?? ''
  }

  constructor(options: ConversationOptions) {
    this.options = options
    this.model = options.model
    this.account = options.account ?? 'default'
    this.effort = options.effort
    this.persona = options.persona
    this.fullAccess = options.fullAccess === true
    this.session = options.fork ? undefined : options.resume
    this.query = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        model: options.model,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        // Not snapshotted: a resume after the persona changed must render the new one.
        ...(options.persona === undefined ? {} : { systemPrompt: { type: 'preset', preset: 'claude_code', append: options.persona, snapshot: false } }),
        ...(options.resume === undefined ? {} : { resume: options.resume, ...(options.fork ? { forkSession: true } : {}) }),
        ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
        ...(options.disallowedTools === undefined ? {} : { disallowedTools: [...options.disallowedTools] }),
        ...(options.additionalDirectories === undefined ? {} : { additionalDirectories: [...options.additionalDirectories] }),
        ...(options.fullAccess ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true } : {}),
        // Only the servers passed above: none of Claude Code's own MCP configuration.
        extraArgs: { 'strict-mcp-config': null },
        pathToClaudeCodeExecutable: options.executable,
        env: { ...claudeEnv(options.configDir), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        includePartialMessages: true,
        // Subagents report what they are doing and forward their text and thinking: DSH shows both as notes.
        agentProgressSummaries: true,
        forwardSubagentText: true,
        canUseTool: (toolName, input, context) => this.canUseTool(toolName, input, context),
        // A hook, not canUseTool: full access skips permission checks but still runs PreToolUse hooks.
        ...(options.blocked === undefined && options.refused === undefined ? {} : {
          hooks: { PreToolUse: [{ matcher: ['Bash', 'PowerShell', ...(options.refused === undefined ? [] : WRITE_TOOLS)].join('|'), hooks: [this.screen] }] },
        }),
        stderr: (data) => options.log(data.trim()),
      },
    })
    this.clock = setInterval(() => this.tick(), TICK_MS)
    this.clock.unref()
    this.pump()
    if (options.remoteControl) this.connectRemote()
  }

  /**
   * Background tasks report no progress of their own (shells) or only now and
   * then (subagents): their running time goes to the turn DSH reads as task
   * progress frames, which the translator shows at its heartbeat marks.
   */
  private tick(): void {
    const turn = this.turns.find((candidate) => candidate.agent !== undefined)
    if (turn === undefined) return
    const now = Date.now()
    for (const [id, task] of this.live) {
      turn.messages.push({
        type: 'system', subtype: 'task_progress', task_id: id, description: task.description,
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: now - task.since }, uuid: randomUUID(), session_id: this.session ?? '',
      })
    }
  }

  /**
   * Route every frame to its turn. A turn's frames name its user messages only
   * now and then; since Claude Code runs one turn at a time, a frame naming
   * none belongs to the oldest unsettled turn. Model output no turn claims
   * opens a Remote Control turn.
   */
  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.lastActive = Date.now()
        if (message.session_id) this.session = message.session_id
        this.track(message)
        const ids = owners(message)
        // Model output of the session itself, not of a subagent (a background one keeps talking between turns).
        const output = (message.type === 'stream_event' || message.type === 'assistant') && typeof message.parent_tool_use_id !== 'string'
        const turn = this.owner(ids) ?? (output ? this.remoteTurn(ids) : undefined)
        if (turn === undefined) {
          // A Remote Control turn with no model output, such as a slash command.
          if (message.type === 'result') this.remoteTurns++
          continue
        }
        for (const id of ids ?? []) turn.ids.add(id)
        if (output) turn.waiting = false
        turn.messages.push(message)
        if (message.type === 'result') {
          // Background tasks still run: Claude Code answers them in a turn of its own, which the DSH turn reading this one waits for.
          if (turn.agent !== undefined && this.live.size > 0 && !message.is_error) turn.waiting = true
          else this.settle(turn)
        }
      }
    } catch (error) {
      this.ending ??= `error: ${(error as Error).message}`
      this.options.log(`Claude Code session ended: ${(error as Error).message}`)
    } finally {
      this.ending ??= 'stream ended'
      this.options.trace?.('end', { session: this.session, by: this.ending, turns: this.turns.length, live: this.live.size })
      this.closed = true
      clearInterval(this.clock)
      for (const turn of this.turns) turn.messages.end()
    }
  }

  /** Follow Claude Code's background tasks: which still run, and which ended while no turn was open. */
  private track(message: SDKMessage): void {
    if (message.type !== 'system') return
    if (message.subtype === 'background_tasks_changed') {
      const now = Date.now()
      this.live = new Map(message.tasks.filter((task) => task.ambient !== true)
        .map((task) => [task.task_id, { description: task.description, since: this.live.get(task.task_id)?.since ?? now }]))
    }
    else if (message.subtype === 'task_notification' && message.ambient !== true && this.turns.length === 0) this.ended.push(message.summary)
  }

  private settle(turn: Turn): void {
    const index = this.turns.indexOf(turn)
    if (index >= 0) this.turns.splice(index, 1)
    turn.messages.end()
  }

  private owner(ids: readonly string[] | undefined): Turn | undefined {
    // A turn waiting on background tasks takes unnamed frames only when no other turn runs: then they are Claude Code answering those tasks.
    if (ids === undefined) return this.turns.find((turn) => !turn.waiting) ?? this.turns[0]
    return this.turns.find((turn) => ids.some((id) => turn.ids.has(id))) ?? this.turns.find((turn) => turn.ids.size === 0)
  }

  /**
   * Model output no turn claims. Claude Code answering background tasks that
   * ended after DSH stopped waiting names no user message; that turn is echoed
   * with the tasks' summaries as its prompt.
   */
  private remoteTurn(ids: readonly string[] | undefined): Turn {
    const prompt = ids === undefined && this.ended.length > 0 ? this.ended.splice(0).map((summary) => `Background task finished: ${summary}`).join('\n') : undefined
    const turn: Turn = { ids: new Set(ids), agent: undefined, messages: new Channel(), ...(prompt === undefined ? {} : { prompt }) }
    this.turns.push(turn)
    this.echoed.push(turn)
    this.echo(turn)
    return turn
  }

  /**
   * Echo a Remote Control prompt to the DSH agent as a follow-up; the DSH turn
   * it starts then follows this turn (see {@link adopt}). Claude Code may
   * write the prompt to its transcript only as the turn ends, so a miss is
   * retried then. With no prompt or no DSH agent, the turn is only counted.
   */
  private async echo(turn: Turn): Promise<void> {
    const prompt = turn.prompt ?? await this.readPrompt(turn) ?? await turn.messages.done.then(() => this.readPrompt(turn))
    try {
      const driver = this.driver as Partial<Driver> | undefined
      if (prompt === undefined || typeof driver?.followup !== 'function') throw new Error('nothing to echo')
      turn.prompt = prompt
      driver.followup({ role: 'user', content: [{ type: 'text', text: prompt }], source: REMOTE_ECHO })
    } catch {
      this.echoed = this.echoed.filter((other) => other !== turn)
      this.remoteTurns++
    }
  }

  private async readPrompt(turn: Turn): Promise<string | undefined> {
    // SDK's transcript helper has no per-call config directory; never read the default account's transcript for another account.
    if (this.session === undefined || turn.ids.size === 0 || this.options.configDir !== undefined) return undefined
    try {
      return transcriptPrompt(await getSessionMessages(this.session, { dir: this.options.cwd }), turn.ids)
    } catch (error) {
      this.options.log(`Remote Control prompt unreadable: ${(error as Error).message}`)
      return undefined
    }
  }

  private async connectRemote(): Promise<void> {
    try {
      const result = await (this.query as Query & RemoteControl).enableRemoteControl?.(true)
      this.remoteUrl = result?.session_url
    } catch (error) {
      this.options.log(`Remote Control unavailable: ${(error as Error).message}`)
    }
  }

  /**
   * Approvals for a turn DSH is reading go through DSH's approval dialog; the
   * remote device may answer first, which cancels the request. A Remote
   * Control turn no DSH turn follows yet is answered on the remote device.
   */
  private async canUseTool(toolName: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    // Bridged DSH tools pass DSH's own tool policy when they run; asking here too would ask twice.
    if (this.options.trusted?.some((prefix) => toolName.startsWith(prefix))) return { behavior: 'allow', updatedInput: input }
    const agent = this.turns[0]?.agent
    if (agent !== undefined) return this.options.approve(agent, toolName, input, context)
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve()
      else context.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return { behavior: 'deny', message: 'Answered elsewhere' }
  }

  /** Refuse a blocked Bash command, or a write the session may not make, before Claude Code runs it; the reason is what the model reads. */
  private screen: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const tool = (input as { tool_name?: string }).tool_name ?? ''
    const args = (input.tool_input ?? {}) as Record<string, unknown>
    const reason = (WRITE_TOOLS as readonly string[]).includes(tool) ? this.options.refused?.(tool, args) : this.options.blocked?.(args.command)
    return reason === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }

  /** Whether a turn is running or being read. */
  get busy(): boolean {
    return this.reading || this.turns.length > 0
  }

  /** Host notices for the next DSH turn: the Remote Control link once, then remote turns DSH did not show. */
  takeNotices(): string[] {
    const notices: string[] = []
    if (this.remoteUrl !== undefined) {
      notices.push(`Remote Control: ${this.remoteUrl}`)
      this.remoteUrl = undefined
    }
    if (this.remoteTurns > 0) {
      notices.push(`${this.remoteTurns} turn(s) ran from Remote Control since the last message here; they are visible in claude.ai/code.`)
      this.remoteTurns = 0
    }
    return notices
  }

  private claim(agent: unknown): void {
    if (this.closed) throw new Error('Claude Code session is closed')
    if (this.reading) throw new Error('Claude Code session is already answering a turn')
    this.reading = true
    this.driver = agent
  }

  /** Send one prompt and yield every Claude Code message of its turn, ending with its result. */
  async *run(prompt: string, agent: unknown, signal: AbortSignal | undefined): AsyncGenerator<SDKMessage> {
    this.claim(agent)
    // Background tasks that just ended are answered within this turn.
    this.ended = []
    const uuid = randomUUID()
    const turn: Turn = { ids: new Set([uuid]), agent, messages: new Channel() }
    this.turns.push(turn)
    this.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage['uuid'] })
    yield* this.follow([turn], agent, signal)
  }

  /**
   * Yield the Remote Control turns whose echoes (`prompts`, in order) started
   * this DSH turn. Echoed turns before them that no DSH turn followed are
   * given up and counted.
   */
  async *adopt(prompts: readonly string[], agent: unknown, signal: AbortSignal | undefined): AsyncGenerator<SDKMessage> {
    this.claim(agent)
    const turns: Turn[] = []
    for (const prompt of prompts) {
      const index = this.echoed.findIndex((turn) => turn.prompt === prompt)
      if (index < 0) continue
      this.remoteTurns += index
      turns.push(this.echoed[index])
      this.echoed.splice(0, index + 1)
    }
    if (turns.length === 0) {
      this.reading = false
      throw new Error('the Remote Control turn is no longer running here')
    }
    yield* this.follow(turns, agent, signal)
  }

  private async *follow(turns: readonly Turn[], agent: unknown, signal: AbortSignal | undefined): AsyncGenerator<SDKMessage> {
    const interrupt = (): void => {
      this.query.interrupt().catch(() => {})
      const turn = turns[current]
      if (turn === undefined) return
      // Stop waiting on background tasks (one answered later is echoed instead); a waiting turn runs nothing whose result would end it.
      turn.agent = undefined
      if (turn.waiting) this.settle(turn)
    }
    let current = 0
    signal?.addEventListener('abort', interrupt, { once: true })
    try {
      for (; current < turns.length; current++) {
        const turn = turns[current]
        turn.agent = agent
        let last: SDKMessage | undefined
        // A turn waiting on background tasks reads past its first result, until pump settles it.
        for await (const message of turn.messages) {
          last = message
          yield message
        }
        if (last?.type !== 'result') {
          const frame = last === undefined ? 'none' : 'subtype' in last ? `${last.type}/${String(last.subtype)}` : last.type
          this.options.trace?.('mid-turn', { session: this.session, by: this.ending, last: frame, waiting: turn.waiting === true, aborted: signal?.aborted === true })
          throw new Error(`Claude Code session ended mid-turn (${this.ending ?? 'turn closed'}; last frame ${frame})`)
        }
      }
    } finally {
      signal?.removeEventListener('abort', interrupt)
      // Turns DSH stopped reading drain unread: their late frames are dropped.
      for (const turn of turns.slice(current)) {
        turn.agent = undefined
        turn.messages.end()
      }
      this.reading = false
      this.lastActive = Date.now()
    }
  }

  close(reason = 'close'): void {
    if (this.closed) return
    this.ending = `closed: ${reason}`
    this.closed = true
    clearInterval(this.clock)
    this.input.end()
    this.query.close()
  }
}
