import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Bridge, ChooseError, gist, type BridgeHost, type BridgeEvent } from '../src/bridge/service.ts'
import { startBridgeServer } from '../src/bridge/server.ts'
import { BRIDGE_FILE, cliScript, installCli, SKILL, SKILL_EN, withPath } from '../src/bridge/cli.ts'
import { findPty, glassesTargets, installPost, post, POST_HEADER, POST_HEADER_EN, POST_SCRIPT } from '../src/bridge/post.ts'
import { setLocaleSource } from '../src/locale.ts'
import type { TaskView, WorkspaceView } from '../src/qoder/types.ts'
import { GlassesHub } from '../src/client/glasses/hub.ts'

const run = promisify(execFile)

// The glasses speak Chinese here; the English tests switch for their own run.
setLocaleSource(() => 'zh')

const GROUPS = [
  { id: 'claude-agent', name: 'Claude Agent', models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }] },
  { id: 'openai-codex', name: 'Codex', models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini' }] },
]

function fixture(overrides: Partial<BridgeHost> = {}) {
  const started: Array<{ cwd: string; workspaceId?: string; title: string; route?: { provider: string; model: string } }> = []
  const sent: Array<[string, string]> = []
  const cancelled: string[] = []
  let changes = 0
  const bridge = new Bridge({
    sessions: () => ({
      start: async (input) => { started.push(input); return `s${started.length}` },
      send: async (session, text) => { sent.push([session, text]) },
      cancel: async (session) => { cancelled.push(session) },
    }),
    catalog: () => ({
      listProviders: () => GROUPS.map(({ id, name }) => ({ id, name })),
      listModels: async (provider: string) => GROUPS.find((group) => group.id === provider)?.models ?? [],
    }),
    defaultRoute: () => ({ provider: 'claude-agent', model: 'claude-sonnet-5-5' }),
    bots: () => [{ id: 'reviewer', description: 'Reads diffs' }],
    workspaces: () => [
      { id: 'w1', path: join('/work', 'vimental'), title: 'vimental' },
      { id: 'w2', path: join('/work', 'vimental-web'), title: 'vimental-web' },
      { id: 'w3', path: join('/work', 'hub'), title: 'DSH Hub' },
    ],
    isDirectory: () => false,
    holdsChanged: () => { changes++ },
    ...overrides,
  })
  const emit = (session: string, type: string, data: Record<string, unknown> = {}): void =>
    bridge.observe({ header: { id: session, cwd: '/work/hub' } }, { type, data, time: Date.now() } satisfies BridgeEvent)
  const answer = (session: string, text: string): void => {
    emit(session, 'turn/start')
    emit(session, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    emit(session, 'turn/end', { reason: { kind: 'completed' } })
  }
  return { bridge, started, sent, cancelled, emit, answer, changes: () => changes }
}

test('bridge: spoken agent names, model fragments and bots pick a route; DSH\'s default when none is named', async () => {
  const { bridge } = fixture()
  assert.deepEqual(await bridge.route(undefined, undefined), { provider: 'claude-agent', model: 'claude-sonnet-5-5' })
  assert.deepEqual(await bridge.route('claude', undefined), { provider: 'claude-agent', model: 'claude-sonnet-5-5' }, 'the default model of that agent')
  assert.deepEqual(await bridge.route('Codex', undefined), { provider: 'openai-codex', model: 'gpt-5.5' }, 'else its first')
  assert.deepEqual(await bridge.route('claude', 'opus'), { provider: 'claude-agent', model: 'claude-opus-5-5' })
  assert.deepEqual(await bridge.route('codex', 'gpt-5.5'), { provider: 'openai-codex', model: 'gpt-5.5' }, 'an exact id wins over the longer one')
  assert.deepEqual(await bridge.route('bot:reviewer', undefined), { provider: 'agent-hub-bot', model: 'reviewer' })
  assert.deepEqual(await bridge.route('reviewer', undefined), { provider: 'agent-hub-bot', model: 'reviewer' })
  await assert.rejects(bridge.route('codex', 'mini-x'), ChooseError)
  await assert.rejects(bridge.route('gemini', undefined), (error: Error) => error instanceof ChooseError && /Claude Agent, Codex/.test(error.message))
})

test('bridge: a project by name, prefix or path; ambiguity lists the choices; none means the caller\'s folder', () => {
  const { bridge } = fixture()
  assert.deepEqual(bridge.place('vimental', '/tmp'), { cwd: join('/work', 'vimental'), workspaceId: 'w1' }, 'exact beats the prefix it shares')
  assert.deepEqual(bridge.place('hub', '/tmp'), { cwd: join('/work', 'hub'), workspaceId: 'w3' }, 'the folder name counts too')
  assert.throws(() => bridge.place('vim', '/tmp'), (error: Error) => error instanceof ChooseError && /vimental, vimental-web/.test(error.message))
  assert.deepEqual(bridge.place(undefined, join('/work', 'hub', 'src')), { cwd: join('/work', 'hub', 'src'), workspaceId: 'w3' })
  assert.deepEqual(bridge.place('', '/elsewhere'), { cwd: '/elsewhere' })
})

test('bridge: a hand-off opens a titled session on the route, waits for its turn, answers with the reply', async () => {
  const { bridge, started, sent, answer } = fixture()
  const asked = bridge.ask({ agent: 'codex', project: 'hub', cwd: '/tmp', text: '  fix the login bug  ', wait: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [{ cwd: join('/work', 'hub'), workspaceId: 'w3', title: '眼镜 · fix the login bug', route: { provider: 'openai-codex', model: 'gpt-5.5' } }])
  assert.deepEqual(sent, [['s1', 'fix the login bug']])
  answer('s1', 'Fixed in auth.ts')
  const report = await asked
  assert.equal(report.phase, 'done')
  assert.equal(report.text, 'Fixed in auth.ts')
  assert.equal(report.model, 'openai-codex / gpt-5.5')
  assert.equal(bridge.status()[0]!.session, 's1')
  await assert.rejects(bridge.ask({ cwd: '/tmp', text: '   ', wait: true }), ChooseError)
})

/** Approvals as the device keeps them: a count waiting per session, the approve switch. */
function approvalsFixture() {
  const waiting = new Map<string, number>()
  const decided: Array<[string, boolean]> = []
  const state = {
    waiting,
    decided,
    approveOn: true,
    approvals: () => ({
      waiting: (session: string) => (waiting.get(session) ?? 0) > 0,
      decide: (session: string, allow: boolean): 'ok' | 'none' | 'refused' | 'off' => {
        const count = waiting.get(session) ?? 0
        if (count === 0) return 'none'
        if (allow && !state.approveOn) return 'off'
        waiting.set(session, count - 1)
        decided.push([session, allow])
        return 'ok'
      },
    }),
  }
  return state
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('bridge: a hand-off stops at an approval, back in its own conversation; approving waits for the next stop; a reply goes on in the session', async () => {
  const asks = approvalsFixture()
  const posts: string[] = []
  const { bridge, emit, answer, sent } = fixture({
    approvals: asks.approvals,
    targets: () => [{ session: 'qs', cwd: '/work/hub' }],
    post: async (_target, text) => { posts.push(text); return 'sent' },
  })
  const asked = bridge.ask({ project: 'hub', cwd: '/tmp', text: 'deploy', wait: true })
  await settle()
  assert.equal(bridge.follows('s1'), true, 'its approvals wait for the glasses too')
  emit('s1', 'turn/start')
  asks.waiting.set('s1', 1)
  emit('s1', 'approval/asked', { toolName: 'Bash' })
  const stopped = await asked
  assert.deepEqual([stopped.phase, stopped.tool], ['approval', 'Bash'])
  await settle()
  assert.deepEqual(posts, [], 'the conversation waiting on it hears it, the glasses are not told again')

  // None named: the one session waiting.
  const approved = bridge.decide({ allow: true })
  await settle()
  assert.deepEqual(asks.decided, [['s1', true]])
  emit('s1', 'approval/decided')
  answer('s1', 'Deployed')
  assert.equal((await approved).phase, 'done')

  const replied = bridge.reply({ text: '  also tag it ' })
  await settle()
  assert.deepEqual(sent.at(-1), ['s1', 'also tag it'], 'the latest session the glasses follow')
  answer('s1', 'Tagged')
  assert.equal((await replied).text, 'Tagged')
  await assert.rejects(bridge.reply({ session: 'nope', text: 'x' }), ChooseError)
  bridge.dispose()
})

test('bridge: approving goes by the device\'s rules, refuses to guess between sessions, and answers at once while another waits', async () => {
  const asks = approvalsFixture()
  const { bridge, emit } = fixture({ approvals: asks.approvals })
  await assert.rejects(bridge.decide({ allow: true }), (error: Error) => error instanceof ChooseError && /No DSH session waiting for approval/.test(error.message))
  await bridge.ask({ project: 'hub', cwd: '/tmp', text: 'one', wait: false })
  await bridge.ask({ project: 'hub', cwd: '/tmp', text: 'two', wait: false })
  asks.waiting.set('s1', 2)
  asks.waiting.set('s2', 1)
  emit('s1', 'approval/asked', { toolName: 'Edit' })
  emit('s2', 'approval/asked', { toolName: 'Bash' })
  await assert.rejects(bridge.decide({ allow: false }), (error: Error) => error instanceof ChooseError && /Several DSH sessions waiting for approval: .*s1 眼镜 · one/.test(error.message) && /s2 眼镜 · two/.test(error.message))

  asks.approveOn = false
  await assert.rejects(bridge.decide({ session: 's1', allow: true }), /only denying works here/)
  const denied = await bridge.decide({ session: 's1', allow: false })
  assert.equal(denied.phase, 'approval', 'its second approval still waits: no stop to wait for')
  assert.deepEqual(asks.decided, [['s1', false]])

  const none = fixture()
  await assert.rejects(none.bridge.decide({ allow: true }), /not available here/)
  bridge.dispose()
  none.bridge.dispose()
})

test('bridge: stop cancels the one at work and answers once it has; a caller gone before the stop leaves the bell on', async () => {
  const posts: string[] = []
  const { bridge, emit, answer, cancelled } = fixture({
    targets: () => [{ session: 'qs', cwd: '/work/hub' }],
    post: async (_target, text) => { posts.push(text); return 'sent' },
  })
  await bridge.ask({ project: 'hub', cwd: '/tmp', text: 'long job', wait: false })
  emit('s1', 'turn/start')
  const stopping = bridge.stop(undefined)
  await settle()
  assert.deepEqual(cancelled, ['s1'])
  emit('s1', 'turn/end', { reason: { kind: 'cancelled' } })
  assert.equal((await stopping).phase, 'stopped')
  await assert.rejects(bridge.stop(undefined), /No DSH session at work/)
  await assert.rejects(bridge.wait(undefined), /No DSH session at work/)

  // The background run killed: the session goes on, and its end reaches the glasses.
  const gone = new AbortController()
  const replied = bridge.reply({ session: 's1', text: 'try again' }, gone.signal)
  await settle()
  gone.abort()
  assert.equal((await replied).phase, 'running')
  assert.deepEqual(bridge.glasses().armed, ['s1'])
  answer('s1', 'Worked this time.')
  await settle()
  assert.match(posts.at(-1) ?? '', /long job 已完成：Worked this time\.（s1）$/)
  bridge.dispose()
})

test('bridge: the bell tells the glasses once; notes wait for a session, go as one batch, pass an offline session over, and stay after a failure', async () => {
  let targets: Array<{ session: string; cwd: string }> = []
  const posts: Array<{ session: string; text: string; held: boolean }> = []
  const results: Array<'sent' | 'offline' | 'failed'> = []
  let gate: Promise<void> = Promise.resolve()
  const { bridge, answer, emit } = fixture({
    targets: () => targets,
    post: async (target, text) => {
      posts.push({ session: target.session, text, held: bridge.held(target.cwd) })
      await gate
      return results.shift() ?? 'sent'
    },
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  bridge.arm('a', true)
  emit('a', 'session/title', { title: 'Refactor billing' })
  emit('a', 'turn/start')
  emit('a', 'approval/asked', { toolName: 'bash' })
  answer('a', 'All green')
  answer('a', 'Second turn')
  assert.equal(bridge.glasses().queued, 2, 'no session to tell yet')
  assert.equal(bridge.glasses().reachable, false)
  assert.deepEqual(bridge.glasses().armed, [], 'once')

  targets = [{ session: 'qs_offline', cwd: '/work/hub' }, { session: 'qs_live', cwd: '/work/hub' }]
  results.push('offline', 'sent')
  bridge.retry()
  await settle()
  await settle()
  assert.deepEqual(posts.map((entry) => entry.session), ['qs_offline', 'qs_live'], 'an offline session is passed over')
  assert.equal(posts[1]!.text, '【DSH 通知】请把下面的消息按原意简短转告我，每条一句，不要扩写，括号里的会话编号不用念，不要做别的操作：Refactor billing 等审批：bash（a）；Refactor billing 已完成：All green（a）')
  assert.ok(posts.every((entry) => entry.held), 'the target worker is held while the message goes in')
  assert.equal(bridge.held('/work/hub'), false)
  assert.equal(bridge.glasses().queued, 0)
  assert.equal(bridge.glasses().reachable, true)

  // One batch at a time: what comes meanwhile goes next, together.
  let open!: () => void
  gate = new Promise((resolve) => { open = resolve })
  bridge.notify('one')
  bridge.notify('two')
  bridge.notify('three')
  await settle()
  assert.equal(bridge.glasses().sending, true)
  assert.deepEqual(posts.slice(2).map((entry) => entry.text.split('：').at(-1)), ['one'])
  open()
  await settle()
  await settle()
  assert.match(posts.at(-1)!.text, /two；three$/)
  assert.equal(bridge.glasses().queued, 0)

  results.push('failed')
  bridge.notify('kept')
  await settle()
  await settle()
  assert.equal(bridge.glasses().queued, 1, 'a failure keeps the note for the next try')
  bridge.dispose()
})

test('bridge: notes go to sessions with a worker, then reclaimed ones, then ones only Qoder\'s records know, in workspaces online here', () => {
  const task = (id: string, phase: TaskView['phase'], updatedAt: number, worker = false): TaskView =>
    ({ id, phase, updatedAt, startedAt: 0, url: '', ...(worker ? { worker: { pid: 1 } } : {}) })
  const workspace = (path: string, phase: WorkspaceView['phase'], tasks: TaskView[]): WorkspaceView =>
    ({ path, name: path, phase, idleMinutes: 0, reaped: { workers: 0, bytes: 0 }, tasks })
  const hub = join('/work', 'hub')
  const web = join('/work', 'web')
  const workspaces = [
    workspace(hub, 'online', [task('qs_old', 'idle', 1, true), task('qs_new', 'idle', 3, true), task('qs_slept', 'dormant', 2), task('qs_busy', 'running', 4, true)]),
    workspace(web, 'retrying', [task('qs_web', 'idle', 5, true)]),
  ]
  const recorded = [
    { id: 'qs_busy', cwd: hub },
    { id: 'qs_tree', cwd: join(hub, '.worktrees', 'qoder', 'fix') },
    { id: 'qs_slept', cwd: hub },
    { id: 'qs_far', cwd: web },
    { id: 'qs_out', cwd: join('/work', 'other') },
  ]
  assert.deepEqual(glassesTargets(workspaces, recorded), [
    { session: 'qs_new', cwd: hub },
    { session: 'qs_old', cwd: hub },
    { session: 'qs_slept', cwd: hub },
    { session: 'qs_tree', cwd: hub },
  ])
  assert.deepEqual(glassesTargets([workspace(hub, 'online', [])], recorded).map((entry) => entry.session), ['qs_busy', 'qs_tree', 'qs_slept'],
    'after a start the daemon lists none: Qoder\'s records stand in')
  assert.deepEqual(glassesTargets([], recorded), [], 'nothing online')
})

test('bridge: with none reachable the bell offers where to open a session; with one, or no way to post, it does not', () => {
  let targets: Array<{ session: string; cwd: string }> = []
  const opener = 'https://qoder.cn/agents/session/new?envId=env_1'
  const { bridge } = fixture({ targets: () => targets, opener: () => opener, post: async () => 'sent' })
  assert.equal(bridge.glasses().opener, opener)
  targets = [{ session: 'qs', cwd: '/work/hub' }]
  assert.equal(bridge.glasses().opener, undefined)
  assert.equal(fixture({ opener: () => opener }).bridge.glasses().opener, undefined)
})

test('bridge: a note names the branch and the title, then the answer in one sentence', async () => {
  const branches: string[] = []
  const said: string[] = []
  const tail = (text: string): string => text.slice(text.indexOf('操作：') + 3)
  const { bridge, emit, answer } = fixture({
    branch: async (cwd) => { branches.push(cwd); return 'feat/login' },
    targets: () => [{ session: 'qs', cwd: '/work/hub' }],
    post: async (_target, text) => { said.push(tail(text)); return 'sent' },
  })
  bridge.arm('a', true)
  emit('a', 'session/title', { title: '修复登录跳转' })
  answer('a', '## 总结\n\n好的。已把登录后的跳转改回 **首页**，并补了测试；另外清理了旧代码。\n\n```ts\nconst x = 1\n```')
  bridge.arm('b', true)
  answer('b', 'Done')
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(branches, ['/work/hub', '/work/hub'], 'read at the turn\'s end')
  assert.deepEqual(said.join('；').split('；'), ['feat/login · 修复登录跳转 已完成：已把登录后的跳转改回 首页，并补了测试（a）', 'feat/login · hub 已完成：Done（b）'], 'in order; an untitled session goes by its folder')

  const failing = fixture({
    branch: async () => { throw new Error('not a repository') },
    targets: () => [{ session: 'qs', cwd: '/work/hub' }],
    post: async (_target, text) => { said.push(tail(text)); return 'sent' },
  })
  failing.bridge.arm('c', true)
  failing.emit('c', 'session/title', { title: '眼镜 · ship it' })
  failing.answer('c', 'Shipped it.')
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(said.at(-1), 'ship it 已完成：Shipped it.（c）', 'no branch: the note goes without')
  bridge.dispose()
  failing.bridge.dispose()
})

test('bridge: with an English UI, notes, their batch and hand-off titles are in English', async () => {
  const restore = setLocaleSource(() => 'en-US')
  try {
    const said: string[] = []
    const { bridge, emit, answer, started } = fixture({
      targets: () => [{ session: 'qs', cwd: '/work/hub' }],
      post: async (_target, text) => { said.push(text); return 'sent' },
    })
    bridge.arm('a', true)
    emit('a', 'session/title', { title: 'Glasses · ship it' })
    emit('a', 'turn/start')
    emit('a', 'approval/asked', { toolName: 'bash' })
    answer('a', 'Shipped it.')
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    const ask = `${POST_HEADER_EN}Relay the messages below to me briefly as they are, one sentence each, without expanding them; skip the session ids in brackets and do nothing else: `
    assert.deepEqual(said, [`${ask}ship it awaiting approval: bash (a)`, `${ask}ship it done: Shipped it. (a)`])
    void bridge.ask({ cwd: '/work/hub', text: 'write the docs', wait: false })
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(started.at(-1)?.title, 'Glasses · write the docs')
    bridge.dispose()
  } finally {
    restore()
  }
})

test('bridge cli: with an English UI, the script and the skill are written in English', async () => {
  const restore = setLocaleSource(() => 'en')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-en-'))
  try {
    await installCli({ node: process.execPath, dir, skills: join(dir, 'skills') })
    const script = await readFile(join(dir, 'dsh.cjs'), 'utf8')
    assert.match(script, /"approval":"awaiting approval"/)
    assert.doesNotMatch(script, /[\u4e00-\u9fff]/, 'no Chinese left in what it prints')
    assert.equal(await readFile(join(dir, 'skills', 'dsh', 'SKILL.md'), 'utf8'), SKILL_EN)
    assert.ok(SKILL_EN.includes(`"${POST_HEADER_EN.trim()}"`), 'the skill names the header the notes start with')
  } finally {
    restore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('bridge: the gist skips filler, markup, code and tables, and stays short', () => {
  assert.equal(gist('## 总结\n\n好的。已把登录后的跳转改回 **首页**，并补了测试；另外清理了旧代码。'), '已把登录后的跳转改回 首页，并补了测试')
  assert.equal(gist('- Fixed the `retry` loop in [post.ts](src/bridge/post.ts). Tests pass.'), 'Fixed the retry loop in post.ts.')
  assert.equal(gist('改动如下：\n| a | b |\n|---|---|'), '改动如下')
  assert.equal(gist('# 只有标题'), '只有标题')
  assert.equal(gist(''), '')
  assert.ok(gist('很'.repeat(200)).length <= 60)
})

test('bridge: holds follow a hand-off\'s caller folder until released', () => {
  const { bridge, changes } = fixture()
  const release = bridge.hold(join('/work', 'hub', '.worktrees', 'x'))
  assert.equal(bridge.held(join('/work', 'hub')), true)
  release()
  release()
  assert.equal(bridge.held(join('/work', 'hub')), false)
  assert.equal(changes(), 2)
})

test('bridge server: refuses without the token, from a page, or under another Host; answers the dsh script end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'))
  const asks = approvalsFixture()
  const { bridge, answer, sent } = fixture({ workspaces: () => [{ id: 'w', path: dir, title: 'scratch' }], approvals: asks.approvals })
  const server = await startBridgeServer(bridge, join(dir, BRIDGE_FILE), () => {})
  try {
    const saved = JSON.parse(await readFile(join(dir, BRIDGE_FILE), 'utf8')) as { url: string; token: string }
    assert.equal(saved.url, server.url)
    const status = (headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
      const url = new URL(`${server.url}/v1/status`)
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(await status({}), 403)
    assert.equal(await status({ authorization: `Bearer ${saved.token}`, origin: 'https://evil.example' }), 403)
    assert.equal(await status({ authorization: `Bearer ${saved.token}`, host: 'evil.example' }), 403)
    assert.equal(await status({ authorization: `Bearer ${saved.token}` }), 200)

    // The script, as Qoder's shell runs it (the launchers use the host's runtime; plain node here).
    const bin = await installCli({ node: process.execPath, dir, skills: join(dir, 'skills') })
    assert.equal(await readFile(join(dir, 'dsh.cjs'), 'utf8'), cliScript())
    assert.equal(await readFile(join(dir, 'skills', 'dsh', 'SKILL.md'), 'utf8'), SKILL)
    assert.match(await readFile(join(bin, 'dsh'), 'utf8'), /ELECTRON_RUN_AS_NODE=1 exec /)
    const dsh = (...args: string[]) => run(process.execPath, [join(dir, 'dsh.cjs'), ...args], { cwd: dir })

    assert.match((await dsh('agents')).stdout, /Claude Agent \[claude-agent\]: claude-opus-5-5, claude-sonnet-5-5（默认）/)
    assert.match((await dsh('projects')).stdout, /scratch/)
    await assert.rejects(dsh('ask', '--agent', 'gemini', 'hi'), (error: { code?: number; stderr?: string }) => error.code === 2 && /No agents named "gemini"/.test(error.stderr ?? ''))

    const asked = dsh('ask', '-a', 'claude', '-m', 'opus', 'write', 'the', 'docs')
    for (let tries = 0; bridge.status().length === 0 && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(bridge.held(dir), true, 'held while the hand-off waits')
    answer('s1', 'Docs written')
    const { stdout } = await asked
    assert.match(stdout, /^\[完成\] 眼镜 · write the docs/)
    assert.match(stdout, /claude-agent \/ claude-opus-5-5/)
    assert.match(stdout, /Docs written/)
    assert.equal(bridge.held(dir), false, 'released once answered')

    // More for the same session, then an approval nothing waits for.
    const replied = dsh('reply', '-s', 's1', 'and', 'the', 'README')
    for (let tries = 0; sent.length < 2 && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(sent.at(-1), ['s1', 'and the README'])
    answer('s1', 'README too')
    assert.match((await replied).stdout, /README too/)
    await assert.rejects(dsh('approve'), (error: { code?: number; stderr?: string }) => error.code === 2 && /No DSH session waiting for approval/.test(error.stderr ?? ''))

    // A note from the shell waits for a glasses session (none in this fixture).
    await dsh('notify', 'build', 'passed')
    assert.equal(bridge.glasses().queued, 1)
  } finally {
    bridge.dispose()
    await server.close()
    await assert.rejects(readFile(join(dir, BRIDGE_FILE)), 'its file removed')
    await rm(dir, { recursive: true, force: true })
  }
})

test('bridge post: the helper puts the message in under a terminal, sees it land in the transcript, and tells an offline session apart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-post-'))
  try {
    // A stand-in for node-pty: the "client" writes what the worker would, or prints the service's refusal.
    const fakePty = join(dir, 'fake-pty.cjs')
    await writeFile(fakePty, `'use strict'
const fs = require('node:fs')
exports.spawn = (cli, args, options) => {
  const listeners = { data: [], exit: [] }
  const [, session, text] = args
  const transcript = process.env.FAKE_TRANSCRIPT
  setTimeout(() => {
    if (session === 'qs_offline') return listeners.data.forEach((fn) => fn('HTTP 424 {"code":"WorkerOffline"}'))
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { content: text } }) + '\\n')
    setTimeout(() => fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n'), 200)
  }, 100)
  return { onData: (fn) => listeners.data.push(fn), onExit: (fn) => listeners.exit.push(fn), kill: () => {} }
}
`)
    const transcript = join(dir, 'qs_live.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { content: `${POST_HEADER}an older one` } }) + '\n')
    const script = join(dir, 'qoder-post.cjs')
    await installPost(script)
    assert.equal(await readFile(script, 'utf8'), POST_SCRIPT)
    process.env.FAKE_TRANSCRIPT = transcript
    const options = { node: process.execPath, script, pty: fakePty, cli: 'qoderclicn' }
    const text = `${POST_HEADER}请用一两句话转告我下面的消息，不要做别的操作：build passed`
    assert.equal(await post(options, { session: 'qs_live', cwd: dir, transcript }, text), 'sent')
    assert.match(await readFile(transcript, 'utf8'), /build passed/)
    assert.equal(await post(options, { session: 'qs_live', cwd: dir, transcript }, `${POST_HEADER_EN}tests passed`), 'sent', 'the English header lands too')
    assert.equal(await post(options, { session: 'qs_offline', cwd: dir, transcript: join(dir, 'none.jsonl') }, text), 'offline')
    assert.equal(await post({ ...options, pty: join(dir, 'missing') }, { session: 'qs_live', cwd: dir, transcript }, text), 'failed')
  } finally {
    delete process.env.FAKE_TRANSCRIPT
    await rm(dir, { recursive: true, force: true })
  }
})

test('bridge post: DSH\'s node-pty is found inside the app archive beside the runtime', () => {
  const exists = (path: string) => path === join('/apps', 'DSH', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty')
  assert.equal(findPty(join('/apps', 'DSH', 'DSH.exe'), exists), join('/apps', 'DSH', 'resources', 'app.asar', 'dsh', 'node_modules', 'node-pty'))
  assert.equal(findPty(join('/elsewhere', 'node'), exists), undefined)
})

test('bridge cli: the launchers\' folder goes first on PATH, once, under the spelling the environment uses', () => {
  assert.deepEqual(withPath('/b', { Path: '/x:/y'.replaceAll(':', process.platform === 'win32' ? ';' : ':') }), { Path: ['/b', '/x', '/y'].join(process.platform === 'win32' ? ';' : ':') })
  assert.deepEqual(withPath('/b', { PATH: '/b' }), { PATH: '/b' })
  assert.deepEqual(withPath('/b', {}), { PATH: '/b' })
})

test('glasses hub: read once and rest while nothing is armed; a long poll while one is; woken by a press or the window coming back', async () => {
  const calls: Array<{ op: string; since?: number }> = []
  let armed: string[] = []
  let epoch = 0
  const hub = new GlassesHub(async (request) => {
    calls.push({ op: request.op, ...(request.op === 'status' && request.since !== undefined ? { since: request.since } : {}) })
    if (request.op === 'arm') armed = request.on ? [request.sessionId] : []
    else if (request.since !== undefined) await new Promise((resolve) => setTimeout(resolve, 20))
    return { boot: 'b', epoch: ++epoch, status: { reachable: true, sending: false, queued: 0, armed } }
  })
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
  const off = hub.subscribe(() => {})
  await tick(60)
  assert.deepEqual(calls, [{ op: 'status' }], 'one read, then rest')
  hub.refresh()
  await tick(30)
  assert.equal(calls.length, 2, 'the window coming back reads again')
  await hub.arm('s1', true)
  await tick(80)
  assert.ok(calls.filter((call) => call.since !== undefined).length >= 2, 'armed: a long poll')
  await hub.arm('s1', false)
  await tick(60)
  const settled = calls.length
  await tick(60)
  assert.equal(calls.length, settled, 'rests again once nothing is armed')
  off()
})
