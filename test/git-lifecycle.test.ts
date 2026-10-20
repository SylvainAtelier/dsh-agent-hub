import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as childProcess from 'node:child_process'

// Model the OS boundary directly: a shell's handling of background descriptors
// differs across platforms, so a real alias cannot reliably reproduce this case.
const git = Object.assign(new EventEmitter(), {
  pid: 500_000_000,
  exitCode: null as number | null,
  signalCode: null,
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  stdin: undefined,
  kill(signal: string) { kills.push(signal); return true },
})
const kills: string[] = []
let taskkills = 0
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  spawn(command: string) {
    if (command === 'git') {
      queueMicrotask(() => {
        git.exitCode = 0
        git.emit('exit', 0, null)
        // The output pipes remain open in an orphaned background child.
      })
      return git
    }
    assert.equal(command, 'taskkill')
    taskkills++
    const killer = new EventEmitter()
    queueMicrotask(() => killer.emit('exit', 128, null)) // Parent PID no longer exists.
    return killer
  },
} })
const { runGit } = await import('../src/git/service.ts')
let pipes = 0
for (const stream of [git.stdout, git.stderr]) stream.on('close', () => { if (++pipes === 2) git.emit('close', git.exitCode, null) })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('runGit: exited parent and failed taskkill cannot leave inherited pipes blocking close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const pending = runGit(['status'], process.cwd(), { timeoutMs: 100 }).then((result) => { settled = true; return result })
  await tick()
  assert.equal(git.exitCode, 0)
  assert.equal(settled, false)
  t.mock.timers.tick(100)
  await tick()
  assert.equal(settled, false, 'do not release an operation solely because a kill was requested')
  if (process.platform === 'win32') {
    assert.equal(taskkills, 1)
    assert.ok(kills.includes('SIGKILL'), 'handle taskkill nonzero exit, not just spawn errors')
  }
  t.mock.timers.tick(1000)
  const result = await pending
  assert.equal(result.code, 0, 'retain the actual parent exit code')
  assert.equal(result.timedOut, true, 'an unfinished pipe drain is not a successful operation')
  assert.equal(pipes, 2)
})
