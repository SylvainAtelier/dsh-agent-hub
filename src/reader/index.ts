/**
 * The reader on the host: feeds are read here (on a timer, conditionally, a failing one less and
 * less often), every text becomes Markdown here (content.ts), and what was read stays on this
 * machine (entries, read marks, article texts). Feeds and favorites are records that travel with
 * the settings (records.ts); a phone reading through this host shares everything else by itself.
 *
 * A request never waits long: an article or a session still being made answers `loading` /
 * `pending`, and the page asks again (DSH stalls a plugin request held past ~10s).
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DOMParser } from 'linkedom'
import { localized } from '../locale.ts'
import { atomicWriteText, jsonWriter } from '../persistence.ts'
import { normalize, type CollectionRecord, type CollectionStore } from '../sync/collection.ts'
import type { Route, SessionHost } from '../review/index.ts'
import { BOT_ROUTE } from '../team/types.ts'
import { cleanUrl, htmlToMarkdown, normalizeMarkdown, readable, textLength } from './content.ts'
import { discoverFeed, fetchText, parseFeed, plainText, type FeedItem } from './feed.ts'
import { GitHubSource, REPO_NAME, type Star } from './github.ts'
import { FAVORITES, feedId, FEEDS, urlKey } from './records.ts'
import type {
  Article, ArticleReply, Entry, EntryList, Favorite, Feed, FeedView, OlderReply, ReaderBot, ReaderRequest, ReaderState, SessionReply,
} from './types.ts'

/** What the title of a session reading an article or a repository begins with. */
const READING = { zh: '阅读', en: 'Reading' }
/** A feed is read again this long after its last read; each failure in a row doubles it, up to 16×. */
const INTERVAL_MS = 30 * 60_000
const TICK_MS = 5 * 60_000
/** Entries kept per feed, older pages read on request included. */
const KEEP = 500
/** A newly added feed starts with this many unread; older entries are there, read. */
const FRESH = 20
/** A feed's own text is used as it is past this many characters; a shorter one is a summary. */
const FULL_TEXT = 1200
/** Article texts kept on disk. */
const ARTICLES = 600
/** How long a request waits for an article before answering `loading`. */
const WAIT_MS = 7000
/** Finding and reading a new feed (or a page of older entries), at most. */
const SUBSCRIBE_MS = 8000
/** Feeds read at once in a scheduled pass. */
const PARALLEL = 3
const FEED_ACCEPT = 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5'

interface FeedState {
  checkedAt?: number
  etag?: string
  modified?: string
  error?: string
  failures: number
  home?: string
  /** The first read is done: what arrives later is unread. */
  primed?: boolean
  /** The page after the newest, as the last read named it: a feed's `rel="next"` link, a GitHub cursor; null when there is none. */
  head?: string | null
  /** Older pages read on request: how many, where the next one is, whether the feed has no more. */
  older?: { page: number; next?: string; done?: boolean }
  entries: Entry[]
}

interface Stored {
  version: 1
  feeds: Record<string, FeedState>
}

export interface ReaderHost {
  dir: string
  bots(): ReaderBot[]
  sessions(): SessionHost | undefined
  github?: GitHubSource
  fetch?: typeof fetchText
  now?(): number
  log(message: string): void
}

const hash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)
const entryId = (feed: string, guid: string): string => hash(`${feed}\n${guid}`)
const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** A WordPress feed's older pages: `?paged=2`, `?paged=3`… (a feed that ignores it answers its newest again, nothing new). */
const pagedUrl = (url: string, page: number): string => {
  const next = new URL(url)
  next.searchParams.set('paged', String(page))
  return next.href
}
/** An article's whole text: a release's notes, then its repository's README. */
const fullText = (article: Article): string => (article.notes === undefined ? article.markdown : `${article.notes}\n\n---\n\n${article.markdown}`)
/** An article read from the page or a feed's text, and whether it stands only until the page can be read again. */
type Read = Article & { transient?: boolean }
const GITHUB_USER = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/?$/
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/
/** Resolves after `ms` without holding the process open. */
const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => { setTimeout(resolve, ms, value).unref?.() })
/** Release entries kept by an earlier version, beside their repository's: folded into it (the newest tag), then dropped. */
const foldReleases = (state: FeedState): void => {
  if (!state.entries.some((entry) => entry.kind === 'release')) return
  const repos = new Map(state.entries.filter((entry) => entry.kind === 'repo' && entry.repo !== undefined).map((entry) => [entry.repo!.name, entry]))
  for (const entry of state.entries) {
    const repo = entry.kind === 'release' && entry.repo?.tag !== undefined ? repos.get(entry.repo.name) : undefined
    const released = entry.repo?.released ?? entry.published
    if (repo === undefined || (repo.repo!.released ?? -1) >= released) continue
    repo.repo = { ...repo.repo!, tag: entry.repo!.tag!, released }
  }
  state.entries = state.entries.filter((entry) => entry.kind !== 'release')
}
const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class ReaderService {
  private readonly host: ReaderHost
  private readonly github: GitHubSource
  private readonly fetch: typeof fetchText
  private feeds: Feed[] | undefined
  private favorites: Favorite[] | undefined
  private stored: Stored | undefined
  private loading: Promise<void> | undefined
  private readonly writeFeeds: (value: unknown) => Promise<void>
  private readonly writeFavorites: (value: unknown) => Promise<void>
  private readonly writeState: (value: unknown) => Promise<void>
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly articles = new Map<string, Promise<Read>>()
  private readonly olders = new Map<string, Promise<{ added: number }>>()
  /** Entries whose feed text was looked at since the start: a feed read again does not parse it again. */
  private readonly looked = new Set<string>()
  private stateChain: Promise<void> = Promise.resolve()
  private stateNext: Promise<void> | undefined
  private readonly sessions = new Map<string, { at: number; reply: Promise<SessionReply> }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private first: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(host: ReaderHost) {
    this.host = host
    this.github = host.github ?? new GitHubSource()
    this.fetch = host.fetch ?? fetchText
    this.writeFeeds = jsonWriter(join(host.dir, 'feeds.json'))
    this.writeFavorites = jsonWriter(join(host.dir, 'favorites.json'))
    this.writeState = jsonWriter(join(host.dir, 'state.json'))
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  /** Reads due feeds now and then; the first pass waits a little, past the host's own start. */
  start(): void {
    if (this.timer !== undefined) return
    const tick = (): void => { void this.refreshDue().catch((error: unknown) => this.host.log(errorOf(error))) }
    this.first = setTimeout(tick, 20_000)
    this.first.unref?.()
    this.timer = setInterval(tick, TICK_MS)
    this.timer.unref?.()
  }

  /** No more reading by itself (the module is off); `start` resumes. */
  stop(): void {
    clearTimeout(this.first)
    clearInterval(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  /** Writes asked for while one is still queued: that one carries them all (a run of read marks is one write). */
  private saveState(): Promise<void> {
    if (this.stateNext !== undefined) return this.stateNext
    const next = this.stateChain.catch(() => {}).then(() => {
      this.stateNext = undefined
      return this.writeState(this.stored)
    })
    this.stateNext = next
    this.stateChain = next
    return next
  }

  // ── Records ─────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    if (this.stored !== undefined) return
    this.loading ??= (async () => {
      const read = async (file: string): Promise<unknown> => {
        try {
          return JSON.parse(await readFile(join(this.host.dir, file), 'utf8'))
        } catch {
          return undefined
        }
      }
      const [feeds, favorites, state] = await Promise.all([read('feeds.json'), read('favorites.json'), read('state.json')])
      const list = (value: unknown, key: string): unknown[] => {
        const items = (value as Record<string, unknown> | undefined)?.[key]
        return Array.isArray(items) ? items : []
      }
      this.feeds = normalize(FEEDS, list(feeds, 'feeds'))
      this.favorites = normalize(FAVORITES, list(favorites, 'favorites'))
      const saved = state as Partial<Stored> | undefined
      this.stored = { version: 1, feeds: saved?.version === 1 && typeof saved.feeds === 'object' && saved.feeds !== null ? saved.feeds : {} }
      for (const state of Object.values(this.stored.feeds)) foldReleases(state)
    })()
    await this.loading
  }

  private async saveFeeds(): Promise<void> {
    await this.writeFeeds({ feeds: this.feeds })
  }

  private async saveFavorites(): Promise<void> {
    await this.writeFavorites({ favorites: this.favorites })
  }

  /** Where the settings sync reads and writes the feeds. */
  get feedStore(): CollectionStore {
    return {
      get: async () => {
        await this.load()
        return this.feeds!
      },
      set: async (records) => {
        await this.load()
        this.feeds = normalize(FEEDS, records)
        const ids = new Set(this.feeds.map((feed) => feed.id))
        for (const id of Object.keys(this.stored!.feeds)) if (!ids.has(id)) delete this.stored!.feeds[id]
        await Promise.all([this.saveFeeds(), this.saveState()])
        // A feed another machine added is read here soon.
        void this.refreshDue().catch((error: unknown) => this.host.log(errorOf(error)))
        return true
      },
    }
  }

  /** Where the settings sync reads and writes the favorites. */
  get favoriteStore(): CollectionStore {
    return {
      get: async () => {
        await this.load()
        return this.favorites!
      },
      set: async (records: CollectionRecord[]) => {
        await this.load()
        this.favorites = normalize(FAVORITES, records)
        await this.saveFavorites()
        return true
      },
    }
  }

  // ── Requests ────────────────────────────────────────────────────────────

  async handle(payload: Record<string, unknown>): Promise<unknown> {
    const request = payload as ReaderRequest
    await this.load()
    switch (request.op) {
      case 'state': return this.state()
      case 'entries': return this.entries(String(request.view), request.before, request.limit, request.beforeId)
      case 'older': return this.older(String(request.id), Number(request.from) || 0)
      case 'article': return this.article(String(request.url), request.entry)
      case 'subscribe': await this.subscribe(String(request.input ?? '')); return this.state()
      case 'unsubscribe': {
        this.feeds = this.feeds!.filter((feed) => feed.id !== request.id)
        delete this.stored!.feeds[request.id]
        await Promise.all([this.saveFeeds(), this.saveState()])
        return this.state()
      }
      case 'rename': {
        const title = String(request.title ?? '').trim().slice(0, 200)
        if (title === '') throw new Error('A feed needs a name')
        this.feeds = this.feeds!.map((feed) => (feed.id === request.id ? { ...feed, title } : feed))
        await this.saveFeeds()
        return this.state()
      }
      case 'read': {
        const ids = new Set(Array.isArray(request.ids) ? request.ids : [])
        for (const state of Object.values(this.stored!.feeds)) for (const entry of state.entries) if (ids.has(entry.id)) entry.read = request.read !== false
        await this.saveState()
        return this.state()
      }
      case 'readAll': {
        for (const [id, state] of Object.entries(this.stored!.feeds)) {
          if (request.view !== 'all' && request.view !== 'unread' && request.view !== id) continue
          for (const entry of state.entries) entry.read = true
        }
        await this.saveState()
        return this.state()
      }
      case 'refresh': {
        const targets = request.id === undefined ? this.feeds! : this.feeds!.filter((feed) => feed.id === request.id)
        for (const feed of targets) void this.refresh(feed).catch(() => {})
        return this.state()
      }
      case 'favorite': return this.favorite(request)
      case 'unfavorite': {
        this.favorites = this.favorites!.filter((favorite) => favorite.id !== request.id)
        await this.saveFavorites()
        return this.state()
      }
      case 'note': {
        const note = String(request.note ?? '').trim().slice(0, 32_000)
        this.favorites = this.favorites!.map((favorite) => {
          if (favorite.id !== request.id) return favorite
          const { note: _old, ...rest } = favorite
          return note === '' ? rest : { ...rest, note }
        })
        await this.saveFavorites()
        return this.state()
      }
      case 'session': return this.session(request)
      case 'exportOpml': return this.exportOpml()
      case 'importOpml': return this.importOpml(String(request.text ?? ''))
      default: throw new Error('Unknown reader request')
    }
  }

  state(): ReaderState {
    const feeds: FeedView[] = this.feeds!.map((feed) => {
      const state = this.stored!.feeds[feed.id]
      return {
        ...feed,
        unread: state?.entries.filter((entry) => !entry.read).length ?? 0,
        ...(state?.checkedAt === undefined ? {} : { checkedAt: state.checkedAt }),
        ...(state?.error === undefined ? {} : { error: state.error }),
        ...(state?.home === undefined ? {} : { home: state.home }),
        refreshing: this.refreshing.has(feed.id),
      }
    })
    return {
      feeds,
      favorites: [...this.favorites!].sort((a, b) => b.at - a.at),
      bots: this.host.bots(),
      refreshing: this.refreshing.size > 0,
    }
  }

  /** Newest first (ties by id), after the cursor `before` / `beforeId` names: a page boundary never skips an entry. */
  entries(view: string, before?: number, limit = 50, beforeId?: string): EntryList {
    const known = new Set(this.feeds!.map((feed) => feed.id))
    const after = (entry: Entry): boolean =>
      before === undefined || entry.published < before || (entry.published === before && beforeId !== undefined && entry.id < beforeId)
    const pool = Object.entries(this.stored!.feeds)
      .filter(([id]) => known.has(id) && (view === 'all' || view === 'unread' || view === id))
      .flatMap(([, state]) => state.entries)
      .filter((entry) => (view !== 'unread' || !entry.read) && after(entry))
      .sort((a, b) => b.published - a.published || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    const size = Math.max(1, Math.min(200, Number(limit) || 50))
    const feed = this.feeds!.find((item) => item.id === view)
    const state = feed === undefined ? undefined : this.stored!.feeds[feed.id]
    const older = feed !== undefined && state !== undefined && this.mayHaveOlder(feed, state) ? { older: state.older?.page ?? 0 } : {}
    return { entries: pool.slice(0, size), more: pool.length > size, ...older }
  }

  private mayHaveOlder(feed: Feed, state: FeedState): boolean {
    if (state.older?.done === true || state.entries.length >= KEEP) return false
    return feed.kind !== 'github' || state.head !== null || state.older?.next !== undefined
  }

  private findEntry(id: string | undefined): Entry | undefined {
    if (id === undefined) return undefined
    for (const state of Object.values(this.stored!.feeds)) {
      const entry = state.entries.find((item) => item.id === id)
      if (entry !== undefined) return entry
    }
    return undefined
  }

  // ── Subscribing ─────────────────────────────────────────────────────────

  private async subscribe(input: string): Promise<Feed> {
    const text = input.trim()
    if (text === '') throw new Error('Paste a site, a feed address, or "github"')
    let feed: Feed
    let items: FeedItem[] | undefined
    let home: string | undefined
    let head: string | null = null
    const login = /^github(?::\s*@?([A-Za-z0-9-]{1,39}))?$/i.exec(text)?.[1] ?? GITHUB_USER.exec(text.replace(/^http:/, 'https:'))?.[1]
    if (/^github(?::|$)/i.test(text) || login !== undefined) {
      const who = login ?? await this.github.viewer()
      const url = `https://github.com/${who}`
      feed = { id: feedId('github', url), kind: 'github', url, title: `GitHub · ${who}`, at: this.now() }
    } else {
      const address = /^https?:\/\//i.test(text) ? text : `https://${text}`
      // Both reads within one budget: DSH stalls a plugin request held past ~10s.
      const signal = AbortSignal.timeout(SUBSCRIBE_MS)
      const page = await this.fetch(address, { signal })
      let parsed = parseFeed(page.text, page.url)
      let url = page.url
      if (parsed === undefined) {
        const found = discoverFeed(page.text, page.url)
        if (found === undefined) throw new Error('This page names no RSS or Atom feed')
        const named = await this.fetch(found, { signal })
        parsed = parseFeed(named.text, named.url)
        if (parsed === undefined) throw new Error('The feed this page names could not be read')
        url = named.url
      }
      items = parsed.items
      home = parsed.home
      head = parsed.next ?? null
      feed = { id: feedId('rss', url), kind: 'rss', url, title: parsed.title ?? new URL(url).host, at: this.now() }
    }
    if (this.feeds!.some((known) => known.id === feed.id)) throw new Error('Already subscribed')
    this.feeds = [...this.feeds!, feed]
    await this.saveFeeds()
    if (items !== undefined) {
      await this.absorb(feed, items.map((item) => this.rssEntry(feed, item)), { home, head })
      await this.saveState()
    } else void this.refresh(feed).catch(() => {})
    return feed
  }

  // ── Reading feeds ───────────────────────────────────────────────────────

  /** A few at a time: one slow site does not hold the others back. */
  private async refreshDue(): Promise<void> {
    await this.load()
    const now = this.now()
    const due = this.feeds!.filter((feed) => {
      const state = this.stored!.feeds[feed.id]
      const wait = INTERVAL_MS * 2 ** Math.min(state?.failures ?? 0, 4)
      return state?.checkedAt === undefined || now - state.checkedAt >= wait
    })
    const work = async (): Promise<void> => {
      for (let feed = due.shift(); feed !== undefined && !this.disposed; feed = due.shift()) {
        if (await this.refresh(feed).then(() => true, () => false)) await this.probe(feed)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, due.length) }, work))
  }

  private refresh(feed: Feed): Promise<void> {
    const running = this.refreshing.get(feed.id)
    if (running !== undefined) return running
    const run = (async () => {
      const state = this.stored!.feeds[feed.id] ?? { failures: 0, entries: [] }
      try {
        if (feed.kind === 'github') {
          const login = GITHUB_USER.exec(feed.url)?.[1]
          if (login === undefined) throw new Error('Not a GitHub account address')
          const page = await this.github.stars(login)
          await this.absorb(feed, page.stars.flatMap((star) => this.starEntries(feed, star)), { home: feed.url, head: page.next ?? null })
        } else {
          const page = await this.fetch(feed.url, { etag: state.etag, modified: state.modified, accept: FEED_ACCEPT })
          if (page.status !== 304) {
            const parsed = parseFeed(page.text, page.url)
            if (parsed === undefined) throw new Error('The address no longer answers with a feed')
            await this.absorb(feed, parsed.items.map((item) => this.rssEntry(feed, item)), { home: parsed.home, head: parsed.next ?? null })
          }
          const current = this.stored!.feeds[feed.id]
          if (current !== undefined) {
            if (page.etag === undefined) delete current.etag
            else current.etag = page.etag
            if (page.modified === undefined) delete current.modified
            else current.modified = page.modified
          }
        }
        const current = this.stored!.feeds[feed.id] ?? state
        delete current.error
        current.failures = 0
        current.checkedAt = this.now()
        this.stored!.feeds[feed.id] = current
      } catch (error) {
        const current = this.stored!.feeds[feed.id] ?? state
        current.error = errorOf(error)
        current.failures = (current.failures ?? 0) + 1
        current.checkedAt = this.now()
        if (this.feeds!.some((known) => known.id === feed.id)) this.stored!.feeds[feed.id] = current
        throw error
      } finally {
        this.refreshing.delete(feed.id)
        await this.saveState().catch((error: unknown) => this.host.log(errorOf(error)))
      }
    })()
    this.refreshing.set(feed.id, run)
    return run
  }

  /** An RSS or Atom item as an entry; a full text it carries becomes the article right away. */
  private rssEntry(feed: Feed, item: FeedItem): Entry & { html?: string } {
    return {
      id: entryId(feed.id, item.guid),
      feed: feed.id,
      kind: 'article',
      url: cleanUrl(item.url),
      title: item.title,
      ...(item.author === undefined ? {} : { author: item.author }),
      published: item.published,
      summary: item.summary,
      read: false,
      ...(item.html === undefined ? {} : { html: item.html }),
    }
  }

  /** A star is one entry, at the star's time; its newest release rides along (`tag`), its notes shown when it opens. */
  private starEntries(feed: Feed, star: Star): Entry[] {
    return [{
      id: entryId(feed.id, `repo:${star.name}`), feed: feed.id, kind: 'repo', url: star.url, title: star.name,
      published: star.starredAt, summary: star.description ?? '', read: false,
      repo: {
        name: star.name, stars: star.stars, ...(star.language === undefined ? {} : { language: star.language }),
        ...(star.release === undefined ? {} : { tag: star.release.tag, released: star.release.publishedAt }),
      },
    }]
  }

  /**
   * New entries join the feed's (marks kept), the newest `KEEP` stay; on the first read only the newest few are unread, and
   * older pages read on request (`history`) arrive read. The entries change at once, before any file is written: a refresh
   * and an older page arriving together both land.
   */
  private async absorb(feed: Feed, incoming: Array<Entry & { html?: string }>, meta: { home?: string; head?: string | null; history?: boolean }): Promise<number> {
    const state = this.stored!.feeds[feed.id] ?? { failures: 0, entries: [] }
    const known = new Map(state.entries.map((entry) => [entry.id, entry]))
    const fresh: Entry[] = []
    const texts: Array<{ entry: Entry; html: string }> = []
    for (const { html, ...entry } of incoming) {
      const old = known.get(entry.id)
      if (old !== undefined) {
        // A star's time is GitHub's own and always given; an article's first-seen time stands in when its feed names none.
        const published = entry.kind === 'article' ? old.published || entry.published : entry.published
        // A starred repository's new release makes it unread again.
        const released = meta.history !== true && entry.repo?.tag !== undefined && old.repo?.tag !== undefined && entry.repo.tag !== old.repo.tag
        known.set(entry.id, { ...entry, read: old.read && !released, published })
      } else {
        const added = meta.history === true ? { ...entry, read: true } : entry
        known.set(entry.id, added)
        fresh.push(added)
      }
      if (html !== undefined && !this.looked.has(entry.id)) {
        this.looked.add(entry.id)
        texts.push({ entry, html })
      }
    }
    const entries = [...known.values()].sort((a, b) => b.published - a.published).slice(0, KEEP)
    if (state.primed !== true && meta.history !== true) {
      const unread = new Set(fresh.sort((a, b) => b.published - a.published).slice(0, FRESH).map((entry) => entry.id))
      for (const entry of entries) if (!unread.has(entry.id)) entry.read = true
      state.primed = true
    }
    state.entries = entries
    if (meta.home !== undefined) state.home = meta.home
    if (meta.head !== undefined) state.head = meta.head
    if (this.feeds!.some((item) => item.id === feed.id)) this.stored!.feeds[feed.id] = state
    for (const { entry, html } of texts) await this.keepFeedText(entry, html).catch((error: unknown) => this.host.log(errorOf(error)))
    return fresh.length
  }

  /**
   * A feed's own text for an entry: past a few paragraphs it is the article (no page to fetch); shorter, it is kept aside,
   * shown when the page has less (an article that is mostly links and images) or cannot be read.
   */
  private async keepFeedText(entry: Entry, html: string): Promise<void> {
    const file = this.articleFile(entry.url)
    if (await stat(file).then(() => true, () => false)) return
    const clean = htmlToMarkdown(html, { link: entry.url })
    const article: Article = { url: entry.url, title: entry.title, markdown: clean.markdown, source: 'feed', cleaned: clean.cleaned, key: `doc:${urlKey(entry.url)}` }
    if (textLength(html) >= FULL_TEXT) return this.saveArticle(article)
    // Only when it holds more than the summary the entry already shows.
    if (clean.markdown.length > entry.summary.length + 40) await atomicWriteText(this.feedTextFile(entry.url), JSON.stringify(article))
  }

  private feedTextFile(url: string): string {
    return join(this.host.dir, 'articles', `${urlKey(url)}.feed.json`)
  }

  private async feedText(url: string): Promise<Article | undefined> {
    try {
      const article = JSON.parse(await readFile(this.feedTextFile(url), 'utf8')) as Article
      return typeof article.markdown === 'string' ? article : undefined
    } catch {
      return undefined
    }
  }

  // ── Older pages ─────────────────────────────────────────────────────────

  /**
   * Whether a feed that names no older pages answers WordPress's paging is found out once, in the background, so its
   * view offers older entries only when there are some.
   */
  private async probe(feed: Feed): Promise<void> {
    const state = this.stored!.feeds[feed.id]
    if (feed.kind !== 'rss' || state === undefined || state.older !== undefined || state.head != null || this.olders.has(feed.id)) return
    const run = this.readOlder(feed).finally(() => this.olders.delete(feed.id))
    this.olders.set(feed.id, run)
    await run.catch(() => {})
  }

  /**
   * The next page of a feed's older entries. `from` is how many pages the asking page knew of: asked again while the
   * page is read (or after), it is not read twice.
   */
  private async older(id: string, from: number): Promise<OlderReply> {
    const feed = this.feeds!.find((item) => item.id === id)
    if (feed === undefined) throw new Error('No such feed')
    const reply = (added: number): OlderReply => {
      const state = this.stored!.feeds[feed.id]
      return { status: 'ready', added, done: state === undefined || !this.mayHaveOlder(feed, state) }
    }
    let running = this.olders.get(id)
    if (running === undefined) {
      if ((this.stored!.feeds[id]?.older?.page ?? 0) > from) return reply(0)
      running = this.readOlder(feed).finally(() => this.olders.delete(id))
      this.olders.set(id, running)
    }
    const done = await Promise.race([running, later(WAIT_MS, undefined)])
    return done === undefined ? { status: 'loading' } : reply(done.added)
  }

  private async readOlder(feed: Feed): Promise<{ added: number }> {
    const state = this.stored!.feeds[feed.id]
    if (state === undefined) throw new Error('The feed has not been read yet')
    if (!this.mayHaveOlder(feed, state)) return { added: 0 }
    const older = { page: 0, ...state.older }
    let added = 0
    if (feed.kind === 'github') {
      const login = GITHUB_USER.exec(feed.url)?.[1]
      if (login === undefined) throw new Error('Not a GitHub account address')
      // A feed read before cursors were kept: its first page names the second.
      const cursor = older.next ?? (state.head === undefined ? (await this.github.stars(login)).next : state.head)
      if (cursor === undefined || cursor === null) {
        older.done = true
      } else {
        const page = await this.github.stars(login, cursor)
        added = await this.absorb(feed, page.stars.flatMap((star) => this.starEntries(feed, star)), { history: true })
        older.page++
        if (page.next === undefined) {
          delete older.next
          older.done = true
        } else older.next = page.next
      }
    } else {
      // A feed that names its older pages is followed through them; one that does not is asked WordPress's way.
      const named = older.next ?? state.head ?? undefined
      const url = named ?? pagedUrl(feed.url, older.page + 2)
      let parsed: ReturnType<typeof parseFeed>
      try {
        const page = await this.fetch(url, { accept: FEED_ACCEPT, signal: AbortSignal.timeout(SUBSCRIBE_MS) })
        parsed = parseFeed(page.text, page.url)
      } catch (error) {
        // Past the last page a site answers 404 (or 400, 410); anything else is worth asking again.
        if (!/answered 4\d\d/.test(errorOf(error))) throw error
      }
      if (parsed !== undefined) added = await this.absorb(feed, parsed.items.map((item) => this.rssEntry(feed, item)), { history: true })
      older.page++
      if (parsed?.next !== undefined) older.next = parsed.next
      else delete older.next
      if (added === 0 || (named !== undefined && parsed?.next === undefined)) older.done = true
    }
    const current = this.stored!.feeds[feed.id]
    if (current !== undefined) {
      current.older = older
      await this.saveState()
    }
    return { added }
  }

  // ── Articles ────────────────────────────────────────────────────────────

  private articleFile(url: string): string {
    return join(this.host.dir, 'articles', `${urlKey(url)}.json`)
  }

  private async saveArticle(article: Article): Promise<void> {
    await atomicWriteText(this.articleFile(article.url), JSON.stringify(article))
    void this.pruneArticles().catch(() => {})
  }

  private pruning = false

  private async pruneArticles(): Promise<void> {
    if (this.pruning) return
    this.pruning = true
    try {
      const dir = join(this.host.dir, 'articles')
      const names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
      if (names.length <= ARTICLES) return
      // Favorites keep their text. Down to a little under the bound: the next few saves do not walk the folder again.
      const kept = new Set(this.favorites?.map((favorite) => `${urlKey(favorite.url)}.json`))
      const dated = await Promise.all(names.filter((name) => !kept.has(name)).map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })))
      dated.sort((a, b) => a.at - b.at)
      for (const { name } of dated.slice(0, names.length - ARTICLES + ARTICLES / 10)) await rm(join(dir, name), { force: true })
    } finally {
      this.pruning = false
    }
  }

  /** The text read before; a summary kept by an earlier version is read again. */
  private async cachedArticle(url: string): Promise<Article | undefined> {
    try {
      const article = JSON.parse(await readFile(this.articleFile(url), 'utf8')) as Article
      // A release kept by an earlier version holds only its notes, not the README.
      const stale = article.source === 'summary' || (article.source === 'release' && article.notes === undefined)
      return typeof article.markdown === 'string' && !stale ? article : undefined
    } catch {
      return undefined
    }
  }

  /** A `doc:` discussion's article, as this machine last read it. */
  async document(owner: string): Promise<{ title: string; url: string; markdown: string } | undefined> {
    const key = /^doc:([a-f0-9]{16})$/.exec(owner)?.[1]
    if (key === undefined) return undefined
    try {
      const article = JSON.parse(await readFile(join(this.host.dir, 'articles', `${key}.json`), 'utf8')) as Article
      return { title: article.title, url: article.url, markdown: fullText(article) }
    } catch {
      return undefined
    }
  }

  private async article(url: string, entryId?: string): Promise<ArticleReply> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Not a web address')
    const entry = this.findEntry(entryId)
    const cached = await this.cachedArticle(url)
    // A starred repository read before its newest release came out is read again, with that release's notes.
    if (cached !== undefined && (entry?.repo?.tag === undefined || cached.tag === entry.repo.tag)) return { status: 'ready', ...cached }
    let running = this.articles.get(url)
    if (running === undefined) {
      // A summary or a stand-in is not kept: the page is read again next time (a minute on, past this one).
      running = this.readArticle(url, entry).then(async (article) => {
        if (article.source !== 'summary' && article.transient !== true) {
          await this.saveArticle(article)
          await rm(this.feedTextFile(url), { force: true })
        }
        return article
      }).finally(() => { setTimeout(() => this.articles.delete(url), 60_000).unref?.() })
      this.articles.set(url, running)
    }
    const read = await Promise.race([running, later(WAIT_MS, undefined)])
    if (read === undefined) return { status: 'loading' }
    const { transient: _transient, ...article } = read
    return { status: 'ready', ...article }
  }

  /**
   * The page through Readability, unless the feed's own text holds more (an article mostly of links and images); when the
   * page cannot be read, the feed's text until it can, else the entry's summary.
   */
  private async readArticle(url: string, entry: Entry | undefined): Promise<Read> {
    const key = `doc:${urlKey(url)}`
    const repoName = entry?.repo?.name ?? GITHUB_REPO.exec(url)?.[1]
    if (repoName !== undefined && REPO_NAME.test(repoName) && (entry === undefined || entry.kind !== 'article')) {
      const bases = { link: `https://github.com/${repoName}/blob/HEAD/`, image: `https://raw.githubusercontent.com/${repoName}/HEAD/` }
      // A starred repository is read as its home: the README, its newest release's notes beside it.
      const tag = entry?.repo?.tag
      const [readme, notes] = await Promise.all([this.github.readme(repoName), tag === undefined ? undefined : this.github.release(repoName, tag)])
      const clean = normalizeMarkdown(readme, bases)
      const released = notes === undefined || notes === '' ? undefined : normalizeMarkdown(notes, bases)
      return {
        url, title: entry?.title ?? repoName, markdown: clean.markdown || (entry?.summary ?? ''), source: tag === undefined ? 'readme' : 'release',
        cleaned: clean.cleaned + (released?.cleaned ?? 0), key, ...(tag === undefined ? {} : { tag }), ...(released === undefined ? {} : { notes: released.markdown }),
      }
    }
    const fed = entry === undefined ? undefined : await this.feedText(entry.url)
    const own = fed === undefined ? undefined : { ...fed, url, title: entry!.title, key }
    let page
    try {
      page = await this.fetch(url)
    } catch (error) {
      if (own !== undefined) return { ...own, error: errorOf(error), transient: true }
      if (entry === undefined) throw error
      return { url, title: entry.title, markdown: entry.summary, source: 'summary', cleaned: 0, key, error: errorOf(error) }
    }
    let found: ReturnType<typeof readable>
    try {
      found = readable(page.text)
    } catch (error) {
      this.host.log(`reader: ${errorOf(error)}`)
    }
    const clean = found === undefined ? undefined : htmlToMarkdown(found.html, { link: page.url })
    // By their text, links and image addresses aside; the page unless the feed holds clearly more.
    const prose = (markdown: string): number => markdown.replace(/\]\([^)]*\)/g, ']').replace(/\s+/g, '').length
    if (clean !== undefined && (own === undefined || prose(own.markdown) <= prose(clean.markdown) * 1.2)) {
      return { url, title: entry?.title ?? found!.title ?? url, markdown: clean.markdown, source: 'page', cleaned: clean.cleaned, key }
    }
    if (own !== undefined) return own
    const error = 'No article could be found on the page'
    if (entry === undefined) throw new Error(error)
    return { url, title: entry.title, markdown: entry.summary, source: 'summary', cleaned: 0, key, error }
  }

  // ── Favorites ───────────────────────────────────────────────────────────

  private async favorite(request: Extract<ReaderRequest, { op: 'favorite' }>): Promise<ReaderState> {
    const url = String(request.url ?? '')
    if (!/^https?:\/\//i.test(url)) throw new Error('Not a web address')
    const record = FAVORITES.parse({ ...request, at: this.now() })
    if (record === undefined) throw new Error('Nothing to keep')
    const known = this.favorites!.find((favorite) => favorite.id === record.id)
    // Keeping it again adds the new note to the old one.
    const note = [known?.note, record.note].filter((text): text is string => text !== undefined && text !== '').join('\n\n---\n\n')
    const next = { ...record, ...(known === undefined ? {} : { at: known.at }), ...(note === '' ? {} : { note }) }
    this.favorites = [...this.favorites!.filter((favorite) => favorite.id !== record.id), next]
    await this.saveFavorites()
    return this.state()
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  private session(request: Extract<ReaderRequest, { op: 'session' }>): Promise<SessionReply> | SessionReply {
    const url = String(request.url ?? '')
    if (!/^https?:\/\//i.test(url)) throw new Error('Not a web address')
    const key = JSON.stringify([url, request.project === true, request.bot ?? '', request.context ?? ''])
    for (const [other, { at }] of this.sessions) if (this.now() - at > 10 * 60_000) this.sessions.delete(other)
    let known = this.sessions.get(key)
    if (known === undefined) {
      const reply = this.startSession(url, request).then(
        ({ sessionId, draft }): SessionReply => ({ status: 'ready', sessionId, draft }),
        (error: unknown): SessionReply => {
          this.sessions.delete(key)
          return { status: 'failed', error: errorOf(error) }
        },
      )
      known = { at: this.now(), reply }
      this.sessions.set(key, known)
    }
    return Promise.race([known.reply, later<SessionReply>(WAIT_MS, { status: 'pending' })])
  }

  private async startSession(url: string, request: Extract<ReaderRequest, { op: 'session' }>): Promise<{ sessionId: string; draft: string }> {
    const host = this.host.sessions()
    if (host === undefined) throw new Error('Sessions are unavailable')
    const entry = this.findEntry(request.entry)
    const bot = request.bot?.trim() || undefined
    if (bot !== undefined && !this.host.bots().some((item) => item.id === bot)) throw new Error(`The bot "${bot}" is unavailable`)
    const route: Route | undefined = bot === undefined ? undefined : { provider: BOT_ROUTE, model: bot }
    const context = request.context?.trim() ?? ''
    if (request.project === true) {
      const name = entry?.repo?.name ?? GITHUB_REPO.exec(url)?.[1]
      if (name === undefined || !REPO_NAME.test(name)) throw new Error('Not a GitHub repository')
      const dir = join(this.host.dir, 'repos', name.replace('/', '__'))
      await this.github.clone(name, dir)
      const sessionId = await host.start({ cwd: dir, title: `${localized(READING)} · ${name}`.slice(0, 120), ...(route === undefined ? {} : { route }) })
      return { sessionId, draft: `https://github.com/${name}\n\n${context}`.trim() }
    }
    const article = await this.cachedArticle(url) ?? await this.readArticle(url, entry)
    delete (article as Read).transient
    const dir = join(this.host.dir, 'docs')
    const file = `${urlKey(url)}.md`
    await atomicWriteText(join(dir, file), `# ${article.title}\n\n<${article.url}>\n\n${fullText(article)}\n`)
    const sessionId = await host.start({ cwd: dir, title: `${localized(READING)} · ${article.title}`.slice(0, 120), ...(route === undefined ? {} : { route }) })
    return { sessionId, draft: `./${file} — [${article.title}](${article.url})\n\n${context}`.trim() }
  }

  // ── OPML ────────────────────────────────────────────────────────────────

  exportOpml(): string {
    const outlines = this.feeds!.filter((feed) => feed.kind === 'rss').map((feed) => {
      const home = this.stored!.feeds[feed.id]?.home
      return `    <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}"${home === undefined ? '' : ` htmlUrl="${escapeXml(home)}"`}/>`
    })
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Agent Hub feeds</title></head>\n  <body>\n${outlines.join('\n')}\n  </body>\n</opml>\n`
  }

  private async importOpml(text: string): Promise<ReaderState & { added: number }> {
    const document = new DOMParser().parseFromString(text, 'text/xml') as unknown as { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> }
    let added = 0
    for (const outline of Array.from(document.querySelectorAll('outline'))) {
      const url = outline.getAttribute('xmlUrl') ?? outline.getAttribute('xmlurl')
      if (url === null || !/^https?:\/\//i.test(url)) continue
      const feed: Feed = { id: feedId('rss', url), kind: 'rss', url, title: plainText(outline.getAttribute('title') ?? outline.getAttribute('text') ?? url, 200) || url, at: this.now() }
      if (this.feeds!.some((known) => known.id === feed.id)) continue
      this.feeds = [...this.feeds!, feed]
      added++
    }
    if (added === 0) throw new Error('No new feeds in this OPML file')
    await this.saveFeeds()
    void this.refreshDue().catch((error: unknown) => this.host.log(errorOf(error)))
    return { ...this.state(), added }
  }
}
