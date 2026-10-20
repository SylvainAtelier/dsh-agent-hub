/**
 * Wire types shared by the host sources and the browser UI. Every provider
 * quirk is normalized into {@link PlanQuota} inside its source; the UI only
 * ever reads this shape.
 */

export type ProviderId = 'claude' | 'codex' | 'minimax' | 'cursor' | 'qoder'

/** One quota window of a subscription plan. */
export interface QuotaWindow {
  /** Stable key the UI localizes: `5h`, `week`, `month`, or `custom`. */
  key: string
  /** Provider-supplied name, shown instead of the localized key. */
  label?: string
  /** Secondary limits (Codex extra limits, Claude per-model weeks) collapse under this name. */
  group?: string
  /** Used percent, 0-100. */
  usedPercent: number
  /** Epoch ms the window resets. */
  resetsAt?: number
  /** Window length in ms; with resetsAt it places the pace marker. */
  windowMs?: number
  /** Request counts, when the provider reports them (MiniMax), or credits (Qoder). */
  used?: number
  limit?: number
  /** `used`/`limit` count credits rather than requests. */
  unit?: 'credits'
}

/** Why a quota could not be read; the UI turns each into an actionable hint. */
export type QuotaErrorCode =
  | 'not-installed' // CLI missing
  | 'not-signed-in' // no subscription login at all
  | 'no-credential' // no API key configured
  | 'expired' // token expired; refreshes once the account is used again
  | 'incompatible' // the source's data shape changed
  | 'failed' // network / provider error
  | 'no-data' // the provider's CLI has not recorded a reading yet (Qoder)
  | 'plugin-missing' // the plugin it comes from is not installed (Codex: dsh-codex-subscription)
  | 'plugin-off' // that plugin is installed but switched off

export interface QuotaError {
  code: QuotaErrorCode
  message?: string
  /** The account directory could not be read: do not infer that its accounts were removed. */
  scope?: 'source'
}

/** Pay-as-you-go spend this billing cycle, in US dollars (Cursor's on-demand usage). */
export interface Spend {
  used: number
  /** The cap; absent when spending is not capped for this account. */
  limit?: number
  /** On-demand usage is turned off for this account. */
  disabled?: boolean
}

/** One subscription account's quota. */
export interface PlanQuota {
  /** `claude`, `minimax`, `cursor`, `qoder`, or `codex:<vault account id>`. */
  id: string
  provider: ProviderId
  /** Opaque credential binding for reset-hint comparison; never a token or a display label. */
  identity?: string
  /** Account label / email. */
  account?: string
  /** Plan tier (`pro`, `plus`, ...). */
  plan?: string
  /** The Codex account currently selected in the Codex plugin. */
  active?: boolean
  /** Epoch ms the subscription itself expires (MiniMax). */
  expiresAt?: number
  /** Codex credit balance, when the account has credits. */
  credits?: string
  /** Spend beyond the plan's included usage (Cursor). */
  spend?: Spend
  windows: QuotaWindow[]
  /** Epoch ms of the data's last successful read. */
  fetchedAt: number
  /** The windows come from an earlier read because the latest one failed. */
  stale?: boolean
  /** The windows are the provider CLI's own last reading, taken at fetchedAt (Qoder): show their age. */
  snapshot?: boolean
  error?: QuotaError
}

/** Token counts in DSH's normalized split: input excludes cache reads and writes, so the four add up to the total. */
export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One day's tokens for one model of one DSH provider route. */
export interface TokenRow extends TokenCounts {
  /** Local day on the host, `YYYY-MM-DD`. */
  day: string
  /** DSH provider route id (`openai-codex`, `claude-agent`, ...). */
  provider: string
  model: string
}

/** Every model call DSH's session logs record, live sessions plus the ledger of deleted ones. */
export interface TokenUsage {
  rows: TokenRow[]
  /** Display names of the provider routes, where DSH still registers them. */
  providers: Record<string, string>
  /** The host's local day, so "today" means the same day the rows were bucketed by. */
  today: string
  /** Epoch ms of the earliest counted call. */
  since?: number
  error?: QuotaError
}

export interface UsageOverview {
  quotas: PlanQuota[]
  tokens?: TokenUsage
  at: number
}

/** RPC method the host registers under the authenticated /api bridge. */
export const OVERVIEW_METHOD = 'agent-hub/usage'
