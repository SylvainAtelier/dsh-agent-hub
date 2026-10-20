import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RemoteWorkspaces } from '../src/qoder/daemon.ts'
import type { QoderStatus, TaskView } from '../src/qoder/types.ts'
import { hermesSessions, hermesTurns } from '../src/relay/hermes.ts'
import { parseKey, Relay, RUNNING, transcript, workingDir } from '../src/relay/index.ts'
import { parseQoder, promptText, QoderSessions } from '../src/relay/qoder.ts'
import type { RelayUpdate, ThreadView, Turn } from '../src/relay/types.ts'

const line = (value: object): string => JSON.stringify(value)

/** A session file the way Qoder CLI CN 1.1.73 writes one. */
function qoderFile(cwd: string, entrypoint = 'remote-control'): string {
  return [
    line({ type: 'workspace-directories', sessionId: 'x', directories: [cwd] }),
    line({ type: 'user', timestamp: '2026-10-17T16:09:52.128Z', cwd, entrypoint, businessModelKey: 'auto', message: { role: 'user', content: '<system-reminder>be brief</system-reminder>\ncheck the last commit' } }),
    line({ type: 'assistant', timestamp: 1792265225000, cwd, entrypoint, gitBranch: 'main', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }),
    line({ type: 'assistant', timestamp: 1792265225001, cwd, entrypoint, gitBranch: 'main', message: { content: [{ type: 'text', text: 'Looking ' }] } }),
    line({ type: 'assistant', timestamp: 1792265225002, cwd, entrypoint, gitBranch: 'main', message: { content: [{ type: 'text', text: 'now.' }] } }),
    line({ type: 'assistant', timestamp: 1792265225003, cwd, entrypoint, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git log -1' } }] } }),
    line({ type: 'user', timestamp: 1792265225004, cwd, entrypoint, message: { content: [{ type: 'tool_result', content: 'abc' }] } }),
    line({ type: 'assistant', timestamp: 1792265225005, cwd, entrypoint, isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    line({ type: 'assistant', timestamp: 1792265225006, cwd, entrypoint, message: { content: [{ type: 'text', text: 'The last commit is abc.' }] } }),
    'not json',
  ].join('\n')
}

test('relay qoder: a session file reads as its first prompt, its turns, and whose move it is', () => {
  assert.equal(promptText([{ type: 'tool_result', content: 'x' }]), undefined)
  assert.equal(promptText('[Request interrupted by user]'), undefined)
  const turns: Turn[] = []
  const session = parseQoder('qs_a', qoderFile('/repo'), turns)!
  assert.equal(session.title, 'check the last commit')
  assert.equal(session.entrypoint, 'remote-control')
  assert.equal(session.model, 'auto')
  assert.equal(session.branch, 'main')
  assert.equal(session.prompts, 1)
  assert.equal(session.waiting, false)
  assert.equal(session.last, 'The last commit is abc.')
  assert.equal(session.startedAt, Date.parse('2026-10-17T16:09:52.128Z'))
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ['user', 'check the last commit'],
    ['assistant', 'Looking now.'],
    ['tool', 'Bash: git log -1'],
    ['assistant', 'The last commit is abc.'],
  ])
  // A prompt with nothing after it: an answer is under way.
  assert.equal(parseQoder('qs_b', qoderFile('/repo').split('\n').slice(0, 2).join('\n'))!.waiting, true)
  assert.equal(parseQoder('qs_c', line({ type: 'worktree-state' })), undefined)
})

test('relay qoder: sessions list newest first, probes in a scratch folder left out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-qoder-'))
  const scratch = join(root, 'scratch')
  await mkdir(join(root, 'C--repo'), { recursive: true })
  await mkdir(join(root, 'scratch-probe'), { recursive: true })
  await writeFile(join(root, 'C--repo', 'qs_one.jsonl'), qoderFile('/repo'))
  await writeFile(join(root, 'scratch-probe', 'probe.jsonl'), qoderFile(join(scratch, 'x'), 'cli'))
  const sessions = new QoderSessions(root, scratch)
  assert.deepEqual((await sessions.list()).map((session) => session.id), ['qs_one'])
  assert.equal((await sessions.read('qs_one'))?.turns.length, 4)
  assert.equal(await sessions.read('missing'), undefined)
})

/** A persona's state.db with the columns Hermes writes. */
function hermesDb(home: string, now: number): void {
  const db = new DatabaseSync(join(home, 'state.db'))
  db.exec(`create table sessions (id text primary key, source text not null, title text, started_at real not null, ended_at real, message_count integer default 0,
    model text, cwd text, git_branch text, last_activity_at real, archived integer default 0, hidden integer default 0);
    create table messages (id integer primary key autoincrement, session_id text not null, role text not null, content text, tool_calls text, timestamp real not null,
    active integer not null default 1, compacted integer not null default 0);`)
  const s = now / 1000
  const session = db.prepare('insert into sessions (id, source, title, started_at, ended_at, message_count, model, last_activity_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
  session.run('tg', 'telegram', 'Summarise a video', s - 600, null, 4, 'gpt', s - 60)
  session.run('cron1', 'cron', 'Nightly digest', s - 7200, s - 7000, 2, 'gpt', s - 7000)
  session.run('acp1', 'acp', 'DSH own', s - 100, null, 2, 'gpt', s - 10)
  session.run('probe', 'oneshot', 'PONG', s - 100, s - 99, 2, 'gpt', s - 99)
  session.run('reset', 'telegram', null, s - 30, null, 0, 'gpt', s - 30)
  const message = db.prepare('insert into messages (session_id, role, content, tool_calls, timestamp, active, compacted) values (?, ?, ?, ?, ?, ?, ?)')
  message.run('tg', 'user', 'summarise https://youtu.be/x', null, s - 600, 0, 1)
  message.run('tg', 'assistant', '', JSON.stringify([{ function: { name: 'terminal', arguments: JSON.stringify({ command: 'yt-dlp x' }) } }]), s - 590, 1, 0)
  message.run('tg', 'tool', '{"output":"ok"}', null, s - 580, 1, 0)
  message.run('tg', 'assistant', 'It is about relays.', null, s - 60, 1, 0)
  message.run('cron1', 'user', 'digest', null, s - 7200, 1, 0)
  db.close()
}

test('relay hermes: a persona\'s conversations, ACP, probes and empty chats left out, and one read as turns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-hermes-'))
  const now = Date.now()
  hermesDb(home, now)
  const sessions = await hermesSessions('mia', home, now)
  assert.deepEqual(sessions.map((session) => [session.id, session.source, session.ended, session.waiting]), [['tg', 'telegram', false, false], ['cron1', 'cron', true, false]])
  assert.equal(sessions[0]!.last, 'It is about relays.')
  const turns = await hermesTurns(home, 'tg')
  assert.deepEqual(turns!.map((turn) => [turn.role, turn.text]), [
    ['user', 'summarise https://youtu.be/x'],
    ['tool', 'terminal: yt-dlp x'],
    ['assistant', 'It is about relays.'],
  ])
  assert.deepEqual(await hermesSessions('none', join(home, 'missing')), [])
})

test('relay: keys, and a transcript keeps its newest part', () => {
  assert.deepEqual(parseKey('qoder:qs_a'), { agent: 'qoder', id: 'qs_a' })
  assert.deepEqual(parseKey('hermes:mia:20261011_1'), { agent: 'hermes', persona: 'mia', id: '20261011_1' })
  assert.equal(parseKey('nope'), undefined)
  const thread = { agent: 'hermes', persona: 'mia', origin: 'telegram', id: 'tg' } as ThreadView
  const text = transcript(thread, [{ role: 'user', text: 'a'.repeat(100) }, { role: 'assistant', text: 'latest' }], 60)
  assert.match(text, /Hermes \(persona mia\).*telegram.*session tg/)
  assert.match(text, /\[… earlier messages left out\]/)
  assert.match(text, /Assistant: latest/)
  assert.doesNotMatch(text, /aaaa/)
})

test('relay: a thread goes on in its folder, else the nearest repository still there', () => {
  const repo = join('/repo')
  const tree = join(repo, '.qoder', 'worktrees', 'qs_a')
  const present = (...paths: string[]) => (path: string): boolean => paths.includes(path)
  assert.equal(workingDir(tree, present(tree)), tree)
  // The worktree was removed: its repository, not the folder that held it.
  assert.equal(workingDir(tree, present(join(repo, '.qoder', 'worktrees'), repo, join(repo, '.git'))), repo)
  // No repository above it: the nearest folder still there.
  assert.equal(workingDir(tree, present(join(repo, '.qoder'))), join(repo, '.qoder'))
})

/** The daemons' side, as the relay sees it. */
function workspaces(tasks: TaskView[] = []): RemoteWorkspaces {
  const status: QoderStatus = { installed: true, workspaces: [{ path: '/repo', name: 'pc / repo', phase: 'online', idleMinutes: 0, reaped: { workers: 0, bytes: 0 }, tasks }] }
  return { subscribe: () => () => {}, watch: () => {}, status: () => status, start: () => {}, stop: () => {}, reap: () => {} } as unknown as RemoteWorkspaces
}

async function relayFor(options: { tasks?: TaskView[]; sends?: string[][]; starts?: object[]; dir?: string; spawn?: () => ChildProcess } = {}): Promise<{ relay: Relay; dir: string }> {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'relay-'))
  const root = join(dir, 'projects')
  const hermes = join(dir, 'hermes')
  if (options.dir === undefined) {
    await mkdir(join(root, 'C--repo'), { recursive: true })
    await writeFile(join(root, 'C--repo', 'qs_done.jsonl'), qoderFile(dir))
    await writeFile(join(root, 'C--repo', 'qs_busy.jsonl'), qoderFile(dir).split('\n').slice(0, 2).join('\n'))
    const hourAgo = new Date(Date.now() - 3_600_000)
    await utimes(join(root, 'C--repo', 'qs_busy.jsonl'), hourAgo, hourAgo)
    await mkdir(join(hermes, 'profiles', 'mia'), { recursive: true })
    hermesDb(join(hermes, 'profiles', 'mia'), Date.now())
  }
  let n = 0
  const relay = new Relay({
    workspaces: workspaces(options.tasks),
    hermesRoot: () => hermes,
    personas: () => ['mia'],
    findHermes: () => undefined,
    findQoder: () => (options.spawn === undefined ? undefined : 'qodercn'),
    qoderModels: async () => ['auto', 'glm'],
    sessions: () => ({
      start: async (input) => { options.starts?.push(input); return `dsh-${++n}` },
      send: async (sessionId, text) => { options.sends?.push([sessionId, text]) },
      cancel: async () => {},
      archive: async () => {},
    }),
    file: join(dir, 'relay.json'),
    log: () => {},
    qoder: new QoderSessions(root, join(dir, 'scratch')),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  })
  return { relay, dir }
}

test('relay: one list of Qoder sessions, the daemon\'s live tasks and the personas\' conversations', async () => {
  const task: TaskView = { id: 'qs_new', prompt: 'just sent', phase: 'running', tool: 'Edit: a.ts', url: 'https://qoder.cn/agents/session/qs_new', startedAt: Date.now(), updatedAt: Date.now() }
  const { relay } = await relayFor({ tasks: [task] })
  try {
    const update = await relay.handle({ op: 'status' }) as RelayUpdate
    const byKey = new Map(update.status.threads.map((thread) => [thread.key, thread]))
    assert.deepEqual([...byKey.keys()].sort(), ['hermes:mia:cron1', 'hermes:mia:tg', 'qoder:qs_busy', 'qoder:qs_done', 'qoder:qs_new'])
    const done = byKey.get('qoder:qs_done')!
    assert.equal(done.origin, 'glasses')
    assert.equal(done.phase, 'idle')
    assert.equal(done.takeover, 'load')
    assert.equal(done.url, 'https://qoder.cn/agents/session/qs_done')
    assert.match(done.command, /qodercn -r qs_done$/)
    // An unanswered prompt written long ago is not at work any more.
    assert.equal(byKey.get('qoder:qs_busy')!.phase, 'idle')
    const live = byKey.get('qoder:qs_new')!
    assert.equal(live.phase, 'running')
    assert.equal(live.detail, 'Edit: a.ts')
    assert.equal(live.title, 'just sent')
    const tg = byKey.get('hermes:mia:tg')!
    assert.equal(tg.origin, 'telegram')
    assert.equal(tg.takeover, 'context')
    assert.equal(tg.command, 'hermes -p mia --resume tg')
    assert.equal(byKey.get('hermes:mia:cron1')!.phase, 'ended')

    // A read with nothing new waits, then answers the same epoch.
    const again = await relay.wait(update.boot, update.epoch, false)
    assert.equal(again.epoch, update.epoch)
  } finally {
    relay.dispose()
  }
})

test('relay: taking a thread over opens a DSH session on its route once, sends the message, and seeds the first turn', async () => {
  const sends: string[][] = []
  const starts: Array<{ cwd: string; route: object; title: string }> = []
  const running: TaskView = { id: 'qs_run', phase: 'running', url: '', startedAt: Date.now(), updatedAt: Date.now() }
  const { relay, dir } = await relayFor({ sends, starts, tasks: [running] })
  try {
    const first = await relay.takeover('qoder:qs_done', 'go on')
    assert.equal(first.session, 'dsh-1')
    assert.deepEqual(starts, [{ cwd: dir, route: { provider: 'qoder-agent', model: 'auto' }, title: 'check the last commit' }])
    assert.deepEqual(sends, [['dsh-1', 'go on']])
    // Again: the same session, no second one.
    assert.equal((await relay.takeover('qoder:qs_done', undefined)).session, 'dsh-1')
    assert.equal(starts.length, 1)
    assert.equal(relay.threads().find((thread) => thread.key === 'qoder:qs_done')!.session, 'dsh-1')

    const seed = await relay.seed('dsh-1')
    assert.equal(seed?.resume, 'qs_done')
    assert.match(await seed!.context!() ?? '', /User: check the last commit/)
    assert.equal(await relay.seed('another'), undefined)

    // Hermes: no session to load, the transcript instead.
    const hermes = await relay.takeover('hermes:mia:tg', undefined)
    assert.deepEqual(starts.at(-1)!.route, { provider: 'hermes-agent', model: 'mia' })
    assert.equal(starts.at(-1)!.title, 'Summarise a video')
    const hermesSeed = await relay.seed(hermes.session)
    assert.equal(hermesSeed?.resume, undefined)
    assert.match(await hermesSeed!.context!() ?? '', /Assistant: It is about relays\./)

    // A Qoder task at work is not taken over.
    await assert.rejects(relay.takeover('qoder:qs_run', 'x'), (error: Error) => error.message === RUNNING)
  } finally {
    relay.dispose()
  }
  // The links outlive the host run.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const { relay: next } = await relayFor({ dir })
  try {
    assert.equal((await next.seed('dsh-1'))?.resume, 'qs_done')
  } finally {
    next.dispose()
  }
})

test('relay: a thread\'s detail is its turns, the newest kept', async () => {
  const { relay } = await relayFor()
  try {
    const detail = await relay.thread('hermes:mia:tg')
    assert.equal(detail.thread.persona, 'mia')
    assert.equal(detail.turns.length, 3)
    assert.equal(detail.truncated, false)
    await assert.rejects(relay.thread('qoder:nope'), /No such thread/)
  } finally {
    relay.dispose()
  }
})

test('relay: a task sent to the cloud answers once its session link is printed, and is listed', async () => {
  // The CLI prints the link and has not exited yet.
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess
  const { relay } = await relayFor({
    spawn: () => {
      setTimeout(() => child.stdout!.emit('data', '\u001b[32mOpened\u001b[0m https://qoder.cn/agents/session/qs_cloud1\n'), 10)
      return child
    },
  })
  try {
    await assert.rejects(relay.cloud('/elsewhere', 'x'), /Not a configured workspace/)
    const result = await relay.cloud('/repo', '  add install steps  ')
    assert.deepEqual(result, { id: 'qs_cloud1', url: 'https://qoder.cn/agents/session/qs_cloud1' })
    const thread = relay.threads().find((entry) => entry.key === 'qoder:qs_cloud1')!
    assert.equal(thread.origin, 'cloud')
    assert.equal(thread.phase, 'cloud')
    assert.equal(thread.title, 'add install steps')
    assert.match(thread.command, /qodercn --teleport qs_cloud1$/)
    await assert.rejects(relay.takeover(thread.key, 'x'), /cloud/)
  } finally {
    child.emit('close', 0)
    relay.dispose()
  }
})
