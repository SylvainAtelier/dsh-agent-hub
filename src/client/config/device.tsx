/**
 * 设置 → Agent Hub → Cardputer: the paired devices first, then pairing a new
 * one, then what dictation and speech recognition need on this computer. One
 * primary button at a time: 添加设备 while nothing is paired, 一致，配对
 * while the numbers are compared. Removing a device asks once more.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DeviceStatus, Pairing } from '../../device/types.ts'
import type { CardputerStore } from '../device/api.ts'
import { t } from './i18n.ts'

type DeviceEntry = DeviceStatus['devices'][number]

const ago = (ms: number): string => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return t('device.ago.now')
  if (minutes < 60) return t('device.ago.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  return hours < 48 ? t('device.ago.hours', { n: hours }) : new Date(ms).toLocaleDateString()
}

/** RSSI in words: what a person can act on (move closer), not dBm. */
const signal = (rssi: number): string => t(rssi >= -60 ? 'device.signal.good' : rssi >= -75 ? 'device.signal.fair' : 'device.signal.weak')

function stateLine(entry: DeviceEntry): string {
  if (!entry.online) return entry.seen === undefined ? t('device.never') : t('device.offline', { when: ago(entry.seen) })
  return [
    t('device.online'),
    ...(entry.bat === undefined ? [] : [t('device.battery', { n: entry.bat })]),
    ...(entry.rssi === undefined ? [] : [signal(entry.rssi)]),
    ...(entry.fw === undefined ? [] : [t('device.firmware', { fw: entry.fw })]),
  ].join(' · ')
}

export function DevicePanel(props: { store: CardputerStore; disabled: boolean }): ReactNode {
  const { store, disabled } = props
  const { status, busy, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => store.watch(), [store])
  if (status === undefined) return <div className="ac-row" data-wide=""><p className="ac-muted">{error ?? t('device.loading')}</p></div>
  const locked = disabled || (busy !== null && busy !== 'status')
  const pairing = status.pairing
  return (
    <div className="ac-row ac-dev" data-wide="">
      {status.devices.length > 0 && (
        <div className="ac-conns ac-dev-list">
          {status.devices.map((entry) => <DeviceRow key={entry.id} entry={entry} store={store} disabled={locked} />)}
        </div>
      )}
      {pairing !== null
        ? <PairingCard pairing={pairing} host={status.host} store={store} disabled={locked} />
        : (
          <div className="ac-dev-add">
            {status.devices.length === 0 && <p className="ac-hint">{t('device.intro')}</p>}
            <button type="button" className="ah-btn" data-variant={status.devices.length === 0 ? 'primary' : undefined} disabled={locked}
              onClick={() => void store.run({ op: 'pair' })}>{t('device.add')}</button>
          </div>
        )}
      <Readiness status={status} store={store} disabled={locked} />
      {error !== null && <p className="ac-notice" data-tone="bad" role="alert">{error}</p>}
    </div>
  )
}

function DeviceRow(props: { entry: DeviceEntry; store: CardputerStore; disabled: boolean }): ReactNode {
  const { entry, store, disabled } = props
  const [naming, setNaming] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  // A second press confirms; the question goes away by itself.
  useEffect(() => {
    if (!removing) return
    const timer = setTimeout(() => setRemoving(false), 4000)
    return () => clearTimeout(timer)
  }, [removing])
  return (
    <div className="ac-agent ac-conn" data-tone={entry.online ? 'ok' : undefined}>
      <div className="ac-conn-head">
        <span className="ac-avatar ac-dev-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" /><rect x="6" y="8" width="7" height="4" rx=".5" /><path d="M6 15h1M9 15h1M12 15h1M15 15h3" />
          </svg>
        </span>
        {naming === null
          ? (
            <div className="ac-agent-text">
              <span className="ac-conn-name">{entry.name}</span>
              <span className="ac-conn-state" role="status"><span className="ac-dot" aria-hidden="true" />{stateLine(entry)}</span>
            </div>
          )
          : (
            <form className="ac-dev-rename" onSubmit={(event) => {
              event.preventDefault()
              if (naming.trim() !== '') void store.run({ op: 'rename', id: entry.id, name: naming.trim() })
              setNaming(null)
            }}>
              <input className="ac-input" value={naming} maxLength={32} autoFocus aria-label={t('device.rename')}
                onChange={(event) => setNaming(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setNaming(null) }} />
              <button type="submit" className="ah-btn" data-variant="primary" disabled={disabled || naming.trim() === ''}>{t('device.save')}</button>
              <button type="button" className="ah-btn" onClick={() => setNaming(null)}>{t('device.cancel')}</button>
            </form>
          )}
        {naming === null && (
          <div className="ac-conn-actions">
            <button type="button" className="ac-link" disabled={disabled} onClick={() => setNaming(entry.name)}>{t('device.rename')}</button>
            <button type="button" className="ah-btn ac-conn-remove" data-confirm={removing ? '' : undefined} disabled={disabled}
              onClick={() => {
                if (!removing) return setRemoving(true)
                setRemoving(false)
                void store.run({ op: 'remove', id: entry.id })
              }}>{removing ? t('device.removeConfirm') : t('device.remove')}</button>
          </div>
        )}
      </div>
    </div>
  )
}

function PairingCard(props: { pairing: Pairing; host: string; store: CardputerStore; disabled: boolean }): ReactNode {
  const { pairing, store, disabled } = props
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (pairing.phase !== 'waiting') return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = (): void => {
      clearInterval(timer)
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', sync) }
  }, [pairing.phase])
  const cancel = <button type="button" className="ah-btn" disabled={disabled} onClick={() => void store.run({ op: 'pair-cancel' })}>{t('device.cancel')}</button>
  if (pairing.phase === 'waiting') {
    const left = Math.max(0, Math.ceil((pairing.until - now) / 1000))
    return (
      <div className="ac-dev-pair" data-tone="busy" aria-live="polite">
        <ol className="ac-dev-steps">
          <li data-current="">{t('device.step.pick', { host: props.host })}</li>
          <li>{t('device.step.compare')}</li>
        </ol>
        <p className="ac-hint" aria-live="off">{t('device.waiting', { n: left })}</p>
        <div className="ac-dev-actions">{cancel}</div>
      </div>
    )
  }
  if (pairing.phase === 'compare') {
    const code = `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`
    return (
      <div className="ac-dev-pair" data-tone="busy" aria-live="polite">
        <ol className="ac-dev-steps">
          <li data-done="">{t('device.step.pick', { host: props.host })}</li>
          <li data-current="">{t('device.step.compare')}</li>
        </ol>
        <p className="ac-dev-code" aria-label={pairing.code.split('').join(' ')}>{code}</p>
        <p className="ac-hint">{t('device.compare', { name: pairing.name })}</p>
        <div className="ac-dev-actions">
          {pairing.confirmed.host
            ? <span className="ac-hint" role="status">{t('device.waitDevice')}</span>
            : <button type="button" className="ah-btn" data-variant="primary" disabled={disabled} onClick={() => void store.run({ op: 'pair-confirm' })}>{t('device.match')}</button>}
          <button type="button" className="ah-btn" disabled={disabled} onClick={() => void store.run({ op: 'pair-cancel' })}>{t('device.mismatch')}</button>
        </div>
      </div>
    )
  }
  if (pairing.phase === 'done') {
    return <p className="ac-notice" data-tone="ok" role="status">{t('device.paired', { name: pairing.name })}</p>
  }
  return (
    <div className="ac-dev-pair" data-tone="bad" role="alert">
      <p className="ac-hint">{t(pairing.reason === 'timeout' ? 'device.failed.timeout' : pairing.reason === 'device left' ? 'device.failed.left' : 'device.failed', { reason: pairing.reason })}</p>
      <div className="ac-dev-actions">
        <button type="button" className="ah-btn" data-variant="primary" disabled={disabled} onClick={() => void store.run({ op: 'pair' })}>{t('device.retry')}</button>
      </div>
    </div>
  )
}

/** What this computer still needs: the port, speech recognition, dictation and its permission. */
function Readiness(props: { status: DeviceStatus; store: CardputerStore; disabled: boolean }): ReactNode {
  const { status, store, disabled } = props
  const [key, setKey] = useState('')
  const openai = status.stt.provider === 'openai'
  return (
    <>
      {status.link.state === 'listening' && (
        <p className="ac-hint">{t('device.link', { port: status.link.port, addresses: status.link.addresses.join(', ') || '—' })}</p>
      )}
      {status.link.state === 'error' && <p className="ac-notice" data-tone="bad">{t('device.linkError', { error: status.link.error })}</p>}
      {!status.typer.available && <p className="ac-notice">{t('device.noTyper')}</p>}
      {status.typer.permission === false && (
        <div className="ac-notice ac-dev-notice" data-tone="bad">
          <span>{t('device.permission')}</span>
          <button type="button" className="ah-btn" data-variant="primary" disabled={disabled} onClick={() => void store.run({ op: 'open-perm' })}>{t('device.openSettings')}</button>
        </div>
      )}
      {!openai && !status.stt.ready && <p className="ac-notice">{t('device.noMinimax')}</p>}
      {openai && (
        <form className="ac-dev-key" onSubmit={(event) => {
          event.preventDefault()
          void store.run({ op: 'stt-key', key }).then(() => setKey(''))
        }}>
          <label className="ac-label" htmlFor="ac-dev-key">{t('device.sttKey')}</label>
          <input id="ac-dev-key" className="ac-input" type="password" autoComplete="off" value={key} disabled={disabled}
            placeholder={t('device.sttKey.placeholder')} onChange={(event) => setKey(event.target.value)} />
          <button type="submit" className="ah-btn" disabled={disabled}>{key.trim() === '' ? t('device.sttKey.clear') : t('device.save')}</button>
          <p className="ac-hint">{t(status.stt.ready ? 'device.sttKey.hint' : 'device.sttUrl.missing')}</p>
        </form>
      )}
    </>
  )
}
