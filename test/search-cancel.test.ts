import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import * as childProcess from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from '../src/exec.ts'

// Keep process-tree behavior deterministic without launching actual descendants.
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 500_000_000,
    exitCode: null as number | null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kills: [] as string[],
    kill(signal: string) { this.kills.push(signal); return true },
  })
}
let current = child()
const spawned: string[] = []
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  spawn(command: string) {
    spawned.push(command)
    if (command === 'taskkill') {
      const killer = new EventEmitter()
      queueMicrotask(() => killer.emit('exit', 0, null))
      return killer
    }
    assert.equal(command, 'scan')
    return current
  },
} })
const { exec } = await import('../src/exec.ts')
const { FilesService } = await import('../src/files/service.ts')
const { ripgrep, gitGrep, definitions } = await import('../src/files/search.ts')
const empty: ExecResult = { code: 0, stdout: '', stderr: '', missing: false, timedOut: false, overflow: false, stopped: false }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('exec: pre-aborted signal never spawns a process or installs a listener', async () => {
  const controller = new AbortController()
  const reason = new Error('superseded')
  controller.abort(reason)
  const before = spawned.length
  await assert.rejects(exec('scan', [], { signal: controller.signal }), (error) => error === reason)
  assert.equal(spawned.length, before)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('exec: cancellation kills the tree once, waits for close and removes the listener', async () => {
  current = child()
  const controller = new AbortController()
  const reason = new Error('superseded')
  const before = spawned.length
  let settled = false
  const pending = exec('scan', [], { signal: controller.signal, onLine: () => assert.fail('no output after cancellation') })
  const rejected = assert.rejects(pending, (error) => error === reason).then(() => { settled = true })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  controller.abort(reason)
  current.stdout.write('stale\n')
  await tick()
  assert.equal(settled, false)
  if (process.platform === 'win32') assert.deepEqual(spawned.slice(before), ['scan', 'taskkill'])
  else assert.deepEqual(current.kills, ['SIGTERM'])
  current.emit('close', null, 'SIGTERM')
  await rejected
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('exec: normal close and spawn error remove abort listeners', async () => {
  for (const missing of [false, true]) {
    current = child()
    const controller = new AbortController()
    const pending = exec('scan', [], { signal: controller.signal })
    if (missing) current.emit('error', Object.assign(new Error('not installed'), { code: 'ENOENT' }))
    current.emit('close', missing ? null : 0, null)
    assert.equal((await pending).missing, missing)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    const before = spawned.length
    controller.abort()
    assert.equal(spawned.length, before, 'finished processes must not be killed later')
  }
})

test('exec: cancellation escalates to close inherited descendant pipes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  current = child()
  const controller = new AbortController()
  const reason = new Error('superseded')
  const pending = exec('scan', [], { signal: controller.signal })
  const rejected = assert.rejects(pending, (error) => error === reason)
  let closed = 0
  const scanChild = current
  for (const stream of [scanChild.stdout, scanChild.stderr]) {
    stream.on('close', () => { if (++closed === 2) scanChild.emit('close', 0, null) })
  }
  scanChild.exitCode = 0
  scanChild.emit('exit', 0, null)
  controller.abort(reason)
  await tick()
  t.mock.timers.tick(1000)
  await rejected
  assert.equal(closed, 2)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

for (const engine of ['ripgrep', 'gitGrep'] as const) {
  const scan = (run: Exec, signal: AbortSignal) => engine === 'ripgrep'
    ? ripgrep(run, 'rg', process.cwd(), { query: 'hello' }, signal)
    : gitGrep(run, process.cwd(), { query: 'hello' }, false, signal)

  test(`${engine}: pre-cancellation skips exec and post-await cancellation beats scan errors`, async () => {
    const controller = new AbortController()
    const reason = new Error('superseded')
    controller.abort(reason)
    await assert.rejects(scan(async () => assert.fail('must not execute'), controller.signal), (error) => error === reason)

    const active = new AbortController()
    const pending = scan(async (_command, _args, options) => {
      assert.equal(options.signal, active.signal)
      active.abort(reason)
      return { ...empty, missing: true, code: 2, stderr: 'invalid pattern' }
    }, active.signal)
    await assert.rejects(pending, (error) => error === reason)
  })
}

test('definitions: cancellation is checked before and after the scan await', async () => {
  const controller = new AbortController()
  const reason = new Error('superseded')
  const pending = definitions(async () => {
    controller.abort(reason)
    return { files: [], count: 0, truncated: false }
  }, 'main.ts', 'hello', controller.signal)
  await assert.rejects(pending, (error) => error === reason)
  await assert.rejects(definitions(async () => assert.fail('must not scan'), 'main.ts', 'hello', controller.signal), (error) => error === reason)
})

test('FilesService: cancellation while awaiting the gate prevents engine resolution', async () => {
  const gate = deferred<string>()
  const controller = new AbortController()
  const service = new FilesService(() => gate.promise, { ripgrep: async () => assert.fail('must not resolve engine') })
  const pending = service.handle({ op: 'search', cwd: process.cwd(), query: 'hello' }, controller.signal)
  controller.abort()
  gate.resolve(process.cwd())
  assert.equal((await pending).ok, false)
})

for (const outcome of ['available', 'missing', 'rejected'] as const) {
  test(`FilesService: cancellation during rg resolution (${outcome}) never starts a fallback scan`, async () => {
    const rg = deferred<string | undefined>()
    const entered = deferred<void>()
    const controller = new AbortController()
    const service = new FilesService(async (cwd) => cwd, {
      exec: async () => assert.fail('must not scan after cancellation'),
      ripgrep: () => { entered.resolve(); return rg.promise },
    })
    const pending = service.handle({ op: 'search', cwd: process.cwd(), query: 'hello' }, controller.signal)
    await entered.promise
    controller.abort()
    if (outcome === 'rejected') rg.reject(new Error('unavailable'))
    else rg.resolve(outcome === 'available' ? 'rg' : undefined)
    assert.equal((await pending).ok, false)
  })
}

for (const engine of ['rg', undefined]) {
  test(`FilesService: search and definition pass cancellation to ${engine ?? 'git grep'}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-search-cancel-')))
    try {
      writeFileSync(join(root, 'main.ts'), 'export const hello = 1\n')
      for (const op of ['search', 'definition']) {
        const controller = new AbortController()
        const started = deferred<void>()
        const finished = deferred<ExecResult>()
        let calls = 0
        const service = new FilesService(async (cwd) => cwd, {
          ripgrep: async () => engine,
          exec: async (command, _args, options) => {
            calls++
            assert.equal(command, engine ?? 'git')
            assert.equal(options.signal, controller.signal)
            started.resolve()
            return finished.promise
          },
        })
        const pending = service.handle({ op, cwd: root, query: 'hello', word: 'hello', path: 'main.ts' }, controller.signal)
        await started.promise
        controller.abort()
        finished.resolve(empty)
        assert.equal((await pending).ok, false, 'cancelled results must not be returned as successful')
        assert.equal(calls, 1)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
