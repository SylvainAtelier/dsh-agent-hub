/**
 * The board's host side: gathers Linear issues (from every connected account)
 * and local tasks into cards, moves Linear issues between workflow states, and
 * starts work on a card (a worktree on its branch, the ticket moved to in
 * progress and taken by me when no one has it). Which worktree a card has is
 * worked out in the browser from the registered workspaces.
 */

import { issueBranch, issueInBranch, type Issue, type PullRequest } from '../connectors/types.ts'
import type { LinearAccount, SlackAccount } from '../connectors/index.ts'
import { issueNotice, type IssueNotice } from '../connectors/slack.ts'
import { pathKey } from '../git/service.ts'
import type { Worktree, WorktreeOpened } from '../git/types.ts'
import type { RepoGroup } from '../repos/types.ts'
import type { LocalTasks } from './store.ts'
import { draftOf, ticketPrompt } from './prompt.ts'
import {
  accountFor, isPriority, isStage, orderStates, pickState, PULLS_BATCH, stageOf, taskBranch,
  type BoardReply, type BoardRequest, type BoardState, type Card, type Created, type Draft, type LinearDraft, type LocalTask, type Named, type NewTicket, type ProjectInfo,
  type Stage, type StartCard, type StartResult, type TicketOptions,
} from './types.ts'

export interface BoardHost {
  repos(): Promise<RepoGroup[]>
  linear(): LinearAccount[]
  /** Slack workspaces a new Linear ticket can be announced in. */
  slack?(): SlackAccount[]
  /** The bots a new ticket's draft can be processed by. */
  bots?(): ReadonlyArray<{ id: string; description?: string }>
  /** One answer from a bot outside any session; `brief` gets its persona. */
  botText?(bot: string, brief: (persona: string) => { system: string; user: string }): Promise<string>
  tasks: LocalTasks
  /** The working trees of the repository `cwd` is in. */
  worktrees(cwd: string): Promise<Worktree[]>
  /** An existing working tree as a workspace (registered now if it was not). */
  openWorktree(cwd: string, path: string): Promise<WorktreeOpened>
  /** A new worktree on `branch` (from `base`, else the branch as it is) for the repository `cwd` is in, registered as a workspace. */
  addWorktree(cwd: string, branch: string, base?: string): Promise<WorktreeOpened>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const text = (value: unknown, max = 20_000): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined)
/** Tickets read at once for their pull requests. */
const PULLS_PARALLEL = 6
/** Linear's priorities as its Slack app names them. */
const PRIORITY_NAMES = ['', 'Urgent', 'High', 'Medium', 'Low']
const samePathKey = (a: string, b: string): boolean => pathKey(a) === pathKey(b)
/** A short non-empty string, else undefined. */
const field = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value.slice(0, 200) : undefined)
const notStarted = (stage: Stage): boolean => stage === 'backlog' || stage === 'unstarted'

function localCard(task: LocalTask): Card {
  return {
    key: `local:${task.id}`,
    source: 'local',
    id: task.id,
    title: task.title,
    stage: task.stage,
    repos: [task.repo],
    ...(task.note === undefined ? {} : { note: task.note }),
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    updatedAt: task.updatedAt,
  }
}

function linearCard(account: LinearAccount, issue: Issue): Card {
  return {
    key: `linear:${account.id}:${issue.identifier}`,
    source: 'linear',
    id: issue.identifier,
    title: issue.title,
    stage: stageOf(issue.stateType),
    repos: [...account.repos],
    connector: account.id,
    ...(issue.state === undefined ? {} : { state: issue.state }),
    ...(issue.priority === undefined ? {} : { priority: issue.priority }),
    ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
    ...(issue.project === undefined ? {} : { project: issue.project }),
    ...(issue.url === undefined ? {} : { url: issue.url }),
    ...(issue.team === undefined ? {} : { team: issue.team }),
    branch: issue.branch ?? issueBranch(issue),
    updatedAt: Date.parse(issue.updatedAt ?? '') || 0,
  }
}

export class BoardService {
  private readonly host: BoardHost
  /** Starts in flight, by repository and card: a second click, or another window, joins the first. */
  private readonly starting = new Map<string, Promise<StartResult>>()

  constructor(host: BoardHost) {
    this.host = host
  }

  /**
   * The board's cards and projects. `project`: the one the board shows, whose every issue comes
   * along (finished ones and other people's too), not only those on the usual board.
   */
  async state(mine: boolean, fresh = false, project?: string): Promise<BoardState> {
    const accounts = this.host.linear()
    // Promise.all preserves configuration order, regardless of account latency.
    // Account identity stays in the key: matching issue numbers do not prove a shared workspace.
    const [tasks, results, projects] = await Promise.all([
      this.host.tasks.list(),
      Promise.all(accounts.map(async (account): Promise<{ cards: Card[]; error?: string }> => {
        try {
          const seen = new Set<string>()
          const cards: Card[] = []
          const [board, inProject] = await Promise.all([
            account.tickets.board(mine, fresh),
            project === undefined ? [] : account.tickets.projectBoard(project, fresh),
          ])
          for (const issue of [...board, ...inProject]) {
            if (seen.has(issue.identifier)) continue
            seen.add(issue.identifier)
            cards.push(linearCard(account, issue))
          }
          return { cards }
        } catch (error) {
          return { cards: [], error: `${account.id}: ${message(error)}` }
        }
      })),
      // Projects are extra: an account without them, or a failed read, still shows its cards.
      Promise.all(accounts.map((account) => (async () => account.tickets.workspaceProjects())().catch(() => [] as ProjectInfo[]))),
    ])
    const errors = results.flatMap((result) => (result.error === undefined ? [] : [result.error]))
    // Cards know their project by name: the first account to name one wins.
    const named = new Map<string, ProjectInfo>()
    for (const project of projects.flat()) if (!named.has(project.name)) named.set(project.name, project)
    const bound = (list: ReadonlyArray<{ id: string; repos: readonly string[] }>): Array<{ id: string; repos: string[] }> => list.map((item) => ({ id: item.id, repos: [...item.repos] }))
    return {
      cards: [...results.flatMap((result) => result.cards), ...tasks.map(localCard)],
      linear: { accounts: accounts.length, errors },
      accounts: { linear: bound(accounts), slack: bound(this.host.slack?.() ?? []) },
      bots: (this.host.bots?.() ?? []).map(({ id, description }) => ({ id, ...(description?.trim() ? { description: description.trim() } : {}) })),
      projects: [...named.values()],
    }
  }

  private account(id: string): LinearAccount {
    const account = this.host.linear().find((item) => item.id === id)
    if (account === undefined) throw new Error('that Linear account is not connected')
    return account
  }

  /** The Linear account serving a repository: the one linked to it, else one linked to none. */
  private accountFor(repo: string): LinearAccount {
    const account = accountFor(this.host.linear(), repo, samePathKey)
    if (account === undefined) throw new Error('no connected Linear account serves this repository')
    return account
  }

  /**
   * A new ticket: a local task, or a Linear issue made in one save and then, when a channel is
   * picked, announced in Slack. The issue stands even when the announcement fails: that comes
   * back as a warning.
   */
  async create(input: NewTicket): Promise<Created> {
    if (input.linear === undefined) {
      const task = await this.host.tasks.create({
        title: input.title, repo: input.repo,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
      })
      return { key: `local:${task.id}` }
    }
    const draft = input.linear
    const account = this.account(draft.connector)
    const title = input.title.trim()
    if (title === '') throw new Error('a ticket needs a title')
    const issue = await account.tickets.create({
      team: draft.team, title,
      ...(input.note === undefined ? {} : { description: input.note.trim() }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(draft.stateId === undefined ? {} : { state: draft.stateId }),
      ...(draft.assignee === undefined ? {} : { assignee: draft.assignee }),
      ...(draft.labels === undefined ? {} : { labels: draft.labels }),
      ...(draft.project === undefined ? {} : { project: draft.project }),
    })
    const created: Created = { key: `linear:${account.id}:${issue.identifier}`, ...(issue.url === undefined ? {} : { url: issue.url }) }
    const slack = input.slack
    if (slack === undefined) return created
    try {
      const workspace = this.host.slack?.().find((item) => item.id === slack.connector)
      if (workspace === undefined) throw new Error('that Slack workspace is not connected')
      await workspace.notices.post(slack.channel, issueNotice(await this.notice(account, draft, issue, input)))
      return created
    } catch (error) {
      return { ...created, warning: `Slack: ${message(error)}` }
    }
  }

  /** A created issue as its Slack announcement shows it: names for what the draft gave by id. */
  private async notice(account: LinearAccount, draft: LinearDraft, issue: Issue, input: NewTicket): Promise<IssueNotice> {
    const nameOf = (list: readonly Named[], id: string | undefined): string | undefined => list.find((item) => item.id === id)?.name
    const none: Named[] = []
    const [teams, labels, projects] = await Promise.all([
      account.tickets.teams().catch(() => none),
      draft.labels === undefined ? none : account.tickets.labels(draft.team).catch(() => none),
      issue.project !== undefined || draft.project === undefined ? none : account.tickets.projects(draft.team).catch(() => none),
    ])
    const priority = issue.priority ?? input.priority
    const project = issue.project ?? nameOf(projects, draft.project)
    const team = nameOf(teams, draft.team)
    const note = input.note?.trim()
    return {
      identifier: issue.identifier,
      title: issue.title,
      ...(issue.url === undefined ? {} : { url: issue.url }),
      ...(note === undefined || note === '' ? {} : { description: note }),
      ...(team === undefined ? {} : { team }),
      ...(issue.state === undefined ? {} : { state: issue.state }),
      ...(priority === undefined || priority === 0 ? {} : { priority: PRIORITY_NAMES[priority]! }),
      ...(issue.assignee === undefined ? {} : { assignee: issue.assignee }),
      labels: (draft.labels ?? []).map((id) => nameOf(labels, id) ?? id),
      ...(project === undefined ? {} : { project }),
    }
  }

  /** A Linear account's teams, and what a new ticket in one of them (`team`, else the first) can be set to. */
  async options(connector: string, team: string | undefined): Promise<TicketOptions> {
    const { tickets } = this.account(connector)
    const teams = await tickets.teams()
    const chosen = teams.find((item) => item.id === team || item.key === team) ?? teams[0]
    if (chosen === undefined) throw new Error('this Linear workspace has no team')
    // The states are what a ticket needs; the rest is offered when Linear answers.
    const none: Named[] = []
    const [states, labels, projects, users] = await Promise.all([
      tickets.teamStates(chosen.id).then(orderStates),
      tickets.labels(chosen.id).catch(() => none),
      tickets.projects(chosen.id).catch(() => none),
      tickets.users().catch(() => none),
    ])
    return { teams, team: chosen.id, states, labels, projects, users }
  }

  /** A new ticket's title and description as a bot writes them. */
  async compose(bot: string, draft: Draft, repo: string | undefined): Promise<Draft> {
    if (draft.title.trim() === '' && draft.note.trim() === '') throw new Error('Write the ticket first')
    if (this.host.botText === undefined) throw new Error('Bots are not available here')
    const name = repo?.split(/[\\/]/).filter(Boolean).pop()
    const answer = await this.host.botText(bot, (persona) => ticketPrompt({ persona, ...draft, ...(name === undefined ? {} : { repo: name }) }))
    return draftOf(answer, draft)
  }

  /** A `create` request's ticket, its loose fields checked. */
  private newTicket(request: Record<string, unknown>): NewTicket {
    const title = text(request.title, 300)
    const repo = text(request.repo, 4096)
    if (title === undefined || repo === undefined || repo === '') throw new Error('a task needs a title and a repository')
    const note = text(request.note)
    const ticket: NewTicket = {
      title, repo,
      ...(note === undefined ? {} : { note }),
      ...(isStage(request.stage) ? { stage: request.stage } : {}),
      ...(isPriority(request.priority) ? { priority: request.priority } : {}),
    }
    const linear = request.linear as Record<string, unknown> | undefined
    if (linear === undefined || linear === null) return ticket
    const connector = field(linear.connector)
    const team = field(linear.team)
    if (connector === undefined || team === undefined) throw new Error('a Linear ticket needs an account and a team')
    const stateId = field(linear.stateId)
    const assignee = field(linear.assignee)
    const project = field(linear.project)
    const labels = (Array.isArray(linear.labels) ? linear.labels : []).map(field).filter((id): id is string => id !== undefined).slice(0, 50)
    const slack = request.slack as Record<string, unknown> | undefined
    const notify = field(slack?.connector)
    const channel = field(slack?.channel)
    return {
      ...ticket,
      linear: {
        connector, team,
        ...(stateId === undefined ? {} : { stateId }),
        ...(assignee === undefined ? {} : { assignee }),
        ...(project === undefined ? {} : { project }),
        ...(labels.length === 0 ? {} : { labels }),
      },
      ...(notify === undefined || channel === undefined ? {} : { slack: { connector: notify, channel } }),
    }
  }

  /** Move a Linear issue to a state, or to the plain-work state of a column. Resolves the state it went to. */
  async move(connector: string, identifier: string, team: string | undefined, stage: Stage | undefined, stateId: string | undefined): Promise<{ id: string; name: string; type: string }> {
    const account = this.account(connector)
    const states = team === undefined ? [] : await account.tickets.teamStates(team)
    const target = stateId !== undefined
      ? states.find((state) => state.id === stateId) ?? { id: stateId, name: '', type: '' }
      : stage === undefined ? undefined : pickState(stage, states)
    if (target === undefined) throw new Error('no workflow state fits that column')
    await account.tickets.move(identifier, target.id)
    return target
  }

  /** Pull requests of some tickets of one account; a ticket that cannot be read is left out. */
  async pulls(connector: string, issues: ReadonlyArray<{ id: string; version?: number }>): Promise<Record<string, PullRequest[]>> {
    const tickets = this.account(connector).tickets
    const out: Record<string, PullRequest[]> = {}
    const queue = issues.slice(0, PULLS_BATCH)
    await Promise.all(Array.from({ length: Math.min(PULLS_PARALLEL, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const { id, version } = next
        try { out[id] = await tickets.pullRequests(id, version) } catch { /* Left out: asked again next time. */ }
      }
    }))
    return out
  }

  /**
   * Start work on a card in a repository (`repo`: any of its registered folders); concurrent
   * starts of the same card there, from the board or the Git pane, share one run.
   */
  async start(card: StartCard, repo: string, base?: string): Promise<StartResult> {
    const where = pathKey(repo)
    const group = (await this.host.repos()).find((item) => pathKey(item.key) === where || item.members.some((member) => pathKey(member.path) === where))
    const cwd = (group?.members.find((member) => member.main) ?? group?.members[0])?.path
    if (group === undefined || cwd === undefined) throw new Error('that repository is not a DSH workspace')
    const key = [pathKey(group.key), card.source, card.id.toUpperCase()].join('\n')
    let run = this.starting.get(key)
    if (run === undefined) {
      run = this.run(card, group, cwd, base).finally(() => { this.starting.delete(key) })
      this.starting.set(key, run)
    }
    return run
  }

  /**
   * The worktree first: the one already on the card's branch (or, for a ticket, on any branch
   * naming it), else a new one. Then the tracker: a ticket not yet started moves to in progress,
   * and one no one has is assigned to me, in one save. A tracker that refuses leaves a warning,
   * never a failure: the worktree is there either way.
   */
  private async run(card: StartCard, group: RepoGroup, cwd: string, base: string | undefined): Promise<StartResult> {
    let branch: string
    let names: (tree: Worktree) => boolean = () => false
    let task: LocalTask | undefined
    let account: LinearAccount | undefined
    let issue: Issue | undefined
    let warning: string | undefined
    if (card.source === 'local') {
      task = (await this.host.tasks.list()).find((item) => item.id === card.id)
      if (task === undefined) throw new Error('that task no longer exists')
      branch = task.branch ?? taskBranch(task)
    } else {
      const identifier = card.id.toUpperCase()
      account = card.connector === undefined || card.connector === '' ? this.accountFor(group.key) : this.account(card.connector)
      // A fresh read: Linear's own suggested branch, and who has the ticket now. Unreachable,
      // the branch the browser saw still makes the worktree.
      let unreachable = false
      issue = await account.tickets.issue(identifier, true).catch((error: unknown) => {
        unreachable = true
        warning = `Worktree is ready, but Linear could not be reached to update the ticket: ${message(error)}`
        return undefined
      })
      if (issue === undefined && !unreachable) throw new Error(`Linear does not know ${identifier}`)
      branch = issue?.branch ?? card.branch ?? issueBranch({ identifier, title: card.title })
      const team = identifier.split('-')[0]!
      names = (tree) => tree.branch !== undefined && issueInBranch(tree.branch, [team]) === identifier
    }

    const trees = (await this.host.worktrees(cwd)).filter((tree) => tree.prunable === undefined)
    const existing = trees.find((tree) => tree.branch === branch) ?? trees.find(names)
    const opened = existing === undefined ? await this.host.addWorktree(cwd, branch, base) : await this.host.openWorktree(cwd, existing.path)
    const result: StartResult = {
      ...(opened.workspaceId === undefined ? {} : { workspaceId: opened.workspaceId }),
      path: opened.path,
      branch: existing?.branch ?? branch,
      created: existing === undefined,
    }

    try {
      if (task !== undefined) {
        const updated = await this.host.tasks.update(task.id, { branch: result.branch, ...(notStarted(task.stage) ? { stage: 'started' as const } : {}) })
        result.stage = updated.stage
      } else if (account !== undefined && issue !== undefined) {
        const stage = stageOf(issue.stateType)
        const target = notStarted(stage) && issue.team !== undefined ? pickState('started', await account.tickets.teamStates(issue.team)) : undefined
        // Only a ticket Linear says no one has: one whose assignee is unknown is left alone.
        const assign = issue.assigned === false
        if (target !== undefined || assign) {
          await account.tickets.update(issue.identifier, { ...(target === undefined ? {} : { state: target.id }), ...(assign ? { assignee: 'me' } : {}) })
        }
        result.stage = target === undefined ? stage : stageOf(target.type)
        const state = target?.name ?? issue.state
        if (state !== undefined) result.state = state
        if (!assign && issue.assignee !== undefined) result.assignee = issue.assignee
      }
    } catch (error) {
      // Do not turn a successfully created worktree into an action failure, or invent a state change.
      warning = `Worktree is ready, but the ticket could not be updated: ${message(error)}`
      delete result.stage
      delete result.state
    }
    return { ...result, ...(warning === undefined ? {} : { warning }) }
  }

  async handle(payload: Record<string, unknown>): Promise<BoardReply<unknown>> {
    const request = payload as unknown as BoardRequest
    try {
      switch (request.op) {
        case 'create': return { ok: true, value: await this.create(this.newTicket(payload)) }
        case 'update': {
          const title = text(request.title, 300)
          const note = text(request.note)
          const repo = text(request.repo, 4096)
          return {
            ok: true,
            value: await this.host.tasks.update(String(request.id), {
              ...(title === undefined ? {} : { title }),
              ...(note === undefined ? {} : { note }),
              ...(repo === undefined || repo === '' ? {} : { repo }),
              ...(isStage(request.stage) ? { stage: request.stage } : {}),
              ...(isPriority(request.priority) ? { priority: request.priority } : {}),
            }),
          }
        }
        case 'options': return { ok: true, value: await this.options(String(request.connector), field(request.team)) }
        case 'channels': {
          const slack = this.host.slack?.().find((item) => item.id === request.connector)
          if (slack === undefined) throw new Error('that Slack workspace is not connected')
          return { ok: true, value: await slack.notices.channels(text(request.query, 100) ?? '') }
        }
        case 'compose': {
          const bot = field(request.bot)
          if (bot === undefined) throw new Error('pick a bot')
          return { ok: true, value: await this.compose(bot, { title: text(request.title, 300) ?? '', note: text(request.note) ?? '' }, text(request.repo, 4096)) }
        }
        case 'delete': return { ok: true, value: await this.host.tasks.remove(String(request.id)) }
        case 'move': return {
          ok: true,
          value: await this.move(String(request.connector), String(request.identifier), text(request.team, 200),
            isStage(request.stage) ? request.stage : undefined, text(request.stateId, 200)),
        }
        case 'detail': {
          const identifier = text(request.identifier, 200)
          if (identifier === undefined || identifier === '') throw new Error('which ticket?')
          return { ok: true, value: await this.account(String(request.connector)).tickets.detail(identifier, request.fresh === true) }
        }
        case 'pulls': {
          const issues = (Array.isArray(request.issues) ? request.issues : []).flatMap((item: unknown) => {
            const raw = (item ?? {}) as { id?: unknown; version?: unknown }
            const id = text(raw.id, 200)
            return id === undefined || id === '' ? [] : [{ id, ...(typeof raw.version === 'number' ? { version: raw.version } : {}) }]
          })
          return { ok: true, value: await this.pulls(String(request.connector), issues) }
        }
        case 'states': return { ok: true, value: orderStates(await this.account(String(request.connector)).tickets.teamStates(String(request.team))) }
        case 'start': {
          const card = (request.card ?? {}) as Partial<StartCard>
          const id = text(card.id, 200)
          const repo = text(request.repo, 4096)
          if ((card.source !== 'linear' && card.source !== 'local') || id === undefined || id === '' || repo === undefined || repo === '') throw new Error('nothing to start')
          const connector = text(card.connector, 200)
          const branch = text(card.branch, 400)
          const base = text(request.base, 400)
          return {
            ok: true,
            value: await this.start({
              source: card.source,
              id,
              title: text(card.title, 300) ?? '',
              ...(connector === undefined ? {} : { connector }),
              ...(branch === undefined ? {} : { branch }),
            }, repo, base === undefined || base === '' ? undefined : base),
          }
        }
        default: {
          const project = text(request.project, 300)
          return { ok: true, value: await this.state(request.mine !== false, request.fresh === true, project === '' ? undefined : project) }
        }
      }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }
}
