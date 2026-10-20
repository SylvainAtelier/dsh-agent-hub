import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { jsonWriter } from '../persistence.ts'
import { validateScriptTask } from './runner.ts'
import type { ReviewScheduleHost, ReviewTask, ReviewToolScope, ReviewSyncTools } from '../review/schedule.ts'
import { AUTOMATION_TOOL, type AutomationReply, type AutomationSettings, type RunResult, type ScriptTask, type TaskStatus } from './types.ts'

export type AutomationNativeHost = Pick<ReviewScheduleHost, 'create' | 'catalog' | 'delete'>
export interface Options {
  file: string
  settings(): AutomationSettings
  schedule(): AutomationNativeHost | undefined
  start(def: ScriptTask): Promise<string>
  prepare(sessionId: string, def: ScriptTask): Promise<void>
  run(def: ScriptTask, signal: AbortSignal, runId: string): Promise<RunResult>
  timeZone?(): string
  /** Best-effort local trace; must never throw into or delay a run. */
  log?(event: Record<string, unknown>): void
}
type Run = NonNullable<TaskStatus['run']>
interface Binding {
  id: string
  sessionId: string
  taskId?: string
  pendingCreation?: boolean
  creationError?: string
  fingerprint: string
  time?: string
  timeZone?: string
  run?: Run
  // Never evict consumption tombstones: a bounded result cache alone permits historical replay.
  receipts: Record<string, Run>
}
interface State { version: 1; bindings: Binding[]; retiredSessions?: string[]; manual?: Record<string, Run>; history?: Record<string, Run[]> }
const HISTORY_LIMIT = 20
interface Flight { occurrence: string; controller: AbortController; promise: Promise<string>; manual?: boolean }
const INTERRUPTED = 'Previous execution was interrupted; outcome is unknown.'
const prompt = '[agent-hub:automation:v1] Call automation_run exactly once and return its authoritative result unchanged. Do not call any other tools or create reminders.'
const encode = (result: RunResult): string => JSON.stringify(result)
const LABELS: Record<RunResult['status'], string> = { ok: 'Succeeded', error: 'Failed', unknown: 'Outcome unknown' }
/** The session shows a readable line; the model still receives the authoritative JSON. */
export function describeResult(text: string): string {
  try {
    const result = JSON.parse(text) as RunResult
    if (!result || !Object.hasOwn(LABELS, result.status) || typeof result.summary !== 'string') return text
    return `${LABELS[result.status]}${result.code === undefined ? '' : ` (exit ${result.code})`}: ${result.summary}`
  } catch { return text }
}
const denied = (summary: string): string => encode({ status: 'error', summary })
const fingerprint = (def: ScriptTask): string => JSON.stringify(def)
const eligible = (task: ReviewTask | undefined): boolean => !!task && (task.status === 'active' || (task.status === 'inactive' && (task.kind === 'at' || task.rule?.type === 'at') && !!task.lastDelivery?.messageId?.trim()))
interface FileSlot { tail: Promise<void>; owner: symbol; cancel(): void }
const registryKey = Symbol.for('agent-hub/automation/file-owners/v1')
const globals = globalThis as unknown as Record<symbol, unknown>
const fileSlots = (globals[registryKey] ??= new Map<string, FileSlot>()) as Map<string, FileSlot>

export class AutomationService {
  private state: State = { version: 1, bindings: [] }
  private ready: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private flights = new Map<string, Flight>()
  private scopes = new Map<object, () => void>()
  private writeState: (state: unknown) => Promise<void>
  private options: Options
  private lifetime = new AbortController()
  private owner = Symbol('automation-owner')
  private fileSlot: FileSlot
  constructor(options: Options) {
    this.options = options
    this.writeState = jsonWriter(options.file)
    const file = process.platform === 'win32' ? resolve(options.file).toLowerCase() : resolve(options.file)
    const previous = fileSlots.get(file)
    previous?.cancel()
    this.fileSlot = previous ?? { tail: Promise.resolve(), owner: this.owner, cancel: () => {} }
    this.fileSlot.owner = this.owner
    this.fileSlot.cancel = () => this.lifetime.abort()
    fileSlots.set(file, this.fileSlot)
    // The read follows every write already begun by the previous instance; queued stale writes are fenced out.
    this.ready = this.fileOperation(async () => {
      this.assertActive()
      let text: string
      try { text = await readFile(options.file, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      this.assertActive()
      const state = JSON.parse(text) as State
      if (state.version !== 1 || !Array.isArray(state.bindings) || state.bindings.some((b) => !b || typeof b.id !== 'string' || typeof b.sessionId !== 'string' || typeof b.fingerprint !== 'string' || !b.receipts || typeof b.receipts !== 'object')) throw new Error('Invalid automation state')
      this.state = state
      this.index()
      let dirty = false
      for (const binding of state.bindings) {
        for (const run of Object.values(binding.receipts)) if (run.status === 'running') {
          run.status = 'unknown'; run.summary = 'Previous execution was interrupted; outcome is unknown.'; run.finishedAt = new Date().toISOString(); dirty = true
          this.record(binding.id, run)
        }
        if (binding.run?.status === 'running') { binding.run = { ...binding.run, status: 'unknown', summary: 'Previous execution was interrupted; outcome is unknown.', finishedAt: new Date().toISOString() }; dirty = true }
      }
      for (const [id, run] of Object.entries(state.manual ?? {})) if (run.status === 'running') {
        run.status = 'unknown'; run.summary = INTERRUPTED; run.finishedAt = new Date().toISOString(); dirty = true
        this.record(id, run)
      }
      this.assertActive()
      // A clean restart rewrites nothing; only interrupted runs need a durable tombstone.
      if (dirty) await this.writeState(this.state)
    })
    // A disposed constructor may finish without a consumer; retain the rejection for callers without an unhandled rejection.
    void this.ready.catch(() => {})
  }
  /** Keep a bounded, newest-first log of finished runs; the same occurrence is recorded once. */
  private record(id: string, run: Run): void {
    const history = (this.state.history ??= {})
    const previous = Object.hasOwn(history, id) ? history[id] : []
    history[id] = [{ ...run }, ...previous.filter((item) => !run.occurrence || item.occurrence !== run.occurrence)].slice(0, HISTORY_LIMIT)
  }
  private sessions = new Set<string>()
  private index(): void {
    this.sessions = new Set([...this.state.bindings.map((item) => item.sessionId), ...(this.state.retiredSessions ?? [])])
  }
  private assertActive(): void {
    if (this.stopped || this.lifetime.signal.aborted || this.fileSlot.owner !== this.owner) throw new Error('Automation service is stopped')
  }
  private fileOperation<T>(work: () => Promise<T>): Promise<T> {
    const next = this.fileSlot.tail.catch(() => {}).then(work)
    this.fileSlot.tail = next.then(() => {}, () => {})
    return next
  }
  private save(): Promise<void> {
    const snapshot = structuredClone(this.state)
    return this.fileOperation(async () => { this.assertActive(); await this.writeState(snapshot) })
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => { await this.ready; this.assertActive(); return work() })
    this.queue = next.catch(() => {})
    return next
  }
  private host(): AutomationNativeHost {
    const host = this.options.schedule()
    if (!host) throw new Error('Native automation scheduling is unavailable')
    return host
  }
  private owned(binding: Binding, tasks: ReviewTask[]): ReviewTask | undefined {
    return tasks.find((task) => task.id === binding.taskId && task.sessionId === binding.sessionId)
  }
  /** Reconcile an uncertain create only; no catalog observation is permission to create. */
  private async reconcileCreation(binding: Binding, tasks: ReviewTask[]): Promise<void> {
    if (!binding.pendingCreation) return
    const matches = tasks.filter((task) => task.sessionId === binding.sessionId && task.prompt === prompt)
    if (matches.length !== 1) {
      const error = matches.length > 1 ? 'Multiple native tasks match the pending creation. Inspect them and disable before enabling again.' : 'Native task creation is uncertain. Inspect the native catalog and disable before enabling again.'
      if (binding.creationError !== error) { binding.creationError = error; await this.save() }
      return
    }
    binding.taskId = matches[0].id
    binding.pendingCreation = false
    delete binding.creationError
    try { await this.save() } catch {
      delete binding.taskId; binding.pendingCreation = true
      throw new Error('Native task reconciliation could not be persisted')
    }
  }
  private displayRun(binding: Binding, task?: ReviewTask): Run | undefined {
    // Display delivery without consuming it. Restart must not turn an unexecuted delivery into unknown.
    const messageId = task?.lastDelivery?.messageId?.trim()
    if (!messageId || !task) return binding.run
    const occurrence = `${task.id}:${task.lastDelivery!.messageId}`
    const consumed = Object.hasOwn(binding.receipts, occurrence) ? binding.receipts[occurrence] : undefined
    return consumed ?? { status: 'delivered', occurrence, kind: 'scheduled', deliveredAt: task.lastDelivery!.deliveredAt }
  }
  private async view(): Promise<AutomationReply> {
    const definitions = this.options.settings().tasks.map((task) => structuredClone(task))
    const tasks = this.options.schedule() ? await this.host().catalog() : []
    this.assertActive()
    let changed = false
    for (const binding of this.state.bindings) {
      await this.reconcileCreation(binding, tasks)
      const task = this.owned(binding, tasks)
      const flight = this.flights.get(binding.id)
      // A user-started manual run does not depend on the native schedule being active.
      if (!eligible(task) && !flight?.manual) flight?.controller.abort()
      const time = typeof task?.time === 'string' ? task.time : task?.rule?.time
      const zone = typeof task?.timeZone === 'string' ? task.timeZone : task?.rule?.timeZone ?? task?.rule?.time_zone
      if (time && time !== binding.time) { binding.time = time; changed = true }
      if (zone && zone !== binding.timeZone) { binding.timeZone = zone; changed = true }
    }
    if (changed) await this.save()
    return { definitions, tasks: definitions.map((def) => {
      const binding = this.state.bindings.find((item) => item.id === def.id)
      const task = binding && this.owned(binding, tasks)
      const manual = this.state.manual && Object.hasOwn(this.state.manual, def.id) ? this.state.manual[def.id] : undefined
      const history = this.state.history && Object.hasOwn(this.state.history, def.id) ? this.state.history[def.id] : undefined
      return { id: def.id, title: def.title, enabled: task?.status === 'active', ...(manual ? { manual: { ...manual } } : {}), ...(history?.length ? { history: history.map((run) => ({ ...run })) } : {}), ...(binding ? { sessionId: binding.sessionId, taskId: task?.id, run: this.displayRun(binding, task), time: binding.time, timeZone: binding.timeZone, ...(binding.creationError ? { error: binding.creationError } : {}) } : {}),
        ...(task ? { nextRun: task.status === 'active' ? task.scheduledAt : undefined, time: typeof task.time === 'string' ? task.time : task.rule?.time, timeZone: typeof task.timeZone === 'string' ? task.timeZone : task.rule?.timeZone ?? task.rule?.time_zone } : {}) }
    }) }
  }
  async whenReady(): Promise<void> { await this.ready; this.assertActive() }
  initialize(): Promise<AutomationReply> { return this.reconfigure() }
  reconfigure(): Promise<AutomationReply> {
    return this.serial(async () => {
      for (const binding of [...this.state.bindings]) {
        const def = this.options.settings().tasks.find((item) => item.id === binding.id)
        // Route/tool capability is re-validated on enable and on every execution; reconfigure only revokes stale bindings.
        if (!def || fingerprint(def) !== binding.fingerprint) await this.disable(binding.id)
      }
      return this.view()
    })
  }
  handle(payload: Record<string, unknown>): Promise<AutomationReply> {
    // Stop a running script immediately instead of waiting behind queued work.
    if (payload.action === 'disable' && typeof payload.id === 'string') this.flights.get(payload.id)?.controller.abort()
    if (payload.action === 'cancel' && typeof payload.id === 'string') { const flight = this.flights.get(payload.id); if (flight?.manual) flight.controller.abort() }
    return this.serial(async () => {
      if (payload.action === 'list' || payload.action === 'cancel') return this.view()
      this.note({ event: 'action', action: payload.action, id: payload.id })
      if (payload.action !== 'enable' && payload.action !== 'disable' && payload.action !== 'run') throw new Error('Unknown automation action')
      if (typeof payload.id !== 'string') throw new Error('Automation task id is required')
      if (payload.action === 'enable' || payload.action === 'run') {
        const current = this.options.settings().tasks.find((task) => task.id === payload.id)
        if (!current || JSON.stringify(validateScriptTask(payload.expected)) !== JSON.stringify(validateScriptTask(current))) throw new Error(`Automation definition changed; confirm the current definition before ${payload.action === 'run' ? 'running' : 'enabling'}`)
        if (payload.action === 'run') await this.runNow(current)
        else await this.enable(payload.id)
      } else await this.disable(payload.id)
      return this.view()
    })
  }
  /**
   * Explicit "run now": executes the confirmed definition directly (no model, no session, no receipt).
   * Replies once the run is admitted and persisted as running; the outcome is read through list.
   */
  private async runNow(def: ScriptTask): Promise<void> {
    validateScriptTask(def)
    if (this.flights.has(def.id)) throw new Error('Automation task is already running')
    const controller = new AbortController()
    const combined = AbortSignal.any([controller.signal, this.lifetime.signal])
    const run: Run = { status: 'running', occurrence: `manual:${randomUUID()}`, kind: 'manual', startedAt: new Date().toISOString() }
    const manual = (this.state.manual ??= {})
    const previous = Object.hasOwn(manual, def.id) ? manual[def.id] : undefined
    manual[def.id] = run
    try { await this.save() } catch (error) {
      if (previous) manual[def.id] = previous; else delete manual[def.id]
      throw error
    }
    this.assertActive()
    const promise = this.finish(run, structuredClone(def), combined, 'manual').finally(() => { this.flights.delete(def.id) })
    this.flights.set(def.id, { occurrence: run.occurrence!, controller, promise, manual: true })
    void promise.catch(() => {})
  }
  /** Run the script, then persist its terminal state; an unconfirmed save is reported as unknown, never as success. */
  private note(event: Record<string, unknown>): void { try { this.options.log?.(event) } catch { /* tracing is best effort */ } }
  private finish(run: Run, definition: ScriptTask, combined: AbortSignal, kind: 'manual' | 'scheduled'): Promise<string> {
    return Promise.resolve().then(async () => {
      let result: RunResult
      const began = Date.now()
      const runId = randomUUID()
      this.note({ event: 'run.start', id: definition.id, kind, occurrence: run.occurrence, runId, command: definition.command, args: definition.args })
      try {
        combined.throwIfAborted()
        result = await this.options.run(definition, combined, runId)
        if (!result || !['ok', 'error', 'unknown'].includes(result.status) || typeof result.summary !== 'string') result = { status: 'unknown', summary: 'Runner returned no confirmed outcome.' }
        if (combined.aborted) result = { status: 'unknown', summary: 'Execution cancelled; outcome is unknown.' }
        if (result.status === 'ok' && result.code !== undefined && result.code !== 0) result = { status: 'error', summary: 'Script exited unsuccessfully.', code: result.code }
      } catch { result = { status: 'unknown', summary: 'Execution interrupted; outcome is unknown.' } }
      run.status = result.status === 'ok' ? 'succeeded' : result.status === 'error' ? 'failed' : 'unknown'
      run.summary = result.summary; run.finishedAt = new Date().toISOString(); run.code = result.code
      this.note({ event: 'run.end', id: definition.id, kind, runId, status: run.status, code: result.code, ms: Date.now() - began, summary: result.summary })
      this.record(definition.id, run)
      try { await this.save() } catch {
        this.note({ event: 'run.persist-failed', id: definition.id, runId })
        run.status = 'unknown'; run.summary = 'Execution outcome could not be persisted; do not retry automatically.'
        this.record(definition.id, run)
        return encode({ status: 'unknown', summary: run.summary })
      }
      return encode(result)
    })
  }
  withDefinitionMutation<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const binding = this.state.bindings.find((item) => item.id === id)
      if (this.flights.has(id) || binding?.pendingCreation || (binding && this.owned(binding, await this.host().catalog())?.status === 'active')) throw new Error('Disable the task before editing or removing its definition')
      this.assertActive()
      return work()
    })
  }
  private async enable(id: string): Promise<void> {
    const def = this.options.settings().tasks.find((item) => item.id === id)
    if (!def) throw new Error('Automation task does not exist')
    validateScriptTask(def)
    const host = this.host()
    let binding = this.state.bindings.find((item) => item.id === id)
    if (binding?.pendingCreation) {
      await this.reconcileCreation(binding, await host.catalog())
      if (binding.pendingCreation) throw new Error(binding.creationError ?? 'Inspect and disable the uncertain native task before enabling')
    }
    if (binding && fingerprint(def) !== binding.fingerprint) await this.disable(id)
    if (binding && this.owned(binding, await host.catalog())?.status === 'active') { await this.options.prepare(binding.sessionId, def); return }
    if (this.flights.has(id)) throw new Error('Automation task is still stopping')
    // Every explicit re-enable gets a fresh session: old inbox receipts cannot acquire a new binding.
    this.assertActive()
    const sessionId = await this.options.start(structuredClone(def))
    this.assertActive()
    await this.options.prepare(sessionId, def)
    this.assertActive()
    if (binding) (this.state.retiredSessions ??= []).push(binding.sessionId)
    binding = { id, sessionId, pendingCreation: true, fingerprint: fingerprint(def), time: binding?.time ?? '10:05:00', timeZone: binding?.timeZone ?? this.options.timeZone?.() ?? 'Asia/Shanghai', receipts: Object.create(null) }
    this.state.bindings = this.state.bindings.filter((item) => item.id !== id)
    this.state.bindings.push(binding)
    this.index()
    await this.save()
    this.assertActive()
    let task: { id: string }
    try { task = await host.create(sessionId, { title: def.title, prompt, daily: { time: binding.time!, time_zone: binding.timeZone! } }) }
    catch (error) {
      if (this.lifetime.signal.aborted) {
        try { for (const item of await host.catalog()) if (item.sessionId === sessionId && item.prompt === prompt) await host.delete({ sessionId, id: item.id }) } catch { /* Persisted pending intent remains fail-closed for operator reconciliation. */ }
      }
      throw error
    }
    if (this.lifetime.signal.aborted || this.stopped || this.fileSlot.owner !== this.owner) {
      try { await host.delete({ sessionId, id: task.id }) } catch { /* Persisted pending intent prevents blind recreation. */ }
      throw new Error('Automation service stopped during native creation')
    }
    binding.taskId = task.id
    binding.pendingCreation = false
    try { await this.save() } catch {
      delete binding.taskId; binding.pendingCreation = true
      throw new Error('Native task creation could not be durably confirmed; inspect the catalog before retrying')
    }
  }
  private async disable(id: string): Promise<void> {
    const binding = this.state.bindings.find((item) => item.id === id)
    this.flights.get(id)?.controller.abort()
    if (!binding) return
    const previousTaskId = binding.taskId
    // Revoke first even if catalog/deletion fails. Never reconcile a revoked creation back into authority.
    delete binding.taskId
    binding.pendingCreation = false
    delete binding.creationError
    await this.save()
    const tasks = (await this.host().catalog()).filter((task) => task.sessionId === binding.sessionId && (task.id === previousTaskId || task.prompt === prompt))
    for (const task of tasks) {
      if (typeof task.time === 'string') binding.time = task.time
      if (typeof task.timeZone === 'string') binding.timeZone = task.timeZone
      await this.host().delete({ sessionId: binding.sessionId, id: task.id })
    }
    await this.save()
  }
  isSession(sessionId: string): boolean { return this.sessions.has(sessionId) }
  prepareTools(agent: object, tools: ReviewToolScope): void {
    if (this.scopes.has(agent)) return
    const mode = tools.presentAs('native')
    try { const restriction = tools.restrict({ allow: [AUTOMATION_TOOL] }); this.scopes.set(agent, () => { restriction(); mode() }) }
    catch (error) { mode(); throw error }
  }
  releaseTools(agent: object): void { this.scopes.get(agent)?.(); this.scopes.delete(agent) }
  guard(name: string, sessionId: string | undefined): string | undefined {
    if (sessionId && this.isSession(sessionId) && name !== AUTOMATION_TOOL) return 'Automation sessions may only call automation_run'
    if (name === AUTOMATION_TOOL && (!sessionId || !this.isSession(sessionId))) return 'automation_run requires a bound automation session'
    return undefined
  }
  register(tools: ReviewSyncTools): () => void {
    return tools.register({ name: AUTOMATION_TOOL, description: 'Run the configured task for a genuine native delivery. No commands or arguments are accepted.', parameters: { type: 'object', properties: {}, additionalProperties: false }, timeoutMs: 61 * 60_000,
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text: describeResult(text) }] },
      execute: async (args, exec) => {
        try {
          if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return denied('automation_run accepts no arguments.')
          return await this.execute(exec.agent?.id, exec.signal)
        } catch { return denied('Automation could not authorize or persist this execution.') }
        finally { exec.concludeTurn() }
      },
    })
  }
  async execute(sessionId: string | undefined, signal: AbortSignal): Promise<string> {
    const admitted = await this.serial(async (): Promise<{ result: Promise<string> }> => {
      const binding = this.state.bindings.find((item) => item.sessionId === sessionId)
      const def = binding && this.options.settings().tasks.find((item) => item.id === binding.id)
      if (!binding || !def || !binding.taskId || fingerprint(def) !== binding.fingerprint) { this.note({ event: 'run.denied', reason: 'no-binding', session: sessionId, id: binding?.id }); return { result: Promise.resolve(denied('No enabled automation binding.')) } }
      const task = this.owned(binding, await this.host().catalog())
      this.assertActive()
      if (!eligible(task) || !task?.lastDelivery?.messageId?.trim()) {
        const running = this.flights.get(binding.id)
        if (!eligible(task) && !running?.manual) running?.controller.abort()
        this.note({ event: 'run.denied', reason: 'no-receipt', id: binding.id, native: task?.status })
        return { result: Promise.resolve(denied('A genuine native delivery receipt is required.')) }
      }
      const occurrence = `${task.id}:${task.lastDelivery.messageId}`
      const existing = Object.hasOwn(binding.receipts, occurrence) ? binding.receipts[occurrence] : undefined
      const flight = this.flights.get(binding.id)
      if (existing && existing.status !== 'running' && existing.status !== 'delivered') return { result: Promise.resolve(encode({ status: existing.status === 'succeeded' ? 'ok' : existing.status === 'failed' ? 'error' : 'unknown', summary: existing.summary ?? 'Outcome is unknown.', ...(existing.code === undefined ? {} : { code: existing.code }) })) }
      if (flight) { if (flight.occurrence !== occurrence) this.note({ event: 'run.denied', reason: 'busy', id: binding.id, occurrence }); return { result: flight.occurrence === occurrence ? flight.promise : Promise.resolve(denied('Task is busy with a different delivery.')) } }
      if (existing) { this.note({ event: 'run.denied', reason: 'unconfirmed-earlier-admission', id: binding.id, occurrence }) }
      if (existing) return { result: Promise.resolve(encode({ status: 'unknown', summary: 'An earlier admission has no confirmed outcome; it will not be retried.' })) }
      // Revalidate route/tool capability at execution time: bot or model configuration may have changed since enable.
      await this.options.prepare(binding.sessionId, structuredClone(def))
      this.assertActive()
      signal.throwIfAborted()
      const controller = new AbortController()
      const combined = AbortSignal.any([controller.signal, signal, this.lifetime.signal])
      this.note({ event: 'delivery.admitted', id: binding.id, occurrence, model: `${def.provider}/${def.model}` })
      const run: Run = { status: 'running', occurrence, kind: 'scheduled', startedAt: new Date().toISOString(), ...(task.lastDelivery.deliveredAt ? { deliveredAt: task.lastDelivery.deliveredAt } : {}) }
      binding.receipts[occurrence] = run
      binding.run = run
      // If this write fails, do not run. The in-memory tombstone still prevents uncertain replay.
      await this.save()
      this.assertActive()
      combined.throwIfAborted()
      const promise = this.finish(run, structuredClone(def), combined, 'scheduled').finally(() => { this.flights.delete(binding.id) })
      this.flights.set(binding.id, { occurrence, controller, promise })
      return { result: promise }
    })
    return admitted.result
  }
  dispose(): void { this.stopped = true; this.lifetime.abort(); for (const flight of this.flights.values()) flight.controller.abort(); for (const off of this.scopes.values()) off(); this.scopes.clear() }
}
