/**
 * The board: Linear tickets and local tasks in one set of columns, by stage.
 * A card is either a Linear issue (its state lives in Linear and moves there)
 * or a local task (kept by this plugin, for work no tracker knows about).
 * Both link to a worktree the same way: by branch name, worked out in the
 * browser from the registered workspaces, so a new worktree shows on its card
 * as soon as it is registered. Shared by the host and the browser.
 */

import { issueInBranch, type IssueState } from '../connectors/types.ts'
import type { RepoGroup } from '../repos/types.ts'

export const BOARD_METHOD = 'agent-hub/board'

/** The columns: Linear's workflow state types, which every team shares. */
export type Stage = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
export const STAGES: readonly Stage[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled']

export const isStage = (value: unknown): value is Stage => typeof value === 'string' && (STAGES as readonly string[]).includes(value)

/** A Linear state type in a column; triage waits in the backlog, a duplicate is cancelled. */
export function stageOf(stateType: string | undefined): Stage {
  switch (stateType) {
    case 'unstarted': case 'started': case 'completed': case 'canceled': return stateType
    case 'cancelled': case 'duplicate': return 'canceled'
    default: return 'backlog'
  }
}

/** States that read as review rather than work; a card dropped on "in progress" avoids them. */
const REVIEWISH = /review|qa|test|verif|approv|merge|deploy|审|测/i

/**
 * The state a card dropped on a column moves to: of the team's states of that column's type,
 * the one that reads as plain work (In Progress over In Review), in Linear's listed order.
 */
export function pickState(stage: Stage, states: readonly IssueState[]): IssueState | undefined {
  const types = stage === 'backlog' ? ['backlog', 'triage'] : stage === 'canceled' ? ['canceled', 'cancelled'] : [stage]
  for (const type of types) {
    const fits = states.filter((state) => state.type === type)
    const plain = fits.find((state) => !REVIEWISH.test(state.name))
    if (plain !== undefined || fits[0] !== undefined) return plain ?? fits[0]
  }
  return undefined
}

/** A team's states in column order, for the detail's state picker. */
export function orderStates(states: readonly IssueState[]): IssueState[] {
  return [...states]
    .filter((state) => state.type !== 'duplicate')
    .sort((a, b) => STAGES.indexOf(stageOf(a.type)) - STAGES.indexOf(stageOf(b.type)) || Number(REVIEWISH.test(a.name)) - Number(REVIEWISH.test(b.name)))
}

/** Linear's priorities, shared by local tasks: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const PRIORITIES = [0, 1, 2, 3, 4] as const
export const isPriority = (value: unknown): value is number => typeof value === 'number' && (PRIORITIES as readonly number[]).includes(value)

/** A task kept by this plugin. */
export interface LocalTask {
  id: string
  title: string
  note?: string
  /** The repository (main working tree path) it belongs to. */
  repo: string
  stage: Stage
  /** Linear's scale; absent: none. */
  priority?: number
  /** The branch its worktree was started on. */
  branch?: string
  createdAt: number
  updatedAt: number
}

export interface Card {
  /** Unique on the board: `linear:<connector>:<identifier>` or `local:<id>`. */
  key: string
  source: 'linear' | 'local'
  /** Linear identifier (ENG-123) or the local task id. */
  id: string
  title: string
  stage: Stage
  /** Linear's own state name (In Review), when it says more than the column. */
  state?: string
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority?: number
  assignee?: string
  project?: string
  url?: string
  /** Linear's suggested branch, or the branch a local task was started on. */
  branch?: string
  note?: string
  /** Local: the task's repository. Linear: the repositories its account serves (empty: all). */
  repos: string[]
  /** Linear: the connector it came from; its team's states are what it can move to. */
  connector?: string
  team?: string
  /** A registered worktree on this card's branch: set in the browser by {@link linkTrees}. */
  workspace?: Workspace
  updatedAt: number
}

export interface Workspace { id: string; branch: string; repo: string }

export interface BoardState {
  cards: Card[]
  /** Linear accounts connected; errors are per account, the rest of the board still shows. */
  linear: { accounts: number; errors: string[] }
  /** Connected accounts and the repositories each serves (none: every one): where a new ticket can go, who announces it. */
  accounts: { linear: Account[]; slack: Account[] }
  /** The bots a new ticket's draft can be processed by. */
  bots: Array<{ id: string; description?: string }>
  /** The connected workspaces' projects: the project filter's choices, a card's colour, a ticket's project in its detail. */
  projects?: ProjectInfo[]
}

/**
 * A Linear project, by the name a card carries. What Linear does not say is left out. `statusType`:
 * backlog, planned, started, paused, completed or canceled; `progress`: 0 to 1.
 */
export interface ProjectInfo {
  name: string
  url?: string
  color?: string
  status?: string
  statusType?: string
  progress?: number
  lead?: string
  targetDate?: string
  summary?: string
}

export interface Account { id: string; repos: string[] }

/**
 * The account serving a repository: the one linked to it, else one linked to none. Shared by the
 * host (starting work, creating a ticket) and the browser (offering Linear and Slack for a repository).
 */
export function accountFor<T extends { repos: readonly string[] }>(accounts: readonly T[], repo: string, same: (a: string, b: string) => boolean): T | undefined {
  return accounts.find((item) => item.repos.some((path) => same(path, repo))) ?? accounts.find((item) => item.repos.length === 0)
}

/** A new ticket in Linear: its team and, optionally, what Linear would otherwise default. `assignee`: a user id or "me". */
export interface LinearDraft {
  connector: string
  team: string
  stateId?: string
  assignee?: string
  labels?: string[]
  project?: string
}

/** Where a new Linear ticket is announced: a Slack channel by id. */
export interface SlackDraft { connector: string; channel: string }

export interface NewTicket {
  repo: string
  title: string
  note?: string
  stage?: Stage
  priority?: number
  /** Absent: a local task. */
  linear?: LinearDraft
  slack?: SlackDraft
}

/** What a created ticket is on the board, and what went wrong after it was made (the announcement). */
export interface Created { key: string; url?: string; warning?: string }

export interface Named { id: string; name: string }
export interface Team extends Named { key: string }

/** What a new ticket in one team can be set to: `team` is the one these lists are for. */
export interface TicketOptions {
  teams: Team[]
  team: string
  states: IssueState[]
  labels: Named[]
  projects: Named[]
  users: Named[]
}

/**
 * How a repository's tickets were last filed (`board.tickets` in the profile, so it syncs): where
 * to, which team and project, and the Slack channel announcing them, by id with its name to show.
 * `notify` false keeps the channel without posting.
 */
export interface TicketDefaults {
  repo: string
  linear?: boolean
  team?: string
  project?: string
  channel?: string
  channelName?: string
  notify?: boolean
}

export interface BoardSettings {
  /** The bot a new ticket's draft is processed by unless another is picked; picking one there sets it. */
  ticketBot?: string
  tickets: readonly TicketDefaults[]
}

/** A draft as a bot rewrites it. */
export interface Draft { title: string; note: string }

export type BoardRequest =
  /** `project`: the Linear project the board shows, by name; its every issue comes along. */
  | { op: 'state'; mine?: boolean; fresh?: boolean; project?: string }
  | ({ op: 'create' } & NewTicket)
  | { op: 'update'; id: string; title?: string; note?: string; stage?: Stage; repo?: string; priority?: number }
  | { op: 'delete'; id: string }
  /** Move a Linear card: to a state, or to the plain-work state of a column. */
  | { op: 'move'; connector: string; identifier: string; team?: string; stage?: Stage; stateId?: string }
  | { op: 'states'; connector: string; team: string }
  /** A Linear account's teams, and what a new ticket in one of them (the first, without `team`) can be set to. */
  | { op: 'options'; connector: string; team?: string }
  /** Slack channels whose name matches `query`. */
  | { op: 'channels'; connector: string; query: string }
  /** A new ticket's title and description as a bot writes them. */
  | { op: 'compose'; bot: string; repo?: string; title: string; note: string }
  /** A Linear card's description, pull requests and activity. */
  | { op: 'detail'; connector: string; identifier: string; fresh?: boolean }
  /** The pull requests of some Linear cards of one account, by identifier; `version`: the card's `updatedAt`. */
  | { op: 'pulls'; connector: string; issues: Array<{ id: string; version?: number }> }
  /**
   * Start work on a card in `repo`: its worktree (the one already on its branch, else a new one
   * on Linear's suggested branch from `base`), then the ticket moves to in progress and, when no
   * one has it, is assigned to me. Idempotent: the same card and repository started twice at
   * once share one run, and a later start opens the worktree made by the first.
   */
  | { op: 'start'; card: StartCard; repo: string; base?: string }

/**
 * What starting needs to know of a card. Linear: `connector` absent picks the account serving the
 * repository (the Git pane's ticket picker does not know it); `branch` is used when Linear cannot
 * be reached.
 */
export interface StartCard {
  source: 'linear' | 'local'
  id: string
  title: string
  connector?: string
  branch?: string
}

export interface StartResult {
  workspaceId?: string
  path: string
  branch: string
  /** False: the worktree was already there, so there is nothing new to tell its session. */
  created: boolean
  /** The card after starting, when its tracker answered. */
  stage?: Stage
  state?: string
  assignee?: string
  /** The worktree is ready, but the ticket could not be updated. */
  warning?: string
}

/** At most this many tickets per `pulls` request. */
export const PULLS_BATCH = 30

export type BoardReply<T> = { ok: true; value: T } | { ok: false; error: string }

/** Cards in a column: urgent first, then by priority, then the most recently changed. */
export function sortCards(cards: readonly Card[]): Card[] {
  const rank = (card: Card): number => (card.priority === undefined || card.priority === 0 ? 5 : card.priority)
  return [...cards].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
}

/** A branch name for a local task: `task/<slug>`, ASCII, short. */
export function taskBranch(task: Pick<LocalTask, 'id' | 'title'>): string {
  const slug = task.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return `task/${slug === '' ? task.id.slice(0, 8) : slug}`
}

/**
 * The registered worktree each card is worked on in, by card key: a Linear card's is on a branch
 * naming its identifier (in a repository its account serves), a local task's on its own branch.
 * One pass over the worktrees, then one lookup per card. `prefer`: the repository to pick when a
 * card has worktrees in more than one.
 */
export function linkTrees(cards: readonly Card[], repos: readonly RepoGroup[], same: (a: string, b: string) => boolean, prefer = ''): Map<string, Workspace> {
  const keys = [...new Set(cards.flatMap((card) => (card.source === 'linear' ? [card.id.split('-')[0]!] : [])))]
  const byIssue = new Map<string, Workspace[]>()
  const byBranch = new Map<string, Workspace[]>()
  for (const group of repos) {
    for (const member of group.members) {
      if (member.branch === undefined) continue
      const tree = { id: member.workspaceId, branch: member.branch, repo: group.key }
      const add = (map: Map<string, Workspace[]>, key: string): void => { map.set(key, [...(map.get(key) ?? []), tree]) }
      add(byBranch, member.branch)
      const issue = keys.length === 0 ? undefined : issueInBranch(member.branch, keys)
      if (issue !== undefined) add(byIssue, issue)
    }
  }
  const out = new Map<string, Workspace>()
  for (const card of cards) {
    const found = (card.source === 'linear' ? byIssue.get(card.id.toUpperCase()) : card.branch === undefined ? undefined : byBranch.get(card.branch))
      ?.filter((tree) => card.repos.length === 0 || card.repos.some((repo) => same(repo, tree.repo)))
    const tree = found?.find((item) => prefer !== '' && same(item.repo, prefer)) ?? found?.[0]
    if (tree !== undefined) out.set(card.key, tree)
  }
  return out
}

/**
 * The repositories a card can be started in: a local task's own; else the one the board shows;
 * else those its account serves; else every registered one. One answer starts at once.
 */
export function startRepos(card: Card, shown: string, repos: readonly string[], same: (a: string, b: string) => boolean): string[] {
  const known = (repo: string): boolean => repos.some((item) => same(item, repo))
  if (card.source === 'local') return card.repos.filter(known).slice(0, 1)
  const served = card.repos.length === 0 ? [...repos] : repos.filter((repo) => card.repos.some((item) => same(item, repo)))
  if (shown !== '' && served.some((repo) => same(repo, shown))) return [served.find((repo) => same(repo, shown))!]
  return served
}

/** Whether a card belongs to a repository's view. */
export function inRepo(card: Card, repo: string, same: (a: string, b: string) => boolean): boolean {
  return card.repos.length === 0 ? card.source === 'linear' : card.repos.some((item) => same(item, repo))
}
