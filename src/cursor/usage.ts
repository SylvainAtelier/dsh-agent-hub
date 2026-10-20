/**
 * Cursor usage, read from Cursor's own dashboard service with the CLI's
 * signed-in token — the same calls the CLI's `/usage` makes. Read-only: the
 * token is never refreshed or stored (the CLI owns its login), and a token the
 * service rejects reads as signed out until the CLI is used again.
 *
 * - The plan: included usage this billing cycle (total, Auto, API) and the
 *   on-demand spend, computed as the CLI computes it.
 * - A conversation's usage events: every model call of an ACP session is one
 *   event naming that session as `conversationId`, with its tokens and cost.
 *   They arrive a second or two after the turn ends.
 */

import { accessToken } from './cli.ts'
import { clampPercent, HttpError, isRecord, num } from '../usage/sources/http.ts'
import type { PlanQuota, QuotaWindow, Spend } from '../usage/types.ts'

const BASE = 'https://api2.cursor.sh/aiserver.v1.DashboardService/'

export type Call = (method: string, body: object) => Promise<unknown>

/** A Connect unary call in its JSON form. */
export function dashboard(token: () => Promise<string | undefined> = () => accessToken()): Call {
  return async (method, body) => {
    const bearer = await token()
    if (bearer === undefined) throw new HttpError(401)
    const response = await fetch(BASE + method, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new HttpError(response.status)
    return response.json()
  }
}

const cents = (value: unknown): number | undefined => {
  const n = num(value)
  return n === undefined ? undefined : n / 100
}

/** The on-demand spend line, as the CLI's `/usage` decides it. */
export function onDemand(current: Record<string, unknown>, hard: Record<string, unknown> | undefined): Spend | undefined {
  const limits = isRecord(current.spendLimitUsage) ? current.spendLimitUsage : undefined
  const used = cents(limits?.individualUsed) ?? 0
  const individual = num(limits?.individualLimit)
  const own = individual === undefined ? undefined : individual > 0 ? { used, limit: individual / 100 } : { used, disabled: true }
  const hardLimit = num(hard?.hardLimit)
  const blocked = hard?.noUsageBasedAllowed === true
  if (limits?.limitType === 'team') {
    if (own !== undefined) return own
    if (hard !== undefined) return blocked || (hardLimit ?? 0) <= 0 ? { used, disabled: true } : { used }
    return (num(limits.pooledLimit) ?? 0) > 0 ? { used } : undefined
  }
  if (hard === undefined) return own
  if (blocked) return { used, disabled: true }
  if (hardLimit === undefined || hardLimit <= 0) return { used, disabled: true }
  return hardLimit >= 2_147_483_647 ? { used } : { used, limit: hardLimit }
}

/** The plan as one quota card: the cycle's included usage first, its Auto and API pools under it. */
export function planQuota(current: unknown, plan: unknown, hard: unknown, now = Date.now()): PlanQuota {
  if (!isRecord(current)) return { id: 'cursor', provider: 'cursor', windows: [], fetchedAt: now, error: { code: 'incompatible' } }
  const info = isRecord(plan) && isRecord(plan.planInfo) ? plan.planInfo : undefined
  const start = num(current.billingCycleStart)
  const end = num(current.billingCycleEnd) ?? num(info?.billingCycleEnd)
  const cycle = start !== undefined && end !== undefined && end > start ? { resetsAt: end, windowMs: end - start } : end === undefined ? {} : { resetsAt: end }
  const usage = isRecord(current.planUsage) ? current.planUsage : undefined
  const windows: QuotaWindow[] = []
  if (usage !== undefined) {
    const limit = num(usage.limit) ?? 0
    const total = num(usage.totalPercentUsed) ?? (limit > 0 ? ((num(usage.includedSpend) ?? 0) / limit) * 100 : 0)
    windows.push({ key: 'month', usedPercent: clampPercent(total), ...cycle })
    for (const [label, field] of [['Auto', 'autoPercentUsed'], ['API', 'apiPercentUsed']] as const) {
      const used = num(usage[field])
      if (used !== undefined) windows.push({ key: 'month', label, group: 'Included', usedPercent: clampPercent(used), ...cycle })
    }
  }
  const spend = onDemand(current, isRecord(hard) ? hard : undefined)
  const name = typeof info?.planName === 'string' && info.planName !== '' ? info.planName : undefined
  return {
    id: 'cursor',
    provider: 'cursor',
    ...(name === undefined ? {} : { plan: name }),
    windows,
    ...(spend === undefined ? {} : { spend }),
    fetchedAt: now,
    ...(usage === undefined && spend === undefined ? { error: { code: 'incompatible' as const, message: 'this plan reports no usage to the CLI' } } : {}),
  }
}

/** One account read: plan usage, plan name and hard limit (the last two optional, as in the CLI). */
export async function readPlan(call: Call = dashboard()): Promise<PlanQuota> {
  const optional = (method: string): Promise<unknown> => call(method, {}).catch(() => undefined)
  const [current, plan, hard] = await Promise.all([call('GetCurrentPeriodUsage', {}), optional('GetPlanInfo'), optional('GetHardLimit')])
  return planQuota(current, plan, hard)
}

/** One conversation's usage since a moment, summed. */
export interface TurnUsage {
  /** Timestamp of the newest event counted; the next read starts after it. */
  through: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Charged cents, Cursor's token fee included. */
  cents: number
  /** The same counts per model, as Cursor names them (`claude-opus-5-5-high`, `composer-2.5-fast`). */
  byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
}

interface UsageEvent {
  timestamp?: unknown
  model?: unknown
  conversationId?: unknown
  chargedCents?: unknown
  tokenUsage?: { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; totalCents?: unknown }
}

/** Sum a conversation's events newer than `after`; undefined when there is none. */
export function sumEvents(events: readonly unknown[], conversation: string, after: number): TurnUsage | undefined {
  let usage: TurnUsage | undefined
  for (const raw of events) {
    if (!isRecord(raw)) continue
    const event = raw as UsageEvent
    const at = num(event.timestamp)
    if (event.conversationId !== conversation || at === undefined || at <= after) continue
    const tokens = event.tokenUsage ?? {}
    const counts = { input: num(tokens.inputTokens) ?? 0, output: num(tokens.outputTokens) ?? 0, cacheRead: num(tokens.cacheReadTokens) ?? 0, cacheWrite: num(tokens.cacheWriteTokens) ?? 0 }
    usage ??= { through: after, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cents: 0, byModel: {} }
    usage.through = Math.max(usage.through, at)
    const model = typeof event.model === 'string' && event.model !== '' ? event.model : 'unknown'
    const row = usage.byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      usage[key] += counts[key]
      row[key] += counts[key]
    }
    usage.cents += num(event.chargedCents) ?? num(tokens.totalCents) ?? 0
  }
  return usage
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    resolve()
  }, { once: true })
})

/**
 * A conversation's usage after event time `after`, waiting up to `budgetMs`
 * for the service to record it; `from` (local time) bounds the search, the
 * conversation's start when nothing was counted yet. Events that arrive later
 * are not lost: the next turn reads from the same `after`.
 */
export async function conversationUsage(conversation: string, after: number, from: number, options: { call?: Call; budgetMs?: number; stepMs?: number; signal?: AbortSignal; now?: () => number } = {}): Promise<TurnUsage | undefined> {
  const call = options.call ?? dashboard()
  const now = options.now ?? Date.now
  const deadline = now() + (options.budgetMs ?? 6_000)
  const step = options.stepMs ?? 1_200
  // Events are bucketed by the service's clock; a little slack on both ends.
  const startDate = String(Math.max(0, (after > 0 ? Math.min(after, from) : from) - 120_000))
  for (;;) {
    await sleep(step, options.signal)
    if (options.signal?.aborted) return undefined
    try {
      const result = await call('GetFilteredUsageEvents', { startDate, endDate: String(now() + 120_000), page: 1, pageSize: 100 })
      const events = isRecord(result) && Array.isArray(result.usageEventsDisplay) ? result.usageEventsDisplay : []
      const usage = sumEvents(events, conversation, after)
      if (usage !== undefined) return usage
    } catch {
      return undefined
    }
    if (now() + step > deadline) return undefined
  }
}
