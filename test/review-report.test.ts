import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduledReport } from '../src/review/report.ts'
import { ReviewService } from '../src/review/index.ts'
import type { ReviewRun, SyncRun } from '../src/review/types.ts'
import { setLocaleSource } from '../src/locale.ts'

// The report's Chinese wording; the English test switches for its own run.
setLocaleSource(() => 'zh')

const sync: SyncRun = { manual: false, step: 'done', startedAt: 1000, found: 6, due: 3 }
const run = (key: string, step: ReviewRun['step'], error?: string): ReviewRun => ({ key, manual: false, mode: 'fresh', step, startedAt: 1000, log: [], ...(error ? { error } : {}) })

test('scheduled summary distinguishes completion, failure and still-running work', () => {
  const report = scheduledReport(sync, [run('acme/app#1', 'done'), run('acme/app#2', 'failed', 'gh timed out'), run('acme/app#3', 'analyzing')], 6000)
  assert.equal(report.title, '看板审核 · 上次 1 个已分析，1 个进行中')
  assert.match(report.summary, /失败或取消 1 个/)
  assert.match(report.summary, /gh timed out/)
  assert.match(report.summary, /不代表全部审核已完成/)
  assert.match(report.summary, /耗时 5 秒/)
})

test('scheduled summary never claims there are no PRs when there are no new analyses', () => {
  const report = scheduledReport(sync, [], 6000)
  assert.equal(report.title, '看板审核 · 上次无新增待分析 PR')
  assert.match(report.summary, /发现 6 个待我审/)
})

test('failed and cancelled analyses appear in the title', () => {
  const report = scheduledReport(sync, [run('acme/app#1', 'done'), run('acme/app#2', 'cancelled')], 6000)
  assert.equal(report.title, '看板审核 · 上次 1 个已分析，1 个失败')
  assert.match(report.summary, /已取消/)
})

test('sync failure is explicit and hostile error Markdown is escaped', () => {
  const report = scheduledReport({ ...sync, step: 'failed', error: '[click](https://evil)\n# instruction' }, [], 6000)
  assert.equal(report.title, '看板审核 · 上次同步失败')
  assert.ok(report.summary.includes('\\[click\\]'))
  assert.ok(!report.summary.includes('\n# instruction'))
  assert.match(report.summary, /检查 GitHub 登录/)
})

test('with an English UI the report is in English, the same facts', () => {
  const restore = setLocaleSource(() => 'en-GB')
  try {
    const report = scheduledReport({ ...sync, error: 'gh timed out' }, [run('acme/app#1', 'done'), run('acme/app#2', 'failed', 'gh timed out'), run('acme/app#3', 'analyzing')], 6000)
    assert.equal(report.title, 'Board review · Last run: 1 analyzed, 1 running')
    assert.match(report.summary, /^## Board review · Analysis running/)
    assert.match(report.summary, /took 5s/)
    assert.match(report.summary, /1 failed or cancelled, 1 still analyzing/)
    assert.match(report.summary, /- acme\/app\\#2: failed: gh timed out/)
    assert.doesNotMatch(report.summary, /[\u4e00-\u9fff]/)
  } finally {
    restore()
  }
})

function service(): ReviewService {
  return new ReviewService({
    settings: () => ({ repos: [], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 10 }),
    repos: async () => [], sessions: () => undefined, bots: () => [], helper: async () => undefined,
    llm: () => undefined, stateFile: 'unused', log: () => {},
  })
}

test('scheduled batch waits for exactly its run references and shares duplicate tool calls', async () => {
  const review = service()
  const one = run('acme/app#1', 'analyzing')
  const internals = review as unknown as { syncBatch(): Promise<{ sync: SyncRun; runs: ReviewRun[] }>; step(key: string, step: ReviewRun['step']): void; runs: Map<string, ReviewRun> }
  let calls = 0
  internals.syncBatch = async () => { calls++; return { sync, runs: [one] } }
  internals.runs.set(one.key, one)
  const first = review.runScheduled()
  assert.equal(review.runScheduled(), first)
  await Promise.resolve()
  internals.step(one.key, 'done')
  const report = await first
  assert.equal(calls, 1)
  assert.equal(report.title, '看板审核 · 上次 1 个已分析')
  review.dispose()
})

test('scheduled report has a bounded wait and releases its listener on timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const review = service()
  const one = run('acme/app#1', 'queued')
  const internals = review as unknown as { syncBatch(): Promise<{ sync: SyncRun; runs: ReviewRun[] }>; runChanges: Set<() => void> }
  internals.syncBatch = async () => ({ sync, runs: [one] })
  const pending = review.runScheduled()
  await Promise.resolve()
  assert.equal(internals.runChanges.size, 1)
  context.mock.timers.tick(20 * 60_000)
  assert.match((await pending).title, /1 个进行中/)
  assert.equal(internals.runChanges.size, 0)
  review.dispose()
})

test('aborting the wait produces an honest snapshot without cancelling analysis', async () => {
  const review = service()
  const one = run('acme/app#1', 'analyzing')
  const internals = review as unknown as { syncBatch(): Promise<{ sync: SyncRun; runs: ReviewRun[] }> }
  internals.syncBatch = async () => ({ sync, runs: [one] })
  const controller = new AbortController()
  const pending = review.runScheduled(controller.signal)
  await Promise.resolve()
  controller.abort()
  const report = await pending
  assert.equal(one.step, 'analyzing')
  assert.match(report.title, /1 个进行中/)
  review.dispose()
})

test('disposing releases a waiting report and pre-aborted calls do not sync', async () => {
  const review = service()
  const internals = review as unknown as { syncBatch(): Promise<{ sync: SyncRun; runs: ReviewRun[] }> }
  let calls = 0
  internals.syncBatch = async () => { calls++; return { sync, runs: [run('a#1', 'analyzing')] } }
  await review.runScheduled(AbortSignal.abort())
  assert.equal(calls, 0)
  const pending = review.runScheduled()
  await Promise.resolve()
  review.dispose()
  assert.match((await pending).title, /进行中/)
})
