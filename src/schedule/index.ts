/** A thin authenticated bridge to the official Schedule service; no second task store or timer. */
import { effectiveRoute, resetSuggestion, sameRoute, sameSuggestion } from './reset.ts'
import type { AgentProfile } from '../team/profiles.ts'
import type { UsageOverview } from '../usage/types.ts'
import type { ResetSuggestion, Route, ScheduledSend, ScheduleOptions, ScheduleReply, ScheduleRequest } from './types.ts'

export interface NativeSchedule {
  create(sessionId: string, request: { title: string; prompt: string; at: string }): Promise<{ id: string; scheduledAt: string; title: string }>
}
export interface ScheduleHost {
  schedule(): NativeSchedule | undefined
  /** Cold-safe existence and model lookup. Reject archived and subagent Sessions, without resuming them. */
  selection(sessionId: string): Promise<Route | undefined>
  overview(route: Route): Promise<UsageOverview>
  profiles(): readonly AgentProfile[]
  defaultRoute(): Route | undefined
  now?(): number
}

const validRoute = (value: unknown): value is Route => value !== null && typeof value === 'object'
  && typeof (value as Route).provider === 'string' && typeof (value as Route).model === 'string'
const failure = (code: Extract<ScheduleReply<never>, { ok: false }>['code']): ScheduleReply<never> => ({ ok: false, code })

/** Title generation is deterministic and never spends a model call. */
export function scheduleTitle(prompt: string): string {
  return prompt.trim().split(/\r?\n/, 1)[0].trim().slice(0, 120)
}

export function createScheduledSend(host: ScheduleHost): (payload: Record<string, unknown>) => Promise<ScheduleReply<ScheduleOptions | ScheduledSend>> {
  // Retry identity is transient and bounded; the official task remains the sole durable entity.
  const attempts = new Map<string, { input: string; promise: Promise<ScheduleReply<ScheduledSend>>; settled: boolean }>()
  const now = host.now ?? Date.now
  const options = async (sessionId: string, includeQuota = true): Promise<ScheduleOptions> => {
    const available = typeof host.schedule()?.create === 'function'
    if (!available) return { available: false }
    const route = await host.selection(sessionId)
    const effective = route === undefined ? undefined : effectiveRoute(route, host.profiles(), host.defaultRoute())
    const base = { available, ...(route === undefined ? {} : { route }), ...(effective === undefined ? {} : { effectiveRoute: effective }) }
    if (!includeQuota) return base
    let overview: UsageOverview | undefined
    try { overview = effective === undefined ? undefined : await host.overview(effective) } catch {
      return { ...base, reason: 'stale' }
    }
    return { ...base, ...resetSuggestion(effective, overview?.quotas ?? [], now()) }
  }
  const create = async (request: Extract<ScheduleRequest, { op: 'create' }>): Promise<ScheduleReply<ScheduledSend>> => {
    const schedule = host.schedule()
    if (typeof schedule?.create !== 'function') return failure('unavailable')
    let current: Route | undefined
    try { current = await host.selection(request.sessionId) } catch { return failure('session-unavailable') }
    if (!sameRoute(current, request.expectedRoute)) return failure('changed')
    const effective = current === undefined ? undefined : effectiveRoute(current, host.profiles(), host.defaultRoute())
    if (!sameRoute(effective, request.expectedEffectiveRoute)) return failure('changed')
    if (request.suggestion !== undefined) {
      let latest: ScheduleOptions
      try { latest = await options(request.sessionId) } catch { return failure('changed') }
      if (!sameRoute(latest.route, request.expectedRoute) || !sameSuggestion(latest.suggestion, request.suggestion)
        || request.at !== latest.suggestion?.at) return failure('changed')
    }
    // Model picks, bot edits and archiving may race quota I/O. Re-read before native admission.
    try { current = await host.selection(request.sessionId) } catch { return failure('session-unavailable') }
    if (!sameRoute(current, request.expectedRoute)
      || !sameRoute(effective, current === undefined ? undefined : effectiveRoute(current, host.profiles(), host.defaultRoute()))) return failure('changed')
    // Never silently turn an expired target into an immediate send.
    if (Date.parse(request.at) <= now()) return failure('not-future')
    try {
      const result = await schedule.create(request.sessionId, { title: scheduleTitle(request.prompt), prompt: request.prompt.trim(), at: request.at })
      return { ok: true, value: { id: result.id, sessionId: request.sessionId, title: result.title, scheduledAt: result.scheduledAt } }
    } catch {
      // A write may have committed before a failed response. Never retry this automatically.
      return failure('create-uncertain')
    }
  }
  return async (payload) => {
    if (typeof payload.sessionId !== 'string' || payload.sessionId.trim() === '' || payload.sessionId.length > 512) return failure('invalid-request')
    if (payload.op === 'options') {
      try { return { ok: true, value: await options(payload.sessionId, payload.quota !== false) } } catch { return failure('session-unavailable') }
    }
    if (payload.op === 'result') {
      if (typeof payload.requestId !== 'string') return failure('invalid-request')
      // Reconcile the exact attempt; awaiting it never starts another native write.
      return attempts.get(`${payload.sessionId}:${payload.requestId}`)?.promise ?? failure('request-missing')
    }
    if (payload.op !== 'create' || typeof payload.prompt !== 'string' || payload.prompt.trim() === '' || payload.prompt.length > 100_000
      || payload.prompt.trimStart().startsWith('/') || typeof payload.requestId !== 'string' || !/^[\w-]{8,128}$/.test(payload.requestId)
      || typeof payload.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(payload.at)
      || !Number.isFinite(Date.parse(payload.at)) || new Date(payload.at).toISOString() !== payload.at
      || (payload.expectedRoute !== undefined && !validRoute(payload.expectedRoute))
      || (payload.expectedEffectiveRoute !== undefined && !validRoute(payload.expectedEffectiveRoute))) return failure('invalid-request')
    if (payload.suggestion !== undefined) {
      const suggestion = payload.suggestion as ResetSuggestion | null
      if (suggestion === null || typeof suggestion !== 'object' || typeof suggestion.at !== 'string' || typeof suggestion.quotaId !== 'string'
        || !Array.isArray(suggestion.windows) || !suggestion.windows.every((item) => typeof item === 'string')) return failure('invalid-request')
    }
    const key = `${payload.sessionId}:${payload.requestId}`
    const input = JSON.stringify([payload.prompt, payload.at, payload.expectedRoute, payload.expectedEffectiveRoute, payload.suggestion])
    const existing = attempts.get(key)
    if (existing !== undefined) return existing.input === input ? existing.promise : failure('invalid-request')
    if (Date.parse(payload.at) <= now()) return failure('not-future')
    if (attempts.size >= 128) {
      const oldest = [...attempts].find(([, attempt]) => attempt.settled)?.[0]
      if (oldest === undefined) return failure('invalid-request')
      attempts.delete(oldest)
    }
    const entry = { input, promise: create(payload as unknown as Extract<ScheduleRequest, { op: 'create' }>).catch(() => failure('create-uncertain')), settled: false }
    attempts.set(key, entry)
    void entry.promise.finally(() => { entry.settled = true })
    return entry.promise
  }
}
