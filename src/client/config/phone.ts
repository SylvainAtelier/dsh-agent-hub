/**
 * The settings form's scope on a phone. DSH gives a page not opened on its own
 * machine no configuration form, so this one reads and writes the plugin's
 * entry through `agent-hub/phone-settings` (remote/settings.ts), which the
 * computer keeps closed until 允许手机修改设置 is on there.
 *
 * It reads once at startup, so the settings page opens on values already here,
 * and again when the page is shown or the browser comes back to the tab. A
 * write answers with the entry as stored, so a save costs one round trip, and
 * an answer older than one already applied is dropped.
 */

import { rpcValue, type Rpc } from '../rpc.ts'
import { PHONE_SETTINGS_METHOD, type PhoneSettingsReply, type PhoneSettingsRequest, type PhoneSettingsView } from '../../remote/settings.ts'
import type { ConfigScope, Op } from './form.ts'

type Snapshot = ReturnType<ConfigScope['getSnapshot']>

/** A read this recent is fresh enough when the tab comes back. */
const FRESH = 5_000

export class PhoneScope implements ConfigScope {
  private snapshot: Snapshot = { status: 'loading', writable: false, phone: 'open' }
  private listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private writing: Promise<void> | undefined
  private readAt = 0
  /** Requests are numbered as sent; an answer applies only if none sent after it has applied. */
  private sent = 0
  private applied = 0
  private readonly call: (request: PhoneSettingsRequest) => Promise<PhoneSettingsReply>

  constructor(rpc: Rpc) {
    this.call = (request) => rpcValue<PhoneSettingsReply>(rpc, PHONE_SETTINGS_METHOD, request, 'agent-hub phone settings RPC failed')
  }

  getSnapshot = (): Snapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Read the entry again, unless a read is in flight or one finished within `fresh` ms. A write in
   * flight answers with the stored entry itself; a read sent beside it could be served first.
   */
  refresh(fresh = 0): Promise<void> {
    if (this.writing !== undefined) return this.writing
    if (this.reading !== undefined) return this.reading
    if (fresh > 0 && Date.now() - this.readAt < fresh) return Promise.resolve()
    const ticket = ++this.sent
    this.reading = this.call({ op: 'read' })
      .then((reply) => this.apply(ticket, reply.view), () => {
        // Keep what is shown; only a first read that failed has nothing to show.
        if (this.snapshot.status === 'loading') this.set({ status: 'unavailable', writable: false })
      })
      .finally(() => {
        this.reading = undefined
        this.readAt = Date.now()
      })
    return this.reading
  }

  /** Refresh when the browser comes back to this tab; returns the disposer. */
  watch(): () => void {
    const onVisible = (): void => { if (document.visibilityState === 'visible') void this.refresh(FRESH) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }

  async mutate(ops: Op[], expectedRevision?: number): Promise<boolean> {
    if (expectedRevision === undefined) return false
    const ticket = ++this.sent
    const request = this.call({ op: 'mutate', ops, revision: expectedRevision })
    const writing = request.then(() => {}, () => {})
    this.writing = writing
    try {
      const reply = await request
      this.apply(ticket, reply.view)
      return reply.landed === true
    } finally {
      if (this.writing === writing) this.writing = undefined
    }
  }

  private apply(ticket: number, view: PhoneSettingsView): void {
    if (ticket < this.applied) return
    this.applied = ticket
    this.set(view.enabled
      ? { status: 'ready', writable: view.writable, revision: view.revision, value: view.value, base: view.base, user: view.user, phone: 'open' }
      : { status: 'unavailable', writable: false, phone: 'locked' })
  }

  private set(next: Snapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
