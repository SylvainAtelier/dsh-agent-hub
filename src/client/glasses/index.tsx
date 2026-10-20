/**
 * The composer's glasses bell (public right-hand slot, beside scheduled send):
 * on, the glasses are told once when this session's turn ends, or when it waits
 * on an approval, as a message into their latest Qoder session.
 * One poll serves every mounted bell (hub.ts): long only while one is armed or a notification waits.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GLASSES_METHOD } from '../../bridge/types.ts'
import { GlassesHub } from './hub.ts'
import { rpcValue, type Rpc } from '../rpc.ts'
import { t } from './i18n.ts'
import { injectGlassesStyle } from './style.ts'

const HINT_MS = 3200
/** A hint with a link stays long enough to reach it, and while the pointer is on it. */
const LINK_MS = 8000

function Bell(props: { ringing: boolean }): ReactNode {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" fill={props.ringing ? 'currentColor' : 'none'} fillOpacity={props.ringing ? 0.18 : 0} />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    {props.ringing && <><path d="M21.5 8c0-2.2-.8-4.2-2.1-5.7" /><path d="M2.5 8c0-2.2.8-4.2 2.1-5.7" /></>}
  </svg>
}

interface SessionState { removed: boolean; subagent: unknown | null }
interface Props {
  sessionId: string
  useSession<T>(select: (state: SessionState) => T): T
  hub: GlassesHub
}

function GlassesBell(props: Props): ReactNode {
  const update = useSyncExternalStore(props.hub.subscribe, props.hub.snapshot)
  const unavailable = props.useSession((state) => state.removed || state.subagent != null)
  const armed = update?.status.armed.includes(props.sessionId) === true
  const offline = update !== undefined && !update.status.reachable
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<{ text: string; warn: boolean; link?: string; place: CSSProperties }>()
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  /** A bubble above the bell, kept inside the viewport: portalled, so the composer's clipping does not cut it. */
  const show = (text: string, warn: boolean, link?: string): void => {
    clearTimeout(timer.current)
    const rect = trigger.current?.getBoundingClientRect()
    const width = document.documentElement.clientWidth
    const place: CSSProperties = rect === undefined ? { right: 12, bottom: 12 }
      : { right: Math.max(12, width - rect.right), bottom: Math.max(12, window.innerHeight - rect.top + 8) }
    setHint({ text, warn, ...(link === undefined ? {} : { link }), place })
    timer.current = setTimeout(() => setHint(undefined), link === undefined ? HINT_MS : LINK_MS)
  }
  const hold = (): void => clearTimeout(timer.current)
  const release = (): void => { timer.current = setTimeout(() => setHint(undefined), HINT_MS) }
  const toggle = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const next = await props.hub.arm(props.sessionId, !armed)
      const on = next.status.armed.includes(props.sessionId)
      show(on ? t(next.status.reachable ? 'armed' : 'armedOffline') : t('disarmed'), on && !next.status.reachable, on ? next.status.opener : undefined)
    } catch {
      show(t('failed'), true)
    } finally {
      setBusy(false)
    }
  }
  const title = armed ? `${t('on')}${offline ? `\n${t('offline')}` : ''}` : offline ? `${t('label')}\n${t('offline')}` : t('label')
  return <span className="ah-glasses">
    <button ref={trigger} type="button" className="ah-glasses-trigger" aria-label={t('label')} aria-pressed={armed} title={title}
      data-offline={armed && offline ? '' : undefined} aria-busy={busy || undefined} disabled={unavailable || update === undefined}
      onClick={() => void toggle()}><Bell ringing={armed} /></button>
    {hint !== undefined && createPortal(<span className="ah-glasses-hint" style={hint.place} data-tone={hint.warn ? 'warn' : undefined}
      data-link={hint.link === undefined ? undefined : ''} aria-hidden={hint.link === undefined || undefined} onMouseEnter={hold} onMouseLeave={release}>
      {hint.text}
      {hint.link !== undefined && <a href={hint.link} target="_blank" rel="noopener noreferrer">{t('opener')} ↗</a>}
    </span>, document.body)}
    <span className="ah-glasses-sr" role="status" aria-live="polite">{hint?.text ?? ''}</span>
  </span>
}

interface ClientContext {
  effect(body: () => () => void, label?: string): void
  slots: {
    inject(name: string, body: () => () => void): void
    register<P>(entry: object, component: (props: P) => unknown): () => void
  }
}

export function applyGlasses(ctx: ClientContext, rpc: Rpc): void {
  ctx.effect(injectGlassesStyle, 'dsh-agent-hub: glasses bell style')
  const hub = new GlassesHub((request, signal) => rpcValue(rpc, GLASSES_METHOD, request, 'Glasses notification request failed', signal))
  ctx.effect(() => {
    const visible = (): void => { if (document.visibilityState === 'visible') hub.refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, 'dsh-agent-hub: glasses bell refresh')
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'dsh-agent-hub.glasses-bell', order: 21,
    inject: () => ({ hub }),
  }, (props: Props) => <GlassesBell key={props.sessionId} {...props} />))
}
