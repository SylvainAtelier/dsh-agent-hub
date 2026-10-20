/** Native daily review delivery. Host reminders are the sole scheduler. */
import { readFile } from 'node:fs/promises'
import { localized } from '../locale.ts'
import { jsonWriter } from '../persistence.ts'

export const REVIEW_SCHEDULE_METHOD = 'agent-hub/review-schedule'
export const REVIEW_SYNC_TOOL = 'review_sync'
const PROMPT = '[agent-hub:review-daily:v1] Call review_sync exactly once. It performs deterministic review synchronization and returns the authoritative summary. Return that summary unchanged. Do not call any other tools, independently inspect repositories, submit reviews, or create reminders.'
const TITLE = { zh: '看板审核 · 每日同步', en: 'Board review · Daily sync' }

/** The daily review's task and session title, in the UI language. */
export function dailyTitle(): string {
  return localized(TITLE)
}

export interface ScheduleStatus {
  enabled: boolean
  taskId?: string
  sessionId?: string
  nextRun?: number
  title?: string
  error?: string
  time?: string
  timeZone?: string
  summary?: string
}
export interface ReviewTask {
  id: string
  sessionId: string
  status: string
  title: string
  prompt: string
  scheduledAt: string
  lastDelivery?: { messageId: string; scheduledAt?: string; deliveredAt?: string }
  rule?: { type: string; time?: string; timeZone?: string; time_zone?: string }
  [key: string]: unknown
}
export interface ReviewScheduleHost {
  create(sessionId: string, request: { title: string; prompt: string; daily: { time: string; time_zone: string } }): Promise<{ id: string }>
  catalog(): Promise<ReviewTask[]>
  delete(request: { sessionId: string; id: string }): Promise<unknown>
  update(request: { sessionId: string; id: string; expected: Record<string, unknown>; title: string }): Promise<{ updated: boolean; code?: string }>
}
export interface ReviewToolScope {
  presentAs(mode: 'native'): () => void
  restrict(filter: { allow: string[] }): () => void
}
export interface ReviewSyncTools {
  register(tool: {
    name: string; description: string; parameters: Record<string, unknown>; timeoutMs: number
    output: { schema: Record<string, unknown>; render(args: unknown, value: string): Array<{ type: 'text'; text: string }> }
    execute(args: unknown, exec: { agent?: { id: string }; signal: AbortSignal; concludeTurn(): void }): Promise<string>
  }): () => void
}
interface State {
  migrated: boolean
  sessionId?: string
  taskId?: string
  time?: string
  timeZone?: string
  summary?: string
  lastOccurrence?: string
}
interface Options {
  file: string
  settings(): { auto?: boolean; at?: string }
  repositories?(): Promise<boolean>
  writable?(): boolean
  setAuto(enabled: boolean): Promise<void>
  schedule(): ReviewScheduleHost | undefined
  start(): Promise<string>
  rename(sessionId: string, title: string): Promise<unknown>
  prepare?(sessionId: string): Promise<void>
  run(signal?: AbortSignal): Promise<{ title: string; summary: string }>
  timeZone?(): string
}

export class ReviewSchedule {
  private state: State = { migrated: false }
  private queue: Promise<unknown> = Promise.resolve()
  private flight?: Promise<string>
  private stopped = false
  private controller = new AbortController()
  private error?: string
  private toolScopes = new Map<object, () => void>()
  private ready: Promise<void>
  private readonly options: Options
  private readonly writeState: (value: unknown) => Promise<void>
  constructor(options: Options) {
    this.options = options
    this.writeState = jsonWriter(options.file)
    this.ready = readFile(options.file, 'utf8').then((text) => {
      const value = JSON.parse(text) as State
      if (value.migrated !== true) throw new Error('Invalid review schedule state')
      this.state = value
    }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  }
  private save(): Promise<void> { return this.writeState(this.state) }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => { await this.ready; if (this.stopped) throw new Error('Review scheduling stopped'); return work() })
    this.queue = next.catch(() => {})
    return next
  }
  private host(): ReviewScheduleHost {
    const host = this.options.schedule()
    if (!host || !['create', 'catalog', 'delete', 'update'].every((key) => typeof host[key as keyof ReviewScheduleHost] === 'function')) throw new Error('Native review scheduling is unavailable')
    return host
  }
  private async tasks(): Promise<ReviewTask[]> {
    return (await this.host().catalog()).filter((task) => task.sessionId === this.state.sessionId
      && (this.state.taskId ? task.id === this.state.taskId : task.prompt === PROMPT))
  }
  /** A persisted migration fence is written BEFORE native admission: deletion never triggers recreation. */
  initialize(): Promise<ScheduleStatus> {
    return this.serial(async () => {
      if (!this.state.migrated) {
        // A temporarily empty/loading workspace registry must not consume the migration fence.
        if (this.options.repositories && !await this.options.repositories()) return { enabled: false }
        this.state.migrated = true
        await this.save()
        if (this.options.settings().auto === true) await this.enable()
      } else if (this.options.settings().auto !== true) await this.disable()
      else if (this.state.sessionId) await this.options.prepare?.(this.state.sessionId)
      return this.status()
    }).catch((error) => this.failed(error))
  }
  handle(payload: Record<string, unknown>): Promise<ScheduleStatus> {
    return this.serial(async () => {
      if (payload.action === 'enable') { await this.enable(); this.error = undefined }
      else if (payload.action === 'disable') { await this.disable(); this.error = undefined }
      else if (payload.action !== 'status') throw new Error('Unknown review schedule action')
      return this.status()
    }).catch((error) => this.failed(error))
  }
  /** Config edits may turn scheduling off, but must never re-arm a deleted task. */
  reconfigure(): Promise<ScheduleStatus> {
    return this.serial(async () => {
      if (!this.state.migrated && this.options.settings().auto === true) {
        if (this.options.repositories && !await this.options.repositories()) return { enabled: false }
        this.state.migrated = true
        await this.save()
        await this.enable()
      } else if (this.options.settings().auto !== true) await this.disable()
      else if (this.state.sessionId) await this.options.prepare?.(this.state.sessionId)
      return this.status()
    }).catch((error) => this.failed(error))
  }
  private failed(error: unknown): ScheduleStatus {
    this.error = error instanceof Error ? error.message : String(error)
    return { enabled: false, ...this.stateView(), error: this.error }
  }
  private stateView(): Omit<ScheduleStatus, 'enabled'> {
    const { sessionId, taskId, time, timeZone, summary } = this.state
    return { sessionId, taskId, time, timeZone, summary }
  }
  private async status(): Promise<ScheduleStatus> {
    const tasks = await this.tasks()
    const active = tasks.find((item) => item.status === 'active')
    const task = active ?? tasks[0]
    if (task && ((typeof task.time === 'string' && task.time !== this.state.time)
      || (typeof task.timeZone === 'string' && task.timeZone !== this.state.timeZone))) {
      if (typeof task.time === 'string') this.state.time = task.time
      if (typeof task.timeZone === 'string') this.state.timeZone = task.timeZone
      await this.save()
    }
    const error = this.error ?? (this.state.migrated && this.options.settings().auto === true && !active
      ? 'No active native review task. Enable explicitly to create or recover it.' : undefined)
    return { ...this.stateView(), taskId: task?.id, ...(error ? { error } : {}), enabled: this.options.settings().auto === true && active !== undefined,
      ...(task ? { title: task.title, ...(active ? { nextRun: Date.parse(task.scheduledAt) } : {}),
        ...(typeof task.time === 'string' ? { time: task.time } : {}), ...(typeof task.timeZone === 'string' ? { timeZone: task.timeZone } : {}) } : {}) }
  }
  private async enable(): Promise<void> {
    if (this.options.writable?.() === false) throw new Error('Review settings are read-only')
    if (this.options.repositories && !await this.options.repositories()) throw new Error('Add a review repository before enabling daily reviews')
    this.host()
    if (!this.state.sessionId) {
      this.state.sessionId = await this.options.start()
      await this.save()
    }
    await this.options.prepare?.(this.state.sessionId)
    const tasks = await this.tasks()
    const active = tasks.find((task) => task.status === 'active')
    if (active) {
      this.state.taskId = active.id
      this.state.migrated = true
      await this.save()
      await this.options.setAuto(true)
      return
    }
    const at = this.options.settings().at ?? '09:00'
    const time = this.state.time ?? (/^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? `${at}:00` : '09:00:00')
    const timeZone = this.state.timeZone ?? this.options.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    this.state = { ...this.state, migrated: true, time, timeZone }
    delete this.state.taskId
    // Persist intent and session before create; an uncertain response is recovered by catalog, never retried blindly.
    await this.save()
    const task = await this.host().create(this.state.sessionId!, { title: dailyTitle(), prompt: PROMPT, daily: { time, time_zone: timeZone } })
    this.state.taskId = task.id
    await this.save()
    await this.options.setAuto(true)
  }
  private async disable(): Promise<void> {
    if (this.options.writable?.() === false) throw new Error('Review settings are read-only')
    await this.options.setAuto(false)
    if (this.state.sessionId) for (const task of await this.tasks()) {
      if (typeof task.time === 'string') this.state.time = task.time
      if (typeof task.timeZone === 'string') this.state.timeZone = task.timeZone
      await this.host().delete({ sessionId: task.sessionId, id: task.id })
    }
    this.state.migrated = true
    delete this.state.taskId
    await this.save()
  }
  isSession(sessionId: string): boolean { return sessionId === this.state.sessionId }
  releaseTools(agent: object): void {
    this.toolScopes.get(agent)?.()
    this.toolScopes.delete(agent)
  }
  /** Force only this agent's presentation to native; the global PTC deployment stays unchanged. */
  prepareTools(agent: object, tools: ReviewToolScope): void {
    if (this.toolScopes.has(agent)) return
    const offMode = tools.presentAs('native')
    let offRestriction: () => void
    try { offRestriction = tools.restrict({ allow: [REVIEW_SYNC_TOOL] }) }
    catch (error) { offMode(); throw error }
    this.toolScopes.set(agent, () => { offRestriction(); offMode() })
  }
  guard(name: string, sessionId: string | undefined): string | undefined {
    if (sessionId && sessionId === this.state.sessionId && name !== REVIEW_SYNC_TOOL) return 'The daily review session may only call review_sync'
    return undefined
  }
  register(tools: ReviewSyncTools): () => void {
    return tools.register({
      name: REVIEW_SYNC_TOOL,
      description: 'Synchronize the review board and return its deterministic summary. Only available to the dedicated daily review session. Never submits reviews.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 21 * 60_000,
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async (_args, exec) => {
        const summary = await this.execute(exec.agent?.id, exec.signal)
        // Installed host public execution API: persist the tool result and stop without a second helper generation.
        exec.concludeTurn()
        return summary
      },
    })
  }
  async execute(sessionId: string | undefined, signal: AbortSignal): Promise<string> {
    await this.ready
    if (this.options.repositories && !await this.options.repositories()) throw new Error('No review repositories are configured')
    if (this.stopped || sessionId !== this.state.sessionId || !sessionId || this.options.settings().auto !== true) throw new Error('review_sync is restricted to the enabled daily review session')
    // A native one-shot timing edit ends its task immediately after inbox delivery.
    // Its persisted receipt still authorizes that final tool call; a deleted row never does.
    const task = (await this.tasks()).find((task) => task.status === 'active'
      || (task.status === 'inactive' && typeof task.lastDelivery?.messageId === 'string' && task.lastDelivery.messageId !== ''))
    if (!task) throw new Error('The daily review task has been deleted or ended')
    if (this.flight) return this.flight
    // Catalog exposes the durable inbox message receipt. A timing edit must not re-run that delivery.
    // Before the first delivery, use the committed target for explicit calls in this dedicated Session.
    const occurrence = `${task.id}:${task.lastDelivery?.messageId ?? task.scheduledAt}`
    if (this.state.lastOccurrence === occurrence && this.state.summary !== undefined) return this.state.summary
    const combined = AbortSignal.any([signal, this.controller.signal])
    this.flight = (async () => {
      combined.throwIfAborted()
      const result = await this.options.run(combined)
      this.state.summary = result.summary
      this.state.lastOccurrence = occurrence
      await this.save()
      this.error = undefined
      try {
        await this.options.rename(sessionId, result.title)
        // Re-read the current occurrence after the long run; a user timing edit wins the CAS.
        for (const task of await this.tasks()) {
          if (task.status !== 'active') continue
          const { sessionId: binding, status: _status, lastDelivery: _delivery, ...expected } = task
          const updated = await this.host().update({ sessionId: binding, id: task.id, expected, title: result.title.slice(0, 120) })
          if (!updated.updated && updated.code) throw new Error(`Review task title update failed: ${updated.code}`)
        }
      } catch (error) {
        // The synchronization succeeded: keep its readable tool result even when title metadata fails.
        this.error = `Review completed; title update failed: ${error instanceof Error ? error.message : String(error)}`
      }
      return result.summary
    })().finally(() => { this.flight = undefined })
    return this.flight
  }
  dispose(): void {
    this.stopped = true
    this.controller.abort()
    for (const off of this.toolScopes.values()) off()
    this.toolScopes.clear()
  }
}
