/**
 * MiniMax Coding Plan quota over the API key the harness already uses for
 * the `minimax-cn` / `minimax` routes. The key is resolved through the host
 * credentials service and never leaves the host.
 *
 * `coding_plan/remains` field semantics (easy to misread):
 * - `current_interval_usage_count` is the REMAINING count, not the used one.
 * - `remains_time` is the subscription's remaining time, unrelated to the 5h window.
 */

import { createHash } from 'node:crypto'
import { clampPercent, DAY, getJson, HOUR, HttpError, isRecord, num, windowKey } from './http.ts'
import type { CredentialRecords } from './codex.ts'
import type { PlanQuota, QuotaWindow } from '../types.ts'

interface Route {
  id: string
  host: string
  env: string
}

const ROUTES: readonly Route[] = [
  { id: 'minimax-cn', host: 'api.minimaxi.com', env: 'MINIMAX_CN_API_KEY' },
  { id: 'minimax', host: 'api.minimax.io', env: 'MINIMAX_API_KEY' },
]

/** The runtime helpers that build credential addresses (from @deepseek-ai/dsh-credentials). */
export interface CredentialAddressing {
  credentialKey(owner: string, id: string): unknown
  credentialRef(name: string): unknown
}

async function resolveKey(credentials: CredentialRecords, addressing: CredentialAddressing, route: Route): Promise<string | undefined> {
  try {
    const record = await credentials.readRecord(addressing.credentialKey('llm-pi-ai', route.id))
    if (record?.kind === 'api-key' && record.key) return record.key
  } catch {
    // Invalid record ids read as absent.
  }
  try {
    const resolved = await credentials.resolve(addressing.credentialRef(route.env))
    if (resolved?.value) return resolved.value
  } catch {
    // Unresolvable references read as absent.
  }
  return undefined
}

/** The first MiniMax API key DSH keeps (the China route first), with its API host; the device's speech recognition uses it. */
export async function minimaxKey(credentials: CredentialRecords, addressing: CredentialAddressing): Promise<{ key?: string; host?: string }> {
  for (const route of ROUTES) {
    const key = await resolveKey(credentials, addressing, route)
    if (key !== undefined) return { key, host: route.host }
  }
  return {}
}

/**
 * Subscription remaining time → epoch ms of expiry. Sources disagree on the
 * unit, so it is inferred: a month in seconds is ~2.6e6, in ms ~2.6e9. A
 * value that merely restates the 5h window's end is not a subscription term.
 */
export function subscriptionExpiry(remains: number | undefined, windowEnd: number | undefined, now: number): number | undefined {
  if (remains === undefined || remains <= 0) return undefined
  const restatesWindow = windowEnd !== undefined
    && [remains, remains * 1000].some((ms) => Math.abs(now + ms - windowEnd) < 5 * 60_000)
  if (restatesWindow) return undefined
  const ms = remains < 1e8 ? remains * 1000 : remains
  if (ms < DAY) return undefined
  return now + ms
}

function countWindow(row: Record<string, unknown>, prefix: 'current_interval' | 'current_weekly', start: unknown, end: unknown, fallbackMs: number): QuotaWindow | undefined {
  const limit = num(row[`${prefix}_total_count`])
  const remaining = num(row[`${prefix}_usage_count`])
  const remainingPercent = num(row[`${prefix}_remaining_percent`])
  const used = limit !== undefined && remaining !== undefined ? Math.max(0, limit - remaining) : undefined
  const usedPercent = remainingPercent !== undefined
    ? 100 - remainingPercent
    : used !== undefined && limit ? (used / limit) * 100 : undefined
  if (usedPercent === undefined) return undefined
  const startMs = num(start)
  const endMs = num(end)
  const windowMs = startMs !== undefined && endMs !== undefined && endMs > startMs ? endMs - startMs : fallbackMs
  return {
    key: windowKey(windowMs) === 'custom' ? windowKey(fallbackMs) : windowKey(windowMs),
    usedPercent: clampPercent(usedPercent),
    ...(endMs ? { resetsAt: endMs } : {}),
    windowMs,
    ...(used !== undefined && limit ? { used, limit } : {}),
  }
}

/** Reduce a `coding_plan/remains` response to windows and subscription expiry. */
export function parseRemains(body: unknown, now: number, model?: string): Pick<PlanQuota, 'windows' | 'expiresAt'> {
  if (!isRecord(body)) throw new Error('malformed remains response')
  const base = body.base_resp
  if (isRecord(base) && num(base.status_code) !== 0 && base.status_code !== undefined) {
    throw new Error(typeof base.status_msg === 'string' ? base.status_msg : `status ${String(base.status_code)}`)
  }
  const rows = Array.isArray(body.model_remains) ? body.model_remains.filter(isRecord) : []
  // `general` is the plan-wide entry; older plans carry one model row only.
  const row = rows.find((entry) => entry.model_name === 'general')
    ?? (model !== undefined && rows.length > 1
      ? rows.find((entry) => typeof entry.model_name === 'string' && entry.model_name.toLowerCase() === model.toLowerCase())
      : rows[0])
  if (row === undefined) throw new Error('no plan in remains response')
  const windows = [countWindow(row, 'current_interval', row.start_time, row.end_time, 5 * HOUR)]
  if (num(row.current_weekly_status) === 1 || row.current_weekly_total_count !== undefined) {
    windows.push(countWindow(row, 'current_weekly', row.weekly_start_time, row.weekly_end_time, 7 * DAY))
  }
  const expiresAt = subscriptionExpiry(num(row.remains_time), num(row.end_time), now)
  return {
    windows: windows.filter((window): window is QuotaWindow => window !== undefined),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

export async function readMinimax(credentials: CredentialRecords, addressing: CredentialAddressing, now = Date.now, routeId?: string, model?: string): Promise<PlanQuota[]> {
  const quotas: PlanQuota[] = []
  for (const route of ROUTES) {
    if (routeId !== undefined && route.id !== routeId) continue
    const key = await resolveKey(credentials, addressing, route)
    if (key === undefined) continue
    // Two configured routes are two accounts; one route keeps the plain id.
    const base = route.id === 'minimax-cn'
      ? { id: 'minimax', provider: 'minimax' as const, windows: [], fetchedAt: 0 }
      : { id: `minimax:${route.id}`, provider: 'minimax' as const, account: 'minimax.io', windows: [], fetchedAt: 0 }
    try {
      const body = await getJson(`https://${route.host}/v1/api/openplatform/coding_plan/remains`, { authorization: `Bearer ${key}` })
      const changed = routeId !== undefined && await resolveKey(credentials, addressing, route) !== key
      quotas.push({ ...base, ...parseRemains(body, now(), model), fetchedAt: now(),
        ...(routeId === undefined ? {} : { identity: createHash('sha256').update(`minimax:${key}`).digest('hex') }),
        ...(changed ? { stale: true } : {}),
      })
    } catch (error) {
      const denied = error instanceof HttpError && (error.status === 401 || error.status === 403)
      quotas.push({ ...base, error: denied ? { code: 'no-credential' } : { code: 'failed', message: (error as Error).message } })
    }
  }
  return quotas.length > 0 ? quotas : [{ id: 'minimax', provider: 'minimax', windows: [], fetchedAt: 0, error: { code: 'no-credential' } }]
}
