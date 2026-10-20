/**
 * How a run goes, as it goes: a line on its card (steps as segments, the step, the time since it
 * was asked for), the steps with what each learned in its detail, and a strip atop the lane while
 * a sync or analyses run. Elapsed times tick from one shared second timer, and only while
 * something on screen is live; times are the host's, corrected by the client's skew.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { runEnded, type ReviewItem, type ReviewProgress, type ReviewRun, type RunInfo, type RunStep } from '../../review/types.ts'
import { t, type ReviewKey } from './i18n.ts'

/** An ended run's line stays on its card this long (a failure stays while the host keeps it). */
const SHOW_ENDED_MS = 2 * 60_000
/** The lane's strip stays this long after the last run or sync ended. */
const SHOW_STRIP_MS = 60_000

// ── The shared ticker ─────────────────────────────────────────────────────

let tick = 0
let ticker: ReturnType<typeof setInterval> | undefined
const ticking = new Set<() => void>()
const subscribeTick = (listener: () => void): (() => void) => {
  ticking.add(listener)
  ticker ??= setInterval(() => {
    tick++
    for (const each of ticking) each()
  }, 1000)
  return () => {
    ticking.delete(listener)
    if (ticking.size === 0) {
      clearInterval(ticker)
      ticker = undefined
    }
  }
}
const still = (): (() => void) => () => {}

/** The host's now, re-rendered every second while `live`. */
export function useHostNow(skew: number | undefined, live: boolean): number {
  useSyncExternalStore(live ? subscribeTick : still, () => (live ? tick : -1))
  return Date.now() - (skew ?? 0)
}

// ── Formatting ────────────────────────────────────────────────────────────

/** 0.8s, 12s, 3:05, 1:02:09. */
export function duration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`
  const seconds = Math.floor(safe / 1000)
  if (seconds < 60) return `${seconds}s`
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`
}

/** The steps a run passes through, in order, before it ends. */
export const stepsOf = (run: Pick<ReviewRun, 'mode'>): RunStep[] =>
  run.mode === 'fix' ? ['session', 'analyzing'] : run.mode === 'again' ? ['queued', 'session', 'analyzing'] : ['queued', 'fetch', 'context', 'session', 'analyzing']

export function stepLabel(step: RunStep, mode: ReviewRun['mode']): string {
  if (mode === 'fix' && (step === 'session' || step === 'analyzing')) return t(step === 'session' ? 'step.fixSession' : 'step.fixing')
  return t(step === 'session' && mode === 'again' ? 'step.again' : `step.${step}` as ReviewKey)
}

export function infoText(info: RunInfo | undefined): string {
  if (info === undefined) return ''
  const parts: string[] = []
  if (info.round !== undefined) parts.push(t('info.round', { n: info.round }))
  if (info.head !== undefined) parts.push(t('info.head', { sha: info.head.slice(0, 7) }))
  if (info.files !== undefined) parts.push(t('info.diff', { files: info.files, added: info.added ?? 0, removed: info.removed ?? 0 }))
  if (info.threads !== undefined && info.threads > 0) parts.push(t('info.threads', { n: info.threads }))
  return parts.join(' · ')
}

/** The step a failed run stopped at. */
const failedAt = (run: ReviewRun): RunStep => run.log.filter((entry) => !runEnded(entry.step)).at(-1)?.step ?? 'queued'

export function failure(run: ReviewRun): string {
  if (run.code === 'stalled') return t('run.stalled')
  if (run.code === 'timeout') return t('run.timeout')
  return run.error ?? t('step.failed')
}

const found = (item: ReviewItem | undefined): string =>
  item !== undefined && item.must + item.nice > 0 ? t('info.found', { n: item.must + item.nice }) : ''

/** Whether an ended run is still worth a line on its card. */
export const recent = (run: ReviewRun, now: number): boolean =>
  !runEnded(run.step) || run.step === 'failed' || now - (run.endedAt ?? 0) < SHOW_ENDED_MS

// ── On the card ───────────────────────────────────────────────────────────

/** The run's line on its card; nothing once an ended run is no longer recent. */
export function RunLine(props: { run: ReviewRun; item: ReviewItem; skew: number | undefined; onRetry(): void }): ReactNode {
  const { run, item } = props
  const ended = runEnded(run.step)
  // Ticks while live, and while a done line counts down to leaving; a failure stays still.
  const fading = ended && run.step !== 'failed' && recent(run, Date.now() - (props.skew ?? 0))
  const now = useHostNow(props.skew, !ended || fading)
  if (!recent(run, now)) return null
  if (run.step === 'failed') {
    const message = failure(run)
    return (
      <div className="rv-run" data-state="failed" role="alert">
        <span className="rv-run-mark" aria-hidden="true">!</span>
        <span className="rv-run-text" title={message}>
          <span className="rv-run-label">{t('run.failed', { step: stepLabel(failedAt(run), run.mode) })}</span>
          <span className="rv-run-info">{message}</span>
        </span>
        <button type="button" className="rv-run-retry" onClick={(event) => { event.stopPropagation(); props.onRetry() }}
          onKeyDown={(event) => event.stopPropagation()}>{t('retry')}</button>
      </div>
    )
  }
  if (run.step === 'cancelled') return <div className="rv-run" data-state="cancelled"><span className="rv-run-label">{t(run.code === 'stopped' ? 'run.stopped' : 'run.cancelled')}</span></div>
  if (run.step === 'done') {
    return (
      <div className="rv-run" data-state="done">
        <span className="rv-run-mark" aria-hidden="true">✓</span>
        <span className="rv-run-label">{t('run.doneIn', { time: duration((run.endedAt ?? now) - run.startedAt) })}</span>
        {found(item) !== '' && <span className="rv-run-info">{found(item)}</span>}
      </div>
    )
  }
  const steps = stepsOf(run)
  const at = Math.max(0, steps.indexOf(run.step))
  const info = run.step === 'analyzing' ? found(item) : infoText(run.log.at(-1)?.info)
  return (
    <div className="rv-run" data-state="active">
      <div className="rv-run-bar" aria-hidden="true">
        {steps.map((step, index) => <i key={step} data-on={index < at ? 'done' : index === at ? 'now' : undefined} />)}
      </div>
      <span className="rv-run-text">
        <span className="rv-run-label" role="status">{stepLabel(run.step, run.mode)}</span>
        {info !== '' && <span className="rv-run-info">{info}</span>}
      </span>
      <span className="rv-run-time">{duration(now - run.startedAt)}</span>
    </div>
  )
}

// ── In the detail ─────────────────────────────────────────────────────────

/** Each step with what it learned and how long it took; open while the run is live or failed. */
export function RunTimeline(props: { run: ReviewRun; item: ReviewItem; skew: number | undefined; onRetry(): void; onStop?(): void }): ReactNode {
  const { run, item } = props
  const ended = runEnded(run.step)
  const [open, setOpen] = useState(!ended || run.step === 'failed')
  const now = useHostNow(props.skew, open && !ended)
  const steps = stepsOf(run)
  const reached = new Map(run.log.map((entry, index) => [entry.step, { entry, next: run.log[index + 1] }]))
  const stoppedAt = run.step === 'failed' ? failedAt(run) : undefined
  const total = duration((run.endedAt ?? now) - run.startedAt)
  return (
    <section className="rv-section rv-progress" aria-label={t('progress')}>
      <div className="rv-section-head">
        <button type="button" className="rv-toggle rv-progress-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="rv-chevron" aria-hidden="true">›</span> {t('progress')}
        </button>
        <span className="rv-count">{ended ? t('run.total', { time: total }) : `${stepLabel(run.step, run.mode)} · ${total}`}</span>
        {!ended && props.onStop !== undefined && <StopButton queued={run.step === 'queued'} onStop={props.onStop} />}
      </div>
      {open && (
        <ol className="rv-steps">
          {steps.map((step) => {
            const hit = reached.get(step)
            const state = step === stoppedAt ? 'failed' : hit === undefined ? 'todo' : step === run.step ? 'now' : 'done'
            const until = hit?.next?.at ?? (state === 'now' ? now : undefined)
            const info = step === 'analyzing' && hit !== undefined ? found(item) : infoText(hit?.entry.info)
            return (
              <li key={step} className="rv-step" data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                <span className="rv-step-mark" aria-hidden="true" />
                <span className="rv-step-label">{stepLabel(step, run.mode)}</span>
                <span className="rv-step-time">{hit !== undefined && until !== undefined ? duration(until - hit.entry.at) : ''}</span>
                {info !== '' && <span className="rv-step-info">{info}</span>}
              </li>
            )
          })}
          {(run.step === 'done' || run.step === 'cancelled') && (
            <li className="rv-step" data-state={run.step === 'done' ? 'done' : 'todo'}>
              <span className="rv-step-mark" aria-hidden="true" />
              <span className="rv-step-label">{t(run.code === 'stopped' ? 'step.stopped' : `step.${run.step}`)}</span>
              <span className="rv-step-time">{total}</span>
            </li>
          )}
        </ol>
      )}
      {run.step === 'failed' && (
        <p className="rv-banner" role="alert">
          <span>{failure(run)}</span>
          <button type="button" className="rv-link" onClick={props.onRetry}>{t('retry')}</button>
        </p>
      )}
    </section>
  )
}

// ── Stopping ──────────────────────────────────────────────────────────────

/** A stop that appears where a start just was takes no click for this long: a double click starts, not starts and stops. */
const ARM_MS = 600

/** False until `ms` after mount. */
export function useArmed(ms = ARM_MS): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ms)
    return () => clearTimeout(timer)
  }, [ms])
  return armed
}

export const StopIcon = (): ReactNode => (
  <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /></svg>
)

/** Stop one run: 取消排队 while it waits, 终止 once it started. */
export function StopButton(props: { queued: boolean; className?: string; onStop(): void }): ReactNode {
  const armed = useArmed()
  const label = props.queued ? t('menu.cancel') : t('stop')
  return (
    <button type="button" className={props.className ?? 'rv-stop'} title={props.queued ? label : t('stopHint')} aria-label={label}
      aria-disabled={!armed || undefined}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        if (armed) props.onStop()
      }}>
      <StopIcon />
      <span>{label}</span>
    </button>
  )
}

// ── Atop the lane ─────────────────────────────────────────────────────────

/** A sync reading GitHub and the runs it started, summed up; hidden until something new starts. */
export function ActivityStrip(props: { progress: ReviewProgress | undefined; skew: number | undefined }): ReactNode {
  const { progress } = props
  const [hidden, setHidden] = useState<string | undefined>()
  const runs = progress?.runs ?? []
  const sync = progress?.sync
  const live = sync?.step === 'list' || runs.some((run) => !runEnded(run.step))
  const lastEnd = Math.max(sync?.endedAt ?? 0, ...runs.map((run) => run.endedAt ?? 0))
  const now = useHostNow(props.skew, live || Date.now() - (props.skew ?? 0) - lastEnd <= SHOW_STRIP_MS)
  // What has started since: a new sync or run shows the strip again.
  const latest = String(Math.max(sync?.startedAt ?? 0, ...runs.map((run) => run.startedAt)))
  if (progress === undefined || hidden === latest) return null
  if (!live && now - lastEnd > SHOW_STRIP_MS) return null
  if (sync === undefined && runs.length === 0) return null
  const count = (test: (run: ReviewRun) => boolean): number => runs.filter(test).length
  const tally = [
    { key: 'tally.active', n: count((run) => !runEnded(run.step) && run.step !== 'queued'), tone: 'active' },
    { key: 'tally.queued', n: count((run) => run.step === 'queued'), tone: 'queued' },
    { key: 'tally.done', n: count((run) => run.step === 'done'), tone: 'done' },
    { key: 'tally.failed', n: count((run) => run.step === 'failed'), tone: 'failed' },
  ].filter((entry) => entry.n > 0)
  const listing = sync?.step === 'list'
  // The sync leads while it reads and for a while after; then the runs' tally does.
  let headline: string | undefined
  if (sync === undefined || (!listing && now - (sync.endedAt ?? now) > SHOW_STRIP_MS)) headline = undefined
  else if (listing) headline = t('sync.listing')
  else if (sync.step === 'failed') headline = t('sync.failed', { message: sync.error ?? '' })
  else if (sync.total !== undefined) headline = t('sync.listedAll', { total: sync.total, found: sync.found ?? 0 })
  else if (sync.due === undefined) headline = t('sync.listed', { found: sync.found ?? 0 })
  else if (sync.due > 0) headline = t('sync.found', { found: sync.found ?? 0, due: sync.due ?? 0 })
  else headline = t('sync.none', { found: sync.found ?? 0 })
  if (headline === undefined && tally.length === 0) return null
  return (
    <div className="rv-activity" data-live={live ? '' : undefined} data-failed={sync?.step === 'failed' ? '' : undefined}>
      <div className="rv-activity-row">
        {live && <span className="rv-spin" aria-hidden="true" />}
        <span className="rv-activity-text" role="status">{headline ?? tally.map((entry) => t(entry.key as ReviewKey, { n: entry.n })).join(' · ')}</span>
        {listing && sync !== undefined && <span className="rv-run-time">{duration(now - sync.startedAt)}</span>}
        <button type="button" className="rv-activity-hide" aria-label={t('hide')} title={t('hide')} onClick={() => setHidden(latest)}>
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" /></svg>
        </button>
      </div>
      {headline !== undefined && tally.length > 0 && (
        <div className="rv-tally">
          {tally.map((entry) => <span key={entry.key} className="rv-tally-chip" data-tone={entry.tone}>{t(entry.key as ReviewKey, { n: entry.n })}</span>)}
        </div>
      )}
    </div>
  )
}
