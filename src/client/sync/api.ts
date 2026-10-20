/**
 * The browser side of settings sync: one store shared by the 同步与更新 page
 * and the startup notice. A sync runs on the host beside the request (a fetch
 * or a plugin install can take a while), so while the status says it is busy
 * the store reads it again until it is done.
 */

import { SYNC_METHOD, type SyncCatalog, type SyncLog, type SyncRequest, type SyncStatus } from '../../sync/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

export type SyncCall = (payload: SyncRequest) => Promise<unknown>

export function syncCall(rpc: Rpc): SyncCall {
  return (payload) => rpcValue(rpc, SYNC_METHOD, payload, 'agent-hub settings sync RPC failed')
}

export interface SyncSnapshot {
  /** Undefined until the first read. */
  status: SyncStatus | undefined
  /** A request is on its way (the status's `busy` is the host's own run). */
  sending: boolean
  /** The transport failed (the status's own `error` is the operation's). */
  error: string | null
}

/** How often a running sync is read. */
const FOLLOW_MS = 800
/** Failed reads in a row a running sync outlasts (about 15 s). */
const FOLLOW_MISSES = 20

export class SyncStore {
  private snapshot: SyncSnapshot = { status: undefined, sending: false, error: null }
  private listeners = new Set<() => void>()
  private readonly call: SyncCall
  private timer: ReturnType<typeof setTimeout> | undefined
  private misses = 0

  constructor(call: SyncCall) {
    this.call = call
  }

  getSnapshot = (): SyncSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  load(): Promise<void> {
    return this.run({ op: 'status' })
  }

  async run(request: Exclude<SyncRequest, { op: 'log' | 'catalog' }>): Promise<void> {
    if (request.op !== 'status' && (this.snapshot.sending || this.snapshot.status?.busy)) return
    clearTimeout(this.timer)
    if (request.op !== 'status') this.publish({ ...this.snapshot, sending: true })
    try {
      const status = await this.call(request) as SyncStatus
      this.misses = 0
      this.publish({ status, sending: false, error: null })
      if (status.busy !== null) this.timer = setTimeout(() => void this.load(), FOLLOW_MS)
    } catch (error) {
      // A sync that applies this plugin's own settings reloads it on the host: while one runs,
      // a read that finds the plugin away is tried again rather than ending the follow.
      if (request.op === 'status' && this.snapshot.status?.busy && ++this.misses <= FOLLOW_MISSES) {
        this.timer = setTimeout(() => void this.load(), FOLLOW_MS)
        return
      }
      this.misses = 0
      this.publish({ ...this.snapshot, sending: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async log(): Promise<SyncLog> {
    return await this.call({ op: 'log' }) as SyncLog
  }

  async catalog(): Promise<SyncCatalog> {
    return await this.call({ op: 'catalog' }) as SyncCatalog
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private publish(next: SyncSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
