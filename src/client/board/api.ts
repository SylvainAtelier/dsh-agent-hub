/**
 * The board's browser state: the host's cards, the filters (remembered per
 * browser), and the moves in flight. A move shows at once and is undone if
 * the host (or Linear) refuses it. The board reads again every minute while
 * it is on screen, and whenever the window regains focus.
 *
 * Which worktree a card has comes from the registered workspaces (the
 * repositories store, which follows the sidebar), not from the host's cards:
 * a worktree made anywhere shows on its card at once, without asking Linear.
 */

import type { Issue, IssueDetail, IssueState, PullRequest } from '../../connectors/types.ts'
import { samePath, type RepoGroup } from '../../repos/types.ts'
import {
  BOARD_METHOD, inRepo, linkTrees, PULLS_BATCH,
  type BoardReply, type BoardRequest, type BoardState, type Card, type Created, type Draft, type Named, type NewTicket, type Stage, type StartResult,
  type TicketOptions, type Workspace,
} from '../../board/types.ts'
import { rpcReply, type Rpc } from '../rpc.ts'

export type BoardCall = (payload: BoardRequest) => Promise<BoardReply<unknown>>

export function boardCall(rpc: Rpc): BoardCall {
  return (payload) => rpcReply<BoardReply<unknown>>(rpc, BOARD_METHOD, payload, 'agent-hub board RPC failed', (error) => ({ ok: false, error }))
}

/** A card the board's search (lower-cased, trimmed) finds by itself: by title, id or project. */
export const cardMatches = (card: Card, text: string): boolean =>
  card.title.toLowerCase().includes(text) || card.id.toLowerCase().includes(text) || (card.project?.toLowerCase().includes(text) ?? false)

export interface Filters {
  /** The repository shown; empty for all. */
  repo: string
  /** Linear: my issues, or everyone's. */
  mine: boolean
  /** The Linear project shown, by name; empty for all. */
  project: string
  query: string
}

/** The repositories store's slice the board reads. */
export interface ReposSource {
  getSnapshot(): { repos: readonly RepoGroup[] | undefined }
  subscribe(listener: () => void): () => void
  load(): Promise<void>
}

export interface BoardSnapshot {
  data: BoardState | undefined
  /** Registered workspaces by repository: the filter's choices, and where cards' worktrees are. */
  repos: readonly RepoGroup[]
  /** Cards whose worktree is being made. */
  starting: readonly string[]
  loading: boolean
  error: string | null
  /** The last action's failure, until dismissed or the next action. */
  notice: string | null
  filters: Filters
  /** Linear cards' pull requests by card key, filled in after the board is read. */
  pulls: ReadonlyMap<string, readonly PullRequest[]>
}

const FILTERS_KEY = 'dsh-agent-hub.board.filters.v1'
const POLL_MS = 60_000
const NO_REPOS: readonly RepoGroup[] = []
/** A card's pull requests are asked for again after this even when the card has not changed (the host caches as long). */
const PULLS_TTL_MS = 10 * 60_000
/** Which cards' pull requests are read first: work under way, then done, then the rest. */
const PULLS_ORDER: Record<Stage, number> = { started: 0, completed: 1, unstarted: 2, backlog: 3, canceled: 4 }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

function readFilters(): Filters {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') as Partial<Filters>
    return { repo: typeof raw.repo === 'string' ? raw.repo : '', mine: raw.mine !== false, project: typeof raw.project === 'string' ? raw.project : '', query: '' }
  } catch {
    return { repo: '', mine: true, project: '', query: '' }
  }
}

export class BoardStore {
  private snapshot: BoardSnapshot = { data: undefined, repos: NO_REPOS, starting: [], loading: false, error: null, notice: null, filters: readFilters(), pulls: new Map() }
  private readonly listeners = new Set<() => void>()
  private readonly call: BoardCall
  private timer: ReturnType<typeof setTimeout> | undefined
  private reading = 0
  private disposed = false
  private readonly pending = new Set<string>()
  private readonly stateCache = new Map<string, Promise<IssueState[]>>()
  private readonly optionsCache = new Map<string, Promise<TicketOptions>>()
  private readonly detailCache = new Map<string, { version: number; detail: Promise<IssueDetail> }>()
  /** Pull requests asked for, by card key: the card's version then, and when. */
  private readonly pullsAsked = new Map<string, { version: number; at: number }>()
  private readonly repos: ReposSource | undefined
  private readonly offRepos: () => void
  private links: { cards: readonly Card[]; repos: readonly RepoGroup[]; prefer: string; map: Map<string, Workspace>; linked: Card[] } | undefined

  constructor(call: BoardCall, repos?: ReposSource) {
    this.call = call
    this.repos = repos
    const sync = (): void => {
      const next = repos?.getSnapshot().repos ?? NO_REPOS
      if (next !== this.snapshot.repos) this.publish({ repos: next })
    }
    sync()
    this.offRepos = repos?.subscribe(sync) ?? (() => {})
  }

  getSnapshot = (): BoardSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(patch: Partial<BoardSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  setFilters(patch: Partial<Filters>): void {
    const before = this.snapshot.filters
    const filters = { ...before, ...patch }
    this.publish({ filters })
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ repo: filters.repo, mine: filters.mine, project: filters.project }))
    } catch {
      // Not remembered.
    }
    // A project's every ticket is read with the board, so picking one reads it again.
    if (patch.mine !== undefined || (patch.project !== undefined && patch.project !== before.project)) void this.load()
  }

  /** Read the board; `fresh` skips the host's short Linear cache. The latest read wins. */
  async load(fresh = false): Promise<void> {
    if (this.disposed) return
    clearTimeout(this.timer)
    const ticket = ++this.reading
    this.publish({ loading: true })
    // The repositories are cheap to read (no git process): a branch switched inside a worktree shows too.
    void this.repos?.load()
    const { mine, project } = this.snapshot.filters
    const reply = await this.request({ op: 'state', mine, fresh, ...(project === '' ? {} : { project }) })
    if (this.disposed || ticket !== this.reading) return
    if (reply.ok) {
      const data = reply.value as BoardState
      const current = this.snapshot.data?.cards ?? []
      // Reads can update other cards, but not a pending optimistic edit/deletion.
      const cards = data.cards.filter((card) => !this.pending.has(card.key))
      cards.push(...current.filter((card) => this.pending.has(card.key)))
      this.publish({ data: { ...data, cards }, loading: false, error: null })
      void this.loadPulls(cards)
    } else this.publish({ loading: false, error: reply.error })
    this.poll()
  }

  /**
   * The pull requests of Linear cards not yet asked about, or changed since, or asked about long
   * ago: per account, a batch at a time, each shown as it lands.
   */
  private async loadPulls(cards: readonly Card[]): Promise<void> {
    const now = Date.now()
    const due = cards
      .filter((card) => {
        if (card.source !== 'linear' || card.connector === undefined) return false
        const asked = this.pullsAsked.get(card.key)
        return asked === undefined || asked.version !== card.updatedAt || now - asked.at >= PULLS_TTL_MS
      })
      .sort((a, b) => PULLS_ORDER[a.stage] - PULLS_ORDER[b.stage] || b.updatedAt - a.updatedAt)
    for (const card of due) this.pullsAsked.set(card.key, { version: card.updatedAt, at: now })
    const byAccount = new Map<string, Card[]>()
    for (const card of due) byAccount.set(card.connector!, [...(byAccount.get(card.connector!) ?? []), card])
    await Promise.all([...byAccount].map(async ([connector, list]) => {
      for (let i = 0; i < list.length && !this.disposed; i += PULLS_BATCH) {
        const batch = list.slice(i, i + PULLS_BATCH)
        const reply = await this.request({ op: 'pulls', connector, issues: batch.map((card) => ({ id: card.id, version: card.updatedAt })) })
        const found = reply.ok ? reply.value as Record<string, PullRequest[]> : {}
        const pulls = new Map(this.snapshot.pulls)
        for (const card of batch) {
          const value = found[card.id]
          if (value !== undefined) pulls.set(card.key, value)
          // Not read this time: asked again on the next read.
          else this.pullsAsked.delete(card.key)
        }
        this.publish({ pulls })
      }
    }))
  }

  /**
   * A Linear card's description, pull requests (its comments' too) and activity; kept until the
   * card changes, `fresh` reads again.
   */
  detail(card: Card, fresh = false): Promise<IssueDetail> {
    if (card.source !== 'linear' || card.connector === undefined) return Promise.reject(new Error('only Linear tickets have activity'))
    const hit = this.detailCache.get(card.key)
    if (!fresh && hit !== undefined && hit.version === card.updatedAt) return hit.detail
    const detail = this.request({ op: 'detail', connector: card.connector, identifier: card.id, ...(fresh ? { fresh } : {}) }).then((reply) => {
      if (!reply.ok) throw new Error(reply.error)
      return reply.value as IssueDetail
    })
    this.detailCache.set(card.key, { version: card.updatedAt, detail })
    detail.catch(() => { if (this.detailCache.get(card.key)?.detail === detail) this.detailCache.delete(card.key) })
    return detail
  }

  private poll(delay = POLL_MS): void {
    clearTimeout(this.timer)
    if (this.disposed || this.listeners.size === 0) return
    this.timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void this.load()
      else this.poll()
    }, delay)
  }

  /** Every card, each with the worktree it is worked on in; recomputed only when cards or workspaces change. */
  cards(): Card[] {
    const { data, repos, filters } = this.snapshot
    if (data === undefined) return []
    const hit = this.links
    if (hit !== undefined && hit.cards === data.cards && hit.repos === repos && hit.prefer === filters.repo) return hit.linked
    const map = linkTrees(data.cards, repos, samePath, filters.repo)
    const linked = data.cards.map((card) => {
      const workspace = map.get(card.key)
      if (workspace === undefined) return card.workspace === undefined ? card : { ...card, workspace: undefined }
      return { ...card, workspace }
    })
    this.links = { cards: data.cards, repos, prefer: filters.repo, map, linked }
    return linked
  }

  /** One card by key, with its worktree. */
  card(key: string | undefined): Card | undefined {
    return key === undefined ? undefined : this.cards().find((card) => card.key === key)
  }

  /** The cards the filters let through; `byProject` false: whatever their project (what the project filter counts); `bySearch` false: whatever the search. */
  visible(byProject = true, bySearch = true): Card[] {
    const { filters } = this.snapshot
    const query = bySearch ? filters.query.trim().toLowerCase() : ''
    return this.cards().filter((card) =>
      (filters.repo === '' || inRepo(card, filters.repo, samePath))
      && (!byProject || filters.project === '' || card.project === filters.project)
      && (query === '' || cardMatches(card, query)))
  }

  private patchCard(key: string, patch: Partial<Card>): void {
    const data = this.snapshot.data
    if (data === undefined) return
    this.publish({ data: { ...data, cards: data.cards.map((card) => (card.key === key ? { ...card, ...patch } : card)) } })
  }

  private async request(payload: BoardRequest): Promise<BoardReply<unknown>> {
    if (this.disposed) return { ok: false, error: 'board is disposed' }
    try { return await this.call(payload) } catch (error) { return { ok: false, error: message(error) } }
  }

  /** All writes, including start and delete, share the same per-card lock. */
  private begin(card: Card): Card | undefined {
    if (this.disposed) return undefined
    if (this.pending.has(card.key)) {
      this.fail('Wait for the current action on this card to finish.')
      return undefined
    }
    const current = this.snapshot.data?.cards.find((item) => item.key === card.key) ?? card
    this.pending.add(card.key)
    this.publish({ notice: null })
    return current
  }

  private end(key: string): void {
    this.pending.delete(key)
    // A read begun before completion cannot undo the confirmed result or rollback.
    ++this.reading
    this.publish({ loading: false })
    // Failed/no-op writes also invalidate a read: restore polling and current filters.
    this.poll(0)
  }

  private restore(card: Card): void {
    const data = this.snapshot.data
    if (data === undefined) return
    const cards = data.cards.filter((item) => item.key !== card.key)
    cards.push(card)
    this.publish({ data: { ...data, cards } })
  }

  private fail(error: string): void {
    this.publish({ notice: error })
  }

  dismiss(): void {
    this.publish({ notice: null })
  }

  /** Move a card to a column (or, for Linear, to one exact state); shown at once, undone on refusal. */
  async move(card: Card, stage: Stage, state?: IssueState): Promise<boolean> {
    const before = this.begin(card)
    if (before === undefined) return false
    if (before.stage === stage && state === undefined) { this.end(card.key); return true }
    this.patchCard(card.key, { stage, ...(state === undefined ? {} : { state: state.name }), updatedAt: Date.now() })
    const reply = card.source === 'local'
      ? await this.request({ op: 'update', id: card.id, stage })
      : await this.request({
          op: 'move', connector: card.connector ?? '', identifier: card.id,
          ...(card.team === undefined ? {} : { team: card.team }),
          ...(state === undefined ? { stage } : { stateId: state.id }),
        })
    if (!reply.ok) {
      this.restore(before)
      this.fail(reply.error)
      this.end(card.key)
      return false
    }
    if (card.source === 'linear') {
      const moved = reply.value as IssueState
      if (moved.name !== '') this.patchCard(card.key, { state: moved.name })
    }
    this.end(card.key)
    if (this.disposed) return false
    void this.load(card.source === 'linear')
    return true
  }

  /**
   * A new ticket, local or in Linear (announced in Slack when a channel is given). Rejects with the
   * host's reason, for the form to show beside what was typed; a failed announcement is a notice.
   */
  async create(input: NewTicket): Promise<Created> {
    const reply = await this.request({ op: 'create', ...input })
    if (!reply.ok) throw new Error(reply.error)
    const created = reply.value as Created
    if (created.warning !== undefined) this.fail(created.warning)
    if (!this.disposed) await this.load(input.linear !== undefined)
    return created
  }

  /** What a new ticket in a Linear team can be set to; kept for the page's life, a failed read is asked again. */
  options(connector: string, team?: string): Promise<TicketOptions> {
    const key = `${connector}\n${team ?? ''}`
    let options = this.optionsCache.get(key)
    if (options === undefined) {
      options = this.request({ op: 'options', connector, ...(team === undefined ? {} : { team }) }).then((reply) => {
        if (!reply.ok) throw new Error(reply.error)
        return reply.value as TicketOptions
      })
      this.optionsCache.set(key, options)
      options.catch(() => { if (this.optionsCache.get(key) === options) this.optionsCache.delete(key) })
    }
    return options
  }

  /** Slack channels whose name matches `query`. */
  async channels(connector: string, query: string): Promise<Named[]> {
    const reply = await this.request({ op: 'channels', connector, query })
    if (!reply.ok) throw new Error(reply.error)
    return reply.value as Named[]
  }

  /** A new ticket's title and description as a bot writes them. */
  async compose(bot: string, draft: Draft, repo?: string): Promise<Draft> {
    const reply = await this.request({ op: 'compose', bot, ...draft, ...(repo === undefined ? {} : { repo }) })
    if (!reply.ok) throw new Error(reply.error)
    return reply.value as Draft
  }

  async update(card: Card, patch: { title?: string; note?: string; repo?: string; priority?: number }): Promise<boolean> {
    const before = this.begin(card)
    if (before === undefined) return false
    this.patchCard(card.key, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      ...(patch.repo === undefined ? {} : { repos: [patch.repo] }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    })
    const reply = await this.request({ op: 'update', id: card.id, ...patch })
    if (!reply.ok) { this.restore(before); this.fail(reply.error) }
    this.end(card.key)
    if (reply.ok) void this.load()
    return reply.ok && !this.disposed
  }

  async remove(card: Card): Promise<void> {
    const before = this.begin(card)
    if (before === undefined) return
    const data = this.snapshot.data
    if (data !== undefined) this.publish({ data: { ...data, cards: data.cards.filter((item) => item.key !== card.key) } })
    const reply = await this.request({ op: 'delete', id: card.id })
    if (!reply.ok) { this.restore(before); this.fail(reply.error) }
    this.end(card.key)
    if (reply.ok) void this.load()
  }

  /** A Linear team's workflow states, in column order; cached for the page's life. */
  states(card: Card): Promise<IssueState[]> {
    if (card.connector === undefined || card.team === undefined) return Promise.resolve([])
    const key = `${card.connector}\n${card.team}`
    let states = this.stateCache.get(key)
    if (states === undefined) {
      states = this.request({ op: 'states', connector: card.connector, team: card.team }).then((reply) => {
        if (!reply.ok) throw new Error(reply.error)
        return reply.value as IssueState[]
      })
      this.stateCache.set(key, states)
      states.catch(() => { this.stateCache.delete(key) })
    }
    return states
  }

  /**
   * Start work on a card in a repository: the card moves to in progress at once and shows its
   * worktree being made; resolves the host's result, undefined on failure. The worktree shows on
   * the card as soon as the repositories are read again, before this resolves.
   */
  async start(card: Card, repo: string, base?: string): Promise<StartResult | undefined> {
    const before = this.begin(card)
    if (before === undefined) return undefined
    this.publish({ starting: [...this.snapshot.starting, card.key] })
    if (before.stage === 'backlog' || before.stage === 'unstarted') this.patchCard(card.key, { stage: 'started' })
    const reply = await this.request({
      op: 'start',
      card: {
        source: before.source, id: before.id, title: before.title,
        ...(before.connector === undefined ? {} : { connector: before.connector }),
        ...(before.branch === undefined ? {} : { branch: before.branch }),
      },
      repo,
      ...(base === undefined || base === '' ? {} : { base }),
    })
    let value: StartResult | undefined
    if (reply.ok) {
      value = reply.value as StartResult
      this.restore({
        ...before,
        branch: value.branch,
        ...(value.stage === undefined ? {} : { stage: value.stage }),
        ...(value.state === undefined ? {} : { state: value.state }),
        ...(value.assignee === undefined ? {} : { assignee: value.assignee }),
      })
      if (value.warning !== undefined) this.publish({ notice: value.warning })
      // The new workspace is registered: read it now, so the card links to it as "starting" ends.
      await this.repos?.load().catch(() => {})
    } else {
      this.restore(before)
      this.fail(reply.error)
    }
    this.publish({ starting: this.snapshot.starting.filter((key) => key !== card.key) })
    this.end(card.key)
    if (this.disposed || value === undefined) return undefined
    void this.load(card.source === 'linear')
    return value
  }

  /**
   * Start work on a ticket picked in the Git pane, in the repository `cwd` is in: the same run as
   * the board's "开始" (the account serving that repository answers). The board, if on screen,
   * reads again.
   */
  async startIssue(issue: Pick<Issue, 'identifier' | 'title' | 'branch'>, cwd: string, base?: string): Promise<BoardReply<StartResult>> {
    const reply = await this.request({
      op: 'start',
      card: { source: 'linear', id: issue.identifier, title: issue.title, ...(issue.branch === undefined ? {} : { branch: issue.branch }) },
      repo: cwd,
      ...(base === undefined || base === '' ? {} : { base }),
    })
    if (reply.ok && !this.disposed) {
      await this.repos?.load().catch(() => {})
      if (this.listeners.size > 0) void this.load(true)
    }
    return reply as BoardReply<StartResult>
  }

  dispose(): void {
    this.disposed = true
    ++this.reading
    clearTimeout(this.timer)
    this.listeners.clear()
    this.stateCache.clear()
    this.optionsCache.clear()
    this.detailCache.clear()
    this.offRepos()
  }
}
