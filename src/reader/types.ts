/** The reader: feeds (RSS, Atom, GitHub stars) and favorites. The RPC shared by the host and the page. */

export const READER_METHOD = 'agent-hub/reader'

/** Where a feed's entries come from; a new kind is one more source (sources.ts). */
export type FeedKind = 'rss' | 'github'

/** A subscription, as it travels with the settings (reader-feeds.json). */
export interface Feed {
  /** Derived from `kind` and `url`: the same feed added on two machines is one. */
  id: string
  kind: FeedKind
  /** The feed's address; for GitHub, `https://github.com/<login>` (whose stars). */
  url: string
  title: string
  at: number
}

/** A whole entry kept (no `quote`), or a passage of it, as it travels with the settings (reader-favorites.json). */
export interface Favorite {
  /** Derived from `url` and `quote`. */
  id: string
  url: string
  title: string
  quote?: string
  /** What the person or a bot's answer added. */
  note?: string
  /** The feed's title when it was kept. */
  site?: string
  at: number
}

export interface FeedView extends Feed {
  unread: number
  checkedAt?: number
  error?: string
  refreshing: boolean
  /** The site the feed belongs to. */
  home?: string
}

/** `release`: kept by an earlier version beside its repository's entry; folded into it when read. */
export type EntryKind = 'article' | 'repo' | 'release'

export interface RepoMeta {
  /** owner/name */
  name: string
  stars?: number
  language?: string
  tag?: string
  /** The newest release's time. */
  released?: number
}

export interface Entry {
  id: string
  feed: string
  kind: EntryKind
  url: string
  title: string
  author?: string
  published: number
  /** Plain text, short. */
  summary: string
  read: boolean
  repo?: RepoMeta
}

export interface ReaderBot {
  id: string
  description?: string
}

export interface ReaderState {
  feeds: FeedView[]
  favorites: Favorite[]
  bots: ReaderBot[]
  /** A refresh of some feed is running. */
  refreshing: boolean
}

export interface EntryList {
  entries: Entry[]
  /** Older entries remain here. */
  more: boolean
  /** One feed's view, whose source may have older pages: how many have been read (ask `older` with it). */
  older?: number
}

/** A page of older entries: how many it added, and whether the feed has no more. */
export type OlderReply = { status: 'loading' } | { status: 'ready'; added: number; done: boolean }

/** Where an article's text came from. */
export type ArticleSource = 'feed' | 'page' | 'summary' | 'readme' | 'release'

export interface Article {
  url: string
  title: string
  markdown: string
  source: ArticleSource
  /** Tracking pixels and `utm_*` parameters removed. */
  cleaned: number
  /** The key a discussion about it is kept under (discussion/types.ts `doc:`). */
  key: string
  /** Why the full text could not be read, when only the summary is shown. */
  error?: string
  /** A release's notes; its `markdown` is then the repository's README. */
  notes?: string
  /** The release whose notes were read. */
  tag?: string
}

export type ArticleReply = { status: 'loading' } | ({ status: 'ready' } & Article)

/** A session started in DSH: the page seeds its composer with `draft` and opens it. */
export type SessionReply = { status: 'pending' } | { status: 'ready'; sessionId: string; draft: string } | { status: 'failed'; error: string }

/** `view`: `unread`, `all`, or a feed id. */
export type ReaderRequest =
  | { op: 'state' }
  /** After the cursor of the last entry shown (`before` its time, `beforeId` its id). */
  | { op: 'entries'; view: string; before?: number; beforeId?: string; limit?: number }
  /** The feed's next page of older entries; `from` is the `older` count the page saw. Answers `loading` until read. */
  | { op: 'older'; id: string; from: number }
  /** The readable text; `entry` names the feed entry when there is one (a favorite may outlive it). */
  | { op: 'article'; url: string; entry?: string }
  | { op: 'subscribe'; input: string }
  | { op: 'unsubscribe'; id: string }
  | { op: 'rename'; id: string; title: string }
  | { op: 'read'; ids: string[]; read: boolean }
  | { op: 'readAll'; view: string }
  | { op: 'refresh'; id?: string }
  | { op: 'favorite'; url: string; title: string; quote?: string; note?: string; site?: string }
  | { op: 'unfavorite'; id: string }
  | { op: 'note'; id: string; note: string }
  /**
   * A DSH session about an article (its text saved where the session can read it) or a repository
   * (a shallow clone it works in). Answers `pending` until it is ready; asking again follows it.
   */
  | { op: 'session'; url: string; entry?: string; project?: boolean; bot?: string; context?: string }
  | { op: 'exportOpml' }
  | { op: 'importOpml'; text: string }

/** The settings that keep the reader's records on one machine (不参与同步). */
export const FEEDS_SETTING = 'agent-hub.config.reader.feeds'
export const FAVORITES_SETTING = 'agent-hub.config.reader.favorites'
export const FEEDS_FILE = 'reader-feeds.json'
export const FAVORITES_FILE = 'reader-favorites.json'
