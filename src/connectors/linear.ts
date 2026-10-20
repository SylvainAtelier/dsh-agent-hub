/**
 * Tickets for the worktree picker, read through the Linear connector's own MCP
 * tools with the same credential the models use. Linear's MCP output is JSON
 * whose exact shape is not a contract, so issues are read leniently and tool
 * arguments are limited to what the server's schema lists.
 */

import { issueInBranch, type Activity, type Issue, type IssueDetail, type IssueState, type LinkedIssues, type PullRequest } from './types.ts'
import type { McpSession } from './mcp.ts'
import type { Named, ProjectInfo, Team } from '../board/types.ts'

const TEAMS_TTL_MS = 10 * 60_000
const ISSUE_TTL_MS = 60_000
/** An expired issue is still shown this long while it is read again in the background. */
const ISSUE_STALE_MS = 10 * 60_000
const BOARD_TTL_MS = 30_000
const STATES_TTL_MS = 10 * 60_000
const DETAIL_TTL_MS = 60_000
/** A ticket's pull requests are read again after this even when the ticket has not changed. */
const PULLS_TTL_MS = 10 * 60_000
/** Labels, projects and people change rarely: read again after this. */
const OPTIONS_TTL_MS = 10 * 60_000
/** Linear's `list_projects` answers at most this many a page. */
const PROJECTS_PAGE = 50
/** Pages read at most for one list: enough for any project, without paging through a whole workspace. */
const MAX_PAGES = 10
/** What tells a ticket's pull requests: attachments, and those its description names. */
const PULL_FIELDS = ['id', 'description', 'attachments']
const DETAIL_FIELDS = ['id', 'description', 'project', 'projectMilestone', 'labels', 'attachments', 'stateHistory', 'createdAt', 'createdBy']
/**
 * Fields the board shows; servers that ignore `fields` answer with their default set. Requested
 * fields with no value come back null, which is how an unassigned issue is told from an unknown one.
 */
const BOARD_FIELDS = ['id', 'title', 'url', 'gitBranchName', 'status', 'statusType', 'priority', 'assignee', 'assigneeId', 'project', 'teamId', 'updatedAt']
/** Workflow states that are over: hidden from "my issues". */
const CLOSED_TYPES = new Set(['completed', 'canceled', 'cancelled', 'duplicate'])
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/

type Json = Record<string, unknown>
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const record = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined)

/** One issue object, whatever names its fields go by. */
export function toIssue(value: unknown): Issue | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const identifier = text(raw.identifier) ?? (IDENTIFIER.test(String(raw.id ?? '')) ? String(raw.id) : undefined)
  const title = text(raw.title)
  if (identifier === undefined || title === undefined) return undefined
  const status = record(raw.status) ?? record(raw.state)
  const state = text(status?.name) ?? text(raw.status) ?? text(raw.state)
  const stateType = text(status?.type) ?? text(raw.statusType) ?? text(raw.stateType)
  const url = text(raw.url)
  const branch = text(raw.gitBranchName) ?? text(raw.branchName)
  const priority = typeof raw.priority === 'number' ? raw.priority : record(raw.priority)?.value
  const assignee = text(raw.assignee) ?? text(record(raw.assignee)?.name) ?? text(record(raw.assignee)?.displayName)
  const project = text(raw.project) ?? text(record(raw.project)?.name)
  const team = text(raw.teamId) ?? text(record(raw.team)?.id)
  const updatedAt = text(raw.updatedAt)
  const assigned = 'assigneeId' in raw ? raw.assigneeId !== null && raw.assigneeId !== '' : 'assignee' in raw ? raw.assignee !== null && raw.assignee !== '' : undefined
  return {
    identifier: identifier.toUpperCase(),
    title,
    ...(url === undefined ? {} : { url }),
    ...(branch === undefined ? {} : { branch }),
    ...(state === undefined ? {} : { state }),
    ...(stateType === undefined ? {} : { stateType: stateType.toLowerCase() }),
    ...(typeof priority === 'number' && Number.isInteger(priority) && priority >= 0 && priority <= 4 ? { priority } : {}),
    ...(assignee === undefined ? {} : { assignee }),
    ...(assigned === undefined ? {} : { assigned }),
    ...(project === undefined ? {} : { project }),
    ...(team === undefined ? {} : { team }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** A team's workflow states in a `list_issue_statuses` result. */
export function statesIn(value: unknown): IssueState[] {
  const list = Array.isArray(value) ? value : Object.values(record(value) ?? {}).find(Array.isArray) ?? []
  return list.flatMap((item) => {
    const raw = record(item)
    const id = text(raw?.id)
    const name = text(raw?.name)
    const type = text(raw?.type)
    return id === undefined || name === undefined || type === undefined ? [] : [{ id, name, type: type.toLowerCase() }]
  })
}

/** Days a finished issue stays on the board. */
export const FINISHED_DAYS = 14

/** Every issue in a tool result: a list, or a list under some key, or one issue. */
export function issuesIn(value: unknown): Issue[] {
  const list = Array.isArray(value)
    ? value
    : Object.values(record(value) ?? {}).find((entry): entry is unknown[] => Array.isArray(entry) && entry.some((item) => toIssue(item) !== undefined))
  if (list !== undefined) return list.map(toIssue).filter((issue): issue is Issue => issue !== undefined)
  const single = toIssue(value) ?? toIssue(record(value)?.issue)
  return single === undefined ? [] : [single]
}

/** The list in a `list_*` result: the result itself, or the first list under some key. */
const listIn = (value: unknown): unknown[] => (Array.isArray(value) ? value : Object.values(record(value) ?? {}).find(Array.isArray) ?? [])

/** Teams in a `list_teams` result. */
export function teamsIn(value: unknown): Team[] {
  return listIn(value).flatMap((item) => {
    const raw = record(item)
    const id = text(raw?.id)
    const key = text(raw?.key)
    return id === undefined || key === undefined ? [] : [{ id, key, name: text(raw?.displayName) ?? text(raw?.name) ?? key }]
  })
}

/** Team keys (ENG, OPS) in a `list_teams` result. */
export function teamKeysIn(value: unknown): string[] {
  return listIn(value).map((team) => text(record(team)?.key)).filter((key): key is string => key !== undefined)
}

/**
 * What a new ticket can be set to, in a `list_issue_labels`, `list_projects` or `list_users`
 * result: by id and the name Linear shows. Retired, archived and group labels, finished projects
 * and deactivated people are left out; a person's name is their full name, not an email.
 */
export function namedIn(value: unknown): Named[] {
  return listIn(value).flatMap((item) => {
    const raw = record(item)
    const id = text(raw?.id)
    if (id === undefined || raw?.isGroup === true || raw?.isActive === false || text(raw?.archivedAt) !== undefined || text(raw?.retiredAt) !== undefined) return []
    const status = text(record(raw?.status)?.type)
    if (status === 'completed' || status === 'canceled') return []
    const name = text(raw?.name)
    const shown = name === undefined || name.includes('@') ? text(raw?.displayName) ?? name : name
    return shown === undefined ? [] : [{ id, name: shown }]
  })
}

const COLOR = /^#[0-9a-f]{3,8}$/i

/** A project status's type by its name, for servers that give only the name (Linear's default statuses). */
function projectStatusType(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  if (/cancel/i.test(name)) return 'canceled'
  if (/complete|done|shipped/i.test(name)) return 'completed'
  if (/pause|hold/i.test(name)) return 'paused'
  if (/progress|start|active/i.test(name)) return 'started'
  if (/plan/i.test(name)) return 'planned'
  if (/backlog/i.test(name)) return 'backlog'
  return undefined
}

/**
 * Projects in a `list_projects` result, archived ones left out. A colour is kept only as a hex
 * colour (it goes into a style); progress reads as 0 to 1 whether Linear says 0.4 or 40.
 */
export function projectsIn(value: unknown): ProjectInfo[] {
  return listIn(value).flatMap((item) => {
    const raw = record(item)
    const name = text(raw?.name)
    if (raw === undefined || name === undefined || text(raw.archivedAt) !== undefined) return []
    const status = record(raw.status)
    const statusName = text(status?.name) ?? text(raw.status) ?? text(raw.state)
    const statusType = text(status?.type) ?? projectStatusType(statusName)
    const color = text(raw.color)
    const progress = typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? Math.min(Math.max(raw.progress > 1 ? raw.progress / 100 : raw.progress, 0), 1) : undefined
    const url = text(raw.url)
    const lead = nameOf(raw.lead)
    const targetDate = text(raw.targetDate)
    const summary = text(raw.summary)
    return [{
      name,
      ...(url === undefined ? {} : { url }),
      ...(color === undefined || !COLOR.test(color) ? {} : { color }),
      ...(statusName === undefined ? {} : { status: statusName }),
      ...(statusType === undefined ? {} : { statusType: statusType.toLowerCase() }),
      ...(progress === undefined ? {} : { progress }),
      ...(lead === undefined ? {} : { lead }),
      ...(targetDate === undefined ? {} : { targetDate }),
      ...(summary === undefined ? {} : { summary }),
    }]
  })
}

/** `owner/repo#12` for a GitHub, GitLab or Bitbucket pull request URL; undefined for anything else. */
export function pullRequestOf(url: string): { label: string; number: number } | undefined {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url)
    ?? /^https?:\/\/[^/]*gitlab[^/]*\/(.+?)\/-\/merge_requests\/(\d+)/i.exec(url)
    ?? /^https?:\/\/(?:www\.)?bitbucket\.org\/([^/]+\/[^/]+)\/pull-requests\/(\d+)/i.exec(url)
  return match === null ? undefined : { label: `${match[1]}#${match[2]}`, number: Number(match[2]) }
}

/** Linear's code review of a pull request: `linear.app/<workspace>/review/<slug>`. */
const LINEAR_REVIEW = /^https:\/\/linear\.app\/[^/]+\/review\//
const PR_TAG = /<pull-request\b[^>]*?\bhref="([^"]+)"[^>]*>([^<]*)<\/pull-request>/g
const MD_LINK = /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g
const BARE_PR = /https?:\/\/(?:www\.)?github\.com\/[^\s/)>"\]]+\/[^\s/)>"\]]+\/pull\/\d+/g

/**
 * The pull requests a ticket links: its attachments that are pull requests, then those its text
 * names (Linear's `<pull-request>` mentions, Markdown links, bare GitHub URLs), each once.
 */
export function pullRequestsIn(attachments: unknown, texts: readonly (string | undefined)[]): PullRequest[] {
  const out: PullRequest[] = []
  const seen = new Set<string>()
  const add = (url: string, label: string | undefined, title?: string): void => {
    const parsed = pullRequestOf(url)
    const name = parsed?.label ?? label?.trim()
    if (name === undefined || name === '') return
    const key = /#\d+$/.test(name) ? name.toLowerCase() : url
    if (seen.has(key) || seen.has(url)) return
    seen.add(key)
    seen.add(url)
    const number = parsed?.number ?? Number(/#(\d+)$/.exec(name)?.[1] ?? NaN)
    out.push({ url, label: name, ...(title === undefined ? {} : { title }), ...(Number.isFinite(number) ? { number } : {}) })
  }
  const list = Array.isArray(attachments) ? attachments : []
  for (const item of list) {
    const raw = record(item)
    const url = text(raw?.url)
    if (url !== undefined && pullRequestOf(url) !== undefined) add(url, undefined, text(raw?.title))
  }
  for (const body of texts) {
    if (body === undefined) continue
    for (const [, url, label] of body.matchAll(PR_TAG)) add(url!, label)
    for (const [, label, url] of body.matchAll(MD_LINK)) {
      if (pullRequestOf(url!) !== undefined || (LINEAR_REVIEW.test(url!) && /#\d+$/.test(label!.trim()))) add(url!, label)
    }
    for (const [url] of body.matchAll(BARE_PR)) add(url, undefined)
  }
  return out
}

const nameOf = (value: unknown): string | undefined => text(value) ?? text(record(value)?.displayName) ?? text(record(value)?.name)

/** A `get_issue` result (with {@link DETAIL_FIELDS}) and its comments as the detail shows them. */
export function detailOf(identifier: string, value: unknown, comments: unknown): IssueDetail {
  const raw = record(value) ?? {}
  const issue = record(raw.issue) ?? raw
  const description = text(issue.description)
  const project = nameOf(issue.project)
  const milestone = nameOf(issue.projectMilestone)
  const labels = (Array.isArray(issue.labels) ? issue.labels : []).map(nameOf).filter((name): name is string => name !== undefined)
  const commentList = Array.isArray(comments) ? comments : Object.values(record(comments) ?? {}).find(Array.isArray) ?? []
  const activity: Activity[] = []
  const created = text(issue.createdAt)
  if (created !== undefined) {
    const actor = nameOf(issue.createdBy)
    activity.push({ kind: 'created', at: created, ...(actor === undefined ? {} : { actor }) })
  }
  for (const item of Array.isArray(issue.stateHistory) ? issue.stateHistory : []) {
    const entry = record(item)
    const state = record(entry?.state)
    const at = text(entry?.startedAt)
    const name = text(state?.name)
    if (at !== undefined && name !== undefined) activity.push({ kind: 'state', at, state: name, stateType: (text(state?.type) ?? '').toLowerCase() })
  }
  const bodies: string[] = []
  for (const item of commentList) {
    const entry = record(item)
    const body = text(entry?.body)
    const at = text(entry?.createdAt)
    if (body === undefined || at === undefined) continue
    bodies.push(body)
    const actor = nameOf(entry?.author) ?? nameOf(entry?.user)
    activity.push({ kind: 'comment', at, body, reply: text(entry?.parentId) !== undefined, ...(actor === undefined ? {} : { actor }) })
  }
  // Oldest first; entries at the same moment keep their order (created before its first state).
  activity.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return {
    identifier: identifier.toUpperCase(),
    ...(description === undefined ? {} : { description }),
    ...(project === undefined ? {} : { project }),
    ...(milestone === undefined ? {} : { milestone }),
    labels,
    pullRequests: pullRequestsIn(issue.attachments, [description, ...bodies]),
    activity,
  }
}

/** A closed issue by its state type, or by its state name when the type is missing. */
const closed = (issue: Issue): boolean => issue.stateType !== undefined
  ? CLOSED_TYPES.has(issue.stateType)
  : /^(done|completed|canceled|cancelled|duplicate)$/i.test(issue.state ?? '')

export class LinearTickets {
  private session: () => McpSession
  private toolNames: Promise<Map<string, Set<string>>> | undefined
  private issues = new Map<string, { at: number; issue: Promise<Issue | undefined> }>()
  private boards = new Map<string, { at: number; issues: Promise<Issue[]> }>()
  private states = new Map<string, { at: number; states: Promise<IssueState[]> }>()
  private details = new Map<string, { at: number; detail: Promise<IssueDetail> }>()
  private pulls = new Map<string, { at: number; version: number | undefined; pulls: Promise<PullRequest[]> }>()
  private lists = new Map<string, { at: number; value: Promise<unknown> }>()

  constructor(session: () => McpSession) {
    this.session = session
  }

  /** A read kept for `ttl`; a failed one is not kept. */
  private memo<T>(key: string, ttl: number, read: () => Promise<T>): Promise<T> {
    const hit = this.lists.get(key)
    if (hit !== undefined && Date.now() - hit.at < ttl) return hit.value as Promise<T>
    const value = read()
    this.lists.set(key, { at: Date.now(), value })
    value.catch(() => { if (this.lists.get(key)?.value === value) this.lists.delete(key) })
    return value
  }

  /** The workspace's teams. */
  teams(): Promise<Team[]> {
    return this.memo('teams', TEAMS_TTL_MS, async () => teamsIn(await this.call('list_teams', { limit: 250 })))
  }

  /** The labels a new ticket in a team can take (the team's and the workspace's). */
  labels(team: string): Promise<Named[]> {
    return this.memo(`labels
${team}`, OPTIONS_TTL_MS, async () => namedIn(await this.call('list_issue_labels', { team, limit: 250 })))
  }

  /** A team's projects still under way. */
  projects(team: string): Promise<Named[]> {
    return this.memo(`projects
${team}`, OPTIONS_TTL_MS, async () => namedIn(await this.pages('list_projects', { team, limit: PROJECTS_PAGE, fields: ['id', 'name', 'status'] })))
  }

  /** Every project of the workspace, for the board: its filter, its cards' colours, a ticket's project. */
  workspaceProjects(): Promise<ProjectInfo[]> {
    return this.memo('workspaceProjects', OPTIONS_TTL_MS, async () => projectsIn(await this.pages('list_projects', { limit: PROJECTS_PAGE })))
  }

  /** The workspace's active people. */
  users(): Promise<Named[]> {
    return this.memo('users', OPTIONS_TTL_MS, async () => namedIn(await this.call('list_users', { limit: 250 })))
  }

  /**
   * A new issue, in one save; resolves it as Linear answers (identifier, url, state, assignee).
   * `assignee`: a user id or "me".
   */
  async create(input: { team: string; title: string; description?: string; priority?: number; state?: string; assignee?: string; labels?: readonly string[]; project?: string }): Promise<Issue> {
    const saved = await this.call('save_issue', {
      team: input.team,
      title: input.title,
      ...(input.description === undefined || input.description === '' ? {} : { description: input.description }),
      ...(input.priority === undefined || input.priority === 0 ? {} : { priority: input.priority }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      ...(input.labels === undefined || input.labels.length === 0 ? {} : { labels: [...input.labels] }),
      ...(input.project === undefined ? {} : { project: input.project }),
    })
    if (saved === undefined) throw new Error('this Linear server cannot create issues')
    this.boards.clear()
    const issue = issuesIn(saved)[0]
    if (issue === undefined) throw new Error('Linear created the issue but did not say which one')
    // Read it back for what Linear filled in (the state it landed in, my name as assignee, its branch).
    const full = await this.issue(issue.identifier, true).catch(() => undefined)
    return { ...issue, ...full }
  }

  /** The server's tools and the argument names each takes. */
  private tools(): Promise<Map<string, Set<string>>> {
    this.toolNames ??= this.session().tools().then(
      (tools) => new Map(tools.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema?.properties ?? {}))])),
      (error: unknown) => {
        this.toolNames = undefined
        throw error
      },
    )
    return this.toolNames
  }

  /** Call a tool with only the arguments its schema lists; undefined when the server has no such tool. */
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const accepted = (await this.tools()).get(name)
    if (accepted === undefined) return undefined
    const sent = Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && (accepted.size === 0 || accepted.has(key))))
    return this.session().tool(name, sent)
  }

  /**
   * A `list_*` tool's items over its pages (each answer's `cursor` while `hasNextPage`), up to
   * {@link MAX_PAGES}; undefined when the server has no such tool.
   */
  private async pages(name: string, args: Record<string, unknown>): Promise<unknown[] | undefined> {
    let cursor: string | undefined
    const items: unknown[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const value = await this.call(name, { ...args, ...(cursor === undefined ? {} : { cursor }) })
      if (value === undefined) return page === 0 ? undefined : items
      items.push(...listIn(value))
      const raw = record(value)
      cursor = raw?.hasNextPage === true ? text(raw.cursor) : undefined
      if (cursor === undefined) break
    }
    return items
  }

  /** Open issues assigned to me, or any issue matching `query` (an identifier goes straight to it). */
  async search(query = ''): Promise<Issue[]> {
    const q = query.trim()
    if (IDENTIFIER.test(q)) {
      const exact = await this.issue(q)
      if (exact !== undefined) return [exact]
    }
    const found = q === ''
      ? issuesIn(await this.call('list_issues', { assignee: 'me', limit: 50, orderBy: 'updatedAt' })).filter((issue) => !closed(issue))
      : issuesIn(await this.call('list_issues', { query: q, limit: 20, orderBy: 'updatedAt' }))
    for (const issue of found) this.remember(issue)
    return found
  }

  /**
   * One issue by identifier; undefined when Linear does not know it. Cached briefly; past that,
   * the last answer still comes back at once while it is read again. `fresh` waits for a new read
   * and rejects when Linear cannot be reached.
   */
  issue(identifier: string, fresh = false): Promise<Issue | undefined> {
    const id = identifier.toUpperCase()
    const hit = this.issues.get(id)
    const age = hit === undefined ? Infinity : Date.now() - hit.at
    if (!fresh && age < ISSUE_TTL_MS) return hit!.issue
    const read = this.call('get_issue', { id, fields: BOARD_FIELDS }).then((value) => issuesIn(value)[0])
    const entry = { at: Date.now(), issue: read.catch(() => hit?.issue) }
    this.issues.set(id, entry)
    // A failed read is not remembered: the last answer stays, and the next read tries again.
    read.catch(() => {
      if (this.issues.get(id) !== entry) return
      if (hit === undefined) this.issues.delete(id)
      else this.issues.set(id, hit)
    })
    if (fresh) return read
    return age < ISSUE_STALE_MS ? hit!.issue : entry.issue
  }

  /**
   * The issues the board shows: open ones, plus those finished in the last {@link FINISHED_DAYS}
   * days. `mine`: assigned to me; else the workspace's most recently updated ones. Cached briefly;
   * `fresh` reads again.
   */
  board(mine: boolean, fresh = false): Promise<Issue[]> {
    const key = mine ? 'mine' : 'all'
    const hit = this.boards.get(key)
    if (!fresh && hit !== undefined && Date.now() - hit.at < BOARD_TTL_MS) return hit.issues
    const since = Date.now() - FINISHED_DAYS * 86_400_000
    const issues = this.call('list_issues', { ...(mine ? { assignee: 'me' } : {}), limit: 150, orderBy: 'updatedAt', fields: BOARD_FIELDS })
      .then((value) => issuesIn(value).filter((issue) => {
        if (!closed(issue)) return true
        const at = Date.parse(issue.updatedAt ?? '')
        return Number.isFinite(at) && at >= since
      }))
    this.boards.set(key, { at: Date.now(), issues })
    issues.then((list) => { for (const issue of list) this.remember(issue) }, () => { this.boards.delete(key) })
    return issues
  }

  /**
   * Every issue of a project, finished ones too, whoever they are assigned to: what the board
   * shows when it shows only that project. Cached briefly; `fresh` reads again.
   */
  projectBoard(project: string, fresh = false): Promise<Issue[]> {
    const key = `project
${project}`
    const hit = this.boards.get(key)
    if (!fresh && hit !== undefined && Date.now() - hit.at < BOARD_TTL_MS) return hit.issues
    // A server that cannot filter by project would answer with the whole workspace: none then.
    const issues = this.tools().then((tools) => tools.get('list_issues')?.has('project')
      ? this.pages('list_issues', { project, limit: 250, orderBy: 'updatedAt', fields: BOARD_FIELDS }).then((items) => issuesIn(items ?? []))
      : [])
    this.boards.set(key, { at: Date.now(), issues })
    issues.then((list) => { for (const issue of list) this.remember(issue) }, () => { this.boards.delete(key) })
    return issues
  }

  /** A team's workflow states, cached. */
  teamStates(team: string): Promise<IssueState[]> {
    const hit = this.states.get(team)
    if (hit !== undefined && Date.now() - hit.at < STATES_TTL_MS) return hit.states
    const states = this.call('list_issue_statuses', { team }).then(statesIn)
    this.states.set(team, { at: Date.now(), states })
    states.catch(() => { this.states.delete(team) })
    return states
  }

  /** Move an issue to a workflow state; the board and the issue are read again next time. */
  move(identifier: string, stateId: string): Promise<void> {
    return this.update(identifier, { state: stateId })
  }

  /** Change an issue in one save: its state, its assignee ("me" for the signed-in user). */
  async update(identifier: string, patch: { state?: string; assignee?: string }): Promise<void> {
    if (await this.call('save_issue', { id: identifier, ...patch }) === undefined) throw new Error('this Linear server cannot update issues')
    this.boards.clear()
    this.issues.delete(identifier.toUpperCase())
    this.details.delete(identifier.toUpperCase())
  }

  /** A ticket's description, pull requests and activity (state changes, comments). Cached briefly; `fresh` reads again. */
  detail(identifier: string, fresh = false): Promise<IssueDetail> {
    const id = identifier.toUpperCase()
    const hit = this.details.get(id)
    if (!fresh && hit !== undefined && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail
    const detail = Promise.all([
      this.call('get_issue', { id, fields: DETAIL_FIELDS }),
      // Comments are extra: a server without them, or a failed read, still shows the rest.
      this.call('list_comments', { issueId: id, limit: 100, orderBy: 'createdAt' }).catch(() => undefined),
    ]).then(([issue, comments]) => {
      if (issue === undefined) throw new Error('this Linear server cannot read issues')
      return detailOf(id, issue, comments)
    })
    this.details.set(id, { at: Date.now(), detail })
    detail.catch(() => { if (this.details.get(id)?.detail === detail) this.details.delete(id) })
    return detail
  }

  /**
   * The pull requests a ticket links (attachments and its description), for its card. `version`:
   * the ticket's last change as the board saw it; a changed ticket is read again, an unchanged one
   * after {@link PULLS_TTL_MS}.
   */
  pullRequests(identifier: string, version?: number): Promise<PullRequest[]> {
    const id = identifier.toUpperCase()
    const hit = this.pulls.get(id)
    if (hit !== undefined && hit.version === version && Date.now() - hit.at < PULLS_TTL_MS) return hit.pulls
    const pulls = this.call('get_issue', { id, fields: PULL_FIELDS }).then((value) => {
      const issue = record(record(value)?.issue) ?? record(value)
      return pullRequestsIn(issue?.attachments, [text(issue?.description)])
    })
    this.pulls.set(id, { at: Date.now(), version, pulls })
    pulls.catch(() => { if (this.pulls.get(id)?.pulls === pulls) this.pulls.delete(id) })
    return pulls
  }

  private remember(issue: Issue): void {
    this.issues.set(issue.identifier, { at: Date.now(), issue: Promise.resolve(issue) })
  }

  /** The workspace's team keys, which tell a ticket in a branch name from `login-2`. */
  private teamKeys(): Promise<string[]> {
    return this.memo('teamKeys', TEAMS_TTL_MS, () => this.call('list_teams', { limit: 250 }).then(teamKeysIn, () => [] as string[]))
  }

  /** The tickets these branches carry, by branch; branches naming none (or an unknown one) are left out. */
  async linked(branches: readonly string[]): Promise<LinkedIssues> {
    const keys = await this.teamKeys()
    const out: LinkedIssues = {}
    await Promise.all(branches.map(async (branch) => {
      const identifier = issueInBranch(branch, keys)
      const issue = identifier === undefined ? undefined : await this.issue(identifier)
      if (issue !== undefined) out[branch] = issue
    }))
    return out
  }
}
