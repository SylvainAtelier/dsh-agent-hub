/**
 * Restart DSH from the left sidebar's foot: an icon button after the light/dark
 * switch, right of the account button. Shown only where the host can restart
 * (DSH Desktop). A click asks first, naming the sessions and jobs a restart
 * would interrupt; once confirmed the dialog follows the restart and reloads
 * the page when a new host answers, so a phone over Tailscale comes back too.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { injectGitStyle } from '../git/style.ts'
import { ATTR as THEME_ATTR, keepInFoot } from '../theme/toggle.ts'
import type { RestartStatus } from '../../restart/types.ts'

export type RestartCall = (payload: { op: 'status' | 'restart' }) => Promise<unknown>

const ATTR = 'data-ah-restart'
/** How often the restarting dialog asks whether a new host is up. */
const POLL_MS = 1500
/** After this long the dialog stops promising and offers a manual reload. */
const SLOW_MS = 90_000

const english = (): boolean => document.documentElement.lang.toLowerCase().startsWith('en')

const COPY = {
  zh: {
    button: '重启 DSH',
    title: '重启 DSH？',
    lead: 'DSH 会关闭并重新打开，以加载插件和配置的最新改动，通常需要十几秒。',
    checking: '正在检查进行中的任务…',
    idle: '当前没有进行中的会话或后台任务。',
    running: '有 {n} 个会话或后台任务正在进行，重启会中断它们。',
    cancel: '取消',
    confirm: '重启',
    confirmAnyway: '仍然重启',
    restartingTitle: '正在重启 DSH',
    restartingBody: 'DSH 正在关闭并重新打开，完成后此页面会自动刷新。',
    slowBody: '重启用时比预期长。DSH 重新打开后，可以手动刷新此页面。',
    reload: '刷新页面',
    close: '关闭',
    failed: '无法重启：{error}',
    upgrades: '重启时会先升级：{list}。DSH 退出后运行 pnpm，失败会自动还原，重新打开后显示结果。',
  },
  en: {
    button: 'Restart DSH',
    title: 'Restart DSH?',
    lead: 'DSH quits and opens again to load the latest plugin and settings changes. This usually takes a few seconds.',
    checking: 'Checking for work in progress…',
    idle: 'No sessions or background jobs are running.',
    running: '{n} sessions or background jobs are running; restarting interrupts them.',
    cancel: 'Cancel',
    confirm: 'Restart',
    confirmAnyway: 'Restart anyway',
    restartingTitle: 'Restarting DSH',
    restartingBody: 'DSH is quitting and opening again; this page reloads once it is back.',
    slowBody: 'The restart is taking longer than expected. Reload this page once DSH is open again.',
    reload: 'Reload page',
    close: 'Close',
    failed: 'Could not restart: {error}',
    upgrades: 'The restart upgrades first: {list}. pnpm runs once DSH has quit and is undone if it fails; the outcome shows when DSH is back.',
  },
}

type CopyKey = keyof typeof COPY.zh
const tr = (key: CopyKey, params: Record<string, string> = {}): string =>
  (english() ? COPY.en : COPY.zh)[key].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')

const ICON = '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'

const CSS = `
[${ATTR}] {
  position: relative; flex: none; width: 28px; height: 28px; padding: 0; border: none; background: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary);
  transition: background-color 120ms ease, color 120ms ease;
}
[${ATTR}] svg { transition: transform 320ms var(--ah-ease); }
[${ATTR}]:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[${ATTR}]:hover svg { transform: rotate(90deg); }
[${ATTR}]:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
/* A finger-sized target without widening the row. */
@media (pointer: coarse) { [${ATTR}]::before { content: ""; position: absolute; inset: -8px; } }
[class*="railRow"] > [${ATTR}] { display: none; }

.ar-dialog { width: min(400px, 100%); }
.ar-head { display: flex; align-items: center; gap: 10px; }
.ar-icon {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%;
  background: color-mix(in srgb, var(--ah-info) 14%, transparent); color: var(--ah-info-ink);
}
.ar-dialog[data-warn] .ar-icon { background: color-mix(in srgb, var(--ah-warn) 18%, transparent); color: var(--ah-warn-ink); }
.ar-note {
  display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 10px; border-radius: var(--ah-radius);
  font-size: 12px; line-height: 1.5; background: var(--ah-soft); color: var(--ah-fg2);
}
.ar-note[data-warn] { background: color-mix(in srgb, var(--ah-warn) 12%, transparent); color: var(--ah-fg); }
.ar-note[data-error] { background: color-mix(in srgb, var(--ah-danger) 10%, transparent); color: var(--ah-fg); }
.ar-dot { flex: none; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%; background: var(--ah-fg3); }
.ar-note[data-warn] .ar-dot { background: var(--ah-warn); }
.ar-note[data-error] .ar-dot { background: var(--ah-danger); }
.ar-spin { animation: ar-spin 900ms linear infinite; }
@keyframes ar-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  [${ATTR}] svg { transition: none; }
  [${ATTR}]:hover svg { transform: none; }
  .ar-spin { animation-duration: 2.4s; }
}
`

function Icon(props: { size: number; spin?: boolean }): ReactNode {
  return (
    <svg className={props.spin ? 'ar-spin' : undefined} width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON }} />
  )
}

type Phase =
  | { name: 'confirm'; status?: RestartStatus; error?: string; sending?: boolean }
  | { name: 'restarting'; boot?: string; slow: boolean }

function Dialog(props: { call: RestartCall; onClose: () => void }): ReactNode {
  const [phase, setPhase] = useState<Phase>({ name: 'confirm' })
  const restarting = phase.name === 'restarting'
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    props.call({ op: 'status' }).then(
      (status) => { if (live) setPhase((current) => (current.name === 'confirm' ? { ...current, status: status as RestartStatus } : current)) },
      (error: unknown) => {
        if (!live) return
        const message = error instanceof Error ? error.message : String(error)
        setPhase((current) => (current.name === 'confirm' ? { ...current, status: { supported: true, running: 0, boot: '' }, error: message } : current))
      },
    )
    return () => { live = false }
  }, [])

  const running = phase.name === 'confirm' ? phase.status?.running : undefined
  const upgrades = phase.name === 'confirm' ? phase.status?.upgrades ?? [] : []
  const warn = (running ?? 0) > 0
  // A restart that interrupts work starts on Cancel; otherwise Enter confirms.
  useEffect(() => {
    if (running === undefined) return
    ;(warn ? cancel : confirm).current?.focus()
  }, [running === undefined, warn])

  // Restarting: wait for a host with a new boot id, then reload onto it.
  useEffect(() => {
    if (phase.name !== 'restarting') return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = setTimeout(() => { if (live) setPhase((current) => (current.name === 'restarting' ? { ...current, slow: true } : current)) }, SLOW_MS)
    // Without the old boot id, only an answer after the host was seen down is the new host.
    let down = false
    const poll = (): void => {
      timer = setTimeout(() => {
        props.call({ op: 'status' }).then((status) => {
          const boot = (status as RestartStatus).boot
          if (live && boot !== phase.boot && (phase.boot !== undefined || down)) location.reload()
          else poll()
        }, () => {
          down = true
          poll()
        })
      }, POLL_MS)
    }
    poll()
    return () => {
      live = false
      clearTimeout(timer)
      clearTimeout(slow)
    }
  }, [restarting])

  const start = async (): Promise<void> => {
    if (phase.name !== 'confirm' || phase.sending) return
    const boot = phase.status?.boot
    setPhase({ ...phase, sending: true, error: undefined })
    try {
      await props.call({ op: 'restart' })
      setPhase({ name: 'restarting', ...(boot ? { boot } : {}), slow: false })
    } catch (error) {
      setPhase({ ...phase, sending: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const close = (): void => { if (!restarting || phase.slow) props.onClose() }

  let body: ReactNode
  if (phase.name === 'restarting') {
    body = (
      <>
        <div className="ar-head">
          <span className="ar-icon"><Icon size={16} spin={!phase.slow} /></span>
          <div className="gp-dialog-title" id="ar-title">{tr('restartingTitle')}</div>
        </div>
        <p className="gp-dialog-body" role="status" aria-live="polite">{tr(phase.slow ? 'slowBody' : 'restartingBody')}</p>
        {phase.slow && (
          <div className="gp-dialog-actions">
            <button type="button" className="ah-btn" onClick={props.onClose}>{tr('close')}</button>
            <button type="button" className="ah-btn" data-variant="primary" onClick={() => location.reload()} autoFocus>{tr('reload')}</button>
          </div>
        )}
      </>
    )
  } else {
    const note = phase.error !== undefined
      ? <p className="ar-note" data-error="" role="alert"><span className="ar-dot" />{tr('failed', { error: phase.error })}</p>
      : running === undefined
        ? <p className="ar-note"><span className="ar-dot" />{tr('checking')}</p>
        : <p className="ar-note" data-warn={warn ? '' : undefined}><span className="ar-dot" />{warn ? tr('running', { n: String(running) }) : tr('idle')}</p>
    body = (
      <>
        <div className="ar-head">
          <span className="ar-icon"><Icon size={16} /></span>
          <div className="gp-dialog-title" id="ar-title">{tr('title')}</div>
        </div>
        <p className="gp-dialog-body" id="ar-lead">{tr('lead')}</p>
        {upgrades.length > 0 && <p className="ar-note"><span className="ar-dot" />{tr('upgrades', { list: upgrades.map((op) => `${op.name}@${op.spec}`).join(', ') })}</p>}
        {note}
        <div className="gp-dialog-actions">
          <button ref={cancel} type="button" className="ah-btn" onClick={props.onClose}>{tr('cancel')}</button>
          <button ref={confirm} type="button" className="ah-btn" data-variant={warn ? 'danger' : 'primary'} disabled={phase.sending || running === undefined} onClick={() => void start()}>
            {phase.sending && <Icon size={13} spin />}
            {tr(warn ? 'confirmAnyway' : 'confirm')}
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="gp-dialog-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="gp-dialog ar-dialog" data-warn={warn ? '' : undefined} role="alertdialog" aria-modal="true" aria-labelledby="ar-title"
        aria-describedby={restarting ? undefined : 'ar-lead'} aria-busy={restarting && !phase.slow}
        tabIndex={-1} ref={(node) => { if (node !== null && !node.contains(document.activeElement)) node.focus() }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
          // Keep Tab inside the dialog.
          if (event.key !== 'Tab') return
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          if (items.length === 0) return
          const first = items[0]!
          const last = items[items.length - 1]!
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }}>
        {body}
      </div>
    </div>
  )
}

let closeDialog: (() => void) | undefined

/**
 * Ask to restart, the same dialog the sidebar button opens; the 同步与更新 page offers it too
 * where a change waits for a restart. One dialog at a time.
 */
export function openRestartDialog(call: RestartCall): void {
  if (closeDialog !== undefined) return
  const opener = document.activeElement
  const releaseStyle = injectGitStyle()
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  closeDialog = () => {
    root.unmount()
    host.remove()
    releaseStyle()
    closeDialog = undefined
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }
  root.render(<Dialog call={call} onClose={() => closeDialog?.()} />)
}

/** Mount the button where the host can restart; returns the disposer. */
export function mountRestart(call: RestartCall): () => void {
  let stopped = false
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub'
  style.textContent = CSS
  document.head.append(style)

  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(ATTR, '')
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-label', tr('button'))
  button.title = tr('button')
  button.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON}</svg>`

  button.addEventListener('click', () => openRestartDialog(call))

  let offPlace: (() => void) | undefined

  // Ask once whether this host can restart at all; a host still starting gets a few more tries.
  let timer: ReturnType<typeof setTimeout> | undefined
  const probe = (tries: number): void => {
    call({ op: 'status' }).then((status) => {
      if (stopped || !(status as RestartStatus).supported) return
      // After the light/dark switch, else right after the account launcher.
      offPlace ??= keepInFoot(button, (row, launcher) => row.querySelector(`:scope > [${THEME_ATTR}]`) ?? launcher)
    }, () => {
      if (!stopped && tries > 1) timer = setTimeout(() => probe(tries - 1), 5000)
    })
  }
  probe(3)

  return () => {
    stopped = true
    clearTimeout(timer)
    offPlace?.()
    closeDialog?.()
    button.remove()
    style.remove()
  }
}
