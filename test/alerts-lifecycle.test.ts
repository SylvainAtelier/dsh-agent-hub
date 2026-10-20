import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlertsService, serializeRecord, sheetPath } from '../src/alerts/index.ts'
import type { SentryIssues } from '../src/connectors/sentry.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'alerts-lifecycle-'))
  const events: string[] = []
  const gates: Array<{ name: string; entered: ReturnType<typeof deferred>; done: ReturnType<typeof deferred> }> = []
  const pause = (name: string) => {
    const gate = { name, entered: deferred(), done: deferred() }
    gates.push(gate)
    return gate
  }
  const visit = async (name: string) => {
    events.push(name)
    const gate = gates.find((item) => item.name === name)
    if (gate) {
      gate.name = ''
      gate.entered.resolve()
      await gate.done.promise
    }
  }
  const issue = (id: string) => ({ id, title: 'Failure', lastSeen: '2026-10-14T00:00:00Z', events: 1 })
  let nextSession = 0
  const service = new AlertsService({
    settings: () => ({ url: 'https://acme.sentry.io/issues/', repo, bot: 'reviewer' }),
    bots: () => [{ id: 'reviewer', provider: '', model: '', persona: '', tools: [] }],
    sentry: () => ({
      cached: async (id: string) => { await visit(`cached:${id}`); return issue(id) },
      list: async () => { await visit('list'); return { issues: [issue('APP-1')], truncated: false } },
      detail: async (value: { id: string }) => { await visit(`detail:${value.id}`); return { ...issue(value.id), markdown: 'Evidence' } },
      resolve: async () => { await visit('resolve') },
    } as unknown as SentryIssues),
    sessions: () => ({
      start: async () => { await visit('session:start'); return `s${++nextSession}` },
      send: async () => { await visit('session:send') },
      cancel: async () => {}, archive: async () => {},
    }),
    trees: {
      list: async () => { await visit('tree:list'); return [] },
      open: async () => { await visit('tree:open'); return { path: repo } },
      add: async () => { await visit('tree:add'); return { path: repo } },
    },
    git: async (args) => {
      await visit(`git:${args[0]}`)
      const stdout = args[0] === 'remote' ? 'origin\n' : args[0] === 'symbolic-ref' ? 'origin/main\n' : args[0] === 'rev-list' ? '0\n' : ''
      return { code: 0, stdout, stderr: '' }
    },
    log: (value) => { events.push(`log:${value}`) },
  })
  t.after(async () => {
    service.dispose()
    for (const gate of gates) gate.done.resolve()
    await service.settled()
    rmSync(repo, { recursive: true, force: true })
  })
  const record = (phase: 'analysed' | 'analysing' | 'fixing' = 'analysed') => {
    mkdirSync(join(repo, '.reviews'), { recursive: true })
    writeFileSync(sheetPath(repo, 'APP-1'), serializeRecord({
      issue: 'APP-1', phase, tree: repo, branch: 'fix/app-1', session: 's1',
      generated: true, base: 'origin/main', body: 'Keep this record.',
    }))
  }
  return { service, repo, events, pause, record }
}

test('dispose is idempotent, releases held slots and rejects queued analyses without starting them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clearTimer = t.mock.method(globalThis, 'clearTimeout')
  const { service, repo, events } = fixture(t)
  await service.analyse('APP-1')
  await service.analyse('APP-2')
  await service.settled()
  await service.analyse('APP-3')
  const queued = readFileSync(sheetPath(repo, 'APP-3'), 'utf8')
  assert.equal(events.filter((event) => event === 'session:send').length, 2)
  assert.equal(service.sessionMode('s1'), 'analysis')
  const clearedBefore = clearTimer.mock.callCount()
  service.dispose()
  assert.equal(clearTimer.mock.callCount(), clearedBefore + 2)
  service.dispose()
  assert.equal(clearTimer.mock.callCount(), clearedBefore + 2)
  await service.settled()
  t.mock.timers.tick(31 * 60_000)
  await service.status('s1', false)
  assert.equal(events.filter((event) => event === 'tree:list').length, 2)
  assert.equal(service.sessionMode('s1'), undefined)
  assert.equal(readFileSync(sheetPath(repo, 'APP-3'), 'utf8'), queued)
  assert.equal(events.some((event) => event.startsWith('log:')), false)
  await assert.rejects(service.analyse('APP-4'), /disposed/)
  await assert.rejects(service.fix('APP-1'), /disposed/)
  await assert.rejects(service.resolve('APP-1', true), /disposed/)
})

for (const [boundary, forbidden] of [
  ['cached:APP-1', 'tree:list'],
  ['tree:list', 'git:remote'],
  ['git:remote', 'git:fetch'],
  ['git:fetch', 'tree:add'],
  ['git:symbolic-ref', 'tree:add'],
  ['tree:add', 'session:start'],
  ['detail:APP-1', 'session:start'],
  ['session:start', 'session:send'],
] as const) {
  test(`dispose during ${boundary} prevents ${forbidden} and preserves the preparing record`, async (t) => {
    const { service, repo, events, pause } = fixture(t)
    const gate = pause(boundary)
    // Attach a rejection handler before disposal can reject an early validation await.
    const analysis = service.analyse('APP-1').catch((error: unknown) => {
      assert.match(String(error), /disposed/)
    })
    await gate.entered.promise
    service.dispose()
    gate.done.resolve()
    await analysis
    await service.settled()
    assert.equal(events.includes(forbidden), false)
    if (boundary !== 'cached:APP-1') assert.match(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'), /phase: preparing/)
    assert.equal(events.some((event) => event.startsWith('log:')), false)
  })
}

test('a detached detail rejection after dispose is handled while tree preparation finishes', async (t) => {
  const { service, events, pause } = fixture(t)
  const detail = pause('detail:APP-1')
  const tree = pause('tree:list')
  await service.analyse('APP-1')
  await Promise.all([detail.entered.promise, tree.entered.promise])
  service.dispose()
  detail.done.reject(new Error('late detail failure'))
  tree.done.resolve()
  await service.settled()
  assert.equal(events.includes('git:fetch'), false)
})

test('a late session send rejection after dispose does not restart queued work', async (t) => {
  const { service, events, pause } = fixture(t)
  const sending = pause('session:send')
  await service.analyse('APP-1')
  await sending.entered.promise
  await service.analyse('APP-2')
  await service.analyse('APP-3')
  service.dispose()
  sending.done.reject(new Error('late send failure'))
  await service.settled()
  assert.equal(events.filter((event) => event === 'tree:list').length, 2)
  assert.equal(events.some((event) => event.startsWith('log:')), false)
})

test('dispose clears delayed cleanup and does not delete a resolved issue worktree', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clearTimer = t.mock.method(globalThis, 'clearTimeout')
  const { service, events, record } = fixture(t)
  record()
  await service.resolve('APP-1', true)
  const clearedBefore = clearTimer.mock.callCount()
  service.dispose()
  assert.equal(clearTimer.mock.callCount(), clearedBefore + 1)
  t.mock.timers.tick(10_000)
  await service.settled()
  assert.deepEqual(events, ['resolve'])
})

test('dispose while resolving does not schedule cleanup after the connector completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { service, events, pause, record } = fixture(t)
  record()
  const gate = pause('resolve')
  const resolving = assert.rejects(service.resolve('APP-1', true), /disposed/)
  await gate.entered.promise
  service.dispose()
  gate.done.resolve()
  await resolving
  t.mock.timers.tick(10_000)
  assert.deepEqual(events, ['resolve'])
})

for (const [boundary, forbidden] of [
  ['git:status', 'git:rev-list'],
  ['git:rev-list', 'git:worktree'],
  ['git:worktree', 'git:branch'],
] as const) {
  test(`dispose during cleanup ${boundary} prevents ${forbidden}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { service, events, pause, record } = fixture(t)
    record()
    const gate = pause(boundary)
    await service.resolve('APP-1', true)
    t.mock.timers.tick(10_000)
    await gate.entered.promise
    service.dispose()
    gate.done.resolve()
    // Flush the cleanup chain, including its detached rejection handler.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(events.includes(forbidden), false)
    assert.equal(events.some((event) => event.startsWith('log:')), false)
  })
}

test('dispose during fix lookup prevents the fix message and record rewrite', async (t) => {
  const { service, repo, events, pause, record } = fixture(t)
  record()
  const before = readFileSync(sheetPath(repo, 'APP-1'), 'utf8')
  const gate = pause('cached:APP-1')
  const fixing = assert.rejects(service.fix('APP-1'), /disposed/)
  await gate.entered.promise
  service.dispose()
  gate.done.resolve()
  await fixing
  assert.equal(events.includes('session:send'), false)
  assert.equal(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'), before)
})

test('dispose during turn status prevents record updates', async (t) => {
  const { service, repo, events, pause, record } = fixture(t)
  record('fixing')
  await service.warm()
  const before = readFileSync(sheetPath(repo, 'APP-1'), 'utf8')
  const gate = pause('git:rev-parse')
  const status = assert.rejects(service.status('s1', false), /disposed/)
  await gate.entered.promise
  service.dispose()
  gate.done.resolve()
  await status
  assert.equal(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'), before)
  assert.equal(events.filter((event) => event.startsWith('git:')).length, 1)
})
