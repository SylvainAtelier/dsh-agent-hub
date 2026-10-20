import { test } from 'node:test'
import { readCodex } from '../src/usage/sources/codex.ts'
import { parseRemains, readMinimax } from '../src/usage/sources/minimax.ts'
import { readCursor } from '../src/usage/sources/cursor.ts'
import assert from 'node:assert/strict'
import { createScheduledSend, scheduleTitle, type ScheduleHost } from '../src/schedule/index.ts'
import { effectiveRoute, resetSuggestion } from '../src/schedule/reset.ts'
import type { PlanQuota, QuotaWindow } from '../src/usage/types.ts'
import type { ScheduledSend, ScheduleOptions, ScheduleReply, ScheduleRequest } from '../src/schedule/types.ts'
import { clearSubmittedDraft, draftIssue, localFields, localInstant, type InputSnapshot } from '../src/client/schedule/draft.ts'
import { createPendingHub, decodeTasks, relativeParts, type ScheduleRemote } from '../src/client/schedule/pending.ts'

const NOW = Date.parse('2026-10-15T16:00:00.000Z')
const HOUR = 3600_000
const route = { provider: 'claude-agent', model: 'claude-sonnet-4-5' }
const window = (usedPercent = 100, reset = NOW + HOUR): QuotaWindow => ({ key: '5h', usedPercent, resetsAt: reset })
const quota = (windows = [window()]): PlanQuota => ({ id: 'claude', provider: 'claude', active: true, fetchedAt: NOW, windows })

test('schedule reset: recovery waits for all blocking windows, otherwise suggests the nearest reset', () => {
  const result = resetSuggestion(route, [quota([window(), { ...window(100, NOW + 24 * HOUR), key: 'week' }])], NOW)
  assert.equal(result.suggestion?.at, new Date(NOW + 24 * HOUR + 60_000).toISOString())
  assert.equal(result.suggestion?.kind, 'recovery')
  assert.deepEqual(result.suggestion?.windows, ['week'])
  const available = resetSuggestion(route, [quota([window(20), window(30, NOW + 24 * HOUR)])], NOW)
  assert.equal(available.suggestion?.at, new Date(NOW + HOUR + 60_000).toISOString())
  assert.equal(available.suggestion?.kind, 'reset')
})

test('schedule reset: actual route and active account, not model name or arbitrary account', () => {
  assert.equal(resetSuggestion({ ...route, provider: 'anthropic' }, [quota()], NOW).reason, 'unsupported-route')
  assert.equal(resetSuggestion(route, [{ ...quota(), active: false }], NOW).reason, 'no-account')
  assert.equal(resetSuggestion(route, [quota(), { ...quota(), id: 'claude:other' }], NOW).reason, 'no-account')
  assert.equal(resetSuggestion({ provider: 'openai-codex', model: 'gpt-6' }, [{ ...quota(), id: 'codex:a', provider: 'codex' }], NOW).suggestion?.quotaId, 'codex:a')
  for (const [provider, id] of [['minimax-cn', 'minimax'], ['minimax', 'minimax:minimax']] as const) {
    assert.equal(resetSuggestion({ provider, model: 'm2' }, [{ ...quota(), provider: 'minimax', id }], NOW).suggestion?.quotaId, id)
  }
})

test('schedule reset: only known model-specific windows participate; code review never blocks chat', () => {
  const base = quota([window(20), { ...window(100, NOW + 24 * HOUR), group: 'Opus' }])
  assert.equal(resetSuggestion(route, [base], NOW).suggestion?.kind, 'reset')
  assert.equal(resetSuggestion({ ...route, model: 'opus' }, [base], NOW).suggestion?.kind, 'recovery')
  const codex = { ...quota([window(), { ...window(100, NOW + 24 * HOUR), group: 'Code review' }]), provider: 'codex' as const }
  assert.equal(resetSuggestion({ provider: 'openai-codex', model: 'gpt-6' }, [codex], NOW).suggestion?.at, new Date(NOW + HOUR + 60_000).toISOString())
  assert.equal(resetSuggestion(route, [quota([window(), { ...window(10), group: 'Unknown pool' }])], NOW).reason, 'unknown-window')
  assert.equal(resetSuggestion({ ...route, model: 'default' }, [base], NOW).reason, 'unknown-window')
})

test('schedule reset: stale, expired, unknown and past reset values never become promises of recovery', () => {
  for (const bad of [{ ...quota(), stale: true }, { ...quota(), fetchedAt: NOW - 7 * 60_000 }, { ...quota(), error: { code: 'failed' as const } }]) {
    assert.equal(resetSuggestion(route, [bad], NOW).reason, 'stale')
  }
  assert.equal(resetSuggestion(route, [{ ...quota(), expiresAt: NOW + 500 }], NOW).reason, 'expired-plan')
  for (const resetsAt of [undefined, NaN, NOW - 1]) {
    assert.equal(resetSuggestion(route, [quota([{ ...window(), resetsAt }])], NOW).reason, 'no-reset')
  }
  assert.equal(resetSuggestion(route, [quota([{ ...window(), usedPercent: NaN }])], NOW).reason, 'unknown-window')
  assert.equal(resetSuggestion(route, [quota([])], NOW).reason, 'no-reset')
})

test('schedule reset: bots resolve their underlying route without cycles or model-name guesses', () => {
  assert.deepEqual(effectiveRoute({ provider: 'agent-hub-bot', model: 'reviewer' }, [{ id: 'reviewer', ...route }]), route)
  assert.deepEqual(effectiveRoute({ provider: 'agent-hub-bot', model: 'reviewer' }, [{ id: 'reviewer' }], route), route)
  assert.equal(effectiveRoute({ provider: 'agent-hub-bot', model: 'a' }, [{ id: 'a', provider: 'agent-hub-bot', model: 'a' }]), undefined)
  assert.equal(effectiveRoute({ provider: 'agent-hub-bot', model: 'removed' }, []), undefined)
  assert.equal(effectiveRoute({ provider: 'agent-hub-bot', model: 'a' }, [{ id: 'a', provider: 'agent-hub-bot', model: 'b' }, { id: 'b', ...route }]), undefined)
})

test('schedule Codex source: read only the selected account and detect an account switch during I/O', async () => {
  let activeId = 'a'
  let calls = 0
  const original = globalThis.fetch
  const credentials = {
    async readRecord() { return { kind: 'grant', payload: { version: 1, activeId, accounts: ['a', 'b'].map((id) => ({ id, credential: { access: `test-access-${id}`, expires: NOW + HOUR } })) } } },
    async resolve() { return undefined },
  }
  globalThis.fetch = async () => {
    calls++
    activeId = 'b'
    return Response.json({ rate_limit: { primary_window: { used_percent: 100, reset_at: (NOW + HOUR) / 1000 } } })
  }
  try {
    const result = await readCodex(credentials, 'test-vault', () => NOW, true)
    assert.equal(calls, 1)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'codex:a')
    assert.equal(result[0].active, false)
  } finally { globalThis.fetch = original }
})

function fixture(changes: Partial<ScheduleHost> = {}) {
  const created: Array<{ sessionId: string; request: { title: string; prompt: string; at: string } }> = []
  const host: ScheduleHost = {
    schedule: () => ({ async create(sessionId, request) { created.push({ sessionId, request }); return { id: 'schedule-1', title: request.title, scheduledAt: request.at } } }),
    selection: async () => route, overview: async () => ({ quotas: [quota()], at: NOW }),
    profiles: () => [], defaultRoute: () => route, now: () => NOW, ...changes,
  }
  const handle = createScheduledSend(host)
  const request = { op: 'create', sessionId: 's1', requestId: 'request-1234', prompt: '  Fix tests\nThen run regression.  ', at: new Date(NOW + HOUR).toISOString(), expectedRoute: route, expectedEffectiveRoute: route }
  return { handle, created, request }
}

test('schedule host: creates a native at task with a deterministic title and no prompt execution', async () => {
  const { handle, created, request } = fixture()
  const result = await handle(request)
  assert.deepEqual(result, { ok: true, value: { id: 'schedule-1', sessionId: 's1', title: 'Fix tests', scheduledAt: request.at } })
  assert.deepEqual(created, [{ sessionId: 's1', request: { title: 'Fix tests', prompt: 'Fix tests\nThen run regression.', at: request.at } }])
  assert.equal(scheduleTitle('x'.repeat(200)).length, 120)
})

test('schedule host: native capability missing, archived/deleted session, malformed input and past targets', async () => {
  const absent = fixture({ schedule: () => undefined })
  assert.deepEqual(await absent.handle({ op: 'options', sessionId: 's1' }), { ok: true, value: { available: false } })
  assert.deepEqual(await absent.handle(absent.request), { ok: false, code: 'unavailable' })
  const invalid = fixture({ selection: async () => { throw new Error('Session is archived') } })
  assert.deepEqual(await invalid.handle(invalid.request), { ok: false, code: 'session-unavailable' })
  const { handle, created, request } = fixture()
  for (const patch of [{ prompt: '  ' }, { prompt: '/goal test' }, { at: 'later' }, { at: '2027-02-30T12:00:00.000Z' }, { sessionId: '' }, { requestId: '' }, { suggestion: { windows: 'bad' } }]) {
    assert.deepEqual(await handle({ ...request, ...patch }), { ok: false, code: 'invalid-request' })
  }
  assert.deepEqual(await handle({ ...request, at: new Date(NOW).toISOString() }), { ok: false, code: 'not-future' })
  assert.equal(created.length, 0)
})

test('schedule host: quota reads failing still allow custom time; a reset hint is revalidated', async () => {
  const offline = fixture({ overview: async () => { throw new Error('offline') } })
  const options = await offline.handle({ op: 'options', sessionId: 's1' })
  assert.deepEqual(options, { ok: true, value: { available: true, route, effectiveRoute: route, reason: 'stale' } })
  assert.equal((await offline.handle(offline.request)).ok, true)
  const { handle, created, request } = fixture()
  const value = (await handle({ op: 'options', sessionId: 's1' }) as { ok: true; value: ScheduleOptions }).value
  assert.equal((await handle({ ...request, at: value.suggestion!.at, suggestion: value.suggestion })).ok, true)
  assert.equal(created.length, 1)
})

test('schedule host: changed account, model or reset requires confirmation and creates nothing', async () => {
  let currentQuota = quota()
  let currentRoute = route
  const { handle, created, request } = fixture({ selection: async () => currentRoute, overview: async () => ({ quotas: [currentQuota], at: NOW }) })
  const value = (await handle({ op: 'options', sessionId: 's1' }) as { ok: true; value: ScheduleOptions }).value
  currentQuota = { ...quota(), id: 'claude:another' }
  assert.deepEqual(await handle({ ...request, at: value.suggestion!.at, suggestion: value.suggestion }), { ok: false, code: 'changed' })
  currentRoute = { ...route, model: 'opus' }
  assert.deepEqual(await handle({ ...request, requestId: 'another-request' }), { ok: false, code: 'changed' })
  assert.equal(created.length, 0)
})

test('schedule host: duplicate requests share the native write; reusing the id for different content fails', async () => {
  const { handle, created, request } = fixture()
  const [a, b] = await Promise.all([handle(request), handle(request)])
  assert.deepEqual(a, b)
  assert.equal(created.length, 1)
  assert.deepEqual(await handle({ ...request, prompt: 'different' }), { ok: false, code: 'invalid-request' })
  assert.deepEqual(await handle(request), a)
  assert.equal(created.length, 1)
})

test('schedule host: an uncertain native write is not automatically retried', async () => {
  let calls = 0
  const { handle, request } = fixture({ schedule: () => ({ create: async () => { calls++; throw new Error('write outcome unknown') } }) })
  assert.deepEqual(await handle(request), { ok: false, code: 'create-uncertain' })
  assert.deepEqual(await handle(request), { ok: false, code: 'create-uncertain' })
  assert.equal(calls, 1)
})

test('schedule host: custom capability never waits for a quota read', async () => {
  let reads = 0
  const { handle } = fixture({ overview: async () => { reads++; return new Promise(() => {}) } })
  const result = await handle({ op: 'options', sessionId: 's1', quota: false })
  assert.deepEqual(result, { ok: true, value: { available: true, route, effectiveRoute: route } })
  assert.equal(reads, 0)
})

test('schedule host: model/archival changes while a quota read is pending prevent native creation', async () => {
  for (const archived of [false, true]) {
    let changed = false
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { handle, created, request } = fixture({
      selection: async () => { if (changed && archived) throw new Error('archived'); return changed ? { ...route, model: 'opus' } : route },
      overview: async () => { entered(); await gate; return { quotas: [quota()], at: NOW } },
    })
    const suggestion = resetSuggestion(route, [quota()], NOW).suggestion!
    const pending = handle({ ...request, at: suggestion.at, suggestion })
    await enteredPromise
    changed = true
    release()
    assert.deepEqual(await pending, { ok: false, code: archived ? 'session-unavailable' : 'changed' })
    assert.equal(created.length, 0)
  }
})

test('schedule host: editing a bot underlying model requires a new confirmation', async () => {
  let botRoute = route
  const bot = { provider: 'agent-hub-bot', model: 'reviewer' }
  const { handle, created, request } = fixture({ selection: async () => bot, profiles: () => [{ id: 'reviewer', ...botRoute }] })
  const before = (await handle({ op: 'options', sessionId: 's1' }) as { ok: true; value: ScheduleOptions }).value
  botRoute = { ...route, model: 'opus' }
  assert.deepEqual(await handle({ ...request, expectedRoute: bot, expectedEffectiveRoute: before.effectiveRoute, at: before.suggestion!.at, suggestion: before.suggestion }), { ok: false, code: 'changed' })
  assert.equal(created.length, 0)
})

test('schedule sources: MiniMax selects the model pool and marks credential switches stale', async () => {
  const body = { model_remains: ['m1', 'm2'].map((model_name, index) => ({ model_name, current_interval_total_count: 100, current_interval_usage_count: index, end_time: NOW + HOUR })) }
  assert.equal(parseRemains(body, NOW, 'm2').windows[0].used, 99)
  assert.throws(() => parseRemains(body, NOW, 'unknown'), /no plan/)
  let key = 'test-key-a'
  const original = globalThis.fetch
  globalThis.fetch = async () => { key = 'test-key-b'; return Response.json(body) }
  try {
    const result = await readMinimax({ readRecord: async () => ({ kind: 'api-key', key }), resolve: async () => undefined }, {
      credentialKey: () => 'test-key', credentialRef: () => 'test-env',
    }, () => NOW, 'minimax-cn', 'm2')
    assert.equal(result[0].stale, true)
    assert.match(result[0].identity!, /^[a-f0-9]{64}$/)
    assert.ok(!JSON.stringify(result).includes('test-key-a'))
  } finally { globalThis.fetch = original }
})

test('schedule sources: Cursor detects credential changes without exposing tokens', async () => {
  let reads = 0
  const call = async () => ({ planUsage: { limit: 100, totalPercentUsed: 100 }, billingCycleEnd: NOW + HOUR })
  const result = await readCursor(call, () => true, async () => ++reads === 1 ? 'test-cursor-a' : 'test-cursor-b', true)
  assert.equal(result[0].stale, true)
  assert.match(result[0].identity!, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(result).includes('test-cursor-a'))
})

test('schedule host: a changed opaque account binding invalidates an otherwise identical preset', async () => {
  let identity = 'account-a'
  const { handle, request, created } = fixture({ overview: async () => ({ quotas: [{ ...quota(), identity }], at: NOW }) })
  const before = (await handle({ op: 'options', sessionId: 's1' }) as { ok: true; value: ScheduleOptions }).value
  identity = 'account-b'
  assert.deepEqual(await handle({ ...request, at: before.suggestion!.at, suggestion: before.suggestion }), { ok: false, code: 'changed' })
  assert.equal(created.length, 0)
})

test('schedule host: reconciling a timed-out attempt waits for the original native write, never duplicates it', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let writes = 0
  const { handle, request } = fixture({ schedule: () => ({ async create(_id, value) { writes++; entered(); await gate; return { id: 'native-once', title: value.title, scheduledAt: value.at } } }) })
  const pending = handle(request)
  await started
  const reconciled = handle({ op: 'result', sessionId: request.sessionId, requestId: request.requestId })
  assert.equal(writes, 1)
  release()
  assert.deepEqual(await reconciled, await pending)
  assert.equal(writes, 1)
  assert.deepEqual(await handle({ op: 'result', sessionId: 's1', requestId: 'missing' }), { ok: false, code: 'request-missing' })
})

const input: InputSnapshot = { draft: 'Fix tests', draftRev: 7, attachmentIds: [], occurrences: [], phase: 'plain' }
test('schedule draft: reject commands, references and attachments instead of silently dropping them', () => {
  assert.equal(draftIssue(input), undefined)
  assert.equal(draftIssue({ ...input, attachmentIds: ['image'] }), 'attachments')
  assert.equal(draftIssue({ ...input, occurrences: [{}] }), 'references')
  assert.equal(draftIssue({ ...input, draft: ' /goal x' }), 'command')
  assert.equal(draftIssue({ ...input, draft: ' ' }), 'empty')
  assert.equal(draftIssue({ ...input, phase: 'submitting' }), 'busy')
})

test('schedule draft: successful creation never overwrites new text, references or attachments', () => {
  const spans: unknown[] = []
  const actions = { insertText(text: string, span: unknown) { spans.push({ text, span }); return true } }
  for (const current of [undefined, { ...input, draftRev: 8 }, { ...input, draft: 'new' }, { ...input, attachmentIds: ['new'] }, { ...input, occurrences: [{}] }]) {
    assert.equal(clearSubmittedDraft(actions, input, current), false)
  }
  assert.deepEqual(spans, [])
  assert.equal(clearSubmittedDraft(actions, input, input), true)
  assert.deepEqual(spans, [{ text: '', span: { start: 0, end: 9, draftRev: 7 } }])
  assert.equal(clearSubmittedDraft({ insertText: () => false }, input, input), false)
})

test('schedule time: explicit local time rejects invalid dates, DST gaps/overlaps and past instants', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Europe/Paris'
  try {
    assert.deepEqual(localInstant('2026-10-15', '21:30', NOW), { at: '2026-10-15T19:30:00.000Z' })
    assert.deepEqual(localInstant('2026-02-30', '12:00', 0), { error: 'invalid-time' })
    assert.deepEqual(localInstant('2026-03-29', '02:30', 0), { error: 'invalid-time' })
    assert.deepEqual(localInstant('2026-10-25', '02:30', 0), { error: 'ambiguous-time' })
    assert.deepEqual(localInstant('2026-10-15', '10:00', NOW), { error: 'not-future' })
    assert.deepEqual(localInstant('', '', NOW), { error: 'invalid-time' })
    assert.deepEqual(localFields(new Date('2026-10-15T19:30:00Z')), { date: '2026-10-15', time: '21:30' })
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})

test('schedule pending: decode sorts by target, falls back to the first prompt line and drops unusable records', () => {
  const tasks = decodeTasks([
    { id: 'b', title: 'Later', scheduledAt: '2026-10-15T20:00:00.000Z', kind: 'daily' },
    { id: 'a', title: ' ', prompt: 'first line\nsecond', scheduledAt: '2026-10-15T18:00:00.000Z' },
    { id: 'c', title: 'Broken', scheduledAt: 'not a time' }, null, { title: 'no id', scheduledAt: '2026-10-15T18:00:00.000Z' },
  ])
  assert.deepEqual(tasks.map((task) => [task.id, task.title, task.kind]), [['a', 'first line', 'at'], ['b', 'Later', 'daily']])
  assert.deepEqual(decodeTasks({ not: 'a list' }), [])
})

test('schedule pending: relative distance rounds to minutes, hours and days', () => {
  assert.deepEqual(relativeParts(NOW + 10_000, NOW), { unit: 'minute', value: 1 })
  assert.deepEqual(relativeParts(NOW + 59 * 60_000, NOW), { unit: 'minute', value: 59 })
  assert.deepEqual(relativeParts(NOW + 2 * HOUR, NOW), { unit: 'hour', value: 2 })
  assert.deepEqual(relativeParts(NOW + 50 * HOUR, NOW), { unit: 'day', value: 2 })
})

test('schedule pending: one list per Session, refreshed on change and reset; failures keep the last tasks', async () => {
  const changed = new Set<() => void>()
  const resets = new Set<() => void>()
  const calls: string[] = []
  let reply: { ok: true; value: unknown } | { ok: false } = { ok: true, value: [{ id: 'x', title: 'Ping', scheduledAt: '2026-10-15T18:00:00.000Z' }] }
  const remote: ScheduleRemote = {
    schedule: { list: async ({ sessionId }) => { calls.push(sessionId); return reply } },
    $on: (_event, listener) => { changed.add(listener); return () => changed.delete(listener) },
  }
  const hub = createPendingHub()
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  let notified = 0
  const off = hub.subscribe('s1', () => notified++)
  const offSecond = hub.subscribe('s1', () => undefined)
  assert.equal(calls.length, 0, 'nothing is read before the Remote face mounts')
  const detach = hub.attach(remote, (listener) => { resets.add(listener); return () => resets.delete(listener) })
  await flush()
  assert.deepEqual(calls, ['s1'])
  assert.equal(hub.snapshot('s1').tasks[0].title, 'Ping')
  assert.ok(notified > 0)
  reply = { ok: false }
  for (const listener of changed) listener()
  await flush()
  assert.equal(hub.snapshot('s1').tasks.length, 1, 'a failed refresh does not blank the hint')
  reply = { ok: true, value: [] }
  for (const listener of resets) listener()
  await flush()
  assert.equal(hub.snapshot('s1').tasks.length, 0)
  off()
  assert.equal(changed.size, 1, 'the Session stays connected while any subscriber remains')
  offSecond()
  assert.equal(changed.size, 0)
  assert.equal(resets.size, 0)
  hub.subscribe('s2', () => undefined)
  detach()
  assert.equal(changed.size, 0)
  assert.equal(hub.snapshot('s2').ready, false)
})
