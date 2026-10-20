/**
 * One store per repository directory, shared by every pane showing it. Status
 * is polled only while a pane holds the store and the page is visible (fast
 * when focused, slow otherwise); a reply whose key matches the last one is
 * dropped without notifying, so idle polling never re-renders. The graph
 * reloads only when refs or HEAD move. Where the host watches the files, an
 * unchanged poll costs it no git run, so the focused pace is quicker there.
 * Explicit refreshes (after a command, the refresh button) ask for a fresh read.
 */

import type { Commit, CommitDetail, DiffText, GitError, GitOp, GitReply, GitRequest, GitStatus, Ref, ValueOf, WorktreeList } from '../../git/types.ts'
import { t, type GitKey } from './i18n.ts'

export type Call = (cwd: string, request: GitRequest) => Promise<GitReply<unknown>>

export interface Toast {
  id: number
  kind: 'ok' | 'error'
  text: string
  detail?: string
  /** Lifetime in ms; the toast dismisses itself unless held. */
  ttl: number
  /** A follow-up the toast offers (Back to session); such a toast stays long enough to reach it. */
  action?: { label: string; run: () => void }
}

const TOAST_TTL: Record<Toast['kind'], number> = { ok: 2600, error: 10_000 }
const ACTION_TTL = 5000

export interface LogState {
  commits: Commit[]
  refs: Ref[]
  head?: string
  branch?: string
  more: boolean
  loading: boolean
  error?: string
  /** refsKey the log was read at. */
  key?: string
  /** The one ref whose history this is; every ref's when absent. */
  scope?: string
  /** Only these authors' commits (`authorKey`s); everyone's when absent. */
  authors?: string[]
}

export interface TreesState {
  list?: WorktreeList
  loading: boolean
  error?: string
}

export interface RepoState {
  status?: GitStatus
  error?: GitError
  log?: LogState
  /** The working trees, once something asked for them. */
  trees?: TreesState
  /** Label of the mutation in flight. */
  busy?: GitOp
  /** The AI commit in flight and the step it is on; it lives here so it outlasts the pane that started it. */
  ai?: AiPhase
  toasts: Toast[]
}

export type AiPhase = 'stage' | 'write' | 'commit'

const PAGE = 400

const logFilter = (scope: string | undefined, authors: string[] | undefined): { ref?: string; authors?: string[] } =>
  ({ ...(scope === undefined ? {} : { ref: scope }), ...(authors === undefined ? {} : { authors }) })

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((item, i) => item === b[i]))
const FAST_MS = 2500
/** Focused pace when the host answers from a file watcher. */
const WATCHED_MS = 1500
const SLOW_MS = 10_000

export interface RunOptions {
  /** Success toast. */
  done?: GitKey
  doneParams?: Record<string, string | number>
  /** Keep failures quiet (the caller shows them). */
  quiet?: boolean
  /** Failures shown in the pane's words instead of git's, by error code. */
  errors?: Partial<Record<string, GitKey>>
}

export class RepoStore {
  private state: RepoState = { toasts: [] }
  private readonly listeners = new Set<() => void>()
  private holds = 0
  private fastHolds = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private polling: { run: Promise<void>; fresh: boolean; seq: number } | undefined
  private statusSeq = 0
  private appliedSeq = 0
  private logSeq = 0
  private toastSeq = 0
  private readonly toastTimers = new Map<number, { timer: ReturnType<typeof setTimeout> | undefined; left: number; since: number }>()
  private mutations: Promise<unknown> = Promise.resolve()
  private pendingMutations = 0
  private readonly details = new Map<string, Promise<GitReply<CommitDetail>>>()

  readonly cwd: string
  private readonly call: Call

  constructor(cwd: string, call: Call) {
    this.cwd = cwd
    this.call = call
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): RepoState => this.state

  private set(next: Partial<RepoState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  async request<R extends GitRequest>(request: R): Promise<GitReply<ValueOf<R['op']>>> {
    try {
      return await this.call(this.cwd, request) as GitReply<ValueOf<R['op']>>
    } catch (error) {
      return { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /**
   * Hold the store while something shows it; polling runs only while held.
   * A pane polls fast; a glance (the header badge) settles for the slow pace.
   */
  retain(pace: 'fast' | 'slow' = 'fast'): () => void {
    this.holds++
    if (pace === 'fast') this.fastHolds++
    if (this.holds === 1) {
      document.addEventListener('visibilitychange', this.wake)
      window.addEventListener('focus', this.wake)
      void this.refresh(false)
    }
    else if (pace === 'fast' && this.fastHolds === 1) void this.refresh(false)
    return () => {
      this.holds--
      if (pace === 'fast') this.fastHolds--
      if (this.holds === 0) {
        clearTimeout(this.timer)
        this.timer = undefined
        document.removeEventListener('visibilitychange', this.wake)
        window.removeEventListener('focus', this.wake)
      }
    }
  }

  private wake = (): void => {
    if (document.visibilityState === 'visible') void this.refresh(false)
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.holds === 0 || document.visibilityState !== 'visible') return
    const fast = this.state.status?.watched === true ? WATCHED_MS : FAST_MS
    this.timer = setTimeout(() => void this.refresh(false), this.fastHolds > 0 && document.hasFocus() ? fast : SLOW_MS)
  }

  /**
   * Re-read status now. `fresh` (the default) makes the host read everything
   * again; polls pass false. Coalesced with a read in flight that is at least
   * as fresh; an older reply never overwrites a newer one.
   */
  refresh(fresh = true): Promise<void> {
    if (this.polling !== undefined && (this.polling.fresh || !fresh)) return this.polling.run
    const seq = ++this.statusSeq
    const run = (async () => {
      const reply = await this.request(fresh ? { op: 'status', fresh: true } : { op: 'status' })
      if (this.polling?.seq === seq) this.polling = undefined
      if (seq < this.appliedSeq) return
      this.appliedSeq = seq
      if (reply.ok) {
        const previous = this.state.status
        if (previous?.key !== reply.value.key || this.state.error !== undefined) this.set({ status: reply.value, error: undefined })
        const log = this.state.log
        if (log !== undefined && log.key !== reply.value.refsKey && !log.loading) void this.loadLog()
        // Branches moving (here or in another tree) can change what each tree has checked out.
        if (this.state.trees !== undefined && previous !== undefined && previous.refsKey !== reply.value.refsKey) void this.loadTrees()
      } else if (this.state.error?.message !== reply.error.message || this.state.status !== undefined) {
        this.set({ error: reply.error, status: undefined })
      }
      this.schedule()
    })()
    this.polling = { run, fresh, seq }
    return run
  }

  /** First page of the graph (again). */
  async loadLog(): Promise<void> {
    const seq = ++this.logSeq
    const key = this.state.status?.refsKey
    const scope = this.state.log?.scope
    const authors = this.state.log?.authors
    this.set({ log: { ...(this.state.log ?? { commits: [], refs: [], more: false }), loading: true, error: undefined } })
    const reply = await this.request({ op: 'log', skip: 0, limit: Math.max(PAGE, this.state.log?.commits.length ?? 0), ...logFilter(scope, authors) })
    if (seq !== this.logSeq) return
    const kept = { ...(key === undefined ? {} : { key }), ...(scope === undefined ? {} : { scope }), ...(authors === undefined ? {} : { authors }) }
    if (reply.ok) this.set({ log: { ...reply.value, loading: false, ...kept } })
    else this.set({ log: { ...(this.state.log ?? { commits: [], refs: [], more: false }), loading: false, error: reply.error.message } })
  }

  /** Show one ref's history in the graph (undefined: every ref's). The old rows go, so nothing stale shows meanwhile. */
  setScope(scope: string | undefined): Promise<void> {
    const log = this.state.log ?? { commits: [], refs: [], more: false, loading: false }
    if (log.scope === scope && this.state.log !== undefined) return Promise.resolve()
    const { scope: _old, ...rest } = log
    this.set({ log: { ...rest, commits: [], more: false, ...(scope === undefined ? {} : { scope }) } })
    return this.loadLog()
  }

  /** Show only these authors' commits (undefined: everyone's). */
  setAuthors(authors: string[] | undefined): Promise<void> {
    const next = authors === undefined || authors.length === 0 ? undefined : authors
    const log = this.state.log ?? { commits: [], refs: [], more: false, loading: false }
    if (sameList(log.authors, next) && this.state.log !== undefined) return Promise.resolve()
    const { authors: _old, ...rest } = log
    this.set({ log: { ...rest, commits: [], more: false, ...(next === undefined ? {} : { authors: next }) } })
    return this.loadLog()
  }

  async loadMore(): Promise<void> {
    const log = this.state.log
    if (log === undefined || log.loading || !log.more) return
    const seq = ++this.logSeq
    this.set({ log: { ...log, loading: true } })
    const reply = await this.request({ op: 'log', skip: log.commits.length, limit: PAGE, ...logFilter(log.scope, log.authors) })
    if (seq !== this.logSeq) return
    const current = this.state.log!
    if (reply.ok) {
      const seen = new Set(current.commits.map((commit) => commit.hash))
      const commits = current.commits.concat(reply.value.commits.filter((commit) => !seen.has(commit.hash)))
      this.set({ log: { ...current, commits, refs: reply.value.refs, more: reply.value.more, loading: false } })
    } else {
      this.set({ log: { ...current, loading: false, error: reply.error.message } })
    }
  }

  private treesSeq = 0

  /** Read the working trees (again); the last list stays on screen meanwhile. */
  async loadTrees(): Promise<void> {
    const seq = ++this.treesSeq
    this.set({ trees: { ...this.state.trees, loading: true } })
    const reply = await this.request({ op: 'worktree-list' })
    if (seq !== this.treesSeq) return
    if (reply.ok) this.set({ trees: { list: reply.value, loading: false } })
    else this.set({ trees: { ...this.state.trees, loading: false, error: reply.error.message } })
  }

  show(hash: string): Promise<GitReply<CommitDetail>> {
    let found = this.details.get(hash)
    if (found === undefined) {
      found = this.request({ op: 'show', hash })
      this.details.set(hash, found)
      found.then((reply) => { if (!reply.ok) this.details.delete(hash) })
      if (this.details.size > 64) this.details.delete(this.details.keys().next().value!)
    }
    return found
  }

  diff(request: Extract<GitRequest, { op: 'diff' }>): Promise<GitReply<DiffText>> {
    return this.request(request)
  }

  /** Run a mutation: one at a time, status refreshed after, outcome toasted. */
  run<R extends GitRequest>(request: R, options: RunOptions = {}): Promise<GitReply<ValueOf<R['op']>>> {
    if (++this.pendingMutations === 1) this.set({ busy: request.op })
    const next = this.mutations.catch(() => {}).then(async () => {
      this.set({ busy: request.op })
      try {
        return await this.runMutation(request, options)
      } finally {
        if (--this.pendingMutations === 0) this.set({ busy: undefined })
      }
    })
    this.mutations = next
    return next
  }

  private async runMutation<R extends GitRequest>(request: R, options: RunOptions): Promise<GitReply<ValueOf<R['op']>>> {
    const reply = await this.request(request)
    if (reply.ok) {
      if (options.done !== undefined) this.toast('ok', t(options.done, options.doneParams))
    } else if (!options.quiet && options.errors?.[reply.error.code] !== undefined) {
      this.toast('error', t(options.errors[reply.error.code]!))
    } else if (!options.quiet) {
      const lines = reply.error.message.split('\n').filter((line) => line.trim() !== '')
      const head = lines.find((line) => /^(error|fatal|hint: )/i.test(line)) ?? lines[0] ?? t('failed')
      this.toast('error', head.replace(/^(error|fatal):\s*/i, ''), lines.length > 1 ? reply.error.message : undefined)
    }
    await this.refresh()
    if (this.state.log !== undefined && reply.ok) void this.loadLog()
    if (this.state.trees !== undefined) void this.loadTrees()
    return reply
  }

  /**
   * Stage everything, let the model write the message, commit (no push). Runs on the store,
   * not the pane, so switching windows or closing the pane doesn't cut it short.
   */
  async autoCommit(email: string): Promise<void> {
    if (this.state.ai !== undefined) return
    this.set({ ai: 'stage' })
    try {
      // The message describes the index when anything is staged: a partly staged tree is staged whole first.
      const now = this.state.status
      if (now !== undefined && now.staged.length > 0 && now.unstaged.length + now.untracked.length > 0) {
        const added = await this.run({ op: 'stage' })
        if (!added.ok) return
      }
      this.set({ ai: 'write' })
      const reply = await this.request({ op: 'suggest-message' })
      if (!reply.ok) {
        this.toast('error', reply.error.code === 'unavailable' ? t('suggestUnavailable') : t('suggestFailed', { error: reply.error.message }))
        return
      }
      this.set({ ai: 'commit' })
      const subject = reply.value.split('\n', 1)[0]!.trim()
      await this.run({ op: 'commit', message: reply.value, all: true, as: email },
        { done: 'done.aiCommit', doneParams: { subject }, errors: { identity: 'ident.changed' } })
    } finally {
      this.set({ ai: undefined })
    }
  }

  toast(kind: Toast['kind'], text: string, detail?: string, action?: Toast['action']): void {
    const toast: Toast = {
      id: ++this.toastSeq, kind, text, ttl: action === undefined ? TOAST_TTL[kind] : Math.max(TOAST_TTL[kind], ACTION_TTL),
      ...(detail === undefined ? {} : { detail }), ...(action === undefined ? {} : { action }),
    }
    this.set({ toasts: [...this.state.toasts.slice(-2), toast] })
    this.toastTimers.set(toast.id, { timer: setTimeout(() => this.dismiss(toast.id), toast.ttl), left: toast.ttl, since: Date.now() })
  }

  /** Pause a toast's countdown while it is hovered, focused or expanded; resume when released. */
  holdToast(id: number, held: boolean): void {
    const entry = this.toastTimers.get(id)
    if (entry === undefined || held === (entry.timer === undefined)) return
    if (held) {
      clearTimeout(entry.timer)
      entry.timer = undefined
      entry.left = Math.max(0, entry.left - (Date.now() - entry.since))
    } else {
      entry.since = Date.now()
      entry.timer = setTimeout(() => this.dismiss(id), entry.left)
    }
  }

  dismiss(id: number): void {
    clearTimeout(this.toastTimers.get(id)?.timer)
    this.toastTimers.delete(id)
    if (this.state.toasts.some((toast) => toast.id === id)) this.set({ toasts: this.state.toasts.filter((toast) => toast.id !== id) })
  }
}

export function createRepos(call: Call): (cwd: string) => RepoStore {
  const repos = new Map<string, RepoStore>()
  return (cwd) => {
    let repo = repos.get(cwd)
    if (repo === undefined) {
      repo = new RepoStore(cwd, call)
      repos.set(cwd, repo)
    }
    return repo
  }
}
