/**
 * One long-lived agent CLI as an Agent Client Protocol server (JSON-RPC 2.0,
 * one message per line on stdio): Cursor's `agent acp`, Qoder's
 * `qoderclicn --acp`. Every DSH session on such a route is an ACP session
 * of one process.
 *
 * A session's model is either its `model` config option (Cursor, Qoder) or,
 * on agents that only speak the older shape, its `models` list and
 * `session/set_model` (Hermes); {@link modelChoice} reads both.
 *
 * Measured against Cursor CLI 2026.10.01:
 * - `initialize` with `_meta.parameterizedModelPicker` lists base model ids
 *   (`claude-opus-5-5`) and each model's knobs as config options, the
 *   reasoning ones under the `thought_level` category; without it efforts
 *   are folded into ids.
 * - `session/set_model` is a no-op; the model is the `model` config option.
 * - Setting a config option also saves it as the CLI's own default for that
 *   model (cli-config.json). The session keeps the value in memory, so the
 *   file is put back as it was (see {@link AcpAgent.configure}).
 * - `session/load` replays the conversation as updates; they are dropped.
 * - Per-turn usage is not reported here; see usage.ts.
 */

import { spawn as spawnProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'

export interface ConfigOption {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: string
  options?: Array<{ value: string; name?: string }>
}

/** The older model shape: the session's models and the current one, set with `session/set_model`. */
export interface SessionModels {
  availableModels: Array<{ modelId: string; name?: string; description?: string }>
  currentModelId?: string
}

export interface SessionInfo {
  sessionId: string
  configOptions: ConfigOption[]
  models?: SessionModels
}

/** A model the agent offers: its id, name and the agent's own one-line description. */
export interface ModelChoice {
  id: string
  name: string
  description?: string
}

/** The session's model list and current model, from its `model` config option or else its `models`. */
export function modelChoice(info: Pick<SessionInfo, 'configOptions' | 'models'>): { models: ModelChoice[]; current?: string; viaOption: boolean } {
  const option = info.configOptions.find((entry) => entry.id === 'model' || entry.category === 'model')
  if (option?.options !== undefined && option.options.length > 0) {
    const described = new Map((info.models?.availableModels ?? []).map((model) => [model.modelId, model.description]))
    return {
      models: option.options.map((entry) => {
        const description = described.get(entry.value)
        return { id: entry.value, name: entry.name ?? entry.value, ...(description ? { description } : {}) }
      }),
      ...(option.currentValue === undefined ? {} : { current: option.currentValue }),
      viaOption: true,
    }
  }
  const models = (info.models?.availableModels ?? []).map((model) => ({ id: model.modelId, name: model.name ?? model.modelId, ...(model.description ? { description: model.description } : {}) }))
  return { models, ...(info.models?.currentModelId === undefined ? {} : { current: info.models.currentModelId }), viaOption: false }
}

/** A `session/update` payload; `sessionUpdate` names its kind. */
export interface SessionUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

export interface PermissionRequest {
  sessionId: string
  toolCall: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown; content?: unknown }
  options: Array<{ optionId: string; name?: string; kind?: string }>
}

/** What a turn listens to while it runs. */
export interface TurnListener {
  update(update: SessionUpdate): void
  permission(request: PermissionRequest, signal: AbortSignal): Promise<string | undefined>
}

export class AcpError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** The slice of a child process the client drives; tests hand in a fake. */
export interface Child {
  stdin: Writable
  stdout: Readable
  stderr?: Readable | null
  kill(): void
  once(event: 'exit', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export interface AcpOptions {
  /** How the agent is named in errors ("Cursor CLI exited"); Cursor CLI when unset. */
  name?: string
  start(): Child
  /** The CLI's settings file, restored after every config change; undefined skips that. */
  configFile?: string
  log(message: string): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

const METHOD_NOT_FOUND = -32601

/** Start an agent CLI as an ACP server; `args` are all of its arguments. */
export function spawnAcp(command: string, args: readonly string[], env: Record<string, string | undefined>): Child {
  // Not in a workspace folder: Windows would not let a worktree holding the process's cwd be removed.
  return spawnProcess(command, [...args], { cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })
}

export class AcpAgent {
  private child: Child | undefined
  private ready: Promise<void> | undefined
  private next = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, TurnListener>()
  /** Sessions being loaded: their replayed history is not anyone's turn. */
  private loading = new Set<string>()
  private cancels = new Map<number | string, AbortController>()
  /** Config changes run one at a time, so each restores the settings file it found. */
  private configChain: Promise<unknown> = Promise.resolve()
  private options: AcpOptions
  /** Bumped when the process exits: sessions opened in an older generation must be loaded again. */
  generation = 0
  lastUsed = Date.now()

  constructor(options: AcpOptions) {
    this.options = options
  }

  private get name(): string {
    return this.options.name ?? 'Cursor CLI'
  }

  get running(): boolean {
    return this.child !== undefined
  }

  /** Start the process (once) and initialize it. */
  start(): Promise<void> {
    if (this.ready !== undefined) return this.ready
    const child = this.options.start()
    this.child = child
    let buffer = ''
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', (data: string | Buffer) => {
      buffer += String(data)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line !== '') this.receive(line)
      }
    })
    child.stderr?.on('data', (data: string | Buffer) => {
      const text = String(data).trim()
      if (text !== '') this.options.log(text)
    })
    child.once('exit', (code) => this.exited(child, code))
    // A process that never started emits only this; its requests must fail rather than wait forever.
    child.once('error', (error) => {
      this.options.log(`${this.name} failed: ${error.message}`)
      this.exited(child, null)
    })
    child.stdin.on('error', () => {})
    this.ready = this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
      clientInfo: { name: 'dsh-agent-hub', version: '1' },
    }).then(() => undefined)
    this.ready.catch(() => this.close())
    return this.ready
  }

  private exited(child: Child, code: number | null): void {
    if (this.child !== child) return
    this.child = undefined
    this.ready = undefined
    this.generation++
    const error = new Error(`${this.name} exited${code === null ? '' : ` with code ${code}`}`)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const controller of this.cancels.values()) controller.abort()
    this.cancels.clear()
  }

  private write(message: object): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  request<T = unknown>(method: string, params: object): Promise<T> {
    if (this.child === undefined) return Promise.reject(new Error(`${this.name} is not running`))
    this.lastUsed = Date.now()
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: object): void {
    this.write({ method, params })
  }

  private receive(line: string): void {
    let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
    try {
      message = JSON.parse(line)
    } catch {
      this.options.log(`unreadable ACP line: ${line.slice(0, 200)}`)
      return
    }
    if (message.method === undefined) {
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (pending === undefined) return
      this.pending.delete(message.id as number)
      if (message.error !== undefined) pending.reject(new AcpError(message.error.code ?? 0, message.error.message ?? 'ACP request failed', message.error.data))
      else pending.resolve(message.result)
      return
    }
    if (message.id === undefined) {
      if (message.method === 'session/update') this.update(message.params ?? {})
      return
    }
    void this.answer(message.id, message.method, message.params ?? {})
  }

  private update(params: Record<string, unknown>): void {
    const sessionId = String(params.sessionId ?? '')
    const update = params.update as SessionUpdate | undefined
    if (update === undefined || this.loading.has(sessionId)) return
    this.listeners.get(sessionId)?.update(update)
  }

  /** Requests from the agent. Only permissions are ours to answer; an agent's own extensions fall back on refusal. */
  private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    if (method !== 'session/request_permission') {
      this.write({ id, error: { code: METHOD_NOT_FOUND, message: `${method} is not supported by this client` } })
      return
    }
    const request = params as unknown as PermissionRequest
    const listener = this.listeners.get(request.sessionId)
    const controller = new AbortController()
    this.cancels.set(id, controller)
    let optionId: string | undefined
    try {
      optionId = listener === undefined ? undefined : await listener.permission(request, controller.signal)
    } catch (error) {
      this.options.log(`permission request failed: ${(error as Error).message}`)
    } finally {
      this.cancels.delete(id)
    }
    const outcome = optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId }
    this.write({ id, result: { outcome } })
  }

  async newSession(cwd: string): Promise<SessionInfo> {
    await this.start()
    const result = await this.request<{ sessionId: string; configOptions?: ConfigOption[]; models?: SessionModels }>('session/new', { cwd, mcpServers: [] })
    return { sessionId: result.sessionId, configOptions: result.configOptions ?? [], ...(result.models === undefined ? {} : { models: result.models }) }
  }

  /** Reopen a session from the agent's own store; its replayed history is dropped. */
  async loadSession(sessionId: string, cwd: string): Promise<SessionInfo> {
    await this.start()
    this.loading.add(sessionId)
    try {
      const result = await this.request<{ configOptions?: ConfigOption[]; models?: SessionModels }>('session/load', { sessionId, cwd, mcpServers: [] })
      return { sessionId, configOptions: result?.configOptions ?? [], ...(result?.models === undefined ? {} : { models: result.models }) }
    } finally {
      this.loading.delete(sessionId)
    }
  }

  /**
   * Set one config option and return the session's options after it. The CLI
   * also saves the choice as its own default for that model: the settings
   * file is put back as it was, so DSH never changes the user's Cursor CLI.
   */
  configure(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const task = async (): Promise<ConfigOption[]> => {
      const file = this.options.configFile
      const before = file === undefined ? undefined : await readFile(file, 'utf8').catch(() => undefined)
      try {
        const result = await this.request<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId, configId, value })
        return result?.configOptions ?? []
      } finally {
        if (file !== undefined && before !== undefined) {
          const after = await readFile(file, 'utf8').catch(() => undefined)
          if (after !== before) await writeFile(file, before, 'utf8').catch((error: unknown) => this.options.log(`could not restore ${file}: ${(error as Error).message}`))
        }
      }
    }
    const run = this.configChain.then(task, task)
    this.configChain = run.catch(() => {})
    return run
  }

  /** Pick a session's model on an agent with the older model shape (no `model` config option). */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId, modelId })
  }

  /** Run one turn; `listener` gets its updates and permission requests. Resolves with the stop reason. */
  async prompt(sessionId: string, prompt: readonly object[], listener: TurnListener): Promise<string> {
    this.listeners.set(sessionId, listener)
    try {
      const result = await this.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt })
      return result?.stopReason ?? 'end_turn'
    } finally {
      if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId)
    }
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  close(): void {
    const child = this.child
    if (child === undefined) {
      this.ready = undefined
      return
    }
    this.exited(child, null)
    child.stdin.end()
    child.kill()
  }
}
