/** A glanceable strip above the composer: what this Session will receive, and when. */
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { relativeParts, type PendingHub, type PendingSnapshot, type PendingTask } from './pending.ts'
import { t } from './i18n.ts'

export function usePending(hub: PendingHub, sessionId: string): PendingSnapshot {
  const subscribe = useCallback((listener: () => void) => hub.subscribe(sessionId, listener), [hub, sessionId])
  return useSyncExternalStore(subscribe, () => hub.snapshot(sessionId))
}

/** Relative copy only needs minute precision; the clock stops when nothing is scheduled. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const locale = (): string => document.documentElement.lang || 'zh-CN'
function when(instant: string, now: number): string {
  const date = new Date(instant)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(locale(), sameDay ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
function distance(task: PendingTask, now: number): { text: string; overdue: boolean } {
  const target = Date.parse(task.scheduledAt)
  if (target <= now) return { text: t('pending.overdue'), overdue: true }
  const { unit, value } = relativeParts(target, now)
  return { text: t(`pending.${unit}`, { value: String(value) }), overdue: false }
}

function ClockIcon(): ReactNode {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>
}
function Chevron({ open }: { open: boolean }): ReactNode {
  return <svg className="ah-pending-chevron" data-open={open || undefined} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
}
function Arrow(): ReactNode {
  return <svg className="ah-pending-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
}

function Meta({ task, now, lead }: { task: PendingTask; now: number; lead?: string }): ReactNode {
  const gap = distance(task, now)
  return <span className="ah-pending-meta" data-overdue={gap.overdue || undefined}>
    {lead !== undefined && <span className="ah-pending-lead">{lead} · </span>}
    <time dateTime={task.scheduledAt}>{when(task.scheduledAt, now)}</time>
    <span className="ah-pending-gap"> · {gap.text}</span>
    {task.kind !== 'at' && <span className="ah-pending-repeat"> · {t('pending.repeat')}</span>}
  </span>
}

export interface DockProps { sessionId: string; pending: PendingHub; openTask(sessionId: string, id: string): boolean }

export function PendingDock({ sessionId, pending, openTask }: DockProps): ReactNode {
  const { tasks } = usePending(pending, sessionId)
  const now = useNow(tasks.length > 0)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  useEffect(() => { if (tasks.length < 2) setExpanded(false) }, [tasks.length])
  if (tasks.length === 0) return null
  const next = tasks[0]
  const overdue = Date.parse(next.scheduledAt) <= now
  const open = (task: PendingTask) => () => { openTask(sessionId, task.id) }
  return <div className="ah-pending-dock" role="region" aria-label={t('pending.region')}>
    <div className="ah-pending-panel" data-overdue={overdue || undefined}>
      {tasks.length === 1
        ? <button type="button" className="ah-pending-row ah-pending-head" title={t('pending.open', { title: next.title })} onClick={open(next)}>
          <span className="ah-pending-icon"><ClockIcon /></span>
          <span className="ah-pending-text"><span className="ah-pending-title">{next.title}</span><Meta task={next} now={now} /></span>
          <Arrow />
        </button>
        : <button type="button" className="ah-pending-row ah-pending-head" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((value) => !value)}>
          <span className="ah-pending-icon"><ClockIcon /><span className="ah-pending-count">{tasks.length}</span></span>
          <span className="ah-pending-text"><span className="ah-pending-title">{t('pending.count', { count: String(tasks.length) })}</span><Meta task={next} now={now} lead={t('pending.next')} /></span>
          <Chevron open={expanded} />
        </button>}
      {tasks.length > 1 && <ul id={listId} className="ah-pending-list" hidden={!expanded}>
        {tasks.map((task) => <li key={task.id}>
          <button type="button" className="ah-pending-row ah-pending-item" title={t('pending.open', { title: task.title })} onClick={open(task)}>
            <span className="ah-pending-text"><span className="ah-pending-title">{task.title}</span><Meta task={task} now={now} /></span>
            <Arrow />
          </button>
        </li>)}
      </ul>}
    </div>
  </div>
}
