/**
 * The reader page's state: the host's feeds and favorites, the entries of the view picked, the
 * article open, and this device's typography (kept in the browser, not synced, like DSH's own theme).
 */

import {
  READER_METHOD, type Article, type ArticleReply, type Entry, type EntryList, type Favorite, type OlderReply, type ReaderRequest, type ReaderState, type SessionReply,
} from '../../reader/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

export type ReaderCall = (payload: ReaderRequest) => Promise<unknown>

export function readerCall(rpc: Rpc): ReaderCall {
  return (payload) => rpcValue(rpc, READER_METHOD, payload, 'agent-hub reader RPC failed')
}

/** `unread`, `all`, `favorites`, or a feed id. */
export type View = string

/** What is open: a feed entry, or a favorite (whose entry may be gone). */
export interface Opened {
  url: string
  title: string
  entry?: Entry
  favorite?: Favorite
}

export type ReaderTheme = 'auto' | 'light' | 'sepia' | 'dark'
export interface Typography {
  theme: ReaderTheme
  font: 'serif' | 'sans'
  /** px */
  size: number
  /** characters per line */
  width: number
  leading: number
}
export const TYPOGRAPHY: Typography = { theme: 'auto', font: 'serif', size: 18, width: 68, leading: 1.8 }
const TYPOGRAPHY_KEY = 'agent-hub.reader.typography'

function readTypography(): Typography {
  try {
    const saved = JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY) ?? '{}') as Partial<Typography>
    const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
    return {
      theme: (['auto', 'light', 'sepia', 'dark'] as const).find((theme) => theme === saved.theme) ?? TYPOGRAPHY.theme,
      font: saved.font === 'sans' ? 'sans' : 'serif',
      size: clamp(saved.size, 14, 26, TYPOGRAPHY.size),
      width: clamp(saved.width, 48, 90, TYPOGRAPHY.width),
      leading: clamp(saved.leading, 1.4, 2.2, TYPOGRAPHY.leading),
    }
  } catch {
    return TYPOGRAPHY
  }
}

export interface ReaderSnapshot {
  state: ReaderState | undefined
  error: string | null
  view: View
  entries: Entry[]
  /** More entries are here; `older`: the feed's source may have older pages (how many were read). */
  more: boolean
  older: number | undefined
  listLoading: boolean
  /** Loading the next page (here, or older from the source) failed. */
  moreError: string | null
  opened: Opened | undefined
  article: Article | undefined
  articleLoading: boolean
  articleError: string | null
  typography: Typography
}

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class ReaderStore {
  private snapshot: ReaderSnapshot = {
    state: undefined, error: null, view: 'unread', entries: [], more: false, older: undefined, listLoading: false, moreError: null,
    opened: undefined, article: undefined, articleLoading: false, articleError: null, typography: readTypography(),
  }
  private readonly listeners = new Set<() => void>()
  private readonly call: ReaderCall
  /** Markdown of the articles read on this page, by their discussion key, for the discussion panel. */
  private readonly texts = new Map<string, string>()
  private listToken = 0
  private articleToken = 0

  constructor(call: ReaderCall) {
    this.call = call
  }

  getSnapshot = (): ReaderSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(patch: Partial<ReaderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  markdown(key: string): string | undefined {
    return this.texts.get(key)
  }

  private async run(payload: ReaderRequest): Promise<ReaderState> {
    const state = await this.call(payload) as ReaderState
    this.publish({ state, error: null })
    return state
  }

  async load(): Promise<void> {
    try {
      await this.run({ op: 'state' })
      if (this.snapshot.view !== 'favorites') await this.loadEntries(false)
    } catch (error) {
      this.publish({ error: errorOf(error) })
    }
  }

  /** While a refresh runs, read again until it is done. */
  async follow(): Promise<void> {
    for (let round = 0; round < 60 && this.snapshot.state?.refreshing === true; round++) {
      await sleep(2000)
      await this.run({ op: 'state' }).catch(() => undefined)
    }
    if (this.snapshot.view !== 'favorites') await this.loadEntries(false)
  }

  setView(view: View): void {
    if (view === this.snapshot.view) return
    this.listToken++
    this.publish({ view, entries: [], more: false, older: undefined, listLoading: false, moreError: null })
    if (view !== 'favorites') void this.loadEntries(false)
  }

  async loadEntries(more: boolean): Promise<void> {
    const token = ++this.listToken
    const { view, entries } = this.snapshot
    this.publish({ listLoading: true, moreError: null })
    try {
      const last = more ? entries.at(-1) : undefined
      const list = await this.call({ op: 'entries', view, ...(last === undefined ? {} : { before: last.published, beforeId: last.id }), limit: 50 }) as EntryList
      if (token !== this.listToken) return
      // In the unread view an entry read here stays listed until the view is left.
      const kept = more ? entries : view === 'unread' ? entries.filter((entry) => entry.id === this.snapshot.opened?.entry?.id && !list.entries.some((item) => item.id === entry.id)) : []
      const merged = kept.length === 0 ? list.entries : [...kept, ...list.entries].sort((a, b) => b.published - a.published)
      this.publish({ entries: merged, more: list.more, older: list.older, listLoading: false, error: null })
    } catch (error) {
      if (token === this.listToken) this.publish({ listLoading: false, ...(more ? { moreError: errorOf(error) } : { error: errorOf(error) }) })
    }
  }

  /** The next entries: those kept here first, then the feed's older pages from its source. */
  async loadMore(): Promise<void> {
    const { view, more, older, listLoading } = this.snapshot
    if (listLoading) return
    if (more) return this.loadEntries(true)
    if (older === undefined) return
    const token = ++this.listToken
    this.publish({ listLoading: true, moreError: null })
    try {
      for (let round = 0; ; round++) {
        const reply = await this.call({ op: 'older', id: view, from: older }) as OlderReply
        if (token !== this.listToken) return
        if (reply.status === 'ready') break
        if (round >= 20) throw new Error('The feed took too long to answer')
        await sleep(1000)
      }
      this.publish({ listLoading: false })
      await this.loadEntries(true)
    } catch (error) {
      if (token === this.listToken) this.publish({ listLoading: false, moreError: errorOf(error) })
    }
  }

  /** Open an entry or a favorite; an entry is marked read. */
  async open(opened: Opened): Promise<void> {
    const token = ++this.articleToken
    this.publish({ opened, article: undefined, articleLoading: true, articleError: null })
    if (opened.entry !== undefined && !opened.entry.read) void this.setRead([opened.entry.id], true)
    try {
      for (let round = 0; ; round++) {
        const reply = await this.call({ op: 'article', url: opened.url, ...(opened.entry === undefined ? {} : { entry: opened.entry.id }) }) as ArticleReply
        if (token !== this.articleToken) return
        if (reply.status === 'ready') {
          const { status: _status, ...article } = reply
          this.texts.set(article.key, article.notes === undefined ? article.markdown : `${article.notes}\n\n---\n\n${article.markdown}`)
          if (this.texts.size > 24) this.texts.delete(this.texts.keys().next().value!)
          this.publish({ article, articleLoading: false })
          return
        }
        if (round >= 12) throw new Error('The article took too long to read')
        await sleep(1000)
      }
    } catch (error) {
      if (token === this.articleToken) this.publish({ articleLoading: false, articleError: errorOf(error) })
    }
  }

  close(): void {
    this.articleToken++
    this.publish({ opened: undefined, article: undefined, articleLoading: false, articleError: null })
  }

  async setRead(ids: string[], read: boolean): Promise<void> {
    const mark = (entry: Entry): Entry => (ids.includes(entry.id) ? { ...entry, read } : entry)
    const opened = this.snapshot.opened
    this.publish({
      entries: this.snapshot.entries.map(mark),
      ...(opened?.entry !== undefined && ids.includes(opened.entry.id) ? { opened: { ...opened, entry: mark(opened.entry) } } : {}),
    })
    await this.run({ op: 'read', ids, read }).catch((error: unknown) => this.publish({ error: errorOf(error) }))
  }

  async readAll(): Promise<void> {
    const view = this.snapshot.view
    this.publish({ entries: this.snapshot.entries.map((entry) => ({ ...entry, read: true })) })
    await this.run({ op: 'readAll', view })
    await this.loadEntries(false)
  }

  async refresh(id?: string): Promise<void> {
    await this.run({ op: 'refresh', ...(id === undefined ? {} : { id }) })
    await this.follow()
  }

  async add(input: string): Promise<void> {
    await this.run({ op: 'subscribe', input })
    await this.follow()
  }

  async unsubscribe(id: string): Promise<void> {
    await this.run({ op: 'unsubscribe', id })
    if (this.snapshot.view === id) this.setView('unread')
    else await this.loadEntries(false)
  }

  async rename(id: string, title: string): Promise<void> {
    await this.run({ op: 'rename', id, title })
  }

  /** The favorite of `url` with this quote (none: the whole article), if kept. */
  favoriteOf(url: string, quote?: string): Favorite | undefined {
    return this.snapshot.state?.favorites.find((favorite) => favorite.url === url && (favorite.quote ?? '') === (quote ?? ''))
  }

  async keep(input: { url: string; title: string; quote?: string; note?: string; site?: string }): Promise<void> {
    await this.run({ op: 'favorite', ...input })
  }

  async unkeep(id: string): Promise<void> {
    await this.run({ op: 'unfavorite', id })
  }

  async note(id: string, note: string): Promise<void> {
    await this.run({ op: 'note', id, note })
  }

  /** A DSH session about the article or its repository; asks again while it is being made. */
  async session(input: { url: string; entry?: string; project?: boolean; bot?: string; context?: string }): Promise<{ sessionId: string; draft: string }> {
    for (let round = 0; round < 120; round++) {
      const reply = await this.call({ op: 'session', ...input }) as SessionReply
      if (reply.status === 'ready') return reply
      if (reply.status === 'failed') throw new Error(reply.error)
      await sleep(1000)
    }
    throw new Error('The session took too long to prepare')
  }

  exportOpml(): Promise<string> {
    return this.call({ op: 'exportOpml' }) as Promise<string>
  }

  async importOpml(text: string): Promise<number> {
    const reply = await this.call({ op: 'importOpml', text }) as ReaderState & { added: number }
    this.publish({ state: reply, error: null })
    void this.follow()
    return reply.added
  }

  setTypography(patch: Partial<Typography>): void {
    const typography = { ...this.snapshot.typography, ...patch }
    try {
      localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(typography))
    } catch {
      // Private mode: this page only.
    }
    this.publish({ typography })
  }
}
