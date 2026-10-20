/**
 * The review module's browser state: the 待我审 list (read with the board, every minute while
 * it is on screen), in the scope the lane shows (mine, or every open pull request); each scope's
 * last list is kept, so switching shows it at once while the host is asked again; and the sheets being shown, each watched while a form shows it: asked for
 * every 1.5 s with its last version, so an unchanged file costs one stat on the host. An edit
 * shows at once; the host's answer (the file as written) replaces it.
 *
 * Runs are followed apart from the list: `progress` is in memory on the host, so it is asked for
 * every second while a sync or an analysis is starting, every few while one analyses, and not at
 * all otherwise. A run reaching a new stage reads the list again, once.
 */

import {
  REVIEW_METHOD, runEnded, scopeOf,
  type Explained, type ExplainLang, type ExplainTarget, type Explanation, type MergeMethod, type MergeState, type PullDiff, type PullFile, type PullRemark, type PullThread, type ResponsePosted, type ResponsePreview, type ReviewPreview, type ReviewProgress, type ReviewReply, type ReviewRequest, type ReviewScope, type ReviewState, type Sheet, type SheetOp, type SheetReply,
  type TreeChoice, type TreePlaces,
} from '../../review/types.ts'
import { applyOps } from '../../review/sheet.ts'
import { rpcReply, type Rpc } from '../rpc.ts'

export type ReviewCall = (payload: ReviewRequest) => Promise<ReviewReply<unknown>>

export function reviewCall(rpc: Rpc): ReviewCall {
  return (payload) => rpcReply<ReviewReply<unknown>>(rpc, REVIEW_METHOD, payload, 'agent-hub review RPC failed', (error) => ({ ok: false, error }))
}

export interface ReviewSnapshot {
  state: ReviewState | undefined
  /** The list the lane shows; `state` is of it once read (`state.scope`, absent meaning mine). */
  scope?: ReviewScope
  loading: boolean
  error: string | null
  /** The last action's failure, until dismissed or the next action. */
  notice: string | null
  progress?: ReviewProgress
  /** This clock minus the host's: host times shown as elapsed read right on a skewed device. */
  skew?: number
}

export type SubmitResult =
  | { preview: ReviewPreview; posted?: { id: string; url?: string } }
  /** My own pull request's response: pushed, replied, resolved. */
  | { preview: ResponsePreview; posted?: ResponsePosted }

const POLL_MS = 60_000
const SCOPE_KEY = 'dsh-agent-hub.review.scope'

function readScope(): ReviewScope {
  try {
    return scopeOf(globalThis.localStorage?.getItem(SCOPE_KEY))
  } catch {
    return 'mine'
  }
}

const scopeOfState = (state: ReviewState): ReviewScope => state.scope ?? 'mine'
const SHEET_POLL_MS = 1_500
/** A sheet nothing writes to is asked after less and less often, up to this. */
const SHEET_IDLE_MS = 8_000
/** Hidden, timers only look whether the page is back this often; coming back reads at once. */
const HIDDEN_MS = 30_000
/** Back on the page, a list older than this is read again at once. */
const STALE_MS = 15_000
/** A sheet nothing shows any more is forgotten after this. */
const RELEASE_MS = 1_000
/** Progress while a sync or an analysis is starting, and while one analyses. */
const HOT_MS = 1_000
const WARM_MS = 3_000
/** Explanations are asked for this often while one streams, and not at all otherwise. */
const EXPLAIN_POLL_MS = 400
/** Pull request diffs kept in the browser. */
const KEEP_DIFFS = 8
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** How closely progress needs following: undefined when nothing runs. */
function pace(progress: ReviewProgress | undefined): number | undefined {
  if (progress === undefined) return undefined
  if (progress.sync?.step === 'list' || progress.runs.some((run) => !runEnded(run.step) && run.step !== 'analyzing')) return HOT_MS
  return progress.runs.some((run) => run.step === 'analyzing') ? WARM_MS : undefined
}

/**
 * What changing calls for the list again: the sync's step, and each run starting, analysing or
 * ending (its card's phase, session and counts change then; the steps between change nothing there).
 */
const stages = (progress: ReviewProgress | undefined): string => {
  const coarse = (step: ReviewProgress['runs'][number]['step']): string => (runEnded(step) || step === 'analyzing' ? step : 'starting')
  const runs = (progress?.runs ?? []).map((run) => `${run.key}:${run.startedAt}:${coarse(run.step)}`).sort().join(',')
  return `${progress?.sync?.step ?? ''}@${progress?.sync?.startedAt ?? ''}|${runs}`
}

/** Everything but the host's clock: what changing is worth a render. */
const content = (progress: ReviewProgress | undefined): string => JSON.stringify(progress === undefined ? null : { ...progress, now: 0 })

/** A pull request's explanations while something shows them. */
interface Book {
  listeners: Set<() => void>
  value: Explained | undefined
  error: string | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  release: ReturnType<typeof setTimeout> | undefined
  reading: boolean
  /** Something started while a read was in flight: that answer may predate it, so read again. */
  again: boolean
}

const hidden = (): boolean => document.visibilityState !== 'visible'

const answering = (value: Explained | undefined): boolean => value?.items.some((item) => item.turns.some((turn) => !turn.done)) === true

interface Watch {
  listeners: Set<() => void>
  reply: SheetReply | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  /** Dropping it once nothing has shown it for a moment: a view that resubscribes keeps the sheet it had. */
  release: ReturnType<typeof setTimeout> | undefined
  /** A read is in flight. */
  reading: boolean
  /** Edits in flight: a poll must not show the file from before them. */
  writes: number
  /** Reads in a row that found it unchanged: an idle sheet is asked after less often. */
  idle: number
}

export class ReviewStore {
  private snapshot: ReviewSnapshot = { state: undefined, scope: readScope(), loading: false, error: null, notice: null }
  /** Each scope's last list. */
  private readonly kept = new Map<ReviewScope, ReviewState>()
  private readonly listeners = new Set<() => void>()
  private readonly call: ReviewCall
  private readonly watches = new Map<string, Watch>()
  /** Each sheet's writes still on their way: a preview waits for them, so a field left by Ctrl+Enter is in it. */
  private readonly writing = new Map<string, Promise<unknown>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private reading = 0
  private disposed = false
  private tracker: ReturnType<typeof setTimeout> | undefined
  private tracking = false
  /** Counts states taken: a progress answer asked for before one is stale. */
  private epoch = 0
  /** Pull request diffs by `key|stamp`, least recently used first. */
  private readonly diffs = new Map<string, { promise: Promise<PullDiff>; value?: PullDiff }>()
  private readonly books = new Map<string, Book>()
  private readonly threadLists = new Map<string, PullThread[]>()
  /** The stack's pull requests picked as context for one with no sheet yet: sent with its analysis, which keeps them in the sheet. */
  private readonly contexts = new Map<string, string[]>()
  /** When a list last came from the host. */
  private loadedAt = 0

  constructor(call: ReviewCall) {
    this.call = call
    globalThis.document?.addEventListener?.('visibilitychange', this.back)
  }

  /** The page shows again: what went stale while hidden is read now, not at the next tick. */
  private readonly back = (): void => {
    if (this.disposed || hidden()) return
    if (this.listeners.size > 0) {
      if (Date.now() - this.loadedAt > STALE_MS) void this.load()
      else if (pace(this.snapshot.progress) !== undefined) this.track(true)
    }
    for (const [path, watch] of this.watches) {
      watch.idle = 0
      if (!watch.reading) void this.read(path)
    }
    for (const [key, book] of this.books) {
      if (book.listeners.size > 0 && !book.reading) void this.readBook(key)
    }
  }

  /** Something runs: sheets shown are followed closely again. */
  private hurry(): void {
    for (const [path, watch] of this.watches) {
      if (watch.idle === 0 || watch.reading) continue
      watch.idle = 0
      clearTimeout(watch.timer)
      watch.timer = setTimeout(() => void this.read(path), SHEET_POLL_MS)
    }
  }

  getSnapshot = (): ReviewSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.poll()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        clearTimeout(this.timer)
        clearTimeout(this.tracker)
        this.tracker = undefined
      }
    }
  }

  private publish(patch: Partial<ReviewSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private get scope(): ReviewScope {
    return this.snapshot.scope ?? 'mine'
  }

  /** A state from the host: its progress too, and progress followed from there. A list of the other scope is only kept. */
  private take(state: ReviewState, patch: Partial<ReviewSnapshot> = {}): void {
    this.epoch++
    this.kept.set(scopeOfState(state), state)
    const progress = state.progress
    const current = this.snapshot.state
    const shown = scopeOfState(state) === this.scope ? state
      // The progress and counts are the host's now whichever list it answered with.
      : current === undefined ? undefined : { ...current, ...(state.counts === undefined ? {} : { counts: state.counts }), syncing: state.syncing }
    this.loadedAt = Date.now()
    this.publish({ ...(shown === undefined ? {} : { state: shown }), ...patch, ...(progress === undefined ? {} : { progress, skew: Date.now() - progress.now }) })
    if (pace(progress) !== undefined) this.hurry()
    this.track()
  }

  /**
   * Show another list: the one kept from before at once (or the current one emptied, marked as
   * loading, so the lane stays), then the host's.
   */
  setScope(scope: ReviewScope): void {
    if (scope === this.scope) return
    try {
      globalThis.localStorage?.setItem(SCOPE_KEY, scope)
    } catch {
      // Not remembered.
    }
    const current = this.snapshot.state
    const kept = this.kept.get(scope)
    const state = kept ?? (current === undefined ? undefined : { ...current, scope, items: [], syncedAt: undefined, error: undefined } as ReviewState)
    this.publish({ scope, ...(state === undefined ? {} : { state }) })
    void this.load()
  }

  /** Follow progress at the pace what runs needs; `soon` asks at once (an action just started something). */
  private track(soon = false): void {
    if (this.disposed || this.listeners.size === 0 || this.tracking) return
    const delay = soon ? 0 : pace(this.snapshot.progress)
    clearTimeout(this.tracker)
    this.tracker = delay === undefined ? undefined : setTimeout(() => void this.follow(), delay)
  }

  private async follow(): Promise<void> {
    this.tracker = undefined
    if (this.disposed || this.tracking) return
    if (hidden()) {
      // Hidden: look again later, slowly, without asking the host; coming back asks at once.
      this.tracker = setTimeout(() => void this.follow(), HIDDEN_MS)
      return
    }
    this.tracking = true
    const epoch = this.epoch
    try {
      const progress = await this.request<ReviewProgress>({ op: 'progress' })
      // A state that came back meanwhile is newer than this answer.
      const before = this.snapshot.progress
      if (epoch === this.epoch && content(progress) !== content(before)) {
        this.publish({ progress, skew: Date.now() - progress.now })
        if (pace(progress) !== undefined) this.hurry()
        // A run reached a new stage: the cards' phases and counts follow from the list.
        if (stages(progress) !== stages(before)) void this.load()
      }
    } catch {
      // The next look tries again; the list's own poll reports a host that is gone.
    } finally {
      this.tracking = false
    }
    this.track()
  }

  private async request<T>(payload: ReviewRequest): Promise<T> {
    if (this.disposed) throw new Error('review is disposed')
    const reply = await this.call(payload)
    if (!reply.ok) throw new Error(reply.error)
    return reply.value as T
  }

  dismiss(): void {
    this.publish({ notice: null })
  }

  private fail(error: unknown): void {
    this.publish({ notice: message(error) })
  }

  /** The list; `fresh` waits for GitHub instead of the host's short cache. */
  async load(fresh = false): Promise<void> {
    if (this.disposed) return
    clearTimeout(this.timer)
    const ticket = ++this.reading
    this.publish({ loading: true })
    try {
      const state = await this.request<ReviewState>({ op: 'state', scope: this.scope, ...(fresh ? { fresh } : {}) })
      if (ticket === this.reading) this.take(state, { loading: false, error: null })
      else this.kept.set(scopeOfState(state), state)
    } catch (error) {
      if (ticket === this.reading) this.publish({ loading: false, error: message(error) })
    }
    this.poll()
  }

  private poll(delay = POLL_MS): void {
    clearTimeout(this.timer)
    if (this.disposed || this.listeners.size === 0) return
    // While analyses run, follow them more closely.
    const busy = this.snapshot.state?.items.some((item) => item.queued === true || item.running === true) === true
    this.timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void this.load()
      else this.poll()
    }, busy ? Math.min(delay, 10_000) : delay)
  }

  /** Read GitHub now, starting nothing; its progress shows while it reads. */
  async sync(): Promise<void> {
    const progress = this.snapshot.progress
    const at = Date.now() - (this.snapshot.skew ?? 0)
    this.publish({
      loading: true, notice: null,
      ...(this.snapshot.state === undefined ? {} : { state: { ...this.snapshot.state, syncing: true } }),
      // Shown at once; the host's own replaces it at the first answer.
      progress: { now: at, runs: progress?.runs ?? [], sync: { manual: true, step: 'list', startedAt: at } },
    })
    this.track(true)
    try {
      const state = await this.request<ReviewState>({ op: 'sync', scope: this.scope })
      ++this.reading
      this.take(state, { loading: false, error: null })
    } catch (error) {
      this.publish({ loading: false })
      this.fail(error)
      this.track(true)
    }
    this.poll()
  }

  /** Queue every pull request not analysed at its current head. */
  analyzeAll(): Promise<void> {
    return this.act({ op: 'analyzeAll', scope: this.scope })
  }

  /**
   * Analyse one pull request again; choosing a bot always starts a new session for that bot. One of
   * mine is answered; `tree` says where when no tree is on its branch yet.
   */
  analyze(key: string, fresh = false, bot?: string, tree?: TreeChoice): Promise<void> {
    const context = this.contexts.get(key)
    this.contexts.delete(key)
    return this.act({
      op: 'analyze', key, scope: this.scope, ...(fresh ? { fresh } : {}), ...(bot === undefined ? {} : { bot }), ...(tree === undefined ? {} : { tree }),
      ...(context === undefined ? {} : { context }),
    })
  }

  /** The stack's pull requests picked as context for one not analysed yet. */
  contextOf(key: string): string[] {
    return this.contexts.get(key) ?? []
  }

  /** Pick the stack's pull requests to read as context: kept in the sheet, or until the analysis that writes one. */
  setContext(item: { key: string; path: string; phase: string }, keys: string[]): void {
    if (item.phase !== 'new') {
      void this.patch(item.path, [{ op: 'context', keys }])
      return
    }
    this.contexts.set(item.key, keys)
    this.publish({})
  }

  /** Where one of my pull requests' branch is worked on, or could be. */
  places(key: string): Promise<TreePlaces> {
    return this.request<TreePlaces>({ op: 'places', key })
  }

  /** Caught up with what followed my submitted review: only what comes later is news. */
  seen(key: string): Promise<void> {
    return this.act({ op: 'seen', key, scope: this.scope })
  }

  /** Stop a pull request's analysis: out of the queue, or its session's turn stopped. */
  cancel(key: string): Promise<void> {
    return this.act({ op: 'cancel', key, scope: this.scope })
  }

  /** Stop every analysis queued, starting or running. */
  cancelAll(): Promise<void> {
    return this.act({ op: 'cancelAll', scope: this.scope })
  }

  private async act(payload: ReviewRequest): Promise<void> {
    this.publish({ notice: null })
    try {
      const state = await this.request<ReviewState>(payload)
      ++this.reading
      this.take(state)
    } catch (error) {
      this.fail(error)
    }
    this.poll()
  }

  // ── Sheets ──────────────────────────────────────────────────────────────

  sheet(path: string): SheetReply | undefined {
    return this.watches.get(path)?.reply
  }

  /** Follow a sheet while something shows it. */
  watch(path: string, listener: () => void): () => void {
    let watch = this.watches.get(path)
    if (watch === undefined) {
      watch = { listeners: new Set(), reply: undefined, timer: undefined, release: undefined, reading: false, writes: 0, idle: 0 }
      this.watches.set(path, watch)
    }
    clearTimeout(watch.release)
    watch.release = undefined
    watch.listeners.add(listener)
    // A first look, unless a read is already scheduled or in flight for a view that just resubscribed.
    if (watch.listeners.size === 1 && watch.timer === undefined && !watch.reading) void this.read(path)
    return () => {
      const current = this.watches.get(path)
      if (current === undefined) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      clearTimeout(current.release)
      current.release = setTimeout(() => {
        if (this.watches.get(path) !== current || current.listeners.size > 0) return
        clearTimeout(current.timer)
        this.watches.delete(path)
      }, RELEASE_MS)
    }
  }

  private show(path: string, reply: SheetReply): void {
    const watch = this.watches.get(path)
    if (watch === undefined) return
    watch.reply = reply
    for (const listener of watch.listeners) listener()
  }

  private async read(path: string): Promise<void> {
    const watch = this.watches.get(path)
    if (watch === undefined || watch.reading || this.disposed) return
    clearTimeout(watch.timer)
    watch.reading = true
    try {
      if (!hidden() && watch.writes === 0) {
        const since = watch.reply?.version
        const reply = await this.request<SheetReply>({ op: 'sheet', path, ...(since === undefined || since === '' ? {} : { since }) })
        if (reply.unchanged === true) watch.idle++
        else watch.idle = 0
        if (watch.writes === 0 && reply.unchanged !== true) this.show(path, reply)
      }
    } catch (error) {
      if (watch.reply === undefined) this.show(path, { version: '', error: message(error) })
    } finally {
      watch.reading = false
      if (this.watches.get(path) === watch) watch.timer = setTimeout(() => void this.read(path), this.sheetPace(watch))
    }
  }

  /** While a session writes the sheet (or anything runs), every moment; otherwise less often the longer it stays the same. */
  private sheetPace(watch: Watch): number {
    if (hidden()) return HIDDEN_MS
    const status = watch.reply?.sheet?.status
    if (status === 'analyzing' || status === 'fixing' || pace(this.snapshot.progress) !== undefined) return SHEET_POLL_MS
    return Math.min(SHEET_POLL_MS * 2 ** Math.min(watch.idle, 4), SHEET_IDLE_MS)
  }

  /** Read a sheet now, ignoring the version it was last seen at. */
  async reload(path: string): Promise<void> {
    const watch = this.watches.get(path)
    if (watch === undefined) return
    try {
      this.show(path, await this.request<SheetReply>({ op: 'sheet', path }))
    } catch (error) {
      this.fail(error)
    }
  }

  /** A host call that rewrites the sheet: its answer is the file as written. */
  private async write(path: string, payload: ReviewRequest, optimistic?: (sheet: Sheet) => Sheet): Promise<boolean> {
    const watch = this.watches.get(path)
    const before = watch?.reply
    if (watch !== undefined) watch.writes++
    if (optimistic !== undefined && before?.sheet !== undefined) {
      try {
        this.show(path, { ...before, sheet: optimistic(before.sheet) })
      } catch {
        // The host will refuse it too.
      }
    }
    try {
      const pending = this.request<SheetReply>(payload)
      const all = Promise.allSettled([this.writing.get(path), pending])
      this.writing.set(path, all)
      void all.then(() => { if (this.writing.get(path) === all) this.writing.delete(path) })
      const reply = await pending
      if (watch !== undefined) {
        watch.writes--
        watch.idle = 0
      }
      this.show(path, { ...(this.sheet(path) ?? {}), ...reply })
      return true
    } catch (error) {
      if (watch !== undefined) watch.writes--
      if (before !== undefined) this.show(path, before)
      this.fail(error)
      void this.reload(path)
      return false
    }
  }

  patch(path: string, ops: SheetOp[]): Promise<boolean> {
    return this.write(path, { op: 'patch', path, ops }, (sheet) => applyOps(sheet, ops))
  }

  /** A comment of mine on lines of the diff; `key` opens the sheet when there is none. Fails out loud, for the composer to say. */
  async comment(path: string, key: string, op: Extract<SheetOp, { op: 'add' }>): Promise<void> {
    const opened = this.sheet(path)?.sheet === undefined
    const watch = this.watches.get(path)
    if (watch !== undefined) watch.writes++
    try {
      const reply = await this.request<SheetReply>({ op: 'patch', path, ops: [op], key })
      const { error: _missing, ...before } = this.sheet(path) ?? { version: '' }
      this.show(path, { ...before, ...reply })
    } finally {
      if (watch !== undefined) watch.writes--
    }
    // A sheet just opened moves its card on: the list is read again.
    if (opened) void this.load()
  }

  /** A comment of mine as a bot makes it: only the text comes back. `thread`: a reply on that review thread. */
  compose(key: string, bot: string, text: string, target?: ExplainTarget, thread?: string): Promise<string> {
    return this.request<string>({ op: 'compose', key, bot, text, ...(target === undefined ? {} : { target }), ...(thread === undefined ? {} : { thread }) })
  }

  /** Someone else's pull request: what others said outside the review threads since my review. */
  remarks(key: string): Promise<PullRemark[]> {
    return this.request<PullRemark[]>({ op: 'remarks', key })
  }

  /** A pull request's review threads, for its diff and what followed my review; `fresh` reads GitHub again. */
  async threads(key: string, fresh = false): Promise<PullThread[]> {
    const list = await this.request<PullThread[]>({ op: 'threads', key, ...(fresh ? { fresh } : {}) })
    this.threadLists.set(key, list)
    return list
  }

  /** The threads when they are already here: shown in the first render. */
  threadsNow(key: string): PullThread[] | undefined {
    return this.threadLists.get(key)
  }

  /** Reply on a review thread, posted now; the lane is read again, as what waits on me changed. */
  async reply(key: string, thread: string, body: string): Promise<PullThread[]> {
    const list = await this.request<PullThread[]>({ op: 'reply', key, thread, body })
    this.threadLists.set(key, list)
    void this.load()
    return list
  }

  /** Where my own pull request stands on merging. */
  mergeState(key: string): Promise<MergeState> {
    return this.request<MergeState>({ op: 'mergeState', key })
  }

  /**
   * Merge my own pull request now, or (`auto`) once its requirements are met. The lane is not read
   * again here: a merged card would leave it, and its detail with it, before the outcome is seen.
   */
  merge(key: string, method: MergeMethod, auto: boolean, head?: string): Promise<MergeState> {
    return this.request<MergeState>({ op: 'merge', key, method, ...(auto ? { auto } : {}), ...(head === undefined ? {} : { head }) })
  }

  cancelAutoMerge(key: string): Promise<MergeState> {
    return this.request<MergeState>({ op: 'cancelAutoMerge', key })
  }

  setDraft(key: string, draft: boolean): Promise<MergeState> {
    return this.request<MergeState>({ op: 'draft', key, draft })
  }

  ask(path: string, id: string, question: string): Promise<boolean> {
    return this.write(path, { op: 'ask', path, id, question })
  }

  rewrite(path: string, id: string, hint?: string): Promise<boolean> {
    return this.write(path, { op: 'rewrite', path, id, ...(hint === undefined || hint.trim() === '' ? {} : { hint }) })
  }

  async tell(path: string, text: string): Promise<boolean> {
    try {
      await this.request({ op: 'tell', path, text })
      return true
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async preview(path: string): Promise<ReviewPreview | ResponsePreview> {
    await this.writing.get(path)
    return this.request<ReviewPreview | ResponsePreview>({ op: 'preview', path })
  }

  /** A response sheet's code changes: its session fixes what it picked; progress follows. */
  async fix(path: string): Promise<boolean> {
    const done = await this.write(path, { op: 'fix', path }, (sheet) => ({ ...sheet, status: 'fixing' }))
    if (done) {
      this.track(true)
      void this.load()
    }
    return done
  }

  async submit(path: string): Promise<SubmitResult> {
    const result = await this.request<SubmitResult>({ op: 'submit', path })
    if (result.posted !== undefined) {
      void this.reload(path)
      void this.load()
    }
    return result
  }

  // ── Diffs and explanations ─────────────────────────────────────────────

  /**
   * A pull request's diff; `stamp` names its version as the card knows it (head, round), so a new
   * round reads again. Asked for once and kept: its commits never change.
   */
  diff(key: string, stamp: string): Promise<PullDiff> {
    const id = `${key}|${stamp}`
    let hit = this.diffs.get(id)
    if (hit === undefined) {
      const entry: { promise: Promise<PullDiff>; value?: PullDiff } = { promise: this.request<PullDiff>({ op: 'diff', key }) }
      entry.promise.then((value) => { entry.value = value }, () => { if (this.diffs.get(id) === entry) this.diffs.delete(id) })
      hit = entry
    } else this.diffs.delete(id)
    this.diffs.set(id, hit)
    while (this.diffs.size > KEEP_DIFFS) this.diffs.delete(this.diffs.keys().next().value!)
    return hit.promise
  }

  /** The diff when it is already here: shown in the first render, without a flash of loading. */
  diffNow(key: string, stamp: string): PullDiff | undefined {
    return this.diffs.get(`${key}|${stamp}`)?.value
  }

  /** One file held back from the diff (generated, or too big), read alone. */
  async file(key: string, path: string): Promise<PullFile> {
    const pull = await this.request<PullDiff>({ op: 'diff', key, file: path })
    const file = pull.files[0]
    if (file === undefined) throw new Error(`${path} is not changed in this pull request`)
    return file
  }

  /** A pull request's explanations as last read; undefined until the first read lands. */
  explained(key: string): Explained | undefined {
    return this.books.get(key)?.value
  }

  /** Follow a pull request's explanations while something shows them: read once, then closely while one streams. */
  watchExplained(key: string, listener: () => void): () => void {
    let book = this.books.get(key)
    if (book === undefined) {
      book = { listeners: new Set(), value: undefined, error: undefined, timer: undefined, release: undefined, reading: false, again: false }
      this.books.set(key, book)
    }
    clearTimeout(book.release)
    book.release = undefined
    book.listeners.add(listener)
    if (book.listeners.size === 1 && book.timer === undefined && !book.reading) void this.readBook(key)
    return () => {
      const current = this.books.get(key)
      if (current === undefined) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      clearTimeout(current.timer)
      current.timer = undefined
      clearTimeout(current.release)
      current.release = setTimeout(() => {
        if (this.books.get(key) !== current || current.listeners.size > 0) return
        clearTimeout(current.timer)
        this.books.delete(key)
      }, RELEASE_MS)
    }
  }

  private showBook(key: string, patch: Partial<Pick<Book, 'value' | 'error'>>): void {
    const book = this.books.get(key)
    if (book === undefined) return
    Object.assign(book, patch)
    for (const listener of book.listeners) listener()
  }

  private async readBook(key: string): Promise<void> {
    const book = this.books.get(key)
    if (book === undefined || book.reading || this.disposed) return
    clearTimeout(book.timer)
    book.timer = undefined
    if (hidden() || book.listeners.size === 0) return
    book.reading = true
    book.again = false
    try {
      const since = book.value?.version
      const value = await this.request<Explained>({ op: 'explained', key, ...(since === undefined ? {} : { since }) })
      if (value.unchanged !== true) this.showBook(key, { value, error: undefined })
    } catch (error) {
      if (book.value === undefined) this.showBook(key, { error: message(error) })
    } finally {
      book.reading = false
      if (!this.disposed && !hidden() && book.listeners.size > 0 && this.books.get(key) === book && (book.again || answering(book.value))) book.timer = setTimeout(() => void this.readBook(key), EXPLAIN_POLL_MS)
    }
  }

  /** An entry the host just answered with: shown at once, then followed. */
  private takeEntry(key: string, entry: Explanation): void {
    const book = this.books.get(key)
    if (book === undefined) return
    const items = book.value?.items ?? []
    const index = items.findIndex((item) => item.id === entry.id)
    const next = index < 0 ? [...items, entry] : items.map((item, at) => (at === index ? entry : item))
    // No version: the next read brings the whole state.
    this.showBook(key, { value: { head: book.value?.head ?? '', version: '', items: next } })
    if (book.reading) book.again = true
    else {
      clearTimeout(book.timer)
      book.timer = setTimeout(() => void this.readBook(key), EXPLAIN_POLL_MS)
    }
  }

  /** Explain part of a diff; the entry comes back at once and its answer streams in. */
  async explain(key: string, target: ExplainTarget, lang: ExplainLang): Promise<Explanation> {
    const entry = await this.request<Explanation>({ op: 'explain', key, target, lang })
    this.takeEntry(key, entry)
    return entry
  }

  /** A follow-up question on an explanation. */
  async followUp(key: string, id: string, question: string, lang: ExplainLang): Promise<Explanation> {
    const entry = await this.request<Explanation>({ op: 'explain', key, id, question, lang })
    this.takeEntry(key, entry)
    return entry
  }

  dispose(): void {
    this.disposed = true
    globalThis.document?.removeEventListener?.('visibilitychange', this.back)
    clearTimeout(this.timer)
    clearTimeout(this.tracker)
    for (const watch of this.watches.values()) {
      clearTimeout(watch.timer)
      clearTimeout(watch.release)
    }
    this.watches.clear()
    for (const book of this.books.values()) {
      clearTimeout(book.timer)
      clearTimeout(book.release)
    }
    this.books.clear()
    this.diffs.clear()
    this.listeners.clear()
  }
}
