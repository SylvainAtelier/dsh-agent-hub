/** Lazy-loaded discussion panel: stable desktop dialog, modal bottom sheet on narrow viewports. */
import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Marked, Renderer, type Tokens } from 'marked'
import type { Discussion } from '../../discussion/types.ts'
import { MAX_QUESTION } from '../../discussion/types.ts'
import { isDocOwner, scopeText, SCOPES, type DiscussionScope } from '../../discussion/context.ts'
import type { DiscussionHub, SelectionDraft } from './store.ts'
import { t } from './i18n.ts'
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const markdown = new Marked({ gfm: true, breaks: true, async: false, renderer: {
  html: ({ text }: Tokens.HTML | Tokens.Tag) => escape(text),
  image: ({ text }: Tokens.Image) => escape(text),
  link(this: Renderer, token: Tokens.Link): string {
    if (!/^(https?:|mailto:)/i.test(token.href.trim())) return this.parser.parseInline(token.tokens)
    return Renderer.prototype.link.call(this, token).replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ')
  },
} })
/** Markdown while streaming too, so finishing never reflows the answer; parsing trails the deltas at low priority. */
const Answer = memo(function Answer({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const deferred = useDeferredValue(text)
  const html = useMemo(() => markdown.parse(deferred) as string, [deferred])
  return <div className={streaming ? 'sd-answer sd-stream' : 'sd-answer'} dangerouslySetInnerHTML={{ __html: html }} />
})
/** The bot a new discussion was last answered by, remembered on this device. */
const BOT_KEY = 'agent-hub.discussion.bot'
export interface PanelProps {
  hub: DiscussionHub
  sessionId: string
  id?: string
  draft?: SelectionDraft
  attach(sessionId: string, thread: Discussion): boolean
  openSettings(): void
}
export function DiscussionPanel({ hub, sessionId, id, draft, attach, openSettings }: PanelProps): ReactNode {
  const client = hub.client(sessionId)
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const [currentId, setCurrentId] = useState(id)
  const draftKey = (target?: string): string => target ?? `selection:${draft?.quote ?? ''}`
  const [question, setQuestion] = useState(() => client.draft(draftKey(id)))
  const writeQuestion = (value: string): void => { setQuestion(value); client.setDraft(draftKey(currentId), value) }
  const [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 639px)').matches)
  const panel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const follow = useRef(true)
  const creatingId = useRef(crypto.randomUUID())
  const thread = snapshot.state?.threads.find((item) => item.id === currentId)
  // A reader article's discussion: a level of context to pick, and the article's own actions instead of staging.
  const doc = isDocOwner(sessionId)
  const [scope, setScope] = useState<DiscussionScope>(() => thread?.scope ?? draft?.scope ?? 'selection')
  useEffect(() => { if (thread !== undefined) setScope(thread.scope ?? 'selection') }, [thread?.id])
  const [bot, setBot] = useState(() => { try { return localStorage.getItem(BOT_KEY) ?? '' } catch { return '' } })
  const pickBot = (value: string): void => { setBot(value); try { localStorage.setItem(BOT_KEY, value) } catch { /* Kept for this panel only. */ } }
  const bots = snapshot.state?.bots ?? []
  const chosenBot = bots.some((item) => item.id === bot) ? bot : ''
  const [opening, setOpening] = useState(false)
  const running = snapshot.state?.threads.some((item) => item.turns.some((turn) => turn.status === 'running')) ?? false
  const currentRunning = thread?.turns.at(-1)?.status === 'running'
  const loading = snapshot.loading && snapshot.state === undefined
  const quote = thread?.quote ?? draft?.quote ?? ''
  const markdown = doc ? hub.doc?.markdown(sessionId) : undefined
  const sendSize = scope === 'selection' || markdown === undefined ? quote.length : scopeText(markdown, quote, scope).length + quote.length
  const scopes: readonly DiscussionScope[] = quote === '' ? ['article'] : SCOPES
  const sent = thread === undefined ? 0 : snapshot.state?.sent[thread.id] ?? 0
  useEffect(() => {
    const previous = document.activeElement
    const media = matchMedia('(max-width: 639px)')
    const changed = (): void => setMobile(media.matches)
    media.addEventListener('change', changed)
    client.connect()
    // Focus the panel, not the textarea: avoid opening a phone keyboard before the quote can be read.
    panel.current?.focus({ preventScroll: true })
    return () => {
      media.removeEventListener('change', changed)
      client.disconnect()
      queueMicrotask(() => { if (document.activeElement === document.body && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) })
    }
  }, [client])
  useEffect(() => {
    if (!mobile) return
    const overlay = panel.current?.parentElement
    const saved = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== overlay).map((node) => ({ node, inert: node.inert }))
    for (const { node } of saved) node.inert = true
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { for (const { node, inert } of saved) node.inert = inert; document.body.style.overflow = overflow }
  }, [mobile])
  useLayoutEffect(() => {
    const view = window.visualViewport
    const resize = (): void => {
      const node = panel.current
      if (node === null) return
      const width = view?.width ?? innerWidth
      const height = view?.height ?? innerHeight
      const left = view?.offsetLeft ?? 0
      const top = view?.offsetTop ?? 0
      const narrow = width < 640
      node.style.setProperty('--sd-height', `${Math.max(160, height - (narrow ? 16 : 32))}px`)
      node.style.left = `${narrow ? left + 8 : Math.max(left + 16, Math.min(draft?.x ?? left + width - 456, left + width - Math.min(440, width - 32) - 16))}px`
      node.style.top = `${narrow ? top + height - node.offsetHeight - 8 : Math.max(top + 16, Math.min(draft?.y ?? top + 72, top + height - node.offsetHeight - 16))}px`
    }
    resize()
    // Content growth changes height, not the chosen anchor; only clamp to the visible viewport.
    const observer = new ResizeObserver(resize)
    if (panel.current !== null) observer.observe(panel.current)
    view?.addEventListener('resize', resize)
    view?.addEventListener('scroll', resize)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); view?.removeEventListener('resize', resize); view?.removeEventListener('scroll', resize); window.removeEventListener('resize', resize) }
  }, [draft?.x, draft?.y])
  useLayoutEffect(() => {
    if (follow.current && scroller.current !== null) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [thread?.turns.at(-1)?.answer, thread?.turns.length, thread?.confirmed, currentId, notice])
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        // Non-modal on desktop: Escape belongs to whatever holds focus (a menu, the editor); the panel takes it only from inside itself.
        const origin = event.target
        if (!mobile && origin instanceof Node && origin !== document.body && origin !== document && !panel.current?.contains(origin)) return
        event.preventDefault(); event.stopPropagation(); hub.close(); return
      }
      if (!mobile || event.key !== 'Tab' || panel.current === null) return
      const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), select, a[href], summary')]
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handle, true)
    return () => document.removeEventListener('keydown', handle, true)
  }, [hub, mobile])
  const send = async (): Promise<void> => {
    const asked = question.trim()
    if (asked === '' || creating || snapshot.busy || running) return
    setNotice(''); setCreating(true)
    try {
      let target = currentId
      if (target === undefined) {
        if (draft === undefined) return
        target = creatingId.current
        await client.run({ op: 'create', id: target, quote: draft.quote, source: draft.source, ...(doc ? { scope } : {}), ...(chosenBot === '' ? {} : { bot: chosenBot }) })
        client.setDraft(draftKey(target), asked)
        client.setDraft(draftKey(), '')
        setCurrentId(target)
      }
      await client.ask(target, asked, doc ? scope : undefined)
      client.setDraft(draftKey(target), '')
      setQuestion('')
      follow.current = true
      textarea.current?.focus({ preventScroll: true })
    } catch { /* The shared status exposes the failure and the question remains intact. */ }
    finally { setCreating(false) }
  }
  const stage = async (): Promise<void> => {
    if (thread === undefined) return
    try {
      const through = thread.turns.length
      const state = await client.run({ op: 'stage', id: thread.id, through })
      const confirmed = state.threads.find((item) => item.id === thread.id)!
      // Another device may have confirmed a newer prefix; this click authorizes only what was shown.
      setNotice(attach(sessionId, { ...confirmed, confirmed: through }) ? t('attached') : t('unavailable'))
    } catch { /* The shared status exposes the failure. */ }
  }
  const keep = async (): Promise<void> => {
    const answer = thread?.turns.filter((turn) => turn.status === 'complete').at(-1)?.answer
    if (thread === undefined || answer === undefined || hub.doc === undefined) return
    try { await hub.doc.keep(sessionId, thread.quote, answer); setNotice(t('kept')) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const carry = async (): Promise<void> => {
    if (thread === undefined || hub.doc === undefined) return
    setOpening(true); setNotice(t('opening'))
    try { await hub.doc.continueInSession(sessionId, thread); hub.close() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setOpening(false) }
  }
  const complete = thread !== undefined && thread.turns.length > 0 && thread.turns.every((turn) => turn.status === 'complete')
  const staged = thread !== undefined && thread.confirmed === thread.turns.length
  return <>
    {mobile && <div className="sd-scrim" data-discussion-ui="" onClick={() => hub.close()} />}
    <div ref={panel} className="sd-panel" data-discussion-ui="" role="dialog" aria-modal={mobile || undefined} aria-labelledby="sd-title" tabIndex={-1}>
      <header className="sd-header"><div><strong id="sd-title">{t('title')}</strong><button className="sd-model" type="button" onClick={openSettings} title={t('settings')}>{thread !== undefined ? (thread.bot === undefined ? thread.route.model : `${thread.bot} · ${thread.route.model}`) : chosenBot !== '' ? chosenBot : snapshot.state?.defaultRoute?.model ?? t('settings')}</button></div><button className="sd-icon" type="button" onClick={() => hub.close()} aria-label={t('close')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
      {snapshot.state !== undefined && snapshot.state.threads.length > 0 && <label className="sd-history"><span>{t('history')}</span><select aria-label={t('history')} disabled={creating || snapshot.busy} value={currentId ?? ''} onChange={(event) => { const target = event.target.value || undefined; setCurrentId(target); setQuestion(client.draft(draftKey(target))); setNotice(''); follow.current = true }}>
        {draft !== undefined && <option value="">{t('start')}</option>}
        {snapshot.state.threads.map((item) => <option key={item.id} value={item.id}>{item.quote.slice(0, 44)}{(snapshot.state?.sent[item.id] ?? 0) >= item.confirmed && item.confirmed > 0 ? ` · ${t('sent')}` : item.confirmed > 0 ? ` · ${t('pending')}` : ''}</option>)}
      </select></label>}
      {thread === undefined && bots.length > 0 && <label className="sd-history"><span>{t('answerBy')}</span><select aria-label={t('answerBy')} disabled={creating || snapshot.busy} value={chosenBot} onChange={(event) => pickBot(event.target.value)}>
        <option value="">{t('defaultModel')}{snapshot.state?.defaultRoute === undefined ? '' : ` · ${snapshot.state.defaultRoute.model}`}</option>
        {bots.map((item) => <option key={item.id} value={item.id} title={item.description}>{item.id}</option>)}
      </select></label>}
      <div className="sd-scroll" ref={scroller} onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 56 }}>
        {quote !== '' && <details className="sd-quote"><summary>{t('quote')} · {quote.length}</summary><blockquote>{quote}</blockquote></details>}
        {doc
          ? <>
              <div className="sd-scopes" role="radiogroup" aria-label={t('scope')}>
                {scopes.map((item) => <button key={item} type="button" role="radio" aria-checked={scope === item} disabled={creating || snapshot.busy || currentRunning} onClick={() => setScope(item)}>
                  {t(item === 'selection' ? 'scopeSelection' : item === 'section' ? 'scopeSection' : 'scopeArticle')}
                </button>)}
              </div>
              <p className="sd-hint">{t('docContext').replace('{what}', t(scope === 'selection' ? 'whatSelection' : scope === 'section' ? 'whatSection' : 'whatArticle')).replace('{n}', sendSize.toLocaleString())}</p>
            </>
          : <p className="sd-hint">{t('context')}</p>}
        {loading && <p role="status">{t('loading')}</p>}
        {!loading && (thread?.turns.length ?? 0) === 0 && <p className="sd-empty">{t('empty')}</p>}
        {thread?.turns.map((turn, index) => <section className="sd-round" key={turn.id} aria-label={`${index + 1} ${t('count')}`}>
          <div className="sd-question">{turn.question}</div>
          <Answer text={turn.answer} streaming={turn.status === 'running'} />
          {turn.status === 'running' && <p className="sd-hint" role="status">{t('busy')}</p>}
          {turn.error !== undefined && <div className="sd-error"><p>{turn.error}</p><p>{t('stopped')}</p><button type="button" disabled={snapshot.busy || running} onClick={() => { writeQuestion(turn.question); textarea.current?.focus() }}>{t('retry')}</button></div>}
        </section>)}
        {complete && doc && hub.doc !== undefined && <div className="sd-stage">
          <button type="button" disabled={snapshot.busy} onClick={() => void keep()}>{t('keepAnswer')}</button>
          <button type="button" disabled={snapshot.busy || opening} onClick={() => void carry()}>{t('continueSession')}</button>
        </div>}
        {complete && !doc && <div className="sd-stage"><button type="button" disabled={snapshot.busy || sent >= thread.turns.length} onClick={() => void stage()}>{sent >= thread.turns.length ? t('sent') : staged ? t('staged') : thread.confirmed > 0 ? t('update') : t('stage')}</button><small>{t('remaining')}</small></div>}
        {thread !== undefined && thread.confirmed > sent && <button className="sd-add" type="button" onClick={() => setNotice(attach(sessionId, thread) ? t('attached') : t('unavailable'))}>{t('add')}</button>}
        {snapshot.disconnected && <div className="sd-error" role="status">{t('disconnected')} <button type="button" onClick={() => client.connect()}>{t('reconnect')}</button></div>}
        {snapshot.error !== undefined && <p className="sd-error" role="alert">{snapshot.error} <button type="button" disabled={snapshot.busy} onClick={() => void client.load()}>{t('retry')}</button></p>}
        {notice !== '' && <p className="sd-hint" role="status">{notice}</p>}
      </div>
      <footer className="sd-footer">
        <label className="sd-input-label" htmlFor="sd-question">{t('question')}</label>
        <textarea id="sd-question" ref={textarea} readOnly={creating || snapshot.busy} aria-busy={creating || snapshot.busy || undefined} rows={2} maxLength={MAX_QUESTION} value={question} placeholder={thread?.turns.length ? t('followup') : quote === '' ? t('articlePlaceholder') : t('placeholder')} onChange={(event) => writeQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send() } }} />
        <div className="sd-send"><small>{thread === undefined ? t(doc ? 'docPrivacy' : 'privacy') : `${thread.route.provider} / ${thread.route.model}`}</small>{currentRunning
          ? <button type="button" disabled={snapshot.busy} onClick={() => void client.run({ op: 'cancel' }).catch(() => {})}>{t('stop')}</button>
          : <button className="sd-primary" type="button" disabled={snapshot.busy || creating || running || question.trim() === '' || snapshot.state?.enabled === false} onClick={() => void send()}>{t('send')}</button>}</div>
      </footer>
    </div>
  </>
}
