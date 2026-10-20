/** Demand-driven Cardputer status: one poll in flight, none while hidden. */
import { DEVICE_METHOD, type DeviceRequest, type DeviceStatus } from '../../device/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

export interface CardputerSnapshot {
  status: DeviceStatus | undefined
  busy: DeviceRequest['op'] | null
  error: string | null
}
const IDLE_MS = 4000
const PAIRING_MS = 1000

export class CardputerStore {
  private snapshot: CardputerSnapshot = { status: undefined, busy: null, error: null }
  private listeners = new Set<() => void>()
  private watchers = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly rpc: Rpc
  private reading: Promise<void> | undefined
  private generation = 0
  private statusBody = ''

  constructor(rpc: Rpc) { this.rpc = rpc }
  getSnapshot = (): CardputerSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private readonly visibility = (): void => {
    clearTimeout(this.timer)
    if (this.watchers > 0 && globalThis.document?.visibilityState !== 'hidden') void this.tick()
  }
  watch(): () => void {
    if (this.watchers++ === 0) {
      globalThis.document?.addEventListener?.('visibilitychange', this.visibility)
      void this.tick()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.watchers === 0) {
        clearTimeout(this.timer)
        globalThis.document?.removeEventListener?.('visibilitychange', this.visibility)
      }
    }
  }
  run(request: DeviceRequest): Promise<void> {
    if (request.op === 'status') {
      if (this.snapshot.busy !== null) return Promise.resolve()
      if (this.reading !== undefined) return this.reading
      const task = this.perform(request)
      this.reading = task
      void task.finally(() => { if (this.reading === task) this.reading = undefined })
      return task
    }
    if (this.snapshot.busy !== null) return Promise.resolve()
    return this.perform(request)
  }
  private async perform(request: DeviceRequest): Promise<void> {
    const generation = ++this.generation
    const action = request.op !== 'status'
    if (action) this.publish({ ...this.snapshot, busy: request.op })
    try {
      const status = await rpcValue<DeviceStatus>(this.rpc, DEVICE_METHOD, request, 'agent-hub device RPC failed')
      if (generation !== this.generation) return
      const body = JSON.stringify(status)
      const stable = body === this.statusBody ? this.snapshot.status : status
      this.statusBody = body
      this.publish({ status: stable, busy: null, error: null })
    } catch (error) {
      if (generation === this.generation) this.publish({ ...this.snapshot, busy: null, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.watchers > 0) this.reschedule()
    }
  }
  private async tick(): Promise<void> {
    if (this.watchers === 0 || globalThis.document?.visibilityState === 'hidden') return
    await this.run({ op: 'status' })
  }
  private reschedule(): void {
    clearTimeout(this.timer)
    if (this.watchers === 0 || globalThis.document?.visibilityState === 'hidden') return
    const phase = this.snapshot.status?.pairing?.phase
    this.timer = setTimeout(() => void this.tick(), phase === 'waiting' || phase === 'compare' ? PAIRING_MS : IDLE_MS)
  }
  private publish(next: CardputerSnapshot): void {
    if (next.status === this.snapshot.status && next.busy === this.snapshot.busy && next.error === this.snapshot.error) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
