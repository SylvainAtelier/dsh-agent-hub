/**
 * The overview feed every surface shares: one poll loop that runs only while
 * something is subscribed and the page is visible. The host's per-source TTL
 * decides how often providers are actually hit.
 */

import type { ProviderId, UsageOverview } from '../../usage/types.ts'

export interface FeedState {
  overview: UsageOverview | null
  error: string | null
  loading: boolean
}

export interface Feed {
  subscribe(listener: () => void): () => void
  getSnapshot(): FeedState
  refresh(): void
  /** One provider's accounts changed elsewhere: drop its host cache, then refresh. */
  reload(provider: ProviderId): void
}

const POLL_MS = 60_000

export function createFeed(call: (force: boolean, invalidate?: ProviderId) => Promise<UsageOverview>): Feed {
  let state: FeedState = { overview: null, error: null, loading: true }
  const listeners = new Set<() => void>()
  let inFlight = false
  let forced = false
  let pendingForce = false
  let pendingInvalidate: ProviderId | undefined
  let lastAt = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const set = (next: Partial<FeedState>): void => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  const load = (force: boolean, invalidate?: ProviderId): void => {
    if (inFlight) {
      // Queue one forced rerun; an invalidation must survive it, since the in-flight result may predate the change.
      if (force && !forced) pendingForce = true
      if (invalidate !== undefined) {
        pendingForce = true
        pendingInvalidate = invalidate
      }
      return
    }
    inFlight = true
    forced = force
    pendingForce = false
    pendingInvalidate = undefined
    // A background poll refreshes quietly; only a first load or a forced refresh shows progress.
    if (force || state.overview === null) set({ loading: true })
    void Promise.resolve().then(() => call(force, invalidate)).then(
      (overview) => set({ overview, error: null, loading: false }),
      (error: unknown) => set({ error: error instanceof Error ? error.message : String(error), loading: false }),
    ).finally(() => {
      inFlight = false
      lastAt = Date.now()
      if (pendingForce && listeners.size > 0 && document.visibilityState === 'visible') load(true, pendingInvalidate)
    })
  }

  const tick = (): void => {
    if (document.visibilityState === 'visible' && (pendingForce || state.overview === null || Date.now() - lastAt >= POLL_MS - 1000)) load(pendingForce, pendingInvalidate)
  }

  const start = (): void => {
    tick()
    timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
  }

  const stop = (): void => {
    pendingForce = false
    pendingInvalidate = undefined
    clearInterval(timer)
    timer = undefined
    document.removeEventListener('visibilitychange', tick)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    getSnapshot: () => state,
    refresh: () => load(true),
    reload: (provider) => load(true, provider),
  }
}
