/** Explicit-save script definitions; time controls remain in DSH's native manager. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ScriptTask, TaskRun, TaskStatus } from '../../automation/types.ts'
import { AutomationStore, EXTERNAL_AUTOMATION_PROVIDERS, clockTime, localClock, parseArguments, pastClock, remaining, runDuration, runInstant, runKind, runTone, taskRuns, validDefinition, zoneName, type AutomationSnapshot, type RunTone } from '../automation/api.ts'
import { RoutePicker } from './route.tsx'
import type { ModelDirectory } from './models.ts'
import { t, type ConfigKey } from './i18n.ts'

/** The id the Qoder CN template's task is saved under (index.ts). */
const QODER_TEMPLATE = 'qoder-cn-daily-credit'

const unavailable: AutomationSnapshot = {}
const noSubscribe = (): (() => void) => () => {}
const blank = (): ScriptTask => ({ id: '', title: '', command: '', args: [], cwd: '', provider: '', model: '', timeoutMs: 300000 })
const preview = (task: ScriptTask): string => JSON.stringify({ command: task.command, args: task.args, cwd: task.cwd, timeoutMs: task.timeoutMs, provider: task.provider, model: task.model }, null, 2)

const localZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined } }
const locale = (): string => typeof document !== 'undefined' && document.documentElement.lang ? document.documentElement.lang : 'zh-CN'

/** Re-renders on each minute boundary only; not a live region (the absolute time carries the meaning). */
function Countdown(props: { at: string }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const delay = (): number => 60_000 - Date.now() % 60_000 + 50
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => { setNow(Date.now()); timer = setTimeout(tick, delay()) }
    timer = setTimeout(tick, delay())
    return () => clearTimeout(timer)
  }, [props.at])
  const left = remaining(Date.parse(props.at), now)
  const text = !left ? t('automation.due') : left.days ? t('automation.leftDays', { d: left.days, h: left.hours }) : left.hours ? t('automation.leftHours', { h: left.hours, m: left.minutes }) : t('automation.leftMinutes', { m: left.minutes })
  return <span className="ac-countdown" data-due={left ? undefined : ''}>{text}</span>
}

/** Configured wall time in its own zone, plus what that is on this computer when the zones differ. */
function ScheduleTime(props: { time?: string; timeZone?: string; nextRun?: string }): ReactNode {
  if (!props.time) return t('automation.nativeTime')
  const zone = props.timeZone
  const main = `${clockTime(props.time)}${zone ? ` ${zoneName(zone, locale())}` : ''}`
  const here = localZone()
  const local = zone && here && zone !== here && props.nextRun ? localClock(props.nextRun, Date.now()) : undefined
  return <>{main}{local && <span className="ac-local-time">{t('automation.localEquivalent', { time: local.time })}</span>}</>
}

function NextRun(props: { at: string }): ReactNode {
  const clock = localClock(props.at, Date.now())
  if (!clock) return props.at
  const day = clock.day === 'date' ? clock.date : t(clock.day === 'today' ? 'automation.today' : 'automation.tomorrow')
  return <span className="ac-next-run"><time dateTime={props.at}>{t('automation.localAt', { day, time: clock.time })}</time><Countdown at={props.at} /></span>
}

const ICONS: Record<RunTone, ReactNode> = {
  ok: <path d="M5.5 8.2 7.2 9.9 10.6 6.3" />,
  error: <path d="M6 6l4 4M10 6l-4 4" />,
  unknown: <><path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1v.3" /><path d="M8 11.2v.1" /></>,
  running: <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />,
  pending: <path d="M8 5v3.2l2 1.3" />,
  stalled: <><path d="M8 4.8v3.8" /><path d="M8 11.1v.1" /></>,
}
/** Decorative: the status label beside it carries the meaning. */
function runIcon(tone: RunTone): ReactNode {
  return <svg className="ac-run-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    {tone === 'running' ? <circle cx="8" cy="8" r="5.5" opacity=".25" /> : <circle cx="8" cy="8" r="6.25" />}
    {ICONS[tone]}
  </svg>
}
function runWhen(run: TaskRun, now: number): ReactNode {
  const at = runInstant(run)
  const clock = at ? pastClock(at, now) : undefined
  if (!at || !clock) return undefined
  const day = clock.day === 'date' ? clock.date : t(clock.day === 'today' ? 'automation.today' : 'automation.yesterday')
  return <time dateTime={at} title={new Date(at).toLocaleString(locale())}>{day} {clock.time}</time>
}
function durationText(ms: number): string {
  if (ms < 60_000) return t('automation.seconds', { s: (ms / 1000).toFixed(1) })
  const seconds = Math.round(ms / 1000)
  return t('automation.minutes', { m: Math.floor(seconds / 60), s: seconds % 60 })
}
/** Time, trigger, duration and a non-zero exit code: the facts that tell two runs apart. */
function runMeta(run: TaskRun, now: number): ReactNode {
  const duration = runDuration(run)
  const parts: ReactNode[] = [runWhen(run, now), t(runKind(run) === 'manual' ? 'automation.kind.manual' : 'automation.kind.scheduled')]
  if (duration !== undefined) parts.push(durationText(duration))
  if (run.code !== undefined && run.code !== 0) parts.push(t('automation.exitCode', { code: run.code }))
  return parts.filter((part) => part !== undefined).map((part, index) => <span key={index}>{part}</span>)
}
const HINTS: Partial<Record<RunTone, ConfigKey>> = { unknown: 'automation.hint.unknown', stalled: 'automation.hint.stalled', pending: 'automation.hint.pending' }
/** The latest outcome up front, older runs one disclosure away; no raw JSON. */
function runPanel(status: TaskStatus | undefined): ReactNode {
  const now = Date.now()
  const [latest, ...older] = taskRuns(status)
  if (!latest) return <p className="ac-run-empty" role="status">{t('automation.noRun')}</p>
  const tone = runTone(latest, now)
  const hint = HINTS[tone]
  return <div className="ac-runs">
    <div className="ac-run-latest" data-tone={tone} role="status" aria-live="polite" aria-atomic="true">
      {runIcon(tone)}
      <div className="ac-run-body">
        <p className="ac-run-line"><span className="ac-visually-hidden">{t('automation.latest')}</span><strong className="ac-run-label">{t(`automation.tone.${tone}`)}</strong><span className="ac-run-meta">{runMeta(latest, now)}</span></p>
        {latest.summary && latest.status !== 'running' && <p className="ac-run-summary">{latest.summary}</p>}
        {hint && <p className="ac-run-hint">{t(hint)}</p>}
      </div>
    </div>
    {older.length > 0 && <details className="ac-run-history">
      <summary>{t('automation.history', { n: older.length })}</summary>
      <ol className="ac-run-list">{older.map((run, index) => {
        const rowTone = runTone(run, now)
        return <li key={run.occurrence ?? index} className="ac-run-row" data-tone={rowTone}>
          {runIcon(rowTone)}
          <div className="ac-run-body">
            <p className="ac-run-line"><strong className="ac-run-label">{t(`automation.tone.${rowTone}`)}</strong><span className="ac-run-meta">{runMeta(run, now)}</span></p>
            {run.summary && <p className="ac-run-summary">{run.summary}</p>}
          </div>
        </li>
      })}</ol>
    </details>}
  </div>
}

export function AutomationPanel(props: { store?: AutomationStore; models: ModelDirectory; disabled: boolean; openTask?: (sessionId: string, id: string) => boolean }): ReactNode {
  const { store } = props
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? (() => unavailable))
  const [draft, setDraft] = useState<ScriptTask | undefined>()
  const [expected, setExpected] = useState<ScriptTask | null>(null)
  const [args, setArgs] = useState('[]')
  const [invalid, setInvalid] = useState(false)
  const [saved, setSaved] = useState(false)
  const [navigationError, setNavigationError] = useState(false)
  const [confirm, setConfirm] = useState<ScriptTask | undefined>()
  const [confirmKind, setConfirmKind] = useState<'enable' | 'run'>('enable')
  const cancel = useRef<HTMLButtonElement>(null)
  const actionTrigger = useRef<HTMLButtonElement | null>(null)
  const editor = useRef<HTMLInputElement>(null)
  const validation = useRef<HTMLParagraphElement>(null)
  useEffect(() => store?.watch(), [store])
  useEffect(() => { if (confirm !== undefined) cancel.current?.focus() }, [confirm])
  useEffect(() => { if (draft) editor.current?.focus() }, [draft?.id === undefined])
  useEffect(() => { if (invalid) validation.current?.focus() }, [invalid])
  const busy = snapshot.busy !== undefined
  const blocked = props.disabled || !store || busy || snapshot.uncertain === true || !snapshot.reply
  const definitions = snapshot.reply?.definitions ?? []
  const selectedStatus = draft ? snapshot.reply?.tasks.find((entry) => entry.id === draft.id) : undefined
  const activeDraft = selectedStatus?.enabled === true || selectedStatus?.run?.status === 'running'
  const edit = (task: ScriptTask, original: ScriptTask | null): void => {
    setDraft({ ...task, args: [...task.args] }); setExpected(original); setArgs(JSON.stringify(task.args, null, 2)); setInvalid(false); setSaved(false)
  }
  const closeConfirm = (): void => { setConfirm(undefined); actionTrigger.current?.focus() }
  const confirmation = confirm
  return <div className="ac-row ac-automation" data-wide="" aria-busy={busy}>
    <div className="ac-control ac-automation-body">
      <div className="ac-review-schedule-actions">
        <button type="button" className="ah-btn" disabled={blocked || draft !== undefined} onClick={() => edit(blank(), null)}>{t('automation.add')}</button>
        <button type="button" className="ah-btn" disabled={!store || busy} onClick={() => void store?.request()}>{t('automation.refresh')}</button>
      </div>
      {/* The Qoder CN template, only where it can work and while no task of it exists. */}
      {snapshot.reply?.presetAvailable === true && draft === undefined && !definitions.some((task) => task.id === QODER_TEMPLATE) && (
        <div className="ac-template">
          <svg className="ac-template-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
          <p className="ac-template-text"><strong>{t('automation.template')}</strong><span>{t('automation.templateNote')}</span></p>
          <button type="button" className="ah-btn" disabled={blocked} onClick={async () => {
            const reply = await store?.request('preset'); if (reply?.preset) edit(reply.preset, null)
          }}>{t('automation.templateUse')}</button>
        </div>
      )}
      <p className="ac-hint" role="status">{busy ? t(snapshot.busy === 'list' ? 'automation.loading' : 'automation.busy') : !snapshot.reply ? t('automation.unknown') : saved ? t('automation.saved') : definitions.length === 0 ? t('automation.empty') : ''}</p>
      {snapshot.uncertain && <p className="ac-notice" role="alert">{t('automation.uncertain')}</p>}
      {snapshot.error && <p className="ac-review-error" role="alert">{snapshot.error}</p>}
      {navigationError && <p className="ac-review-error" role="alert">{t('automation.navigationError')}</p>}
      {definitions.map((task) => {
        const status = snapshot.reply?.tasks.find((entry) => entry.id === task.id)
        const manualRunning = status?.manual?.status === 'running'
        const locked = status?.enabled === true || status?.run?.status === 'running' || manualRunning
        const state = !status ? 'automation.unknown' : status.enabled ? 'automation.enabled' : 'automation.disabled'
        return <article key={task.id} className="ac-automation-task" aria-label={task.title}>
          <div className="ac-row-head"><strong>{task.title}</strong><span className="ac-tag ac-task-state" data-on={status?.enabled ? '' : undefined}>{t(state)}</span></div>
          <p className="ac-hint">{task.id}</p>
          {runPanel(status)}
          <dl className="ac-review-task-meta">
            <div><dt>{t('automation.schedule')}</dt><dd><ScheduleTime time={status?.time} timeZone={status?.timeZone} nextRun={status?.nextRun} /></dd></div>
            {status?.nextRun && <div><dt>{t('automation.next')}</dt><dd><NextRun at={status.nextRun} /></dd></div>}
          </dl>
          {status?.error && <p className="ac-review-error" role="alert">{status.error}</p>}
          {locked && <p className="ac-hint">{t('automation.locked')}</p>}
          <div className="ac-review-schedule-actions">
            <button type="button" className="ah-btn" aria-pressed={manualRunning || undefined} disabled={manualRunning ? !store || props.disabled : blocked || !status || draft !== undefined || status.run?.status === 'running'} onClick={(event) => {
              if (manualRunning) void store?.request('cancel', { id: task.id })
              else { actionTrigger.current = event.currentTarget; setConfirmKind('run'); setConfirm({ ...task, args: [...task.args] }) }
            }}>{t(manualRunning ? 'automation.runCancel' : 'automation.runNow')}</button>
            <button type="button" className="ah-btn" disabled={blocked || !status || manualRunning || (status.enabled !== true && draft !== undefined)} onClick={(event) => {
              if (status?.enabled) void store?.request('disable', { id: task.id })
              else { actionTrigger.current = event.currentTarget; setConfirmKind('enable'); setConfirm({ ...task, args: [...task.args] }) }
            }}>{t(status?.enabled ? 'automation.disable' : 'automation.enable')}</button>
            <button type="button" className="ah-btn" disabled={blocked || locked || draft !== undefined} onClick={() => edit(task, task)}>{t('automation.edit')}</button>
            <button type="button" className="ah-btn" disabled={blocked || locked || draft !== undefined} onClick={() => { if (window.confirm(t('automation.removeConfirm'))) void store?.request('remove', { id: task.id, expected: task }) }}>{t('automation.remove')}</button>
            <button type="button" className="ah-btn" disabled={!props.openTask || !status?.taskId || !status.sessionId} onClick={() => {
              try { setNavigationError(props.openTask?.(status!.sessionId!, status!.taskId!) !== true) } catch { setNavigationError(true) }
            }}>{t('automation.manage')}</button>
          </div>
        </article>
      })}
      {confirmation && <div className="ac-notice ac-review-confirm" role="group" aria-label={t(confirmKind === 'run' ? 'automation.runConfirmTitle' : 'automation.confirmTitle')} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeConfirm() } }}>
        <strong>{t(confirmKind === 'run' ? 'automation.runConfirmTitle' : 'automation.confirmTitle')}</strong><p>{t(confirmKind === 'run' ? 'automation.runRisk' : 'automation.risk')}</p><pre className="ac-automation-preview">{preview(confirmation)}</pre>
        <div className="ac-review-schedule-actions">
          <button type="button" className="ah-btn" ref={cancel} onClick={closeConfirm}>{t('automation.cancel')}</button>
          <button type="button" className="ah-btn" data-variant="primary" disabled={blocked || !validDefinition(confirmation)} onClick={() => { closeConfirm(); void store?.request(confirmKind, { id: confirmation.id, expected: confirmation }) }}>{t(confirmKind === 'run' ? 'automation.confirmRun' : 'automation.confirmEnable')}</button>
        </div>
      </div>}
      {draft && <form className="ac-automation-editor" onSubmit={async (event) => {
        event.preventDefault(); if (blocked || activeDraft) return
        let definition: ScriptTask
        try { definition = { ...draft, args: parseArguments(args) }; if (!validDefinition(definition)) throw new Error('Invalid definition') }
        catch { setInvalid(true); return }
        setInvalid(false)
        const reply = await store?.request('upsert', { definition, expected })
        if (reply) { setDraft(undefined); setSaved(true) }
      }}>
        <fieldset disabled={blocked || activeDraft}>
          <legend>{t('automation.edit')}</legend>
          {(['id', 'title', 'command', 'cwd', 'timeoutMs'] as const).map((key) => <label className="ac-automation-field" key={key}>
            <span>{t(`automation.${key === 'timeoutMs' ? 'timeout' : key}` as ConfigKey)}</span>
            <input ref={key === 'id' ? editor : undefined} aria-invalid={invalid || undefined} aria-describedby={invalid ? 'ac-automation-validation' : undefined} className="ac-input" type={key === 'timeoutMs' ? 'number' : 'text'} required min={key === 'timeoutMs' ? 1000 : undefined} max={key === 'timeoutMs' ? 3_600_000 : undefined} maxLength={key === 'id' || key === 'title' ? 120 : key === 'command' || key === 'cwd' ? 4096 : undefined} step={key === 'timeoutMs' ? 1 : undefined} value={draft[key]} disabled={key === 'id' && expected !== null} onChange={(event) => setDraft({ ...draft, [key]: key === 'timeoutMs' ? Number(event.target.value) : event.target.value })} />
          </label>)}
          <label className="ac-automation-field" htmlFor="ac-automation-args"><span>{t('automation.args')}</span></label>
          <textarea id="ac-automation-args" className="ac-input" rows={4} value={args} aria-describedby="ac-automation-args-hint" onChange={(event) => setArgs(event.target.value)} />
          <p className="ac-hint" id="ac-automation-args-hint">{t('automation.argsHint')}</p>
          <label className="ac-automation-field" htmlFor="ac-automation-route">{t('automation.route')}</label>
          <RoutePicker id="ac-automation-route" exclude={EXTERNAL_AUTOMATION_PROVIDERS} models={props.models} provider={draft.provider} model={draft.model} disabled={blocked || activeDraft} defaultLabel={t('automation.routeDefault')} onPick={(route) => setDraft({ ...draft, provider: route?.provider ?? '', model: route?.model ?? '' })} />
          <p className="ac-hint">{t('automation.routeHint')}</p>
          <button type="submit" className="ah-btn" data-variant="primary">{t('automation.save')}</button>
        </fieldset>
        {activeDraft && <p className="ac-notice">{t('automation.locked')}</p>}
        {invalid && <p id="ac-automation-validation" ref={validation} tabIndex={-1} className="ac-review-error" role="alert">{t('automation.invalid')}</p>}
        <button type="button" className="ah-btn" disabled={busy} onClick={() => { setDraft(undefined); setInvalid(false) }}>{t('automation.cancel')}</button>
      </form>}
    </div>
  </div>
}
