/** Browser state for the Sentry alerts lane. */

import { ALERTS_METHOD, compareIssues, type AlertOrder, type AlertPeriod, type AlertsReply, type AlertsRequest, type AlertsState, type AlertSort, type SentryIssue, type SentryIssueDetail } from '../../alerts/types.ts'
import { rpcReply, type Rpc } from '../rpc.ts'

const POLL_MS = 5 * 60_000
export type AlertsCall = (request: AlertsRequest) => Promise<AlertsReply<unknown>>
export const alertsCall = (rpc: Rpc): AlertsCall => (request) => rpcReply<AlertsReply<unknown>>(rpc, ALERTS_METHOD, request, 'agent-hub alerts RPC failed', (error) => ({ ok: false, error }))

export interface AlertsQuery { period: AlertPeriod; sort: AlertSort; order: AlertOrder }
const queryKey = (query: AlertsQuery): string => `${query.period}:${query.sort}:${query.order}`

export interface AlertsSnapshot {
  state?: AlertsState
  /** The filters last asked for; the list may still show the previous ones while they are read. */
  query?: AlertsQuery
  loading: boolean
  notice: string | null
  details: ReadonlyMap<string, SentryIssueDetail>
  resolving: ReadonlySet<string>
  /** Issues whose Analyse or Fix was clicked and has not been answered yet. */
  pending: ReadonlySet<string>
  undo?: SentryIssue
}

export class AlertsStore {
  private readonly call: AlertsCall
  private snapshot: AlertsSnapshot = { loading: false, notice: null, details: new Map(), resolving: new Set(), pending: new Set() }
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private undoTimer?: ReturnType<typeof setTimeout>
  private readonly resolveCalls = new Map<string, Promise<unknown>>()
  private disposed = false
  private reading = 0
  /** The last list read for each filter, shown at once when switching back to it. */
  private readonly lists = new Map<string, AlertsState>()
  constructor(call: AlertsCall) { this.call = call }
  private readonly back = (): void => {
    clearTimeout(this.timer)
    if (this.disposed || this.listeners.size === 0 || globalThis.document?.visibilityState === 'hidden') return
    if (!this.snapshot.loading) void this.load()
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      globalThis.document?.addEventListener?.('visibilitychange', this.back)
      this.schedule()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        clearTimeout(this.timer)
        globalThis.document?.removeEventListener?.('visibilitychange', this.back)
      }
    }
  }
  readonly getSnapshot = (): AlertsSnapshot => this.snapshot
  private publish(change: Partial<AlertsSnapshot>): void { this.snapshot = { ...this.snapshot, ...change }; for (const listener of this.listeners) listener() }
  private async request<T>(request: AlertsRequest): Promise<T> { const reply = await this.call(request); if (!reply.ok) throw new Error(reply.error); return reply.value as T }
  async load(force = false, patch: Partial<AlertsQuery> = {}): Promise<void> {
    const generation = ++this.reading
    const current = this.snapshot.state
    const base = this.snapshot.query ?? current
    const wanted = base && { period: patch.period ?? base.period, sort: patch.sort ?? base.sort, order: patch.order ?? base.order }
    // Only a filter switch is announced; a poll or refresh keeps any switch still being read.
    const asked = patch.period !== undefined || patch.sort !== undefined || patch.order !== undefined
    this.publish({ loading: true, query: asked ? wanted : this.snapshot.query, ...(asked && current && wanted ? this.preview(current, wanted) : {}) })
    try {
      const state = await this.request<AlertsState>({ op: 'list', period: wanted?.period, sort: wanted?.sort, order: wanted?.order, force })
      this.lists.set(queryKey(state), state)
      if (!this.disposed && generation === this.reading) this.publish({ state, loading: false, query: undefined })
    } catch (error) {
      if (!this.disposed && generation === this.reading) this.publish({ loading: false, query: undefined, notice: error instanceof Error ? error.message : String(error) })
    } finally { this.schedule() }
  }
  /** What to show while another filter is read: its last list, else the current one re-sorted when that is complete. */
  private preview(current: AlertsState, query: AlertsQuery): Partial<AlertsSnapshot> {
    if (queryKey(current) === queryKey(query)) return {}
    const cached = this.lists.get(queryKey(query))
    if (cached) return { state: cached }
    if (current.period !== query.period || current.truncated || current.error) return {}
    const issues = [...current.issues].sort((a, b) => query.order === 'asc' ? compareIssues(a, b, query.sort) : compareIssues(b, a, query.sort))
    return { state: { ...current, sort: query.sort, order: query.order, issues } }
  }
  private schedule(): void {
    clearTimeout(this.timer)
    const busy = this.snapshot.state?.issues.some((issue) => issue.phase === 'preparing' || issue.phase === 'analysing' || issue.phase === 'fixing') === true
    if (!this.disposed && this.listeners.size && globalThis.document?.visibilityState !== 'hidden') this.timer = setTimeout(() => {
      if (!this.disposed && this.listeners.size && globalThis.document?.visibilityState !== 'hidden' && !this.snapshot.loading) void this.load()
    }, busy ? 3_000 : POLL_MS)
  }
  async detail(id: string, force = false): Promise<SentryIssueDetail | undefined> {
    const cached = this.snapshot.details.get(id)
    if (cached && !force) return cached
    try {
      const detail = await this.request<SentryIssueDetail>({ op: 'detail', id, force })
      const details = new Map(this.snapshot.details); details.set(id, detail); this.publish({ details }); return detail
    } catch (error) { this.publish({ notice: error instanceof Error ? error.message : String(error) }); return undefined }
  }
  async analyse(id: string, bot: string): Promise<void> { await this.action(id, { op: 'analyse', id, bot }) }
  async fix(id: string): Promise<void> { await this.action(id, { op: 'fix', id }) }
  private async action(id: string, request: AlertsRequest): Promise<void> {
    if (this.snapshot.pending.has(id)) return
    this.publish({ pending: new Set(this.snapshot.pending).add(id) })
    try { await this.request(request) } catch (error) { this.publish({ notice: error instanceof Error ? error.message : String(error) }) }
    // The card leaves its pending state only once the list shows where the issue went.
    await this.load()
    const pending = new Set(this.snapshot.pending); pending.delete(id)
    this.publish({ pending })
  }
  async resolve(issue: SentryIssue): Promise<void> {
    const state = this.snapshot.state
    if (!state) return
    const resolving = new Set(this.snapshot.resolving); resolving.add(issue.id)
    clearTimeout(this.undoTimer)
    for (const [key, listed] of this.lists) this.lists.set(key, { ...listed, issues: listed.issues.filter((item) => item.id !== issue.id) })
    this.publish({ state: { ...state, issues: state.issues.filter((item) => item.id !== issue.id) }, resolving, undo: issue })
    this.undoTimer = setTimeout(() => this.publish({ undo: undefined }), 10_000)
    const call = this.request({ op: 'resolve', id: issue.id })
    this.resolveCalls.set(issue.id, call)
    try {
      await call
      resolving.delete(issue.id)
      this.publish({ resolving })
    } catch (error) {
      resolving.delete(issue.id)
      this.publish({ state: { ...state, issues: state.issues }, resolving, undo: undefined, notice: error instanceof Error ? error.message : String(error) })
    } finally { if (this.resolveCalls.get(issue.id) === call) this.resolveCalls.delete(issue.id) }
  }
  async undoResolve(issue: SentryIssue): Promise<void> {
    clearTimeout(this.undoTimer)
    this.publish({ undo: undefined })
    try {
      await this.resolveCalls.get(issue.id)?.catch(() => {})
      await this.request({ op: 'unresolve', id: issue.id }); await this.load(true)
    } catch (error) { this.publish({ notice: error instanceof Error ? error.message : String(error) }) }
  }
  dismiss(): void { this.publish({ notice: null }) }
  dispose(): void { this.disposed = true; ++this.reading; clearTimeout(this.timer); clearTimeout(this.undoTimer); globalThis.document?.removeEventListener?.('visibilitychange', this.back); this.listeners.clear() }
}
