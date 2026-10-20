/**
 * Phone access: a sidebar-foot entry that says whether it is on, and a panel
 * that shows exactly one next step for each state — install, connect, enable
 * HTTPS, turn on — ending in a QR code of a plain URL. The URL carries no
 * secret (the tailnet account is the key), so showing it anywhere is safe.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { QRCodeSVG } from 'qrcode.react'
import { t } from '../i18n.ts'
import { surfaceOf } from '../usage/surface.ts'
import type { RemoteAction, RemoteResult, RemoteView } from '../../remote/types.ts'

export interface RemoteApi {
  run(action: RemoteAction): Promise<RemoteResult>
}

const LINKS = {
  missing: 'https://tailscale.com/download',
  offline: 'https://tailscale.com/download',
  'no-https': 'https://login.tailscale.com/admin/dns',
} as const

/** A page served through phone access: the phone itself, which has nothing to set up. */
export const viaTailnet = (): boolean => typeof location !== 'undefined' && location.hostname.endsWith('.ts.net')

/** The entry says only on or off: setup is the panel's business, and an optional feature should not nag. */
type Tone = 'on' | 'off'
const toneOf = (view: RemoteView | undefined): Tone | undefined => view === undefined ? undefined : view.state === 'on' ? 'on' : 'off'

function PhoneIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  )
}

/** The remote state, read on mount, on demand, and whenever the window regains focus. */
function useRemote(api: RemoteApi): { result: RemoteResult | undefined; busy: RemoteAction | undefined; run(action: RemoteAction): void } {
  const [result, setResult] = useState<RemoteResult | undefined>(undefined)
  const [busy, setBusy] = useState<RemoteAction | undefined>(undefined)
  const pending = useRef(false)
  const run = useCallback((action: RemoteAction): void => {
    if (pending.current) return
    pending.current = true
    setBusy(action)
    api.run(action)
      .then((next) => setResult(next), (error: Error) => setResult((current) => ({ view: current?.view ?? { state: 'offline' }, error: error.message })))
      .finally(() => {
        pending.current = false
        setBusy(undefined)
      })
  }, [api])
  useEffect(() => {
    run('status')
    // Coming back from the Tailscale app or its admin console is the usual reason the state changed.
    const onFocus = (): void => run('status')
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [run])
  return { result, busy, run }
}

export function RemoteEntry(props: { api: RemoteApi; wide?: boolean }): ReactNode {
  const { api, wide } = props
  const { result, busy, run } = useRemote(api)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const tone = toneOf(result?.view)

  const label = t('remote.entry')
  const status = tone === undefined ? '' : t(`remote.${tone}`)
  const close = (): void => {
    setOpen(false)
    anchor.current?.focus()
  }
  return (
    <div className="ra-entry-wrap" data-wide={wide === false ? undefined : ''}>
      <button type="button" ref={anchor} className="ra-entry" data-tone={tone} aria-haspopup="dialog" aria-expanded={open}
        aria-label={wide === false ? `${label} · ${status}` : undefined} title={wide === false ? `${label} · ${status}` : undefined}
        onClick={() => { setOpen(true); run('status') }}>
        <span className="ra-entry-icon"><PhoneIcon /></span>
        {wide !== false && <span className="ra-entry-label">{label}</span>}
        {wide !== false && <span className="ra-entry-status">{status}</span>}
      </button>
      {open && anchor.current !== null && createPortal(
        <Panel result={result} busy={busy} run={run} onClose={close} surface={surfaceOf(anchor.current)} />,
        document.body,
      )}
    </div>
  )
}

function Panel(props: {
  result: RemoteResult | undefined
  busy: RemoteAction | undefined
  run(action: RemoteAction): void
  onClose(): void
  surface: { background: string; color: string }
}): ReactNode {
  const { result, busy, run, onClose, surface } = props
  const titleId = useId()
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('[data-variant="primary"]')?.focus() ?? sheet.current?.focus()
  }, [result?.view.state])

  // Escape closes; Tab stays inside the dialog.
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      return onClose()
    }
    if (event.key !== 'Tab' || sheet.current === null) return
    const focusable = [...sheet.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="ra-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={sheet} className="ra-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        style={surface} onKeyDown={onKeyDown}>
        <header className="ra-head">
          <h2 id={titleId}>{t('remote.title')}</h2>
          <button type="button" className="ah-icon-btn ra-close" aria-label={t('close')} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>
        {result === undefined ? <div className="ra-skeleton" /> : <Body result={result} busy={busy} run={run} />}
      </div>
    </div>
  )
}

function Body(props: { result: RemoteResult; busy: RemoteAction | undefined; run(action: RemoteAction): void }): ReactNode {
  const { result: { view, error }, busy, run } = props
  const alert = error === undefined ? null : <p className="ra-error" role="alert">{t('remote.failed', { error })}</p>

  if (view.state === 'on') {
    return (
      <>
        <div className="ra-qr"><QRCodeSVG value={view.url} size={176} marginSize={0} bgColor="#ffffff" fgColor="#111111" title={view.url} /></div>
        <p className="ra-caption">{t('remote.scan')}</p>
        <CopyUrl url={view.url} />
        {alert}
        <footer className="ra-foot">
          <span className="ra-state" data-tone="on"><i className="ra-dot" />{t('remote.onlyYou', { login: view.login })}</span>
          <button type="button" className="ah-btn" disabled={busy !== undefined} onClick={() => run('disable')}>
            {busy === 'disable' ? t('remote.disabling') : t('remote.disable')}
          </button>
        </footer>
      </>
    )
  }

  if (view.state === 'off') {
    return (
      <>
        <p className="ra-lead">{t('remote.lead')}</p>
        {alert}
        <button type="button" className="ah-btn" data-variant="primary" disabled={busy !== undefined} onClick={() => run('enable')}>
          {busy === 'enable' ? t('remote.enabling') : t('remote.enable')}
        </button>
        <p className="ra-note">{t('remote.note')}</p>
      </>
    )
  }

  const message = view.state === 'missing' ? t('remote.missing') : view.state === 'offline' ? t('remote.offline') : t('remote.noHttps')
  const action = view.state === 'missing' ? t('remote.missingAction') : view.state === 'offline' ? t('remote.offlineAction') : t('remote.noHttpsAction')
  return (
    <>
      <p className="ra-lead">{message}</p>
      {alert}
      <div className="ra-actions">
        <a className="ah-btn" data-variant="primary" href={LINKS[view.state]} target="_blank" rel="noopener noreferrer">{action}</a>
        <button type="button" className="ah-btn" disabled={busy !== undefined} onClick={() => run('status')}>
          {busy === 'status' ? t('remote.checking') : t('remote.recheck')}
        </button>
      </div>
    </>
  )
}

function CopyUrl(props: { url: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = (): void => {
    navigator.clipboard?.writeText(props.url).then(() => setCopied(true), () => {})
  }
  return (
    <div className="ra-url">
      <span className="ra-url-text" title={props.url}>{props.url.replace(/^https:\/\//, '')}</span>
      <button type="button" className="ah-btn" data-variant="primary" onClick={copy} aria-live="polite">
        {copied ? t('remote.copied') : t('remote.copy')}
      </button>
    </div>
  )
}
