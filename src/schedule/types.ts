/** Scheduled-send wire values; the official Schedule service owns every persisted task. */
export const SCHEDULE_METHOD = 'agent-hub/schedule'

export interface Route { provider: string; model: string }
export type SuggestionReason = 'unsupported-route' | 'no-account' | 'stale' | 'expired-plan' | 'unknown-window' | 'no-reset'
export interface ResetSuggestion {
  at: string
  resetAt: string
  kind: 'recovery' | 'reset'
  quotaId: string
  identity?: string
  account?: string
  windows: string[]
}
export interface ScheduleOptions {
  available: boolean
  route?: Route
  effectiveRoute?: Route
  suggestion?: ResetSuggestion
  reason?: SuggestionReason
}
export type ScheduleRequest =
  | { op: 'options'; sessionId: string; quota?: boolean }
  | { op: 'result'; sessionId: string; requestId: string }
  | { op: 'create'; sessionId: string; requestId: string; prompt: string; at: string; expectedRoute?: Route; expectedEffectiveRoute?: Route; suggestion?: ResetSuggestion }

export type ScheduleErrorCode = 'unavailable' | 'invalid-request' | 'session-unavailable' | 'not-future' | 'changed' | 'create-uncertain' | 'request-missing'
export type ScheduleReply<T> = { ok: true; value: T } | { ok: false; code: ScheduleErrorCode }
export interface ScheduledSend { id: string; sessionId: string; title: string; scheduledAt: string }
