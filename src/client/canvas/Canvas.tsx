/**
 * The 画布 panel: every canvas the models wrote to ~/.dsh/canvases, newest first, and the
 * selected one running beside the list. A page runs in a sandboxed iframe without the DSH origin,
 * the same way the sidebar's HTML preview runs it. Below them, the @session snapshots saved for
 * Claude Code and Cursor (~/.dsh/dsh-agent-hub/references), shown as text.
 *
 * A canvas some session wrote offers a way back to that session from its header (canvas/source.ts).
 *
 * Room for the canvas: on a wide panel the list folds away (remembered); on a narrow one the list
 * and the canvas take turns filling it; and focus mode drops the header and goes full screen.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CanvasItem, CanvasSource } from '../../canvas/types.ts'
import { isEnglish } from '../board/i18n.ts'
import type { CanvasStore } from './api.ts'
import { t } from './i18n.ts'

export const CANVAS_PANEL_ID = 'dsh-agent-hub.canvas'

export interface CanvasFace {
  store: CanvasStore
  openSession?(sessionId: string): void
}

export function CanvasPanelIcon(props: { size: number; active?: boolean }): ReactNode {
  return (
    <svg data-dsh-panel-entry={CANVAS_PANEL_ID} viewBox="0 0 16 16" width={props.size} height={props.size} fill="none"
      stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 10.5l2.25-2.75 2 1.75 3-4" />
    </svg>
  )
}

/** One row's identity across both folders. */
const keyOf = (item: CanvasItem | undefined): string | undefined => item === undefined ? undefined : `${item.kind}:${item.name}`

const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)
const when = (time: number): string => new Date(time).toLocaleString(isEnglish() ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** At or below this panel width the list and the canvas take turns (the same breakpoint as style.ts). */
const NARROW = 640
const COLLAPSED_KEY = 'dsh-agent-hub.canvas.collapsed'

const Glyph = (props: { d: string }): ReactNode => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.25"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={props.d} />
  </svg>
)
const SIDEBAR = 'M3.5 2.5h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM6 2.5v11'
const BACK = 'M10 3.5L5.5 8l4.5 4.5'
const EXPAND = 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'
const SHRINK = 'M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5'
const COPY = 'M5.5 5.5V3a1 1 0 0 1 1-1H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-2.5M3 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z'
const CHECK = 'M3 8.5l3.25 3L13 4.5'
const SESSION = 'M3 3.5h10v7H7l-3 2.5v-2.5H3z'
const TRASH = 'M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1'

export function CanvasPage(props: CanvasFace): ReactNode {
  const { store, openSession } = props
  const { list, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [selected, setSelected] = useState<string | undefined>()
  const page = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false } })
  const [listing, setListing] = useState(false)

  useEffect(() => {
    void store.load()
    const wake = (): void => { if (document.visibilityState === 'visible') void store.load() }
    window.addEventListener('focus', wake)
    return () => window.removeEventListener('focus', wake)
  }, [store])

  useEffect(() => {
    const node = page.current
    if (node === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setNarrow(node.clientWidth <= NARROW))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const items = list?.items ?? []
  const references = list?.references ?? []
  const current = [...items, ...references].find((item) => keyOf(item) === selected) ?? items[0] ?? references[0]
  const showList = narrow ? listing || current === undefined : !collapsed
  const toggleList = (): void => {
    if (narrow) return setListing(true)
    setCollapsed(!collapsed)
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '0' : '1') } catch { /* not remembered */ }
  }
  const row = (item: CanvasItem): ReactNode => (
    <button key={keyOf(item)} type="button" className="cv-row" aria-current={keyOf(item) === keyOf(current)} title={item.path}
      onClick={() => { setSelected(keyOf(item)); setListing(false) }}>
      <span className="cv-row-title">{item.title}</span>
      <span className="cv-row-meta">{item.name} · {size(item.size)} · {when(item.mtime)}</span>
    </button>
  )
  return (
    <div ref={page} className="cv-page" data-narrow={narrow || undefined} data-list={showList || undefined}>
      <aside className="cv-side" id="cv-side">
        <div className="cv-bar">
          <h2 className="cv-title">{t('title')}</h2>
          <button type="button" className="ah-btn" onClick={() => void store.load()}>{t('refresh')}</button>
          {narrow && current !== undefined && (
            <button type="button" className="ah-btn" data-variant="primary" onClick={() => setListing(false)}>{t('backToCanvas')}</button>
          )}
        </div>
        <div className="cv-list">
          {items.map(row)}
          {list !== undefined && items.length === 0 && <p className="cv-empty">{t('empty')}</p>}
          {references.length > 0 && (
            <>
              <h3 className="cv-group" title={t('referencesHint')}>{t('references')} · {references.length}</h3>
              {references.map(row)}
            </>
          )}
          {error !== null && <p className="cv-empty">{t('failed', { message: error })}</p>}
        </div>
        {list !== undefined && (
          <div className="cv-foot">
            {t('folder', { dir: list.dir })}
            {references.length > 0 && <><br />{t('referenceFolder', { dir: list.referenceDir })}</>}
          </div>
        )}
      </aside>
      <section className="cv-main">
        {current === undefined
          ? <p className="cv-empty">{t('pick')}</p>
          : <Viewer key={keyOf(current)} item={current} store={store} narrow={narrow} listShown={showList} openSession={openSession}
              onToggleList={toggleList} onRemoved={() => setSelected(undefined)} />}
      </section>
    </div>
  )
}

interface ViewerProps {
  item: CanvasItem
  store: CanvasStore
  narrow: boolean
  listShown: boolean
  openSession: CanvasFace['openSession']
  onToggleList(): void
  onRemoved(): void
}

function Viewer(props: ViewerProps): ReactNode {
  const { item, store, narrow } = props
  const [url, setUrl] = useState<string | undefined>()
  const [text, setText] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [focused, setFocused] = useState(false)
  const [painted, setPainted] = useState<string | undefined>()
  const [source, setSource] = useState<CanvasSource | null>(null)
  const stage = useRef<HTMLDivElement>(null)

  // Re-read when the file changes on disk (a model rewrote it), not on every list refresh.
  useEffect(() => {
    let blob: string | undefined
    let live = true
    setFailure(null)
    store.read(item.name, item.kind).then((content) => {
      if (!live) return
      // A snapshot is shown as text, never run.
      if (item.kind === 'reference') return setText(content)
      blob = URL.createObjectURL(new Blob([content], { type: 'text/html' }))
      setUrl(blob)
    }, (reason: unknown) => { if (live) setFailure((reason as Error).message) })
    return () => {
      live = false
      if (blob !== undefined) URL.revokeObjectURL(blob)
    }
  }, [store, item.name, item.kind, item.mtime])

  // Asked once per version of the page: a rewrite may come from another session.
  const { openSession } = props
  useEffect(() => {
    setSource(null)
    if (item.kind !== 'canvas' || openSession === undefined) return
    let live = true
    store.source(item.name).then((found) => { if (live) setSource(found) }, () => {})
    return () => { live = false }
  }, [store, item.name, item.kind, item.mtime, openSession])

  // Focus mode fills the panel, and the whole screen where the browser grants it (iPhone Safari
  // doesn't). Leaving full screen from the browser side (Esc, system back) leaves focus mode too.
  useEffect(() => {
    if (!focused) return
    const node = stage.current
    let live = true
    const change = (): void => { if (document.fullscreenElement !== node) setFocused(false) }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setFocused(false) }
    window.addEventListener('keydown', key)
    if (node !== null && typeof node.requestFullscreen === 'function' && document.fullscreenElement === null) {
      node.requestFullscreen({ navigationUI: 'hide' }).then(() => {
        if (live) document.addEventListener('fullscreenchange', change)
      }, () => { /* stays inside the panel */ })
    }
    return () => {
      live = false
      window.removeEventListener('keydown', key)
      document.removeEventListener('fullscreenchange', change)
      if (node !== null && document.fullscreenElement === node) void document.exitFullscreen().catch(() => {})
    }
  }, [focused])

  const listLabel = narrow || !props.listShown ? t('showList') : t('hideList')
  const copyLabel = copied ? t('copied') : t('copyPath')
  const sourceLabel = source?.title === undefined ? t('openSource') : t('openSourceTitled', { title: source.title })
  return (
    <div ref={stage} className="cv-stage" data-focused={focused || undefined}>
      {!focused && (
        <div className="cv-head">
          <button type="button" className="ah-icon-btn" aria-label={listLabel} title={listLabel} aria-controls="cv-side"
            aria-expanded={narrow ? undefined : props.listShown} onClick={props.onToggleList}>
            <Glyph d={narrow ? BACK : SIDEBAR} />
          </button>
          <span className="cv-head-title" title={item.path}>{item.title}</span>
          {confirm
            ? (
                <>
                  <button type="button" className="ah-btn" data-variant="danger" onClick={() => void store.remove(item.name, item.kind).then(props.onRemoved)}>{t('confirmRemove')}</button>
                  <button type="button" className="ah-btn" onClick={() => setConfirm(false)}>{t('cancel')}</button>
                </>
              )
            : (
                <>
                  {source !== null && openSession !== undefined && (
                    <button type="button" className="ah-btn ah-btn-sm cv-source" data-variant="quiet" aria-label={sourceLabel} title={sourceLabel}
                      onClick={() => openSession(source.sessionId)}>
                      <Glyph d={SESSION} />
                      {!narrow && <span>{t('source')}</span>}
                    </button>
                  )}
                  <button type="button" className="ah-icon-btn" aria-label={copyLabel} title={copyLabel} onClick={() => {
                    void navigator.clipboard?.writeText(item.path).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                  }}><Glyph d={copied ? CHECK : COPY} /></button>
                  <button type="button" className="ah-icon-btn cv-remove" aria-label={t('remove')} title={t('remove')} onClick={() => setConfirm(true)}>
                    <Glyph d={TRASH} />
                  </button>
                  <button type="button" className="ah-icon-btn" aria-label={t('focus')} title={t('focus')} onClick={() => setFocused(true)}>
                    <Glyph d={EXPAND} />
                  </button>
                </>
              )}
        </div>
      )}
      {failure !== null
        ? <p className="cv-empty">{t('failed', { message: failure })}</p>
        : item.kind === 'reference'
          ? text === undefined ? <p className="cv-empty">{t('loading')}</p> : <pre className="cv-text">{text}</pre>
          : url === undefined
            ? <p className="cv-empty">{t('loading')}</p>
            : (
                // Hidden until the page has loaded, so the panel background shows instead of a blank white frame.
                <iframe key={url} className="cv-frame" data-ready={painted === url || undefined} title={item.title} src={url}
                  sandbox="allow-scripts" onLoad={() => requestAnimationFrame(() => setPainted(url))} />
              )}
      {focused && (
        <button type="button" className="cv-exit" aria-label={t('exitFocus')} title={t('exitFocus')} onClick={() => setFocused(false)}>
          <Glyph d={SHRINK} />
        </button>
      )}
    </div>
  )
}
