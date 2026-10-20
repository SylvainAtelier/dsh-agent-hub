import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReviewSchedule, type ReviewScheduleHost, type ReviewTask, type ReviewSyncTools } from '../src/review/schedule.ts'

async function fixture(auto = true) {
  const dir = await mkdtemp(join(tmpdir(), 'review-schedule-'))
  let enabled = auto
  let runs = 0
  let starts = 0
  const titles: string[] = []
  const tasks: ReviewTask[] = []
  const creates: unknown[] = []
  const updates: unknown[] = []
  const host: ReviewScheduleHost = {
    async catalog() { return structuredClone(tasks) },
    async create(sessionId, request) {
      creates.push(request)
      const task = { id: `task-${creates.length}`, sessionId, status: 'active', kind: 'daily', title: request.title,
        prompt: request.prompt, time: request.daily.time, timeZone: request.daily.time_zone, scheduledAt: '2026-10-18T07:00:00.000Z' }
      tasks.push(task)
      return task
    },
    async delete({ id }) { const index = tasks.findIndex((task) => task.id === id); if (index >= 0) tasks.splice(index, 1) },
    async update(request) {
      updates.push(request)
      const task = tasks.find((task) => task.id === request.id)
      assert.equal('status' in request.expected, false)
      assert.equal('sessionId' in request.expected, false)
      if (!task) return { updated: false, code: 'schedule_not_found' }
      // Installed host passes the whole request as content; change is ONLY a timing selector.
      assert.equal('change' in request, false)
      assert.equal(typeof request.title, 'string')
      task.title = request.title
      return { updated: true }
    },
  }
  const options = {
    file: join(dir, 'state.json'), settings: () => ({ auto: enabled, at: '08:45' }),
    setAuto: async (value: boolean) => { enabled = value }, schedule: () => host,
    start: async () => { starts++; return 'daily-session' },
    rename: async (_id: string, title: string) => { titles.push(title) },
    run: async () => { runs++; return { title: '看板审核 · 2 个待审核', summary: '# Review\n\n2 pending' } },
    timeZone: () => 'Europe/Budapest',
  }
  const service = new ReviewSchedule(options)
  return { service, options, host, tasks, creates, updates, titles, runs: () => runs, starts: () => starts,
    clean: async () => { service.dispose(); await rm(dir, { recursive: true, force: true }) } }
}

test('native reviews migrate once with daily wall-clock timezone and no second scheduler', async () => {
  const f = await fixture()
  try {
    const first = await f.service.initialize()
    assert.equal(first.enabled, true)
    assert.equal(first.sessionId, 'daily-session')
    assert.equal(first.time, '08:45:00')
    assert.equal(first.timeZone, 'Europe/Budapest')
    assert.equal(first.nextRun, Date.parse('2026-10-18T07:00:00.000Z'))
    await f.service.initialize()
    assert.equal(f.creates.length, 1)
    assert.equal(f.starts(), 1)
  } finally { await f.clean() }
})

test('native task deletion stays deleted after status, config edits and plugin reload', async () => {
  const f = await fixture()
  try {
    await f.service.initialize()
    f.tasks.splice(0)
    const deleted = await f.service.handle({ action: 'status' })
    assert.equal(deleted.enabled, false)
    assert.equal(deleted.taskId, undefined)
    await f.service.reconfigure()
    const next = new ReviewSchedule(f.options)
    assert.equal((await next.initialize()).enabled, false)
    assert.equal(f.creates.length, 1)
    await assert.rejects(next.execute('daily-session', new AbortController().signal), /deleted|ended/)
    assert.equal((await next.handle({ action: 'enable' })).enabled, true)
    assert.equal(f.creates.length, 2)
    next.dispose()
  } finally { await f.clean() }
})

test('manual enable is serialized and disable removes only owned native tasks', async () => {
  const f = await fixture(false)
  try {
    await f.service.initialize()
    assert.equal(f.creates.length, 0)
    await Promise.all([f.service.handle({ action: 'enable' }), f.service.handle({ action: 'enable' })])
    assert.equal(f.creates.length, 1)
    f.tasks.push({ ...f.tasks[0], id: 'unrelated', prompt: 'A different reminder' })
    assert.equal((await f.service.handle({ action: 'disable' })).enabled, false)
    assert.deepEqual(f.tasks.map((task) => task.id), ['unrelated'])
    await assert.rejects(f.service.execute('daily-session', new AbortController().signal), /restricted/)
    assert.equal(f.service.guard('pwsh', 'daily-session')?.includes('only'), true)
  } finally { await f.clean() }
})

test('review_sync is session-restricted, concludes the helper turn and caches each occurrence durably', async () => {
  const f = await fixture()
  try {
    await f.service.initialize()
    await assert.rejects(f.service.execute('other-session', new AbortController().signal), /restricted/)
    let registered!: Parameters<ReviewSyncTools['register']>[0]
    f.service.register({ register(tool) { registered = tool; return () => {} } })
    assert.equal(registered.timeoutMs, 21 * 60_000)
    let concluded = 0
    const exec = { agent: { id: 'daily-session' }, signal: new AbortController().signal, concludeTurn() { concluded++ } }
    const result = await registered.execute({}, exec)
    assert.equal(concluded, 1)
    assert.equal(result, '# Review\n\n2 pending')
    assert.deepEqual(registered.output.render({}, result), [{ type: 'text', text: result }])
    assert.equal(f.runs(), 1)
    assert.deepEqual(f.titles, ['看板审核 · 2 个待审核'])
    assert.equal(f.tasks[0].title, f.titles[0])
    assert.equal((await f.service.handle({ action: 'status' })).summary, result)
    const next = new ReviewSchedule(f.options)
    await next.initialize()
    assert.equal(await next.execute('daily-session', exec.signal), result)
    assert.equal(f.runs(), 1)
    f.tasks[0].scheduledAt = '2026-10-19T07:00:00.000Z'
    f.tasks[0].lastDelivery = { messageId: 'delivery-2' }
    await next.execute('daily-session', exec.signal)
    assert.equal(f.runs(), 2)
    f.tasks[0].scheduledAt = '2026-10-19T10:00:00.000Z'
    await next.execute('daily-session', exec.signal)
    assert.equal(f.runs(), 2)
    next.dispose()
  } finally { await f.clean() }
})

test('dedicated session gets idempotent native presentation without changing global PTC mode', async () => {
  const f = await fixture()
  try {
    const agent = {}
    const globalMode = 'ptc'
    let sessionMode = globalMode
    let allowed: string[] | undefined
    let applications = 0
    let disposed = 0
    const scoped = {
      presentAs(mode: 'native') { applications++; sessionMode = mode; return () => { disposed++; sessionMode = globalMode } },
      restrict(filter: { allow: string[] }) { allowed = filter.allow; return () => { allowed = undefined } },
    }
    f.service.prepareTools(agent, scoped)
    f.service.prepareTools(agent, scoped)
    assert.equal(applications, 1)
    assert.equal(sessionMode, 'native')
    assert.equal(globalMode, 'ptc')
    assert.deepEqual(allowed, ['review_sync'])
    assert.equal(f.service.guard('run_code', 'daily-session'), undefined)
    await f.service.initialize()
    assert.equal(f.service.isSession('daily-session'), true)
    assert.equal(f.service.isSession('unrelated-session'), false)
    assert.match(f.service.guard('run_code', 'daily-session')!, /only/)
    assert.equal(f.service.guard('review_sync', 'daily-session'), undefined)
    f.service.releaseTools(agent)
    f.service.releaseTools(agent)
    assert.equal(disposed, 1)
    assert.equal(sessionMode, 'ptc')
    const restoredAgent = {}
    f.service.prepareTools(restoredAgent, scoped)
    f.service.prepareTools(restoredAgent, scoped)
    assert.equal(applications, 2)
    assert.equal(sessionMode, 'native')
    assert.deepEqual(allowed, ['review_sync'])
    f.service.dispose()
    assert.equal(sessionMode, 'ptc')
    assert.equal(allowed, undefined)
    assert.equal(disposed, 2)
  } finally { await f.clean() }
})

test('one-shot edits permit the final delivered occurrence without reviving an ended or deleted task', async () => {
  const f = await fixture()
  try {
    await f.service.initialize()
    const task = f.tasks[0]
    task.status = 'inactive'
    task.kind = 'at'
    const signal = new AbortController().signal
    await assert.rejects(f.service.execute('daily-session', signal), /deleted|ended/)
    task.lastDelivery = { messageId: 'last-one-shot-delivery' }
    const status = await f.service.handle({ action: 'status' })
    assert.equal(status.enabled, false)
    assert.equal(status.taskId, task.id)
    assert.equal(status.nextRun, undefined)
    assert.equal(await f.service.execute('daily-session', signal), '# Review\n\n2 pending')
    assert.equal(await f.service.execute('daily-session', signal), '# Review\n\n2 pending')
    assert.equal(f.runs(), 1)
    assert.equal(f.updates.length, 0)
    f.tasks.splice(0)
    assert.equal((await f.service.handle({ action: 'status' })).taskId, undefined)
    await assert.rejects(f.service.execute('daily-session', signal), /deleted|ended/)
  } finally { await f.clean() }
})

test('uncertain native creation is recovered from catalog without duplicates', async () => {
  const f = await fixture(false)
  const create = f.host.create.bind(f.host)
  f.host.create = async (...args) => { await create(...args); throw new Error('Response lost') }
  try {
    await f.service.initialize()
    assert.match((await f.service.handle({ action: 'enable' })).error!, /Response lost/)
    assert.equal(f.tasks.length, 1)
    assert.equal((await f.service.handle({ action: 'enable' })).enabled, true)
    assert.equal(f.creates.length, 1)
  } finally { await f.clean() }
})
