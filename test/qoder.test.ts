import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { Child } from '../src/acp/client.ts'
import { AcpRoute, type AcpProfile, type StreamOptions } from '../src/acp/route.ts'
import type { Chunk } from '../src/acp/turn.ts'
import { clearWorkers, findQoder, type Cleared } from '../src/qoder/cli.ts'
import { clock, parseSample } from '../src/qoder/probe.ts'
import { creditRate, presentQoderModel, QODER_AUTH, QODER_PROVIDER, qoderProfile } from '../src/qoder/route.ts'
import { DaemonLog, daemonName, lineReader, RemoteWorkspaces, toolOf } from '../src/qoder/daemon.ts'
import { HOOK_SCRIPT, prepareWorkspace, withHooks } from '../src/qoder/worktree.ts'
import { exec } from '../src/exec.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

test('qoder: a model\'s credit rate follows its name', () => {
  assert.equal(creditRate('Reasoning · Vision · 0.50x Credit'), '0.5×')
  assert.equal(creditRate('2x Credit'), '2×')
  assert.equal(creditRate('Fast model'), undefined)
  assert.deepEqual(presentQoderModel({ id: 'qmodel_38max', name: 'Qwen3.8-Max', description: 'Reasoning · 1.00x Credit' }), { id: 'qmodel_38max', name: 'Qwen3.8-Max · 1×' })
  assert.deepEqual(presentQoderModel({ id: 'auto', name: 'Auto' }), { id: 'auto', name: 'Auto' })
})

test('qoder: the CLI is the override, else the installer\'s entry, else a real executable on PATH', () => {
  const exe = process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn'
  const entry = join('/home/me', '.qoder-cn', 'bin', 'qoderclicn', exe)
  assert.equal(findQoder({ QODERCN_CLI_BIN: '/opt/q' }, (path) => path === '/opt/q', '/home/me'), '/opt/q')
  assert.equal(findQoder({ QODERCN_CLI_BIN: '/gone' }, (path) => path === entry, '/home/me'), entry)
  const onPath = join('/usr/local/bin', exe)
  assert.equal(findQoder({ PATH: '/usr/local/bin' }, (path) => path === onPath, '/home/me'), onPath)
  assert.equal(findQoder({ PATH: '' }, () => false, '/home/me'), undefined)
})

// Lines as `qoderclicn remote-control --verbose` 1.1.73 printed them (shortened).
const STATUS = [
  '·✔· Connected · dsh-agent-hub · main',
  '    Capacity: 0/4 · New sessions will be created in new git worktrees',
  '    Active sessions:',
  '      (none)',
  '',
  '✓ Remote Control enabled — this machine is now accessible from the mobile app or browser',
  '    Scan the QR or visit: https://qoder.cn/agents/session/new?envId=env_01m54ef2eq3rkn9nf9rnfp4qyn',
]
const ID = 'qs_01m54ej2mrv1v61hkqp7c780ca'
const line = (event: object): string => `[${ID}] ${JSON.stringify(event)}`

test('qoder daemon log: status, a task from the glasses through its tools to its answer, then archived', () => {
  let now = 1_000
  const log = new DaemonLog(() => now)
  for (const text of STATUS) log.feed(text)
  assert.equal(log.phase, 'online')
  assert.equal(log.env, 'env_01m54ef2eq3rkn9nf9rnfp4qyn')
  assert.deepEqual(log.view(), [])

  log.feed(line({ type: 'system', subtype: 'remote_worker_init', permission_mode: 'auto' }))
  assert.equal(log.view()[0]!.phase, 'running')
  now = 2_000
  log.feed(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '在 README 文件末尾添加一行测试文字' }] }, parent_tool_use_id: null }))
  log.feed(line({ type: 'stream_event', event: { delta: 'x' } }))
  log.feed(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:/repo/.qoder/worktrees/x/README.md' } }] }, parent_tool_use_id: null }))
  log.feed(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] }, parent_tool_use_id: null }))
  // A subagent's step keeps the task busy without changing its tool line.
  log.feed(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] }, parent_tool_use_id: 'call_1' }))
  let task = log.view()[0]!
  assert.equal(task.prompt, '在 README 文件末尾添加一行测试文字')
  assert.equal(task.tool, 'Edit: README.md')
  assert.equal(task.url, `https://qoder.cn/agents/session/${ID}`)
  log.feed(line({ type: 'result', subtype: 'success', is_error: false, result: '已在 README.md 末尾添加了测试文字。' }))
  task = log.view()[0]!
  assert.equal(task.phase, 'idle')
  assert.equal(task.summary, '已在 README.md 末尾添加了测试文字。')

  // The next status block lists it (it keeps its worker), the one after does not: reclaimed, or archived in the app.
  for (const text of ['·✔· Connected · dsh-agent-hub · main', '    Capacity: 1/4 · x', '    Active sessions:', `      · https://qoder.cn/agents/session/${ID}`, '✓ Remote Control enabled']) log.feed(text)
  assert.equal(log.view()[0]!.phase, 'idle')
  assert.deepEqual(log.reapable(), { sessions: [ID], since: 2_000 })
  for (const text of ['    Capacity: 0/4 · x', '    Active sessions:', '      (none)', '✓ Remote Control enabled']) log.feed(text)
  assert.equal(log.view()[0]!.phase, 'dormant')
  assert.equal(log.reapable(), undefined)
  // Listed again (a follow-up woke it): answered, with a worker.
  for (const text of ['    Active sessions:', `      · https://qoder.cn/agents/session/${ID}`, 'next']) log.feed(text)
  assert.equal(log.view()[0]!.phase, 'idle')
})

test('qoder daemon log: a task gone while at work is closed and drops out after a while', () => {
  let now = 1_000
  const log = new DaemonLog(() => now)
  log.feed(line({ type: 'system', subtype: 'remote_worker_init', pid: 42 }))
  assert.equal(log.reapable(), undefined, 'a task at work holds every worker')
  for (const text of ['    Active sessions:', '      (none)', 'next']) log.feed(text)
  assert.equal(log.view()[0]!.phase, 'closed')
  assert.equal(log.view()[0]!.worker, undefined)
  now += 7 * 60 * 60_000
  assert.deepEqual(log.view(), [])
})

test('qoder daemon log: a worker started again for an answered task restores it and waits, its pid known', () => {
  const log = new DaemonLog(() => 5_000)
  for (const text of ['    Active sessions:', `      · https://qoder.cn/agents/session/${ID}`, 'next']) log.feed(text)
  assert.equal(log.view()[0]!.phase, 'starting')
  log.feed(line({ type: 'system', subtype: 'remote_worker_init', pid: 4242, hydrated_messages: 8 }))
  const task = log.view()[0]!
  assert.equal(task.phase, 'idle')
  assert.equal(task.restored, 8)
  assert.deepEqual(task.worker, { pid: 4242, startedAt: 5_000 })
  log.detach()
  assert.equal(log.view()[0]!.phase, 'dormant', 'the daemon exited with its workers')
  assert.equal(log.view()[0]!.worker, undefined)
})

test('qoder daemon log: a failure on the service\'s side marks the task failed, and stays so', () => {
  const log = new DaemonLog(() => 1)
  log.feed(line({ type: 'user', message: { content: [{ type: 'text', text: 'review every module' }] }, parent_tool_use_id: null }))
  log.feed(`[${ID}] [remote-control] status=failed error=Remote projection queue is unavailable`)
  log.feed(line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null }))
  log.feed(line({ type: 'result', subtype: 'error_during_execution', is_error: true }))
  log.feed(`[${ID}] detached (1/4, reason=exit:0, exit=graceful)`)
  for (const text of ['    Active sessions:', '      (none)', 'next']) log.feed(text)
  const task = log.view()[0]!
  assert.equal(task.phase, 'failed')
  assert.equal(task.error, 'Remote projection queue is unavailable')
  assert.equal(task.prompt, 'review every module')
})

test('qoder daemon: tool lines and the environment name stay short and printable', () => {
  assert.equal(toolOf('Bash', { command: 'wc -l  "README.md"' }), 'Bash: wc -l "README.md"')
  assert.equal(toolOf('Glob', { pattern: 'README*' }), 'Glob: README*')
  assert.equal(toolOf('TodoWrite', {}), 'TodoWrite')
  assert.equal(toolOf('Bash', { command: 'x'.repeat(200) }).length, 'Bash: '.length + 80)
  assert.equal(daemonName('C:\\Users\\vi\\pro\\dsh-agent-hub', 'VI-PC'), 'VI-PC / dsh-agent-hub')
  assert.equal(daemonName('/Users/me/项目', 'mac.local'), 'mac')
})

test('qoder worktrees: our hooks replace an earlier copy of themselves and keep everything else', () => {
  const before = { model: 'auto', hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: 'old', args: ['/old/qoder-worktree.cjs', 'create'] }, { type: 'command', command: 'mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }
  const after = withHooks(before, '/node', '/home/qoder-worktree.cjs') as { model: string; hooks: Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>> }
  assert.equal(after.model, 'auto')
  assert.deepEqual(after.hooks.Stop, before.hooks.Stop)
  assert.deepEqual(after.hooks.WorktreeCreate!.flatMap((group) => group.hooks.map((hook) => hook.command)), ['mine', '/node'])
  assert.deepEqual(after.hooks.WorktreeCreate!.at(-1)!.hooks[0]!.args, ['/home/qoder-worktree.cjs', 'create'])
  assert.deepEqual(after.hooks.WorktreeRemove!.at(-1)!.hooks[0]!.args, ['/home/qoder-worktree.cjs', 'remove'])
  assert.deepEqual(withHooks(after, '/node', '/home/qoder-worktree.cjs'), after)
})

async function repository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'qoder-trees-'))
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, timeoutMs: 20_000 })
  await git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  await git('add', 'a.txt')
  await git('commit', '-q', '-m', 'a')
  return repo
}

test('qoder worktrees: a repository gets the script, its local hooks, and both kept out of git status', async () => {
  const repo = await repository()
  const script = join(repo, '..', `${Date.now()}-qoder-worktree.cjs`)
  writeFileSync(join(repo, '.qoder-keep'), '')
  await prepareWorkspace(repo, { node: process.execPath, script })
  await prepareWorkspace(repo, { node: process.execPath, script })
  assert.equal(await readFile(script, 'utf8'), HOOK_SCRIPT)
  const settings = JSON.parse(await readFile(join(repo, '.qoder', 'settings.local.json'), 'utf8')) as { hooks: Record<string, unknown[]> }
  assert.equal(settings.hooks.WorktreeCreate!.length, 1)
  const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.match(/^\/\.worktrees\/$/gm)?.length, 1)
  assert.equal(exclude.match(/^\/\.qoder\/settings\.local\.json$/gm)?.length, 1)
  const status = await exec('git', ['status', '--porcelain'], { cwd: repo, timeoutMs: 20_000 })
  assert.equal(status.stdout.trim(), '?? .qoder-keep')
})

test('qoder worktrees: the hook makes a task\'s tree under .worktrees/qoder, reuses it, and removes it only when clean', async () => {
  const repo = await repository()
  const script = join(repo, '..', `${Date.now()}-hook.cjs`)
  writeFileSync(script, HOOK_SCRIPT)
  const hook = (op: string, input: object) => spawnSync(process.execPath, [script, op], { input: JSON.stringify(input), encoding: 'utf8' })
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim()

  const created = hook('create', { hook_event_name: 'WorktreeCreate', cwd: repo, name: 'qs_01abc' })
  assert.equal(created.status, 0, created.stderr)
  const tree = join(repo, '.worktrees', 'qoder', 'qs_01abc')
  assert.equal(created.stdout, tree)
  assert.equal(git(tree, 'branch', '--show-current'), 'qoder/qs_01abc')
  assert.equal(hook('create', { cwd: repo, name: 'qs_01abc' }).stdout, tree, 'a resumed task gets its tree back')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the trees stay out of the main tree\'s status')

  writeFileSync(join(tree, 'a.txt'), 'changed\n')
  const kept = hook('remove', { cwd: repo, worktree_path: tree })
  assert.equal(JSON.parse(kept.stdout).hookSpecificOutput.status, 'retained')
  assert.ok(existsSync(tree), 'a tree with changes stays for review')

  spawnSync('git', ['checkout', '--', 'a.txt'], { cwd: tree })
  const removed = hook('remove', { cwd: repo, worktree_path: tree })
  assert.equal(JSON.parse(removed.stdout).hookSpecificOutput.status, 'removed')
  assert.ok(!existsSync(tree))
  assert.equal(git(repo, 'branch', '--list', 'qoder/*'), '', 'its branch had no commits of its own')

  const elsewhere = hook('remove', { cwd: repo, worktree_path: join(repo, '.worktrees', 'feat') })
  assert.equal(JSON.parse(elsewhere.stdout).hookSpecificOutput.status, 'retained', 'only Qoder\'s own trees are touched')
  assert.notEqual(hook('create', { cwd: repo, name: '' }).status, 0)
})

/** Let a start's preparation finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A stand-in daemon process: its output is written by the test. */
class FakeDaemon extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 1
  killed = false
  exit(code: number | null): void {
    this.emit('exit', code)
  }
}

test('qoder daemons: one per workspace, online from its output, stopped and started by hand, restarted when it exits', async () => {
  const spawned: Array<{ args: readonly string[]; child: FakeDaemon }> = []
  const settings = { workspaces: ['/repo'], idleMinutes: 10, autoStart: true }
  const workspaces = new RemoteWorkspaces({
    settings: () => settings,
    find: () => '/bin/qoderclicn',
    log: () => {},
    spawn: (_command, args) => {
      const child = new FakeDaemon()
      spawned.push({ args, child })
      return child as unknown as ChildProcess
    },
    prepare: async () => {},
    kill: (child) => { (child as unknown as FakeDaemon).killed = true; (child as unknown as FakeDaemon).exit(null) },
  })
  try {
    workspaces.sync()
    await settle()
    assert.equal(spawned.length, 1)
    const args = spawned[0]!.args
    assert.deepEqual(args.slice(0, 1), ['remote-control'])
    assert.equal(args[args.indexOf('--spawn') + 1], 'same-dir')
    assert.ok(!args.includes('--capacity'), 'the CLI\'s own cap')
    assert.equal(args[args.indexOf('--directory') + 1], '/repo')
    assert.equal(workspaces.status().workspaces[0]!.phase, 'starting')

    spawned[0]!.child.stdout.write(`${STATUS.join('\n')}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    const online = workspaces.status().workspaces[0]!
    assert.equal(online.phase, 'online')
    assert.equal(online.env, 'env_01m54ef2eq3rkn9nf9rnfp4qyn')

    workspaces.stop('/repo')
    assert.equal(spawned[0]!.child.killed, true)
    assert.equal(workspaces.status().workspaces[0]!.phase, 'stopped')
    workspaces.sync()
    await settle()
    assert.equal(spawned.length, 1, 'stopped by hand stays stopped')

    workspaces.start('/repo')
    await settle()
    assert.equal(spawned.length, 2)
    spawned[1]!.child.exit(1)
    const retrying = workspaces.status().workspaces[0]!
    assert.equal(retrying.phase, 'retrying')
    assert.match(retrying.error!, /exited with code 1/)

    settings.workspaces = []
    workspaces.sync()
    assert.deepEqual(workspaces.status().workspaces, [])
  } finally {
    workspaces.dispose()
  }
})

test('qoder daemons: without the CLI nothing starts and the panel says how to install it', () => {
  const workspaces = new RemoteWorkspaces({
    settings: () => ({ workspaces: ['/repo'], idleMinutes: 10, autoStart: true }),
    find: () => undefined,
    log: () => {},
    prepare: async () => {},
    spawn: () => { throw new Error('must not start') },
  })
  try {
    workspaces.sync()
    const status = workspaces.status()
    assert.equal(status.installed, false)
    assert.equal(status.workspaces[0]!.phase, 'stopped')
    assert.match(status.workspaces[0]!.error!, /install/)
  } finally {
    workspaces.dispose()
  }
})

/**
 * A minimal ACP agent in two shapes: Qoder's (the model as a config option,
 * described with its credit rate) and the older `models` + `session/set_model`
 * one Hermes speaks.
 */
class FakeAcp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  started: string[] = []
  sessions = new Set<string>()
  signedOut = false
  private shape: 'option' | 'models'
  constructor(shape: 'option' | 'models') {
    this.shape = shape
  }

  child(key: string): Child {
    this.started.push(key)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let buffer = ''
    const send = (message: object): void => { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
    let next = 1000
    const pending = new Map<number, (result: unknown) => void>()
    const ask = (method: string, params: object): Promise<unknown> => new Promise((resolve) => {
      const id = next++
      pending.set(id, resolve)
      send({ id, method, params })
    })
    stdin.on('data', (data) => {
      buffer += String(data)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
        buffer = buffer.slice(end + 1)
        if (message.method === undefined) {
          pending.get(message.id!)?.(message.result)
          continue
        }
        this.calls.push({ method: message.method, params: message.params ?? {} })
        void this.handle(message.method, message.params ?? {}, send, ask).then((result) => {
          if (message.id !== undefined) send(result instanceof Error ? { id: message.id, error: { code: -32000, message: result.message } } : { id: message.id, result })
        })
      }
    })
    const exits: Array<(code: number | null) => void> = []
    return {
      stdin, stdout, stderr: null,
      kill: () => { for (const exit of exits) exit(null) },
      once: (event: string, listener: (value: never) => void) => { if (event === 'exit') exits.push(listener as (code: number | null) => void) },
    }
  }

  private info(id: string, current = 'auto'): object {
    const models = [{ modelId: 'auto', name: 'Auto' }, { modelId: 'qmodel_38max', name: 'Qwen3.8-Max', description: 'Reasoning · 1.00x Credit' }, { modelId: 'glm', name: 'GLM-5.3', description: '0.50x Credit' }]
    if (this.shape === 'models') return { sessionId: id, models: { availableModels: models, currentModelId: current } }
    return {
      sessionId: id,
      configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current, options: models.map((model) => ({ value: model.modelId, name: model.name })) }],
      models: { availableModels: models, currentModelId: current },
    }
  }

  private async handle(method: string, params: Record<string, unknown>, send: (message: object) => void, ask: (method: string, params: object) => Promise<unknown>): Promise<unknown> {
    const update = (sessionId: string, value: object): void => send({ method: 'session/update', params: { sessionId, update: value } })
    switch (method) {
      case 'initialize':
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      case 'session/new': {
        if (this.signedOut) return new Error('Authentication required')
        const id = `s${this.sessions.size + 1}`
        this.sessions.add(id)
        return this.info(id)
      }
      case 'session/load':
        return this.sessions.has(String(params.sessionId)) ? this.info(String(params.sessionId)) : new Error('Session not found')
      case 'session/set_config_option':
        return { configOptions: (this.info(String(params.sessionId), String(params.value)) as { configOptions: unknown }).configOptions }
      case 'session/set_model':
        return {}
      case 'session/prompt': {
        const id = String(params.sessionId)
        const answer = await ask('session/request_permission', {
          sessionId: id,
          toolCall: { toolCallId: 't1', title: 'README.md', kind: 'edit', rawInput: { file_path: 'README.md' } },
          options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }],
        })
        update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(answer) } })
        return { stopReason: 'end_turn' }
      }
      default:
        return new Error(`unexpected ${method}`)
    }
  }
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function request(provider: string, model: string, messages: object[], sessionId = 'dsh-1'): StreamOptions {
  const options = { provider, model, sessionId, messages } as unknown as StreamOptions
  markAgentLoopRequest(options)
  return options
}

async function drain(stream: AsyncIterable<object>): Promise<Chunk<unknown>[]> {
  const chunks: Chunk<unknown>[] = []
  for await (const chunk of stream) chunks.push(chunk as Chunk<unknown>)
  return chunks
}

const host = (fake: FakeAcp, approvals: object[] = []) => ({
  agents: () => ({ currentInitiator: () => ({ session: { header: { cwd: tmpdir() } } }) }),
  approval: () => ({ request: async (value: object) => { approvals.push(value); return 'allowed-once' } }),
  log: () => {},
  spawn: (process: { key: string }) => fake.child(process.key),
})

test('qoder route: models come from a probe session, with their credit rate', async () => {
  const fake = new FakeAcp('option')
  const route = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), host(fake))
  try {
    const models = await route.listModels(QODER_PROVIDER)
    assert.deepEqual(models.map((model) => model.name), ['Auto', 'Qwen3.8-Max · 1×', 'GLM-5.3 · 0.5×'])
    assert.equal(fake.calls.filter((call) => call.method === 'session/prompt').length, 0, 'the probe sends no prompt')
  } finally {
    route.dispose()
  }
})

test('qoder route: a turn switches model by config option, asks DSH to approve, and the next turn loads the session', async () => {
  const fake = new FakeAcp('option')
  const approvals: object[] = []
  const route = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), host(fake, approvals))
  try {
    const chunks = await drain(route.stream(request(QODER_PROVIDER, 'glm', [user('add a line')])))
    assert.deepEqual(fake.calls.filter((call) => call.method === 'session/set_config_option').map((call) => [call.params.configId, call.params.value]), [['model', 'glm']])
    assert.equal(approvals.length, 1)
    const finish = chunks.at(-1) as { type: 'finish'; replayState: { acp: { session: string; process: string } } }
    assert.deepEqual(finish.replayState.acp, { session: 's1', process: 'qoder' })

    route.dispose()
    const again = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), host(fake, approvals))
    try {
      fake.calls = []
      const replied = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: QODER_PROVIDER, model: 'glm', replayState: finish.replayState } }
      await drain(again.stream(request(QODER_PROVIDER, 'glm', [user('add a line'), replied, user('and another')])))
      const methods = fake.calls.map((call) => call.method).filter((method) => method !== 'session/request_permission')
      assert.deepEqual(methods.slice(0, 2), ['initialize', 'session/load'])
      assert.equal((fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>)[0]!.text, 'and another')
    } finally {
      again.dispose()
    }
  } finally {
    route.dispose()
  }
})

test('qoder route: a signed-out CLI fails the turn with the sign-in hint', async () => {
  const fake = new FakeAcp('option')
  fake.signedOut = true
  const route = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), host(fake))
  try {
    await assert.rejects(drain(route.stream(request(QODER_PROVIDER, 'auto', [user('hi')]))), (error: { code?: string; message: string }) => {
      assert.equal(error.code, QODER_AUTH)
      assert.match(error.message, /qodercn/)
      return true
    })
  } finally {
    route.dispose()
  }
})

test('acp route: a profile with a process per model (the shape Hermes personas take) pools by key and uses session/set_model', async () => {
  const fake = new FakeAcp('models')
  const personas: AcpProfile = {
    provider: 'hermes-agent',
    name: 'Hermes',
    process: (model) => ({ key: model, command: '/bin/hermes-acp', args: [], env: { HERMES_HOME: `/hermes/profiles/${model}` } }),
    missing: 'install hermes',
    signIn: 'sign in',
    authCode: 'HERMES_AUTH',
    models: async () => [{ id: 'minima', name: 'Hermes · minima' }, { id: 'qweno', name: 'Hermes · qweno' }],
    agentModel: () => undefined,
  }
  const route = new AcpRoute(personas, host(fake))
  try {
    assert.deepEqual((await route.listModels('hermes-agent')).map((model) => model.id), ['minima', 'qweno'])
    await drain(route.stream(request('hermes-agent', 'minima', [user('hi')], 'a')))
    await drain(route.stream(request('hermes-agent', 'qweno', [user('hi')], 'b')))
    await drain(route.stream(request('hermes-agent', 'minima', [user('hi')], 'c')))
    assert.deepEqual(fake.started, ['minima', 'qweno'], 'one process per persona, shared by its sessions')
    assert.equal(fake.calls.filter((call) => call.method === 'session/set_model' || call.method === 'session/set_config_option').length, 0, 'a persona keeps its own model')
  } finally {
    route.dispose()
  }
})

test('acp route: the older models shape switches with session/set_model', async () => {
  const fake = new FakeAcp('models')
  const profile: AcpProfile = { ...qoderProfile(() => '/bin/x'), provider: 'old-agent' }
  const route = new AcpRoute(profile, host(fake))
  try {
    await drain(route.stream(request('old-agent', 'glm', [user('hi')])))
    assert.deepEqual(fake.calls.filter((call) => call.method === 'session/set_model').map((call) => call.params.modelId), ['glm'])
  } finally {
    route.dispose()
  }
})

test('qoder daemons: lines split across chunks, and an endless line is dropped, not buffered', () => {
  const lines: string[] = []
  const read = lineReader((line) => lines.push(line))
  read('one\ntw')
  read('o\nthr')
  read('ee\n')
  read('x'.repeat((1 << 20) + 10))
  read('still the long one\nafter\n')
  assert.deepEqual(lines, ['one', 'two', 'three', 'after'])
})

test('qoder daemons: the revision moves only with what the panel shows', () => {
  const log = new DaemonLog(() => 1000)
  log.feed('[qs_a] {"type":"system","subtype":"remote_worker_init"}')
  const started = log.revision
  assert.ok(started > 0)
  log.feed('[qs_a] {"type":"stream_event","event":{"type":"content_block_delta"}}')
  log.feed(`[qs_a] {"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"${'x'.repeat(5000)}"}]}}`)
  assert.equal(log.revision, started, 'token deltas and tool results change nothing')
  log.feed('[qs_a] {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/r/README.md"}}]}}')
  const reading = log.revision
  assert.ok(reading > started)
  log.feed('[qs_a] {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/r/README.md"}}]}}')
  assert.equal(log.revision, reading, 'the same tool again changes nothing')
  log.feed('    Capacity: 1/8 · New sessions will be created in new git worktrees')
  const counted = log.revision
  log.feed('    Capacity: 1/8 · New sessions will be created in new git worktrees')
  assert.equal(log.revision, counted)
})

test('qoder daemons: a status read answers at once when behind, else waits for the next change', async () => {
  const workspaces = new RemoteWorkspaces({
    settings: () => ({ workspaces: ['/repo'], idleMinutes: 10, autoStart: false }),
    find: () => 'qoderclicn',
    log: () => {},
    prepare: async () => {},
    spawn: () => { throw new Error('must not start') },
  })
  try {
    workspaces.sync()
    const first = await workspaces.wait(undefined, undefined)
    let answered: Awaited<ReturnType<typeof workspaces.wait>> | undefined
    const waiting = workspaces.wait(first.boot, first.epoch).then((update) => { answered = update })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(answered, undefined, 'nothing changed: still waiting')
    workspaces.sync()
    await waiting
    assert.ok(answered!.epoch > first.epoch)
    const stale = await workspaces.wait('another host run', first.epoch)
    assert.equal(stale.boot, first.boot, 'a restarted host answers at once')
  } finally {
    workspaces.dispose()
  }
})

test('acp route: a turn that starts its process says so first; a warm one does not', async () => {
  const fake = new FakeAcp('option')
  const route = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), host(fake))
  const notes = (chunks: Chunk<unknown>[]) => chunks.flatMap((chunk) => (chunk.type === 'block-end' && chunk.block.type === 'reasoning' ? [chunk.block.text] : []))
  try {
    const cold = await drain(route.stream(request(QODER_PROVIDER, 'auto', [user('hi')], 'a')))
    assert.deepEqual(notes(cold), ['⏳ Starting Qoder…'])
    assert.equal(cold[0]!.type, 'block-start', 'before anything else')
    const warm = await drain(route.stream(request(QODER_PROVIDER, 'auto', [user('hi')], 'b')))
    assert.deepEqual(notes(warm), [])
  } finally {
    route.dispose()
  }
})

type Samples = Map<number, { rss: number; cpuMs: number; startedAt?: number }>

/** A workspace's daemons with every seam faked: the started daemons, the workers files emptied before each start, the probe's reader. */
function harness(settings: { workspaces: string[]; idleMinutes: number; autoStart: boolean }, clear: Cleared | (() => Cleared) = 'cleared', held?: (path: string) => boolean, alive: (pid: number) => boolean = () => false) {
  const spawned: FakeDaemon[] = []
  const clears: string[] = []
  let read: ((samples: Samples) => void) | undefined
  let probes = 0
  const workspaces = new RemoteWorkspaces({
    settings: () => settings,
    find: () => '/bin/qoderclicn',
    log: () => {},
    prepare: async () => {},
    spawn: () => {
      const child = new FakeDaemon()
      child.pid = 100 + spawned.length
      spawned.push(child)
      return child as unknown as ChildProcess
    },
    kill: (child) => { (child as unknown as FakeDaemon).exit(null) },
    clear: (path) => { clears.push(path); return typeof clear === 'function' ? clear() : clear },
    alive,
    ...(held === undefined ? {} : { held }),
    probe: (reader) => {
      probes++
      read = reader
      return () => { read = undefined }
    },
  })
  const say = async (child: FakeDaemon, ...lines: string[]): Promise<void> => {
    child.stdout.write(`${lines.join('\n')}\n`)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { workspaces, spawned, clears, say, sample: (samples: Samples) => read?.(samples), probes: () => probes }
}

const ANSWERED = [
  ...STATUS.slice(0, 2), '    Active sessions:', `      · https://qoder.cn/agents/session/${ID}`, '✓ Remote Control enabled',
  line({ type: 'system', subtype: 'remote_worker_init', pid: 4242 }),
  line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null }),
  line({ type: 'result', subtype: 'success', is_error: false, result: 'hello' }),
]
const other = (event: object): string => `[qs_other] ${JSON.stringify(event)}`

test('qoder daemons: answered and idle, the workers are reclaimed by starting the daemon again without them', async () => {
  const { workspaces, spawned, clears, say } = harness({ workspaces: ['/repo'], idleMinutes: 10, autoStart: true })
  try {
    workspaces.sync()
    await settle()
    const before = Date.now()
    await say(spawned[0]!, ...ANSWERED)
    let view = workspaces.status().workspaces[0]!
    assert.equal(view.tasks[0]!.phase, 'idle')
    assert.equal(view.tasks[0]!.worker?.pid, 4242)
    assert.equal(view.daemon?.pid, 100)
    assert.ok(view.reapAt! >= before + 10 * 60_000 && view.reapAt! <= Date.now() + 10 * 60_000, 'ten minutes after it answered')

    // A new task at work, not listed yet, holds the reclaim.
    await say(spawned[0]!, other({ type: 'system', subtype: 'remote_worker_init', pid: 4343 }))
    assert.equal(workspaces.status().workspaces[0]!.reapAt, undefined)
    workspaces.reap('/repo')
    assert.equal(spawned.length, 1, 'not while a task is at work')
    await say(spawned[0]!, other({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
      '    Active sessions:', `      · https://qoder.cn/agents/session/${ID}`, '      · https://qoder.cn/agents/session/qs_other', '✓ Remote Control enabled')
    assert.ok(workspaces.status().workspaces[0]!.reapAt !== undefined)

    workspaces.reap('/repo')
    await settle()
    assert.deepEqual(clears, ['/repo', '/repo'], 'every start, the first one too, begins with its workers file emptied')
    assert.equal(spawned.length, 2, 'started again')
    view = workspaces.status().workspaces[0]!
    assert.equal(view.reaped.workers, 2)
    assert.ok(view.reaped.at !== undefined)
    assert.deepEqual(view.tasks.map((task) => task.phase), ['dormant', 'dormant'])
    assert.equal(view.reapAt, undefined, 'nothing left to reclaim')
  } finally {
    workspaces.dispose()
  }
})

test('qoder daemons: while a dsh command waits on a worker in the workspace, nothing is reclaimed; refresh times it again', async () => {
  let holding = true
  const { workspaces, spawned, say } = harness({ workspaces: ['/repo'], idleMinutes: 10, autoStart: true }, 'cleared', () => holding)
  try {
    workspaces.sync()
    await settle()
    await say(spawned[0]!, ...ANSWERED)
    let view = workspaces.status().workspaces[0]!
    assert.equal(view.reapAt, undefined)
    assert.equal(view.held, true)
    workspaces.reap('/repo')
    await settle()
    assert.equal(spawned.length, 1, 'the inbox worker stays up')
    holding = false
    workspaces.refresh()
    view = workspaces.status().workspaces[0]!
    assert.equal(view.held, undefined)
    assert.ok(view.reapAt !== undefined, 'timed again once released')
  } finally {
    workspaces.dispose()
  }
})

test('qoder daemons: a start waits for the last run\'s workers to exit and retries a file not ready', async () => {
  let live = true
  let answers: Cleared[] = ['cleared', 'retry', 'cleared']
  const { workspaces, spawned, clears, say } = harness({ workspaces: ['/repo'], idleMinutes: 10, autoStart: true }, () => answers.shift() ?? 'cleared', undefined, (pid) => live && pid === 4242)
  try {
    workspaces.sync()
    await settle()
    assert.equal(clears.length, 1, 'the first start too begins with its workers file emptied')
    await say(spawned[0]!, ...ANSWERED)
    workspaces.reap('/repo')
    await settle()
    assert.equal(clears.length, 1, 'not while its worker still exits')
    assert.equal(spawned.length, 1, 'nor started again: it would fight the exiting workers for the broker')
    assert.equal(workspaces.status().workspaces[0]!.phase, 'starting')
    live = false
    for (let tries = 0; spawned.length < 2 && tries < 60; tries++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(clears.length, 3, 'a file not ready is tried again')
    assert.equal(spawned.length, 2)
    const view = workspaces.status().workspaces[0]!
    assert.equal(view.reaped.workers, 1)
    assert.equal(view.unreapable, undefined)
    assert.deepEqual(view.tasks.map((task) => task.phase), ['dormant'], 'no worker restored for it')
  } finally {
    answers = []
    workspaces.dispose()
  }
})

test('qoder daemons: a workers file in a format this does not know: its workers come back, no reclaims, the panel says why; 0 minutes never schedules one', async () => {
  const broken = harness({ workspaces: ['/repo'], idleMinutes: 10, autoStart: true }, 'unknown')
  try {
    broken.workspaces.sync()
    await settle()
    await broken.say(broken.spawned[0]!, ...ANSWERED)
    broken.workspaces.reap('/repo')
    await settle()
    assert.equal(broken.spawned.length, 1, 'a restart would only bring them back')
    assert.equal(broken.workspaces.status().workspaces[0]!.reapAt, undefined)
    assert.equal(broken.workspaces.status().workspaces[0]!.reaped.workers, 0)
    assert.equal(broken.workspaces.status().workspaces[0]!.unreapable, true, 'the panel says why')
  } finally {
    broken.workspaces.dispose()
  }
  const kept = harness({ workspaces: ['/repo'], idleMinutes: 0, autoStart: true })
  try {
    kept.workspaces.sync()
    await settle()
    await kept.say(kept.spawned[0]!, ...ANSWERED)
    const view = kept.workspaces.status().workspaces[0]!
    assert.equal(view.idleMinutes, 0)
    assert.equal(view.reapAt, undefined)
  } finally {
    kept.workspaces.dispose()
  }
})

test('qoder daemons: processes are sampled while a panel reads, their CPU over the interval', async () => {
  const { workspaces, spawned, say, sample, probes } = harness({ workspaces: ['/repo'], idleMinutes: 10, autoStart: true })
  try {
    workspaces.sync()
    await settle()
    await say(spawned[0]!, ...ANSWERED)
    assert.equal(probes(), 0, 'nobody reads yet')
    await workspaces.wait(undefined, undefined)
    assert.equal(probes(), 1)
    sample(new Map([[100, { rss: 200 << 20, cpuMs: 1_000 }], [4242, { rss: 250 << 20, cpuMs: 5_000, startedAt: 7 }], [999, { rss: 1, cpuMs: 1 }]]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    sample(new Map([[100, { rss: 201 << 20, cpuMs: 1_000 }], [4242, { rss: 250 << 20, cpuMs: 5_025 }]]))
    const view = workspaces.status().workspaces[0]!
    assert.equal(view.daemon?.rss, 201 << 20)
    assert.equal(view.daemon?.cpu, 0)
    const worker = view.tasks[0]!.worker!
    assert.equal(worker.rss, 250 << 20)
    assert.equal(worker.startedAt, 7)
    assert.ok(worker.cpu! > 0 && worker.cpu! <= 50, `${worker.cpu}`)
  } finally {
    workspaces.dispose()
  }
})

test('qoder probe: both helpers\' lines, and the clock formats ps writes', () => {
  assert.equal(clock('1-02:03:04'), ((24 + 2) * 3600 + 3 * 60 + 4) * 1000)
  assert.equal(clock('03:04'), 184_000)
  assert.equal(clock('0:01.25'), 1_250)
  assert.deepEqual(parseSample('15468 282255360 43906 1792264144597', true), [15468, { rss: 282255360, cpuMs: 43906, startedAt: 1792264144597 }])
  assert.equal(parseSample('@', true), undefined)
  assert.deepEqual(parseSample('  812 251904 00:00:42 01:00 /home/me/.qoder-cn/bin/qoderclicn', false, 100_000), [812, { rss: 251904 * 1024, cpuMs: 42_000, startedAt: 40_000 }])
})

test('qoder workers files: every instance of the folder emptied with its dead daemon\'s broker lock, one a running daemon claims left alone, an unknown format left alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qoder-home-'))
  const instance = (id: string, meta: object, workers: object): string => {
    // As Qoder CLI CN 1.1.73 lays them out: a family, then a scope per account and service.
    const dir = join(home, '.qoder-cn', 'remote-control', 'bridge-push-family', 'f00d', 'instances', id)
    mkdirSync(join(dir, 'workers'), { recursive: true })
    mkdirSync(join(dir, 'broker', 'owners', 'abc.owner.lock'), { recursive: true })
    writeFileSync(join(dir, 'instance.json'), JSON.stringify(meta))
    writeFileSync(join(dir, 'workers', 'remote-control-workers.json'), JSON.stringify(workers))
    return join(dir, 'workers', 'remote-control-workers.json')
  }
  const repo = process.platform === 'win32' ? 'C:\repo' : '/repo'
  const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))
  const old = instance('a', { name: 'old name', sourceCwd: repo, claim: { pid: 7 } }, { version: 4, workers: { qs_old: {} } })
  const mine = instance('b', { name: 'PC / repo', sourceCwd: repo, claim: { pid: 100 } }, { version: 4, workers: { qs_a: { state: 'idle' }, qs_b: { state: 'idle' } }, pendingTitles: { qs_a: 'x' } })
  const other = instance('c', { name: 'elsewhere', sourceCwd: repo + 'x' }, { version: 4, workers: { qs_c: {} } })
  const terminal = instance('d', { name: 'a terminal', sourceCwd: repo, claim: { pid: 55 } }, { version: 4, workers: { qs_d: {} } })
  const notes: string[] = []
  assert.equal(clearWorkers(repo, (pid) => pid === 55, (message) => notes.push(message), home), 'cleared')
  const lock = (file: string): boolean => existsSync(join(file, '..', '..', 'broker', 'owners', 'abc.owner.lock'))
  assert.equal(lock(mine), false, 'the exited daemon\'s broker lock removed')
  assert.equal(lock(terminal), true, 'a running daemon\'s lock kept')
  assert.equal(lock(other), true)
  assert.equal(notes.filter((note) => note.includes('2 idle')).length, 1)
  assert.deepEqual(await read(old), { version: 4, workers: {} })
  assert.deepEqual(await read(mine), { version: 4, workers: {}, pendingTitles: { qs_a: 'x' } }, 'the rest of the file kept')
  assert.deepEqual(await read(other), { version: 4, workers: { qs_c: {} } }, 'another folder')
  assert.deepEqual(await read(terminal), { version: 4, workers: { qs_d: {} } }, 'a running daemon\'s own')
  const future = instance('e', { name: 'x', sourceCwd: repo }, { version: 5, workers: { qs_a: {} } })
  assert.equal(clearWorkers(repo, () => false, undefined, home), 'unknown')
  assert.deepEqual(await read(future), { version: 5, workers: { qs_a: {} } })
  writeFileSync(future, '{"version":4,"work')
  assert.equal(clearWorkers(repo, () => false, undefined, home), 'retry', 'half written')
})

test('acp route: a taken-over session\'s first turn loads the agent\'s session the seed names, then follows its own replies', async () => {
  const fake = new FakeAcp('option')
  fake.sessions.add('qs_glasses')
  const seeds: string[] = []
  const route = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), {
    ...host(fake),
    seed: async (sessionId: string) => {
      seeds.push(sessionId)
      return { resume: 'qs_glasses', context: async () => 'TRANSCRIPT' }
    },
  })
  try {
    const chunks = await drain(route.stream(request(QODER_PROVIDER, 'auto', [user('go on')], 'dsh-taken')))
    assert.deepEqual(seeds, ['dsh-taken'])
    assert.deepEqual(fake.calls.find((call) => call.method === 'session/load')?.params.sessionId, 'qs_glasses')
    assert.equal(fake.calls.some((call) => call.method === 'session/new'), false)
    const prompt = (fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>)[0]!.text
    assert.equal(prompt, 'go on', 'a loaded session has its history: no transcript')
    const finish = chunks.at(-1) as { replayState: { acp: { session: string } } }
    assert.equal(finish.replayState.acp.session, 'qs_glasses')

    // Once it has a reply of its own the seed is not asked again.
    const replied = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: QODER_PROVIDER, model: 'auto', replayState: finish.replayState } }
    await drain(route.stream(request(QODER_PROVIDER, 'auto', [user('go on'), replied, user('more')], 'dsh-taken')))
    assert.deepEqual(seeds, ['dsh-taken'])
  } finally {
    route.dispose()
  }
})

test('acp route: a seeded session the agent cannot load starts over with the transcript ahead of the prompt', async () => {
  const fake = new FakeAcp('models')
  const route = new AcpRoute(qoderProfile(() => '/bin/qoderclicn'), {
    ...host(fake),
    seed: async () => ({ resume: 'qs_gone', context: async () => 'User: hello\n\nAssistant: hi' }),
  })
  try {
    await drain(route.stream(request(QODER_PROVIDER, 'auto', [user('and then?')], 'dsh-hermes')))
    assert.ok(fake.calls.some((call) => call.method === 'session/new'))
    const prompt = (fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>)[0]!.text
    assert.match(prompt, /^<system-reminder>\nUser: hello\n\nAssistant: hi\n<\/system-reminder>\n\n/)
    assert.ok(prompt.endsWith('and then?'))
  } finally {
    route.dispose()
  }
})
