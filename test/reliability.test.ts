import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteJson } from '../src/persistence.ts'
import { createHub, mergeWithLast } from '../src/usage/hub.ts'
import { readCodex } from '../src/usage/sources/codex.ts'
import { createFeed } from '../src/client/usage/feed.ts'
import { rpcValue } from '../src/client/rpc.ts'
import { ConfigFormModel, type ConfigScope } from '../src/client/config/form.ts'
import { emptyEntry, fold, totals } from '../src/usage/tokens.ts'
import { ConnectorsStore } from '../src/client/connectors/api.ts'
import { ReposStore } from '../src/client/repos/api.ts'
import type { PlanQuota, UsageOverview } from '../src/usage/types.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const quota: PlanQuota = { id: 'codex:a', provider: 'codex', windows: [{ key: '5h', usedPercent: 20 }], fetchedAt: 1 }
const overview: UsageOverview = { quotas: [quota], at: 1 }

test('persistence: replacement is atomic and failed renames leave no temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-atomic-'))
  try {
    const file = join(dir, 'state.json')
    await atomicWriteJson(file, { n: 1 })
    await atomicWriteJson(file, { n: 2 })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 2 })
    const directory = join(dir, 'directory.json')
    await mkdir(directory)
    await assert.rejects(atomicWriteJson(directory, { n: 3 }))
    assert.deepEqual((await readdir(dir)).sort(), ['directory.json', 'state.json'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hub: a corrupt snapshot cannot poison live reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-hub-'))
  try {
    const file = join(dir, 'usage.json')
    await writeFile(file, '{ broken')
    const errors: string[] = []
    const saved = deferred<void>()
    const hub = createHub({ claude: async () => [], codex: async () => [quota], minimax: async () => [] }, file, {
      log: (text) => errors.push(text),
      async write(path, value) { await atomicWriteJson(path, value); saved.resolve() },
    })
    assert.deepEqual((await hub.overview()).quotas, [quota])
    await saved.promise
    assert.equal(errors.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('hub: persistence retries the same snapshot after failure and serializes writes', async () => {
  let calls = 0
  let active = 0
  let maximum = 0
  const gate = deferred<void>()
  const errors: string[] = []
  const hub = createHub({ claude: async () => [], codex: async () => [quota], minimax: async () => [] }, undefined, {})
  // Missing snapshot is normal; use an injected writer to exercise failure without disk races.
  const dir = await mkdtemp(join(tmpdir(), 'ah-hub-write-'))
  try {
    const persistent = createHub({ claude: async () => [], codex: async () => [quota], minimax: async () => [] }, join(dir, 'usage.json'), {
      log: (text) => errors.push(text),
      async write() {
        calls++; active++; maximum = Math.max(maximum, active)
        try {
          if (calls === 1) throw new Error('disk unavailable')
          await gate.promise
        } finally { active-- }
      },
    })
    await persistent.overview(); await tick()
    await persistent.overview(); await tick()
    await persistent.overview(); await tick()
    assert.equal(calls, 2)
    assert.equal(maximum, 1)
    gate.resolve(); await tick()
    assert.equal(calls, 2, 'queued equal snapshots skip only after the successful write')
    assert.equal(errors.length, 1)
    assert.deepEqual((await hub.overview()).quotas, [quota])
  } finally { gate.resolve(); await tick(); await rm(dir, { recursive: true, force: true }) }
})

test('hub: pending reads remain shared beyond TTL and force floor', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const gate = deferred<PlanQuota[]>()
  let calls = 0
  const hub = createHub({ claude: async () => [], codex: () => { calls++; return gate.promise }, minimax: async () => [] })
  const first = hub.overview(true)
  await tick()
  t.mock.timers.tick(600_000)
  const second = hub.overview(true)
  await tick()
  assert.equal(calls, 1)
  gate.resolve([quota])
  assert.deepEqual((await first).quotas, [quota])
  assert.deepEqual((await second).quotas, [quota])
})

test('hub: directory failures preserve accounts, successful empty directories prune them', async () => {
  const last = new Map([[quota.id, quota]])
  const failed: PlanQuota = { id: 'codex', provider: 'codex', windows: [], fetchedAt: 0, error: { code: 'failed', scope: 'source' } }
  const merged = mergeWithLast([failed], last)
  assert.equal(merged.quotas[0]!.id, quota.id)
  assert.equal(merged.quotas[0]!.stale, true)
  assert.equal(merged.last.size, 1)
  assert.equal(mergeWithLast([], merged.last).last.size, 0)
  await assert.rejects(readCodex({ async readRecord() { throw new Error('vault offline') }, async resolve() { return undefined } }, 'vault'), /vault offline/)
  const hub = createHub({ claude: async () => [], codex: async () => [quota], minimax: async () => [] })
  assert.equal((await hub.overview()).quotas[0]!.id, quota.id)
})

test('feed: slow requests are not superseded by polls; forced refresh is coalesced', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const listeners = new Map<string, () => void>()
  const document = { visibilityState: 'visible', addEventListener: (key: string, listener: () => void) => listeners.set(key, listener), removeEventListener: (key: string) => listeners.delete(key) }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 })
  const gate = deferred<UsageOverview>()
  const calls: boolean[] = []
  const feed = createFeed((force) => { calls.push(force); return calls.length === 1 ? gate.promise : Promise.resolve(overview) })
  const off = feed.subscribe(() => {})
  try {
    await tick()
    t.mock.timers.tick(180_000); await tick()
    assert.deepEqual(calls, [false])
    feed.refresh(); feed.refresh()
    gate.resolve(overview); await tick(); await tick()
    assert.deepEqual(calls, [false, true])
    assert.equal(feed.getSnapshot().overview, overview)
    assert.equal(feed.getSnapshot().loading, false)
    document.visibilityState = 'hidden'
    t.mock.timers.tick(180_000); await tick()
    assert.equal(calls.length, 2)
    document.visibilityState = 'visible'; listeners.get('visibilitychange')?.(); await tick()
    assert.equal(calls.length, 3)
  } finally {
    off()
    if (original === undefined) delete (globalThis as { document?: unknown }).document
    else Object.defineProperty(globalThis, 'document', original)
  }
})

test('rpc: unwraps only the transport envelope and retains domain failures', async () => {
  const domain = { ok: false, error: 'domain failure' }
  assert.equal(await rpcValue({ call: async () => ({ ok: true, value: domain }) }, 'method', {}, 'fallback'), domain)
  await assert.rejects(rpcValue({ call: async () => ({ ok: false, error: { message: 'server failure' } }) }, 'method', {}, 'fallback'), /server failure/)
  await assert.rejects(rpcValue({ call: async () => undefined }, 'method', {}, 'fallback'), /fallback/)
})

test('config: old visit cleanup never clears a new visit draft or its autosave', async () => {
  const gate = deferred<boolean>()
  let stored = ''
  let calls = 0
  const scope: ConfigScope = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: { git: { instructions: stored } }, user: {} }),
    subscribe: () => () => {},
    async mutate(ops) {
      calls++
      const text = (ops[0] as { value: string }).value
      if (calls === 1) await gate.promise
      stored = text
      return true
    },
  }
  const form = new ConfigFormModel(scope)
  try {
    form.edit('git.instructions', 'old visit')
    const leaving = form.leave()
    await tick()
    form.edit('git.instructions', 'new visit')
    gate.resolve(true); await leaving
    assert.equal(form.getSnapshot().fields['git.instructions']!.value, 'new visit')
    assert.equal(form.getSnapshot().dirty, true)
    await form.flush()
    assert.equal(stored, 'new visit')
  } finally { form.dispose() }
})

test('tokens: bot replay counts underlying Claude totals and account/session resets', () => {
  const entry = emptyEntry()
  const event = (account: string, session: string, input: number) => ({ type: 'assistant/message', time: Date.now(), data: {
    usage: { inputTokens: 1, outputTokens: 1 }, message: { source: { provider: 'agent-hub-bot', model: 'coder', replayState: {
      via: { provider: 'claude-agent', model: 'opus' }, state: { claude: { account, session, total: { opus: { input, output: 2, cacheRead: 300, cacheWrite: 4 } } } },
    } } },
  } })
  fold(entry, event('a', 's1', 100))
  fold(entry, event('a', 's1', 110))
  fold(entry, event('b', 's2', 200))
  const rows = totals([entry]).rows
  assert.equal(rows.length, 1)
  assert.deepEqual({ provider: rows[0]!.provider, model: rows[0]!.model, input: rows[0]!.input, output: rows[0]!.output }, { provider: 'claude-agent', model: 'opus', input: 310, output: 4 })
})

test('tokens: non-Claude bots retain the real provider route without replay state', () => {
  const entry = emptyEntry()
  fold(entry, { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 7, outputTokens: 3 }, message: { source: {
    provider: 'agent-hub-bot', model: 'coder', replayState: { via: { provider: 'openai-codex', model: 'm' }, // JSON logs omit an undefined state, but the underlying route remains.
  },
  } } } })
  assert.equal(totals([entry]).rows[0]!.provider, 'openai-codex')
  assert.equal(totals([entry]).rows[0]!.input, 7)
})

test('connectors client: dispose prevents late state publication and stale loads lose', async () => {
  const a = deferred<unknown>()
  const b = deferred<unknown>()
  let calls = 0
  const store = new ConnectorsStore(() => ++calls === 1 ? a.promise : b.promise)
  const first = store.load(); const second = store.load()
  b.resolve({ connectors: [], issues: true }); await second
  a.resolve({ connectors: [], issues: false }); await first
  assert.equal(store.getSnapshot().issues, true)
  const before = store.getSnapshot()
  store.dispose(); await store.load()
  assert.equal(store.getSnapshot(), before)
  assert.equal(calls, 2)
})

test('connectors client: cancelled disconnects cannot authorize removal of a newer connection', async () => {
  const old = deferred<unknown>()
  const newer = deferred<unknown>()
  const connected = { phase: 'connected' as const, tools: 1, via: 'token' as const }
  const store = new ConnectorsStore((request) => request.op === 'status'
    ? Promise.resolve({ connectors: [], issues: false }) : request.op === 'disconnect' ? old.promise : newer.promise)
  try {
    const first = store.run('fake', { op: 'disconnect', id: 'fake' })
    const second = store.run('fake', { op: 'token', id: 'fake', url: 'https://example.test/mcp', token: 'new' })
    newer.resolve(connected)
    assert.deepEqual(await second, connected)
    old.resolve(undefined)
    const cancelled = await first
    assert.equal(cancelled?.phase, 'error', 'remove must stop instead of treating undefined as success')
    assert.deepEqual(store.state('fake'), connected)
    const disposed = store.run('fake', { op: 'disconnect', id: 'fake' })
    store.dispose()
    assert.equal((await disposed)?.phase, 'error')
  } finally { store.dispose() }
})

test('repos: equal payloads retain snapshot identity', async () => {
  const store = new ReposStore(async () => [])
  await store.load()
  const first = store.getSnapshot()
  await store.load()
  assert.equal(store.getSnapshot(), first)
})
