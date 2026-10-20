/**
 * Reading the web: one bounded GET (conditional, decoded by its declared charset, so GBK sites read
 * right), and feeds out of what it returns: RSS 2.0, RSS 1.0 (RDF) and Atom, or the feed a page
 * names in its `<link rel="alternate">`.
 */

import { DOMParser, parseHTML } from 'linkedom'

/** A page or feed larger than this is refused. */
const MAX_BYTES = 6 << 20
const TIMEOUT_MS = 15_000
const AGENT = 'Mozilla/5.0 (compatible; DSH-Agent-Hub-Reader/1.0; +https://github.com)'

export interface Fetched {
  /** 304: unchanged since `etag` / `modified`. */
  status: number
  /** After redirects. */
  url: string
  type: string
  text: string
  etag?: string
  modified?: string
}

const CHARSET = /charset\s*=\s*["']?([\w-]+)/i

function decode(bytes: Uint8Array, type: string): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const label = CHARSET.exec(type)?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export async function fetchText(url: string, options: { etag?: string; modified?: string; accept?: string; signal?: AbortSignal } = {}): Promise<Fetched> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https addresses can be read')
  const signal = options.signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)])
  const response = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': AGENT,
      Accept: options.accept ?? 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(options.etag === undefined ? {} : { 'If-None-Match': options.etag }),
      ...(options.modified === undefined ? {} : { 'If-Modified-Since': options.modified }),
    },
  })
  const type = response.headers.get('content-type') ?? ''
  const meta = {
    url: response.url || url,
    type,
    ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag')! }),
    ...(response.headers.get('last-modified') === null ? {} : { modified: response.headers.get('last-modified')! }),
  }
  if (response.status === 304) return { status: 304, text: '', ...meta }
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('The page is too large to read')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_BYTES) throw new Error('The page is too large to read')
  return { status: response.status, text: decode(bytes, type), ...meta }
}

export interface FeedItem {
  /** The feed's own id for it, else its link. */
  guid: string
  url: string
  title: string
  author?: string
  published: number
  summary: string
  /** The entry's HTML as the feed carries it (full text or a summary). */
  html?: string
}

export interface ParsedFeed {
  title?: string
  home?: string
  items: FeedItem[]
  /** The page of older items a paged feed names (RFC 5005 `rel="next"`). */
  next?: string
}

type Node = { tagName?: string; localName?: string; textContent: string | null; children: ArrayLike<Node>; getAttribute(name: string): string | null }

const nameOf = (node: Node): string => (node.tagName ?? node.localName ?? '').toLowerCase()
const kids = (node: Node, ...names: string[]): Node[] => Array.from(node.children).filter((child) => names.includes(nameOf(child)))
const kid = (node: Node, ...names: string[]): Node | undefined => {
  for (const name of names) {
    const found = kids(node, name)[0]
    if (found !== undefined) return found
  }
  return undefined
}
const value = (node: Node | undefined): string | undefined => {
  const text = node?.textContent?.trim()
  return text === undefined || text === '' ? undefined : text
}

const resolve = (href: string | undefined, base: string): string | undefined => {
  if (href === undefined) return undefined
  try {
    const url = new URL(href, base)
    return /^https?:$/.test(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

/** HTML as plain text, its whitespace collapsed and cut. */
export function plainText(html: string, max = 280): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  for (const node of document.querySelectorAll('script, style')) node.remove()
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function atomLink(node: Node, base: string): string | undefined {
  const links = kids(node, 'link')
  const pick = links.find((link) => (link.getAttribute('rel') ?? 'alternate') === 'alternate') ?? links[0]
  return resolve(pick?.getAttribute('href') ?? undefined, base)
}

function nextLink(node: Node, base: string): string | undefined {
  const link = kids(node, 'link', 'atom:link').find((item) => item.getAttribute('rel') === 'next')
  return resolve(link?.getAttribute('href') ?? undefined, base)
}

const time = (text: string | undefined): number => {
  const parsed = text === undefined ? NaN : Date.parse(text)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The feed in `text`, or undefined when it is not one. */
export function parseFeed(text: string, base: string): ParsedFeed | undefined {
  if (!/<(rss|feed|rdf:rdf)[\s>]/i.test(text.slice(0, 4096))) return undefined
  const document = new DOMParser().parseFromString(text, 'text/xml') as unknown as { documentElement: Node | null }
  const root = document.documentElement
  if (root === null) return undefined
  const kind = nameOf(root)
  const now = Date.now()
  if (kind === 'feed') {
    const home = atomLink(root, base) ?? base
    const items = kids(root, 'entry').map((entry): FeedItem | undefined => {
      const url = atomLink(entry, home)
      const html = value(kid(entry, 'content')) ?? value(kid(entry, 'summary'))
      const title = value(kid(entry, 'title'))
      if (url === undefined && title === undefined) return undefined
      const writer = kid(entry, 'author')
      const author = writer === undefined ? undefined : value(kid(writer, 'name'))
      return {
        guid: value(kid(entry, 'id')) ?? url ?? title!,
        url: url ?? home,
        title: title === undefined ? (url ?? home) : plainText(title, 300),
        ...(author === undefined ? {} : { author }),
        published: time(value(kid(entry, 'published', 'updated'))) || now,
        summary: html === undefined ? '' : plainText(html),
        ...(html === undefined ? {} : { html }),
      }
    }).filter((item): item is FeedItem => item !== undefined)
    const next = nextLink(root, base)
    return { ...(value(kid(root, 'title')) === undefined ? {} : { title: plainText(value(kid(root, 'title'))!, 200) }), home, items, ...(next === undefined ? {} : { next }) }
  }
  if (kind !== 'rss' && kind !== 'rdf:rdf') return undefined
  const channel = kid(root, 'channel') ?? root
  const home = resolve(value(kid(channel, 'link')), base) ?? base
  // RSS 1.0 keeps its items beside the channel; 2.0 inside it.
  const items = [...kids(channel, 'item'), ...(channel === root ? [] : kids(root, 'item'))].map((item): FeedItem | undefined => {
    const url = resolve(value(kid(item, 'link')) ?? (kid(item, 'guid')?.getAttribute('ispermalink') !== 'false' ? value(kid(item, 'guid')) : undefined), home)
    const html = value(kid(item, 'content:encoded')) ?? value(kid(item, 'description'))
    const title = value(kid(item, 'title'))
    if (url === undefined && title === undefined) return undefined
    const author = value(kid(item, 'dc:creator', 'author'))
    return {
      guid: value(kid(item, 'guid')) ?? url ?? title!,
      url: url ?? home,
      title: title === undefined ? plainText(html ?? url ?? home, 120) : plainText(title, 300),
      ...(author === undefined ? {} : { author }),
      published: time(value(kid(item, 'pubdate', 'dc:date'))) || now,
      summary: html === undefined ? '' : plainText(html),
      ...(html === undefined ? {} : { html }),
    }
  }).filter((item): item is FeedItem => item !== undefined)
  const next = nextLink(channel, base)
  return { ...(value(kid(channel, 'title')) === undefined ? {} : { title: plainText(value(kid(channel, 'title'))!, 200) }), home, items, ...(next === undefined ? {} : { next }) }
}

/** The feed a page names for itself, if any. */
export function discoverFeed(html: string, base: string): string | undefined {
  const { document } = parseHTML(html)
  for (const link of document.querySelectorAll('link[rel~="alternate"]')) {
    const type = (link.getAttribute('type') ?? '').toLowerCase()
    if (type.includes('rss') || type.includes('atom')) return resolve(link.getAttribute('href') ?? undefined, base)
  }
  return undefined
}
