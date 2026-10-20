/** The bells' shared state: one poll for every mounted bell, long only while one is armed or a notification waits. */
import type { GlassesRequest, GlassesUpdate } from '../../bridge/types.ts'

const RETRY_MS = 3000

/** The shared state: the bridge's last update, read by every bell. */
export class GlassesHub {
  private update: GlassesUpdate | undefined
  private listeners = new Set<() => void>()
  private stop: AbortController | undefined
  private readonly call: (request: GlassesRequest, signal?: AbortSignal) => Promise<GlassesUpdate>

  constructor(call: (request: GlassesRequest, signal?: AbortSignal) => Promise<GlassesUpdate>) {
    this.call = call
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.stop === undefined) void this.poll(this.stop = new AbortController())
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.stop?.abort()
        this.stop = undefined
      }
    }
  }

  readonly snapshot = (): GlassesUpdate | undefined => this.update

  private set(update: GlassesUpdate): void {
    if (this.update !== undefined && update.boot === this.update.boot && update.epoch < this.update.epoch) return
    this.update = update
    for (const listener of this.listeners) listener()
  }

  /** Wakes a poll resting while nothing is armed or waiting. */
  private nudge: (() => void) | undefined

  /** Read again now (the window came back into view: whether the glasses can be reached may have changed). */
  readonly refresh = (): void => { this.nudge?.() }

  /**
   * A long poll while a bell is armed or a notification waits: what changes then is worth seeing at
   * once (the bell going out when its turn ends). Otherwise the state is read once and the poll
   * rests until a bell is pressed or the window comes back.
   */
  private async poll(stop: AbortController): Promise<void> {
    while (!stop.signal.aborted) {
      try {
        const previous = this.update
        const busy = previous !== undefined && (previous.status.armed.length > 0 || previous.status.queued > 0)
        this.set(await this.call({ op: 'status', ...(busy ? { boot: previous.boot, since: previous.epoch } : {}) }, AbortSignal.any([stop.signal, AbortSignal.timeout(20_000)])))
        const now = this.update!.status
        if (now.armed.length === 0 && now.queued === 0) {
          await new Promise<void>((resolve) => {
            this.nudge = resolve
            stop.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          this.nudge = undefined
        }
      } catch {
        if (stop.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }
  }

  async arm(sessionId: string, on: boolean): Promise<GlassesUpdate> {
    const update = await this.call({ op: 'arm', sessionId, on }, AbortSignal.timeout(15_000))
    this.set(update)
    this.nudge?.()
    return update
  }
}
