/**
 * The two surfaces: the settings section (one card per account) and the
 * sidebar glance card (one row per account, its tightest window only).
 * Everything leads with what is LEFT and WHEN it comes back — the two
 * questions a quota display exists to answer.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ago, date, dateTime, duration, shortDuration, t, type Key } from '../i18n.ts'
import type { Feed } from './feed.ts'
import { surfaceOf } from './surface.ts'
import { compact, exact, expandedChoice, hitRate, hueOf, percent, periodChoice, PERIODS, summarize, type Tally } from './tokens.ts'
import type { AccountStore } from '../claude/accounts.tsx'
import type { CodexAccountStore } from '../codex/accounts.tsx'
import { CodexSetup } from '../codex/setup.tsx'
import type { ModulesStore } from '../modules.ts'
import { AccountSwitch } from './switch.tsx'
import type { PlanQuota, ProviderId, QuotaWindow, Spend, TokenUsage } from '../../usage/types.ts'

const DAY = 86_400_000
const ORDER: Record<ProviderId, number> = { claude: 0, codex: 1, cursor: 2, qoder: 3, minimax: 4 }
/** A provider CLI's own reading (Qoder) shows its age once it is older than this. */
const SNAPSHOT_AGE_MS = 10 * 60_000

type Level = 'ok' | 'warn' | 'bad'
const levelOf = (remaining: number): Level => (remaining < 20 ? 'bad' : remaining < 50 ? 'warn' : 'ok')

interface WindowView {
  remaining: number
  level: Level
  /** The window already reset since the data was read (stale snapshots). */
  reset: boolean
  /** Remaining percent an even pace would leave right now. */
  pace?: number
}

function viewOf(window: QuotaWindow, now: number): WindowView {
  const reset = window.resetsAt !== undefined && window.resetsAt <= now
  const remaining = Math.round(reset ? 100 : 100 - window.usedPercent)
  const pace = !reset && window.resetsAt !== undefined && window.windowMs
    ? Math.max(0, Math.min(100, ((window.resetsAt - now) / window.windowMs) * 100))
    : undefined
  return { remaining, level: levelOf(remaining), reset, ...(pace === undefined ? {} : { pace }) }
}

const windowLabel = (window: QuotaWindow): string => {
  const base = window.label ?? t(`window.${window.key}` as Key)
  return window.group === undefined ? base : `${window.group} · ${base}`
}

/** The account's most constrained main window. */
function tightest(quota: PlanQuota, now: number): WindowView | undefined {
  let best: WindowView | undefined
  for (const window of quota.windows) {
    if (window.group !== undefined) continue
    const view = viewOf(window, now)
    if (best === undefined || view.remaining < best.remaining) best = view
  }
  return best
}

/** Credit pools are spent one after another, so together they are one meter: credits left of all credits. */
function pooled(quota: PlanQuota): WindowView | undefined {
  const main = quota.windows.filter((window) => window.group === undefined)
  if (main.length === 0 || !main.every((window) => window.unit === 'credits' && (window.limit ?? 0) > 0)) return undefined
  const limit = main.reduce((sum, window) => sum + window.limit!, 0)
  const left = main.reduce((sum, window) => sum + Math.max(0, window.limit! - (window.used ?? 0)), 0)
  const remaining = Math.round((left / limit) * 100)
  return { remaining, level: levelOf(remaining), reset: false }
}

/** The glance shows the 5-hour window (all credits, for credit pools); accounts without one fall back to their tightest. */
function glanceView(quota: PlanQuota, now: number): WindowView | undefined {
  const credits = pooled(quota)
  if (credits !== undefined) return credits
  const fiveHour = quota.windows.find((window) => window.group === undefined && window.key === '5h')
  return fiveHour === undefined ? tightest(quota, now) : viewOf(fiveHour, now)
}

function sorted(quotas: readonly PlanQuota[]): PlanQuota[] {
  return [...quotas].sort((a, b) => ORDER[a.provider] - ORDER[b.provider]
    || Number(b.active === true) - Number(a.active === true)
    || (a.account ?? '').localeCompare(b.account ?? ''))
}

function errorText(quota: PlanQuota): string | undefined {
  const error = quota.error
  if (error === undefined) return undefined
  const key = (error.code === 'not-signed-in' ? `err.not-signed-in.${quota.provider}` : `err.${error.code}`) as Key
  const text = t(key)
  return error.message && (error.code === 'failed' || error.code === 'incompatible') ? `${text}：${error.message}` : text
}

/** Codex without its plugin: the offer to install or enable it in place of the hint, where a store can act on it. */
const pluginMissing = (quota: PlanQuota): boolean => quota.error?.code === 'plugin-missing' || quota.error?.code === 'plugin-off'

const usd = (value: number): string => `$${value.toFixed(2)}`

/** Credits in the popover's narrow column: exact up to 9,999, compact above. */
const creditCount = (value: number): string => (value < 10_000 ? exact(value) : compact(value))

const countText = (window: QuotaWindow): string => t(window.unit === 'credits' ? 'countCredits' : 'count', {
  used: window.unit === 'credits' ? exact(window.used ?? 0) : window.used ?? 0,
  limit: window.unit === 'credits' ? exact(window.limit ?? 0) : window.limit ?? 0,
})

/** "from 3 h ago": an earlier read standing in for a failed one, or a provider CLI's own reading once it has aged. */
function ageOf(quota: PlanQuota, now: number): string | undefined {
  if (quota.fetchedAt <= 0) return undefined
  if (quota.stale !== true && !(quota.snapshot === true && now - quota.fetchedAt > SNAPSHOT_AGE_MS)) return undefined
  return t('stale', { time: ago(quota.fetchedAt, now) })
}

/** Pay-as-you-go spend on one line; near or past its cap it takes the warning colors. */
function spendNote(spend: Spend): { text: string; level?: Level } {
  if (spend.disabled === true) return { text: t('spendOff') }
  if (spend.limit === undefined) return { text: t('spendOpen', { used: usd(spend.used) }) }
  const share = spend.limit > 0 ? spend.used / spend.limit : 1
  return { text: t('spendOf', { used: usd(spend.used), limit: usd(spend.limit) }), level: share >= 1 ? 'bad' : share >= 0.8 ? 'warn' : 'ok' }
}

function Bar(props: { view: WindowView }): ReactNode {
  const { view } = props
  return (
    <div className="uh-bar">
      <div className="uh-fill" style={{ width: `${view.remaining}%` }} />
      {view.pace !== undefined && (
        <div className="uh-pace" style={{ left: `${view.pace}%` }} title={t('pace', { n: Math.round(view.pace) })} />
      )}
    </div>
  )
}

function Meter(props: { window: QuotaWindow; now: number }): ReactNode {
  const { window, now } = props
  const view = viewOf(window, now)
  const label = windowLabel(window)
  return (
    <div className="uh-meter" data-level={view.level} role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.remaining}>
      <div className="uh-meter-top">
        <span className="uh-label">{label}</span>
        <span className="uh-pct">{t(view.reset ? 'leftApprox' : 'left', { n: view.remaining })}</span>
      </div>
      <Bar view={view} />
      <div className="uh-meta">
        <span title={window.resetsAt === undefined ? undefined : dateTime(window.resetsAt)}>
          {view.reset ? t('resetDone') : window.resetsAt === undefined ? '' : t('resetIn', { time: duration(window.resetsAt - now) })}
        </span>
        {window.used !== undefined && window.limit !== undefined && <span>{countText(window)}</span>}
      </div>
    </div>
  )
}

function QuotaCard(props: { quota: PlanQuota; now: number; modules?: ModulesStore; changed?: () => void }): ReactNode {
  const { quota, now } = props
  const main = quota.windows.filter((window) => window.group === undefined)
  const more = quota.windows.filter((window) => window.group !== undefined)
  const hint = errorText(quota)
  const days = quota.expiresAt === undefined ? undefined : Math.ceil((quota.expiresAt - now) / DAY)
  return (
    <article className="uh-card" data-stale={quota.stale ? '' : undefined}>
      <header className="uh-head">
        <span className="uh-dot" data-p={quota.provider} />
        <span className="uh-name">{t(`provider.${quota.provider}`)}</span>
        {quota.account !== undefined && <span className="uh-account" title={quota.account}>{quota.account}</span>}
        {quota.plan !== undefined && <span className="uh-tag">{quota.plan}</span>}
        {quota.active === true && <span className="uh-badge">{t('active')}</span>}
        {ageOf(quota, now) !== undefined && <span className="uh-age" title={dateTime(quota.fetchedAt)}>{ageOf(quota, now)}</span>}
      </header>
      {main.map((window, index) => <Meter key={`${window.key}-${index}`} window={window} now={now} />)}
      {more.length > 0 && (
        <details className="uh-more">
          <summary>{t('more')} · {more.length}</summary>
          <div className="uh-more-body">
            {more.map((window, index) => <Meter key={`${window.group}-${window.key}-${index}`} window={window} now={now} />)}
          </div>
        </details>
      )}
      {days !== undefined && quota.expiresAt !== undefined && (
        <div className="uh-foot-note" data-level={days <= 0 ? 'bad' : days <= 7 ? 'warn' : 'ok'}>
          {days <= 0 ? t('expired', { date: date(quota.expiresAt) }) : t('expires', { date: date(quota.expiresAt), days })}
        </div>
      )}
      {quota.credits !== undefined && <div className="uh-foot-note">{t('credits', { n: quota.credits })}</div>}
      {quota.spend !== undefined && <div className="uh-foot-note" data-level={spendNote(quota.spend).level}>{spendNote(quota.spend).text}</div>}
      {hint !== undefined && (pluginMissing(quota) && props.modules !== undefined
        ? <CodexSetup store={props.modules} changed={props.changed} />
        : <p className="uh-hint" data-error={quota.windows.length === 0 ? '' : undefined}>{hint}</p>)}
    </article>
  )
}

/** Every count of a tally, exact: what a compact number stands for. */
function breakdown(tally: Tally): string {
  return [
    `${t('tokens.input')} ${exact(tally.input)}`,
    `${t('tokens.cacheRead')} ${exact(tally.cacheRead)}`,
    `${t('tokens.cacheWrite')} ${exact(tally.cacheWrite)}`,
    `${t('tokens.output')} ${exact(tally.output)}`,
    `${t('tokens.total')} ${exact(tally.total)}`,
  ].join(' · ')
}

/** Today / 7 days / 30 days / all: one remembered choice for both surfaces. Arrow keys move it. */
function PeriodSwitch(): ReactNode {
  const period = useSyncExternalStore(periodChoice.subscribe, periodChoice.get)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = PERIODS[(PERIODS.indexOf(period) + step + PERIODS.length) % PERIODS.length]!
    periodChoice.set(next)
    event.currentTarget.querySelector<HTMLElement>(`[data-period="${next}"]`)?.focus()
  }
  return (
    <div className="ah-seg uh-seg" role="radiogroup" aria-label={t('tokens.period')} onKeyDown={onKeyDown}>
      {PERIODS.map((value) => (
        <button key={value} type="button" role="radio" aria-checked={value === period} tabIndex={value === period ? 0 : -1}
          data-period={value} onClick={() => periodChoice.set(value)}>
          {t(`tokens.period.${value}`)}
        </button>
      ))}
    </div>
  )
}

/** Total, a bar on the period's scale (so a provider's models add up to its bar), and the share. */
function TokenFigures(props: { tally: Tally; whole: number }): ReactNode {
  const { tally, whole } = props
  const share = percent(tally.total, whole)
  return (
    <>
      <span className="uh-tok-num">{compact(tally.total)}</span>
      <span className="uh-tok-bar" aria-hidden="true"><span style={{ width: `${whole > 0 ? (tally.total / whole) * 100 : 0}%` }} /></span>
      <span className="uh-tok-pct" aria-label={t('tokens.share', { n: share })}>{share}%</span>
    </>
  )
}

/**
 * The popover's token block: the period's total, its split, then one row per
 * provider route (largest first) that opens onto its models. Compact numbers;
 * the exact counts sit behind each row (hover, or under each model on touch).
 */
function TokenPanel(props: { usage: TokenUsage | undefined }): ReactNode {
  const { usage } = props
  const period = useSyncExternalStore(periodChoice.subscribe, periodChoice.get)
  const expanded = useSyncExternalStore(expandedChoice.subscribe, expandedChoice.get)
  if (usage === undefined) return null
  const summary = summarize(usage, period)
  const hit = hitRate(summary)
  const error = usage.error === undefined ? undefined : t('tokens.error', { error: usage.error.message ?? '' })
  const toggle = (provider: string, open: boolean): void => {
    if (open === expanded.includes(provider)) return
    const rest = expanded.filter((id) => id !== provider)
    expandedChoice.set(open ? [...rest, provider] : rest)
  }
  return (
    <section className="uh-tok" aria-label={t('tokens.title')}>
      <div className="uh-tok-head">
        <span>{t('tokens.title')}</span>
        <PeriodSwitch />
      </div>
      {summary.total === 0
        ? <div className="uh-pop-note">{error ?? t('tokens.none')}</div>
        : (
          <>
            <div className="uh-tok-sum" title={breakdown(summary)}>
              <span className="uh-tok-total">{compact(summary.total)}</span>
              {hit !== undefined && <span className="uh-tok-hit">{t('tokens.hit', { n: Math.round(hit * 100) })}</span>}
            </div>
            <div className="uh-tok-split">
              {t('tokens.input')} {compact(summary.input)} · {t('tokens.cache')} {compact(summary.cacheRead + summary.cacheWrite)} · {t('tokens.output')} {compact(summary.output)}
            </div>
            <div className="uh-tok-list">
              {summary.providers.map((provider) => (
                <details key={provider.provider} className="uh-tok-provider" open={expanded.includes(provider.provider)}
                  onToggle={(event) => toggle(provider.provider, event.currentTarget.open)}>
                  <summary className="uh-tok-row" title={breakdown(provider)}>
                    <span className="uh-tok-name"><span className="uh-dot" data-p={hueOf(provider.provider)} />{provider.name}</span>
                    <TokenFigures tally={provider} whole={summary.total} />
                  </summary>
                  {provider.models.map((model) => (
                    <div key={model.model} className="uh-tok-row" data-model="" title={breakdown(model)}>
                      <span className="uh-tok-name">{model.model}</span>
                      <TokenFigures tally={model} whole={summary.total} />
                      <span className="uh-tok-detail">{breakdown(model)}</span>
                    </div>
                  ))}
                </details>
              ))}
            </div>
            {error !== undefined && <div className="uh-pop-note">{error}</div>}
          </>
        )}
    </section>
  )
}

/** Settings: the period's exact counts, one row per provider route and per model, totals at the foot. */
function TokenSection(props: { usage: TokenUsage | undefined }): ReactNode {
  const { usage } = props
  const headingId = useId()
  const period = useSyncExternalStore(periodChoice.subscribe, periodChoice.get)
  if (usage === undefined) return null
  const summary = summarize(usage, period)
  const cells = (tally: Tally): ReactNode => (
    <>
      <td>{exact(tally.input)}</td>
      <td>{exact(tally.cacheRead)}</td>
      <td>{exact(tally.cacheWrite)}</td>
      <td>{exact(tally.output)}</td>
      <td data-total="">{exact(tally.total)}</td>
    </>
  )
  return (
    <section className="uh-tok-section" aria-labelledby={headingId}>
      <div className="uh-toolbar">
        <h3 id={headingId} className="uh-tok-heading">{t('tokens.title')}</h3>
        <PeriodSwitch />
      </div>
      {usage.error !== undefined && <p className="uh-hint" data-error="">{t('tokens.error', { error: usage.error.message ?? '' })}</p>}
      {summary.total === 0
        ? <p className="uh-hint">{t('tokens.none')}</p>
        : (
          <div className="uh-tok-scroll" role="region" aria-labelledby={headingId} tabIndex={0}>
            <table className="uh-tok-table">
              <thead>
                <tr>
                  <th scope="col">{t('tokens.column')}</th>
                  <th scope="col">{t('tokens.input')}</th>
                  <th scope="col">{t('tokens.cacheRead')}</th>
                  <th scope="col">{t('tokens.cacheWrite')}</th>
                  <th scope="col">{t('tokens.output')}</th>
                  <th scope="col">{t('tokens.total')}</th>
                </tr>
              </thead>
              {summary.providers.map((provider) => (
                <tbody key={provider.provider}>
                  <tr data-provider="">
                    <th scope="row"><span className="uh-dot" data-p={hueOf(provider.provider)} />{provider.name}</th>
                    {cells(provider)}
                  </tr>
                  {provider.models.map((model) => (
                    <tr key={model.model}>
                      <th scope="row">{model.model}</th>
                      {cells(model)}
                    </tr>
                  ))}
                </tbody>
              ))}
              <tfoot>
                <tr>
                  <th scope="row">{t('tokens.total')}</th>
                  {cells(summary)}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      {usage.since !== undefined && <p className="uh-hint">{t('tokens.note', { date: date(usage.since) })}</p>}
    </section>
  )
}

/** Settings section: every account as a card, densest first-glance order. */
export function Section(props: { feed: Feed; modules?: ModulesStore }): ReactNode {
  const { feed } = props
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot)
  const now = Date.now()
  const overview = state.overview
  return (
    <div className="uh-section">
      <div className="uh-toolbar">
        <span className="uh-muted">{overview === null ? '' : t('updated', { time: ago(overview.at, now) })}</span>
        <button type="button" className="ah-btn" disabled={state.loading} onClick={feed.refresh}>
          {state.loading ? t('refreshing') : t('refresh')}
        </button>
      </div>
      {state.error !== null && <p className="uh-hint" data-error="">{t('loadError', { error: state.error })}</p>}
      {overview === null
        ? state.loading && <div className="uh-grid" aria-busy="true" aria-label={t('loading')}>{[0, 1, 2].map((i) => <div key={i} className="uh-skeleton" />)}</div>
        : overview.quotas.length === 0
          ? <p className="uh-hint">{t('empty')}</p>
          : <div className="uh-grid">{sorted(overview.quotas).map((quota) => <QuotaCard key={quota.id} quota={quota} now={now} modules={props.modules} changed={() => feed.reload('codex')} />)}</div>}
      <TokenSection usage={overview?.tokens} />
    </div>
  )
}

/** Short row name: the provider, plus the account when the provider has several. */
function rowName(quota: PlanQuota, siblings: number): string {
  const provider = t(`provider.${quota.provider}`)
  if (siblings < 2 || quota.account === undefined) return provider
  return `${provider}·${quota.account.split('@')[0]}`
}

/** Hover intent: open after a short dwell; close after a grace that lets the pointer cross into the popover. */
const OPEN_DELAY_MS = 180
const CLOSE_DELAY_MS = 220
const POP_GAP = 8
const POP_WIDTH = 320

interface PopPlacement {
  left: number
  bottom: number
  width: number
  maxHeight: number
  background: string
  color: string
}

/**
 * Beside the sidebar (clearing its edge, not just the card's) with bottom
 * edges aligned to the card; above the card when the viewport is too narrow.
 */
function placeBeside(anchor: HTMLElement): PopPlacement {
  const rect = anchor.getBoundingClientRect()
  const column = anchor.closest<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  const beside = Math.max(rect.right, column?.getBoundingClientRect().right ?? 0) + POP_GAP
  if (beside + POP_WIDTH <= window.innerWidth - 8) {
    return {
      left: beside,
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      width: POP_WIDTH,
      maxHeight: Math.max(160, rect.bottom - 16),
      ...surfaceOf(anchor),
    }
  }
  const width = Math.min(POP_WIDTH, window.innerWidth - 16)
  return {
    left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8),
    bottom: 8,
    width,
    maxHeight: Math.max(100, window.innerHeight - 16),
    ...surfaceOf(anchor),
  }
}

function DetailRow(props: { window: QuotaWindow; now: number }): ReactNode {
  const { window, now } = props
  const view = viewOf(window, now)
  const reset = view.reset ? t('resetDone') : window.resetsAt === undefined ? undefined : shortDuration(window.resetsAt - now)
  // A credit pool without a reset date shows what is left of it instead.
  const left = reset === undefined && window.unit === 'credits' && window.limit !== undefined
    ? t('creditsLeft', { n: creditCount(Math.max(0, window.limit - (window.used ?? 0))) })
    : undefined
  const title = left !== undefined ? countText(window)
    : window.resetsAt === undefined || view.reset ? undefined : `${t('resetIn', { time: duration(window.resetsAt - now) })} · ${dateTime(window.resetsAt)}`
  return (
    <div className="uh-pop-row" data-level={view.level}>
      <span className="uh-pop-label" title={windowLabel(window)}>{windowLabel(window)}</span>
      <Bar view={view} />
      <span className="uh-pop-pct">{view.reset ? '≈' : ''}{view.remaining}%</span>
      <span className="uh-pop-reset" title={title}>{left ?? (reset === undefined ? '' : `↻ ${reset}`)}</span>
    </div>
  )
}

interface HoverHandlers {
  onPointerEnter(event: ReactPointerEvent): void
  onPointerLeave(event: ReactPointerEvent): void
}

/** Every account's main windows as one aligned table: compare by scanning down a column. */
function Detail(props: {
  quotas: PlanQuota[]
  tokens?: TokenUsage
  at?: number
  now: number
  id: string
  placement: PopPlacement
  pinned: boolean
  onClose: () => void
  onOpen: () => void
  hover: HoverHandlers
  accounts: AccountStore
  codexAccounts: CodexAccountStore
  modules?: ModulesStore
  changed?: () => void
}): ReactNode {
  const { quotas, tokens, at, now, id, placement, pinned, onClose, onOpen, hover, accounts, codexAccounts } = props
  return (
    <div id={id} className="uh-pop" role="dialog" aria-label={t('title')} {...hover}
      style={{
        left: placement.left, bottom: placement.bottom, width: placement.width, maxHeight: placement.maxHeight,
        background: placement.background, color: placement.color,
      }}>
      <div className="uh-pop-head">
        <span>{t('title')}</span>
        {at !== undefined && <span className="uh-muted">{t('updated', { time: ago(at, now) })}</span>}
        {pinned && (
          <button type="button" className="uh-pop-close" aria-label={t('close')} onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {quotas.map((quota) => {
        const main = quota.windows.filter((window) => window.group === undefined)
        // Credit pools show their count in their own row.
        const counted = main.find((window) => window.used !== undefined && window.limit !== undefined && window.unit !== 'credits')
        const days = quota.expiresAt === undefined ? undefined : Math.ceil((quota.expiresAt - now) / DAY)
        const hint = main.length === 0 ? errorText(quota) : undefined
        return (
          <section key={quota.id} className="uh-pop-acc" data-stale={quota.stale ? '' : undefined}>
            <div className="uh-head">
              <span className="uh-dot" data-p={quota.provider} />
              <span className="uh-name">{t(`provider.${quota.provider}`)}</span>
              {quota.account !== undefined && <span className="uh-account">{quota.account}</span>}
              {quota.active === true && <span className="uh-badge">{t('active')}</span>}
              {ageOf(quota, now) !== undefined && <span className="uh-age" title={dateTime(quota.fetchedAt)}>{ageOf(quota, now)}</span>}
            </div>
            {main.map((window, index) => <DetailRow key={`${window.key}-${index}`} window={window} now={now} />)}
            {(counted !== undefined || days !== undefined) && (
              <div className="uh-pop-note">
                {counted !== undefined && countText(counted)}
                {counted !== undefined && days !== undefined && ' · '}
                {days !== undefined && quota.expiresAt !== undefined && (
                  <span data-level={days <= 0 ? 'bad' : days <= 7 ? 'warn' : 'ok'} title={date(quota.expiresAt)}>
                    {days <= 0 ? t('expired', { date: date(quota.expiresAt) }) : t('expiresShort', { days })}
                  </span>
                )}
              </div>
            )}
            {quota.spend !== undefined && (
              <div className="uh-pop-note"><span data-level={spendNote(quota.spend).level}>{spendNote(quota.spend).text}</span></div>
            )}
            {hint !== undefined && (pluginMissing(quota) && props.modules !== undefined
              ? <CodexSetup store={props.modules} changed={props.changed} />
              : <div className="uh-pop-note">{hint}</div>)}
          </section>
        )
      })}
      <TokenPanel usage={tokens} />
      <AccountSwitch claude={accounts} codex={codexAccounts} />
      <button type="button" className="uh-pop-link" onClick={onOpen}>{t('details')} →</button>
    </div>
  )
}

type PopMode = 'hover' | 'pinned'

/**
 * Sidebar glance: one cell per account — name, what is left of its 5-hour
 * window (else its tightest), a hairline meter. Hovering opens the detail
 * popover and leaving closes it; a click pins it open until it is closed by
 * hand (×, Esc, or a second click on the glance).
 */
export function FootCard(props: { feed: Feed; accounts: AccountStore; codexAccounts: CodexAccountStore; modules?: ModulesStore; onOpen: () => void; wide?: boolean }): ReactNode {
  const { feed, onOpen, wide } = props
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot)
  const [pop, setPop] = useState<{ mode: PopMode; placement: PopPlacement } | undefined>(undefined)
  // Mirrors pop.mode for the hover timers, which outlive the render that armed them.
  const mode = useRef<PopMode | undefined>(undefined)
  const anchor = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const popId = useId()
  const now = Date.now()
  const quotas = sorted(state.overview?.quotas ?? [])
  const count = (provider: ProviderId): number => quotas.filter((quota) => quota.provider === provider).length
  // The collapsed sidebar is a 56px icon rail with no room for numbers.
  const hidden = wide === false

  const openAs = (next: PopMode): void => {
    clearTimeout(timer.current)
    if (anchor.current === null) return
    mode.current = next
    setPop({ mode: next, placement: placeBeside(anchor.current) })
  }
  const close = (): void => {
    clearTimeout(timer.current)
    mode.current = undefined
    setPop(undefined)
  }
  // Mouse only: touch and pen have no hover, so a tap is the way in.
  const hover: HoverHandlers = {
    onPointerEnter: (event) => {
      if (event.pointerType !== 'mouse') return
      clearTimeout(timer.current)
      if (mode.current === undefined) timer.current = setTimeout(() => openAs('hover'), OPEN_DELAY_MS)
    },
    onPointerLeave: (event) => {
      if (event.pointerType !== 'mouse') return
      clearTimeout(timer.current)
      if (mode.current !== 'pinned') timer.current = setTimeout(close, CLOSE_DELAY_MS)
    },
  }
  // A click pins whatever hover opened; a click on a pinned popover's glance closes it.
  const onClick = (): void => {
    if (mode.current === 'pinned') close()
    else openAs('pinned')
  }

  const open = pop !== undefined
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { if (hidden) close() }, [hidden])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    const onResize = (): void => {
      const element = anchor.current
      if (element !== null) setPop((current) => current && { ...current, placement: placeBeside(element) })
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const openDetails = (): void => {
    close()
    onOpen()
  }

  if (hidden) return null
  const failed = state.overview === null && state.error !== null
  return (
    <div className="uh-glance-wrap">
      <button type="button" ref={anchor} className="uh-glance" data-open={open ? '' : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined} onClick={onClick} {...hover}>
        {quotas.length === 0
          ? <span className="uh-glance-empty">{t('title')} · {failed ? t('err.failed') : state.loading ? '…' : '—'}</span>
          : quotas.map((quota) => {
            const view = glanceView(quota, now)
            const siblings = count(quota.provider)
            return (
              <span key={quota.id} className="uh-cell" data-level={view?.level} data-stale={quota.stale ? '' : undefined}>
                <span className="uh-cell-top">
                  <span className="uh-dot" data-p={quota.provider} />
                  <span className="uh-cell-name">{rowName(quota, siblings)}</span>
                  {quota.active === true && siblings > 1 && <i className="uh-cell-active" aria-label={t('active')} />}
                  <span className="uh-cell-pct">{view === undefined ? '—' : `${view.remaining}%`}</span>
                </span>
                <span className="uh-cell-bar"><span style={{ width: `${view?.remaining ?? 0}%` }} /></span>
              </span>
            )
          })}
      </button>
      {pop !== undefined && createPortal(
        <Detail quotas={quotas} accounts={props.accounts} codexAccounts={props.codexAccounts} modules={props.modules} changed={() => feed.reload('codex')} now={now} id={popId} placement={pop.placement} pinned={pop.mode === 'pinned'}
          onClose={close} onOpen={openDetails} hover={hover}
          {...(state.overview === null ? {} : { at: state.overview.at })}
          {...(state.overview?.tokens === undefined ? {} : { tokens: state.overview.tokens })} />,
        document.body,
      )}
    </div>
  )
}
