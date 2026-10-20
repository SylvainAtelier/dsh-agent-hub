import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { completeFrames, createTokenLedger, dayOf, emptyEntry, fold, foldText, metered, scanLog, totals, type Entry } from '../src/usage/tokens.ts'
import { firstDay, hitRate, percent, summarize } from '../src/client/usage/tokens.ts'
import type { TokenUsage } from '../src/usage/types.ts'

const T = new Date(2026, 9, 9, 12).getTime()
const DAY = dayOf(T)

const header = (isSeeded = false) => ({ type: 'session', version: 4, id: 's', createdAt: T, isSeeded })
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite })
const reply = (provider: string, model: string, counts: ReturnType<typeof usage>, replayState?: unknown, time = T) => ({
  type: 'assistant/message',
  time,
  data: { message: { role: 'assistant', content: [], source: { kind: 'model', provider, model, ...(replayState === undefined ? {} : { replayState }) } }, usage: counts },
})
const claude = (total: Record<string, [number, number, number, number]>) => ({
  claude: { session: 'c', total: Object.fromEntries(Object.entries(total).map(([model, [input, output, cacheRead, cacheWrite]]) => [model, { input, output, cacheRead, cacheWrite }])) },
})
const frame = (...events: unknown[]): Buffer => zstdCompressSync(Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join('')))

function rows(entry: Entry): Record<string, number[]> {
  return Object.fromEntries(Object.entries(entry.rows).map(([key, tuple]) => [key.split('\t').slice(1).join('/'), tuple]))
}

test('tokens: frames are found one by one, a torn tail and skippable frames are passed over', () => {
  const a = frame(header())
  const b = frame(reply('p', 'm', usage(1, 2)))
  const skippable = Buffer.alloc(12)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(4, 4)
  const whole = Buffer.concat([a, skippable, b])
  assert.deepEqual(completeFrames(whole), [[0, a.length], [a.length + 12, whole.length]])
  assert.deepEqual(completeFrames(whole.subarray(0, whole.length - 1)), [[0, a.length]])
  assert.deepEqual(completeFrames(Buffer.from('not zstd')), [])
})

test('tokens: replies count under their route; usage without a route goes to the one in use', () => {
  const entry = emptyEntry()
  fold(entry, header())
  fold(entry, { type: 'model/selection', time: T, data: { provider: 'minimax-cn', model: 'M3' } })
  fold(entry, reply('openai-codex', 'luna', usage(10, 2, 100)))
  fold(entry, { type: 'compaction/summary', time: T, data: { usage: usage(5, 1, 0, 3) } })
  assert.deepEqual(rows(entry), { 'openai-codex/luna': [15, 3, 100, 3] })
  assert.equal(entry.since, T)
})

test('tokens: a seeded log skips the inherited prefix', () => {
  const entry = emptyEntry()
  fold(entry, header(true))
  fold(entry, reply('p', 'm', usage(100, 100)))
  fold(entry, { type: 'session/end-seed', time: T, data: { inherited: true } })
  fold(entry, reply('p', 'm', usage(1, 1)))
  assert.deepEqual(rows(entry), { 'p/m': [1, 1, 0, 0] })
})

test('tokens: Claude Agent replies count the difference between cumulative totals, per model', () => {
  const entry = emptyEntry()
  fold(entry, header())
  fold(entry, reply('claude-agent', 'opus', usage(2, 50, 900), claude({ 'claude-opus-5-5': [10, 50, 3000, 200] })))
  fold(entry, reply('claude-agent', 'opus', usage(2, 70, 950), claude({ 'claude-opus-5-5': [15, 120, 9000, 300], 'claude-haiku-5': [40, 5, 0, 0] })))
  assert.deepEqual(rows(entry), { 'claude-agent/claude-opus-5-5': [15, 120, 9000, 300], 'claude-agent/claude-haiku-5': [40, 5, 0, 0] })
  // A total that went down was reset (/clear): it counts whole.
  fold(entry, reply('claude-agent', 'opus', usage(1, 1), claude({ 'claude-opus-5-5': [1, 2, 3, 4] })))
  assert.deepEqual(rows(entry)['claude-agent/claude-opus-5-5'], [16, 122, 9003, 304])
})

test('tokens: Claude replies from before totals were stamped count as reported; the first total is a baseline', () => {
  const entry = emptyEntry()
  fold(entry, reply('claude-agent', 'opus', usage(2, 50, 900), { claude: { session: 'c' } }))
  fold(entry, reply('claude-agent', 'opus', usage(2, 70, 950), claude({ 'claude-opus-5-5': [500, 500, 50000, 900] })))
  fold(entry, reply('claude-agent', 'opus', usage(2, 70, 950), claude({ 'claude-opus-5-5': [510, 520, 51000, 900] })))
  assert.deepEqual(rows(entry), { 'claude-agent/opus': [2, 50, 900, 0], 'claude-agent/claude-opus-5-5': [10, 20, 1000, 0] })
})

test('tokens: a forked log takes its Claude baseline from the inherited prefix', () => {
  const entry = emptyEntry()
  fold(entry, header(true))
  fold(entry, reply('claude-agent', 'opus', usage(1, 1), claude({ o: [100, 100, 100, 100] })))
  fold(entry, { type: 'session/end-seed', time: T, data: { inherited: true } })
  fold(entry, reply('claude-agent', 'opus', usage(1, 1), claude({ o: [101, 102, 103, 104] })))
  assert.deepEqual(rows(entry), { 'claude-agent/o': [1, 2, 3, 4] })
})

test('tokens: lines that span frames and malformed lines', () => {
  const entry = emptyEntry()
  const line = JSON.stringify(reply('p', 'm', usage(3, 4)))
  foldText(entry, `${JSON.stringify(header())}\n${line.slice(0, 20)}`)
  foldText(entry, `${line.slice(20)}\n{"usage": broken\n`)
  assert.deepEqual(rows(entry), { 'p/m': [3, 4, 0, 0] })
  assert.equal(entry.rest, '')
})

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-hub-tokens-'))
}

test('tokens: a log is read incrementally, and from the start again once it shrinks or moves', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(file, frame(header(), reply('p', 'm', usage(1, 1))))
    let entry = await scanLog(file, undefined)
    assert.deepEqual(rows(entry), { 'p/m': [1, 1, 0, 0] })
    await appendFile(file, frame(reply('p', 'm', usage(2, 2))))
    entry = await scanLog(file, entry)
    assert.deepEqual(rows(entry), { 'p/m': [3, 3, 0, 0] })
    // Unchanged: nothing is added twice.
    entry = await scanLog(file, entry)
    assert.deepEqual(rows(entry), { 'p/m': [3, 3, 0, 0] })
    // A torn tail waits for the rest of its frame.
    const next = frame(reply('p', 'm', usage(5, 5)))
    await appendFile(file, next.subarray(0, 6))
    entry = await scanLog(file, entry)
    assert.deepEqual(rows(entry), { 'p/m': [3, 3, 0, 0] })
    await appendFile(file, next.subarray(6))
    entry = await scanLog(file, entry)
    assert.deepEqual(rows(entry), { 'p/m': [8, 8, 0, 0] })
    // Shrunk (repaired): the whole log again, not on top.
    await writeFile(file, frame(header(), reply('p', 'm', usage(1, 1))))
    entry = await scanLog(file, entry)
    assert.deepEqual(rows(entry), { 'p/m': [1, 1, 0, 0] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tokens: the ledger keeps a deleted session, folding its last lines before the deletion', async () => {
  const dir = await tempDir()
  try {
    const root = join(dir, 'sessions')
    const ledgerFile = join(dir, 'tokens.json')
    const live = join(root, '--proj--', 'session-a')
    const sub = join(root, '--proj--', '0b1c')
    await mkdir(live, { recursive: true })
    await mkdir(sub, { recursive: true })
    await writeFile(join(live, 'session.v4.jsonl.zstd'), frame(header(), reply('p', 'm', usage(1, 0))))
    await writeFile(join(sub, 'session.v4.jsonl.zstd'), frame(header(), reply('p', 'n', usage(0, 1))))
    let now = T
    const ledger = createTokenLedger({ root, file: ledgerFile, names: () => ({ p: 'Provider' }), now: () => now })
    let read = await ledger.read()
    assert.deepEqual(read.rows.map((row) => [row.model, row.input, row.output]).sort(), [['m', 1, 0], ['n', 0, 1]])
    assert.equal(read.providers.p, 'Provider')
    assert.equal(read.today, DAY)

    // A last turn lands, then DSH deletes the session before any poll saw it.
    await appendFile(join(live, 'session.v4.jsonl.zstd'), frame(reply('p', 'm', usage(4, 0))))
    await ledger.capture('session-a')
    await rm(live, { recursive: true })
    now += 10_000
    read = await ledger.read()
    assert.deepEqual(read.rows.map((row) => [row.model, row.input, row.output]).sort(), [['m', 5, 0], ['n', 0, 1]])

    // Persisted: a new ledger (DSH restarted) still has it.
    const again = createTokenLedger({ root, file: ledgerFile, names: () => ({}), now: () => now })
    read = await again.read()
    assert.deepEqual(read.rows.map((row) => [row.model, row.input, row.output]).sort(), [['m', 5, 0], ['n', 0, 1]])

    // Truncating a live log never double counts: its numbers follow its content.
    await truncate(join(sub, 'session.v4.jsonl.zstd'), 0)
    await writeFile(join(sub, 'session.v4.jsonl.zstd'), frame(header(), reply('p', 'n', usage(0, 7))))
    now += 10_000
    read = await again.read()
    assert.deepEqual(read.rows.map((row) => [row.model, row.input, row.output]).sort(), [['m', 5, 0], ['n', 0, 7]])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tokens: Claude Agent compaction is left to the model that answered it', () => {
  const entry = emptyEntry()
  fold(entry, header())
  fold(entry, reply('claude-agent', 'opus', usage(1, 1)))
  fold(entry, { type: 'compaction/summary', time: T, data: { provider: 'claude-agent', model: 'opus', usage: usage(500, 50) } })
  assert.deepEqual(rows(entry), { 'claude-agent/opus': [1, 1, 0, 0] })
})

test('tokens: calls no log records are metered as they stream and persisted', async () => {
  const dir = await tempDir()
  try {
    const root = join(dir, 'sessions')
    const ledgerFile = join(dir, 'tokens.json')
    await mkdir(root, { recursive: true })
    const ledger = createTokenLedger({ root, file: ledgerFile, names: () => ({}), now: () => T })
    async function* stream() {
      yield { type: 'text-delta', text: 'feat: x' }
      yield { type: 'usage', usage: usage(30, 4, 100) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const pending: Promise<void>[] = []
    const seen: string[] = []
    for await (const chunk of metered(stream(), (counts) => { pending.push(ledger.record('minimax-cn', 'M3', counts)) })) seen.push(chunk.type)
    await Promise.all(pending)
    assert.deepEqual(seen, ['text-delta', 'usage', 'finish'])
    const expected = [{ day: DAY, provider: 'minimax-cn', model: 'M3', input: 30, output: 4, cacheRead: 100, cacheWrite: 0 }]
    assert.deepEqual((await ledger.read(true)).rows, expected)
    // A scan with no logs keeps it, and so does a restart.
    const again = createTokenLedger({ root, file: ledgerFile, names: () => ({}), now: () => T })
    assert.deepEqual((await again.read()).rows, expected)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tokens: accounting migration rebuilds live bot logs without losing deleted-session totals', async () => {
  const dir = await tempDir()
  try {
    const root = join(dir, 'sessions')
    const live = join(root, '--proj--', 'live')
    const log = join(live, 'session.v4.jsonl.zstd')
    const file = join(dir, 'tokens.json')
    await mkdir(live, { recursive: true })
    const bytes = frame(header(), reply('agent-hub-bot', 'coder', usage(7, 3), { via: { provider: 'openai-codex', model: 'm' } }))
    await writeFile(log, bytes)
    const previous = emptyEntry(log)
    previous.size = bytes.length
    previous.rows[`${DAY}\tagent-hub-bot\tcoder`] = [999, 0, 0, 0]
    delete previous.accounting
    const deleted = emptyEntry()
    deleted.rows[`${DAY}\tp\tdeleted`] = [4, 0, 0, 0]
    delete deleted.accounting
    await writeFile(file, JSON.stringify({ version: 1, entries: { live: previous, gone: deleted } }))
    const ledger = createTokenLedger({ root, file, names: () => ({}), now: () => T })
    const result = await ledger.read()
    assert.deepEqual(result.rows.map((row) => [row.provider, row.model, row.input, row.output]).sort(), [
      ['openai-codex', 'm', 7, 3], ['p', 'deleted', 4, 0],
    ])
    assert.deepEqual((await ledger.read()).rows, result.rows, 'migration must not add the log twice')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('tokens: totals add entries up per day, provider and model', () => {
  const a = emptyEntry()
  const b = emptyEntry()
  fold(a, reply('p', 'm', usage(1, 2, 3, 4)))
  fold(b, reply('p', 'm', usage(1, 1, 1, 1), undefined, T - 1000))
  assert.deepEqual(totals([a, b]), { rows: [{ day: DAY, provider: 'p', model: 'm', input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }], since: T - 1000 })
})

test('tokens view: periods count back from the host day', () => {
  assert.equal(firstDay('2026-10-09', 'today'), '2026-10-09')
  assert.equal(firstDay('2026-10-09', '7d'), '2026-10-03')
  assert.equal(firstDay('2026-03-01', '30d'), '2026-01-31')
  assert.equal(firstDay('2026-10-09', 'all'), undefined)
})

test('tokens view: a period sums providers and models, largest first', () => {
  const usage: TokenUsage = {
    today: '2026-10-09',
    providers: { a: 'Alpha' },
    rows: [
      { day: '2026-10-09', provider: 'a', model: 'small', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { day: '2026-10-09', provider: 'a', model: 'big', input: 10, output: 0, cacheRead: 30, cacheWrite: 0 },
      { day: '2026-10-08', provider: 'b', model: 'x', input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
    ],
  }
  const today = summarize(usage, 'today')
  assert.equal(today.total, 42)
  assert.deepEqual(today.providers.map((p) => [p.name, p.total, p.models.map((m) => m.model)]), [['Alpha', 42, ['big', 'small']]])
  const week = summarize(usage, '7d')
  assert.deepEqual(week.providers.map((p) => [p.name, p.total]), [['b', 100], ['Alpha', 42]])
  assert.equal(hitRate(today), 30 / 41)
  assert.equal(hitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 }), undefined)
  assert.equal(percent(1, 1000), '<1')
  assert.equal(percent(0, 10), '0')
  assert.equal(percent(1, 3), '33')
})
