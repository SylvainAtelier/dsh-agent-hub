/** Sentry alerts shown on the board and analysed in repository worktrees. */

export const ALERTS_METHOD = 'agent-hub/alerts'
export const SENTRY_REVIEW_PREFIX = 'sentry-'

export type AlertPeriod = '7d' | '14d'
export type AlertSort = 'lastSeen' | 'age' | 'events'
export type AlertOrder = 'asc' | 'desc'
export type AlertPhase = 'unanalysed' | 'preparing' | 'analysing' | 'analysed' | 'fixing' | 'fixed' | 'regression'

export interface AlertsSettings {
  /** Sentry issues URL carrying organization, project and environment. Blank disables the lane. */
  url: string
  /** Repository main working tree used for analysis and fixes. */
  repo: string
  /** Default analysis bot. */
  bot: string
}

export interface SentryLocation {
  path: string
  line?: number
  function?: string
}

export interface SentryIssue {
  id: string
  title: string
  subtitle?: string
  url?: string
  project?: string
  culprit?: string
  firstSeen?: string
  lastSeen?: string
  /** How coarse `lastSeen` is: the list shows "3 hours ago", so the real time is up to this much earlier. */
  lastSeenSlackMs?: number
  events?: number
  users?: number
  location?: SentryLocation
  raw?: string
  phase?: AlertPhase
  branch?: string
  tree?: string
  session?: string
  bot?: string
  verdict?: string
  analysedLastSeen?: string
  analysedEvents?: number
  fixedHead?: string
  /** Why the last analysis did not start. */
  error?: string
}

export interface SentryIssueDetail extends SentryIssue {
  markdown: string
  analysis?: string
  exception?: string
  traceId?: string
}

export interface AlertsState {
  enabled: boolean
  /** The repository the alerts are analysed in: the board shows them only for it (or all). */
  repo?: string
  issues: SentryIssue[]
  period: AlertPeriod
  sort: AlertSort
  order: AlertOrder
  truncated?: boolean
  refreshedAt: number
  bots: Array<{ id: string; description?: string }>
  defaultBot?: string
  error?: string
}

export type AlertsRequest =
  | { op: 'list'; period?: AlertPeriod; sort?: AlertSort; order?: AlertOrder; force?: boolean }
  | { op: 'detail'; id: string; force?: boolean }
  | { op: 'analyse'; id: string; bot?: string }
  | { op: 'fix'; id: string }
  | { op: 'resolve'; id: string }
  | { op: 'unresolve'; id: string }

export type AlertsReply<T> = { ok: true; value: T } | { ok: false; error: string }

export const isAlertPeriod = (value: unknown): value is AlertPeriod => value === '7d' || value === '14d'
export const isAlertSort = (value: unknown): value is AlertSort => value === 'lastSeen' || value === 'age' || value === 'events'
export const isAlertOrder = (value: unknown): value is AlertOrder => value === 'asc' || value === 'desc'

/** Oldest/fewest first by the field a sort names; issues without it go first. */
export function compareIssues(a: SentryIssue, b: SentryIssue, sort: AlertSort): number {
  if (sort === 'events') return (a.events ?? -1) - (b.events ?? -1)
  const fieldName = sort === 'age' ? 'firstSeen' : 'lastSeen'
  const av = Date.parse(a[fieldName] ?? '')
  const bv = Date.parse(b[fieldName] ?? '')
  return (Number.isNaN(av) ? -1 : av) - (Number.isNaN(bv) ? -1 : bv)
}

/** Lower-case words joined by `-`: how an issue id shows in a branch (`fix/proj-1a3-…`) and in a title. */
const slugOf = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-')

/**
 * The issues a pull request works on: its branch or title names their short ids, whole (`PROJ-1`
 * is not in `proj-12`). One project's id inside another's (`API-1` in `WEB-API-1`) is left to the longer.
 */
export function issuesInPull(pull: { branch: string; title: string }, issues: readonly SentryIssue[]): SentryIssue[] {
  const text = `-${slugOf(pull.branch)}-${slugOf(pull.title)}-`
  const found = issues.filter((issue) => text.includes(`-${slugOf(issue.id)}-`))
  return found.filter((issue) => !found.some((other) => other !== issue && slugOf(other.id).endsWith(`-${slugOf(issue.id)}`)))
}
