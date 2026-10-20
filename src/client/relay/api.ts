/**
 * The browser's view of 接力: one store for the panel, the sidebar mark and
 * the notices. Long-polled while a page is visible (the panel also asks the
 * host to sample the processes); what is picked, filtered and typed stays
 * here, so leaving the panel and coming back finds it as it was.
 */

import { RELAY_METHOD, type RelayRequest, type RelayStatus, type RelayUpdate, type TakeoverResult, type ThreadDetail, type ThreadPhase, type ThreadView } from '../../relay/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

export type RelayCall = (payload: RelayRequest) => Promise<unknown>

export function relayCall(rpc: Rpc): RelayCall {
  return (payload) => rpcValue(rpc, RELAY_METHOD, payload, 'agent-hub relay RPC failed')
}

export type Filter = 'all' | 'qoder' | 'hermes'
/** What the detail column shows: the glasses' workspaces, or a thread. */
export const OVERVIEW = 'overview'

export interface DetailState {
  key: string
  data?: ThreadDetail
  error?: string
}

export interface RelaySnapshot {
  /** Undefined until the first read. */
  status: RelayStatus | undefined
  error: string | null
  /** Workspaces with a start, stop or reclaim in flight. */
  pending: ReadonlySet<string>
  /** The picked thread's key, OVERVIEW, or undefined (nothing picked yet). */
  selected: string | undefined
  detail: DetailState | undefined
  filter: Filter
  query: string
  /** Drafts per thread, kept while it is not sent. */
  drafts: Readonly<Record<string, string>>
  /** A takeover in flight, and why the last one failed. */
  sending: string | undefined
  sendError: { key: string; message: string } | undefined
  /** What the sidebar mark shows: a thread at work, or a failure not looked at yet. */
  attention: 'running' | 'failed' | undefined
}

/** A thread that finished while followed (notices.tsx). */
export interface Finished {
  thread: ThreadView
  phase: 'idle' | 'failed'
}

/** After a failed read, wait this long before the next. */
const RETRY_MS = 3_000
/** Failures this recent mark the sidebar until looked at. */
const FRESH_FAILURE_MS = 24 * 60 * 60_000
const SEEN_KEY = 'dsh-agent-hub.relay.seen'
/** Origins a finished thread is announced for: work sent off to run alone (a chat or a terminal is watched where it runs). */
const ANNOUNCED = new Set<ThreadView['origin']>(['glasses', 'cloud', 'cron'])

const readSeen = (): Record<string, number> => {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, number> : {}
  } catch {
    return {}
  }
}

export class RelayStore {
  private snapshot: RelaySnapshot = {
    status: undefined, error: null, pending: new Set(), selected: undefined, detail: undefined,
    filter: 'all', query: '', drafts: {}, sending: undefined, sendError: undefined, attention: undefined,
  }
  private readonly listeners = new Set<() => void>()
  private readonly finished = new Set<(event: Finished) => void>()
  private readonly call: RelayCall
  /** Failures looked at: thread key → the time it failed at. */
  private seen: Record<string, number> = readSeen()

  constructor(call: RelayCall) {
    this.call = call
  }

  getSnapshot = (): RelaySnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Threads that finish while followed; returns the stop. */
  onFinished(listener: (event: Finished) => void): () => void {
    this.finished.add(listener)
    return () => { this.finished.delete(listener) }
  }

  private publish(next: Partial<RelaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  private boot: string | undefined
  private epoch = -1
  /** Pages following the list, and those among them showing the panel. */
  private pollers = 0
  private panels = 0
  private running = false

  /** Whether the panel is on screen (notices stay out of its way). */
  get shown(): boolean {
    return this.panels > 0 && document.visibilityState === 'visible'
  }

  private attention(threads: readonly ThreadView[]): RelaySnapshot['attention'] {
    const now = Date.now()
    if (threads.some((thread) => thread.phase === 'failed' && thread.session === undefined && now - thread.updatedAt < FRESH_FAILURE_MS && this.seen[thread.key] !== thread.updatedAt)) return 'failed'
    return threads.some((thread) => thread.phase === 'running' && thread.session === undefined) ? 'running' : undefined
  }

  private apply(update: RelayUpdate): void {
    if (update.boot === this.boot && update.epoch === this.epoch && this.snapshot.error === null) return
    const before = this.snapshot.status
    const sameRun = update.boot === this.boot
    this.boot = update.boot
    this.epoch = update.epoch
    const threads = update.status.threads
    this.publish({ status: update.status, error: null, attention: this.attention(threads) })
    // What finished since the last read of this host run.
    if (before !== undefined && sameRun) {
      const was = new Map<string, ThreadPhase>(before.threads.map((thread) => [thread.key, thread.phase]))
      for (const thread of threads) {
        if (was.get(thread.key) !== 'running' || (thread.phase !== 'idle' && thread.phase !== 'failed')) continue
        if (thread.session !== undefined || !ANNOUNCED.has(thread.origin)) continue
        for (const listener of this.finished) listener({ thread, phase: thread.phase })
      }
    }
    // The thread on screen moved: read it again.
    const { detail } = this.snapshot
    if (detail?.data !== undefined) {
      const now = threads.find((thread) => thread.key === detail.key)
      if (now !== undefined && (now.updatedAt !== detail.data.thread.updatedAt || now.phase !== detail.data.thread.phase || now.session !== detail.data.thread.session)) void this.load(detail.key)
    }
  }

  /**
   * One long poll at a time while a page is visible: the host answers once
   * something changes (or after a few seconds with nothing new), so an idle
   * page costs one waiting request and a change shows at once.
   */
  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pollers > 0 && document.visibilityState === 'visible') {
        try {
          this.apply(await this.call({ op: 'status', watch: this.panels > 0, ...(this.boot === undefined ? {} : { boot: this.boot, since: this.epoch }) }) as RelayUpdate)
        } catch (error) {
          if (this.snapshot.error !== (error as Error).message) this.publish({ error: (error as Error).message })
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Follow the list while the page is visible (`panel`: the panel itself is shown); returns the stop. */
  poll(panel: boolean): () => void {
    this.pollers++
    if (panel) this.panels++
    void this.run()
    const wake = (): void => { void this.run() }
    document.addEventListener('visibilitychange', wake)
    return () => {
      this.pollers--
      if (panel) this.panels--
      document.removeEventListener('visibilitychange', wake)
    }
  }

  /** Read now, whatever changed or not (a CLI just installed: the host looks again). */
  async refresh(): Promise<void> {
    try {
      const update = await this.call({ op: 'status', watch: this.panels > 0 }) as RelayUpdate
      this.epoch = -1
      this.apply(update)
      const key = this.snapshot.selected
      if (key !== undefined && key !== OVERVIEW) await this.load(key)
    } catch (error) {
      this.publish({ error: (error as Error).message })
    }
  }

  setFilter(filter: Filter): void {
    this.publish({ filter })
  }

  setQuery(query: string): void {
    this.publish({ query })
  }

  setDraft(key: string, text: string): void {
    this.publish({ drafts: { ...this.snapshot.drafts, [key]: text } })
  }

  /** Show a thread (read now), the overview, or nothing (back to the list on a narrow page). */
  select(key: string | undefined): void {
    if (key === this.snapshot.selected) return
    this.publish({ selected: key, ...(key === undefined || key === OVERVIEW ? {} : { detail: this.snapshot.detail?.key === key ? this.snapshot.detail : { key } }) })
    if (key !== undefined && key !== OVERVIEW) {
      this.markSeen(key)
      void this.load(key)
    }
  }

  private markSeen(key: string): void {
    const thread = this.snapshot.status?.threads.find((entry) => entry.key === key)
    if (thread?.phase !== 'failed') return
    const keep = new Set(this.snapshot.status?.threads.map((entry) => entry.key))
    this.seen = Object.fromEntries([...Object.entries(this.seen).filter(([entry]) => keep.has(entry)), [key, thread.updatedAt]])
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(this.seen))
    } catch { /* Private mode: kept for this page. */ }
    this.publish({ attention: this.attention(this.snapshot.status?.threads ?? []) })
  }

  private loading = new Map<string, Promise<void>>()

  private load(key: string): Promise<void> {
    let running = this.loading.get(key)
    if (running !== undefined) return running
    running = (async () => {
      try {
        const data = await this.call({ op: 'thread', key }) as ThreadDetail
        if (this.snapshot.detail?.key === key) this.publish({ detail: { key, data } })
      } catch (error) {
        if (this.snapshot.detail?.key === key) this.publish({ detail: { key, ...(this.snapshot.detail.data === undefined ? {} : { data: this.snapshot.detail.data }), error: (error as Error).message } })
      } finally {
        this.loading.delete(key)
      }
    })()
    this.loading.set(key, running)
    return running
  }

  /** Continue a thread in DSH, sending its draft when there is one; the DSH session it went to. */
  async takeover(key: string, send: boolean): Promise<string | undefined> {
    if (this.snapshot.sending !== undefined) return undefined
    const text = send ? this.snapshot.drafts[key]?.trim() ?? '' : ''
    this.publish({ sending: key, sendError: undefined })
    try {
      const result = await this.call({ op: 'takeover', key, ...(text === '' ? {} : { text }) }) as TakeoverResult
      const drafts = { ...this.snapshot.drafts }
      delete drafts[key]
      this.publish({ drafts })
      return result.session
    } catch (error) {
      this.publish({ sendError: { key, message: (error as Error).message } })
      return undefined
    } finally {
      this.publish({ sending: undefined })
    }
  }

  async terminal(key: string): Promise<void> {
    await this.call({ op: 'terminal', key })
  }

  /** `pending`: Qoder is still opening it; it is listed once open. */
  async cloud(path: string, task: string): Promise<{ id: string; url: string } | { pending: true }> {
    return await this.call({ op: 'cloud', path, task }) as { id: string; url: string } | { pending: true }
  }

  async toggle(path: string, op: 'start' | 'stop' | 'reap'): Promise<void> {
    this.publish({ pending: new Set([...this.snapshot.pending, path]) })
    try {
      this.apply(await this.call({ op, path }) as RelayUpdate)
    } catch (error) {
      this.publish({ error: (error as Error).message })
    } finally {
      const pending = new Set(this.snapshot.pending)
      pending.delete(path)
      this.publish({ pending })
    }
  }
}
