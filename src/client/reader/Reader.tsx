/**
 * The 阅读 panel: feeds on the left, the entries of the one picked in the middle, the article on the
 * right in a reading theme of its own. Below 1100px the feeds fold to a rail of icons; below 640px
 * one column shows at a time, each with a way back. Text selected in an article opens the shared
 * selection discussion, kept with the article (`doc:<key>`); the article's star and the selection's
 * Keep make favorites, which travel with the settings.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Discussion } from '../../discussion/types.ts'
import type { Entry, Favorite, FeedView, ReaderBot } from '../../reader/types.ts'
import { isEnglish } from '../board/i18n.ts'
import type { DiscussionHub } from '../discussion/store.ts'
import { Markdown } from '../review/Markdown.tsx'
import { TYPOGRAPHY, type Opened, type ReaderSnapshot, type ReaderStore, type Typography, type View } from './api.ts'
import { t, type ReaderKey } from './i18n.ts'

export const READER_PANEL_ID = 'dsh-agent-hub.reader'

export interface ReaderFace {
  store: ReaderStore
  hub: DiscussionHub | undefined
  /** Open a session, its composer seeded with `draft`. */
  openSession(sessionId: string, draft: string): void
}

type Pane = 'sources' | 'list' | 'article'

// ── Icons (one 24px stroke family) ────────────────────────────────────────

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  star: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  back: 'M15 18l-6-6 6-6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  type: 'M4 7V5h11v2M9.5 5v14M7 19h5M14 13v-1h6v1M17 12v7M15.5 19h3',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  circle: 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  check: 'M5 12.5l4.5 4.5L19 7',
  down: 'M12 5v14M6 13l6 6 6-6',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM7.5 7.5h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  github: 'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
} as const

function Icon(props: { name: keyof typeof PATHS; filled?: boolean; size?: number }): ReactNode {
  const size = props.size ?? 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={props.filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[props.name]} />
    </svg>
  )
}

function IconButton(props: { icon: keyof typeof PATHS; label: string; onClick?: () => void; pressed?: boolean; filled?: boolean; disabled?: boolean; spin?: boolean; className?: string }): ReactNode {
  return (
    <button type="button" className={`rd-icon${props.className === undefined ? '' : ` ${props.className}`}`} aria-label={props.label} title={props.label}
      aria-pressed={props.pressed} disabled={props.disabled} data-spin={props.spin ? '' : undefined} onClick={props.onClick}>
      <Icon name={props.icon} filled={props.filled} />
    </button>
  )
}

export function ReaderPanelIcon(props: { size: number; active?: boolean }): ReactNode {
  return (
    <svg data-dsh-panel-entry={READER_PANEL_ID} viewBox="0 0 16 16" width={props.size} height={props.size} fill="none"
      stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.5c2-.8 4-.8 6 .6v9.4c-2-1.4-4-1.4-6-.6zM14 3.5c-2-.8-4-.8-6 .6v9.4c2-1.4 4-1.4 6-.6z" />
    </svg>
  )
}

// ── Formatting ────────────────────────────────────────────────────────────

function ago(time: number): string {
  if (!time) return ''
  const minutes = Math.round((Date.now() - time) / 60_000)
  const format = new Intl.RelativeTimeFormat(isEnglish() ? 'en' : 'zh-CN', { numeric: 'auto', style: 'short' })
  if (minutes < 60) return format.format(-Math.max(1, minutes), 'minute')
  if (minutes < 60 * 24) return format.format(-Math.round(minutes / 60), 'hour')
  if (minutes < 60 * 24 * 30) return format.format(-Math.round(minutes / 60 / 24), 'day')
  return new Date(time).toLocaleDateString(isEnglish() ? 'en' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

const initial = (title: string): string => Array.from(title.replace(/^(https?:\/\/)?(www\.)?/, '').trim())[0]?.toUpperCase() ?? '·'
const SOURCE: Record<string, ReaderKey> = { feed: 'sourceFeed', page: 'sourcePage', summary: 'sourceSummary', readme: 'sourceReadme', release: 'sourceRelease' }
const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="dialog"]') !== null)

/** A small panel beside its button; outside clicks and Escape close it. */
function Popover(props: { onClose(): void; label: string; children: ReactNode; className?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  // Once per opening: the owner re-renders as its controls change, and focus must stay where it is.
  useEffect(() => {
    const down = (event: PointerEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target) || ref.current?.parentElement?.contains(target)) return
      close.current()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [])
  return <div ref={ref} className={`rd-pop${props.className === undefined ? '' : ` ${props.className}`}`} role="dialog" aria-label={props.label}>{props.children}</div>
}

// ── The page ──────────────────────────────────────────────────────────────

export function ReaderPage(props: ReaderFace): ReactNode {
  const { store, hub } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [pane, setPane] = useState<Pane>('list')
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void store.load().then(() => store.follow())
    const wake = (): void => { if (document.visibilityState === 'visible') void store.load() }
    window.addEventListener('focus', wake)
    return () => window.removeEventListener('focus', wake)
  }, [store])

  // The discussion panel's document actions, for the article open here.
  useEffect(() => {
    if (hub === undefined) return
    const current = (owner: string): NonNullable<ReaderSnapshot['article']> => {
      const article = store.getSnapshot().article
      if (article === undefined || article.key !== owner) throw new Error(t('pick'))
      return article
    }
    const site = (): string | undefined => {
      const { opened, state } = store.getSnapshot()
      return opened?.favorite?.site ?? state?.feeds.find((feed) => feed.id === opened?.entry?.feed)?.title
    }
    hub.doc = {
      markdown: (owner) => store.markdown(owner),
      keep: async (owner, quote, note) => {
        const article = current(owner)
        const from = site()
        await store.keep({ url: article.url, title: article.title, ...(quote === '' ? {} : { quote }), ...(note === undefined ? {} : { note }), ...(from === undefined ? {} : { site: from }) })
      },
      continueInSession: async (owner, thread) => {
        const article = current(owner)
        const entry = store.getSnapshot().opened?.entry
        const { sessionId, draft } = await store.session({
          url: article.url, ...(entry === undefined ? {} : { entry: entry.id }), ...(thread.bot === undefined ? {} : { bot: thread.bot }), context: discussionText(thread),
        })
        props.openSession(sessionId, draft)
      },
    }
    return () => { if (hub.doc !== undefined) hub.doc = undefined }
  }, [hub, store, props.openSession])

  // Stable: the rows are memoized and keep their render while the list around them changes.
  const open = useCallback((opened: Opened): void => {
    void store.open(opened)
    setPane('article')
  }, [store])
  const pick = (view: View): void => {
    store.setView(view)
    setPane('list')
  }

  // j/k move through the list, s keeps, a analyzes, o opens the original, u toggles read.
  const latest = useRef({ snapshot, open })
  latest.current = { snapshot, open }
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return
      if (root.current === null || root.current.offsetParent === null) return
      const { snapshot: current, open: go } = latest.current
      const rows: Opened[] = current.view === 'favorites'
        ? (current.state?.favorites ?? []).map((favorite) => ({ url: favorite.url, title: favorite.title, favorite }))
        : current.entries.map((entry) => ({ url: entry.url, title: entry.title, entry }))
      const index = rows.findIndex((row) => row.url === current.opened?.url && row.favorite?.id === current.opened?.favorite?.id)
      const article = current.article
      switch (event.key) {
        case 'j': case 'k': {
          const next = rows[index < 0 ? 0 : index + (event.key === 'j' ? 1 : -1)]
          if (next !== undefined) { go(next); document.querySelector(`[data-rd-row="${CSS.escape(next.favorite?.id ?? next.entry?.id ?? next.url)}"]`)?.scrollIntoView({ block: 'nearest' }) }
          break
        }
        case 's': if (article !== undefined) void toggleFavorite(store, current); break
        case 'a': if (article !== undefined) analyze(hub, article.key, root.current.querySelector('[data-rd-analyze]')); break
        case 'o': if (current.opened !== undefined) window.open(current.opened.url, '_blank', 'noopener,noreferrer'); break
        case 'u': if (current.opened?.entry !== undefined) void store.setRead([current.opened.entry.id], !current.opened.entry.read); break
        // One column at a time only below 640px: there Escape goes back a column.
        case 'Escape': if (pane !== 'sources' && root.current.clientWidth < 640) { setPane(pane === 'article' ? 'list' : 'sources'); break } return
        default: return
      }
      event.preventDefault()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [store, hub, pane])

  return (
    <div className="rd-root" ref={root}>
      <div className="rd-page" data-pane={pane}>
        <Sources snapshot={snapshot} store={store} onPick={pick} />
        <List snapshot={snapshot} store={store} onOpen={open} onBack={() => setPane('sources')} />
        <ArticlePane snapshot={snapshot} store={store} hub={hub} openSession={props.openSession} onBack={() => setPane('list')} />
      </div>
    </div>
  )
}

function discussionText(thread: Discussion): string {
  const rounds = thread.turns.filter((turn) => turn.status === 'complete').map((turn) => t('discussionRound', { q: turn.question, a: turn.answer }))
  return [thread.quote === '' ? '' : `${t('discussionQuote')}\n> ${thread.quote.replace(/\n/g, '\n> ')}`, ...rounds].filter(Boolean).join('\n\n')
}

async function toggleFavorite(store: ReaderStore, snapshot: ReaderSnapshot): Promise<void> {
  const article = snapshot.article
  if (article === undefined) return
  const kept = store.favoriteOf(article.url)
  if (kept !== undefined) return store.unkeep(kept.id)
  const site = snapshot.opened?.favorite?.site ?? snapshot.state?.feeds.find((feed) => feed.id === snapshot.opened?.entry?.feed)?.title
  await store.keep({ url: article.url, title: article.title, ...(site === undefined ? {} : { site }) })
}

/** The discussion panel on the whole article, beside the button that asked. */
function analyze(hub: DiscussionHub | undefined, key: string, anchor: Element | null): void {
  if (hub === undefined) return
  const rect = anchor?.getBoundingClientRect()
  hub.open(key, undefined, { sessionId: key, quote: '', scope: 'article', x: rect?.left ?? innerWidth - 460, y: rect?.bottom ?? 72, top: rect?.top ?? 72, floor: innerHeight })
}

// ── Feeds ─────────────────────────────────────────────────────────────────

function Sources(props: { snapshot: ReaderSnapshot; store: ReaderStore; onPick(view: View): void }): ReactNode {
  const { snapshot, store } = props
  const [adding, setAdding] = useState(false)
  const feeds = snapshot.state?.feeds ?? []
  const unread = feeds.reduce((sum, feed) => sum + feed.unread, 0)
  const row = (view: View, label: string, icon: ReactNode, count?: number, extra?: { title?: string; error?: string }): ReactNode => (
    <button key={view} type="button" className="rd-source" aria-current={snapshot.view === view} title={extra?.title ?? label} onClick={() => props.onPick(view)}>
      <span className="rd-source-icon">{icon}</span>
      <span className="rd-source-label">{label}</span>
      {extra?.error !== undefined && <span className="rd-source-warn" title={t('feedError', { message: extra.error })}><Icon name="warn" size={14} /></span>}
      {count !== undefined && count > 0 && <span className="rd-count">{count > 999 ? '999+' : count}</span>}
    </button>
  )
  return (
    <nav className="rd-sources" aria-label={t('feeds')}>
      <div className="rd-bar">
        <h2 className="rd-title">{t('title')}</h2>
        <IconButton icon="refresh" label={snapshot.state?.refreshing ? t('refreshing') : t('refresh')} spin={snapshot.state?.refreshing} onClick={() => void store.refresh()} />
        <span className="rd-anchor">
          <IconButton icon="plus" label={t('add')} pressed={adding} onClick={() => setAdding(!adding)} />
          {adding && <AddFeed store={store} onClose={() => setAdding(false)} />}
        </span>
      </div>
      <div className="rd-sources-list">
        {row('unread', t('unread'), <Icon name="inbox" />, unread)}
        {row('all', t('all'), <Icon name="list" />)}
        {row('favorites', t('favorites'), <Icon name="star" />, snapshot.state?.favorites.length)}
        {feeds.length > 0 && <h3 className="rd-group">{t('feeds')}</h3>}
        {feeds.map((feed) => row(feed.id, feed.title, feed.kind === 'github' ? <Icon name="github" /> : <span className="rd-avatar" aria-hidden="true">{initial(feed.title)}</span>, feed.unread,
          { title: feed.title, ...(feed.error === undefined ? {} : { error: feed.error }) }))}
        {snapshot.state !== undefined && feeds.length === 0 && <p className="rd-hint">{t('empty')}</p>}
      </div>
    </nav>
  )
}

function AddFeed(props: { store: ReaderStore; onClose(): void }): ReactNode {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const submit = async (): Promise<void> => {
    if (input.trim() === '' || busy) return
    setBusy(true)
    setMessage(t('subscribing'))
    try {
      await props.store.add(input)
      props.onClose()
    } catch (error) {
      setMessage(t('failed', { message: (error as Error).message }))
    } finally {
      setBusy(false)
    }
  }
  const exportOpml = async (): Promise<void> => {
    const text = await props.store.exportOpml()
    const url = URL.createObjectURL(new Blob([text], { type: 'text/x-opml' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: 'agent-hub-feeds.opml' })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Popover label={t('add')} onClose={props.onClose} className="rd-add">
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label className="rd-field-label" htmlFor="rd-add-input">{t('add')}</label>
        <div className="rd-add-row">
          <input id="rd-add-input" className="rd-input" type="url" inputMode="url" autoComplete="url" spellCheck={false} value={input}
            placeholder={t('addPlaceholder')} onChange={(event) => setInput(event.target.value)} aria-describedby="rd-add-hint" disabled={busy} />
          <button type="submit" className="ah-btn" data-variant="primary" disabled={busy || input.trim() === ''}>{t('subscribe')}</button>
        </div>
        <p id="rd-add-hint" className="rd-hint">{t('addHint')}</p>
        {message !== null && <p className="rd-hint" role="status">{message}</p>}
        <div className="rd-add-row">
          <button type="button" className="ah-btn" onClick={() => file.current?.click()}>{t('importOpml')}</button>
          <button type="button" className="ah-btn" onClick={() => void exportOpml().catch((error: unknown) => setMessage(t('failed', { message: (error as Error).message })))}>{t('exportOpml')}</button>
          <input ref={file} type="file" accept=".opml,.xml,text/xml,text/x-opml" hidden onChange={(event) => {
            const picked = event.target.files?.[0]
            event.target.value = ''
            if (picked === undefined) return
            void picked.text().then((text) => props.store.importOpml(text)).then(
              (added) => setMessage(t('imported', { n: added })),
              (error: unknown) => setMessage(t('failed', { message: (error as Error).message })),
            )
          }} />
        </div>
      </form>
    </Popover>
  )
}

// ── Entries ───────────────────────────────────────────────────────────────

function viewTitle(snapshot: ReaderSnapshot, feed: FeedView | undefined): string {
  if (feed !== undefined) return feed.title
  return t(snapshot.view === 'all' ? 'all' : snapshot.view === 'favorites' ? 'favorites' : 'unread')
}

function List(props: { snapshot: ReaderSnapshot; store: ReaderStore; onOpen(opened: Opened): void; onBack(): void }): ReactNode {
  const { snapshot, store } = props
  const feed = snapshot.state?.feeds.find((item) => item.id === snapshot.view)
  const favorites = snapshot.view === 'favorites'
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setMenu(false); setConfirm(false) }, [snapshot.view])
  const rename = (): void => {
    if (feed === undefined) return
    const title = window.prompt(t('renamePrompt'), feed.title)?.trim()
    setMenu(false)
    if (title) void store.rename(feed.id, title)
  }
  const openedKey = snapshot.opened?.favorite?.id ?? snapshot.opened?.entry?.id
  const titles = useMemo(() => new Map((snapshot.state?.feeds ?? []).map((item) => [item.id, item.title])), [snapshot.state?.feeds])
  return (
    <section className="rd-list" aria-label={viewTitle(snapshot, feed)}>
      <div className="rd-bar">
        <IconButton icon="back" label={t('back')} className="rd-only-narrow" onClick={props.onBack} />
        <h2 className="rd-title" title={viewTitle(snapshot, feed)}>{viewTitle(snapshot, feed)}</h2>
        {!favorites && <IconButton icon="check" label={t('readAll')} onClick={() => void store.readAll()} />}
        {feed !== undefined && (
          <span className="rd-anchor">
            <IconButton icon="more" label={t('actions')} pressed={menu} onClick={() => setMenu(!menu)} />
            {menu && (
              <Popover label={feed.title} onClose={() => { setMenu(false); setConfirm(false) }} className="rd-menu">
                <button type="button" className="rd-menu-item" onClick={() => { setMenu(false); void store.refresh(feed.id) }}><Icon name="refresh" size={16} />{t('refresh')}</button>
                <button type="button" className="rd-menu-item" onClick={rename}><Icon name="type" size={16} />{t('rename')}</button>
                <a className="rd-menu-item" href={feed.home ?? feed.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} />{t('openOriginal')}</a>
                {confirm
                  ? <button type="button" className="rd-menu-item" data-danger="" onClick={() => { setMenu(false); void store.unsubscribe(feed.id) }}><Icon name="trash" size={16} />{t('confirmUnsubscribe')}</button>
                  : <button type="button" className="rd-menu-item" data-danger="" onClick={() => setConfirm(true)}><Icon name="trash" size={16} />{t('unsubscribe')}</button>}
              </Popover>
            )}
          </span>
        )}
      </div>
      {feed?.error !== undefined && <p className="rd-banner" role="status"><Icon name="warn" size={14} /> {t('feedError', { message: feed.error })}</p>}
      {snapshot.error !== null && <p className="rd-banner" role="alert">{t('failed', { message: snapshot.error })} <button type="button" className="ah-btn ah-btn-sm" onClick={() => void store.load()}>{t('retry')}</button></p>}
      <div className="rd-items">
        {favorites
          ? (snapshot.state?.favorites ?? []).map((favorite) => <FavoriteRow key={favorite.id} favorite={favorite} current={openedKey === favorite.id} store={store} onOpen={props.onOpen} />)
          : snapshot.entries.map((entry) => <EntryRow key={entry.id} entry={entry} current={openedKey === entry.id} feedTitle={feed === undefined ? titles.get(entry.feed) : undefined} onOpen={props.onOpen} />)}
        {!favorites && snapshot.entries.length > 0 && <ListFooter snapshot={snapshot} store={store} feed={feed} />}
        {favorites && snapshot.state !== undefined && snapshot.state.favorites.length === 0 && <p className="rd-hint rd-empty">{t('emptyFavorites')}</p>}
        {!favorites && !snapshot.listLoading && snapshot.state !== undefined && snapshot.entries.length === 0 && (snapshot.state.feeds.length > 0 || feed !== undefined) && (
          <p className="rd-hint rd-empty">{snapshot.view === 'unread' ? t('emptyUnread') : t('emptyList')}</p>
        )}
        {!favorites && snapshot.listLoading && snapshot.entries.length === 0 && <Skeleton />}
      </div>
    </section>
  )
}

function Skeleton(): ReactNode {
  return <div aria-hidden="true">{[0, 1, 2, 3].map((index) => <div key={index} className="rd-skeleton"><i /><i /><i /></div>)}</div>
}

/**
 * The list's end: what is kept here loads by itself as it scrolls into view; a feed's older pages, read from its source,
 * load when asked; past the last, where to read on.
 */
function ListFooter(props: { snapshot: ReaderSnapshot; store: ReaderStore; feed: FeedView | undefined }): ReactNode {
  const { snapshot, store, feed } = props
  const { more, older, listLoading, moreError, view } = snapshot
  const ref = useRef<HTMLDivElement>(null)
  const auto = more && !listLoading && moreError === null
  useEffect(() => {
    const node = ref.current
    if (!auto || node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((seen) => { if (seen.some((item) => item.isIntersecting)) void store.loadMore() }, { root: node.parentElement, rootMargin: '0px 0px 320px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [auto, store, snapshot.entries.length])
  const fromSource = !more && older !== undefined
  if (!more && older === undefined) {
    return (
      <div className="rd-foot" ref={ref}>
        <p className="rd-end">
          <span>{t('end')}</span>
          {feed !== undefined && <a href={feed.home ?? feed.url} target="_blank" rel="noopener noreferrer">{t('endOriginal')}<Icon name="external" size={13} /></a>}
          {feed === undefined && view === 'all' && <span className="rd-end-hint">{t('endHint')}</span>}
        </p>
      </div>
    )
  }
  return (
    <div className="rd-foot" ref={ref}>
      <button type="button" className="rd-more" aria-busy={listLoading} disabled={listLoading} onClick={() => void store.loadMore()}>
        {listLoading ? <span className="rd-spinner" aria-hidden="true" /> : <Icon name={moreError === null ? 'down' : 'refresh'} size={16} />}
        <span>{listLoading ? t(fromSource ? 'loadingOlder' : 'loading') : moreError !== null ? t('retry') : t(fromSource ? 'older' : 'more')}</span>
      </button>
      {moreError !== null
        ? <p className="rd-foot-note" role="alert">{t('failed', { message: moreError })}</p>
        : fromSource && !listLoading && <p className="rd-foot-note">{t('olderHint')}</p>}
    </div>
  )
}

/** Memoized: a list of hundreds re-renders only the rows whose entry, mark or selection changed. */
const EntryRow = memo(function EntryRow(props: { entry: Entry; feedTitle: string | undefined; current: boolean; onOpen(opened: Opened): void }): ReactNode {
  const { entry } = props
  return (
    <button type="button" className="rd-entry" data-rd-row={entry.id} aria-current={props.current} data-unread={entry.read ? undefined : ''}
      onClick={() => props.onOpen({ url: entry.url, title: entry.title, entry })}>
      <span className="rd-entry-meta">
        {!entry.read && <span className="rd-dot" aria-label={t('unread')} />}
        {props.feedTitle !== undefined && <span className="rd-entry-feed">{props.feedTitle}</span>}
        <span>{ago(entry.published)}</span>
      </span>
      <span className="rd-entry-title">{entry.title}</span>
      {entry.repo !== undefined && (
        <span className="rd-chips">
          {entry.repo.tag !== undefined && <span className="rd-chip">{entry.repo.tag}</span>}
          {entry.repo.language !== undefined && <span className="rd-chip">{entry.repo.language}</span>}
          {entry.repo.stars !== undefined && <span className="rd-chip">★ {entry.repo.stars.toLocaleString()}</span>}
        </span>
      )}
      {entry.summary !== '' && <span className="rd-entry-summary">{entry.summary}</span>}
    </button>
  )
})

function FavoriteRow(props: { favorite: Favorite; current: boolean; store: ReaderStore; onOpen(opened: Opened): void }): ReactNode {
  const { favorite } = props
  return (
    <div className="rd-fav" aria-current={props.current} data-rd-row={favorite.id}>
      <button type="button" className="rd-entry" onClick={() => props.onOpen({ url: favorite.url, title: favorite.title, favorite })}>
        <span className="rd-entry-meta">{favorite.site !== undefined && <span className="rd-entry-feed">{favorite.site}</span>}<span>{ago(favorite.at)}</span></span>
        <span className="rd-entry-title">{favorite.title}</span>
        {favorite.quote !== undefined && <span className="rd-fav-quote">{favorite.quote}</span>}
        {favorite.note !== undefined && <span className="rd-entry-summary">{favorite.note.replace(/[#*_`>]/g, '').slice(0, 240)}</span>}
      </button>
      <IconButton icon="trash" label={t('removeFavorite')} className="rd-fav-remove" onClick={() => void props.store.unkeep(favorite.id)} />
    </div>
  )
}

// ── The article ───────────────────────────────────────────────────────────

function ArticlePane(props: { snapshot: ReaderSnapshot; store: ReaderStore; hub: DiscussionHub | undefined; openSession: ReaderFace['openSession']; onBack(): void }): ReactNode {
  const { snapshot, store, hub } = props
  const { opened, article, typography } = snapshot
  const [popover, setPopover] = useState<'type' | 'session' | 'project' | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    setPopover(null)
  }, [opened?.url, opened?.favorite?.id])
  const kept = article === undefined ? undefined : store.favoriteOf(article.url)
  const feed = snapshot.state?.feeds.find((item) => item.id === opened?.entry?.feed)
  const repo = opened?.entry?.repo ?? (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(opened?.url ?? '') ? { name: opened!.url.replace(/^https:\/\/github\.com\/|\/$/g, '') } : undefined)
  const style = {
    '--rd-size': `${typography.size}px`,
    '--rd-width': `${typography.width}ch`,
    '--rd-leading': String(typography.leading),
  } as Record<string, string>
  return (
    <section className="rd-reader" data-theme={typography.theme} data-font={typography.font} style={style} aria-label={opened?.title ?? t('pick')}>
      <div className="rd-tools">
        <IconButton icon="back" label={t('back')} className="rd-only-narrow" onClick={props.onBack} />
        <span className="rd-tools-gap" />
        {opened !== undefined && (
          <>
            {article !== undefined && <IconButton icon="star" label={kept === undefined ? t('favorite') : t('unfavorite')} pressed={kept !== undefined} filled={kept !== undefined} onClick={() => void toggleFavorite(store, snapshot)} />}
            {opened.entry !== undefined && <IconButton icon="circle" label={opened.entry.read ? t('markUnread') : t('markRead')} filled={!opened.entry.read} onClick={() => void store.setRead([opened.entry!.id], !opened.entry!.read)} />}
            <a className="rd-icon" href={opened.url} target="_blank" rel="noopener noreferrer" aria-label={t('openOriginal')} title={t('openOriginal')}><Icon name="external" /></a>
            {article !== undefined && (
              <span className="rd-anchor">
                <IconButton icon="terminal" label={repo === undefined ? t('session') : t('sessionProject')} pressed={popover === 'session'} onClick={() => setPopover(popover === 'session' ? null : 'session')} />
                {popover === 'session' && <SessionStart store={store} opened={opened} project={repo !== undefined} bots={snapshot.state?.bots ?? []} openSession={props.openSession} onClose={() => setPopover(null)} />}
              </span>
            )}
          </>
        )}
        <span className="rd-anchor">
          <IconButton icon="type" label={t('typography')} pressed={popover === 'type'} onClick={() => setPopover(popover === 'type' ? null : 'type')} />
          {popover === 'type' && <TypographyPanel typography={typography} onChange={(patch) => store.setTypography(patch)} onClose={() => setPopover(null)} />}
        </span>
        {article !== undefined && hub !== undefined && (
          <button type="button" className="rd-analyze" data-rd-analyze="" title={t('analyzeHint')} onClick={(event) => analyze(hub, article.key, event.currentTarget)}>
            <Icon name="sparkle" size={16} /><span>{t('analyze')}</span>
          </button>
        )}
      </div>
      <div className="rd-scroll" ref={scroller}>
        {opened === undefined && <div className="rd-placeholder"><Icon name="list" size={28} /><p>{t('pick')}</p><p className="rd-keys">{t('shortcuts')}</p></div>}
        {opened !== undefined && snapshot.articleLoading && <ArticleSkeleton title={opened.title} />}
        {opened !== undefined && snapshot.articleError !== null && (
          <div className="rd-placeholder" role="alert"><p>{t('failed', { message: snapshot.articleError })}</p>
            <button type="button" className="ah-btn" onClick={() => void store.open(opened)}>{t('retry')}</button>
            <a className="ah-btn" href={opened.url} target="_blank" rel="noopener noreferrer">{t('openOriginal')}</a></div>
        )}
        {article !== undefined && (
          <article className="rd-article" data-discussion-doc={article.key} data-discussion-source={article.title}>
            <header className="rd-article-head">
              <p className="rd-byline">
                {(opened?.favorite?.site ?? feed?.title) !== undefined && <span>{opened?.favorite?.site ?? feed?.title}</span>}
                {opened?.entry?.author !== undefined && <span>{opened.entry.author}</span>}
                {opened?.entry !== undefined && <time dateTime={new Date(opened.entry.published).toISOString()}>{ago(opened.entry.published)}</time>}
                <span className="rd-badge" title={t(SOURCE[article.source] ?? 'sourcePage')}>{article.cleaned > 0 ? t('cleaned', { n: article.cleaned }) : t('clean')}</span>
              </p>
              <h1>{article.title}</h1>
              {repo !== undefined && opened?.entry?.repo !== undefined && (
                <p className="rd-chips">
                  {opened.entry.repo.tag !== undefined && <span className="rd-chip">{opened.entry.repo.tag}</span>}
                  {opened.entry.repo.language !== undefined && <span className="rd-chip">{opened.entry.repo.language}</span>}
                  {opened.entry.repo.stars !== undefined && <span className="rd-chip">{t('stars', { n: opened.entry.repo.stars.toLocaleString() })}</span>}
                </p>
              )}
            </header>
            {article.notes !== undefined && (
              <details className="rd-release">
                <summary><Icon name="tag" size={15} /><span>{t('releaseNotes', { tag: opened?.entry?.repo?.tag ?? '' })}</span></summary>
                <div className="rd-release-body"><Markdown text={article.notes} /></div>
              </details>
            )}
            {article.error !== undefined && <p className="rd-notice">{t(article.source === 'summary' ? 'summaryOnly' : 'feedOnly', { message: article.error })}</p>}
            <Body markdown={article.markdown} quotes={(snapshot.state?.favorites ?? []).filter((favorite) => favorite.url === article.url && favorite.quote !== undefined).map((favorite) => favorite.quote!)} />
            {opened?.favorite?.note !== undefined && (
              <aside className="rd-note"><h2>{t('note')}</h2><Markdown text={opened.favorite.note} /></aside>
            )}
          </article>
        )}
      </div>
    </section>
  )
}

function ArticleSkeleton(props: { title: string }): ReactNode {
  return (
    <div className="rd-article" aria-busy="true">
      <p className="rd-byline" role="status">{t('loadingArticle')}</p>
      <h1>{props.title}</h1>
      <div className="rd-skeleton rd-skeleton-body" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    </div>
  )
}

/** The article's Markdown; passages kept from it are marked where they sit in one piece of text. */
function Body(props: { markdown: string; quotes: string[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const quotes = props.quotes.join('\u0000')
  useEffect(() => {
    const node = ref.current
    if (node === null) return
    for (const mark of node.querySelectorAll('mark[data-rd-kept]')) mark.replaceWith(...mark.childNodes)
    node.normalize()
    for (const quote of props.quotes) {
      const needle = quote.split('\n')[0]!.trim()
      if (needle.length < 4) continue
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      for (let text = walker.nextNode() as Text | null; text !== null; text = walker.nextNode() as Text | null) {
        const at = text.data.indexOf(needle)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + needle.length)
        const mark = document.createElement('mark')
        mark.dataset.rdKept = ''
        range.surroundContents(mark)
        break
      }
    }
  }, [props.markdown, quotes])
  return <div ref={ref} className="rd-body"><Markdown text={props.markdown} /></div>
}

function SessionStart(props: { store: ReaderStore; opened: Opened; project: boolean; bots: ReaderBot[]; openSession: ReaderFace['openSession']; onClose(): void }): ReactNode {
  const [bot, setBot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { sessionId, draft } = await props.store.session({
        url: props.opened.url, ...(props.opened.entry === undefined ? {} : { entry: props.opened.entry.id }), project: props.project,
        ...(bot === '' ? {} : { bot }), context: t(props.project ? 'projectPrompt' : 'articlePrompt'),
      })
      props.onClose()
      props.openSession(sessionId, draft)
    } catch (reason) {
      setError((reason as Error).message)
      setBusy(false)
    }
  }
  return (
    <Popover label={props.project ? t('sessionProject') : t('session')} onClose={props.onClose} className="rd-session">
      <strong>{props.project ? t('sessionProject') : t('session')}</strong>
      <p className="rd-hint">{t('sessionHint', { what: t(props.project ? 'sessionWhatProject' : 'sessionWhatArticle') })}</p>
      {props.bots.length > 0 && (
        <label className="rd-field">
          <span className="rd-field-label">{t('sessionBy')}</span>
          <select className="rd-input" value={bot} disabled={busy} onChange={(event) => setBot(event.target.value)}>
            <option value="">{t('defaultModel')}</option>
            {props.bots.map((item) => <option key={item.id} value={item.id} title={item.description}>{item.id}</option>)}
          </select>
        </label>
      )}
      {error !== null && <p className="rd-hint" role="alert">{t('failed', { message: error })}</p>}
      <div className="rd-add-row">
        <button type="button" className="ah-btn" onClick={props.onClose}>{t('cancel')}</button>
        <button type="button" className="ah-btn" data-variant="primary" disabled={busy} onClick={() => void start()}>{busy ? t('starting') : t('start')}</button>
      </div>
    </Popover>
  )
}

function TypographyPanel(props: { typography: Typography; onChange(patch: Partial<Typography>): void; onClose(): void }): ReactNode {
  const { typography, onChange } = props
  const segment = <K extends keyof Typography>(key: K, options: ReadonlyArray<[Typography[K], ReaderKey]>, label: ReaderKey): ReactNode => (
    <div className="rd-field">
      <span className="rd-field-label" id={`rd-${key}`}>{t(label)}</span>
      <div className="rd-segment" role="radiogroup" aria-labelledby={`rd-${key}`}>
        {options.map(([value, text]) => (
          <button key={String(value)} type="button" role="radio" aria-checked={typography[key] === value} data-swatch={key === 'theme' ? String(value) : undefined}
            onClick={() => onChange({ [key]: value } as Partial<Typography>)}>{t(text)}</button>
        ))}
      </div>
    </div>
  )
  const range = (key: 'size' | 'width' | 'leading', label: ReaderKey, min: number, max: number, step: number, show: (value: number) => string): ReactNode => (
    <label className="rd-field">
      <span className="rd-field-label">{t(label)}<output>{show(typography[key])}</output></span>
      <input type="range" min={min} max={max} step={step} value={typography[key]} onChange={(event) => onChange({ [key]: Number(event.target.value) })} />
    </label>
  )
  return (
    <Popover label={t('typography')} onClose={props.onClose} className="rd-type">
      {segment('theme', [['auto', 'themeAuto'], ['light', 'themeLight'], ['sepia', 'themeSepia'], ['dark', 'themeDark']], 'theme')}
      {segment('font', [['serif', 'serif'], ['sans', 'sans']], 'font')}
      {range('size', 'size', 14, 26, 1, (value) => `${value}px`)}
      {range('width', 'width', 48, 90, 2, (value) => `${value}`)}
      {range('leading', 'leading', 1.4, 2.2, 0.1, (value) => value.toFixed(1))}
      <button type="button" className="ah-btn" onClick={() => onChange(TYPOGRAPHY)}>{t('reset')}</button>
    </Popover>
  )
}
