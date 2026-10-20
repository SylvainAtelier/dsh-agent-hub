/** Public slot and input-source integration; the full panel loads only when opened. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { discussionReferences, type Discussion } from '../../discussion/types.ts'
import { isDocOwner } from '../../discussion/context.ts'
import { t } from './i18n.ts'
import { DiscussionHub, type SelectionDraft } from './store.ts'
import { watchSelection } from './selection.ts'
import { DISCUSSION_SOURCE, insertDiscussion, type InputBridge, type InputScope, type InputSnapshot } from './input.ts'
import { injectDiscussionStyle } from './style.ts'
import type { PanelProps } from './Panel.tsx'
import type { Rpc } from '../rpc.ts'

declare const require: { async?: (path: string) => Promise<unknown> }
let chunk: Promise<ComponentType<PanelProps>> | undefined
function loadPanel(): Promise<ComponentType<PanelProps>> {
  chunk ??= (async () => {
    if (typeof require.async !== 'function') throw new Error('Discussion chunk loading is unavailable')
    return (await require.async('./client.discussion.js') as { DiscussionPanel: ComponentType<PanelProps> }).DiscussionPanel
  })().catch((error: unknown) => { chunk = undefined; throw error })
  return chunk
}
type Selector<S> = <T>(select: (state: S) => T) => T
interface DockProps {
  sessionId: string
  inputActions?: InputBridge['actions']
  useInput: Selector<InputSnapshot>
  useSession: Selector<{ running: boolean }>
  hub: DiscussionHub
  bridges: Map<string, InputBridge>
  attach: PanelProps['attach']
}
function DiscussionDock({ sessionId, inputActions, useInput, useSession, hub, bridges, attach }: DockProps): ReactNode {
  const client = hub.client(sessionId)
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const input = useInput((state) => state)
  const running = useSession((state) => state.running)
  const inputRef = useRef(input)
  inputRef.current = input
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (notice === '') return
    // A failure explains what to do next, so it stays long enough to read.
    const timer = setTimeout(() => setNotice(''), notice === t('attached') ? 5000 : 10_000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (inputActions === undefined || typeof inputActions.captureInsertion !== 'function') return
    const bridge: InputBridge = { actions: inputActions, snapshot: () => inputRef.current }
    bridges.set(sessionId, bridge)
    return () => {
      if (bridges.get(sessionId) === bridge) { bridges.delete(sessionId); if (hub.getSnapshot().panel?.sessionId === sessionId) hub.close() }
    }
  }, [sessionId, inputActions, bridges, hub])
  useEffect(() => { void client.load() }, [client, running])
  const state = snapshot.state
  const threads = state?.threads ?? []
  const pending = threads.filter((thread) => thread.confirmed > (state?.sent[thread.id] ?? 0))
  if (state?.enabled === false && threads.length === 0) return null
  if (threads.length === 0 && snapshot.error === undefined) return null
  return <div className="sd-dock" data-discussion-ui="">
    {threads.length > 0 && <button type="button" onClick={() => hub.open(sessionId, threads.at(-1)!.id)}>{t('title')}{pending.length > 0 ? ` · ${pending.length} ${t('pending')}` : ''}</button>}
    {pending.map((thread) => <button key={thread.id} type="button" title={thread.quote} disabled={input.draft.includes(`discussion:${encodeURIComponent(sessionId)}:${thread.id}:${thread.confirmed}`)} onClick={() => setNotice(attach(sessionId, thread) ? t('attached') : t('unavailable'))}>{t('add')} · {thread.confirmed} {t('count')}</button>)}
    {notice !== '' && <span className="sd-dock-note" role="status">{notice}</span>}
    {snapshot.error !== undefined && <span className="sd-dock-note" role="status">{snapshot.error} <button type="button" onClick={() => void client.load()}>{t('retry')}</button></span>}
  </div>
}
const GAP = 8
const EDGE = 12
/** Sits below the selection end, or above its first line when the composer or viewport edge leaves no room. */
function SelectionTrigger({ selection, onOpen, onKeep }: { selection: SelectionDraft; onOpen(): void; onKeep?: () => Promise<void> }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [kept, setKept] = useState<'idle' | 'busy' | 'done'>('idle')
  useEffect(() => setKept('idle'), [selection.quote])
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const { offsetWidth: width, offsetHeight: height } = node
    const below = selection.y + GAP
    const top = below + height <= selection.floor - GAP ? below : selection.top - GAP - height
    node.style.left = `${Math.max(EDGE, Math.min(selection.x - 16, innerWidth - width - EDGE))}px`
    node.style.top = `${Math.max(EDGE, Math.min(top, innerHeight - height - EDGE))}px`
    node.style.visibility = 'visible'
  }, [selection.x, selection.y, selection.top, selection.floor])
  const count = Array.from(selection.quote).length
  // A mouse press must not take the selection away before the click lands.
  const hold = (event: PointerEvent): void => { if (event.pointerType === 'mouse') event.preventDefault() }
  return <div ref={ref} className="sd-trigger-group">
    <button type="button" className="sd-trigger" onPointerDown={hold} onClick={onOpen}>
      <span>{t('ask')}</span><span className="sd-trigger-count">{t('chars').replace('{n}', count.toLocaleString())}</span>
    </button>
    {onKeep !== undefined && <button type="button" className="sd-trigger" onPointerDown={hold} disabled={kept !== 'idle'} aria-live="polite"
      onClick={() => { setKept('busy'); void onKeep().then(() => setKept('done'), () => setKept('idle')) }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill={kept === 'done' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>
      <span>{kept === 'done' ? t('kept') : t('keepQuote')}</span>
    </button>}
  </div>
}
function DiscussionOverlay({ hub, attach, openSettings }: { hub: DiscussionHub; attach: PanelProps['attach']; openSettings(): void }): ReactNode {
  const state = useSyncExternalStore(hub.subscribe, hub.getSnapshot)
  const [Panel, setPanel] = useState<ComponentType<PanelProps>>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const open = state.panel
  useEffect(() => {
    if (open === undefined || Panel !== undefined) return
    let live = true
    void loadPanel().then((loaded) => { if (live) { setPanel(() => loaded); setError('') } }, (error: unknown) => { if (live) setError(String(error)) })
    return () => { live = false }
  }, [open !== undefined, Panel, retry])
  const selection = state.selection
  return createPortal(<div className="sd-overlay" data-discussion-ui="">
    {selection !== undefined && open === undefined && <SelectionTrigger selection={selection} onOpen={() => hub.open(selection.sessionId, undefined, selection)}
      {...(isDocOwner(selection.sessionId) && hub.doc !== undefined ? { onKeep: () => hub.doc!.keep(selection.sessionId, selection.quote) } : {})} />}
    {open !== undefined && (Panel !== undefined
      ? <Panel key={`${open.sessionId}:${open.id ?? 'new'}:${open.draft?.quote ?? ''}`} hub={hub} {...open} attach={attach} openSettings={() => { hub.close(); openSettings() }} />
      : <div className="sd-panel" style={{ top: 72, left: 16, height: 'auto', padding: 16 }} role="dialog" aria-label={t('title')}><p role="status">{error || t('loading')}</p>{error !== '' && <button type="button" onClick={() => { setError(''); setRetry((value) => value + 1) }}>{t('retry')}</button>}<button type="button" onClick={() => hub.close()}>{t('close')}</button></div>)}
  </div>, document.body)
}
export interface DiscussionContext {
  get(name: string): unknown
  effect(body: () => () => void, label?: string): void
  inject(deps: string[], body: (scope: DiscussionContext) => void): void
  slots: { inject(name: string, body: () => () => void): void; register<P>(entry: object, component: (props: P) => ReactNode): () => void }
}
/** Returns the hub, so a page showing documents (the reader) can lend it their actions and open it. */
export function applyDiscussions(ctx: DiscussionContext, openSettings: () => void): DiscussionHub {
  const { rpc } = ctx.get('connection') as { rpc: Rpc }
  const hub = new DiscussionHub(rpc)
  const bridges = new Map<string, InputBridge>()
  const attach = (sessionId: string, thread: Discussion): boolean => {
    const sessions = ctx.get('sessions') as { scope(id: string): InputScope | undefined } | undefined
    return insertDiscussion(sessions?.scope(sessionId), bridges.get(sessionId), sessionId, thread)
  }
  ctx.effect(injectDiscussionStyle, 'dsh-agent-hub: discussion styles')
  ctx.effect(() => watchSelection(hub), 'dsh-agent-hub: selection delegation')
  ctx.effect(() => () => hub.dispose(), 'dsh-agent-hub: discussion state')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-agent-hub.discussions', order: 1900, inject: () => ({ hub, bridges, attach }),
  }, DiscussionDock))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-agent-hub.discussion-overlay', inject: () => ({ hub, attach, openSettings }) }, DiscussionOverlay))
  ctx.inject(['inputTriggers'], (scope) => scope.effect(() => {
    const triggers = scope.get('inputTriggers') as { registerSource(source: object): () => void }
    return triggers.registerSource({
      trigger: '@', name: DISCUSSION_SOURCE, order: 90,
      candidates: async () => [], onPick: () => undefined,
      openReference: (session: { sessionId: string }, input: { ref?: string }) => {
        const ref = discussionReferences(input.ref ?? '')[0]
        if (ref === undefined || ref.sessionId !== session.sessionId) return false
        hub.open(session.sessionId, ref.id)
        return true
      },
      codec: {
        clipboardText: (ref: string) => ref,
        serialize: async (ref: string) => {
          if (discussionReferences(ref).length !== 1) throw new Error('Invalid discussion reference')
          return ref
        },
      },
    })
  }, 'dsh-agent-hub: discussion reference codec'))
  return hub
}
