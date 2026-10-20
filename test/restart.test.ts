import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countRunning, createRestart, desktopRelaunch, freshPath, type Relaunch, type Run } from '../src/restart/index.ts'

test('restart: counts busy and queued agents and running jobs, like the Desktop quit check', () => {
  const agents = [
    { id: 'a', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
    { id: 'b', status: 'idle', inbox: { nextTurn: ['queued'], nextStep: [] } },
    { id: 'c', status: 'idle', inbox: { nextTurn: [], nextStep: [] } },
  ]
  const jobs: Record<string, Array<{ status: string }>> = {
    host: [{ status: 'running' }, { status: 'done' }],
    c: [{ status: 'stopping' }],
  }
  const running = countRunning({ agents: () => ({ list: () => agents }), jobs: () => ({ list: (id) => jobs[id ?? 'host'] ?? [] }) })
  assert.equal(running, 4)
})

test('restart: missing or failing services count as idle', () => {
  assert.equal(countRunning({ agents: () => undefined, jobs: () => undefined }), 0)
  assert.equal(countRunning({ agents: () => ({ list: () => { throw new Error('down') } }), jobs: () => ({ list: () => { throw new Error('down') } }) }), 0)
})

test('restart: not offered outside DSH Desktop', async () => {
  assert.equal(desktopRelaunch({}), undefined)
  const handle = createRestart({ agents: () => undefined, jobs: () => undefined }, () => undefined, () => assert.fail('must not start'))
  const status = await handle({ op: 'status' }) as { supported: boolean; boot: string }
  assert.equal(status.supported, false)
  assert.ok(status.boot.length > 0)
  await assert.rejects(handle({ op: 'restart' }), /only available in DSH Desktop/)
})

test('restart: starts the helper once however often it is asked', async () => {
  const target: Relaunch = { shell: 1, command: 'app', args: [] }
  const started: Relaunch[] = []
  const handle = createRestart({ agents: () => undefined, jobs: () => undefined }, () => target, (item) => { started.push(item) })
  assert.equal((await handle({ op: 'status' }) as { supported: boolean }).supported, true)
  assert.deepEqual(await handle({ op: 'restart' }), { started: true })
  assert.deepEqual(await handle({ op: 'restart' }), { started: true })
  assert.deepEqual(started, [target])
})

test('restart: Windows reads machine then user PATH from the registry', async () => {
  const calls: string[][] = []
  const run: Run = async (file, args) => { calls.push([file, ...args]); return `${JSON.stringify([String.raw`C:\Windows\system32;C:\Windows`, String.raw`C:\Users\vi\.qoder\entry`])}\r\n` }
  const path = await freshPath({ shell: 1, command: String.raw`C:\DSH\DSH.exe`, args: [] }, 'win32', { SystemRoot: String.raw`C:\Windows` }, run)
  assert.equal(path, String.raw`C:\Windows\system32;C:\Windows;C:\Users\vi\.qoder\entry`)
  assert.equal(calls[0]?.[0], String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
})

test('restart: Windows skips an empty user PATH and keeps the old one when the read fails', async () => {
  const target: Relaunch = { shell: 1, command: 'DSH.exe', args: [] }
  assert.equal(await freshPath(target, 'win32', {}, async () => JSON.stringify([String.raw`C:\Windows`, null])), String.raw`C:\Windows`)
  assert.equal(await freshPath(target, 'win32', {}, async () => undefined), undefined)
  assert.equal(await freshPath(target, 'win32', {}, async () => 'not json'), undefined)
})

test('restart: macOS through open leaves PATH to Launch Services', async () => {
  const path = await freshPath({ shell: 1, command: 'open', args: ['/Applications/DSH.app'] }, 'darwin', {}, () => assert.fail('must not run a shell'))
  assert.equal(path, undefined)
})

test('restart: a bare executable takes the login shell PATH, ignoring shell chatter', async () => {
  const calls: string[][] = []
  const run: Run = async (file, args) => { calls.push([file, ...args]); return 'motd\n__DSH_PATH__/opt/homebrew/bin:/usr/bin__DSH_PATH__' }
  assert.equal(await freshPath({ shell: 1, command: '/opt/DSH/dsh', args: [] }, 'darwin', { SHELL: '/bin/bash' }, run), '/opt/homebrew/bin:/usr/bin')
  assert.equal(calls[0]?.[0], '/bin/bash')
  assert.equal(calls[0]?.[1], '-ilc')
  assert.equal(await freshPath({ shell: 1, command: '/opt/DSH/dsh', args: [] }, 'linux', {}, async () => undefined), undefined)
})

test('restart: names the plugin upgrades it runs and hands their job to the helper', async () => {
  const target: Relaunch = { shell: 1, command: 'app', args: [] }
  const jobs: unknown[] = []
  const job = { cwd: '/p', commands: [], files: [], ops: [{ name: 'a', spec: '2.0.0' }], result: '/r', pending: '/q' }
  const handle = createRestart({ agents: () => undefined, jobs: () => undefined }, () => target, (_item, given) => { jobs.push(given) }, { list: () => [{ name: 'a', spec: '2.0.0' }], job: () => job })
  assert.deepEqual((await handle({ op: 'status' }) as { upgrades?: unknown }).upgrades, [{ name: 'a', spec: '2.0.0' }])
  await handle({ op: 'restart' })
  assert.deepEqual(jobs, [job])
})

test('restart helper: runs the waiting upgrades after DSH is gone, puts the profile back when one fails, then relaunches', async () => {
  const { HELPER } = await import('../src/restart/index.ts')
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-helper-'))
  try {
    const manifest = join(dir, 'package.json')
    await writeFile(manifest, 'before')
    await writeFile(join(dir, 'pending.json'), '{}')
    const gone = spawnSync(process.execPath, ['-e', '']).pid ?? 999999
    const marker = join(dir, 'relaunched')
    const run = async (script: string): Promise<{ ok: boolean; error?: string; log?: string[] }> => {
      const job = { cwd: dir, commands: [{ command: process.execPath, args: ['-e', script] }], files: [manifest], ops: [{ name: 'a', spec: '2.0.0' }], result: join(dir, 'result.json'), pending: join(dir, 'pending.json') }
      const child = spawn(process.execPath, ['-e', HELPER, JSON.stringify([gone, gone, process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`], null, job])], { stdio: 'ignore' })
      await new Promise((resolve) => child.on('exit', resolve))
      for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 100))
      return JSON.parse(await readFile(job.result, 'utf8'))
    }
    const failed = await run(`require('fs').writeFileSync('package.json', 'half'); console.log('fetching'); process.exit(1)`)
    assert.equal(failed.ok, false)
    assert.deepEqual(failed.log, ['fetching'])
    assert.equal(await readFile(manifest, 'utf8'), 'before', 'put back')
    assert.ok(existsSync(marker), 'DSH opens again either way')
    assert.equal(existsSync(join(dir, 'pending.json')), false)
    await rm(marker)
    const done = await run(`require('fs').writeFileSync('package.json', 'after')`)
    assert.equal(done.ok, true)
    assert.equal(await readFile(manifest, 'utf8'), 'after')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
