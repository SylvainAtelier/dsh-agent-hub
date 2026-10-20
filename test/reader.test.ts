import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReaderService, type ReaderHost } from '../src/reader/index.ts'
import type { Fetched } from '../src/reader/feed.ts'
import { favoriteId, urlKey } from '../src/reader/records.ts'
import type { ArticleReply, EntryList, ReaderState } from '../src/reader/types.ts'
import { flatText, scopeText, sectionOf } from '../src/discussion/context.ts'
import { DiscussionService, type DiscussionHost } from '../src/discussion/service.ts'

const LONG = '<p>' + 'Readable paragraph text that goes on. '.repeat(60) + '</p>'

function rss(count: number, full = false): string {
  const items = Array.from({ length: count }, (_, index) => `
    <item><title>Post ${index}</title><link>https://blog.example/p/${index}?utm_source=rss&amp;id=${index}</link>
    <guid>p-${index}</guid><pubDate>${new Date(Date.UTC(2026, 0, 1 + index)).toUTCString()}</pubDate>
    <description><![CDATA[${full ? LONG : `<p>Short ${index}</p>`}]]></description></item>`).join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Blog</title><link>https://blog.example/</link>${items}</channel></rss>`
}

async function fixture(pages: Record<string, string | (() => string)>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-reader-'))
  const fetched: string[] = []
  const fetch: ReaderHost['fetch'] = async (url) => {
    fetched.push(url)
    const page = pages[url]
    if (page === undefined) throw new Error(`no page ${url}`)
    return { status: 200, url, type: 'text/html', text: typeof page === 'function' ? page() : page } satisfies Fetched
  }
  const reader = new ReaderService({ dir, bots: () => [], sessions: () => undefined, fetch, log: () => {} })
  const call = <T>(payload: Record<string, unknown>): Promise<T> => reader.handle(payload) as Promise<T>
  return { dir, reader, call, fetched }
}

test('reader: a page names its feed; the first read leaves only the newest unread', async () => {
  const { call, fetched } = await fixture({
    'https://blog.example/': '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Hi</body></html>',
    'https://blog.example/feed.xml': rss(30),
  })
  const state = await call<ReaderState>({ op: 'subscribe', input: 'blog.example/' })
  assert.deepEqual(fetched, ['https://blog.example/', 'https://blog.example/feed.xml'])
  assert.equal(state.feeds.length, 1)
  assert.equal(state.feeds[0]!.title, 'Example Blog')
  assert.equal(state.feeds[0]!.unread, 20)
  const unread = await call<EntryList>({ op: 'entries', view: 'unread' })
  assert.equal(unread.entries[0]!.title, 'Post 29')
  assert.equal(unread.entries.length, 20)
  const all = await call<EntryList>({ op: 'entries', view: 'all', limit: 25 })
  assert.equal(all.entries.length, 25)
  assert.equal(all.more, true)
  await assert.rejects(call({ op: 'subscribe', input: 'https://blog.example/feed.xml' }), /Already subscribed/)
})

test('reader: a feed carrying the whole text is the article, cleaned of tracking; marks and favorites persist', async () => {
  const { dir, call } = await fixture({ 'https://blog.example/feed.xml': rss(2, true) })
  const state = await call<ReaderState>({ op: 'subscribe', input: 'https://blog.example/feed.xml' })
  const [entry] = (await call<EntryList>({ op: 'entries', view: state.feeds[0]!.id })).entries
  assert.ok(entry)
  const article = await call<ArticleReply>({ op: 'article', url: entry.url, entry: entry.id })
  assert.equal(article.status, 'ready')
  if (article.status !== 'ready') return
  assert.equal(article.source, 'feed')
  assert.equal(article.key, `doc:${urlKey(entry.url)}`)
  assert.match(article.markdown, /Readable paragraph/)

  await call({ op: 'read', ids: [entry.id], read: true })
  const kept = await call<ReaderState>({ op: 'favorite', url: entry.url, title: entry.title, quote: 'Readable paragraph', note: 'first' })
  assert.equal(kept.favorites[0]!.id, favoriteId(entry.url, 'Readable paragraph'))
  // Keeping the same passage again adds its note.
  const again = await call<ReaderState>({ op: 'favorite', url: entry.url, title: entry.title, quote: 'Readable paragraph', note: 'second' })
  assert.equal(again.favorites.length, 1)
  assert.match(again.favorites[0]!.note!, /first[\s\S]*second/)

  // A fresh service over the same folder reads it all back.
  const reopened = new ReaderService({ dir, bots: () => [], sessions: () => undefined, fetch: async () => { throw new Error('offline') }, log: () => {} })
  const after = await reopened.handle({ op: 'state' }) as ReaderState
  assert.equal(after.favorites.length, 1)
  assert.equal(after.feeds[0]!.unread, 1)
  assert.deepEqual(await reopened.document(article.key), { title: article.title, url: article.url, markdown: article.markdown })
  assert.equal(JSON.parse(await readFile(join(dir, 'feeds.json'), 'utf8')).feeds.length, 1)
})

test('reader: a page without an article falls back to the feed summary, with the reason', async () => {
  const { call } = await fixture({ 'https://blog.example/feed.xml': rss(1), 'https://blog.example/p/0?id=0': '<html><body>tiny</body></html>' })
  await call({ op: 'subscribe', input: 'https://blog.example/feed.xml' })
  const [entry] = (await call<EntryList>({ op: 'entries', view: 'all' })).entries
  // The feed's link carried utm_source; the entry's address does not.
  assert.equal(entry!.url, 'https://blog.example/p/0?id=0')
  const article = await call<ArticleReply>({ op: 'article', url: entry!.url, entry: entry!.id })
  assert.equal(article.status, 'ready')
  if (article.status === 'ready') {
    assert.equal(article.source, 'summary')
    assert.ok(article.error)
  }
})

test('reader: the sync stores take records from another machine, and drop what a removed feed kept', async () => {
  const { reader, call } = await fixture({ 'https://blog.example/feed.xml': rss(3) })
  await call({ op: 'subscribe', input: 'https://blog.example/feed.xml' })
  assert.equal((await reader.feedStore.get())!.length, 1)
  assert.equal(await reader.feedStore.set([]), true)
  const state = await call<ReaderState>({ op: 'state' })
  assert.equal(state.feeds.length, 0)
  assert.equal((await call<EntryList>({ op: 'entries', view: 'all' })).entries.length, 0)
  await reader.favoriteStore.set([{ id: 'x', url: 'https://a.example/', title: 'A', at: 5 } as never])
  const favorites = (await call<ReaderState>({ op: 'state' })).favorites
  assert.equal(favorites[0]!.id, favoriteId('https://a.example/'))
  reader.dispose()
})

test('reader: OPML round trip', async () => {
  const { call } = await fixture({ 'https://blog.example/feed.xml': rss(1) })
  await call({ op: 'subscribe', input: 'https://blog.example/feed.xml' })
  const opml = await call<string>({ op: 'exportOpml' })
  assert.match(opml, /xmlUrl="https:\/\/blog\.example\/feed\.xml"/)
  const other = await fixture({})
  const imported = await other.call<ReaderState & { added: number }>({ op: 'importOpml', text: opml })
  assert.equal(imported.added, 1)
  assert.equal(imported.feeds[0]!.title, 'Example Blog')
  await assert.rejects(other.call({ op: 'importOpml', text: opml }), /No new feeds/)
  other.reader.dispose()
})

test('discussion context: a selection finds its section; small ones widen to their parent', () => {
  const markdown = ['# Title', 'intro', '## Setup', 'Install **the** tool with [npm](https://npm.example).', '### Detail', 'tiny', '## Usage', 'Run it.'].join('\n')
  assert.equal(flatText('Install **the** tool with [npm](x)'), 'Installthetoolwithnpm')
  assert.equal(sectionOf(markdown, 'Install the tool with npm'), ['## Setup', 'Install **the** tool with [npm](https://npm.example).', '### Detail', 'tiny'].join('\n'))
  // A tiny subsection is shown with its parent.
  assert.match(sectionOf(markdown, 'tiny'), /^## Setup[\s\S]*tiny$/)
  assert.equal(sectionOf(markdown, 'not there'), markdown)
  assert.equal(scopeText(markdown, 'tiny', 'selection'), '')
  assert.equal(scopeText(markdown, '', 'article'), markdown)
})

test('discussion: a reader article discussion carries the level asked for, and answers as a bot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-doc-discussion-'))
  const calls: Array<{ system: string; messages: Array<{ content: Array<{ text: string }> }>; provider: string }> = []
  const owner = `doc:${'a'.repeat(16)}`
  const host: DiscussionHost = {
    dir, settings: () => ({ enabled: true }), route: async () => ({ provider: 'test', model: 'small' }),
    llm: () => ({ async *stream(options: object) {
      calls.push(options as never)
      yield { type: 'text-delta', text: 'Answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }) as never,
    events: async () => { throw new Error('not a session') },
    instructions: () => '', log: () => {},
    document: async (key) => (key === owner ? { title: 'Doc', url: 'https://d.example/', markdown: '# A\nfirst part here\n# B\nsecond part here' } : undefined),
    bots: () => [{ id: 'critic' }],
    bot: async (id) => (id === 'critic' ? { route: { provider: 'bot-model', model: 'm' }, persona: 'You are a sharp critic.' } : undefined),
  }
  const service = new DiscussionService(host)
  const ask = async (id: string, question: string, scope?: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      void service.watch(owner, (event) => { if (event.type === 'turn' && event.id === id && event.turn.status !== 'running') resolve() })
    })
    await service.handle({ sessionId: owner, op: 'ask', id, question, requestId: randomUUID(), ...(scope === undefined ? {} : { scope }) })
    await done
  }
  await assert.rejects(service.handle({ sessionId: `doc:${'b'.repeat(16)}`, op: 'list' }), /not cached/)

  const id = randomUUID()
  const state = await service.handle({ sessionId: owner, op: 'create', id, quote: 'second part', scope: 'section', bot: 'critic' })
  assert.deepEqual(state.bots, [{ id: 'critic' }])
  assert.equal(state.threads[0]!.route.provider, 'bot-model')
  await ask(id, 'Why?')
  assert.match(calls[0]!.system, /^You are a sharp critic\./)
  const context = calls[0]!.messages[0]!.content[0]!.text
  assert.match(context, /# B\nsecond part here/)
  assert.doesNotMatch(context, /first part/)
  // Widen to the whole article for the next question.
  await ask(id, 'And overall?', 'article')
  assert.match(calls[1]!.messages[0]!.content[0]!.text, /first part[\s\S]*second part/)
  await assert.rejects(service.handle({ sessionId: owner, op: 'stage', id, through: 1 }), /no main session/)

  // A whole article without a selection.
  const whole = randomUUID()
  await service.handle({ sessionId: owner, op: 'create', id: whole, quote: '', scope: 'article' })
  await ask(whole, 'Summary?')
  assert.doesNotMatch(calls[2]!.messages[0]!.content[0]!.text, /Selected text/)
  await service.dispose()
})
