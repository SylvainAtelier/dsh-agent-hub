import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { Typer } from '../src/device/type.ts'
import { Sessions } from '../src/device/view.ts'
import { Approvals } from '../src/device/control.ts'
import { CardputerStore } from '../src/client/device/api.ts'
import type { DeviceStatus } from '../src/device/types.ts'
import { AlertsStore } from '../src/client/alerts/api.ts'
import { ReviewStore } from '../src/client/review/api.ts'
import { transcribe, wav } from '../src/device/voice.ts'

function helper() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: 0,
    kill() { this.kills++; return true },
  })
  const typer = new Typer('fixture', () => {}, (() => child) as unknown as typeof spawn)
  return { typer, child }
}

test('typer: dispose rejects pending calls immediately and prevents respawn', async () => {
  const { typer, child } = helper()
  const typing = typer.type('hello', 'unicode')
  const rejected = assert.rejects(typing, /disposed/)
  typer.dispose()
  await rejected
  assert.equal(child.kills, 1)
  await assert.rejects(typer.type('hello', 'unicode'), /disposed/)
})

test('typer: bounded queue, malformed reply and stdin errors reject safely', async () => {
  const { typer, child } = helper()
  const calls = Array.from({ length: 8 }, () => typer.type('hello', 'unicode'))
  const rejected = calls.map((call) => assert.rejects(call, /reply too large/))
  await assert.rejects(typer.type('extra', 'unicode'), /busy/)
  child.stdout.write('x'.repeat(32 * 1024 + 1))
  await Promise.all(rejected)
  assert.equal(child.kills, 1)
  typer.dispose()
})

test('typer: stale child exit cannot reject replacement process requests', async () => {
  const children = [helper().child, helper().child]
  let next = 0
  const typer = new Typer('fixture', () => {}, (() => children[next++]!) as unknown as typeof spawn)
  const first = typer.type('first', 'auto')
  const rejected = assert.rejects(first, /input failed/)
  children[0]!.stdin.emit('error', new Error('broken'))
  await rejected
  const second = typer.type('second', 'auto')
  children[0]!.emit('exit', 1)
  children[1]!.stdout.write('{"id":2,"ok":true}\n')
  await second
  typer.dispose()
})

test('voice: bounded recognizer replies and caller cancellation use one deadline signal', async (t) => {
  let body = JSON.stringify({ text: ' recognized ' })
  let seen: RequestInit | undefined
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { seen = init; return new Response(body) })
  const abort = new AbortController()
  const settings = { stt: 'openai' as const, sttUrl: 'http://127.0.0.1:1/v1' }
  assert.equal(await transcribe(wav(Buffer.alloc(9600)), settings, {}, [], abort.signal), 'recognized')
  assert.ok(seen?.signal !== abort.signal)
  abort.abort()
  assert.equal(seen?.signal?.aborted, true)
  body = 'x'.repeat(65537)
  await assert.rejects(transcribe(wav(Buffer.alloc(9600)), settings, {}, []), /response too large/)
  body = '{}'
  await assert.rejects(transcribe(wav(Buffer.alloc(9600)), settings, {}, []), /invalid response/)
  body = JSON.stringify({ text: 'x'.repeat(4001) })
  await assert.rejects(transcribe(wav(Buffer.alloc(9600)), settings, {}, []), /too much text/)
})

test('sessions: unrelated events allocate no tracks and tracked history is bounded', () => {
  const sessions = new Sessions()
  for (let n = 0; n < 1000; n++) sessions.observe({ header: { id: `ignored-${n}` } }, { type: 'message/delta' })
  assert.equal(sessions.has('ignored-999'), false)
  for (let n = 0; n < 1000; n++) sessions.observe({ header: { id: `s${n}` } }, { type: 'turn/start', time: n })
  assert.equal(sessions.has('s743'), false)
  assert.equal(sessions.has('s744'), true)
  assert.equal(sessions.rows(1000).length, 8)
})

test('approvals: synchronous downstream failure and disposal clear pending requests', async () => {
  const approvals = new Approvals(() => true)
  const request = { agent: { id: 's' }, toolName: 'Read' }
  assert.equal(await approvals.answer(request, () => { throw new Error('offline') }), 'unavailable')
  const waiting = approvals.answer(request, () => new Promise(() => {}))
  approvals.dispose()
  assert.equal(await waiting, 'cancelled')
  assert.equal(approvals.list().length, 0)
})

const status: DeviceStatus = { host: 'test', devices: [], pairing: null, link: { state: 'off' }, stt: { provider: 'minimax', ready: false }, typer: { available: false } }
const drain = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }

function visibility() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  return { document, restore() { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') } }
}

test('cardputer polling: identical status keeps reference, hidden/unwatched pages do not poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = visibility()
  let calls = 0
  const store = new CardputerStore({ async call() { calls++; return { ok: true, value: structuredClone(status) } } })
  const off = store.watch()
  try {
    await drain()
    const first = store.getSnapshot()
    t.mock.timers.tick(4000)
    await drain()
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot(), first)
    view.document.visibilityState = 'hidden'
    view.document.dispatchEvent(new Event('visibilitychange'))
    t.mock.timers.tick(60_000)
    await drain()
    assert.equal(calls, 2)
    view.document.visibilityState = 'visible'
    view.document.dispatchEvent(new Event('visibilitychange'))
    await drain()
    assert.equal(calls, 3)
    off(); off()
    t.mock.timers.tick(60_000)
    assert.equal(calls, 3)
  } finally { off(); view.restore(); t.mock.timers.reset() }
})

test('cardputer: an older poll cannot overwrite a completed action', async () => {
  const pending: Array<(value: unknown) => void> = []
  const store = new CardputerStore({ call: () => new Promise((resolve) => pending.push(resolve)) })
  const poll = store.run({ op: 'status' })
  assert.equal(store.run({ op: 'status' }), poll)
  const action = store.run({ op: 'pair' })
  pending[1]!({ ok: true, value: { ...status, pairing: { phase: 'waiting', until: 123 } } })
  await action
  pending[0]!({ ok: true, value: status })
  await poll
  assert.equal(store.getSnapshot().status?.pairing?.phase, 'waiting')
})

test('review explanations: hidden pages and removed subscribers stop streaming polls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = visibility()
  let calls = 0
  const store = new ReviewStore(async () => { calls++; return { ok: true, value: { head: 'h', version: '1', items: [{ turns: [{ done: false }] }] } } })
  const off = store.watchExplained('pull', () => {})
  try {
    await drain()
    assert.equal(calls, 1)
    view.document.visibilityState = 'hidden'
    view.document.dispatchEvent(new Event('visibilitychange'))
    t.mock.timers.tick(60_000)
    await drain()
    assert.equal(calls, 1)
    view.document.visibilityState = 'visible'
    view.document.dispatchEvent(new Event('visibilitychange'))
    await drain()
    assert.equal(calls, 2)
    off()
    t.mock.timers.tick(60_000)
    await drain()
    assert.equal(calls, 2)
  } finally { off(); store.dispose(); view.restore(); t.mock.timers.reset() }
})

test('alerts polling: hidden and final unsubscribe stop automatic RPCs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = visibility()
  let calls = 0
  const store = new AlertsStore(async () => { calls++; return { ok: true, value: { issues: [{ phase: 'analysing' }], period: '7d', sort: 'lastSeen', order: 'desc' } } })
  const off = store.subscribe(() => {})
  try {
    await store.load()
    view.document.visibilityState = 'hidden'
    view.document.dispatchEvent(new Event('visibilitychange'))
    t.mock.timers.tick(60_000)
    await drain()
    assert.equal(calls, 1)
    view.document.visibilityState = 'visible'
    view.document.dispatchEvent(new Event('visibilitychange'))
    await drain()
    assert.equal(calls, 2)
    off()
    t.mock.timers.tick(60_000)
    assert.equal(calls, 2)
  } finally { off(); store.dispose(); view.restore(); t.mock.timers.reset() }
})
