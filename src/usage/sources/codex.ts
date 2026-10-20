/**
 * Codex (ChatGPT subscription) quota for every account signed in through
 * dsh-codex-subscription.
 *
 * The Codex plugin's own `usage` RPC only reports its active account, so this
 * source reads the plugin's account vault directly — READ-ONLY. Each account's
 * stored access token is used as-is and never refreshed: refresh tokens
 * rotate, and refreshing behind the Codex plugin's back could sign it out.
 * An inactive account whose token has expired reports `expired`; the hub then
 * serves its last good snapshot until the account is used again.
 */

import { getJson, HttpError, isRecord, num, clampPercent, windowKey } from './http.ts'
import type { PlanQuota, QuotaWindow } from '../types.ts'

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** The vault record as dsh-codex-subscription 2.x stores it (version 1). */
interface VaultAccount {
  id: string
  label?: string
  credential: { access: string; expires: number; accountId?: string; email?: string }
}

/** Minimal slice of the host credentials service. */
export interface CredentialRecords {
  readRecord(key: unknown): Promise<{ kind: string; key?: string; payload?: unknown } | undefined>
  resolve(ref: unknown): Promise<{ value: string } | undefined>
}

/** Validate the vault payload; undefined when its shape is not one we know. */
export function parseVault(record: { kind: string; payload?: unknown } | undefined): { activeId: string; accounts: VaultAccount[] } | undefined {
  if (record?.kind !== 'grant' || !isRecord(record.payload) || record.payload.version !== 1) return undefined
  const { activeId, accounts } = record.payload
  if (typeof activeId !== 'string' || !Array.isArray(accounts)) return undefined
  const valid = accounts.filter((account): account is VaultAccount =>
    isRecord(account) && typeof account.id === 'string'
    && isRecord(account.credential) && typeof account.credential.access === 'string'
    && typeof account.credential.expires === 'number')
  return valid.length === accounts.length ? { activeId, accounts: valid } : undefined
}

function windowOf(value: unknown, group?: string): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const used = num(value.used_percent)
  if (used === undefined) return undefined
  const seconds = num(value.limit_window_seconds)
  const resetAt = num(value.reset_at)
  const windowMs = seconds === undefined ? undefined : seconds * 1000
  return {
    key: windowKey(windowMs),
    ...(group === undefined ? {} : { group }),
    usedPercent: clampPercent(used),
    ...(resetAt ? { resetsAt: resetAt * 1000 } : {}),
    ...(windowMs === undefined ? {} : { windowMs }),
  }
}

function windowsOf(limit: unknown, group?: string): QuotaWindow[] {
  if (!isRecord(limit)) return []
  return [windowOf(limit.primary_window, group), windowOf(limit.secondary_window, group)]
    .filter((window): window is QuotaWindow => window !== undefined)
}

/** Reduce a `wham/usage` response to plan, windows, and credits. */
export function parseCodexUsage(body: unknown): Pick<PlanQuota, 'plan' | 'windows' | 'credits'> {
  if (!isRecord(body)) throw new Error('malformed usage response')
  const windows = windowsOf(body.rate_limit)
  for (const extra of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
    if (!isRecord(extra)) continue
    const name = typeof extra.limit_name === 'string' && extra.limit_name !== '' ? extra.limit_name : String(extra.metered_feature ?? '')
    windows.push(...windowsOf(extra.rate_limit, name || 'extra'))
  }
  windows.push(...windowsOf(body.code_review_rate_limit, 'Code review'))
  const credits = isRecord(body.credits) && body.credits.has_credits === true
    ? (body.credits.unlimited === true ? '∞' : typeof body.credits.balance === 'string' ? body.credits.balance : undefined)
    : undefined
  return {
    ...(typeof body.plan_type === 'string' ? { plan: body.plan_type } : {}),
    windows,
    ...(credits === undefined ? {} : { credits }),
  }
}

/** Grace before the stored expiry; mirrors the Codex plugin's own skew. */
const EXPIRY_SKEW_MS = 60_000

export async function readCodex(credentials: CredentialRecords, vaultKey: unknown, now = Date.now, activeOnly = false): Promise<PlanQuota[]> {
  // A vault read failure is not evidence that the user signed out.
  const record = await credentials.readRecord(vaultKey)
  if (record === undefined) {
    return [{ id: 'codex', provider: 'codex', windows: [], fetchedAt: 0, error: { code: 'not-signed-in' } }]
  }
  const vault = parseVault(record)
  if (vault === undefined) {
    return [{ id: 'codex', provider: 'codex', windows: [], fetchedAt: 0, error: { code: 'incompatible', scope: 'source' } }]
  }
  const result = await Promise.all(vault.accounts.filter((account) => !activeOnly || account.id === vault.activeId).map(async (account): Promise<PlanQuota> => {
    const base = {
      id: `codex:${account.id}`,
      provider: 'codex' as const,
      account: account.credential.email ?? account.label,
      active: account.id === vault.activeId,
      windows: [],
      fetchedAt: 0,
    }
    if (account.credential.expires - EXPIRY_SKEW_MS <= now()) return { ...base, error: { code: 'expired' } }
    try {
      const body = await getJson(CODEX_USAGE_URL, {
        authorization: `Bearer ${account.credential.access}`,
        ...(account.credential.accountId ? { 'chatgpt-account-id': account.credential.accountId } : {}),
        'user-agent': 'dsh-agent-hub',
      })
      return { ...base, ...parseCodexUsage(body), fetchedAt: now() }
    } catch (error) {
      const expired = error instanceof HttpError && (error.status === 401 || error.status === 403)
      return { ...base, error: expired ? { code: 'expired' } : { code: 'failed', message: (error as Error).message } }
    }
  }))
  if (!activeOnly) return result
  // The selected vault entry may change while the usage request is in flight.
  const latest = parseVault(await credentials.readRecord(vaultKey))
  return result.map((item) => ({ ...item, active: latest !== undefined && item.id === `codex:${latest.activeId}` }))
}
