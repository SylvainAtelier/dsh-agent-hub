import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunOptions, RunResult } from '../src/git/service.ts'
import type { GitStatus } from '../src/git/types.ts'

// Keep native notifications deterministic while exercising real Git ignore/index semantics.
const listeners = new Map<string, (event: string, name: string | null) => void>()
mock.module('node:fs', { namedExports: {
  ...fs,
  watch(root: string, _options: unknown, listener: (event: string, name: string | null) => void) {
    listeners.set(root, listener)
    return Object.assign(new EventEmitter(), { close() { listeners.delete(root) } })
  },
} })
const { GitService, runGit } = await import('../src/git/service.ts')

type Hook = (args: readonly string[], options?: RunOptions) => Promise<RunResult | undefined>
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'git-watch-ignore-')))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  fs.mkdirSync(join(root, 'build'))
  fs.writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n!keep.log\n.worktrees/\n')
  fs.writeFileSync(join(root, 'build', 'tracked.txt'), 'tracked\n')
  git('add', '.gitignore')
  git('add', '-f', 'build/tracked.txt')
  const calls: string[] = []
  let hook: Hook | undefined
  const service = new GitService(async () => root, async (args, cwd, options) => {
    calls.push(args[0]!)
    return await hook?.(args, options) ?? runGit(args, cwd, options)
  }, undefined, { watch: true })
  const status = async (fresh = false): Promise<GitStatus> => {
    const reply = await service.handle({ cwd: root, op: 'status', fresh })
    if (!reply.ok) assert.fail(reply.error.message)
    return reply.value as GitStatus
  }
  return {
    root, git, calls, status,
    setHook(value: Hook | undefined) { hook = value },
    emit(name: string | null) { listeners.get(root)!('rename', name) },
    close() { service.dispose(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}
const failed = (extra: Partial<RunResult> = {}): RunResult => ({ code: 128, stdout: '', stderr: 'failed', ...extra })
function barrier() {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  return { release, entered, waiting, started }
}

test('watch: batches ignored output without status; tracked files and negative rules stay visible', async () => {
  const f = fixture()
  try {
    const first = await f.status()
    f.calls.length = 0
    assert.equal(await f.status(), first)
    assert.equal(f.calls.length, 0)
    f.emit('build/output.js')
    f.emit('debug.log')
    assert.equal(await f.status(), first)
    assert.equal(f.calls.filter((call) => call === 'check-ignore').length, 1)
    assert.ok(!f.calls.includes('status'))
    f.calls.length = 0
    fs.writeFileSync(join(f.root, 'build', 'tracked.txt'), 'changed\n')
    f.emit('build/tracked.txt')
    assert.ok((await f.status()).unstaged.some((file) => file.path === 'build/tracked.txt'))
    assert.ok(f.calls.includes('status'))
    f.calls.length = 0
    fs.writeFileSync(join(f.root, 'keep.log'), 'visible\n')
    f.emit('keep.log')
    assert.ok((await f.status()).untracked.some((file) => file.path === 'keep.log'))
    assert.ok(f.calls.includes('status'))
  } finally { f.close() }
})

test('watch: ignored directory events and formerly hard-coded worktree directories protect tracked descendants', async () => {
  const f = fixture()
  try {
    fs.mkdirSync(join(f.root, '.worktrees'))
    fs.writeFileSync(join(f.root, '.worktrees', 'tracked.txt'), 'one\n')
    f.git('add', '-f', '.worktrees/tracked.txt')
    await f.status()
    for (const dir of ['build', '.worktrees']) {
      f.calls.length = 0
      fs.writeFileSync(join(f.root, dir, 'tracked.txt'), 'two\n')
      f.emit(dir)
      assert.ok((await f.status()).unstaged.some((file) => file.path === `${dir}/tracked.txt`))
      assert.ok(f.calls.includes('status'))
    }
    f.calls.length = 0
    fs.rmSync(join(f.root, 'build'), { recursive: true })
    f.emit('build')
    assert.ok((await f.status()).unstaged.some((file) => file.path === 'build/tracked.txt'))
    assert.ok(f.calls.includes('status'), 'deleted directory still has tracked descendants in the index')
  } finally { f.close() }
})

test('watch: ignore-rule and metadata changes are not hidden by previous ignored batches', async () => {
  const f = fixture()
  try {
    await f.status()
    f.emit('debug.log')
    await f.status()
    fs.writeFileSync(join(f.root, 'debug.log'), 'visible after rule change\n')
    fs.writeFileSync(join(f.root, '.gitignore'), 'build/\n')
    f.emit('.gitignore')
    assert.ok((await f.status()).untracked.some((file) => file.path === 'debug.log'))
    f.calls.length = 0
    f.emit('.git/info/exclude')
    await f.status()
    assert.ok(f.calls.includes('status'))
    assert.ok(f.calls.includes('for-each-ref'))
    // Nested rule files must also bypass classification, even if ignored themselves.
    f.calls.length = 0
    f.emit('build/.gitignore')
    await f.status()
    assert.ok(f.calls.includes('status'))
  } finally { f.close() }
})

test('watch: unknown events, bounded queue overflow and classification failures conservatively scan', async () => {
  const f = fixture()
  try {
    await f.status()
    const faults = [failed(), failed({ code: 0, stdout: 'debug.log\0', overflow: true }),
      failed({ code: 0, stdout: 'debug.log\0', timedOut: true }), failed({ code: 0, stdout: 'debug.log' })]
    for (const result of faults) {
      f.calls.length = 0
      f.setHook(async (args) => args[0] === 'check-ignore' ? result : undefined)
      f.emit('debug.log')
      await f.status()
      assert.ok(f.calls.includes('status'))
    }
    f.setHook(async (args) => { if (args[0] === 'check-ignore') throw new Error('spawn failed'); return undefined })
    f.calls.length = 0
    f.emit('debug.log')
    await f.status()
    assert.ok(f.calls.includes('status'))
    for (const result of [failed(), failed({ code: 0, overflow: true })]) {
      f.calls.length = 0
      f.setHook(async (args) => args[0] === '--literal-pathspecs' ? result : undefined)
      f.emit('debug.log')
      await f.status()
      assert.ok(f.calls.includes('status'), 'failed tracked-descendant checks must remain dirty')
    }
    f.setHook(undefined)
    for (const event of [null, 'x'.repeat(9000)]) {
      f.calls.length = 0
      f.emit(event)
      await f.status()
      assert.ok(f.calls.includes('status'))
      assert.ok(!f.calls.includes('check-ignore'))
    }
    f.calls.length = 0
    for (let i = 0; i < 300; i++) f.emit(`${i}.log`)
    await f.status()
    assert.ok(f.calls.includes('status'))
    assert.ok(!f.calls.includes('check-ignore'))
  } finally { f.close() }
})

test('watch: events arriving during ignore classification remain pending', async () => {
  const f = fixture()
  try {
    await f.status()
    const b = barrier()
    f.setHook(async (args) => { if (args[0] === 'check-ignore') { b.entered(); await b.waiting }; return undefined })
    f.emit('debug.log')
    const pending = f.status()
    await b.started
    fs.writeFileSync(join(f.root, 'new.txt'), 'new\n')
    f.emit('new.txt')
    b.release()
    await pending
    f.setHook(undefined)
    f.calls.length = 0
    assert.ok((await f.status()).untracked.some((file) => file.path === 'new.txt'))
    assert.ok(f.calls.includes('status'))
  } finally { f.close() }
})

test('watch: metadata during ignore classification forces a full refresh', async () => {
  const f = fixture()
  try {
    await f.status()
    const b = barrier()
    f.setHook(async (args) => { if (args[0] === 'check-ignore') { b.entered(); await b.waiting }; return undefined })
    f.calls.length = 0
    f.emit('debug.log')
    const pending = f.status()
    await b.started
    f.emit('.git/index')
    b.release()
    await pending
    assert.ok(f.calls.includes('status'))
    assert.ok(f.calls.includes('for-each-ref'))
  } finally { f.close() }
})

test('watch: events during status survive; fresh and 30 second max age still scan', async (t) => {
  const f = fixture()
  try {
    await f.status()
    const b = barrier()
    f.setHook(async (args) => { if (args[0] === 'status') { b.entered(); await b.waiting }; return undefined })
    f.emit('first.txt')
    const pending = f.status()
    await b.started
    f.emit('second.txt')
    b.release()
    await pending
    f.setHook(undefined)
    f.calls.length = 0
    await f.status()
    assert.ok(f.calls.includes('status'))
    f.calls.length = 0
    f.emit('debug.log')
    await f.status(true)
    assert.ok(f.calls.includes('status'))
    f.calls.length = 0
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(30_001)
    f.emit('debug.log')
    await f.status()
    assert.ok(f.calls.includes('status'))
    assert.ok(f.calls.includes('for-each-ref'))
    assert.ok(!f.calls.includes('check-ignore'))
  } finally { f.close() }
})
