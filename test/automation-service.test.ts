import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationService, describeResult, type Options } from '../src/automation/service.ts'
import type { ReviewTask } from '../src/review/schedule.ts'
import type { RunResult, ScriptTask } from '../src/automation/types.ts'

const definition: ScriptTask = { id: 'daily', title: 'Daily task', command: '/bin/mock', args: [], cwd: '/work', provider: 'native', model: 'm', timeoutMs: 1000 }
async function harness(run?: Options['run']) {
  const dir = await mkdtemp(join(tmpdir(), 'automation-service-'))
  let definitions = [structuredClone(definition)]
  let starts = 0; let calls = 0
  const tasks: ReviewTask[] = []
  const options: Options = {
    file: join(dir, 'state.json'), settings: () => ({ tasks: definitions }),
    start: async () => `session-${++starts}`, prepare: async () => {},
    run: async (...args) => { calls++; return run ? run(...args) : { status: 'ok', summary: 'Confirmed outcome' } },
    schedule: () => ({ catalog: async () => structuredClone(tasks), create: async (sessionId, request) => {
      const id = `native-${starts}`
      tasks.push({ id, sessionId, status: 'active', title: request.title, prompt: request.prompt, scheduledAt: '2027-01-01T02:05:00Z', time: request.daily.time, timeZone: request.daily.time_zone })
      return { id }
    }, delete: async ({ id }) => { const index = tasks.findIndex((task) => task.id === id); if (index >= 0) tasks.splice(index, 1) } }),
  }
  const service = new AutomationService(options)
  await service.initialize()
  return { service, options, tasks, dir, enable: (id = 'daily') => service.handle({ action: 'enable', id, expected: structuredClone(definitions.find((task) => task.id === id)) }), calls: () => calls, setDefinitions: (next: ScriptTask[]) => { definitions = next },
    deliver: (messageId = 'receipt-1') => { tasks[0].lastDelivery = { messageId, deliveredAt: '2027-01-01T02:05:01Z' } },
    cleanup: async () => { service.dispose(); await rm(dir, { recursive: true, force: true }) } }
}
const signal = () => new AbortController().signal

test('only explicit enable schedules, genuine receipt is mandatory and terminal replay returns saved result', async () => {
  const h = await harness()
  try {
    assert.equal(h.tasks.length, 0)
    const status = await h.enable()
    assert.equal(status.tasks[0].enabled, true); assert.equal(status.tasks[0].nextRun, '2027-01-01T02:05:00Z')
    assert.equal(h.tasks[0].time, '10:05:00'); assert.equal(h.tasks[0].timeZone, 'Asia/Shanghai')
    assert.equal(JSON.parse(await h.service.execute('session-1', signal())).status, 'error'); assert.equal(h.calls(), 0)
    h.deliver()
    const output = await h.service.execute('session-1', signal())
    assert.equal(JSON.parse(output).status, 'ok'); assert.equal(await h.service.execute('session-1', signal()), output); assert.equal(h.calls(), 1)
    h.tasks.splice(0)
    await h.service.reconfigure(); assert.equal(h.tasks.length, 0)
    assert.equal(JSON.parse(await h.service.execute('session-1', signal())).status, 'error')
  } finally { await h.cleanup() }
})

test('persist running before executing, same receipt joins flight and different occurrence is busy', async () => {
  let finish!: (result: RunResult) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness(async () => {
    const persisted = JSON.parse(await readFile(h.options.file, 'utf8'))
    assert.equal(persisted.bindings[0].run.status, 'running')
    entered()
    return new Promise<RunResult>((resolve) => { finish = resolve })
  })
  try {
    await h.enable(); h.deliver()
    const first = h.service.execute('session-1', signal()); await started
    const duplicate = h.service.execute('session-1', signal())
    // Wait until the duplicate has passed admission before changing the receipt.
    await h.service.handle({ action: 'list' })
    h.deliver('receipt-2')
    assert.match(JSON.parse(await h.service.execute('session-1', signal())).summary, /busy/)
    assert.equal(h.calls(), 1)
    finish({ status: 'ok', summary: 'Done' })
    assert.equal(await first, await duplicate)
    h.deliver('receipt-1'); assert.equal(JSON.parse(await h.service.execute('session-1', signal())).status, 'ok'); assert.equal(h.calls(), 1)
  } finally { await h.cleanup() }
})

test('disable aborts flight, changed definitions fail closed, retired sessions retain tool guard', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness(async (_def, abort) => { entered(); return new Promise((resolve) => abort.addEventListener('abort', () => resolve({ status: 'unknown', summary: 'Cancelled' }), { once: true })) })
  try {
    await h.enable(); h.deliver()
    const running = h.service.execute('session-1', signal()); await started
    await assert.rejects(h.service.withDefinitionMutation('daily', async () => {}), /Disable/)
    await h.service.handle({ action: 'disable', id: 'daily' }); assert.equal(JSON.parse(await running).status, 'unknown'); assert.equal(h.tasks.length, 0)
    await h.enable()
    assert.equal(h.service.isSession('session-1'), true); assert.ok(h.service.guard('exec', 'session-1'))
    h.setDefinitions([{ ...definition, args: ['changed'] }]); await h.service.reconfigure()
    assert.equal(h.tasks.length, 0)
    assert.equal(JSON.parse(await h.service.execute('session-2', signal())).status, 'error')
    await h.service.withDefinitionMutation('daily', async () => { h.setDefinitions([]) })
  } finally { await h.cleanup() }
})

test('restart marks persisted running unknown and never retries the receipt', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    await h.enable(); h.deliver()
    await h.service.execute('session-1', signal()); h.service.dispose()
    const state = JSON.parse(await readFile(h.options.file, 'utf8'))
    state.bindings[0].run.status = 'running'; state.bindings[0].receipts['native-1:receipt-1'].status = 'running'
    await writeFile(h.options.file, JSON.stringify(state))
    restarted = new AutomationService(h.options); await restarted.initialize()
    assert.equal(JSON.parse(await restarted.execute('session-1', signal())).status, 'unknown'); assert.equal(h.calls(), 1)
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('route preflight failure does not consume the receipt and native timing survives config invalidation', async () => {
  const h = await harness()
  try {
    await h.enable(); h.deliver()
    h.options.prepare = async () => { throw new Error('Route unavailable') }
    await assert.rejects(h.service.execute('session-1', signal()), /Route unavailable/); assert.equal(h.calls(), 0)
    h.options.prepare = async () => {}
    assert.equal(JSON.parse(await h.service.execute('session-1', signal())).status, 'ok')
    h.tasks[0].time = '13:20:00'; h.tasks[0].timeZone = 'UTC'
    h.setDefinitions([{ ...definition, command: '/bin/changed' }]); await h.service.reconfigure()
    await h.enable()
    assert.equal(h.tasks[0].time, '13:20:00'); assert.equal(h.tasks[0].timeZone, 'UTC')
  } finally { await h.cleanup() }
})

test('many terminal receipts retain replay tombstones across restart', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    await h.enable()
    for (let index = 0; index < 35; index++) { h.deliver(`receipt-${index}`); await h.service.execute('session-1', signal()) }
    assert.equal(h.calls(), 35); h.service.dispose()
    restarted = new AutomationService(h.options); await restarted.initialize(); h.deliver('receipt-0')
    assert.equal(JSON.parse(await restarted.execute('session-1', signal())).status, 'ok'); assert.equal(h.calls(), 35)
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('independent tasks have independent single flights and catalog deletion aborts the active one', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness(async (def, abort) => {
    if (def.id === 'other') return { status: 'ok', summary: 'Other done' }
    entered()
    return new Promise((resolve) => abort.addEventListener('abort', () => resolve({ status: 'unknown', summary: 'Cancelled' }), { once: true }))
  })
  try {
    h.setDefinitions([definition, { ...definition, id: 'other' }])
    await h.enable(); await h.enable('other')
    h.deliver(); h.tasks[1].lastDelivery = { messageId: 'other-receipt' }
    const running = h.service.execute('session-1', signal()); await started
    assert.equal(JSON.parse(await h.service.execute('session-2', signal())).status, 'ok')
    h.tasks.splice(0, 1); await h.service.handle({ action: 'list' })
    assert.equal(JSON.parse(await running).status, 'unknown')
  } finally { await h.cleanup() }
})

test('inactive recurring tasks fail closed while explicit completed one-shot receipts can execute once', async () => {
  const h = await harness()
  try {
    await h.enable(); h.deliver()
    for (const status of ['inactive', 'paused', 'cancelled', 'unknown']) {
      h.tasks[0].status = status
      h.tasks[0].rule = { type: 'daily' }
      assert.equal(JSON.parse(await h.service.execute('session-1', signal())).status, 'error')
    }
    assert.equal(h.calls(), 0)
    h.tasks[0].status = 'inactive'; h.tasks[0].rule = { type: 'at' }
    const output = await h.service.execute('session-1', signal())
    assert.equal(JSON.parse(output).status, 'ok')
    assert.equal(await h.service.execute('session-1', signal()), output); assert.equal(h.calls(), 1)
  } finally { await h.cleanup() }
})

test('pausing a recurring native task aborts its active flight during status reconciliation', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness(async (_def, abort) => { entered(); return new Promise((resolve) => abort.addEventListener('abort', () => resolve({ status: 'unknown', summary: 'Stopped' }), { once: true })) })
  try {
    await h.enable(); h.deliver()
    const execution = h.service.execute('session-1', signal()); await started
    h.tasks[0].status = 'inactive'; h.tasks[0].rule = { type: 'daily' }
    await h.service.handle({ action: 'list' })
    assert.equal(JSON.parse(await execution).status, 'unknown')
  } finally { await h.cleanup() }
})

test('enable requires the exact normalized definition confirmed by the caller', async () => {
  const h = await harness()
  try {
    await assert.rejects(h.service.handle({ action: 'enable', id: 'daily' }))
    h.setDefinitions([{ ...definition, args: ['changed'] }])
    await assert.rejects(h.service.handle({ action: 'enable', id: 'daily', expected: definition }), /changed/)
    assert.equal(h.tasks.length, 0)
    await h.enable(); assert.equal(h.tasks.length, 1)
  } finally { await h.cleanup() }
})

test('lost create response reconciles the saved session without a duplicate create', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    const native = h.options.schedule()!
    h.options.schedule = () => ({ ...native, create: async (...args) => { await native.create(...args); throw new Error('Response lost') } })
    await assert.rejects(h.enable(), /Response lost/); assert.equal(h.tasks.length, 1)
    h.service.dispose(); restarted = new AutomationService(h.options)
    const status = await restarted.initialize()
    assert.equal(status.tasks[0].enabled, true); assert.equal(status.tasks[0].sessionId, 'session-1')
    await restarted.handle({ action: 'enable', id: 'daily', expected: definition })
    assert.equal(h.tasks.length, 1)
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('creation acknowledgement save failure recovers persisted intent after restart', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    const writable = h.service as unknown as { writeState(value: unknown): Promise<void> }
    const original = writable.writeState
    writable.writeState = async (value) => {
      if ((value as { bindings: Array<{ taskId?: string }> }).bindings.some((binding) => binding.taskId)) throw new Error('Write failed')
      await original(value)
    }
    await assert.rejects(h.enable(), /durably confirmed/)
    const persisted = JSON.parse(await readFile(h.options.file, 'utf8'))
    assert.equal(persisted.bindings[0].pendingCreation, true); assert.equal(persisted.bindings[0].taskId, undefined)
    h.service.dispose(); restarted = new AutomationService(h.options)
    assert.equal((await restarted.initialize()).tasks[0].enabled, true)
    await restarted.handle({ action: 'enable', id: 'daily', expected: definition }); assert.equal(h.tasks.length, 1)
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('unresolved or ambiguous creation never retries and disable removes every matching native task', async () => {
  const h = await harness()
  try {
    const native = h.options.schedule()!
    h.options.schedule = () => ({ ...native, create: async () => { throw new Error('No response') } })
    await assert.rejects(h.enable(), /No response/)
    const pending = await h.service.handle({ action: 'list' })
    assert.equal(pending.tasks[0].enabled, false); assert.match(pending.tasks[0].error!, /uncertain/)
    await assert.rejects(h.enable(), /uncertain/)
    const persisted = JSON.parse(await readFile(h.options.file, 'utf8'))
    const binding = persisted.bindings[0]
    // Obtain the fixed prompt from the native request without executing any program.
    let savedPrompt = ''
    h.options.schedule = () => ({ ...native, create: async (_session, request) => { savedPrompt = request.prompt; throw new Error('Capture request') } })
    await h.service.handle({ action: 'disable', id: 'daily' })
    await assert.rejects(h.enable(), /Capture request/)
    const sessionId = (await h.service.handle({ action: 'list' })).tasks[0].sessionId!
    for (const id of ['uncertain-a', 'uncertain-b']) h.tasks.push({ id, sessionId, prompt: savedPrompt, status: 'active', title: 'Task', scheduledAt: '2027-01-01T00:00:00Z' })
    const ambiguous = await h.service.handle({ action: 'list' })
    assert.equal(ambiguous.tasks[0].enabled, false); assert.match(ambiguous.tasks[0].error!, /Multiple/)
    await assert.rejects(h.enable(), /Multiple/)
    assert.equal(JSON.parse(await h.service.execute(sessionId, signal())).status, 'error')
    await h.service.handle({ action: 'disable', id: 'daily' }); assert.equal(h.tasks.length, 0)
    assert.equal(h.service.isSession(binding.sessionId), true)
  } finally { await h.cleanup() }
})

test('delivery display is derived without consuming a receipt or becoming unknown after restart', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    await h.enable(); h.deliver()
    const delivered = (await h.service.handle({ action: 'list' })).tasks[0].run
    assert.equal(delivered?.status, 'delivered'); assert.equal(delivered?.deliveredAt, '2027-01-01T02:05:01Z')
    const state = JSON.parse(await readFile(h.options.file, 'utf8'))
    assert.deepEqual(state.bindings[0].receipts, {}); assert.equal(state.bindings[0].run, undefined)
    h.service.dispose(); restarted = new AutomationService(h.options)
    assert.equal((await restarted.initialize()).tasks[0].run?.status, 'delivered')
    assert.equal(JSON.parse(await restarted.execute('session-1', signal())).status, 'ok'); assert.equal(h.calls(), 1)
    const [entry] = (await restarted.handle({ action: 'list' })).tasks[0].history ?? []
    assert.equal(entry?.status, 'succeeded'); assert.equal(entry?.kind, 'scheduled'); assert.ok(entry?.startedAt && entry.finishedAt)
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('hot reload fences late old-flight writes from overwriting new bindings', async () => {
  let finish!: (result: RunResult) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness(async () => { entered(); return new Promise<RunResult>((resolve) => { finish = resolve }) })
  let restarted: AutomationService | undefined
  try {
    await h.enable(); h.deliver()
    const oldFlight = h.service.execute('session-1', signal()); await started
    h.service.dispose(); restarted = new AutomationService(h.options); await restarted.initialize()
    await restarted.handle({ action: 'disable', id: 'daily' })
    await restarted.handle({ action: 'enable', id: 'daily', expected: definition })
    const before = await readFile(h.options.file, 'utf8')
    finish({ status: 'ok', summary: 'Late old result' })
    assert.equal(JSON.parse(await oldFlight).status, 'unknown')
    assert.equal(await readFile(h.options.file, 'utf8'), before)
    assert.equal((await restarted.handle({ action: 'list' })).tasks[0].sessionId, 'session-2')
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('whenReady waits for persisted session ownership before exposing bound tool scopes', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    await h.enable()
    let release!: () => void; let entered!: () => void
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const internals = h.service as unknown as { fileOperation<T>(work: () => Promise<T>): Promise<T> }
    const pending = internals.fileOperation(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
    await blocked
    h.service.dispose(); restarted = new AutomationService(h.options)
    let ready = false
    const readiness = restarted.whenReady().then(() => { ready = true })
    await Promise.resolve(); assert.equal(ready, false); assert.equal(restarted.isSession('session-1'), false)
    release(); await pending; await readiness
    assert.equal(ready, true); assert.equal(restarted.isSession('session-1'), true)
    assert.ok(restarted.guard('exec', 'session-1'))
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('new owner waits for an already started write and blocks execution after that admission', async () => {
  const h = await harness()
  let restarted: AutomationService | undefined
  try {
    await h.enable(); h.deliver()
    const writable = h.service as unknown as { writeState(value: unknown): Promise<void> }
    const original = writable.writeState
    let release!: () => void; let entered!: () => void
    const writing = new Promise<void>((resolve) => { entered = resolve })
    writable.writeState = async (value) => {
      if ((value as { bindings: Array<{ run?: { status: string } }> }).bindings.some((binding) => binding.run?.status === 'running')) {
        entered(); await new Promise<void>((resolve) => { release = resolve })
      }
      await original(value)
    }
    const execution = h.service.execute('session-1', signal()); const rejection = assert.rejects(execution, /stopped/)
    await writing; h.service.dispose(); restarted = new AutomationService(h.options)
    const initializing = restarted.initialize()
    release(); await rejection
    assert.equal((await initializing).tasks[0].run?.status, 'unknown'); assert.equal(h.calls(), 0)
    assert.equal(JSON.parse(await restarted.execute('session-1', signal())).status, 'unknown')
  } finally { restarted?.dispose(); await h.cleanup() }
})

test('dispose while execution preflight is blocked never starts the runner', async () => {
  const h = await harness()
  try {
    await h.enable(); h.deliver()
    let release!: () => void; let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.options.prepare = async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) }
    const executing = h.service.execute('session-1', signal()); const rejection = assert.rejects(executing, /stopped/)
    await started; h.service.dispose(); release(); await rejection
    assert.equal(h.calls(), 0)
  } finally { await h.cleanup() }
})

test('dispose during enable start or prepare prevents native creation', async () => {
  for (const stage of ['start', 'prepare'] as const) {
    const h = await harness()
    try {
      let release!: () => void; let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      const block = async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) }
      if (stage === 'start') h.options.start = async () => { await block(); return 'session-blocked' }
      else h.options.prepare = block
      const enabling = h.enable(); const rejection = assert.rejects(enabling, /stopped/)
      await started; h.service.dispose(); release(); await rejection
      assert.equal(h.tasks.length, 0)
    } finally { await h.cleanup() }
  }
})

test('dispose during native create cleans up a task admitted before the fence', async () => {
  const h = await harness()
  try {
    const native = h.options.schedule()!
    let release!: () => void; let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    h.options.schedule = () => ({ ...native, create: async (...args) => { await new Promise<void>((resolve) => { release = resolve; entered() }); return native.create(...args) } })
    const enabling = h.enable(); const rejection = assert.rejects(enabling, /stopped/)
    await started; h.service.dispose(); release(); await rejection
    assert.equal(h.tasks.length, 0)
  } finally { await h.cleanup() }
})

test('tool rejects command injection, concludes every failure and restricts native presentation', async () => {
  const h = await harness()
  try {
    let tool!: Parameters<Parameters<AutomationService['register']>[0]['register']>[0]
    h.service.register({ register: (value) => { tool = value; return () => {} } })
    let concluded = 0
    const context = { agent: { id: 'unbound' }, signal: signal(), concludeTurn: () => { concluded++ } }
    assert.equal(JSON.parse(await tool.execute({ command: '/bin/hack' }, context)).status, 'error')
    assert.equal(JSON.parse(await tool.execute({}, context)).status, 'error'); assert.equal(concluded, 2); assert.equal(h.calls(), 0)
    let released = 0; const agent = {}
    h.service.prepareTools(agent, { presentAs: (mode) => { assert.equal(mode, 'native'); return () => { released++ } }, restrict: ({ allow }) => { assert.deepEqual(allow, ['automation_run']); return () => { released++ } } })
    h.service.releaseTools(agent); assert.equal(released, 2)
  } finally { await h.cleanup() }
})

test('clean restart and reconfigure rewrite nothing and skip route preparation', async () => {
  const h = await harness()
  try {
    await h.enable()
    const before = (await stat(h.options.file)).mtimeMs
    let prepared = 0
    const options = { ...h.options, prepare: async () => { prepared++ } }
    h.service.dispose()
    const restarted = new AutomationService(options)
    await restarted.initialize(); await restarted.reconfigure()
    assert.equal((await stat(h.options.file)).mtimeMs, before); assert.equal(prepared, 0)
    assert.equal(restarted.isSession('session-1'), true); assert.equal(restarted.isSession('other'), false)
    restarted.dispose()
  } finally { await h.cleanup() }
})

test('disable cancels a running script before queued work drains', async () => {
  let aborted = false
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness((_def, signal) => new Promise<RunResult>((resolve) => { entered(); signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'ok', summary: 'late' }) }) }))
  try {
    await h.enable(); h.deliver()
    const running = h.service.execute('session-1', signal())
    await started
    const disabling = h.service.handle({ action: 'disable', id: 'daily' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(aborted, true)
    await disabling
    assert.equal(JSON.parse(await running).status, 'unknown')
  } finally { await h.cleanup() }
})

test('manual run executes the confirmed definition without a session, receipt or model and survives restart as a result', async () => {
  let finish!: (result: RunResult) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness(async () => {
    assert.equal(JSON.parse(await readFile(h.options.file, 'utf8')).manual.daily.status, 'running')
    entered()
    return new Promise<RunResult>((resolve) => { finish = resolve })
  })
  try {
    await assert.rejects(h.service.handle({ action: 'run', id: 'daily', expected: { ...definition, command: '/bin/other' } }), /changed/)
    assert.equal(h.calls(), 0)
    const admitted = await h.service.handle({ action: 'run', id: 'daily', expected: structuredClone(definition) })
    assert.equal(admitted.tasks[0].manual?.status, 'running'); assert.equal(admitted.tasks[0].enabled, false)
    await started
    await assert.rejects(h.service.handle({ action: 'run', id: 'daily', expected: structuredClone(definition) }), /already running/)
    await assert.rejects(h.service.withDefinitionMutation('daily', async () => {}), /Disable/)
    finish({ status: 'ok', summary: 'Checked' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const done = (await h.service.handle({ action: 'list' })).tasks[0]
    assert.equal(done.manual?.status, 'succeeded'); assert.equal(done.manual?.summary, 'Checked')
    assert.equal(done.history?.length, 1); assert.equal(done.history?.[0]?.kind, 'manual'); assert.equal(done.history?.[0]?.summary, 'Checked')
    assert.equal(h.tasks.length, 0); assert.equal(h.calls(), 1)
  } finally { await h.cleanup() }
})

test('manual run is cancellable, ignores native schedule state and interrupted runs restart as unknown', async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const h = await harness((_def, signal) => new Promise<RunResult>((resolve) => { entered(); signal.addEventListener('abort', () => resolve({ status: 'ok', summary: 'late' })) }))
  try {
    await h.service.handle({ action: 'run', id: 'daily', expected: structuredClone(definition) })
    await started
    await h.service.handle({ action: 'list' }) // reconciliation must not cancel a manual run
    assert.equal((await h.service.handle({ action: 'list' })).tasks[0].manual?.status, 'running')
    await h.service.handle({ action: 'cancel', id: 'daily' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await h.service.handle({ action: 'list' })).tasks[0].manual?.status, 'unknown')
  } finally { await h.cleanup() }
  const crashed = await harness(() => new Promise<RunResult>(() => {}))
  try {
    await crashed.service.handle({ action: 'run', id: 'daily', expected: structuredClone(definition) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    crashed.service.dispose()
    const restarted = new AutomationService(crashed.options)
    const view = await restarted.initialize()
    assert.equal(view.tasks[0].manual?.status, 'unknown')
    assert.equal(view.tasks[0].history?.[0]?.status, 'unknown')
    restarted.dispose()
  } finally { await crashed.cleanup() }
})

test('every run leaves start and end events in the local trace, and a throwing sink cannot affect it', async () => {
  const events: Record<string, any>[] = []
  const h = await harness()
  try {
    const options = { ...h.options, log: (event: Record<string, unknown>) => { events.push(event) } }
    h.service.dispose()
    const service = new AutomationService(options)
    await service.initialize()
    await service.handle({ action: 'run', id: 'daily', expected: structuredClone(definition) })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const names = events.map((event) => event.event)
    assert.deepEqual(names.filter((name) => name !== 'action'), ['run.start', 'run.end'])
    assert.equal(events.find((event) => event.event === 'run.start')?.kind, 'manual')
    assert.equal(events.find((event) => event.event === 'run.end')?.status, 'succeeded')
    service.dispose()
    const noisy = new AutomationService({ ...h.options, log: () => { throw new Error('sink') } })
    await noisy.initialize()
    await noisy.handle({ action: 'run', id: 'daily', expected: structuredClone(definition) })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal((await noisy.handle({ action: 'list' })).tasks[0].manual?.status, 'succeeded')
    noisy.dispose()
  } finally { await h.cleanup() }
})

test('tool output reads as a sentence while unparseable text passes through', () => {
  assert.equal(describeResult('{"status":"ok","summary":"Claim confirmed."}'), 'Succeeded: Claim confirmed.')
  assert.equal(describeResult('{"status":"error","summary":"Script exited unsuccessfully.","code":2}'), 'Failed (exit 2): Script exited unsuccessfully.')
  assert.equal(describeResult('not json'), 'not json')
})
