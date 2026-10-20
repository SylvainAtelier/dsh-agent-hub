import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScriptTask, validateScriptTask } from '../src/automation/runner.ts'
import { resolveAutomationRoute } from '../src/automation/route.ts'
import type { ExecResult, ExecOptions } from '../src/exec.ts'
import type { ScriptTask } from '../src/automation/types.ts'
const def: ScriptTask = { id: 'daily', title: 'Daily', command: '/bin/task', args: ['--mode', 'sync'], cwd: '/workspace', provider: 'native', model: 'model', timeoutMs: 1000 }
const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '{"status":"ok","summary":"Confirmed"}', stderr: 'SECRET STDERR', missing: false, timedOut: false, overflow: false, stopped: false, ...overrides })

test('runner uses bounded argv exec without shell and accepts only its JSON protocol', async () => {
  let seen: ExecOptions | undefined
  const output = await runScriptTask(def, new AbortController().signal, 'run-id', async (command, args, options) => {
    assert.equal(command, def.command); assert.deepEqual(args, def.args); seen = options
    return result()
  })
  assert.deepEqual(output, { status: 'ok', summary: 'Confirmed' })
  assert.equal(seen?.shell, false); assert.equal(seen?.cwd, def.cwd); assert.equal(seen?.env?.AUTOMATION_RUN_ID, 'run-id')
})

test('nonzero exit cannot succeed and all raw errors/output are withheld', async () => {
  for (const data of [result({ code: 3 }), result({ stdout: 'SECRET STDOUT' }), result({ missing: true }), result({ overflow: true }), result({ stdout: '{"status":"ok","summary":"x","extra":"SECRET"}' })]) {
    const output = await runScriptTask(def, new AbortController().signal, undefined, async () => data)
    assert.notEqual(output.status, 'ok'); assert.doesNotMatch(JSON.stringify(output), /SECRET/)
  }
  const failed = await runScriptTask(def, new AbortController().signal, undefined, async () => { throw new Error('SECRET ERROR') })
  assert.equal(failed.status, 'unknown'); assert.doesNotMatch(JSON.stringify(failed), /SECRET/)
})

test('nonzero structured errors and unknown outcomes preserve authoritative protocol summaries', async () => {
  for (const status of ['error', 'unknown'] as const) {
    const output = await runScriptTask(def, new AbortController().signal, undefined, async () => result({ code: 2, stdout: JSON.stringify({ status, summary: 'Authentication required' }) }))
    assert.deepEqual(output, { status, summary: 'Authentication required', code: 2 })
  }
})

test('timeout and cancellation always report unknown', async () => {
  assert.equal((await runScriptTask(def, new AbortController().signal, undefined, async () => result({ timedOut: true }))).status, 'unknown')
  const controller = new AbortController(); controller.abort()
  let called = false
  assert.equal((await runScriptTask(def, controller.signal, undefined, async () => { called = true; return result() })).status, 'unknown')
  assert.equal(called, false)
})

test('definition validation rejects relative paths, NUL arguments, invalid timeouts and missing routes', () => {
  for (const change of [{ command: 'sh' }, { cwd: '.' }, { args: ['bad\0arg'] }, { timeoutMs: 0 }, { timeoutMs: 3_600_001 }, { model: '' }, { provider: '' }]) assert.throws(() => validateScriptTask({ ...def, ...change }))
  assert.equal(validateScriptTask({ ...def, command: 'C:\\tools\\task.exe', cwd: 'C:\\work' }).id, 'daily')
})

test('route rejects every external adapter, missing explicit route and unsafe bot configuration', () => {
  for (const provider of ['claude-agent', 'cursor-agent', 'qoder-agent', 'hermes-agent']) {
    assert.throws(() => resolveAutomationRoute({ ...def, provider }, []))
    assert.throws(() => resolveAutomationRoute({ provider: 'agent-hub-bot', model: 'bot' }, [{ id: 'bot', provider, model: 'x', tools: ['automation_run'] }]))
  }
  assert.throws(() => resolveAutomationRoute({ provider: '', model: '' }, [], { provider: 'native', model: 'x' }))
  assert.throws(() => resolveAutomationRoute({ provider: 'agent-hub-bot', model: 'missing' }, []))
  assert.throws(() => resolveAutomationRoute({ provider: 'agent-hub-bot', model: 'bot' }, [{ id: 'bot', tools: [] }], { provider: 'native', model: 'x' }))
  assert.deepEqual(resolveAutomationRoute({ provider: 'agent-hub-bot', model: 'bot' }, [{ id: 'bot', tools: ['automation_run'] }], { provider: 'native', model: 'x' }), { provider: 'agent-hub-bot', model: 'bot' })
})

test('diagnostics expose exit facts and bounded stderr to the local log only, never in the result', async () => {
  const seen: Record<string, unknown>[] = []
  const output = await runScriptTask(def, new AbortController().signal, 'run-id', async () => result({ code: 1, stdout: 'not json', stderr: 'step-1\nstep-2' }), (info) => { seen.push(info) })
  assert.equal(output.status, 'error'); assert.doesNotMatch(JSON.stringify(output), /step-1|not json/)
  assert.equal(seen.length, 1); assert.equal(seen[0].code, 1); assert.equal(seen[0].stderr, 'step-1\nstep-2'); assert.equal(seen[0].stdout, 'not json')
  const thrown: Record<string, unknown>[] = []
  await runScriptTask(def, new AbortController().signal, undefined, async () => { throw new Error('spawn failed') }, (info) => { thrown.push(info) })
  assert.equal(thrown[0].failed, 'spawn failed')
  // A throwing sink must never change the outcome.
  assert.equal((await runScriptTask(def, new AbortController().signal, undefined, async () => result(), () => { throw new Error('sink') })).status, 'ok')
})
