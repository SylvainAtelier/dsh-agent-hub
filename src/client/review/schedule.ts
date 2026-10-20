/** Browser state for the host-owned review automation task, not a second scheduler. */
import { rpcValue, type Rpc } from '../rpc.ts'

export const REVIEW_SCHEDULE_METHOD = 'agent-hub/review-schedule'
export type ScheduleAction = 'status' | 'enable' | 'disable'
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
export interface ScheduleSnapshot {
  status: ScheduleStatus | undefined
  busy: ScheduleAction | undefined
  error: string | undefined
  /** A transport failure leaves the mutation outcome unknown; a host warning does not. */
  uncertain?: boolean
}

export class ReviewScheduleStore {
  private snapshot: ScheduleSnapshot = { status: undefined, busy: undefined, error: undefined }
  private listeners = new Set<() => void>()
  private pending: Promise<void> | undefined
  private controller: AbortController | undefined
  private disposed = false

  private rpc: Rpc
  constructor(rpc: Rpc) { this.rpc = rpc }
  getSnapshot = (): ScheduleSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Serialize reads and mutations so a stale read never overwrites a newly enabled task. */
  request(action: ScheduleAction = 'status'): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending !== undefined) return this.pending
    this.set({ ...this.snapshot, busy: action, error: undefined })
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)])
    this.pending = (async () => {
      try {
        const status = await rpcValue<ScheduleStatus>(this.rpc, REVIEW_SCHEDULE_METHOD, { action }, 'Review automation request failed', signal)
        if (typeof status?.enabled !== 'boolean') throw new Error('Invalid review automation status')
        if (!this.disposed) this.set({ status, busy: undefined, error: status.error, uncertain: false })
      } catch (error) {
        if (!this.disposed) this.set({ ...this.snapshot, busy: undefined, error: error instanceof Error ? error.message : String(error), uncertain: true })
      } finally {
        this.pending = undefined
        this.controller = undefined
      }
    })()
    return this.pending
  }

  /** Only the visible settings row watches; edits in the native manager appear on return. */
  watch(): () => void {
    const refresh = (): void => { if (document.visibilityState !== 'hidden') void this.request() }
    refresh()
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }

  dispose(): void {
    this.disposed = true
    this.controller?.abort()
    this.listeners.clear()
  }
  private set(snapshot: ScheduleSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
