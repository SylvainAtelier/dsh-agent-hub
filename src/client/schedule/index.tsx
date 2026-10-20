/** Plain-text scheduling in the composer's public right-hand slot. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { surfaceOf } from '../usage/surface.ts'
import { SCHEDULE_METHOD, type Route, type ScheduledSend, type ScheduleOptions, type ScheduleReply, type ScheduleRequest } from '../../schedule/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'
import { clearSubmittedDraft, draftIssue, localFields, localInstant, type InputActions, type InputSnapshot } from './draft.ts'
import { t } from './i18n.ts'
import { injectScheduleStyle } from './style.ts'
import { createPendingHub, type PendingHub, type ScheduleRemote } from './pending.ts'
import { PendingDock, usePending, type DockProps } from './dock.tsx'

type Select<S> = <T>(select: (state: S) => T) => T
interface SessionState { removed: boolean; subagent: unknown | null }
interface Props {
  sessionId: string
  useInput: Select<InputSnapshot | undefined>
  useSession: Select<SessionState>
  useProjection(key: 'modelSelection'): { next?: Route | null } | undefined
  inputActions: InputActions
  call(request: ScheduleRequest): Promise<ScheduleReply<ScheduleOptions | ScheduledSend>>
  openTask(sessionId: string, id: string): boolean
  pending: PendingHub
}
interface ClientContext {
  effect(body: () => () => void, label?: string): void
  get(name: string): unknown
  on(event: 'connection/reset', listener: () => void): () => void
  slots: {
    inject(name: string, body: () => () => void): void
    register<P>(entry: object, component: (props: P) => unknown): () => void
  }
  inject(deps: string[], body: (scope: ClientContext & { remote: ScheduleRemote }) => void): void
}
const identity = <T,>(value: T): T => value
const formatTime = (instant: string): string => new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(instant))

function Clock(): ReactNode {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>
}

/** Placement follows the actual composer width, not only the browser's viewport. */
function placeDialog(dialog: HTMLDialogElement, trigger: HTMLButtonElement): void {
  const viewport = window.visualViewport
  const left = viewport?.offsetLeft ?? 0
  const top = viewport?.offsetTop ?? 0
  const width = viewport?.width ?? window.innerWidth
  const height = viewport?.height ?? window.innerHeight
  const rect = trigger.getBoundingClientRect()
  const composer = trigger.closest('[data-composer-card]')?.getBoundingClientRect()
  const sheet = width <= 600 || (composer !== undefined && composer.width < 480)
  dialog.toggleAttribute('data-sheet', sheet)
  dialog.style.maxHeight = `${Math.max(160, height - 24)}px`
  dialog.style.width = `${Math.min(sheet ? width - 16 : 392, width - 16)}px`
  const box = dialog.getBoundingClientRect()
  dialog.style.left = `${sheet ? left + 8 : Math.max(left + 8, Math.min(rect.right - box.width, left + width - box.width - 8))}px`
  dialog.style.top = `${sheet ? Math.max(top + 8, top + height - box.height) : Math.max(top + 8, Math.min(rect.top - box.height - 10, top + height - box.height - 8))}px`
}

function ScheduleControl(props: Props): ReactNode {
  const input = props.useInput(identity)
  const session = props.useSession(identity)
  const model = props.useProjection('modelSelection')
  const latest = useRef(input)
  latest.current = input
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ScheduleOptions>()
  const [loading, setLoading] = useState(false)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const choiceTouched = useRef(false)
  const [mode, setMode] = useState<'preset' | 'custom'>('preset')
  const [date, setDate] = useState(() => localFields(new Date(Date.now() + 3600_000)).date)
  const [time, setTime] = useState(() => localFields(new Date(Date.now() + 3600_000)).time)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [settled, setSettled] = useState(true)
  const attempt = useRef<{ request: Extract<ScheduleRequest, { op: 'create' }>; snapshot: InputSnapshot }>()
  const [saved, setSaved] = useState<ScheduledSend>()
  const [retained, setRetained] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  const pending = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const dialogId = useId()
  const titleId = useId()
  const issue = draftIssue(input)
  const scheduled = usePending(props.pending, props.sessionId).tasks.length
  const unavailable = session.removed || session.subagent != null
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  useEffect(() => {
    if (!open || saved !== undefined || uncertain) return
    let active = true
    setLoading(true)
    setError('')
    setOptions(undefined)
    setQuotaLoading(false)
    choiceTouched.current = false
    void (async () => {
      try {
        // Capability/model lookup is independent of quota I/O: custom time becomes usable immediately.
        const initial = await props.call({ op: 'options', sessionId: props.sessionId, quota: false })
        if (!active) return
        setLoading(false)
        if (!initial.ok) { setError(t(`error.${initial.code}`)); return }
        const base = initial.value as ScheduleOptions
        setOptions(base)
        setMode('custom')
        if (!base.available) return
        setQuotaLoading(true)
        try {
          const reply = await props.call({ op: 'options', sessionId: props.sessionId, quota: true })
          if (!active || pending.current) return
          if (!reply.ok) { setOptions({ ...base, reason: 'stale' }); return }
          const value = reply.value as ScheduleOptions
          setOptions(value)
          if (!choiceTouched.current) setMode(value.suggestion === undefined ? 'custom' : 'preset')
        } catch { if (active) setOptions({ ...base, reason: 'stale' }) }
      } catch { if (active) setError(t('error.load')) }
      finally { if (active) { setLoading(false); setQuotaLoading(false) } }
    })()
    return () => { active = false }
  }, [open, props.sessionId, props.call, refresh, model?.next?.provider, model?.next?.model, saved, uncertain])

  useLayoutEffect(() => {
    const element = dialog.current
    const anchor = trigger.current
    if (!open || element === null || anchor === null) return
    // Resolve an opaque surface before entering the top layer; lazy currentColor/Canvas
    // fallbacks otherwise paint white-on-white primary actions or a light sheet in dark mode.
    const surface = surfaceOf(anchor)
    element.style.setProperty('--ah-popup', surface.background)
    element.style.setProperty('--ah-bg', surface.background)
    element.style.setProperty('--ah-fg', surface.color)
    element.showModal()
    const place = (): void => placeDialog(element, anchor)
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      element.close()
      if (anchor.isConnected) anchor.focus({ preventScroll: true })
    }
  }, [open])

  // Async quota/error content changes must be placed before paint, not one observer frame later.
  useLayoutEffect(() => {
    if (open && dialog.current !== null && trigger.current !== null) placeDialog(dialog.current, trigger.current)
  })

  const close = (): void => { if (!pending.current) setOpen(false) }
  const submit = async (): Promise<void> => {
    const snapshot = latest.current
    if (pending.current || uncertain || saved || snapshot === undefined || draftIssue(snapshot) !== undefined || !options?.available || loading || unavailable) return
    const target = mode === 'preset' && options.suggestion !== undefined ? { at: options.suggestion.at } : localInstant(date, time)
    if ('error' in target) { setError(t(`error.${target.error}`)); return }
    if (Date.parse(target.at) <= Date.now()) { setError(t('error.not-future')); return }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const request: Extract<ScheduleRequest, { op: 'create' }> = {
        op: 'create', sessionId: props.sessionId, requestId: crypto.randomUUID(), prompt: snapshot.draft, at: target.at,
        ...(options.route === undefined ? {} : { expectedRoute: options.route }),
        ...(options.effectiveRoute === undefined ? {} : { expectedEffectiveRoute: options.effectiveRoute }),
        ...(mode !== 'preset' ? {} : { suggestion: options.suggestion }),
      }
      attempt.current = { request, snapshot }
      const result = await props.call(request)
      if (!alive.current) return
      if (!result.ok) {
        setError(t(`error.${result.code}`))
        if (result.code === 'create-uncertain') { setUncertain(true); setSettled(true) }
        return
      }
      setSaved(result.value as ScheduledSend)
      setRetained(!clearSubmittedDraft(props.inputActions, snapshot, latest.current))
    } catch {
      if (alive.current) { setError(t('error.create-uncertain')); setUncertain(true); setSettled(false) }
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const reconcile = async (): Promise<void> => {
    if (pending.current || attempt.current === undefined) return
    pending.current = true
    setBusy(true)
    const previous = attempt.current
    try {
      const reply = await props.call({ op: 'result', sessionId: props.sessionId, requestId: previous.request.requestId })
      if (!alive.current) return
      if (reply.ok) {
        setSaved(reply.value as ScheduledSend)
        setRetained(!clearSubmittedDraft(props.inputActions, previous.snapshot, latest.current))
      } else {
        setError(t(`error.${reply.code}`))
        // Only a settled host reply makes another deliberate attempt safe. A missing
        // host-local identity after restart is not evidence that the task was never written.
        setSettled(reply.code !== 'request-missing')
      }
    } catch { if (alive.current) setError(t('error.create-uncertain')) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return <>
    <button ref={trigger} type="button" className="ah-schedule-trigger" data-pending={scheduled > 0 || undefined}
      aria-label={scheduled > 0 ? t('pending.trigger', { count: String(scheduled) }) : t('title')} title={scheduled > 0 ? t('pending.trigger', { count: String(scheduled) }) : t('title')}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} disabled={unavailable}
      onClick={() => {
        if (saved !== undefined) { setSaved(undefined); setRetained(false) }
        // The default was taken when the composer mounted; one that has since passed moves to an hour from now.
        const custom = localInstant(date, time)
        if ('error' in custom && custom.error === 'not-future') {
          const next = localFields(new Date(Date.now() + 3600_000))
          setDate(next.date)
          setTime(next.time)
        }
        setOpen(true)
      }}><Clock /></button>
    {open && createPortal(
      <dialog ref={dialog} id={dialogId} className="ah-schedule-dialog" aria-labelledby={titleId}
        onCancel={(event) => { event.preventDefault(); close() }} onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
        }}>
        <div className="ah-schedule-body">
          <div className="ah-schedule-head"><h2 id={titleId}>{t('title')}</h2><button type="button" className="ah-schedule-close" disabled={busy} aria-label={t('close')} onClick={close}>
            <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button></div>
          {saved !== undefined ? <>
            <p role="status">{t('saved', { time: formatTime(saved.scheduledAt) })}</p>
            {retained && <p className="ah-schedule-muted">{t('retained')}</p>}
            <div className="ah-schedule-foot"><button className="ah-btn" onClick={close}>{t('close')}</button><button className="ah-btn" data-variant="primary" onClick={() => { if (props.openTask(saved.sessionId, saved.id)) close() }}>{t('manage')}</button></div>
          </> : <>
            {(loading || quotaLoading) && <p className="ah-schedule-muted" role="status">{t('loading')}</p>}
            {options?.available === false ? <p className="ah-schedule-error">{t('disabled')}</p> : <>
              {options?.route && <p className="ah-schedule-muted">{options.route.provider} / {options.route.model}{options.suggestion?.account ? ` · ${options.suggestion.account}` : ''}</p>}
              <div className="ah-schedule-options" role="radiogroup" aria-label={t('time')} onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
                const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')]
                const index = radios.indexOf(event.target as HTMLButtonElement)
                if (index < 0 || radios.length === 0) return
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1
                  : (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + radios.length) % radios.length
                radios[next].click()
                radios[next].focus()
              }}>
                {options?.suggestion && <button type="button" className="ah-schedule-choice" role="radio" aria-checked={mode === 'preset'} tabIndex={mode === 'preset' ? 0 : -1} disabled={busy || uncertain}
                  onClick={() => { choiceTouched.current = true; setMode('preset'); setError('') }}>
                  <strong>{t(options.suggestion.kind === 'recovery' ? 'recovery' : 'reset')} · {formatTime(options.suggestion.at)}</strong>
                  <span className="ah-schedule-muted">{t('buffer', { windows: options.suggestion.windows.join(' / '), time: formatTime(options.suggestion.resetAt) })}</span>
                  {options.suggestion.kind === 'reset' && <span className="ah-schedule-muted">{t('available')}</span>}
                </button>}
                <button type="button" className="ah-schedule-choice" role="radio" aria-checked={mode === 'custom'} tabIndex={mode === 'custom' ? 0 : -1} disabled={busy || uncertain}
                  onClick={() => { choiceTouched.current = true; setMode('custom'); setError('') }}><strong>{t('custom')}</strong></button>
              </div>
              {mode === 'custom' && <div className="ah-schedule-dates"><label>{t('date')}<input type="date" value={date} disabled={busy || uncertain} onChange={(event) => { choiceTouched.current = true; setDate(event.target.value); setError('') }} /></label>
                <label>{t('time')}<input type="time" value={time} disabled={busy || uncertain} onChange={(event) => { choiceTouched.current = true; setTime(event.target.value); setError('') }} /></label></div>}
              <p className="ah-schedule-muted">{t('timezone', { zone })}</p>
              {options?.reason && <p className="ah-schedule-muted">{t(`reason.${options.reason}`)}</p>}
              {!loading && !quotaLoading && !uncertain && <button type="button" className="ah-btn" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>{t('refresh')}</button>}
              {input?.draft.trim() && <div className="ah-schedule-preview" aria-label={t('preview')}>{input.draft}</div>}
              {issue && <p className="ah-schedule-error">{t(`draft.${issue}`)}</p>}
              <p className="ah-schedule-muted">{t('follows')}</p>
              <div className="ah-schedule-foot"><button type="button" className="ah-btn" disabled={busy} onClick={close}>{t('cancel')}</button>
                <button type="button" className="ah-btn" data-variant="primary" disabled={busy || uncertain || loading || !options?.available || issue !== undefined || unavailable}
                  onClick={() => void submit()}>{t(busy ? 'creating' : 'create')}</button></div>
            </>}
            {error && <p className="ah-schedule-error" role="alert">{error}</p>}
            {uncertain && <button type="button" className="ah-btn" disabled={busy} onClick={() => {
              if (!settled) { void reconcile(); return }
              setUncertain(false); setError(''); setRefresh((value) => value + 1)
            }}>{t(!settled ? 'reconcile' : 'checked')}</button>}
          </>}
        </div>
      </dialog>, document.body)}
  </>
}

export function applySchedule(ctx: ClientContext, rpc: Rpc): void {
  ctx.effect(injectScheduleStyle, 'dsh-agent-hub: scheduled send style')
  const call: Props['call'] = (request) => rpcValue(rpc, SCHEDULE_METHOD, request, 'Scheduled send failed', AbortSignal.timeout(request.op === 'create' || request.op === 'result' ? 45_000 : 35_000))
  const openTask = (sessionId: string, id: string): boolean => {
    const sidebar = ctx.get('sidebarRight') as { openTab?(kind: string, options: { params: { sessionId: string; id: string } }): void } | undefined
    if (sidebar?.openTab === undefined) return false
    sidebar.openTab('scheduleTask', { params: { sessionId, id } })
    return true
  }
  const pending = createPendingHub()
  // Hosts without this public slot simply have no entry; do not replace their composer or scan its DOM.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'dsh-agent-hub.scheduled-send', order: 20,
    inject: () => ({ call, openTask, pending }),
  }, (props: Props) => <ScheduleControl key={props.sessionId} {...props} />))
  // Pending hints read the official task list only while its Remote face is mounted.
  ctx.inject(['remote', 'remote.schedule'], (scope) => {
    scope.effect(() => pending.attach(scope.remote, (listener) => scope.on('connection/reset', listener)), 'dsh-agent-hub: scheduled send pending')
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: 'dsh-agent-hub.scheduled-pending', order: 30,
      inject: (sessionId: string): DockProps => ({ sessionId, pending, openTask }),
    }, (props: DockProps) => <PendingDock key={props.sessionId} {...props} />))
  })
}
