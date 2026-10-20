import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReaderService, type ReaderHost } from '../src/reader/index.ts'
import type { Fetched } from '../src/reader/feed.ts'
import type { ArticleReply, Entry, EntryList, ReaderState } from '../src/reader/types.ts'

const day = (index: number): string => new Date(Date.UTC(2026, 0, 1 + index)).toUTCString()

async function fixture(pages: Record<string, string | (() => string)>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-reader-older-'))
  const fetched: string[] = []
  const fetch: ReaderHost['fetch'] = async (url) => {
    fetched.push(url)
    const page = pages[url]
    if (page === undefined) throw new Error(`no page ${url}`)
    return { status: 200, url, type: 'text/html', text: typeof page === 'function' ? page() : page } satisfies Fetched
  }
  const reader = new ReaderService({ dir, bots: () => [], sessions: () => undefined, fetch, log: () => {} })
  const call = <T>(payload: Record<string, unknown>): Promise<T> => reader.handle(payload) as Promise<T>
  return { reader, call, fetched }
}

/** Posts `to`…`from - 1`, newest first; `next` names the page after it. */
function paged(from: number, to: number, next?: string): string {
  const items = Array.from({ length: from - to }, (_, offset) => {
    const index = from - offset - 1
    return `<item><title>Post ${index}</title><link>https://wp.example/p/${index}</link><guid>p-${index}</guid><pubDate>${day(index)}</pubDate><description>S ${index}</description></item>`
  }).join('')
  const link = next === undefined ? '' : `<atom:link xmlns:atom="http://www.w3.org/2005/Atom" rel="next" href="${next}"/>`
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>WP</title><link>https://wp.example/</link>${link}${items}</channel></rss>`
}

test('reader: an article mostly of links and images is read from its body, not from a long comment', async () => {
  const links = Array.from({ length: 30 }, (_, index) => `<h4><a href="https://v.example/${index}">Video number ${index} with a title</a></h4>`).join('')
  const page = `<html><head><title>Roundup 146</title></head><body><div class="content"><article class="article-content">
    <p>BGM: <a href="https://m.example/1">play</a></p><blockquote>${links}</blockquote><p><img src="https://i.example/1.jpg" alt="one"></p></article>
    <div id="comments"><ol class="commentlist"><li id="comment-1"><p>${'A long and wordy comment about a camera battery that goes on. '.repeat(8)}</p></li></ol></div></div></body></html>`
  const { call } = await fixture({ 'https://wp.example/feed': paged(1, 0), 'https://wp.example/p/0': page })
  await call({ op: 'subscribe', input: 'https://wp.example/feed' })
  const [entry] = (await call<EntryList>({ op: 'entries', view: 'all' })).entries
  const article = await call<ArticleReply>({ op: 'article', url: entry!.url, entry: entry!.id })
  assert.equal(article.status, 'ready')
  if (article.status !== 'ready') return
  assert.equal(article.source, 'page')
  assert.match(article.markdown, /\[Video number 29 with a title\]\(https:\/\/v\.example\/29\)/)
  assert.doesNotMatch(article.markdown, /camera battery/)
})

test('reader: a short feed text stands in when the page has less, and while the page cannot be read', async () => {
  const body = `<p>Intro with <a href="https://x.example/a">a link</a></p>${Array.from({ length: 12 }, (_, index) => `<p><a href="https://x.example/${index}">Item ${index}</a> <img src="https://i.example/${index}.png"></p>`).join('')}`
  const item = (index: number): string =>
    `<item><title>Post ${index}</title><link>https://s.example/${index}</link><guid>${index}</guid><pubDate>${day(index)}</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item>`
  let down = true
  const { call } = await fixture({
    'https://s.example/feed': `<?xml version="1.0"?><rss version="2.0"><channel><title>Short</title><link>https://s.example/</link>${item(2)}${item(1)}</channel></rss>`,
    'https://s.example/2': '<html><body>tiny</body></html>',
    'https://s.example/1': () => {
      if (down) throw new Error('s.example answered 503')
      return '<html><body>tiny</body></html>'
    },
  })
  await call({ op: 'subscribe', input: 'https://s.example/feed' })
  const [newer, older] = (await call<EntryList>({ op: 'entries', view: 'all' })).entries
  const first = await call<ArticleReply>({ op: 'article', url: newer!.url, entry: newer!.id })
  assert.ok(first.status === 'ready')
  assert.equal(first.source, 'feed')
  assert.equal(first.error, undefined)
  assert.match(first.markdown, /!\[\]\(https:\/\/i\.example\/11\.png\)/)
  // The page is down: the feed's text, with the reason.
  const second = await call<ArticleReply>({ op: 'article', url: older!.url, entry: older!.id })
  assert.ok(second.status === 'ready')
  assert.equal(second.source, 'feed')
  assert.match(second.error ?? '', /503/)
  down = false
})

test('reader: older pages come from the source on request, WordPress-paged, read, until it has no more', async () => {
  const { call, fetched } = await fixture({
    'https://wp.example/feed': paged(30, 20),
    'https://wp.example/feed?paged=2': paged(20, 10),
    'https://wp.example/feed?paged=3': paged(10, 0),
    'https://wp.example/feed?paged=4': () => { throw new Error('wp.example answered 404') },
  })
  const id = (await call<ReaderState>({ op: 'subscribe', input: 'https://wp.example/feed' })).feeds[0]!.id
  let list = await call<EntryList>({ op: 'entries', view: id })
  assert.equal(list.entries.length, 10)
  assert.equal(list.more, false)
  assert.equal(list.older, 0)
  assert.deepEqual(await call({ op: 'older', id, from: 0 }), { status: 'ready', added: 10, done: false })
  // Asked again with the same count (a page polling): nothing is read twice.
  assert.deepEqual(await call({ op: 'older', id, from: 0 }), { status: 'ready', added: 0, done: false })
  assert.equal(fetched.filter((url) => url.includes('paged=2')).length, 1)
  const last = list.entries.at(-1)!
  list = await call<EntryList>({ op: 'entries', view: id, before: last.published, beforeId: last.id })
  assert.equal(list.entries[0]!.title, 'Post 19')
  assert.ok(list.entries.every((entry) => entry.read))
  assert.equal((await call<ReaderState>({ op: 'state' })).feeds[0]!.unread, 10)
  await call({ op: 'older', id, from: 1 })
  assert.deepEqual(await call({ op: 'older', id, from: 2 }), { status: 'ready', added: 0, done: true })
  list = await call<EntryList>({ op: 'entries', view: id, limit: 100 })
  assert.equal(list.entries.length, 30)
  assert.equal(list.older, undefined)
})

test('reader: a feed naming its next page is followed through it; a feed that ignores paging is done at once', async () => {
  const { call } = await fixture({
    'https://wp.example/feed': paged(30, 20, 'https://wp.example/archive/2'),
    'https://wp.example/archive/2': paged(20, 10),
    'https://same.example/feed': paged(5, 0),
    'https://same.example/feed?paged=2': paged(5, 0),
  })
  const named = (await call<ReaderState>({ op: 'subscribe', input: 'https://wp.example/feed' })).feeds[0]!.id
  assert.deepEqual(await call({ op: 'older', id: named, from: 0 }), { status: 'ready', added: 10, done: true })
  const same = (await call<ReaderState>({ op: 'subscribe', input: 'https://same.example/feed' })).feeds.find((feed) => feed.url.startsWith('https://same.'))!.id
  assert.deepEqual(await call({ op: 'older', id: same, from: 0 }), { status: 'ready', added: 0, done: true })
})

test('reader: a scheduled read finds out once whether a feed pages, so its view offers older entries only when it does', async () => {
  const { reader, call, fetched } = await fixture({ 'https://html.example/feed': paged(5, 0), 'https://html.example/feed?paged=2': '<html><body>Not a feed</body></html>' })
  const id = (await call<ReaderState>({ op: 'subscribe', input: 'https://html.example/feed' })).feeds[0]!.id
  assert.equal((await call<EntryList>({ op: 'entries', view: id })).older, 0)
  // A scheduled pass (here: the feed list arriving from another machine) reads the feed, then asks for its second page.
  await reader.feedStore.set([...(await reader.feedStore.get())!] as never)
  for (let round = 0; round < 50 && (await call<EntryList>({ op: 'entries', view: id })).older !== undefined; round++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await call<EntryList>({ op: 'entries', view: id })).older, undefined)
  assert.equal(fetched.filter((url) => url.includes('paged=2')).length, 1)
  // Known now: the next pass does not ask again.
  await reader.feedStore.set([...(await reader.feedStore.get())!] as never)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fetched.filter((url) => url.includes('paged=2')).length, 1)
  reader.dispose()
})

test('reader: a starred repository is one entry, opening as the README with its newest release notes beside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-reader-github-'))
  const github = {
    viewer: async () => 'alice',
    stars: async () => ({ stars: [
      { name: 'o/r', url: 'https://github.com/o/r', description: 'A tool', stars: 7, starredAt: 2, release: { tag: 'v1.2', title: 'v1.2', url: 'https://github.com/o/r/releases/tag/v1.2', publishedAt: 3 } },
      { name: 'o/plain', url: 'https://github.com/o/plain', description: null, stars: 1, starredAt: 1 },
    ] }),
    readme: async () => '# R\n\nThe home page. ![logo](docs/logo.png)',
    release: async () => '- Fixed a bug',
  }
  const reader = new ReaderService({ dir, bots: () => [], sessions: () => undefined, github: github as never, log: () => {} })
  const call = <T>(payload: Record<string, unknown>): Promise<T> => reader.handle(payload) as Promise<T>
  await call({ op: 'subscribe', input: 'github' })
  let entries: EntryList['entries'] = []
  for (let round = 0; round < 50 && entries.length < 2; round++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    entries = (await call<EntryList>({ op: 'entries', view: 'all' })).entries
  }
  assert.deepEqual(entries.map((entry) => `${entry.kind}:${entry.repo?.name}:${entry.repo?.tag}`), ['repo:o/r:v1.2', 'repo:o/plain:undefined'])
  const [released, plain] = entries as [Entry, Entry]
  const opened = await call<ArticleReply>({ op: 'article', url: released.url, entry: released.id })
  assert.ok(opened.status === 'ready')
  assert.equal(opened.source, 'release')
  assert.match(opened.markdown, /The home page/)
  assert.match(opened.markdown, /raw\.githubusercontent\.com\/o\/r\/HEAD\/docs\/logo\.png/)
  assert.match(opened.notes ?? '', /Fixed a bug/)
  // A discussion reads both.
  assert.match((await reader.document(opened.key))!.markdown, /Fixed a bug[\s\S]*The home page/)
  const home = await call<ArticleReply>({ op: 'article', url: plain.url, entry: plain.id })
  assert.ok(home.status === 'ready')
  assert.equal(home.source, 'readme')
  assert.equal(home.notes, undefined)
  reader.dispose()
})

test('reader: stars list newest starred first; release entries an earlier version kept fold into their repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-reader-starred-'))
  const star = (name: string, starredAt: number, publishedAt?: number) => ({
    name, url: `https://github.com/${name}`, description: null, stars: 1, starredAt,
    ...(publishedAt === undefined ? {} : { release: { tag: 'v1', title: 'v1', url: `https://github.com/${name}/releases/tag/v1`, publishedAt } }),
  })
  const github = { viewer: async () => 'alice', stars: async () => ({ stars: [star('o/new', 300), star('o/mid', 200, 900), star('o/old', 100)] }) }
  const open = () => {
    const reader = new ReaderService({ dir, bots: () => [], sessions: () => undefined, github: github as never, log: () => {} })
    return { reader, call: <T>(payload: Record<string, unknown>): Promise<T> => reader.handle(payload) as Promise<T> }
  }
  let { reader, call } = open()
  await call({ op: 'subscribe', input: 'github' })
  let entries: EntryList['entries'] = []
  for (let round = 0; round < 50 && entries.length < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    entries = (await call<EntryList>({ op: 'entries', view: 'all' })).entries
  }
  assert.deepEqual(entries.map((entry) => entry.repo?.name), ['o/new', 'o/mid', 'o/old'])
  assert.deepEqual(entries[1]!.repo, { name: 'o/mid', stars: 1, tag: 'v1', released: 900 })
  reader.dispose()
  // As an earlier version kept it: a release entry of its own, the repository's without the tag.
  const file = join(dir, 'state.json')
  const saved = JSON.parse(await readFile(file, 'utf8')) as { feeds: Record<string, { entries: Entry[] }> }
  const state = Object.values(saved.feeds)[0]!
  const repo = state.entries.find((entry) => entry.repo?.name === 'o/new')!
  repo.repo = { name: 'o/new', stars: 1 }
  state.entries.push({ ...repo, id: 'old-release', kind: 'release', url: 'https://github.com/o/new/releases/tag/v0', published: 50, repo: { name: 'o/new', tag: 'v0' } })
  await writeFile(file, JSON.stringify(saved))
  ;({ reader, call } = open())
  entries = (await call<EntryList>({ op: 'entries', view: 'all' })).entries
  assert.deepEqual(entries.map((entry) => `${entry.repo?.name}:${entry.repo?.tag}`), ['o/new:v0', 'o/mid:v1', 'o/old:undefined'])
  reader.dispose()
})

test('reader: entries sharing a time page by id, none skipped', async () => {
  const items = Array.from({ length: 5 }, (_, index) => `<item><title>T ${index}</title><link>https://t.example/${index}</link><guid>t-${index}</guid><pubDate>${day(0)}</pubDate></item>`).join('')
  const { call } = await fixture({ 'https://t.example/feed': `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>` })
  await call({ op: 'subscribe', input: 'https://t.example/feed' })
  const seen: string[] = []
  let list = await call<EntryList>({ op: 'entries', view: 'all', limit: 2 })
  for (;;) {
    seen.push(...list.entries.map((entry) => entry.id))
    if (!list.more) break
    const last = list.entries.at(-1)!
    list = await call<EntryList>({ op: 'entries', view: 'all', limit: 2, before: last.published, beforeId: last.id })
  }
  assert.equal(new Set(seen).size, 5)
})
