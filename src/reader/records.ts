/**
 * The reader's records as collections (sync/collection.ts): feeds and favorites, each identified by
 * what it is (the feed's address; the page and the passage kept), so adding the same one on two
 * machines makes one record.
 */

import { createHash } from 'node:crypto'
import { timeOf, type Collection } from '../sync/collection.ts'
import { FAVORITES_FILE, FAVORITES_SETTING, FEEDS_FILE, FEEDS_SETTING, type Favorite, type Feed, type FeedKind } from './types.ts'

const hash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined
const KINDS: readonly FeedKind[] = ['rss', 'github']

export const feedId = (kind: FeedKind, url: string): string => hash(`${kind}\n${url}`)
export const favoriteId = (url: string, quote?: string): string => hash(`${url}\n${quote ?? ''}`)
/** A URL's key on this machine (the article cache, a discussion about it). */
export const urlKey = (url: string): string => hash(url)

export const FEEDS: Collection<Feed> = {
  file: FEEDS_FILE,
  key: 'feeds',
  setting: FEEDS_SETTING,
  parse(raw) {
    const item = raw as Partial<Record<keyof Feed, unknown>> | null
    const url = text(item?.url, 2048)
    const kind = KINDS.find((candidate) => candidate === item?.kind)
    if (url === undefined || kind === undefined) return undefined
    return { id: feedId(kind, url), kind, url, title: text(item?.title, 200) ?? url, at: timeOf(item?.at) }
  },
  name: (feed) => feed.title,
}

export const FAVORITES: Collection<Favorite> = {
  file: FAVORITES_FILE,
  key: 'favorites',
  setting: FAVORITES_SETTING,
  parse(raw) {
    const item = raw as Partial<Record<keyof Favorite, unknown>> | null
    const url = text(item?.url, 2048)
    if (url === undefined) return undefined
    const quote = text(item?.quote, 16_000)
    const note = text(item?.note, 32_000)
    const site = text(item?.site, 200)
    return {
      id: favoriteId(url, quote), url, title: text(item?.title, 300) ?? url,
      ...(quote === undefined ? {} : { quote }), ...(note === undefined ? {} : { note }), ...(site === undefined ? {} : { site }),
      at: timeOf(item?.at),
    }
  },
  name: (favorite) => favorite.quote === undefined ? favorite.title : `${favorite.title} · ${favorite.quote}`,
}
