import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AlertsService, parseRecord, sheetPath } from '../src/alerts/index.ts'
import { issueMatches, splitTitle, tidyTitle } from '../src/client/alerts/title.ts'
import { AlertsStore } from '../src/client/alerts/api.ts'
import { issuesInPull, type AlertsRequest, type AlertsState } from '../src/alerts/types.ts'
import type { SentryIssues } from '../src/connectors/sentry.ts'
import type { Runner } from '../src/git/service.ts'

test('Sentry analysis creates one fresh-base worktree and reuses its session for fix', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'alerts-'))
  const tree = join(repo, '.worktrees', 'fix-app-1')
  mkdirSync(tree, { recursive: true })
  const commands: string[][] = []
  const sent: Array<{ session: string; text: string }> = []
  const git: Runner = async (args) => {
    commands.push([...args])
    const command = args.join(' ')
    if (command === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' }
    if (command.includes('symbolic-ref')) return { code: 0, stdout: 'origin/main\n', stderr: '' }
    if (command === 'rev-parse HEAD') return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
    if (command.startsWith('rev-list --count')) return { code: 0, stdout: '1\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const issue = { id: 'APP-1', title: 'Checkout failed', lastSeen: '2026-10-14T00:00:00Z', events: 12 }
  const sentry = {
    list: async () => ({ issues: [issue], truncated: false }),
    cached: async () => undefined,
    detail: async () => ({ ...issue, markdown: '**Source**: src/pay.ts:7' }),
    resolve: async () => {},
  } as unknown as SentryIssues
  const service = new AlertsService({
    settings: () => ({ url: 'https://acme.sentry.io/issues/?project=7&environment=prod&statsPeriod=14d', repo, bot: 'reviewer' }),
    sentry: () => sentry,
    bots: () => [{ id: 'reviewer', description: 'review', provider: '', model: '', persona: '', tools: [] }],
    sessions: () => ({
      start: async () => 's1',
      send: async (session, text) => { sent.push({ session, text }) },
      cancel: async () => {}, archive: async () => {},
    }),
    trees: { list: async () => [], add: async (_repo, branch, base) => { assert.equal(base, 'origin/main'); assert.match(branch, /^fix\/app-1-/); return { path: tree, workspaceId: 'w1' } }, open: async () => ({ path: tree, workspaceId: 'w1' }) },
    git,
    log: () => {},
  })
  try {
    await service.analyse('APP-1', 'reviewer')
    await service.settled()
    let record = parseRecord(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'))!
    assert.deepEqual([record.phase, record.session, record.tree, record.generated, record.base], ['analysing', 's1', tree, true, 'origin/main'])
    assert.match(sent[0]!.text, /full access/)
    assert.equal(service.sessionMode('s1'), 'analysis')
    // An idle report before the turn ran is not its end.
    await service.status('s1', false)
    assert.equal(parseRecord(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'))!.phase, 'analysing')
    await service.status('s1', true)
    await service.status('s1', false)
    record = parseRecord(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'))!
    assert.equal(record.phase, 'analysed')
    await service.fix('APP-1')
    assert.equal(service.sessionMode('s1'), 'fix')
    assert.equal(sent[1]!.session, 's1')
    assert.match(sent[1]!.text, /Fixes APP-1/)
    // The board's polling re-reads the records while the fix runs; the turn's state survives it.
    await service.state()
    await service.status('s1', true)
    await service.status('s1', false)
    record = parseRecord(readFileSync(sheetPath(repo, 'APP-1'), 'utf8'))!
    assert.deepEqual([record.phase, record.fixedHead], ['fixed', 'a'.repeat(40)])
    assert.equal(service.sessionMode('s1'), 'analysis')
    assert.ok(commands.some((args) => args[0] === 'fetch'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Alerts mark new events past the list rounding, and keep the lane with a read error', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'alerts-'))
  mkdirSync(join(repo, '.reviews'))
  writeFileSync(sheetPath(repo, 'APP-1'), '---\nissue: "APP-1"\nphase: analysed\nlastSeen: "2026-10-14T08:30:00.000Z"\n---\n\nBody\n')
  writeFileSync(sheetPath(repo, 'APP-2'), '---\nissue: "APP-2"\nphase: analysed\nlastSeen: "2026-10-14T08:30:00.000Z"\n---\n\nBody\n')
  writeFileSync(sheetPath(repo, 'APP-3'), '---\nissue: "APP-3"\nphase: preparing\n---\n\nBody\n')
  let failing = false
  const sentry = {
    list: async () => {
      if (failing) throw new Error('boom')
      return { issues: [
        // "1 hour ago" seen at 09:40: somewhere in 08:40–09:40, after the record.
        { id: 'APP-1', title: 'New', lastSeen: '2026-10-14T08:40:00.000Z', lastSeenSlackMs: 0 },
        // "1 hour ago" seen at 09:00: 08:00–09:00, maybe the recorded event.
        { id: 'APP-2', title: 'Same', lastSeen: '2026-10-14T09:00:00.000Z', lastSeenSlackMs: 3_600_000 },
        { id: 'APP-3', title: 'Stale', lastSeen: '2026-10-14T09:00:00.000Z' },
      ], truncated: false }
    },
  } as unknown as SentryIssues
  const service = new AlertsService({
    settings: () => ({ url: 'https://acme.sentry.io/issues/', repo, bot: 'reviewer' }),
    sentry: () => sentry, bots: () => [], sessions: () => undefined,
    trees: { list: async () => [], add: async () => ({ path: repo }), open: async () => ({ path: repo }) },
    log: () => {},
  })
  try {
    const state = await service.state()
    assert.deepEqual(state.issues.map((issue) => issue.phase), ['regression', 'analysed', 'unanalysed'])
    failing = true
    const broken = await service.state()
    assert.equal(broken.enabled, true)
    assert.match(broken.error ?? '', /boom/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Sentry titles split off their error type and tidy the noise', () => {
  assert.deepEqual(splitTitle('TypeError:  NetworkError when\n fetching'), { kind: 'TypeError', message: 'NetworkError when fetching' })
  assert.deepEqual(splitTitle('Hydration Error'), { message: 'Hydration Error' })
  assert.deepEqual(splitTitle('https://x.io: down'), { message: 'https://x.io: down' })
  assert.equal(tidyTitle('<pipecat.transports.websocket.client.WebsocketClient object at 0x7f4f2d571750> exception while closing:'), '<WebsocketClient> exception while closing')
  assert.equal(tidyTitle('connector b799b774-f678-4e81-a7ac-1ad403c0493a failed'), 'connector b799b774… failed')
  assert.equal(tidyTitle(`GET ${'a'.repeat(80)}`), `GET ${'a'.repeat(29)}…${'a'.repeat(14)}`)
})

test('Alert filters answer the click at once and show what is known while Sentry is read', async () => {
  const issues = [
    { id: 'A-1', title: 'a', lastSeen: '2026-10-10T00:00:00Z', firstSeen: '2026-10-01T00:00:00Z', events: 5 },
    { id: 'A-2', title: 'b', lastSeen: '2026-10-09T00:00:00Z', firstSeen: '2026-10-05T00:00:00Z', events: 50 },
  ]
  const answer = (request: AlertsRequest): AlertsState => {
    const list = request.op === 'list' ? request : { period: undefined, sort: undefined, order: undefined }
    return { enabled: true, issues, period: list.period ?? '14d', sort: list.sort ?? 'lastSeen', order: list.order ?? 'desc', refreshedAt: 0, bots: [] }
  }
  let release: (() => void) | undefined
  const store = new AlertsStore(async (request) => {
    if (release === undefined) return { ok: true, value: answer(request) }
    await new Promise<void>((done) => { const prior = release!; release = () => { prior(); done() } })
    return { ok: true, value: answer(request) }
  })
  await store.load()
  release = () => {}
  // A sort switch on a complete list re-sorts locally before Sentry answers.
  const sorting = store.load(false, { sort: 'events' })
  let snapshot = store.getSnapshot()
  assert.equal(snapshot.loading, true)
  assert.deepEqual(snapshot.query, { period: '14d', sort: 'events', order: 'desc' })
  assert.deepEqual(snapshot.state?.issues.map((issue) => issue.id), ['A-2', 'A-1'])
  // A period never read keeps the old list while the buttons already show the new filter.
  const period = store.load(false, { period: '7d' })
  snapshot = store.getSnapshot()
  assert.deepEqual(snapshot.query, { period: '7d', sort: 'events', order: 'desc' })
  assert.equal(snapshot.state?.period, '14d')
  release()
  await Promise.all([sorting, period])
  snapshot = store.getSnapshot()
  assert.equal(snapshot.query, undefined)
  assert.equal(snapshot.state?.period, '7d')
  // Switching back shows the last list for that filter at once.
  release = () => {}
  const back = store.load(false, { period: '14d', sort: 'lastSeen' })
  assert.equal(store.getSnapshot().state?.period, '14d')
  assert.equal(store.getSnapshot().state?.sort, 'lastSeen')
  release()
  await back
  store.dispose()
})

test('the board search finds an issue by its id, text or source', () => {
  const issue = { id: 'HUB-12A', title: 'TypeError: x is undefined', culprit: 'app/render', project: 'web', location: { path: 'src/view.ts', line: 4 } }
  for (const text of ['hub-12a', 'typeerror', 'render', 'web', 'view.ts']) assert.equal(issueMatches(issue, text), true, text)
  assert.equal(issueMatches(issue, 'nothing'), false)
})

test('a pull request is linked to the Sentry issues its branch or title names, whole', () => {
  const issue = (id: string) => ({ id, title: id })
  const issues = [issue('PROJ-1'), issue('PROJ-12'), issue('PROJ-1A3'), issue('API-7'), issue('WEB-API-7')]
  const ids = (pull: { branch: string; title: string }): string[] => issuesInPull(pull, issues).map((found) => found.id)
  // The fix branch the alerts make: `fix/<id>-<title>`.
  assert.deepEqual(ids({ branch: 'fix/proj-1a3-typeerror-in-billing', title: 'Handle a missing user' }), ['PROJ-1A3'])
  // By the title, any case; a prefix of an id is not the id.
  assert.deepEqual(ids({ branch: 'vi/billing', title: 'Fixes proj-12: retry the charge' }), ['PROJ-12'])
  assert.deepEqual(ids({ branch: 'proj-123', title: 'PROJ-1234 and PROJ-1A' }), [])
  // Several at once; one project's id inside another's is left to the longer.
  assert.deepEqual(ids({ branch: 'fix/proj-1', title: 'Also PROJ-12' }), ['PROJ-1', 'PROJ-12'])
  assert.deepEqual(ids({ branch: 'fix/web-api-7-timeout', title: 'Timeout' }), ['WEB-API-7'])
  assert.deepEqual(ids({ branch: 'fix/api-7', title: 'Timeout' }), ['API-7'])
  assert.deepEqual(ids({ branch: '', title: 'Nothing here' }), [])
})
