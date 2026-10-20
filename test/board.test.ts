import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkTrees, orderStates, pickState, sortCards, stageOf, startRepos, taskBranch, type Card } from '../src/board/types.ts'
import { LocalTasks } from '../src/board/store.ts'
import { BoardStore, type BoardCall } from '../src/client/board/api.ts'
import type { BoardReply, BoardRequest, BoardState } from '../src/board/types.ts'
import { BoardService, type BoardHost } from '../src/board/index.ts'
import { Connectors, type ConnectorsHost, type LinearAccount, type Mounted } from '../src/connectors/index.ts'
import type { LinearTickets } from '../src/connectors/linear.ts'
import type { Issue, IssueState } from '../src/connectors/types.ts'
import type { Worktree } from '../src/git/types.ts'
import { samePath, type RepoGroup } from '../src/repos/types.ts'
import { RepoIndex, type RepoWorkspaces } from '../src/repos/index.ts'
import { summarize } from '../src/client/config/sections.ts'
import type { FieldState } from '../src/client/config/form.ts'
import { arrange, placements, preferTreeView, TREE_VIEW, viewMode } from '../src/client/repos/sidebar.ts'

const STATES: IssueState[] = [
  { id: 'tri', type: 'triage', name: 'Triage' },
  { id: 'rev', type: 'started', name: 'In Review' },
  { id: 'done', type: 'completed', name: 'Done' },
  { id: 'todo', type: 'unstarted', name: 'Todo' },
  { id: 'back', type: 'backlog', name: 'Backlog' },
  { id: 'cxl', type: 'canceled', name: 'Canceled' },
  { id: 'prog', type: 'started', name: 'In Progress' },
  { id: 'dup', type: 'duplicate', name: 'Duplicate' },
]

test('board: Linear state types map onto the five columns', () => {
  assert.equal(stageOf('triage'), 'backlog')
  assert.equal(stageOf(undefined), 'backlog')
  assert.equal(stageOf('started'), 'started')
  assert.equal(stageOf('duplicate'), 'canceled')
  assert.equal(stageOf('cancelled'), 'canceled')
})

test('board: a card dropped on a column takes the plain-work state of that kind', () => {
  // In Progress, not In Review, though Linear lists review first.
  assert.equal(pickState('started', STATES)?.id, 'prog')
  assert.equal(pickState('backlog', STATES)?.id, 'back')
  assert.equal(pickState('backlog', STATES.filter((state) => state.type !== 'backlog'))?.id, 'tri')
  assert.equal(pickState('canceled', STATES)?.id, 'cxl')
  // Only review-like states of that kind: the first one still fits.
  assert.equal(pickState('started', [{ id: 'r', type: 'started', name: 'Code review' }])?.id, 'r')
  assert.equal(pickState('completed', []), undefined)
  // The picker lists states in column order, work before review, duplicates left out.
  assert.deepEqual(orderStates(STATES).map((state) => state.id), ['tri', 'back', 'todo', 'prog', 'rev', 'done', 'cxl'])
})

test('board: cards sort urgent first, then by priority, then the latest change', () => {
  const card = (key: string, priority: number | undefined, updatedAt: number): Card =>
    ({ key, source: 'linear', id: key, title: key, stage: 'unstarted', repos: [], updatedAt, ...(priority === undefined ? {} : { priority }) })
  const sorted = sortCards([card('none-new', 0, 9), card('low', 4, 1), card('urgent', 1, 1), card('high-old', 2, 1), card('high-new', 2, 5), card('unset', undefined, 7)])
  assert.deepEqual(sorted.map((item) => item.key), ['urgent', 'high-new', 'high-old', 'low', 'none-new', 'unset'])
  assert.equal(taskBranch({ id: 'abcdef1234', title: 'Fix the Login page!' }), 'task/fix-the-login-page')
  assert.equal(taskBranch({ id: 'abcdef1234', title: '修复登录' }), 'task/abcdef12')
})

test('repos: paths compare the way the host spells them', () => {
  assert.ok(samePath('C:\\Users\\vi\\repo\\', 'c:/users/vi/repo'))
  assert.ok(!samePath('/home/vi/Repo', '/home/vi/repo'))
})

const field = (value: unknown, invalid = false): FieldState => ({ value, overridden: false, fallback: undefined, invalid, dirty: false })

test('sidebar: the tree view is the default until a view is picked', () => {
  const memory = (entries: Record<string, string>) => ({
    entries,
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => { entries[key] = value },
  })
  const fresh = memory({})
  preferTreeView(undefined, fresh)
  assert.equal(JSON.parse(fresh.entries['dsh.workspace.view.v5'] ?? 'null').groupBy, TREE_VIEW)
  const picked: string[] = []
  preferTreeView({ setGroupBy: (mode) => picked.push(mode) }, memory({}))
  assert.deepEqual(picked, [TREE_VIEW])
  const chosen = memory({ 'dsh.workspace.view.v5': JSON.stringify({ groupBy: 'flat' }) })
  preferTreeView({ setGroupBy: (mode) => picked.push(mode) }, chosen)
  assert.deepEqual(picked, [TREE_VIEW])
  assert.equal(JSON.parse(chosen.entries['dsh.workspace.view.v5'] ?? 'null').groupBy, 'flat')
})

test('sidebar: the tree view nests every worktree under its registered repository; other views are left alone', () => {
  const storage = (entries: Record<string, string>) => ({
    get length() { return Object.keys(entries).length },
    key: (i: number) => Object.keys(entries)[i] ?? null,
    getItem: (key: string) => entries[key] ?? null,
  })
  assert.equal(viewMode(storage({ 'dsh.workspace.view.v5': JSON.stringify({ state: { groupBy: 'workspace-tree' }, version: 0 }) })), TREE_VIEW)
  assert.equal(viewMode(storage({ 'dsh.workspace.view.v5.root': JSON.stringify({ groupBy: 'workspace' }) })), 'workspace')
  assert.equal(viewMode(storage({ 'dsh.workspace.view.v5': '{broken' })), undefined)
  assert.equal(viewMode(storage({})), undefined)

  const groups: RepoGroup[] = [
    { key: '/r/app', name: 'app', members: [
      { workspaceId: 'm', path: '/r/app', title: 'app', main: true },
      { workspaceId: 'w1', path: '/r/app.wt/feat/x', title: 'app · feat/x', main: false },
      { workspaceId: 'w2', path: '/r/app/.worktrees/y', title: 'Renamed by hand', main: false },
    ] },
    // No registered main tree: nothing to nest under.
    { key: '/r/lib', name: 'lib', members: [
      { workspaceId: 'l1', path: '/r/lib.wt/a', title: 'lib · a', main: false },
      { workspaceId: 'l2', path: '/r/lib.wt/b', title: 'lib · b', main: false },
    ] },
    { key: '/r/solo', name: 'solo', members: [{ workspaceId: 's', path: '/r/solo', title: 'solo', main: true }] },
  ]
  const placed = placements(groups)
  assert.deepEqual(placed.get('w1'), { head: 'm', title: 'app · feat/x', headTitle: 'app', short: 'feat/x' })
  assert.deepEqual(placed.get('w2'), { head: 'm', title: 'Renamed by hand', headTitle: 'app' })
  assert.deepEqual([...placed.keys()].sort(), ['w1', 'w2'])

  // Worktrees (adopted or natively nested, as one run) go after the head's row and native groups, before its sessions.
  const order = arrange(
    ['other', 'head', 'wt', 'last'],
    new Map([['head', { parts: ['head:row', 'head:children', 'head:s1', 'head:s2'], lead: 2, worktrees: ['wt', 'native'] }]]),
    new Set(['wt']),
  )
  assert.deepEqual(order, ['other', 'head:row', 'head:children', 'wt', 'native', 'head:s1', 'head:s2', 'last'])

  // With a root row, the head's sessions follow it, before every worktree, in the order given.
  const rooted = arrange(
    ['other', 'head', 'wt', 'last'],
    new Map([['head', { parts: ['head:row', 'head:children', 'head:s1', 'head:s2'], lead: 2, worktrees: ['wt', 'native'], root: { item: 'root', rowLead: 1 } }]]),
    new Set(['wt']),
  )
  assert.deepEqual(rooted, ['other', 'head:row', 'root', 'head:s1', 'head:s2', 'head:children', 'wt', 'native', 'last'])
})

test('settings: each folded group sums itself up in one line; trouble asks for attention', () => {
  const fields = {
    'connectors.servers': field([{ id: 'linear', url: 'https://mcp.linear.app/mcp' }, { id: 'notion', url: 'https://mcp.notion.com/mcp' }]),
    'team.agents': field([{ id: 'reviewer' }, { id: 'coder' }]),
    'claude.remoteControl': field(true),
    'claude.fullAccess': field(false),
    'claude.idleHours': field(2),
    'claude.models': field([]),
    'remote.httpsPort': field(443),
    'models.hiddenProviders': field(['deepseek-official']),
    'git.model': field(''),
    'git.instructions': field('Use Conventional Commits'),
  }
  const states = { linear: { phase: 'connected', tools: 30, via: 'oauth' }, notion: { phase: 'expired' } } as const
  const connectors = summarize('connectors', fields, (id) => states[id as keyof typeof states])
  assert.equal(connectors.attention, true)
  assert.match(connectors.text, /Linear .+ · Notion /)
  assert.equal(summarize('team', fields, () => undefined).text.includes('reviewer, coder'), true)
  assert.equal(summarize('models', fields, () => undefined).attention, false)
  assert.equal(summarize('remote', { ...fields, 'remote.httpsPort': field('x', true) }, () => undefined).attention, true)
  assert.equal(summarize('connectors', { 'connectors.servers': field([]) }, () => undefined).attention, false)
})

test('local tasks: kept in one file, changed one at a time; a broken file is set aside', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-board-'))
  try {
    const file = join(dir, 'nested', 'board.json')
    const tasks = new LocalTasks(file)
    assert.deepEqual(await tasks.list(), [])
    await assert.rejects(tasks.create({ title: '  ', repo: '/r' }), /title/)
    const [a, b] = await Promise.all([tasks.create({ title: ' First ', repo: '/r', note: ' why ' }), tasks.create({ title: 'Second', repo: '/r', stage: 'backlog' })])
    assert.equal(a.title, 'First')
    assert.equal(a.note, 'why')
    assert.equal(a.stage, 'unstarted')
    assert.equal(b.stage, 'backlog')
    const moved = await tasks.update(a.id, { stage: 'started', branch: 'task/first', note: '' })
    assert.equal(moved.stage, 'started')
    assert.equal(moved.note, undefined)
    await tasks.remove(b.id)
    // A fresh reader sees what was written.
    assert.deepEqual((await new LocalTasks(file).list()).map((task) => [task.title, task.stage, task.branch]), [['First', 'started', 'task/first']])
    writeFileSync(file, '{ not json')
    assert.deepEqual(await new LocalTasks(file).list(), [])
    assert.ok(readdirSync(join(dir, 'nested')).some((name) => name.startsWith('board.json.corrupt-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A Linear account whose board, issues, states and saves are in memory. */
function account(id: string, repos: string[], issues: Issue[], fail?: string): LinearAccount & { moves: Array<[string, string]>; saves: Array<[string, Record<string, string>]>; reads: string[] } {
  const moves: Array<[string, string]> = []
  const saves: Array<[string, Record<string, string>]> = []
  const reads: string[] = []
  const tickets = {
    async board() {
      if (fail !== undefined) throw new Error(fail)
      return issues
    },
    async issue(identifier: string, fresh?: boolean) {
      reads.push(`${identifier}${fresh === true ? ':fresh' : ''}`)
      if (fail !== undefined) throw new Error(fail)
      return issues.find((issue) => issue.identifier === identifier)
    },
    async teamStates() { return STATES },
    async move(identifier: string, stateId: string) { moves.push([identifier, stateId]) },
    async update(identifier: string, patch: Record<string, string>) { saves.push([identifier, patch]) },
    async workspaceProjects() {
      if (fail !== undefined) throw new Error(fail)
      return [{ name: 'Auth', color: id === 'linear' ? '#111111' : '#222222' }]
    },
  } as unknown as LinearTickets
  return { id, repos, tickets, moves, saves, reads }
}

/** A board host over in-memory worktrees: `add` makes one (and registers it), `open` registers one. */
function treesHost(repos: RepoGroup[], trees: Worktree[], linear: () => LinearAccount[], tasks: LocalTasks) {
  const added: Array<[string, string, string | undefined]> = []
  const opened: string[] = []
  const host: BoardHost = {
    repos: async () => repos,
    linear,
    tasks,
    worktrees: async () => trees,
    async openWorktree(_cwd, path) {
      opened.push(path)
      return { path, workspaceId: `ws:${path}` }
    },
    async addWorktree(cwd, branch, base) {
      added.push([cwd, branch, base])
      await new Promise((resolve) => setTimeout(resolve, 5))
      trees.push({ path: `/r/app/.worktrees/${branch}`, branch, main: false, current: false })
      return { workspaceId: `new:${branch}`, path: `/r/app/.worktrees/${branch}` }
    },
  }
  return { host, added, opened }
}

const APP: RepoGroup[] = [{ key: '/r/app', name: 'app', members: [
  { workspaceId: 'main', path: '/r/app', title: 'app', main: true, branch: 'main' },
  { workspaceId: 'wt', path: '/r/app/.worktrees/vi/eng-1-login', title: 'app · vi/eng-1-login', main: false, branch: 'vi/eng-1-login' },
] }]

test('board service: Linear issues and local tasks become cards; moves go through the RPC surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-board-'))
  try {
    const work = account('linear', [], [
      { identifier: 'ENG-1', title: 'Login', state: 'In Review', stateType: 'started', priority: 2, team: 't1', branch: 'vi/eng-1-login', updatedAt: '2026-10-01T00:00:00Z' },
      { identifier: 'ENG-2', title: 'Signup', state: 'Todo', stateType: 'unstarted', team: 't1' },
    ])
    const personal = account('linear-2', ['/r/other'], [{ identifier: 'ENG-1', title: 'dup', stateType: 'backlog' }])
    const broken = account('linear-3', [], [], 'unauthorized')
    const tasks = new LocalTasks(join(dir, 'board.json'))
    const { host } = treesHost(APP, [], () => [work, personal, broken], tasks)
    const notes = await tasks.create({ title: 'Notes', repo: '/r/app' })
    const board = new BoardService(host)
    const state = await board.state(true)
    assert.deepEqual(state.linear, { accounts: 3, errors: ['linear-3: unauthorized'] })
    // Projects of every account, by name (the first account naming one wins); a failed read leaves none.
    assert.deepEqual(state.projects, [{ name: 'Auth', color: '#111111' }])
    const byKey = new Map(state.cards.map((card) => [card.key, card]))
    // Identical identifiers from different connectors are never merged.
    assert.equal(byKey.get('linear:linear-2:ENG-1')?.title, 'dup')
    assert.deepEqual(byKey.get('linear:linear-2:ENG-1')?.repos, ['/r/other'])
    assert.equal(byKey.get('linear:linear:ENG-1')?.stage, 'started')
    assert.equal(byKey.get('linear:linear:ENG-2')?.branch, 'eng-2-signup')
    assert.equal(byKey.get(`local:${notes.id}`)?.title, 'Notes')
    // Worktrees are linked in the browser, not by the host.
    assert.ok(state.cards.every((card) => card.workspace === undefined))

    assert.deepEqual(await board.handle({ op: 'move', connector: 'linear', identifier: 'ENG-2', team: 't1', stage: 'completed' }), { ok: true, value: STATES[2] })
    assert.deepEqual(await board.handle({ op: 'move', connector: 'nope', identifier: 'ENG-2', stage: 'completed' }), { ok: false, error: 'that Linear account is not connected' })
    const reply = await board.handle({ op: 'states', connector: 'linear', team: 't1' }) as { ok: true; value: IssueState[] }
    assert.equal(reply.value[0]?.id, 'tri')
    assert.deepEqual(await board.handle({ op: 'start', card: { source: 'linear' }, repo: '/r/app' } as never), { ok: false, error: 'nothing to start' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('board start: Linear\'s branch from a fresh read; the ticket moves to In Progress and is taken in one save', async () => {
  const work = account('linear', [], [
    { identifier: 'ENG-2', title: 'Signup', state: 'Todo', stateType: 'unstarted', team: 't1', branch: 'vi/eng-2-signup', assigned: false },
    { identifier: 'ENG-3', title: 'Theirs', state: 'Backlog', stateType: 'backlog', team: 't1', branch: 'eng-3-theirs', assigned: true, assignee: 'Ada' },
    { identifier: 'ENG-4', title: 'Unknown owner', state: 'In Progress', stateType: 'started', team: 't1', branch: 'eng-4-x' },
  ])
  const { host, added } = treesHost(APP, [], () => [work], { list: async () => [] } as unknown as LocalTasks)
  const board = new BoardService(host)

  // The browser's stale branch loses to Linear's own suggestion; `base` reaches git.
  const started = await board.start({ source: 'linear', id: 'eng-2', title: 'Signup', connector: 'linear', branch: 'eng-2-old' }, '/r/app', 'develop')
  assert.deepEqual(added, [['/r/app', 'vi/eng-2-signup', 'develop']])
  assert.deepEqual(work.reads, ['ENG-2:fresh'])
  assert.deepEqual(work.saves, [['ENG-2', { state: 'prog', assignee: 'me' }]])
  assert.deepEqual({ ...started }, { workspaceId: 'new:vi/eng-2-signup', path: '/r/app/.worktrees/vi/eng-2-signup', branch: 'vi/eng-2-signup', created: true, stage: 'started', state: 'In Progress' })

  // Someone else has it: only the state moves.
  await board.start({ source: 'linear', id: 'ENG-3', title: 'Theirs', connector: 'linear' }, '/r/app')
  assert.deepEqual(work.saves.at(-1), ['ENG-3', { state: 'prog' }])
  // Already started and its owner unknown: nothing is saved.
  const saves = work.saves.length
  const unknown = await board.start({ source: 'linear', id: 'ENG-4', title: 'Unknown owner', connector: 'linear' }, '/r/app')
  assert.equal(work.saves.length, saves)
  assert.equal(unknown.state, 'In Progress')
  await assert.rejects(board.start({ source: 'linear', id: 'ENG-2', title: 'x', connector: 'linear' }, '/r/nowhere'), /not a DSH workspace/)
  await assert.rejects(board.start({ source: 'linear', id: 'ENG-9', title: 'x', connector: 'linear' }, '/r/app'), /Linear does not know ENG-9/)
})

test('board start: idempotent: concurrent starts share one run, a later one opens the worktree already there', async () => {
  const work = account('linear', [], [{ identifier: 'ENG-2', title: 'Signup', stateType: 'unstarted', team: 't1', branch: 'vi/eng-2-signup', assigned: true }])
  const trees: Worktree[] = [
    { path: '/r/app', branch: 'main', main: true, current: true },
    // An unregistered tree on another spelling of the ticket's branch, and a pruned one.
    { path: '/r/app/.worktrees/eng-5-old', branch: 'ENG-5-old', main: false, current: false },
    { path: '/gone', branch: 'eng-6-gone', main: false, current: false, prunable: 'gone' },
  ]
  const { host, added, opened } = treesHost(APP, trees, () => [work], { list: async () => [] } as unknown as LocalTasks)
  const board = new BoardService(host)
  const card = { source: 'linear' as const, id: 'ENG-2', title: 'Signup', connector: 'linear' }
  // From the board (the repository) and the Git pane (a worktree of it, no connector) at once.
  const [a, b] = await Promise.all([board.start(card, '/r/app'), board.start({ ...card, connector: undefined } as never, '/r/app/.worktrees/vi/eng-1-login')])
  assert.equal(a, b)
  assert.equal(added.length, 1)
  assert.equal(work.saves.length, 1)
  const again = await board.start(card, '/r/app')
  assert.equal(added.length, 1)
  assert.equal(again.created, false)
  assert.equal(again.workspaceId, 'ws:/r/app/.worktrees/vi/eng-2-signup')

  // A tree on any branch naming the ticket is found; a pruned one is not.
  const five = account('linear', [], [{ identifier: 'ENG-5', title: 'Old', stateType: 'started', team: 't1', branch: 'vi/eng-5-old' }])
  const six = account('linear', [], [{ identifier: 'ENG-6', title: 'Gone', stateType: 'started', team: 't1', branch: 'eng-6-gone' }])
  const old = await new BoardService({ ...host, linear: () => [five] }).start({ source: 'linear', id: 'ENG-5', title: 'Old' }, '/r/app')
  assert.deepEqual([old.created, old.branch, opened.at(-1)], [false, 'ENG-5-old', '/r/app/.worktrees/eng-5-old'])
  const gone = await new BoardService({ ...host, linear: () => [six] }).start({ source: 'linear', id: 'ENG-6', title: 'Gone' }, '/r/app')
  assert.equal(gone.created, true)
})

test('board start: Linear unreachable still makes the worktree on the branch the browser saw; a refused save is a warning', async () => {
  const down = account('linear', [], [], 'socket hang up')
  const { host, added } = treesHost(APP, [], () => [down], { list: async () => [] } as unknown as LocalTasks)
  const result = await new BoardService(host).start({ source: 'linear', id: 'ENG-7', title: 'Offline', connector: 'linear', branch: 'vi/eng-7-offline' }, '/r/app')
  assert.deepEqual(added, [['/r/app', 'vi/eng-7-offline', undefined]])
  assert.equal(result.created, true)
  assert.equal(result.stage, undefined)
  assert.match(result.warning ?? '', /socket hang up/)

  const refusing = account('work', [], [{ identifier: 'ENG-1', title: 'Work', state: 'Todo', stateType: 'unstarted', team: 't', branch: 'eng-1-work', assigned: false }])
  refusing.tickets.update = async () => { throw new Error('Linear denied') }
  const refused = await new BoardService(treesHost(APP, [], () => [refusing], { list: async () => [] } as unknown as LocalTasks).host)
    .start({ source: 'linear', id: 'ENG-1', title: 'Work', connector: 'work' }, '/r/app')
  assert.equal(refused.workspaceId, 'new:eng-1-work')
  assert.equal(refused.stage, undefined)
  assert.equal(refused.state, undefined)
  assert.match(refused.warning ?? '', /Linear denied/)
})

test('board start: a local task gets its branch and moves to in progress; the Git pane\'s ticket finds its repository\'s account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-board-'))
  try {
    const tasks = new LocalTasks(join(dir, 'board.json'))
    const other = account('other', ['/r/other'], [])
    const mine = account('mine', ['/r/app'], [{ identifier: 'ENG-8', title: 'Mine', stateType: 'started', team: 't1', branch: 'eng-8-mine' }])
    const { host, added } = treesHost(APP, [], () => [other, mine], tasks)
    const board = new BoardService(host)
    const fresh = await tasks.create({ title: 'Write docs', repo: '/r/app', stage: 'backlog' })
    const started = await board.start({ source: 'local', id: fresh.id, title: 'ignored' }, '/r/app')
    assert.deepEqual(added.at(-1), ['/r/app', 'task/write-docs', undefined])
    assert.equal(started.stage, 'started')
    assert.deepEqual((await tasks.list()).map((task) => [task.branch, task.stage]), [['task/write-docs', 'started']])
    await assert.rejects(board.start({ source: 'local', id: 'missing', title: '' }, '/r/app'), /no longer exists/)

    await board.start({ source: 'linear', id: 'ENG-8', title: 'Mine' }, '/r/app')
    assert.deepEqual([other.reads, mine.reads], [[], ['ENG-8:fresh']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('board links: each card finds its registered worktree by branch, in one pass', () => {
  const repos: RepoGroup[] = [
    { key: '/r/app', name: 'app', members: [
      { workspaceId: 'main', path: '/r/app', title: 'app', main: true, branch: 'main' },
      { workspaceId: 'w1', path: '/r/app/.worktrees/vi/eng-1-login', title: '', main: false, branch: 'vi/eng-1-login' },
      { workspaceId: 'w2', path: '/r/app/.worktrees/task/notes', title: '', main: false, branch: 'task/notes' },
      { workspaceId: 'w3', path: '/r/app/.worktrees/x', title: '', main: false },
    ] },
    { key: '/r/other', name: 'other', members: [{ workspaceId: 'o1', path: '/r/other', title: '', main: true, branch: 'ENG-1-other' }] },
  ]
  const card = (patch: Partial<Card>): Card => ({ key: patch.id!, source: 'linear', id: '', title: '', stage: 'started', repos: [], updatedAt: 0, ...patch })
  const cards = [
    card({ key: 'a', id: 'ENG-1' }),
    card({ key: 'b', id: 'ENG-1', repos: ['/r/other'] }),
    card({ key: 'c', id: 'ENG-2' }),
    card({ key: 'd', id: 'notes', source: 'local', branch: 'task/notes', repos: ['/r/app'] }),
    card({ key: 'e', id: 'other', source: 'local', branch: 'task/notes', repos: ['/r/other'] }),
  ]
  const links = linkTrees(cards, repos, samePath)
  assert.equal(links.get('a')?.id, 'w1')
  assert.deepEqual(links.get('b'), { id: 'o1', branch: 'ENG-1-other', repo: '/r/other' })
  assert.equal(links.has('c'), false)
  assert.equal(links.get('d')?.id, 'w2')
  assert.equal(links.has('e'), false)
  // A card with worktrees in two repositories prefers the one shown.
  assert.equal(linkTrees(cards, repos, samePath, '/r/other').get('a')?.id, 'o1')
  assert.equal(linkTrees([], repos, samePath).size, 0)
})

test('board start repositories: one answer starts at once, several ask', () => {
  const all = ['/r/app', '/r/lib', '/r/other']
  const linear = (repos: string[]): Card => ({ key: 'k', source: 'linear', id: 'ENG-1', title: '', stage: 'unstarted', repos, updatedAt: 0 })
  assert.deepEqual(startRepos(linear([]), '', all, samePath), all)
  assert.deepEqual(startRepos(linear([]), '/r/lib', all, samePath), ['/r/lib'])
  assert.deepEqual(startRepos(linear(['/r/app']), '', all, samePath), ['/r/app'])
  // The board shows a repository this account does not serve: its own repositories still.
  assert.deepEqual(startRepos(linear(['/r/app', '/r/lib']), '/r/other', all, samePath), ['/r/app', '/r/lib'])
  assert.deepEqual(startRepos({ ...linear([]), source: 'local', repos: ['/r/lib'] }, '/r/app', all, samePath), ['/r/lib'])
  assert.deepEqual(startRepos({ ...linear([]), source: 'local', repos: ['/r/gone'] }, '', all, samePath), [])
})

/** Connected Linear accounts over a fake mcp-client; each has a stored token. */
async function linearAccounts(entries: Array<{ id: string; url: string; repos?: string[] }>, repoOf: (dir: string) => Promise<string | undefined>) {
  const records = new Map<string, unknown>(entries.map((entry) => [`dsh-agent-hub/connector-${entry.id}`, { kind: 'api-key', key: `token-${entry.id}` }]))
  const live = new Set<string>()
  const host: ConnectorsHost = {
    entries: () => entries,
    credentials: {
      async readRecord(key) { return records.get(String(key)) as never },
      async modifyRecord(key, mutate) { return mutate(records.get(String(key))) },
      async deleteRecord(key) { records.delete(String(key)) },
    },
    key: (id) => `dsh-agent-hub/connector-${id}`,
    mount(config) {
      const name = (config as { serverName: string }).serverName
      live.add(name)
      const fiber: Mounted = { dispose: () => { live.delete(name) }, await: async () => fiber }
      return fiber
    },
    toolCount: (id) => (live.has(id) ? 3 : 0),
    log: () => {},
    repoOf,
  }
  const connectors = new Connectors(host)
  await connectors.sync()
  return connectors
}

test('connectors: a repository uses the Linear account linked to it, else an unlinked one', async () => {
  const connectors = await linearAccounts([
    { id: 'notion', url: 'https://mcp.notion.com/mcp' },
    { id: 'work', url: 'https://mcp.linear.app/mcp', repos: ['/r/app', '/r/api'] },
    { id: 'personal', url: 'https://mcp.linear.app/mcp' },
  ], async () => undefined)
  try {
    assert.deepEqual(connectors.linears().map((item) => [item.id, item.repos]), [['work', ['/r/app', '/r/api']], ['personal', []]])
    const work = connectors.linears()[0]!.tickets
    const personal = connectors.linears()[1]!.tickets
    assert.equal(connectors.issues('/r/api'), work)
    assert.equal(connectors.issues('/r/blog'), personal)
    // Unknown repository: the unlinked account answers.
    assert.equal(connectors.issues(), personal)
  } finally {
    connectors.dispose()
  }
  const linkedOnly = await linearAccounts([{ id: 'work', url: 'https://mcp.linear.app/mcp', repos: ['/r/app'] }], async () => undefined)
  try {
    // A repository no account is linked to gets no tickets at all.
    assert.equal(linkedOnly.issues('/r/blog'), undefined)
    assert.notEqual(linkedOnly.issues('/r/app'), undefined)
    assert.deepEqual(await linkedOnly.handle({ op: 'status' }), { connectors: [{ id: 'work', url: 'https://mcp.linear.app/mcp', state: { phase: 'connected', tools: 3, via: 'token' } }], issues: true })
  } finally {
    linkedOnly.dispose()
  }
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('repos: workspaces group by the repository they are in, worktrees inside it included', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ah-repos-')))
  const git = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }) }
  try {
    const app = join(dir, 'app')
    mkdirSync(app)
    git(app, 'init', '-q', '-b', 'main')
    git(app, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    const tree = join(app, '.worktrees', 'feat')
    git(app, 'worktree', 'add', '-q', '-b', 'feat/x', tree)
    const plain = join(dir, 'notes')
    mkdirSync(plain)
    assert.ok(existsSync(tree))
    const order = ['wt', 'notes', 'main']
    const paths: Record<string, string> = { main: app, wt: tree, notes: plain }
    const registry: RepoWorkspaces = {
      list: () => order.map((id) => ({ id, path: paths[id]!, title: id === 'wt' ? 'app · feat/x' : id, sessionIds: [] })),
    }
    const index = new RepoIndex(() => registry)
    const groups = await index.list()
    assert.equal(groups.length, 1)
    assert.equal(groups[0]!.name, 'app')
    assert.ok(samePath(groups[0]!.key, app))
    assert.deepEqual(groups[0]!.members.map((member) => [member.workspaceId, member.main, member.branch]), [['main', true, 'main'], ['wt', false, 'feat/x']])
    assert.ok(samePath((await index.repoOf(tree))!, app))
    assert.equal(await index.repoOf(plain), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('linear: the board reads open issues and recently finished ones; a move drops the cache', async () => {
  const { LinearTickets } = await import('../src/connectors/linear.ts')
  const calls: Array<[string, Record<string, unknown>]> = []
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const recent = new Date(Date.now() - 86_400_000).toISOString()
  const session = {
    async tools() {
      return [
        { name: 'list_issues', inputSchema: { properties: { assignee: {}, limit: {}, orderBy: {}, fields: {} } } },
        { name: 'list_issue_statuses', inputSchema: { properties: { team: {} } } },
        { name: 'save_issue', inputSchema: { properties: { id: {}, state: {} } } },
      ]
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push([name, args])
      if (name === 'list_issue_statuses') return [{ id: 's1', type: 'Started', name: 'In Progress' }, { bogus: true }]
      if (name === 'save_issue') return { id: args.id }
      return { issues: [
        { id: 'ENG-1', title: 'open', status: 'Todo', statusType: 'unstarted', priority: { value: 2, name: 'High' }, assignee: 'vi@x.ai', project: 'Hub', teamId: 't1', updatedAt: old },
        { id: 'ENG-2', title: 'done long ago', status: 'Done', statusType: 'completed', updatedAt: old },
        { id: 'ENG-3', title: 'done lately', status: 'Done', statusType: 'completed', updatedAt: recent },
      ] }
    },
  } as unknown as import('../src/connectors/mcp.ts').McpSession
  const tickets = new LinearTickets(() => session)
  const issues = await tickets.board(true)
  assert.deepEqual(issues.map((issue) => issue.identifier), ['ENG-1', 'ENG-3'])
  assert.deepEqual({ ...issues[0], updatedAt: undefined }, { identifier: 'ENG-1', title: 'open', state: 'Todo', stateType: 'unstarted', priority: 2, assignee: 'vi@x.ai', assigned: true, project: 'Hub', team: 't1', updatedAt: undefined })
  assert.equal(calls[0]![1].assignee, 'me')
  assert.ok(Array.isArray(calls[0]![1].fields))
  await tickets.board(true)
  assert.equal(calls.filter(([name]) => name === 'list_issues').length, 1)
  assert.deepEqual(await tickets.teamStates('t1'), [{ id: 's1', name: 'In Progress', type: 'started' }])
  await tickets.move('ENG-1', 's1')
  assert.deepEqual(calls.at(-1), ['save_issue', { id: 'ENG-1', state: 's1' }])
  await tickets.board(true)
  assert.equal(calls.filter(([name]) => name === 'list_issues').length, 2)
})

test('linear: projects are read 50 a page over every page; a project shows its every issue', async () => {
  const { LinearTickets } = await import('../src/connectors/linear.ts')
  const calls: Array<[string, Record<string, unknown>]> = []
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const session = {
    async tools() {
      return [
        { name: 'list_projects', inputSchema: { properties: { limit: {}, cursor: {}, team: {}, fields: {} } } },
        { name: 'list_issues', inputSchema: { properties: { project: {}, limit: {}, cursor: {}, orderBy: {}, fields: {} } } },
      ]
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push([name, args])
      if (name === 'list_projects') {
        if ((args.limit as number) > 50) throw new Error('limit: Too big: expected number to be <=50')
        return args.cursor === undefined
          ? { projects: [{ id: 'P-1', name: 'Charts', color: '#26b5ce' }], hasNextPage: true, cursor: 'c1' }
          : { projects: [{ id: 'P-2', name: 'Alerts' }], hasNextPage: false }
      }
      return args.cursor === undefined
        ? { issues: [{ id: 'ENG-1', title: 'open', statusType: 'started', project: 'Charts', assignee: 'someone' }], hasNextPage: true, cursor: 'i1' }
        : { issues: [{ id: 'ENG-2', title: 'done long ago', statusType: 'completed', project: 'Charts', updatedAt: old }], hasNextPage: false }
    },
  } as unknown as import('../src/connectors/mcp.ts').McpSession
  const tickets = new LinearTickets(() => session)
  assert.deepEqual((await tickets.workspaceProjects()).map((project) => project.name), ['Charts', 'Alerts'])
  assert.deepEqual(calls.map(([, args]) => args.cursor), [undefined, 'c1'])
  assert.deepEqual((await tickets.projects('t1')).map((project) => project.name), ['Charts', 'Alerts'])
  calls.length = 0
  // Finished long ago and someone else's: a project's view still shows it.
  assert.deepEqual((await tickets.projectBoard('Charts')).map((issue) => issue.identifier), ['ENG-1', 'ENG-2'])
  assert.deepEqual(calls.map(([name, args]) => [name, args.project, args.cursor]), [['list_issues', 'Charts', undefined], ['list_issues', 'Charts', 'i1']])
})

test('linear: a server that cannot filter issues by project shows none for a project', async () => {
  const { LinearTickets } = await import('../src/connectors/linear.ts')
  let listed = 0
  const session = {
    async tools() { return [{ name: 'list_issues', inputSchema: { properties: { limit: {} } } }] },
    async tool() { listed++; return { issues: [{ id: 'ENG-9', title: 'anything' }] } },
  } as unknown as import('../src/connectors/mcp.ts').McpSession
  assert.deepEqual(await new LinearTickets(() => session).projectBoard('Charts'), [])
  assert.equal(listed, 0)
})

test('board service: the project shown brings its every issue along with the board', async () => {
  const work = account('linear', [], [{ identifier: 'ENG-1', title: 'mine', stateType: 'started', project: 'Charts' }])
  const asked: string[] = []
  ;(work.tickets as unknown as { projectBoard: (project: string) => Promise<Issue[]> }).projectBoard = async (project) => {
    asked.push(project)
    return [{ identifier: 'ENG-1', title: 'mine', stateType: 'started', project }, { identifier: 'ENG-7', title: 'theirs', stateType: 'completed', project }]
  }
  const { host } = treesHost(APP, [], () => [work], new LocalTasks(join(mkdtempSync(join(tmpdir(), 'ah-board-')), 'board.json')))
  const board = new BoardService(host)
  const plain = await board.handle({ op: 'state', mine: true }) as BoardReply<BoardState>
  assert.ok(plain.ok)
  assert.deepEqual(plain.value.cards.map((card) => card.id), ['ENG-1'])
  assert.deepEqual(asked, [])
  const reply = await board.handle({ op: 'state', mine: true, project: 'Charts' }) as BoardReply<BoardState>
  assert.ok(reply.ok)
  assert.deepEqual(reply.value.cards.map((card) => card.id), ['ENG-1', 'ENG-7'])
  assert.deepEqual(asked, ['Charts'])
})

test('local tasks: returned values cannot mutate storage, and only ENOENT means empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-board-safe-'))
  try {
    const file = join(dir, 'board.json')
    const tasks = new LocalTasks(file)
    const created = await tasks.create({ title: 'Original', repo: '/r' })
    created.title = 'Bad create'
    const listed = await tasks.list()
    listed[0]!.title = 'Bad list'
    listed.pop()
    assert.equal((await tasks.list())[0]?.title, 'Original')
    const updated = await tasks.update(created.id, { title: 'Updated' })
    updated.title = 'Bad update'
    assert.equal((await tasks.list())[0]?.title, 'Updated')
    await tasks.create({ title: 'Second', repo: '/r' })
    assert.equal((await new LocalTasks(file).list())[0]?.title, 'Updated')
    const unreadable = new LocalTasks(dir)
    await assert.rejects(unreadable.list())
    await assert.rejects(unreadable.create({ title: 'No overwrite', repo: '/r' }))
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ bogus: true }] }))
    assert.deepEqual(await new LocalTasks(file).list(), [])
    assert.ok(readdirSync(dir).some((name) => name.startsWith('board.json.corrupt-')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('local tasks: a failed corruption backup forbids writes to the original', async () => {
  const fs = await import('node:fs/promises')
  let writes = 0
  let backups = 0
  const dir = mkdtempSync(join(tmpdir(), 'ah-board-backup-'))
  const mocked = mock.module('node:fs/promises', { namedExports: {
    ...fs,
    readFile: async () => '{broken',
    rename: async () => { backups++; throw new Error('backup denied') },
    writeFile: async () => { writes++ },
  } })
  try {
    const isolatedModule = '../src/board/store.ts?backup-failure'
    const { LocalTasks: IsolatedTasks } = await import(isolatedModule) as typeof import('../src/board/store.ts')
    const tasks = new IsolatedTasks(join(dir, 'board.json'))
    await assert.rejects(tasks.list(), /backup denied/)
    await assert.rejects(tasks.create({ title: 'No overwrite', repo: '/r' }), /backup denied/)
    assert.equal(backups, 1)
    assert.equal(writes, 0)
  } finally { mocked.restore(); rmSync(dir, { recursive: true, force: true }) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const browserCard = (): Card => ({ key: 'local:one', source: 'local', id: 'one', title: 'Original', repos: ['/r'], stage: 'unstarted', updatedAt: 1 })
const browserState = (cards: Card[]): BoardState => ({ cards, linear: { accounts: 0, errors: [] }, accounts: { linear: [], slack: [] }, bots: [] })

/** Controlled RPC: tests decide when reads and writes complete, without timers. */
function browserStore() {
  const requests: Array<{ payload: BoardRequest; result: ReturnType<typeof deferred<BoardReply<unknown>>> }> = []
  const call: BoardCall = (payload) => {
    const result = deferred<BoardReply<unknown>>()
    requests.push({ payload, result })
    return result.promise
  }
  const store = new BoardStore(call)
  return { store, requests }
}

async function seedBrowser(store: BoardStore, requests: ReturnType<typeof browserStore>['requests'], cards = [browserCard()]) {
  const load = store.load()
  requests.at(-1)!.result.resolve({ ok: true, value: browserState(cards) })
  await load
}

test('board client: failed writes restart a fenced filter read and keep polling alive', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, requests } = browserStore()
  const off = store.subscribe(() => {})
  try {
    await seedBrowser(store, requests)
    const card = browserCard()
    const moving = store.move(card, 'started')
    const mutation = requests.at(-1)!
    store.setFilters({ mine: false })
    const oldRead = requests.at(-1)!
    mutation.result.resolve({ ok: false, error: 'refused' })
    assert.equal(await moving, false)
    oldRead.result.resolve({ ok: true, value: browserState([{ ...card, title: 'stale' }]) })
    await Promise.resolve(); await Promise.resolve()
    t.mock.timers.tick(0)
    const retry = requests.at(-1)!
    assert.notEqual(retry, oldRead)
    assert.equal(retry.payload.op, 'state')
    assert.equal((retry.payload as { mine: boolean }).mine, false)
    retry.result.resolve({ ok: true, value: browserState([card]) })
    await Promise.resolve(); await Promise.resolve()
    t.mock.timers.tick(100_000)
    assert.notEqual(requests.at(-1), retry, 'future polls remain scheduled')
    assert.equal(store.getSnapshot().notice, 'refused')
  } finally {
    off(); store.dispose()
    if (original === undefined) delete (globalThis as { document?: unknown }).document
    else Object.defineProperty(globalThis, 'document', original)
  }
})

test('board client: the project filter narrows the cards, is remembered, and counts across projects', async () => {
  const stored = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } })
  try {
    const { store, requests } = browserStore()
    const linear = (id: string, project?: string): Card => ({ key: `linear:l:${id}`, source: 'linear', id, title: id, repos: [], stage: 'unstarted', updatedAt: 1, ...(project === undefined ? {} : { project }) })
    await seedBrowser(store, requests, [linear('ENG-1', 'Auth'), linear('ENG-2', 'Billing'), linear('ENG-3'), browserCard()])
    store.setFilters({ project: 'Auth' })
    assert.deepEqual(store.visible().map((card) => card.id), ['ENG-1'])
    assert.equal(store.visible(false).length, 4)
    assert.equal(JSON.parse(stored.get('dsh-agent-hub.board.filters.v1')!).project, 'Auth')
    assert.equal(new BoardStore(async () => ({ ok: false, error: 'off' })).getSnapshot().filters.project, 'Auth')
    store.setFilters({ project: '' })
    assert.equal(store.visible().length, 4)
    store.dispose()
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
    else Object.defineProperty(globalThis, 'localStorage', original)
  }
})

test('board service: connector identity and configuration order survive out-of-order responses', async () => {
  const first = deferred<Issue[]>()
  const a = account('first', [], [])
  a.tickets.board = () => first.promise
  const b = account('second', [], [{ identifier: 'ENG-1', title: 'Second workspace', stateType: 'backlog' }])
  const board = new BoardService(treesHost([], [], () => [a, b], { list: async () => [] } as unknown as LocalTasks).host)
  const reading = board.state(true)
  first.resolve([{ identifier: 'ENG-1', title: 'First workspace', stateType: 'unstarted' }])
  const state = await reading
  assert.deepEqual(state.cards.map((card) => [card.key, card.title]), [['linear:first:ENG-1', 'First workspace'], ['linear:second:ENG-1', 'Second workspace']])
})

test('board client: start shows at once, links the new worktree from the repositories, and undoes a failure', async () => {
  let groups: RepoGroup[] = [{ key: '/r', name: 'r', members: [{ workspaceId: 'main', path: '/r', title: 'r', main: true, branch: 'main' }] }]
  const listeners = new Set<() => void>()
  let loads = 0
  const repos = {
    getSnapshot: () => ({ repos: groups }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    async load() { loads++ },
  }
  const requests: Array<{ payload: BoardRequest; result: ReturnType<typeof deferred<BoardReply<unknown>>> }> = []
  const store = new BoardStore((payload) => {
    const result = deferred<BoardReply<unknown>>()
    requests.push({ payload, result })
    return result.promise
  }, repos)
  try {
    const ticket: Card = { key: 'linear:linear:ENG-1', source: 'linear', id: 'ENG-1', title: 'Login', stage: 'unstarted', repos: [], connector: 'linear', branch: 'eng-1-login', updatedAt: 1 }
    await seedBrowser(store, requests, [ticket])
    assert.equal(store.getSnapshot().repos, groups)
    const linked = store.cards()
    assert.equal(store.cards(), linked, 'links are not recomputed while nothing changed')

    const start = store.start(ticket, '/r', 'develop')
    const writing = requests.at(-1)!
    assert.deepEqual(writing.payload, { op: 'start', card: { source: 'linear', id: 'ENG-1', title: 'Login', connector: 'linear', branch: 'eng-1-login' }, repo: '/r', base: 'develop' })
    assert.deepEqual(store.getSnapshot().starting, [ticket.key])
    assert.equal(store.card(ticket.key)?.stage, 'started')
    // Registered elsewhere meanwhile (the sidebar saw it): the card links at once.
    groups = [{ ...groups[0]!, members: [...groups[0]!.members, { workspaceId: 'w1', path: '/r/.worktrees/vi/eng-1-login', title: '', main: false, branch: 'vi/eng-1-login' }] }]
    for (const listener of listeners) listener()
    assert.equal(store.card(ticket.key)?.workspace?.id, 'w1')
    const before = loads
    writing.result.resolve({ ok: true, value: { workspaceId: 'w1', path: '/r/.worktrees/vi/eng-1-login', branch: 'vi/eng-1-login', created: true, stage: 'started', state: 'In Progress' } })
    const result = await start
    assert.equal(result?.created, true)
    assert.ok(loads > before, 'the repositories were read again')
    assert.deepEqual(store.getSnapshot().starting, [])
    assert.deepEqual([store.card(ticket.key)?.state, store.card(ticket.key)?.branch], ['In Progress', 'vi/eng-1-login'])
    requests.at(-1)!.result.resolve({ ok: true, value: browserState([ticket]) })

    const local = browserCard()
    const failing = store.start(local, '/r')
    requests.at(-1)!.result.resolve({ ok: false, error: 'branch is checked out elsewhere' })
    assert.equal(await failing, undefined)
    assert.equal(store.card(local.key)?.stage, 'unstarted', 'the optimistic move is undone')
    assert.equal(store.getSnapshot().notice, 'branch is checked out elsewhere')
    assert.deepEqual(store.getSnapshot().starting, [])
  } finally { store.dispose() }
  assert.equal(listeners.size, 0)
})

test('board client: a ticket picked in the Git pane starts through the same op, and the board reads again', async () => {
  let loads = 0
  const repos = { getSnapshot: () => ({ repos: [] }), subscribe: () => () => {}, async load() { loads++ } }
  const requests: BoardRequest[] = []
  const store = new BoardStore(async (payload) => {
    requests.push(payload)
    return payload.op === 'start'
      ? { ok: true, value: { path: '/r/.worktrees/eng-1', branch: 'eng-1', created: false } }
      : { ok: true, value: browserState([]) }
  }, repos)
  const off = store.subscribe(() => {})
  try {
    const reply = await store.startIssue({ identifier: 'ENG-1', title: 'Login', branch: 'eng-1' }, '/r/.worktrees/other')
    assert.deepEqual(reply, { ok: true, value: { path: '/r/.worktrees/eng-1', branch: 'eng-1', created: false } })
    assert.deepEqual(requests[0], { op: 'start', card: { source: 'linear', id: 'ENG-1', title: 'Login', branch: 'eng-1' }, repo: '/r/.worktrees/other' })
    assert.equal(loads >= 1, true)
    assert.deepEqual(requests.slice(1).map((request) => request.op), ['state'])
  } finally { off(); store.dispose() }
})

test('linear: a fresh read asks for the fields that tell unassigned from unknown; an expired issue answers at once while read again', async (t) => {
  const { LinearTickets, toIssue } = await import('../src/connectors/linear.ts')
  t.mock.timers.enable({ apis: ['Date'] })
  const calls: Array<Record<string, unknown>> = []
  let answer: unknown = { id: 'ENG-1', title: 'One', assigneeId: null, assignee: null, gitBranchName: 'vi/eng-1-one' }
  let fail = false
  const session = {
    async tools() {
      return [
        { name: 'get_issue', inputSchema: { properties: { id: {}, fields: {} } } },
        { name: 'save_issue', inputSchema: { properties: { id: {}, state: {}, assignee: {} } } },
      ]
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push({ name, ...args })
      if (name === 'save_issue') return { id: args.id }
      if (fail) throw new Error('offline')
      return answer
    },
  } as unknown as import('../src/connectors/mcp.ts').McpSession
  const tickets = new LinearTickets(() => session)
  const first = await tickets.issue('eng-1', true)
  assert.deepEqual([first?.assigned, first?.branch], [false, 'vi/eng-1-one'])
  assert.ok((calls[0]!.fields as string[]).includes('assigneeId'))
  answer = { id: 'ENG-1', title: 'Two', assigneeId: 'u1', assignee: 'Ada' }
  assert.equal((await tickets.issue('ENG-1'))?.title, 'One', 'cached')
  t.mock.timers.tick(61_000)
  assert.equal((await tickets.issue('ENG-1'))?.title, 'One', 'stale, but answered at once')
  assert.equal((await tickets.issue('ENG-1'))?.assigned, true, 'then the new read')
  fail = true
  await assert.rejects(tickets.issue('ENG-1', true), /offline/)
  assert.equal((await tickets.issue('ENG-1'))?.title, 'Two', 'a failed read keeps the last answer')
  assert.equal(toIssue({ id: 'ENG-2', title: 'x' })?.assigned, undefined)
  await tickets.update('ENG-1', { state: 's1', assignee: 'me' })
  assert.deepEqual(calls.at(-1), { name: 'save_issue', id: 'ENG-1', state: 's1', assignee: 'me' })
})

test('board client: same-card writes are mutually exclusive and reads preserve pending moves', async () => {
  const { store, requests } = browserStore()
  try {
    await seedBrowser(store, requests)
    const card = browserCard()
    const move = store.move(card, 'started')
    const writing = requests.at(-1)!
    assert.equal(await store.update(card, { title: 'Must wait' }), false)
    assert.equal(await store.start(card, '/r'), undefined)
    await store.remove(card)
    assert.equal(requests.length, 2)
    const load = store.load()
    requests.at(-1)!.result.resolve({ ok: true, value: browserState([card]) })
    await load
    assert.equal(store.getSnapshot().data?.cards[0]?.stage, 'started')
    writing.result.reject('transport gone')
    assert.equal(await move, false)
    assert.deepEqual(store.getSnapshot().data?.cards, [card])
    assert.equal(store.getSnapshot().notice, 'transport gone')
  } finally { store.dispose() }
})

test('board client: rejected edits and deletions restore cards, even through a pending read', async () => {
  const { store, requests } = browserStore()
  try {
    await seedBrowser(store, requests)
    const card = browserCard()
    const edit = store.update(card, { title: 'Optimistic' })
    const writing = requests.at(-1)!
    const load = store.load()
    requests.at(-1)!.result.resolve({ ok: true, value: browserState([card]) })
    await load
    assert.equal(store.getSnapshot().data?.cards[0]?.title, 'Optimistic')
    writing.result.reject(new Error('edit offline'))
    assert.equal(await edit, false)
    assert.deepEqual(store.getSnapshot().data?.cards, [card])
    const remove = store.remove(card)
    const deleting = requests.at(-1)!
    const reload = store.load()
    requests.at(-1)!.result.resolve({ ok: true, value: browserState([card]) })
    await reload
    assert.deepEqual(store.getSnapshot().data?.cards, [])
    deleting.result.resolve({ ok: false, error: 'delete denied' })
    await remove
    assert.deepEqual(store.getSnapshot().data?.cards, [card])
    assert.equal(store.getSnapshot().notice, 'delete denied')
  } finally { store.dispose() }
})

test('board client: completed writes invalidate reads begun before completion', async () => {
  const { store, requests } = browserStore()
  try {
    await seedBrowser(store, requests)
    const move = store.move(browserCard(), 'started')
    const writing = requests.at(-1)!
    const oldRead = store.load()
    const oldRequest = requests.at(-1)!
    writing.result.resolve({ ok: true, value: {} })
    assert.equal(await move, true)
    oldRequest.result.resolve({ ok: true, value: browserState([browserCard()]) })
    await oldRead
    assert.equal(store.getSnapshot().data?.cards[0]?.stage, 'started')
    requests.at(-1)!.result.resolve({ ok: true, value: browserState([{ ...browserCard(), stage: 'started' }]) })
  } finally { store.dispose() }
})

test('board client: start warning preserves successful workspace; transport errors become notices', async () => {
  const { store, requests } = browserStore()
  try {
    await seedBrowser(store, requests)
    const start = store.start(browserCard(), '/r')
    requests.at(-1)!.result.resolve({ ok: true, value: { workspaceId: 'created', path: '/r/.worktrees/task/original', branch: 'task/original', created: true, warning: 'Worktree ready; Linear denied' } })
    assert.equal((await start)?.workspaceId, 'created')
    assert.equal(store.getSnapshot().notice, 'Worktree ready; Linear denied')
    assert.equal(store.getSnapshot().data?.cards[0]?.stage, 'unstarted')
    requests.at(-1)!.result.resolve({ ok: true, value: browserState([browserCard()]) })
    // A failed create is the form's to show, beside what was typed: no notice.
    const create = store.create({ title: 'New', repo: '/r' })
    requests.at(-1)!.result.reject(new Error('create offline'))
    await assert.rejects(create, /create offline/)
    assert.equal(store.getSnapshot().notice, 'Worktree ready; Linear denied')
    const failedStart = store.start(browserCard(), '/r')
    requests.at(-1)!.result.reject(new Error('start offline'))
    assert.equal(await failedStart, undefined)
    assert.equal(store.getSnapshot().notice, 'start offline')
    // Failure released the per-card lock.
    const edit = store.update(browserCard(), { title: 'Retry' })
    requests.at(-1)!.result.resolve({ ok: false, error: 'retry denied' })
    assert.equal(await edit, false)
  } finally { store.dispose() }
})

test('board client: dispose prevents late reads/actions from publishing or navigating', async () => {
  const { store, requests } = browserStore()
  await seedBrowser(store, requests)
  const start = store.start(browserCard(), '/r')
  const writing = requests.at(-1)!
  const reading = store.load()
  const load = requests.at(-1)!
  const before = store.getSnapshot()
  store.dispose()
  let updates = 0
  store.subscribe(() => { updates++ })
  writing.result.resolve({ ok: true, value: { workspaceId: 'late', path: '/late', branch: 'late', created: true, stage: 'started' } })
  load.result.resolve({ ok: true, value: browserState([]) })
  assert.equal(await start, undefined)
  await reading
  assert.equal(store.getSnapshot(), before)
  assert.equal(updates, 0)
  const calls = requests.length
  await store.load()
  await assert.rejects(store.create({ title: 'No', repo: '/r' }), /disposed/)
  assert.equal(requests.length, calls)
})

test('git terminals: off-screen commands are marked busy, then done until seen; the panel opens per session', async () => {
  const { GitTerminals } = await import('../src/client/git/terminal-host.ts')
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  try {
    const host = {
      view: (_session: string, key: string) => ({ id: `host-${key}`, state: { getSnapshot: () => ({ phase: 'idle', writable: false }), subscribe: () => () => {} }, refresh: async () => {} }),
      close: () => {},
      retainTabs: () => {},
      launchShells: async () => ({ shells: [] }),
      selectShell: () => {},
    }
    const states: Record<string, string> = {}
    const asked: string[][] = []
    const probe = async (_session: string, ids: string[]): Promise<Record<string, string>> => {
      asked.push(ids)
      return Object.fromEntries(ids.map((id) => [id, states[id] ?? 'idle']))
    }
    const terminals = new GitTerminals(host as never, probe)
    const notices: Array<{ sessionId: string; keys: string[] }> = []
    terminals.onDone((notice) => notices.push(notice))
    const a = terminals.open('s1')
    const b = terminals.open('s1')

    // On screen: never probed. Leaving the screen with a command running marks it busy.
    const releaseA = terminals.show(a.key)
    const releaseB = terminals.show(b.key)
    states[`host-${a.key}`] = 'busy'
    mock.timers.tick(5000)
    await flush()
    assert.equal(asked.length, 0)
    releaseA()
    releaseB()
    mock.timers.tick(800)
    await flush()
    assert.deepEqual(asked, [[`host-${a.key}`, `host-${b.key}`]])
    assert.equal(terminals.marks().get(a.key), 'busy')
    assert.equal(terminals.marks().has(b.key), false)
    assert.deepEqual(terminals.sessionMarks('s1'), { busy: 1, done: 0 })

    // Only the busy one is polled; when it stops, it is done and announced once.
    mock.timers.tick(4000)
    await flush()
    assert.deepEqual(asked.at(-1), [`host-${a.key}`])
    delete states[`host-${a.key}`]
    mock.timers.tick(4000)
    await flush()
    assert.equal(terminals.marks().get(a.key), 'done')
    assert.deepEqual(notices, [{ sessionId: 's1', keys: [a.key] }])
    const calls = asked.length
    mock.timers.tick(20000)
    await flush()
    assert.equal(asked.length, calls)

    // Seen again: the mark goes.
    const again = terminals.show(a.key)
    assert.equal(terminals.marks().size, 0)
    again()

    // The panel's open state is per session, the pane-wide flag deciding until set.
    assert.equal(terminals.drawer('s1', true), true)
    terminals.setDrawer('s1', false)
    assert.equal(terminals.drawer('s1', true), false)
    assert.equal(terminals.drawer('s2', true), true)
    terminals.reveal('s1', b.key)
    assert.equal(terminals.drawer('s1', false), true)
    assert.equal(terminals.tabs('s1').active, b.key)
    terminals.dispose()
  } finally {
    mock.timers.reset()
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('git terminals: reopening drops the terminals whose process is gone', async () => {
  const { GitTerminals } = await import('../src/client/git/terminal-host.ts')
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  try {
    const gone = new Set<string>()
    const closed: string[] = []
    const host = {
      view(_session: string, key: string) {
        let state: Record<string, unknown> = { phase: 'idle', writable: false }
        return {
          id: key,
          state: { getSnapshot: () => state, subscribe: () => () => {} },
          async refresh() { state = gone.has(key) ? { phase: 'failed', writable: false, issue: 'missingTerminal' } : { phase: 'connected', writable: true, info: { id: key, title: 't', cols: 80, rows: 24, state: 'running' } } },
        }
      },
      close: (_session: string, key: string) => { closed.push(key) },
      retainTabs: () => {},
      launchShells: async () => ({ shells: [] }),
      selectShell: () => {},
    }
    const terminals = new GitTerminals(host as never)
    const a = terminals.open('s1')
    const b = terminals.open('s1')
    gone.add(a.key)
    await terminals.prune('s1')
    assert.deepEqual(terminals.tabs('s1').list.map((entry) => entry.key), [b.key])
    assert.deepEqual(closed, [a.key])
    gone.add(b.key)
    await terminals.prune('s1')
    assert.equal(terminals.tabs('s1').list.length, 0)
    // Several dead at once go in one update, and the live one stays selected.
    const c = terminals.open('s1')
    const d = terminals.open('s1')
    const e = terminals.open('s1')
    terminals.select('s1', e.key)
    gone.add(c.key).add(d.key)
    let updates = 0
    const off = terminals.subscribe(() => { updates++ })
    await terminals.prune('s1')
    off()
    assert.equal(updates, 1)
    assert.deepEqual(terminals.tabs('s1'), { list: [e], active: e.key })
    assert.deepEqual(closed.slice(-2), [c.key, d.key])
    terminals.dispose()
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('git terminals: terminals opened on another device are taken in, once, from every session of the worktree', async () => {
  const { GitTerminals } = await import('../src/client/git/terminal-host.ts')
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  try {
    // The host's terminals per session; a view of this window hides its own from `recover`.
    const hosted: Record<string, Array<{ id: string; state: 'running' | 'exited' | 'failed' }>> = {
      s1: [{ id: 'phone-1', state: 'running' }, { id: 'phone-dead', state: 'exited' }],
      s2: [{ id: 'phone-2', state: 'running' }],
      other: [{ id: 'elsewhere', state: 'running' }],
    }
    const viewed = new Set<string>()
    const views: Array<{ key: string; terminalId: string | undefined }> = []
    const asked: string[] = []
    const host = {
      view(_session: string, key: string, _content: string, terminalId?: string) {
        const id = terminalId ?? `local-${key}`
        viewed.add(id)
        views.push({ key, terminalId })
        return { id, state: { getSnapshot: () => ({ phase: 'idle', writable: false }), subscribe: () => () => {} }, refresh: async () => {} }
      },
      async recover(sessionId: string) {
        asked.push(sessionId)
        return (hosted[sessionId] ?? []).filter((info) => !viewed.has(info.id))
      },
      close: () => {},
      retainTabs: () => {},
      launchShells: async () => ({ shells: [] }),
      selectShell: () => {},
    }
    const cwd: Record<string, string> = { s1: '/repo', s2: '/repo/', other: '/elsewhere' }
    const terminals = new GitTerminals(host as never, undefined, (sessionId) => cwd[sessionId], () => Object.keys(cwd))
    const own = terminals.open('s1')
    // Two calls at once share one lookup per session of the worktree.
    await Promise.all([terminals.adopt('s1'), terminals.adopt('s2')])
    assert.deepEqual(asked.sort(), ['s1', 's2'])
    const list = terminals.tabs('s1').list
    assert.deepEqual(list.map((entry) => [entry.sessionId, entry.terminalId]), [['s1', undefined], ['s1', 'phone-1'], ['s2', 'phone-2']])
    assert.equal(terminals.tabs('s1').active, own.key)
    // Bound to the host terminal, not a new one.
    terminals.view(list[1]!)
    assert.equal(views.find((view) => view.key === list[1]!.key)?.terminalId, 'phone-1')
    // Nothing new: nothing changes.
    let updates = 0
    const off = terminals.subscribe(() => { updates++ })
    await terminals.adopt('s1')
    off()
    assert.equal(updates, 0)
    assert.equal(terminals.tabs('s2').list.length, 3)
    terminals.dispose()
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('git terminals: a tab splits into panes, which close, move and reload with it', async () => {
  const { GitTerminals, groupsOf, MAX_PANES } = await import('../src/client/git/terminal-host.ts')
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  try {
    const closed: string[] = []
    const host = {
      view: (_session: string, key: string) => ({ id: key, state: { getSnapshot: () => ({ phase: 'idle', writable: false }), subscribe: () => () => {} } }),
      close: (_session: string, key: string) => { closed.push(key) },
      retainTabs: () => {},
      launchShells: async () => ({ shells: [] }),
      selectShell: () => {},
    }
    const terminals = new GitTerminals(host as never)
    const a = terminals.open('s1', '/bin/zsh')
    const b = terminals.open('s1')
    const shape = (): string[][] => groupsOf(terminals.tabs('s1').list).map((group) => group.panes.map((pane) => pane.key))

    // Splitting the focused pane: beside it, in its shell, and focused.
    terminals.select('s1', a.key)
    const a2 = terminals.split('s1')!
    assert.equal(a2.parent, a.key)
    assert.equal(a2.shellPath, '/bin/zsh')
    assert.deepEqual(shape(), [[a.key, a2.key], [b.key]])
    assert.equal(terminals.tabs('s1').active, a2.key)
    const a3 = terminals.split('s1', a.key)!
    assert.deepEqual(shape(), [[a.key, a3.key, a2.key], [b.key]])
    terminals.split('s1')
    assert.equal(shape()[0]!.length, MAX_PANES)
    assert.equal(terminals.split('s1'), undefined)
    terminals.close('s1', terminals.tabs('s1').active!)

    // A tab remembers its focused pane; selecting the tab brings it back.
    terminals.select('s1', a2.key)
    terminals.select('s1', b.key)
    terminals.select('s1', a.key)
    assert.equal(terminals.tabs('s1').active, a2.key)

    // Resized panes keep their widths; a new split halves the one it splits.
    terminals.resize('s1', { [a.key]: 2 })
    const a4 = terminals.split('s1', a.key)!
    assert.equal(a4.weight, 1)
    assert.equal(terminals.tabs('s1').list.find((entry) => entry.key === a.key)!.weight, 1)
    terminals.evenOut('s1', a.key)
    assert.ok(terminals.tabs('s1').list.every((entry) => entry.weight === undefined))
    terminals.close('s1', a4.key)

    // Tabs move whole.
    terminals.move('s1', b.key, a.key)
    assert.deepEqual(shape(), [[b.key], [a.key, a3.key, a2.key]])

    // Closing the focused pane: the one to its right takes the focus; closing a tab's first
    // pane hands the tab to the next.
    terminals.select('s1', a3.key)
    terminals.close('s1', a3.key)
    assert.equal(terminals.tabs('s1').active, a2.key)
    terminals.close('s1', a.key)
    assert.deepEqual(shape(), [[b.key], [a2.key]])
    assert.equal(terminals.tabs('s1').list.find((entry) => entry.key === a2.key)!.parent, undefined)

    // A reload reads the same tabs.
    const b2 = terminals.split('s1', b.key)!
    const again = new GitTerminals(host as never)
    assert.deepEqual(groupsOf(again.tabs('s1').list).map((group) => group.panes.map((pane) => pane.key)), [[b.key, b2.key], [a2.key]])
    again.dispose()

    // Closing a tab ends all its panes; the next tab takes the focus.
    closed.length = 0
    terminals.closeTab('s1', b2.key)
    assert.deepEqual(closed, [b.key, b2.key])
    assert.deepEqual(terminals.tabs('s1'), { list: [{ sessionId: 's1', key: a2.key, contentId: a2.contentId, shellPath: '/bin/zsh' }], active: a2.key })
    terminals.dispose()
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('git terminals: the sessions of one worktree share one list, each process kept by the session that started it', async () => {
  const { GitTerminals } = await import('../src/client/git/terminal-host.ts')
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  try {
    // A list from before sharing: per session, its entries not naming their session.
    store.set('dsh-agent-hub.git.terminals.v1.old', JSON.stringify({ list: [{ key: 'k-old', contentId: 'c-old' }], active: 'k-old' }))
    const viewed: string[] = []
    const closed: string[] = []
    const held: string[][] = []
    const host = {
      view: (session: string, key: string) => {
        viewed.push(`${session}/${key}`)
        return { id: `host-${key}`, state: { getSnapshot: () => ({ phase: 'idle', writable: false }), subscribe: () => () => {} }, refresh: async () => {} }
      },
      close: (session: string, key: string) => { closed.push(`${session}/${key}`) },
      retainTabs: (tabs: Array<{ sessionId: string; tabId: string }>) => { held.push(tabs.map((tab) => `${tab.sessionId}/${tab.tabId}`)) },
      launchShells: async () => ({ shells: [] }),
      selectShell: () => {},
    }
    const asked: Array<[string, string[]]> = []
    const probe = async (session: string, ids: string[]): Promise<Record<string, string>> => {
      asked.push([session, ids])
      return Object.fromEntries(ids.map((id) => [id, 'busy']))
    }
    const folders: Record<string, string> = { a: '/repo/wt', b: '/repo/wt/', c: '/repo/other' }
    const terminals = new GitTerminals(host as never, probe, (session) => folders[session])
    // The legacy list is held while its folder is unknown, then folded into its worktree's.
    assert.deepEqual(held.at(-1), ['old/k-old'])
    folders.old = '/repo/wt'
    const x = terminals.open('a')
    const y = terminals.open('b')
    assert.deepEqual(terminals.tabs('b').list.map((entry) => entry.key), ['k-old', x.key, y.key])
    assert.equal(terminals.tabs('a'), terminals.tabs('b'))
    assert.equal(terminals.tabs('a').active, y.key)
    assert.equal(terminals.tabs('c').list.length, 0)
    assert.equal(store.has('dsh-agent-hub.git.terminals.v1.old'), false)
    assert.deepEqual(held.at(-1), ['old/k-old', `a/${x.key}`, `b/${y.key}`])

    // Driven from either session, always through the one that started it.
    terminals.view(terminals.tabs('b').list[1]!)
    assert.equal(viewed.at(-1), `a/${x.key}`)
    terminals.select('a', 'k-old')
    assert.equal(terminals.tabs('b').active, 'k-old')
    terminals.close('b', x.key)
    assert.deepEqual(closed, [`a/${x.key}`])

    // Probed per owning session; every session of the worktree is marked.
    terminals.show(y.key)()
    mock.timers.tick(2500)
    await flush()
    assert.deepEqual(asked.map(([session]) => session).sort(), ['b', 'old'])
    assert.deepEqual(terminals.sessionMarks('a'), { busy: 2, done: 0 })
    assert.deepEqual(terminals.sessionMarks('c'), { busy: 0, done: 0 })
    // A sidebar workspace: its sessions and its folder, each worktree counted once.
    assert.deepEqual(terminals.marksIn(['a', 'b'], ['/repo/wt']), { busy: 2, done: 0 })
    assert.deepEqual(terminals.marksIn([], ['/repo/wt/']), { busy: 2, done: 0 })
    assert.deepEqual(terminals.marksIn(['c'], ['/repo/other', undefined]), { busy: 0, done: 0 })

    // Reloaded: the shared list comes back as it was.
    terminals.dispose()
    const again = new GitTerminals(host as never, undefined, (session) => folders[session])
    assert.deepEqual(again.tabs('a').list.map((entry) => [entry.sessionId, entry.key]), [['old', 'k-old'], ['b', y.key]])
    again.dispose()
  } finally {
    mock.timers.reset()
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('board client: Linear cards\' pull requests are read in batches per account after the board, and again once a card changes', async () => {
  const requests: BoardRequest[] = []
  let updatedAt = 1
  const call: BoardCall = async (payload) => {
    requests.push(payload)
    if (payload.op === 'pulls') {
      return { ok: true, value: Object.fromEntries(payload.issues.filter((issue) => issue.id !== 'ENG-3').map((issue) => [issue.id, [{ url: `u/${issue.id}`, label: `a/b#${issue.id.slice(4)}` }]])) }
    }
    const linear = (id: string, connector: string): Card => ({ key: `linear:${connector}:${id}`, source: 'linear', id, title: id, stage: 'started', repos: [], connector, updatedAt })
    const state: BoardState = {
      cards: [linear('ENG-1', 'a'), linear('ENG-2', 'b'), linear('ENG-3', 'a'),
        { key: 'local:x', source: 'local', id: 'x', title: 'x', stage: 'started', repos: ['/r'], updatedAt: 1 }],
      linear: { accounts: 2, errors: [] },
      accounts: { linear: [], slack: [] },
      bots: [],
    }
    return { ok: true, value: state }
  }
  const store = new BoardStore(call)
  await store.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const pulls = requests.filter((request) => request.op === 'pulls')
  assert.deepEqual(pulls.map((request) => [request.connector, request.issues.map((issue) => issue.id)]), [['a', ['ENG-1', 'ENG-3']], ['b', ['ENG-2']]])
  assert.equal(store.getSnapshot().pulls.get('linear:a:ENG-1')?.[0]?.label, 'a/b#1')
  assert.equal(store.getSnapshot().pulls.has('linear:a:ENG-3'), false)
  // Unchanged cards are not asked again; one that could not be read is.
  requests.length = 0
  await store.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(requests.filter((request) => request.op === 'pulls').map((request) => request.issues.map((issue) => issue.id)), [['ENG-3']])
  requests.length = 0
  updatedAt = 2
  await store.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(requests.filter((request) => request.op === 'pulls').flatMap((request) => request.issues).length, 3)
  store.dispose()
})

test('board service: detail and pulls go to the card\'s own account', async () => {
  const seen: string[] = []
  const tickets = {
    async detail(id: string) { seen.push(`detail ${id}`); return { identifier: id, labels: [], pullRequests: [], activity: [] } },
    async pullRequests(id: string, version?: number) {
      seen.push(`pulls ${id} ${version}`)
      if (id === 'ENG-2') throw new Error('gone')
      return [{ url: 'u', label: 'a/b#1' }]
    },
  } as unknown as LinearTickets
  const service = new BoardService({
    repos: async () => [], linear: () => [{ id: 'lin', repos: [], tickets }], tasks: new LocalTasks(join(tmpdir(), 'none.json')),
    worktrees: async () => [], openWorktree: async () => { throw new Error('no') }, addWorktree: async () => { throw new Error('no') },
  } as BoardHost)
  const detail = await service.handle({ op: 'detail', connector: 'lin', identifier: 'ENG-1' })
  assert.equal(detail.ok, true)
  const pulls = await service.handle({ op: 'pulls', connector: 'lin', issues: [{ id: 'ENG-1', version: 5 }, { id: 'ENG-2' }, { bogus: 1 }] })
  assert.deepEqual(pulls, { ok: true, value: { 'ENG-1': [{ url: 'u', label: 'a/b#1' }] } })
  assert.deepEqual(seen.sort(), ['detail ENG-1', 'pulls ENG-1 5', 'pulls ENG-2 undefined'])
  assert.equal((await service.handle({ op: 'detail', connector: 'nope', identifier: 'ENG-1' })).ok, false)
})
