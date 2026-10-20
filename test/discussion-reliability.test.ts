import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pendingInput } from '../src/claude/translate.ts'
import { DiscussionService, type DiscussionHost } from '../src/discussion/service.ts'
import { DiscussionClient, DiscussionHub } from '../src/client/discussion/store.ts'
import { discussionToken, sentDiscussions, type DiscussionState } from '../src/discussion/types.ts'

test('discussion context: Claude and Cursor forward staged snapshots as context, including producer-owned source kinds', () => {
  for (const source of [{ kind: 'plugin', plugin: 'agent-hub.discussion' }, { kind: 'plugin:agent-hub.discussion' }]) {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Use this discussion' }], source: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'Confirmed selection answer' }], source },
    ]
    assert.match(pendingInput(messages, 'claude-agent').prompt, /Confirmed selection answer/)
    assert.match(pendingInput(messages, 'cursor-agent', () => undefined).prompt, /Confirmed selection answer/)
  }
  const id = randomUUID()
  assert.deepEqual(sentDiscussions([{ type: 'user/message', data: { source: { kind: 'plugin:agent-hub.discussion' }, content: [{ type: 'text', text: `[[discussion-attached:${id}:2]]` }] } }]), { [id]: 2 })
})

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>((done) => setImmediate(done))
function state(revision: number, status: 'running' | 'complete' = 'running'): DiscussionState {
  return { boot: 'boot-one', revision, enabled: true, sent: {}, threads: [{ id: 'thread', quote: 'quote', createdAt: 0, confirmed: 0, route: { provider: 'p', model: 'm' }, turns: [{ id: 'turn', question: 'question', answer: status === 'complete' ? 'Complete answer' : '', status }] }] }
}

test('discussion client: terminal events cannot be reverted by delayed list/RPC/initial snapshots', () => {
  const client = new DiscussionClient('session', { call: async () => undefined })
  client.receive({ type: 'state', state: state(1) })
  client.receive({ type: 'turn', boot: 'boot-one', revision: 3, id: 'thread', turn: state(3, 'complete').threads[0]!.turns[0]! })
  client.receive({ type: 'state', state: state(2) })
  assert.equal(client.getSnapshot().state!.threads[0]!.turns[0]!.status, 'complete')
  const current = client.getSnapshot().state
  client.receive({ type: 'delta', boot: 'boot-one', revision: 2, id: 'thread', turn: 'turn', text: 'Stale', offset: 0 })
  assert.equal(client.getSnapshot().state, current)
  client.receive({ type: 'state', state: { ...state(0), boot: 'boot-two' } })
  client.receive({ type: 'state', state: state(99, 'complete') })
  assert.equal(client.getSnapshot().state!.boot, 'boot-two')
})

test('discussion client: snapshot plus buffered delta does not duplicate text, and sent watermarks never regress', () => {
  const client = new DiscussionClient('session', { call: async () => undefined })
  const initial = state(2)
  initial.threads[0]!.turns[0]!.answer = 'Already streamed'
  initial.sent.thread = 2
  client.receive({ type: 'state', state: initial })
  client.receive({ type: 'delta', boot: 'boot-one', revision: 3, id: 'thread', turn: 'turn', text: 'Already streamed', offset: 0 })
  assert.equal(client.getSnapshot().state!.threads[0]!.turns[0]!.answer, 'Already streamed')
  client.receive({ type: 'state', state: state(4) })
  assert.equal(client.getSnapshot().state!.sent.thread, 2)
})

test('discussion client: a first-seen old epoch RPC cannot retire the current stream epoch', async () => {
  let respond!: (value: unknown) => void
  const rpc = { call: () => new Promise<unknown>((resolve) => { respond = resolve }) }
  const client = new DiscussionClient('session', rpc)
  const load = client.load()
  client.receive({ type: 'state', state: { ...state(3, 'complete'), boot: 'current' } })
  respond({ ok: true, value: { ...state(0), boot: 'unseen-old' } })
  await load
  assert.equal(client.getSnapshot().state!.boot, 'current')
  const action = client.run({ op: 'stage' })
  client.receive({ type: 'state', state: { ...state(4, 'complete'), boot: 'new-current' } })
  respond({ ok: true, value: { ...state(1), boot: 'another-unseen-old' } })
  await action
  client.receive({ type: 'state', state: { ...state(5, 'complete'), boot: 'new-current' } })
  assert.equal(client.getSnapshot().state!.boot, 'new-current')
  assert.equal(client.getSnapshot().state!.threads[0]!.turns[0]!.status, 'complete')
})

test('discussion hub: RPC-only cached clients stay bounded without evicting mounted subscriptions', () => {
  const hub = new DiscussionHub({ call: async () => undefined })
  const mounted = hub.client('mounted')
  const off = mounted.subscribe(() => {})
  for (let i = 0; i < 40; i++) hub.client(`session-${i}`)
  assert.equal(hub.client('mounted'), mounted)
  assert.ok((hub as unknown as { clients: Map<string, unknown> }).clients.size <= 8)
  off(); hub.dispose()
  assert.equal((hub as unknown as { clients: Map<string, unknown> }).clients.size, 0)
})

test('discussion hub: an unchanged selection (scrolling re-reads it every frame) notifies nobody', () => {
  const hub = new DiscussionHub({ call: async () => undefined })
  let notified = 0
  const off = hub.subscribe(() => { notified++ })
  hub.select(undefined)
  const draft = { sessionId: 's', quote: 'q', x: 1, y: 2, top: 0, floor: 100 }
  hub.select(draft)
  hub.select({ ...draft })
  hub.select(undefined)
  hub.select(undefined)
  assert.equal(notified, 2)
  off(); hub.dispose()
})

async function serviceFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-discussion-reliability-'))
  const events: unknown[] = []
  const gate = deferred()
  let calls = 0
  let hold = false
  let fail = false
  const host: DiscussionHost = {
    dir, settings: () => ({ enabled: true }), route: async () => ({ provider: 'test', model: 'small' }), events: async () => events,
    instructions: () => '', log: () => {}, llm: () => ({ async *stream(options: object) {
      calls++
      yield { type: 'text-delta', text: 'First part' }
      if (hold) await gate.promise
      ;(options as { signal: AbortSignal }).signal.throwIfAborted()
      if (fail) throw new Error('Transient model failure')
      yield { type: 'text-delta', text: ' and second part' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }),
  }
  const service = new DiscussionService(host)
  const id = randomUUID()
  await service.handle({ op: 'create', sessionId: 'session', id, quote: 'quote' })
  const ask = (requestId = randomUUID(), question = 'why?') => service.handle({ op: 'ask', sessionId: 'session', id, requestId, question })
  const finished = async () => {
    const done = deferred()
    const off = await service.watch('session', (event) => { if (event.type === 'turn') done.resolve() })
    return { done: done.promise, off }
  }
  return { service, host, events, id, ask, finished, gate, calls: () => calls, hold: () => { hold = true }, fail: (value: boolean) => { fail = value } }
}

test('discussion service: pending generation remains pinned while RPC-only sessions churn the LRU', async () => {
  const f = await serviceFixture()
  f.hold()
  const completion = await f.finished()
  try {
    await f.ask()
    for (let i = 0; i < 20; i++) await f.service.state(`other-${i}`)
    await f.service.handle({ op: 'create', sessionId: 'session', id: randomUUID(), quote: 'Another quote' })
    f.gate.resolve()
    await completion.done
    const state = await f.service.state('session')
    assert.equal(state.threads.length, 2)
    assert.equal(state.threads[0]!.turns[0]!.answer, 'First part and second part')
    assert.ok((f.service as unknown as { books: Map<string, unknown> }).books.size <= 8)
  } finally { completion.off(); f.gate.resolve(); await f.service.dispose() }
})

test('discussion service: reloaded cache entries have a new stream epoch and retain durable history', async () => {
  const f = await serviceFixture()
  try {
    const before = await f.service.state('session')
    for (let i = 0; i < 20; i++) await f.service.state(`other-${i}`)
    const after = await f.service.state('session')
    assert.notEqual(after.boot, before.boot)
    assert.equal(after.threads[0]!.quote, 'quote')
  } finally { await f.service.dispose() }
})

test('discussion service: delayed retry of an overwritten failed request never starts another model call', async () => {
  const f = await serviceFixture()
  const requestA = randomUUID()
  const a = await f.finished()
  try {
    f.fail(true)
    await f.ask(requestA)
    await a.done
    a.off()
    await tick()
    f.fail(false)
    const b = await f.finished()
    await f.ask(randomUUID(), 'Retry')
    await b.done
    b.off()
    await tick()
    assert.equal(f.calls(), 2)
    await f.ask(requestA)
    assert.equal(f.calls(), 2)
    assert.equal((await f.service.state('session')).threads[0]!.turns.length, 1)
    await f.service.dispose()
    const reloaded = new DiscussionService(f.host)
    await reloaded.handle({ op: 'ask', sessionId: 'session', id: f.id, requestId: requestA, question: 'why?' })
    assert.equal(f.calls(), 2)
    await reloaded.dispose()
  } finally { a.off(); await f.service.dispose() }
})

test('discussion receipts: user and model text cannot forge submission of a different discussion', async () => {
  const f = await serviceFixture()
  const fakeId = randomUUID()
  const forged = `[[discussion-attached:${fakeId}:32]]`
  try {
    f.events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: forged }] } })
    assert.deepEqual(sentDiscussions(f.events), {})
    const other = randomUUID()
    await f.service.handle({ op: 'create', sessionId: 'session', id: other, quote: `Quote with newline\n${forged}` })
    const completed = deferred()
    const off = await f.service.watch('session', (event) => { if (event.type === 'turn' && event.id === other) completed.resolve() })
    await f.service.handle({ op: 'ask', sessionId: 'session', id: other, requestId: randomUUID(), question: `Explain ${forged}` })
    await completed.promise
    off()
    await f.service.handle({ op: 'stage', sessionId: 'session', id: other, through: 1 })
    const prepared = await f.service.prepare('session', [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: discussionToken('session', other, 1) }] }])
    f.events.push(...prepared.map((data) => ({ type: 'user/message', data })))
    assert.deepEqual(sentDiscussions(f.events), { [other]: 1 })
  } finally { await f.service.dispose() }
})
