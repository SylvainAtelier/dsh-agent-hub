/**
 * A value read on demand and kept for a while: stale-while-revalidate with one
 * read in flight at a time. Before the first read, and when asked for a fresh
 * one, callers wait for it; afterwards a stale value is served at once while a
 * background read replaces it. A read that throws keeps the last value (and
 * rethrows to whoever waited on it); one that should be remembered as a
 * failure resolves to a value that says so. `stale`: a value to serve until the first read, which
 * then runs in the background (a list asked for slightly different things keeps showing its last).
 */

export interface Cached<T> {
  get(fresh?: boolean): Promise<T>
  /** The last value read, and when; undefined before the first. */
  peek(): { at: number; value: T } | undefined
  /** Forget the value; a read in flight no longer counts. */
  invalidate(): void
}

export function cached<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now, stale?: T): Cached<T> {
  let last: { at: number; value: T } | undefined = stale === undefined ? undefined : { at: now() - ttlMs, value: stale }
  let inflight: Promise<T> | undefined
  let generation = 0
  const refresh = (): Promise<T> => {
    if (inflight !== undefined) return inflight
    const own = generation
    const read = load().then((value) => {
      if (own === generation) last = { at: now(), value }
      return value
    }).finally(() => {
      if (inflight === read) inflight = undefined
    })
    inflight = read
    return read
  }
  return {
    get(fresh = false) {
      if (last === undefined || fresh) return refresh()
      if (now() - last.at >= ttlMs) void refresh().catch(() => {})
      return Promise.resolve(last.value)
    },
    peek: () => last,
    invalidate() {
      generation++
      last = undefined
      inflight = undefined
    },
  }
}
