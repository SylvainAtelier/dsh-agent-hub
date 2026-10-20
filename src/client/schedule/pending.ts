/** Read-only view of a Session's active official Schedule tasks; the Host stays the only store. */
export interface PendingTask { id: string; title: string; scheduledAt: string; kind: string }
export interface PendingSnapshot { tasks: readonly PendingTask[]; ready: boolean }
type Reply = { ok: true; value: unknown } | { ok: false }
export interface ScheduleRemote {
  schedule?: { list(request: { sessionId: string }): Promise<Reply> }
  $on(event: 'schedule/changed', listener: () => void): () => void
}
export interface PendingHub {
  attach(remote: ScheduleRemote, onReset: (listener: () => void) => () => void): () => void
  subscribe(sessionId: string, listener: () => void): () => void
  snapshot(sessionId: string): PendingSnapshot
}

const EMPTY: PendingSnapshot = { tasks: [], ready: false }

/** Durable records missing a usable id, title or target are not shown rather than guessed. */
export function decodeTasks(value: unknown): PendingTask[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: Record<string, unknown> | null): PendingTask[] => {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.scheduledAt !== 'string'
      || !Number.isFinite(Date.parse(item.scheduledAt))) return []
    const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title
      : typeof item.prompt === 'string' ? item.prompt.trim().split(/\r?\n/, 1)[0] : ''
    return [{ id: item.id, title, scheduledAt: item.scheduledAt, kind: typeof item.kind === 'string' ? item.kind : 'at' }]
  }).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
}

/** One `list` per open Session, refreshed on every committed task change and connection reset. */
export function createPendingHub(): PendingHub {
  let remote: ScheduleRemote | undefined
  let reset: ((listener: () => void) => () => void) | undefined
  const entries = new Map<string, { listeners: Set<() => void>; snapshot: PendingSnapshot; epoch: number; dispose?: () => void }>()
  const publish = (entry: { listeners: Set<() => void> }): void => { for (const listener of entry.listeners) listener() }
  const read = (sessionId: string): void => {
    const entry = entries.get(sessionId)
    const list = remote?.schedule?.list
    if (entry === undefined || list === undefined) return
    const epoch = ++entry.epoch
    void list.call(remote!.schedule, { sessionId }).then((reply) => {
      // A failed refresh keeps the last known tasks visible instead of blinking the hint away.
      if (entry.epoch !== epoch || !reply.ok) return
      entry.snapshot = { tasks: decodeTasks(reply.value), ready: true }
      publish(entry)
    }, () => undefined)
  }
  const connect = (sessionId: string): void => {
    const entry = entries.get(sessionId)
    if (entry === undefined || remote === undefined || reset === undefined) return
    const refresh = (): void => read(sessionId)
    const offChanged = remote.$on('schedule/changed', refresh)
    const offReset = reset(refresh)
    entry.dispose = () => { offChanged(); offReset() }
    refresh()
  }
  return {
    attach(nextRemote, onReset) {
      remote = nextRemote
      reset = onReset
      for (const sessionId of entries.keys()) connect(sessionId)
      return () => {
        remote = undefined
        reset = undefined
        for (const entry of entries.values()) {
          entry.dispose?.()
          entry.dispose = undefined
          entry.epoch++
          entry.snapshot = EMPTY
          publish(entry)
        }
      }
    },
    subscribe(sessionId, listener) {
      let entry = entries.get(sessionId)
      if (entry === undefined) {
        entry = { listeners: new Set(), snapshot: EMPTY, epoch: 0 }
        entries.set(sessionId, entry)
      }
      entry.listeners.add(listener)
      if (entry.listeners.size === 1) connect(sessionId)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size !== 0 || entries.get(sessionId) !== entry) return
        entry.dispose?.()
        entry.epoch++
        entries.delete(sessionId)
      }
    },
    snapshot: (sessionId) => entries.get(sessionId)?.snapshot ?? EMPTY,
  }
}

/** Compact, locale-aware distance to a target; past targets are reported by the caller. */
export function relativeParts(target: number, now: number): { unit: 'minute' | 'hour' | 'day'; value: number } {
  const minutes = Math.max(1, Math.round((target - now) / 60_000))
  if (minutes < 60) return { unit: 'minute', value: minutes }
  const hours = Math.round(minutes / 60)
  return hours < 24 ? { unit: 'hour', value: hours } : { unit: 'day', value: Math.round(hours / 24) }
}
