import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnsiBuffer, lineText } from '../src/client/git/ansi.ts'
import { ConsoleService, terminalActivity, type ConsoleRead, type ConsoleStart } from '../src/git/console.ts'
import { GitService, workspaceGate } from '../src/git/service.ts'
import type { GitReply } from '../src/git/types.ts'

test('terminal activity: DSH probe per terminal, unknown for anything unreadable', async () => {
  const handle = (state: unknown) => ({ handle: { inspectActivity: async () => ({ state, revision: 1 }) } })
  const terminals = new Map<string, unknown>([
    ['busy', handle('busy')],
    ['idle', handle('idle')],
    ['odd', handle('weird')],
    ['throws', { handle: { inspectActivity: async () => { throw new Error('ps failed') } } }],
    ['bare', {}],
  ])
  const controller = { owners: new Map([['s1', { terminals }]]) }
  assert.deepEqual(await terminalActivity(controller, 's1', ['busy', 'idle', 'odd', 'throws', 'bare', 'missing']),
    { busy: 'busy', idle: 'idle', odd: 'unknown', throws: 'unknown', bare: 'unknown', missing: 'unknown' })
  assert.deepEqual(await terminalActivity(controller, 'other', ['busy']), { busy: 'unknown' })
  // A controller shaped differently (a DSH upgrade) degrades to unknown, never throws.
  assert.deepEqual(await terminalActivity(undefined, 's1', ['busy']), { busy: 'unknown' })
  assert.deepEqual(await terminalActivity({ owners: 'nope' }, 's1', ['busy']), { busy: 'unknown' })
  // Windows ConPTY: the handle captured pid 0, so DSH's probe is blind; its process table is
  // read for node-pty's live pid instead, and the probe itself is not run.
  let probed = 0
  const conpty = (tree: number[]) => ({
    handle: {
      pid: 0,
      terminal: { pid: 100 },
      inspector: { snapshot: () => ({ tree: (pid: number) => (pid === 100 ? tree.map((member) => ({ pid: member })) : []) }) },
      inspectActivity: async () => { probed++; return { state: 'unknown' } },
    },
  })
  const win = { owners: new Map([['w', { terminals: new Map<string, unknown>([['running', conpty([100, 200])], ['idle', conpty([100])], ['gone', conpty([])]]) }]]) }
  assert.deepEqual(await terminalActivity(win, 'w', ['running', 'idle', 'gone']), { running: 'busy', idle: 'idle', gone: 'unknown' })
  assert.equal(probed, 0)
  // Through the console RPC.
  const service = new ConsoleService(async () => undefined, () => controller)
  assert.deepEqual(await service.handle({ op: 'activity', sessionId: 's1', ids: ['busy', 7] }), { ok: true, value: { busy: 'busy' } })
  service.dispose()
})

test('ansi: colors, resets, carriage returns and split escapes', () => {
  const buffer = new AnsiBuffer()
  buffer.write('\x1b[32mgreen\x1b[0m plain\n')
  buffer.write('progress 10%\rprogress 100%\n')
  buffer.write('\x1b[1;3')
  buffer.write('1mbold red\x1b[m\n')
  buffer.write('\x1b]0;title\x07after osc\r\n')
  buffer.write('\x1b[38;5;196mx\x1b[38;2;1;2;3my\n')
  const [first, second, third, fourth, fifth] = buffer.lines
  assert.deepEqual(first, [{ text: 'green', style: { fg: 'var(--gc-green)' } }, { text: ' plain' }])
  assert.equal(lineText(second!), 'progress 100%')
  assert.deepEqual(third, [{ text: 'bold red', style: { bold: true, fg: 'var(--gc-red)' } }])
  assert.equal(lineText(fourth!), 'after osc')
  assert.deepEqual(fifth!.map((s) => s.style?.fg), ['rgb(255,0,0)', 'rgb(1,2,3)'])
  const capped = new AnsiBuffer(3)
  capped.write('1\n2\n3\n4\n5\n')
  assert.equal(capped.lines.length, 3)
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function drain(service: ConsoleService, id: string): Promise<{ text: string; exit: number | null | undefined }> {
  let since = 0
  let text = ''
  for (let i = 0; i < 50; i++) {
    const reply = await service.handle({ op: 'read', id, since }) as { ok: true; value: ConsoleRead }
    for (const chunk of reply.value.chunks) {
      text += chunk.text
      since = chunk.seq
    }
    if (reply.value.exit !== undefined) return { text, exit: reply.value.exit }
  }
  return { text, exit: undefined }
}

test('console: runs in the repo root, streams output, refuses outside dirs', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-console-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-out-')))
  const service = new ConsoleService(workspaceGate(() => [dir]))
  try {
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: dir })
    const denied = await service.handle({ op: 'run', cwd: outside, command: 'git status' })
    assert.equal(denied.ok, false)
    const started = await service.handle({ op: 'run', cwd: dir, command: 'git status' }) as { ok: true; value: ConsoleStart }
    assert.ok(started.ok)
    const norm = (path: string): string => path.toLowerCase().split('\\').join('/')
    assert.equal(norm(started.value.cwd), norm(dir))
    const { text, exit } = await drain(service, started.value.id)
    assert.equal(exit, 0)
    assert.match(text.replace(/\x1b\[[0-9;]*m/g, ''), /On branch trunk/)
    const failing = await service.handle({ op: 'run', cwd: dir, command: 'git definitely-not-a-command' }) as { ok: true; value: ConsoleStart }
    const failed = await drain(service, failing.value.id)
    assert.notEqual(failed.exit, 0)
    // stdin reaches a running command, and an interrupt ends it (process tree included).
    const echo = await service.handle({ op: 'run', cwd: dir, command: `node -e "process.stdin.once('data', d => { console.log('got ' + d.toString().trim()); process.exit(0) })"` }) as { ok: true; value: ConsoleStart }
    await service.handle({ op: 'input', id: echo.value.id, text: 'hello' })
    const echoed = await drain(service, echo.value.id)
    assert.match(echoed.text, /got hello/)
    const long = await service.handle({ op: 'run', cwd: dir, command: 'node -e "setTimeout(() => {}, 60000)"' }) as { ok: true; value: ConsoleStart }
    const begun = Date.now()
    setTimeout(() => { void service.handle({ op: 'kill', id: long.value.id }) }, 300)
    const killed = await drain(service, long.value.id)
    assert.notEqual(killed.exit, 0)
    assert.ok(Date.now() - begun < 20_000)
  } finally {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('push: named branch, force-with-lease and force against a local remote', { skip: !hasGit() }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-push-')))
  const remote = join(base, 'remote.git')
  const dir = join(base, 'work')
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('config', 'user.name', 'T')
    git('config', 'user.email', 't@x')
    git('config', 'commit.gpgsign', 'false')
    git('remote', 'add', 'origin', remote)
    writeFileSync(join(dir, 'a.txt'), '1\n')
    git('add', '-A')
    git('commit', '-qm', 'one')
    const service = new GitService(workspaceGate(() => [base]))
    const call = async (payload: Record<string, unknown>): Promise<GitReply<unknown>> => service.handle({ cwd: dir, ...payload })
    // First push publishes and sets the upstream.
    assert.equal((await call({ op: 'push', branch: 'main', setUpstream: true })).ok, true)
    assert.equal(git('rev-parse', '--abbrev-ref', 'main@{upstream}').trim(), 'origin/main')
    // Rewrite history: a plain push is refused, --force-with-lease succeeds.
    writeFileSync(join(dir, 'a.txt'), '2\n')
    git('commit', '-qam', 'two')
    git('reset', '-q', '--hard', 'HEAD~1')
    writeFileSync(join(dir, 'a.txt'), '3\n')
    git('commit', '-qam', 'three')
    assert.equal((await call({ op: 'push', branch: 'main' })).ok, true) // fast-forward from one
    git('commit', '-q', '--amend', '-m', 'three amended')
    assert.equal((await call({ op: 'push', branch: 'main' })).ok, false)
    assert.equal((await call({ op: 'push', branch: 'main', force: 'lease' })).ok, true)
    git('commit', '-q', '--amend', '-m', 'three again')
    assert.equal((await call({ op: 'push', branch: 'main', force: 'force' })).ok, true)
    const remoteHead = execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim()
    assert.equal(remoteHead, 'three again')
    const remoteLog = (ref: string, at = remote): string => execFileSync('git', ['--git-dir', at, 'log', '-1', '--format=%s', ref], { encoding: 'utf8' }).trim()
    const remoteHas = (ref: string, at = remote): boolean => execFileSync('git', ['--git-dir', at, 'for-each-ref', `refs/heads/${ref}`], { encoding: 'utf8' }).trim() !== ''
    // A branch started from origin/main tracks main: it can't be force-pushed there, and its push publishes
    // it under its own name, never onto main.
    git('fetch', '-q', 'origin')
    git('switch', '-q', '--track', '-c', 'fix/x', 'origin/main')
    writeFileSync(join(dir, 'a.txt'), 'fix\n')
    git('commit', '-qam', 'fix')
    assert.equal((await call({ op: 'push', force: 'force' })).ok, false)
    assert.equal((await call({ op: 'push', force: 'lease' })).ok, false)
    assert.equal(remoteLog('main'), 'three again')
    assert.equal((await call({ op: 'push' })).ok, true)
    assert.equal(remoteLog('main'), 'three again')
    assert.equal(remoteLog('fix/x'), 'fix')
    assert.equal(git('rev-parse', '--abbrev-ref', 'fix/x@{upstream}').trim(), 'origin/fix/x')
    // Publishing over someone else's branch of the same name is refused, not merged or overwritten.
    const other = join(base, 'other')
    execFileSync('git', ['clone', '-q', remote, other])
    const theirs = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=O', '-c', 'user.email=o@x', ...args], { cwd: other, encoding: 'utf8' })
    theirs('switch', '-q', '-c', 'shared', 'origin/main')
    writeFileSync(join(other, 'b.txt'), 'theirs\n')
    theirs('add', '-A')
    theirs('commit', '-qm', 'theirs')
    theirs('push', '-q', '-u', 'origin', 'shared')
    git('switch', '-q', '--no-track', '-c', 'shared', 'main')
    writeFileSync(join(dir, 'a.txt'), 'mine\n')
    git('commit', '-qam', 'mine')
    assert.equal((await call({ op: 'push' })).ok, false)
    assert.equal(remoteLog('shared'), 'theirs')
    // Force-with-lease checks what this clone has seen: a fetch that merely brought their commit in
    // (as the fetch button does) doesn't let a lease push discard it.
    git('fetch', '-q', 'origin')
    git('branch', '-q', '--set-upstream-to=origin/shared', 'shared')
    assert.equal((await call({ op: 'push', force: 'lease' })).ok, false)
    assert.equal(remoteLog('shared'), 'theirs')
    // A tag named like the branch can't divert the push: both ends are spelled out.
    git('switch', '-q', 'fix/x')
    git('tag', 'fix/x', 'main')
    writeFileSync(join(dir, 'a.txt'), 'fix 2\n')
    git('commit', '-qam', 'fix 2')
    assert.equal((await call({ op: 'push' })).ok, true)
    assert.equal(remoteLog('fix/x'), 'fix 2')
    assert.equal(execFileSync('git', ['--git-dir', remote, 'tag', '--list', 'fix/x'], { encoding: 'utf8' }).trim(), '')
    // A configured push remote (a fork) takes the push, under the same name; the upstream stays.
    const fork = join(base, 'fork.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', fork])
    git('remote', 'add', 'fork', fork)
    git('config', 'branch.fix/x.pushRemote', 'fork')
    assert.equal((await call({ op: 'push' })).ok, true)
    assert.equal(remoteLog('fix/x', fork), 'fix 2')
    assert.equal(remoteHas('main', fork), false)
    assert.equal(git('rev-parse', '--abbrev-ref', 'fix/x@{upstream}').trim(), 'origin/fix/x')
    // A branch on the remote under its name but never set to track it (made without tracking, then reset onto
    // it): the status takes that branch as the upstream; after a rebase it is behind only by its own old commits,
    // so it force-pushes with a lease (a plain push is refused) and the push sets the upstream.
    type Status = { upstream?: string; upstreamGuessed?: boolean; rewritten?: boolean; ahead: number; behind: number }
    const status = async (): Promise<Status> => {
      const reply = await call({ op: 'status', fresh: true })
      assert.ok(reply.ok)
      return reply.value as Status
    }
    git('switch', '-q', '--no-track', '-c', 'rb', 'main')
    writeFileSync(join(dir, 'c.txt'), 'rb\n')
    git('add', '-A')
    git('commit', '-qm', 'rb one')
    git('push', '-q', 'origin', 'rb')
    let now = await status()
    assert.deepEqual([now.upstream, now.upstreamGuessed, now.ahead, now.behind, now.rewritten], ['origin/rb', true, 0, 0, undefined])
    git('commit', '-q', '--amend', '-m', 'rb rebased')
    now = await status()
    assert.deepEqual([now.upstream, now.ahead, now.behind, now.rewritten], ['origin/rb', 1, 1, true])
    assert.equal((await call({ op: 'push' })).ok, false)
    assert.equal((await call({ op: 'push', force: 'lease' })).ok, true)
    assert.equal(remoteLog('rb'), 'rb rebased')
    assert.equal(git('rev-parse', '--abbrev-ref', 'rb@{upstream}').trim(), 'origin/rb')
    now = await status()
    assert.deepEqual([now.upstreamGuessed, now.ahead, now.behind, now.rewritten], [undefined, 0, 0, undefined])
    // Someone else's commit on it is not a rewrite: the status says pull, and a lease push is refused.
    theirs('fetch', '-q', 'origin')
    theirs('switch', '-q', '-c', 'rb', 'origin/rb')
    writeFileSync(join(other, 'd.txt'), 'theirs\n')
    theirs('add', '-A')
    theirs('commit', '-qm', 'their rb')
    theirs('push', '-q', 'origin', 'rb')
    git('commit', '-q', '--amend', '-m', 'rb again')
    git('fetch', '-q', 'origin')
    now = await status()
    assert.equal(now.behind > 0 && now.rewritten !== true, true)
    assert.equal((await call({ op: 'push', force: 'lease' })).ok, false)
    assert.equal(remoteLog('rb'), 'their rb')
    // New branches started at a remote branch track nothing.
    assert.equal((await call({ op: 'branch-create', name: 'fix/y', at: 'origin/main' })).ok, true)
    assert.equal(git('for-each-ref', '--format=%(upstream)', 'refs/heads/fix/y').trim(), '')
    // A branch name that looks like an option is rejected.
    assert.equal((await call({ op: 'push', branch: '--mirror' })).ok, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/** DSH's terminal controller, as far as its spawn goes: the Session folder from `environment`, read through `this`. */
class FakeController {
  readonly config = { shell: 'zsh' }
  spawned: Array<{ id: string; cwd: string; shell: string }> = []
  environment(agent: { id: string }): { cwd: string; maxCols: number } {
    return { cwd: `/sessions/${agent.id}`, maxCols: 200 }
  }
  async spawn(agent: { id: string }, _owner: unknown, request: { id: string }): Promise<{ cwd: string }> {
    const { cwd } = this.environment(agent)
    this.spawned.push({ id: request.id, cwd, shell: this.config.shell })
    return { cwd }
  }
}

test('start-in: the Session\'s next terminal starts in the folder, once; the rest is DSH\'s spawn', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-start-')))
  mkdirSync(join(dir, 'scripts'))
  writeFileSync(join(dir, 'a.txt'), '')
  const controller = new FakeController()
  const service = new ConsoleService(workspaceGate(() => [dir]), () => controller)
  try {
    const placed = await service.handle({ op: 'start-in', sessionId: 's', dir: join(dir, 'scripts') }) as { ok: true; value: boolean }
    assert.deepEqual(placed, { ok: true, value: true })
    // Another Session is untouched; this one's next terminal starts in the folder, the one after in its own.
    await controller.spawn({ id: 'other' }, undefined, { id: 't0' })
    assert.deepEqual(await controller.spawn({ id: 's' }, undefined, { id: 't1' }), { cwd: join(dir, 'scripts') })
    await controller.spawn({ id: 's' }, undefined, { id: 't2' })
    assert.deepEqual(controller.spawned, [
      { id: 't0', cwd: '/sessions/other', shell: 'zsh' },
      { id: 't1', cwd: join(dir, 'scripts'), shell: 'zsh' },
      { id: 't2', cwd: '/sessions/s', shell: 'zsh' },
    ])
    // Only folders inside a workspace.
    for (const [target, code] of [[join(dir, 'a.txt'), 'invalid'], [tmpdir(), 'denied']] as const) {
      const refused = await service.handle({ op: 'start-in', sessionId: 's', dir: target }) as { ok: false; error: { code: string } }
      assert.equal(refused.error.code, code)
    }
    // Disposed: DSH's own spawn is back.
    service.dispose()
    assert.equal(controller.spawn, FakeController.prototype.spawn)
  } finally {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start-in: a controller shaped otherwise is left alone, and the answer says so', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-start-')))
  try {
    for (const controller of [undefined, {}, { spawn: () => {} }]) {
      const service = new ConsoleService(workspaceGate(() => [dir]), () => controller)
      assert.deepEqual(await service.handle({ op: 'start-in', sessionId: 's', dir }), { ok: true, value: false })
      service.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
