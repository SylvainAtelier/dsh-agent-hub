/** Conservative, deterministic reset hints: never infer a subscription from a model name. */
import type { PlanQuota, QuotaWindow } from '../usage/types.ts'
import type { AgentProfile } from '../team/profiles.ts'
import { BOT_ROUTE } from '../team/types.ts'
import type { ResetSuggestion, Route, SuggestionReason } from './types.ts'

const BUFFER_MS = 60_000
const MAX_AGE_MS = 6 * 60_000

/** Resolve bot aliases exactly as the bot adapter does; cycles and removed bots have no hint. */
export function effectiveRoute(route: Route, profiles: readonly AgentProfile[], fallback?: Route): Route | undefined {
  if (route.provider !== BOT_ROUTE) return route
  const bot = profiles.find((item) => item.id === route.model)
  if (bot === undefined) return undefined
  const next = bot.provider && bot.model ? { provider: bot.provider, model: bot.model } : fallback
  // The bot adapter deliberately rejects bot-to-bot routes.
  return next?.provider === BOT_ROUTE ? undefined : next
}

/** Display groups are not model metadata: only known, unambiguous groups may decide a hint. */
function applies(window: QuotaWindow, route: Route, provider: PlanQuota['provider']): boolean | undefined {
  if (window.group === undefined) return true
  if (provider === 'codex' && window.group === 'Code review') return false
  if (provider === 'cursor' && window.group === 'Included') return false // same cycle as the main window
  if (provider === 'claude') {
    const family = /^(opus|sonnet|haiku)$/i.exec(window.group)?.[1].toLowerCase()
    if (family !== undefined) {
      const selected = /(?:^|[-_. ])(opus|sonnet|haiku)(?:$|[-_. ]|\[)/i.exec(route.model)?.[1].toLowerCase()
      return selected === undefined ? undefined : selected === family
    }
  }
  // Codex feature limits are eligible only when their identifier names this exact model.
  if (provider === 'codex' && window.group.toLowerCase() === route.model.toLowerCase()) return true
  return undefined
}

export function resetSuggestion(route: Route | undefined, quotas: readonly PlanQuota[], now = Date.now()): { suggestion?: ResetSuggestion; reason?: SuggestionReason } {
  let matches: PlanQuota[]
  if (route?.provider === 'claude-agent') matches = quotas.filter((q) => q.provider === 'claude' && q.active === true)
  else if (route?.provider === 'openai-codex') matches = quotas.filter((q) => q.provider === 'codex' && q.active === true)
  else if (route?.provider === 'minimax-cn') matches = quotas.filter((q) => q.provider === 'minimax' && q.id === 'minimax')
  else if (route?.provider === 'minimax') matches = quotas.filter((q) => q.provider === 'minimax' && q.id === 'minimax:minimax')
  else if (route?.provider === 'cursor-agent') matches = quotas.filter((q) => q.provider === 'cursor')
  else return { reason: 'unsupported-route' }
  if (matches.length !== 1) return { reason: 'no-account' }
  const quota = matches[0]
  if (quota.stale || quota.error || !Number.isFinite(quota.fetchedAt) || quota.fetchedAt <= 0
    || now - quota.fetchedAt > MAX_AGE_MS || quota.fetchedAt > now + BUFFER_MS) return { reason: 'stale' }
  if (quota.expiresAt !== undefined && quota.expiresAt <= now) return { reason: 'expired-plan' }
  const windows: QuotaWindow[] = []
  for (const window of quota.windows) {
    const applicable = applies(window, route!, quota.provider)
    if (applicable === undefined) return { reason: 'unknown-window' }
    if (applicable) windows.push(window)
  }
  if (windows.some((w) => !Number.isFinite(w.usedPercent))) return { reason: 'unknown-window' }
  const blocked = windows.filter((w) => w.usedPercent >= 100 || (w.limit !== undefined && w.limit > 0 && w.used !== undefined && w.used >= w.limit))
  const candidates = blocked.length > 0 ? blocked : windows
  // A past reset is not evidence of replenishment; never extrapolate by windowMs.
  if (blocked.some((w) => w.resetsAt === undefined || !Number.isFinite(w.resetsAt) || w.resetsAt <= now)) return { reason: 'no-reset' }
  const future = candidates.filter((w) => w.resetsAt !== undefined && Number.isFinite(w.resetsAt) && w.resetsAt > now)
  if (future.length === 0) return { reason: 'no-reset' }
  const reset = (blocked.length > 0 ? Math.max : Math.min)(...future.map((w) => w.resetsAt!))
  if (quota.expiresAt !== undefined && quota.expiresAt <= reset + BUFFER_MS) return { reason: 'expired-plan' }
  try {
    return { suggestion: {
      at: new Date(reset + BUFFER_MS).toISOString(), resetAt: new Date(reset).toISOString(),
      kind: blocked.length > 0 ? 'recovery' : 'reset', quotaId: quota.id,
      ...(quota.account === undefined ? {} : { account: quota.account }),
      ...(quota.identity === undefined ? {} : { identity: quota.identity }),
      windows: future.filter((w) => w.resetsAt === reset).map((w) => w.group ? `${w.group} · ${w.key}` : w.label ?? w.key),
    } }
  } catch { return { reason: 'no-reset' } }
}

export function sameRoute(left: Route | undefined, right: Route | undefined): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

/** Changes to an account, target, or blocking interpretation require a new confirmation. */
export function sameSuggestion(left: ResetSuggestion | undefined, right: ResetSuggestion | undefined): boolean {
  return left !== undefined && right !== undefined && left.at === right.at && left.quotaId === right.quotaId
    && left.kind === right.kind && left.account === right.account && left.identity === right.identity && left.windows.join('\n') === right.windows.join('\n')
}
