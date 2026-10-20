/**
 * Notices for outside work that finished while DSH was open, over the whole
 * window: a glasses or app task, a cloud session, a Hermes cron run that
 * answered or failed. View opens 接力 on that thread. At most three; each
 * leaves after a few seconds unless pointed at or focused, and none shows
 * while the panel itself is on screen. The page follows the list for them
 * without sampling processes (the panel alone does that).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Finished, RelayStore } from './api.ts'
import { IconClose, PhaseMark } from './icons.tsx'
import { t } from './i18n.ts'

const NOTICE_MS = 8000
const NOTICE_MAX = 3

interface Notice extends Finished {
  id: number
}

let seq = 0

export function RelayNotices(props: { store: RelayStore; view(key: string): void }): ReactNode {
  const { store } = props
  const [notices, setNotices] = useState<Notice[]>([])
  useEffect(() => store.poll(false), [store])
  useEffect(() => store.onFinished((event) => {
    if (store.shown) return
    setNotices((list) => [...list.filter((notice) => notice.thread.key !== event.thread.key), { ...event, id: ++seq }].slice(-NOTICE_MAX))
  }), [store])
  const dismiss = useCallback((id: number): void => setNotices((list) => list.filter((notice) => notice.id !== id)), [])
  if (notices.length === 0) return null
  return (
    <div className="rl-notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <Item key={notice.id} notice={notice} onDismiss={dismiss} onView={() => {
          dismiss(notice.id)
          props.view(notice.thread.key)
        }} />
      ))}
    </div>
  )
}

function Item(props: { notice: Notice; onView(): void; onDismiss(id: number): void }): ReactNode {
  const { onDismiss } = props
  const { id, thread, phase } = props.notice
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => onDismiss(id), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [held, onDismiss, id])
  const agent = thread.agent === 'qoder' ? 'Qoder' : `Hermes · ${thread.persona}`
  return (
    <div className="rl-notice" data-phase={phase} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false) }}>
      <span className="rl-notice-mark" aria-hidden="true"><PhaseMark phase={phase} /></span>
      <span className="rl-notice-text">
        <span className="rl-notice-title">{t(phase === 'failed' ? 'notice.failed' : 'notice.done', { agent })}</span>
        <span className="rl-notice-sub" title={thread.title}>{thread.title}</span>
      </span>
      <button type="button" className="rl-notice-view" onClick={props.onView}>{t('notice.view')}</button>
      <button type="button" className="ah-icon-btn rl-notice-close" aria-label={t('dismiss')} title={t('dismiss')} onClick={() => onDismiss(id)}><IconClose /></button>
    </div>
  )
}
