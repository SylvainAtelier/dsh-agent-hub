/**
 * What the left sidebar's workspace rows say about their sessions: how many there are, and
 * whether one is waiting on the person, running, or finished unseen. DSH shows those states on
 * session rows only, which a folded workspace hides; a hidden slot component (which has the
 * framework's session hooks) feeds this store, and the sidebar layer reads it.
 */

/** A row's state, most urgent first: DSH's StateDot states. */
export type ActivityState = 'warning' | 'ongoing' | 'done'
const RANK: Record<ActivityState, number> = { warning: 3, ongoing: 2, done: 1 }

export interface Tally {
  sessions: number
  state?: ActivityState
}

export interface SessionSummary {
  id?: string
  origin?: string
  blank?: boolean
  running?: boolean
  retainedBy?: { mainView?: number }
}

export interface SessionStatus {
  running?: boolean
  completionUnread?: boolean
  pendingInteraction?: { kind?: string }
}

export interface WorkspaceItem {
  workspaceId: string
  /** The workspace's folder. */
  path?: string
  sessionIds: readonly string[]
}

export interface ActivityInput {
  sessions?: { byId: Record<string, SessionSummary | undefined> }
  statuses?: ReadonlyMap<string, SessionStatus | undefined>
}

const PENDING = new Set(['approval', 'plan-review', 'question'])

export function stateOf(summary: SessionSummary, status: SessionStatus | undefined): ActivityState | undefined {
  if (PENDING.has(status?.pendingInteraction?.kind ?? '')) return 'warning'
  if (status?.running ?? summary.running) return 'ongoing'
  if (status?.completionUnread === true) return 'done'
  return undefined
}

export function merge(a: Tally, b: Tally): Tally {
  const state = (b.state === undefined || (a.state !== undefined && RANK[a.state] >= RANK[b.state])) ? a.state : b.state
  return { sessions: a.sessions + b.sessions, ...(state === undefined ? {} : { state }) }
}

/** Each workspace's sessions as DSH lists them: no subagents, no archived ones, no blank one but the one on screen. */
export function tally(workspaces: readonly WorkspaceItem[], input: ActivityInput, archived: ReadonlySet<string> = new Set()): Map<string, Tally> {
  const byId = input.sessions?.byId ?? {}
  const current = Object.entries(byId).find(([, summary]) => (summary?.retainedBy?.mainView ?? 0) > 0)?.[0]
  const out = new Map<string, Tally>()
  for (const workspace of workspaces) {
    let total: Tally = { sessions: 0 }
    for (const id of workspace.sessionIds) {
      const summary = byId[id]
      if (summary === undefined || summary.origin === 'subagent' || archived.has(id) || (summary.blank === true && id !== current)) continue
      const state = stateOf(summary, input.statuses?.get(id))
      total = merge(total, { sessions: 1, ...(state === undefined ? {} : { state }) })
    }
    out.set(workspace.workspaceId, total)
  }
  return out
}

export interface ActivityStore {
  get(): ActivityInput
  set(next: ActivityInput): void
  subscribe(listener: () => void): () => void
}

export function createActivity(): ActivityStore {
  let value: ActivityInput = {}
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      if (next.sessions === value.sessions && next.statuses === value.statuses) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
