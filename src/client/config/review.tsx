/**
 * 设置 → Agent Hub → 审核: which repositories' pull requests are reviewed (a checklist of the
 * repositories DSH knows) and which bot reviews them (one of 设置 → Bots).
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ReviewScheduleStore, ScheduleSnapshot } from '../review/schedule.ts'
import { samePath } from '../../repos/types.ts'
import type { ReposStore } from '../repos/api.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'

interface Props {
  id: string
  field: FieldState
  disabled: boolean
  form: ConfigFormModel
}

const unavailableSchedule: ScheduleSnapshot = { status: undefined, busy: undefined, error: undefined }
const noSubscribe = (): (() => void) => () => {}

/** The native task is authoritative; the legacy form fields are never read or written here. */
export function ReviewScheduleField(props: {
  store?: ReviewScheduleStore
  disabled: boolean
  openTask?: (sessionId: string, id: string) => boolean
}): ReactNode {
  const { store } = props
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? (() => unavailableSchedule))
  const [confirm, setConfirm] = useState(false)
  const [navigationResult, setNavigationResult] = useState<'opened' | 'failed' | undefined>()
  const toggle = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => store?.watch(), [store])
  useEffect(() => { if (confirm) cancel.current?.focus() }, [confirm])
  const { status, busy, error } = snapshot
  const enabled = status?.enabled === true
  const blocked = props.disabled || store === undefined || status === undefined || busy !== undefined || (snapshot.uncertain === true && !enabled)
  const closeConfirm = (): void => { setConfirm(false); toggle.current?.focus() }
  let nextRun: string | undefined
  if (status?.nextRun !== undefined && Number.isFinite(status.nextRun)) {
    try { nextRun = new Date(status.nextRun).toLocaleString(undefined, { timeZone: status.timeZone, timeZoneName: 'short' }) }
    catch { nextRun = new Date(status.nextRun).toISOString() }
  }
  const stateLabel = busy !== undefined ? t(`review.schedule.${busy === 'status' ? 'loading' : busy === 'enable' ? 'enabling' : 'disabling'}`)
    : status === undefined ? t('review.schedule.unknown') : t(enabled ? 'review.schedule.enabled' : 'review.schedule.disabled')
  return (
    <div className="ac-row ac-review-schedule" data-wide="" aria-labelledby="ac-review-schedule-label" aria-busy={busy !== undefined}>
      <div className="ac-row-text">
        <div className="ac-row-head">
          <label className="ac-label" id="ac-review-schedule-label" htmlFor="ac-review-schedule-switch">{t('review.schedule')}</label>
          <span className="ac-tag" role="status" aria-live="polite">{stateLabel}</span>
        </div>
        <p className="ac-hint" id="ac-review-schedule-hint">{t('review.schedule.hint')}</p>
      </div>
      <div className="ac-control ac-review-schedule-body">
        <div className="ac-review-schedule-actions">
          <button type="button" ref={toggle} id="ac-review-schedule-switch" role="switch" className="ac-switch" aria-checked={enabled}
            aria-labelledby="ac-review-schedule-label" aria-describedby="ac-review-schedule-hint" disabled={blocked}
            onClick={() => { if (enabled) void store?.request('disable'); else setConfirm(true) }}><span className="ac-thumb" /></button>
          <button type="button" className="ah-btn" disabled={store === undefined || busy !== undefined} onClick={() => void store?.request()}>{t('review.schedule.refresh')}</button>
          <button type="button" className="ah-btn" disabled={status?.taskId === undefined || status?.sessionId === undefined || props.openTask === undefined}
            onClick={() => {
              try { setNavigationResult(props.openTask?.(status!.sessionId!, status!.taskId!) === true ? 'opened' : 'failed') }
              catch { setNavigationResult('failed') }
            }}>{t('review.schedule.manage')}</button>
        </div>
        {confirm && <div className="ac-notice ac-review-confirm" role="group" aria-label={t('review.schedule.confirmTitle')}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeConfirm() } }}>
          <p>{t('review.schedule.confirm')}</p>
          <div className="ac-review-schedule-actions">
            <button type="button" className="ah-btn" ref={cancel} onClick={closeConfirm}>{t('review.schedule.cancel')}</button>
            <button type="button" className="ah-btn" data-variant="primary" disabled={blocked} onClick={() => { closeConfirm(); void store?.request('enable') }}>{t('review.schedule.confirmEnable')}</button>
          </div>
        </div>}
        {store === undefined && <p className="ac-hint" role="status">{t('review.schedule.unavailable')}</p>}
        {status !== undefined && <dl className="ac-review-task-meta">
          <div><dt>{t('review.schedule.title')}</dt><dd>{status.title || t('review.schedule.noTask')}</dd></div>
          <div><dt>{t('review.schedule.time')}</dt><dd>{[status.time, status.timeZone].filter(Boolean).join(' · ') || t('review.schedule.nativeTime')}</dd></div>
          {nextRun !== undefined && enabled && <div><dt>{t('review.schedule.next')}</dt><dd>{nextRun}</dd></div>}
          <div><dt>{t('review.schedule.summary')}</dt><dd>{status.summary
            ? <details className="ac-review-task-summary"><summary>{t('review.schedule.expandSummary')}</summary><pre>{status.summary}</pre></details>
            : t('review.schedule.noSummary')}</dd></div>
        </dl>}
        {error !== undefined && <p className="ac-review-error" role="alert">{t('review.schedule.error', { error })}</p>}
        {navigationResult === 'failed' && <p className="ac-review-error" role="alert">{t('review.schedule.navigationError')}</p>}
        {navigationResult === 'opened' && <p className="ac-hint" role="status">{t('review.schedule.opened')}</p>}
      </div>
    </div>
  )
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

export function Row(props: Props & { children: ReactNode }): ReactNode {
  const { id, field, disabled, form } = props
  return (
    <div className="ac-row" data-wide="">
      <div className="ac-row-text">
        <div className="ac-row-head">
          <label className="ac-label" htmlFor={`ac-field-${id}`}>{t(id as ConfigKey)}</label>
          <span className="ac-badges">
            {field.overridden
              ? <>
                  <span className="ac-tag">{t('overridden')}</span>
                  <button type="button" className="ac-link" disabled={disabled} onClick={() => form.reset(id)}>{t('reset')}</button>
                </>
              : <span className="ac-muted">{t('default')}</span>}
          </span>
        </div>
        <p className="ac-hint">{t(`${id}.hint` as ConfigKey)}</p>
      </div>
      <div className="ac-control">{props.children}</div>
    </div>
  )
}

/** `review.repos`: the repositories whose pull requests are reviewed, as main working tree paths. */
export function ReviewReposField(props: Props & { repos?: ReposStore }): ReactNode {
  const store = props.repos
  const snapshot = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => ({ repos: undefined, error: null })))
  useEffect(() => { void store?.load() }, [store])
  const value = strings(props.field.value)
  const known = snapshot.repos ?? []
  const stale = value.filter((path) => !known.some((group) => samePath(group.key, path)))
  const options = [...known.map((group) => ({ key: group.key, name: group.name })), ...stale.map((path) => ({ key: path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path }))]
  const checked = (key: string): boolean => value.some((path) => samePath(path, key))
  const toggle = (key: string): void => props.form.edit(props.id, checked(key) ? value.filter((path) => !samePath(path, key)) : [...value, key])
  return (
    <Row {...props}>
      {snapshot.repos === undefined && snapshot.error === null
        ? <span className="ac-muted ac-route-status" role="status">{t('conn.repos.loading')}</span>
        : options.length === 0
          ? <span className="ac-muted ac-route-status">{snapshot.error ?? t('conn.repos.empty')}</span>
          : (
            <div className="ac-checks" id={`ac-field-${props.id}`}>
              {options.map((option) => (
                <label key={option.key} className="ac-check" data-disabled={props.disabled ? '' : undefined} title={option.key}>
                  <input type="checkbox" checked={checked(option.key)} disabled={props.disabled} onChange={() => toggle(option.key)} />
                  <span className="ac-check-label">{option.name}</span>
                  <span className="ac-check-detail">{option.key}</span>
                </label>
              ))}
            </div>
          )}
    </Row>
  )
}

/** `review.bot`: one of the bots; a saved one that no longer exists stays listed and marked. `optional`: blank (no bot) is offered too. */
export function BotField(props: Props & { bots: readonly string[]; optional?: boolean }): ReactNode {
  const current = typeof props.field.value === 'string' ? props.field.value : ''
  const listed = props.bots.includes(current) || (props.optional === true && current === '')
  return (
    <Row {...props}>
      <select id={`ac-field-${props.id}`} className="ac-input ac-select" disabled={props.disabled} value={current}
        onChange={(event) => props.form.edit(props.id, event.target.value)}>
        {props.optional === true && <option value="">{t(`${props.id}.none` as ConfigKey)}</option>}
        {!listed && <option value={current}>{current === '' ? t('review.bot.none') : t('review.bot.missing', { id: current })}</option>}
        {props.bots.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
    </Row>
  )
}
