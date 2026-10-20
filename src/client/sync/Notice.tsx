/**
 * What happened by itself at startup, announced once: conflicts the startup pull left for a
 * choice, the remote's changes it applied, and how the upgrades the last restart ran went. One
 * announcement at a time, the most pressing first; each is dismissed for this window.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { t } from '../config/i18n.ts'
import type { PluginUpdatesStore } from '../plugins/api.ts'
import type { SyncStore } from './api.ts'

const DISMISSED_KEY = 'dsh-agent-hub.sync.dismissed'

const remembered = (): string[] => {
  try {
    const value = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function SyncNotice(props: { store: SyncStore; plugins: PluginUpdatesStore; onOpen(): void }): ReactNode {
  const { status } = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const updates = useSyncExternalStore(props.plugins.subscribe, props.plugins.getSnapshot).status
  const [dismissed, setDismissed] = useState(remembered)
  useEffect(() => { void props.store.load() }, [props.store])
  useEffect(() => { void props.plugins.load() }, [props.plugins])

  const notices: Array<{ key: string; text: string; tone?: 'bad' }> = []
  const conflicts = status?.conflicts
  if (conflicts !== undefined) notices.push({ key: `conflicts:${conflicts.remote ?? ''}:${conflicts.items.map((item) => item.key).join(',')}`, text: t('sync.notice.conflicts', { n: conflicts.items.length }) })
  const run = updates?.lastRun
  if (run !== undefined) {
    notices.push(run.ok
      ? { key: `upgraded:${run.at}`, text: t('sync.notice.upgraded', { list: run.ops.map((op) => `${op.name}@${op.spec}`).join(', ') }) }
      : { key: `upgradeFailed:${run.at}`, text: t('sync.notice.upgradeFailed', { error: run.error ?? '' }), tone: 'bad' })
  }
  const last = status?.last
  const applied = last?.applied.reduce((sum, group) => sum + group.changes.length, 0) ?? 0
  if (last?.kind === 'pull' && last.auto === true && applied > 0) {
    notices.push({ key: `pulled:${last.at}`, text: t(last.restart ? 'sync.notice.pulledRestart' : 'sync.notice.pulled', { n: applied }) })
  }
  const notice = notices.find((item) => !dismissed.includes(item.key))
  if (notice === undefined) return null
  const dismiss = (): void => {
    const next = [...dismissed, notice.key].slice(-20)
    setDismissed(next)
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // Dismissed for this page only.
    }
  }
  return (
    <div className="ac-sync-notice" role="status" data-tone={notice.tone}>
      <span>{notice.text}</span>
      <button type="button" className="ah-btn" data-variant="primary" onClick={() => { dismiss(); props.onOpen() }}>{t('sync.notice.open')}</button>
      <button type="button" className="ah-btn" onClick={dismiss}>{t('sync.notice.dismiss')}</button>
    </div>
  )
}
