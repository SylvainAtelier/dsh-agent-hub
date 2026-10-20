/**
 * 设置 → Agent Hub → Archify 结构图: where the plugin's install of the skill
 * stands, under the switch. Read again every two seconds while it installs; a
 * failed install offers to try again.
 */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { ModulesStore } from '../modules.ts'
import { t } from './i18n.ts'

export function ArchifyNote(props: { store: ModulesStore; on: boolean; disabled: boolean }): ReactNode {
  const { store, on } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const status = snapshot.status?.archify
  const phase = on ? status?.phase : 'off'
  // A switch just turned on: the host starts installing once the edit is saved.
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => void store.refresh(), 600)
    return () => clearTimeout(timer)
  }, [on, store])
  useEffect(() => {
    if (phase !== 'installing') return
    const timer = setInterval(() => void store.refresh(), 2000)
    return () => clearInterval(timer)
  }, [phase, store])
  if (status === undefined || phase === undefined || phase === 'off') return null

  const busy = snapshot.archifyBusy === true || phase === 'installing'
  const missing = (status.missing ?? []).map((need) => t(`prompt.archify.need.${need}`)).join(t('prompt.archify.and'))
  const text = busy
    ? t('prompt.archify.installing', { version: status.version })
    : phase === 'failed'
      ? t('prompt.archify.failed', { error: status.error ?? '' })
      : missing === ''
        ? t('prompt.archify.ready', { version: status.version })
        : t('prompt.archify.missing', { version: status.version, missing })
  const tone = busy ? 'running' : phase === 'failed' ? 'error' : missing === '' ? 'ok' : 'warn'
  return (
    <p className="ac-archify" role="status" data-tone={tone}>
      <span>{text}</span>
      {phase === 'failed' && !busy && (
        <button type="button" className="ac-link" disabled={props.disabled} onClick={() => void store.retryArchify()}>{t('retry')}</button>
      )}
    </p>
  )
}
