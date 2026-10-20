import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardService, type BoardHost } from '../src/board/index.ts'
import { draftOf, ticketPrompt } from '../src/board/prompt.ts'
import { LocalTasks } from '../src/board/store.ts'
import { accountFor, type Named } from '../src/board/types.ts'
import { LinearTickets, namedIn, projectsIn, teamsIn } from '../src/connectors/linear.ts'
import type { McpSession } from '../src/connectors/mcp.ts'
import { channelsIn, issueNotice, type SlackNotices } from '../src/connectors/slack.ts'
import type { Issue, IssueState } from '../src/connectors/types.ts'

const STATES: IssueState[] = [{ id: 'todo', type: 'unstarted', name: 'Todo' }, { id: 'back', type: 'backlog', name: 'Backlog' }]

function service(options: { tickets?: Partial<LinearTickets>; post?: (channel: string, message: string) => Promise<void>; botText?: BoardHost['botText'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-tickets-'))
  const tasks = new LocalTasks(join(dir, 'board.json'))
  const posts: Array<[string, string]> = []
  const notices = {
    async post(channel: string, message: string) { posts.push([channel, message]); await options.post?.(channel, message) },
    async channels(query: string): Promise<Named[]> { return [{ id: 'C1', name: query }] },
  } as unknown as SlackNotices
  const host: BoardHost = {
    repos: async () => [],
    linear: () => (options.tickets === undefined ? [] : [{ id: 'lin', repos: ['/r/app'], tickets: options.tickets as LinearTickets }]),
    slack: () => [{ id: 'slack', repos: [], notices }],
    bots: () => [{ id: 'writer', description: ' Writes tickets ' }],
    ...(options.botText === undefined ? {} : { botText: options.botText }),
    tasks,
    worktrees: async () => [],
    openWorktree: async () => { throw new Error('no') },
    addWorktree: async () => { throw new Error('no') },
  }
  return { board: new BoardService(host), tasks, posts, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('tickets: a local task keeps its priority; the board lists accounts, their repositories and the bots', async () => {
  const { board, tasks, done } = service({ tickets: {} })
  try {
    const reply = await board.handle({ op: 'create', repo: '/r/app', title: ' Fix it ', note: 'why', stage: 'backlog', priority: 2 })
    assert.equal(reply.ok, true)
    const [task] = await tasks.list()
    assert.equal(reply.ok && (reply.value as { key: string }).key, `local:${task!.id}`)
    assert.deepEqual([task!.title, task!.stage, task!.priority, task!.note], ['Fix it', 'backlog', 2, 'why'])
    // An out-of-range priority is dropped; 0 clears it on update.
    await board.handle({ op: 'update', id: task!.id, priority: 9 })
    assert.equal((await tasks.list())[0]!.priority, 2)
    await board.handle({ op: 'update', id: task!.id, priority: 0 })
    assert.equal((await tasks.list())[0]!.priority, undefined)
    const state = await board.handle({ op: 'state' })
    assert.ok(state.ok)
    const value = state.value as { accounts: unknown; bots: unknown }
    assert.deepEqual(value.accounts, { linear: [{ id: 'lin', repos: ['/r/app'] }], slack: [{ id: 'slack', repos: [] }] })
    assert.deepEqual(value.bots, [{ id: 'writer', description: 'Writes tickets' }])
  } finally { done() }
})

test('tickets: a Linear ticket is made in one save, then announced the way Linear\'s Slack app shows it', async () => {
  const saved: unknown[] = []
  const tickets: Partial<LinearTickets> = {
    async create(input) {
      saved.push(input)
      return { identifier: 'ENG-9', title: input.title, url: 'https://linear.app/x/issue/ENG-9', state: 'Todo', assignee: 'Vi', priority: 2 } satisfies Issue
    },
    async teams() { return [{ id: 't1', key: 'ENG', name: 'Engineering' }] },
    async labels() { return [{ id: 'l1', name: 'Bug' }] },
    async projects() { return [{ id: 'p1', name: 'Charts' }] },
  }
  const { board, posts, done } = service({ tickets })
  try {
    const reply = await board.handle({
      op: 'create', repo: '/r/app', title: 'Crash on save', note: 'Steps:\n1. save', priority: 2, stage: 'started',
      linear: { connector: 'lin', team: 't1', stateId: 'todo', assignee: 'me', labels: ['l1', 7, ''], project: 'p1' },
      slack: { connector: 'slack', channel: 'C42' },
    })
    assert.deepEqual(reply, { ok: true, value: { key: 'linear:lin:ENG-9', url: 'https://linear.app/x/issue/ENG-9' } })
    assert.deepEqual(saved, [{ team: 't1', title: 'Crash on save', description: 'Steps:\n1. save', priority: 2, state: 'todo', assignee: 'me', labels: ['l1'], project: 'p1' }])
    assert.equal(posts.length, 1)
    assert.equal(posts[0]![0], 'C42')
    assert.equal(posts[0]![1], [
      '**[ENG-9 Crash on save](https://linear.app/x/issue/ENG-9)**',
      'Steps:\n1. save',
      '**State**  Todo',
      '**Priority**  High',
      '**Assignee**  Vi',
      '**Labels**  Bug',
      '**Project**  Charts',
      'Engineering',
    ].join('\n'))
  } finally { done() }
})

test('tickets: the issue stands when Slack refuses; a Linear draft needs its account and team', async () => {
  const tickets: Partial<LinearTickets> = {
    async create(input) { return { identifier: 'ENG-1', title: input.title } },
    async teams() { throw new Error('offline') },
  }
  const { board, done } = service({ tickets, post: async () => { throw new Error('not_in_channel') } })
  try {
    const reply = await board.handle({ op: 'create', repo: '/r/app', title: 'T', linear: { connector: 'lin', team: 't1' }, slack: { connector: 'slack', channel: 'C1' } })
    assert.deepEqual(reply, { ok: true, value: { key: 'linear:lin:ENG-1', warning: 'Slack: not_in_channel' } })
    const gone = await board.handle({ op: 'create', repo: '/r/app', title: 'T', linear: { connector: 'lin', team: 't1' }, slack: { connector: 'other', channel: 'C1' } })
    assert.equal(gone.ok && (gone.value as { warning?: string }).warning, 'Slack: that Slack workspace is not connected')
    assert.deepEqual(await board.handle({ op: 'create', repo: '/r/app', title: 'T', linear: { connector: 'lin' } }), { ok: false, error: 'a Linear ticket needs an account and a team' })
    assert.equal((await board.handle({ op: 'create', repo: '/r/app', title: 'T', linear: { connector: 'nope', team: 't' } })).ok, false)
  } finally { done() }
})

test('tickets: options are the chosen team\'s, the first one without a choice; extras fail softly', async () => {
  const tickets: Partial<LinearTickets> = {
    async teams() { return [{ id: 't1', key: 'ENG', name: 'Engineering' }, { id: 't2', key: 'OPS', name: 'Ops' }] },
    async teamStates(team: string) { return team === 't2' ? STATES : [] },
    async labels() { throw new Error('no labels') },
    async projects() { return [{ id: 'p', name: 'P' }] },
    async users() { return [{ id: 'u', name: 'Vi' }] },
  }
  const { board, done } = service({ tickets })
  try {
    const first = await board.handle({ op: 'options', connector: 'lin' })
    assert.equal(first.ok && (first.value as { team: string }).team, 't1')
    const ops = await board.handle({ op: 'options', connector: 'lin', team: 'OPS' })
    assert.ok(ops.ok)
    const value = ops.value as { team: string; states: IssueState[]; labels: Named[]; projects: Named[] }
    assert.equal(value.team, 't2')
    // Column order: the backlog before todo.
    assert.deepEqual(value.states.map((state) => state.id), ['back', 'todo'])
    assert.deepEqual(value.labels, [])
    assert.deepEqual(value.projects, [{ id: 'p', name: 'P' }])
    const channels = await board.handle({ op: 'channels', connector: 'slack', query: 'eng' })
    assert.deepEqual(channels, { ok: true, value: [{ id: 'C1', name: 'eng' }] })
  } finally { done() }
})

test('tickets: a bot rewrites the draft through its persona; its answer reads back as title and description', async () => {
  const briefs: Array<{ system: string; user: string }> = []
  const { board, done } = service({
    botText: async (bot, brief) => {
      assert.equal(bot, 'writer')
      briefs.push(brief('I write tickets.'))
      return 'Title: Save crashes on empty file\n\n## Steps\n1. save'
    },
  })
  try {
    const reply = await board.handle({ op: 'compose', bot: 'writer', repo: 'C:\\pro\\app', title: '', note: '空文件保存会崩' })
    assert.deepEqual(reply, { ok: true, value: { title: 'Save crashes on empty file', note: '## Steps\n1. save' } })
    assert.match(briefs[0]!.system, /^I write tickets\./)
    assert.match(briefs[0]!.user, /Repository: app/)
    assert.match(briefs[0]!.user, /\(none: write one from the description\)/)
    assert.deepEqual(await board.handle({ op: 'compose', bot: 'writer', title: ' ', note: '' }), { ok: false, error: 'Write the ticket first' })
  } finally { done() }
  const bare = service()
  try {
    assert.deepEqual(await bare.board.handle({ op: 'compose', bot: 'writer', title: 'x', note: '' }), { ok: false, error: 'Bots are not available here' })
  } finally { bare.done() }
})

test('tickets: answers without the title label, fenced or bolded, still read', () => {
  const before = { title: 'Mine', note: 'n' }
  assert.deepEqual(draftOf('just a description', before), { title: 'Mine', note: 'just a description' })
  assert.deepEqual(draftOf('```\n**Title:** "Quoted"\nBody\n```', before), { title: 'Quoted', note: 'Body' })
  assert.deepEqual(draftOf('标题无\nTitle：中文冒号', before), { title: 'Mine', note: '标题无\nTitle：中文冒号' })
  assert.deepEqual(draftOf('title: \nOnly body', before), { title: 'Mine', note: 'Only body' })
  assert.match(ticketPrompt({ persona: 'P', title: 'T', note: '' }).user, /Description:\n\(none\)/)
})

test('tickets: Linear lists read leniently; Slack channels read off its text answer', () => {
  assert.deepEqual(teamsIn({ teams: [{ id: '1', key: 'ENG', displayName: 'Engineering' }, { id: '2' }] }), [{ id: '1', key: 'ENG', name: 'Engineering' }])
  assert.deepEqual(namedIn({ labels: [
    { id: 'a', name: 'Bug' }, { id: 'b', name: 'Old', archivedAt: '2024-01-01' }, { id: 'c', name: 'Group', isGroup: true }, { id: 'd', name: 'Gone', retiredAt: '2025' },
  ] }).map((item) => item.id), ['a'])
  assert.deepEqual(namedIn({ users: [{ id: 'u1', name: 'vi@x.ai', displayName: 'vi' }, { id: 'u2', name: 'Max M', isActive: false }, { id: 'u3', name: 'Ana B' }] }),
    [{ id: 'u1', name: 'vi' }, { id: 'u3', name: 'Ana B' }])
  assert.deepEqual(namedIn({ projects: [{ id: 'p1', name: 'Live', status: { type: 'started' } }, { id: 'p2', name: 'Done', status: { type: 'completed' } }] }).map((item) => item.id), ['p1'])
  // Projects keep what the board shows; a colour only as hex, progress as 0 to 1, a status type from its name when missing.
  assert.deepEqual(projectsIn({ projects: [
    { id: 'p1', name: 'Auth', color: '#5e6ad2', url: 'https://linear.app/w/project/auth', status: { id: 's', name: 'In Progress' }, progress: 40, lead: { id: 'u', name: 'Ana B' }, targetDate: '2026-11-30', summary: 'One sign-in' },
    { id: 'p2', name: 'Billing', color: 'red;background:url(x)', status: { name: 'Paused', type: 'paused' }, progress: 0.25 },
    { id: 'p3', name: 'Old', archivedAt: '2025-01-01' },
    { id: 'p4' },
  ] }), [
    { name: 'Auth', url: 'https://linear.app/w/project/auth', color: '#5e6ad2', status: 'In Progress', statusType: 'started', progress: 0.4, lead: 'Ana B', targetDate: '2026-11-30', summary: 'One sign-in' },
    { name: 'Billing', status: 'Paused', statusType: 'paused', progress: 0.25 },
  ])
  const text = '## Channels (3 results)\n1. #team-eng (C084R1V66JH) - public_channel - Not Archived\n2. #old-eng (C0B5HBPEKT8) - public_channel - Archived\n3. #priv (G0ABCDEF12) - private_channel - Not Archived\n'
  assert.deepEqual(channelsIn({ results: text }), [{ id: 'C084R1V66JH', name: 'team-eng' }, { id: 'G0ABCDEF12', name: 'priv' }])
  assert.deepEqual(channelsIn(42), [])
  // Long descriptions are cut to fit one Slack text element; unset fields are left out.
  const long = issueNotice({ identifier: 'ENG-1', title: 'T', description: 'x'.repeat(4000) })
  assert.ok(long.length < 3100)
  assert.equal(issueNotice({ identifier: 'ENG-1', title: 'T', labels: [] }), '**ENG-1 T**')
})

test('tickets: a repository is served by the account linked to it, else by one linked to none', () => {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  const all = { id: 'all', repos: [] }
  const app = { id: 'app', repos: ['/R/App'] }
  assert.equal(accountFor([all, app], '/r/app', same)?.id, 'app')
  assert.equal(accountFor([all, app], '/r/web', same)?.id, 'all')
  assert.equal(accountFor([app], '/r/web', same), undefined)
})

test('linear: a new issue is saved with the arguments the server takes, then read back', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const session = {
    async tools() {
      return [
        { name: 'save_issue', inputSchema: { properties: { team: {}, title: {}, description: {}, priority: {}, state: {}, assignee: {}, labels: {} } } },
        { name: 'get_issue', inputSchema: { properties: { id: {}, fields: {} } } },
      ]
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push([name, args])
      if (name === 'save_issue') return { identifier: 'ENG-3', title: args.title, url: 'u' }
      return { identifier: 'ENG-3', title: args.id, status: { name: 'Todo', type: 'unstarted' }, assignee: { name: 'Vi' } }
    },
  } as unknown as McpSession
  const tickets = new LinearTickets(() => session)
  const issue = await tickets.create({ team: 't', title: 'New', description: '', priority: 0, assignee: 'me', labels: ['l'], project: 'p' })
  // An empty description and no priority are left out; project is not in this server's schema.
  assert.deepEqual(calls[0], ['save_issue', { team: 't', title: 'New', assignee: 'me', labels: ['l'] }])
  assert.equal(calls[1]![0], 'get_issue')
  assert.deepEqual([issue.identifier, issue.url, issue.state, issue.assignee], ['ENG-3', 'u', 'Todo', 'Vi'])
})
