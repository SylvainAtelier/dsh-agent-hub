/**
 * The review module's host half. Everything deterministic happens here, without a model:
 *
 * - Sync: one GitHub search lists the pull requests waiting for my review across every
 *   repository; each is matched to a repository set for review by its GitHub remote. The board
 *   reads the list at most every few minutes (stale while it refreshes); the sync button reads it
 *   now and starts nothing; the daily run also starts analyses of what is new or has new commits.
 *   A pull request I analysed though nobody asked me joins the list while it is open (its sheet
 *   says I chose it; one lookup by number says it is open), never analysed in a batch.
 * - Analyse all: the board's button queues every pull request not analysed at its current head.
 * - Analysis: the pull request is fetched to `refs/reviews/pr-<n>` (no working tree, no branch),
 *   a session opens in the repository's main tree on the review bot, its sheet is written with
 *   the facts, and its first message sent. At most two run at once; the rest queue.
 * - The sheet (`<repo>/.reviews/pr-<n>.md`) is the state. The UI's edits apply to the file as it
 *   is now, one write at a time per file; the agent edits it with its own tools.
 * - Questions and rewrites go to a small helper model, beside the session, never into it.
 * - Posting: a preview first; then one `POST …/reviews` with the head the analysis read. A review
 *   I already posted with the same body is recognized, so a retry never posts twice.
 * - Stacks: a pull request based on another's branch sits above it. The listed ones' neighbours are
 *   looked up round by round (the `all` list has them already), and those not listed come along as
 *   `related`, to be shown in their stacks and asked for like any other. An analysis reads the
 *   stack's pull requests I picked (`context` in the sheet) beside its own, fetched to their refs.
 *
 * My own pull requests (the lane's 我的, read only once asked for, never analysed in a batch): a
 * response session opens in the working tree on the branch (the one already there, else one I
 * pick or a new worktree), the branch caught up with the remote when that is a fast-forward. It
 * triages the comments waiting on me into the response sheet, then does what I ask in it, with no
 * guard beyond every session's; `fix` sends it the picked items, and the turn's end marks the sheet fixed. Posting
 * pushes the new commits, replies on each picked thread, resolves the fixed ones and leaves one
 * conversation comment for the rest; replies already there are recognized, so a retry is safe.
 * Merging it happens from its detail: now against the head I saw, or by auto-merge once its
 * requirements are met; the list is read again after, so a merged one leaves the lane.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseCommitFiles } from '../git/parse.ts'
import { pathKey, runGit, type Runner } from '../git/service.ts'
import { replyText, type Llm } from '../git/message.ts'
import { cached, type Cached as Cache } from '../cached.ts'
import { localized } from '../locale.ts'
import { atomicWriteText as writeText } from '../persistence.ts'
import type { RepoGroup } from '../repos/types.ts'
import { personaText, type AgentProfile } from '../team/profiles.ts'
import { BOT_ROUTE } from '../team/types.ts'
import type { Worktree, WorktreeOpened } from '../git/types.ts'
import { buildResponse, defaultResponse, fixMessage, ownPhase, replyPrompt, respondMessage, respondSection, threadReplyPrompt, waiting } from './author.ts'
import { commentableLines, GhError, GitHub, repoSlug, type Conversation, type OwnPull, type Pull, type PullActivity, type PullState } from './github.ts'
import { askPrompt, composePrompt, defaultAnalysis, explainPrompt, firstMessage, followSection, reviewSection, rewritePrompt, stackSection, type StackPull } from './prompt.ts'
import { applyOps, blankSheet, parseSheet, serializeSheet } from './sheet.ts'
import { buildReview, reviewPayload, sameCommit } from './submit.ts'
import { scheduledReport, type ScheduledReport } from './report.ts'
import {
  anchorOf, isMine, REVIEW_DIR, reviewRank, reviewRef, runEnded, scopeOf, SHEET_PATH, sheetName, stacksOf, stalled, standOf, unanalysed,
  type Explained, type FollowUp, type PullRemark, type ExplainLang, type ExplainTarget, type Explanation, type MergeMethod, type MergeState, type PullDiff, type PullFile, type PullThread, type ResponsePosted, type ResponsePreview, type ReviewItem, type ReviewPhase, type ReviewPreview, type ReviewProgress, type ReviewReply, type ReviewRequest, type ReviewRun, type ReviewState,
  type ReviewScope, type RunInfo, type RunStep, type Sheet, type SheetReply, type SyncRun, type TreeChoice, type TreePlaces,
} from './types.ts'

export interface ReviewSettings {
  /** Main working trees whose pull requests are reviewed; empty turns the module off. */
  repos: readonly string[]
  /** Whether the daily sync runs by itself; off, only a manual sync reads GitHub. */
  auto?: boolean
  /** HH:MM, local time: the daily sync. */
  at: string
  /** The bot whose model and persona review. */
  bot: string
  /** The bot a comment of mine is processed by unless another is picked; blank: none. */
  commentBot?: string
  helperProvider?: string
  helperModel?: string
  style: string
  rules?: string
  /** How the helper model explains a change; blank: the built-in parts. */
  explain?: string
  /** The bot that explains a change and answers follow-ups; blank: the helper model. */
  explainBot?: string
  maxPerRun: number
  /** Days a submitted review stays on the board once its pull request is merged or closed; 0: it leaves at once. */
  keepMerged?: number
}

export interface Route {
  provider: string
  model: string
}

/** DSH's sessions, as far as reviews use them. */
export interface SessionHost {
  /** A new session in a workspace (or a folder outside any), on a model when given, titled. */
  start(input: { cwd: string; workspaceId?: string; title: string; route?: Route }): Promise<string>
  /** A user message into a session; the same `requestId` is sent once. */
  send(sessionId: string, text: string, requestId: string): Promise<void>
  /** Stop the session's turn in flight. */
  cancel(sessionId: string): Promise<void>
  archive(sessionId: string): Promise<void>
}


export interface ReviewHost {
  settings(): ReviewSettings
  repos(): Promise<RepoGroup[]>
  sessions(): SessionHost | undefined
  bots(): readonly AgentProfile[]
  /** The model for questions and rewrites: never Claude Agent (it answers conversation turns only). */
  helper(): Promise<Route | undefined>
  /** Where a bot answers one request outside a session: its own model, or the helper when that only answers conversations. */
  botRoute?(bot: AgentProfile): Promise<Route | undefined>
  llm(): Llm | undefined
  /** A repository's working trees as DSH workspaces: listed, a new one on a branch, an existing one opened (registered if it was not). */
  trees?: {
    list(cwd: string): Promise<Worktree[]>
    add(cwd: string, branch: string): Promise<WorktreeOpened>
    open(cwd: string, path: string): Promise<WorktreeOpened>
  }
  /** Legacy constructor compatibility; native automation owns scheduling persistence now. */
  stateFile?: string
  log(message: string): void
  github?: GitHub
  git?: Runner
  now?: () => number
}

/** The board reads GitHub again after this. */
const LIST_TTL_MS = 5 * 60_000
/** Submitted reviews stay on the board this long while their pull request is open. */
const KEEP_SUBMITTED_MS = 14 * 24 * 3600_000
/** Days a submitted review stays once its pull request is merged or closed, unless set. */
const KEEP_MERGED_DAYS = 5
const DAY_MS = 24 * 3600_000
/**
 * Asked of me again after I submitted: GitHub's list still has it, and it changed this long after
 * the review (my review itself touches it; the search index may lag behind the review just sent).
 */
const REREQUEST_GRACE_MS = 2 * 60_000
/** Analyses running at once: each is a model session, a Claude Code process on Claude Agent. */
const MAX_ACTIVE = 2
/** The `locked` key every `git fetch` waits its turn on. */
const FETCH_LOCK = '\0git-fetch'
/** An analysis that never reported back frees its slot after this. */
const SLOT_MS = 45 * 60_000
const SLUG_TTL_MS = 10 * 60_000
/** An ended run stays on the board this long. */
const KEEP_RUN_MS = 15 * 60_000
/** The helper waits for this batch, never indefinitely for a slow review session. */
const REPORT_WAIT_MS = 20 * 60_000
const REF = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/

/** Lock files, minified bundles, source maps, snapshots: noise to a reader, read only when asked for. */
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|flake\.lock|Podfile\.lock|packages\.lock\.json)$|\.(min\.(js|css)|map|snap)$/i
/** A file changing more lines than this is read alone, when asked for. */
const LARGE_LINES = 3000
/** The whole diff, read at once, is cut here; the files past the cut are read alone. */
const DIFF_BYTES = 4 << 20
const FILE_BYTES = 8 << 20
/** Pull request diffs kept in memory (their commits never change). */
const KEEP_DIFFS = 8
/** What one explanation sends of its diff. */
const EXPLAIN_DIFF_CHARS = 40_000
const EXPLAIN_KINDS: ReadonlyArray<ExplainTarget['kind']> = ['hunk', 'lines', 'file']

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** A starting analysis gave up, asked to stop. */
class Stopped extends Error {
  constructor() {
    super('The analysis was stopped')
  }
}

/**
 * A unified diff cut into its files' parts, in order: `git diff` writes its files in the order
 * `--name-status` lists them. `cut` (output hit the cap): the last part may be partial, so it and
 * the files after it are left out.
 */
export function splitPatches(text: string, count: number, cut: boolean): string[] {
  const parts: string[] = []
  const starts: number[] = []
  const pattern = /^diff --git /gm
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) starts.push(match.index)
  starts.forEach((start, index) => parts.push(text.slice(start, starts[index + 1] ?? text.length)))
  if (cut) parts.pop()
  return parts.slice(0, count)
}

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'await', 'async', 'new', 'typeof', 'this', 'super', 'self'])

/** Names a diff declares or redefines, the ones whose uses tell how the change takes effect. */
export function symbolsOf(diff: string, limit = 4): string[] {
  const out: string[] = []
  const add = (name: string | undefined): void => {
    if (name === undefined || name.length < 3 || NOT_NAMES.has(name) || out.includes(name)) return
    out.push(name)
  }
  for (const line of diff.split('\n')) {
    if (!/^[+-](?![+-]{2})/.test(line)) continue
    const body = line.slice(1)
    for (const match of body.matchAll(/\b(?:function|class|def|func|fn|interface|type|enum|struct|trait|const|let|var|val)\s+\*?\s*([A-Za-z_$][\w$]*)/g)) add(match[1])
    add(/^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>)/.exec(body)?.[1])
    add(/^\s*(?:(?:export|public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]*)?\{\s*$/.exec(body)?.[1])
  }
  return out.slice(0, limit)
}

/** An explanation as kept on the host: the diff it explains, and its prompt once built. */
interface Entry extends Explanation {
  diff: string
  prompt?: { system: string; user: string }
}

/** One pull request's explanations, at one head. */
interface Book {
  key: string
  repo: string
  number: number
  head: string
  base: string
  version: number
  items: Map<string, Entry>
}
/** A tree choice from the browser, or undefined for anything else. */
function treeChoice(value: unknown): TreeChoice | undefined {
  const choice = value as { kind?: unknown; path?: unknown } | undefined
  if (choice?.kind === 'new') return { kind: 'new' }
  return choice?.kind === 'path' && typeof choice.path === 'string' && choice.path !== '' ? { kind: 'path', path: choice.path } : undefined
}

const mergeMethodOf = (value: unknown): MergeMethod => {
  if (value === 'SQUASH' || value === 'MERGE' || value === 'REBASE') return value
  throw new Error('unknown merge method')
}

const parsePr = (pr: string): { slug: string; number: number } => {
  const at = pr.lastIndexOf('#')
  return { slug: pr.slice(0, at), number: Number(pr.slice(at + 1)) }
}

/** Where a card stands, from GitHub's head and the sheet. A submitted one stays so: what came after it is its {@link followOf}. */
export function phaseOf(sheet: Sheet | undefined, error: string | undefined, remoteHead: string | undefined): ReviewPhase {
  if (error !== undefined) return 'invalid'
  if (sheet === undefined) return 'new'
  if (sheet.status === 'submitted') return 'submitted'
  if (remoteHead !== undefined && remoteHead !== '' && !sameCommit(remoteHead, sheet.head)) return 'stale'
  return sheet.status === 'analyzing' ? 'analyzing' : 'ready'
}

/**
 * What followed a review I submitted, `head` being the pull request's now: commits past the head I
 * last saw, comments by anyone but me since I last caught up (or since it was sent), and where the
 * threads I started stand. Undefined while nothing can be told; without `activity` (or knowing who
 * I am), only the commits.
 */
export function followOf(sheet: Sheet, head: string, activity: PullActivity | undefined, viewer: string): FollowUp | undefined {
  if (sheet.status !== 'submitted' || sheet.role === 'author') return undefined
  const seen = sheet.seen ?? sheet.head
  const since = Math.max(Date.parse(sheet.submitted ?? '') || 0, Date.parse(sheet.read ?? '') || 0)
  let commits = 0
  if (head !== '' && !sameCommit(head, seen)) {
    const list = activity?.commits ?? []
    const at = list.findIndex((commit) => sameCommit(commit.oid, seen))
    // Rebased, or further back than the list reaches: those committed since, and at least the push itself.
    commits = Math.max(1, at >= 0 ? list.length - 1 - at : list.filter((commit) => commit.at > since).length)
  }
  const mine = { replied: 0, resolved: 0, outdated: 0, open: 0 }
  const me = viewer.toLowerCase()
  if (activity === undefined || me === '') return commits > 0 ? { commits, comments: 0, authors: [], mine } : undefined
  const others = (author: string): boolean => author.toLowerCase() !== me
  const authors: string[] = []
  let comments = 0
  const note = (author: string, at: number): void => {
    if (at <= since || !others(author)) return
    comments++
    if (author !== '' && !authors.includes(author)) authors.push(author)
  }
  for (const thread of activity.threads) {
    for (const comment of thread.comments) note(comment.author, comment.at)
    if (others(thread.root)) continue
    const last = thread.comments.at(-1)
    mine[standOf({ resolved: thread.resolved, outdated: thread.outdated, replied: last !== undefined && others(last.author) })]++
  }
  // A review with no summary of its own is its thread comments, counted there; a bare verdict still counts.
  for (const remark of activity.remarks) {
    if (remark.kind === 'comment' || !remark.empty || remark.state === 'APPROVED' || remark.state === 'CHANGES_REQUESTED') note(remark.author, remark.at)
  }
  return { commits, comments, authors, mine }
}

/**
 * A pull request's review threads as the diff draws them, and what others said outside them. Mine:
 * every thread waits on me when its last word is not mine. Someone else's: those I started are
 * marked and only they wait on me; each sits on the lines of the head the diff shows (where it is
 * now when that is the head, else where it was left when that was), or on none; the remarks are
 * those since my review was submitted.
 */
export function talkOf(conversation: Conversation, item: Pick<ReviewItem, 'own' | 'head'>, sheet: Sheet | undefined): Talk {
  const me = conversation.viewer.toLowerCase()
  const own = item.own === true
  const shown = sheet?.head || item.head
  const threads = conversation.threads.map((thread): PullThread => {
    const mine = !own && me !== '' && thread.comments[0]?.author.toLowerCase() === me
    const place = own || sameCommit(item.head, shown) ? { line: thread.line, start: thread.start }
      : thread.original !== undefined && sameCommit(thread.original.commit, shown) ? { line: thread.original.line, start: thread.original.start }
      : {}
    return {
      id: thread.id, path: thread.path,
      ...(place.line === undefined ? {} : { line: place.line }), ...(place.start === undefined ? {} : { start: place.start }),
      resolved: thread.resolved, outdated: thread.outdated,
      waiting: (own || mine) && !thread.resolved && (thread.comments.at(-1)?.author.toLowerCase() ?? me) !== me,
      ...(mine ? { mine: true } : {}),
      comments: thread.comments.map((comment) => ({ id: comment.id, author: comment.author, body: comment.body, at: comment.at, ...(comment.url === undefined ? {} : { url: comment.url }) })),
    }
  })
  const since = Date.parse(sheet?.submitted ?? '')
  if (own || sheet?.status !== 'submitted' || Number.isNaN(since)) return { threads, remarks: [] }
  const remarks: PullRemark[] = [
    ...conversation.reviews.filter((review) => review.body.trim() !== '').map((review) => ({ ...remarkOf(review), state: review.state })),
    ...conversation.comments.map(remarkOf),
  ].filter((remark) => remark.author.toLowerCase() !== me && Date.parse(remark.at) > since)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return { threads, remarks }
}

const remarkOf = (remark: { author: string; body: string; at: string; url?: string }): PullRemark =>
  ({ author: remark.author, body: remark.body, at: remark.at, ...(remark.url === undefined ? {} : { url: remark.url }) })

/** The next time HH:MM comes round after `now`, local time; undefined for a malformed time. */
export function nextRun(at: string, now: number): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  const date = new Date(now)
  date.setHours(hours, minutes, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** The last time HH:MM came round at or before `now`. */
export function lastRun(at: string, now: number): number | undefined {
  const next = nextRun(at, now)
  if (next === undefined) return undefined
  const date = new Date(next)
  date.setDate(date.getDate() - 1)
  return date.getTime()
}

interface Cached {
  version: string
  sheet?: Sheet
  error?: string
  /** The session, read even from a sheet that cannot be parsed, so it can be asked to fix it. */
  session?: string
}

/** An analysis asked for and not yet running: what it was asked for, and how far it got. */
interface Job {
  key: string
  /** Open a new session even where the sheet's own could look again. */
  fresh: boolean
  /** A bot explicitly chosen for it. */
  bot?: string
  /** Where a response of mine works, chosen when no tree was on its branch. */
  place?: TreeChoice
  /** The stack's pull requests to read as context, picked before there was a sheet to keep them. */
  context?: string[]
  /** Out of the queue, being prepared. */
  starting?: boolean
  /** Asked to stop while starting: it gives up at its next step. */
  stopping?: boolean
}

interface Active {
  key: string
  /** The working tree it reads (or, fixing, changes): the repository's main one for a review. */
  repo: string
  startedAt: number
  /** Tracked changes before it started: what it leaves behind is compared with this. */
  status: string
  path: string
  /** A response's fix turn: the sheet marked fixed when it ends. */
  fix?: boolean
}

/** A GitHub list as last read; a failed read keeps the pull requests it had. */
interface Listed<T> {
  pulls: T[]
  error?: string
}

/** A pull request's review threads as the diff draws them, and (someone else's) the remarks of others since my review. */
export interface Talk {
  threads: PullThread[]
  remarks: PullRemark[]
}

/** A listed pull request and those stacked with it: its parent, when one is open. */
type Stacked = Pull & { parent?: string }

/** Stack lookups go this many levels from the listed pull requests, and stop past this many found. */
const STACK_ROUNDS = 6
const STACK_PULLS = 200

const pullKey = (pull: Pick<Pull, 'slug' | 'number'>): string => `${pull.slug}#${pull.number}`

/** At most this many replies are posted at once. */
const REPLIES_PARALLEL = 4
/** How long my pull request's review threads are taken as read. */
const THREADS_TTL_MS = 60_000

/** `N files changed, A insertions(+), D deletions(-)`: git's last --stat line. */
export function diffCounts(stat: string): Pick<RunInfo, 'files' | 'added' | 'removed'> {
  const last = stat.trim().split('\n').pop() ?? ''
  if (!/files? changed/.test(last)) return {}
  const count = (pattern: RegExp): number => Number(pattern.exec(last)?.[1] ?? 0)
  return { files: count(/(\d+) files? changed/), added: count(/(\d+) insertions?/), removed: count(/(\d+) deletions?/) }
}

export class ReviewService {
  private readonly host: ReviewHost
  private readonly github: GitHub
  private readonly git: Runner
  private readonly now: () => number
  /** The pull requests waiting for my review. */
  private readonly requested = this.listOf(() => this.github.requested(), 'GitHub list')
  /** Every open pull request of the repositories set for review, read only once the board asks for them; `slugs` names which. */
  private others: { slugs: string; list: Cache<Listed<Pull>> } | undefined
  /** The pull requests I analysed without being asked, still open; `keys` names which were looked up. */
  private picked: { keys: string; list: Cache<Listed<Pull>> } | undefined
  /** Submitted reviews' pull requests, looked up for whether they landed and what followed; `keys` names which. */
  private sent: { keys: string; list: Cache<Listed<PullState>> } | undefined
  /** The signed-in account, learnt with that lookup: my own comments are no news. */
  private viewer = ''
  /** Submitted reviews' pull requests merged or closed, and when: for good, so never looked up again. */
  private readonly landed = new Map<string, { phase: 'merged' | 'closed'; at: number }>()
  /** The `all` list's size when it was last put together, shown on its tab from the other one. */
  private allCount: number | undefined
  /** Each list's stacks: what is stacked with the pull requests it lists, `keys` naming them. */
  private readonly stacked = new Map<ReviewScope, { keys: string; list: Cache<Listed<Stacked>> }>()
  /** My own open pull requests, read only once the board asks for them. */
  private readonly authored = this.listOf(() => this.github.authored(), 'GitHub list of my pull requests')
  private syncing: Promise<{ sync: SyncRun; runs: ReviewRun[] }> | undefined
  private scheduledRun: Promise<ScheduledReport> | undefined
  private readonly runChanges = new Set<() => void>()
  /** Whether the sync in flight starts analyses, and which list it reads. */
  private syncingAnalyses = false
  private syncingScope: ReviewScope = 'mine'
  private readonly slugs = new Map<string, Cache<{ remote: string; slug: string } | undefined>>()
  private readonly sheets = new Map<string, Cached>()
  /** Review sessions by id: their repository and sheet. Guards and prompts ask synchronously. */
  private readonly bySession = new Map<string, { repo: string; path: string; author?: boolean }>()
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Analyses queued (in order) or starting; each leaves once it runs, fails or is stopped. */
  private readonly jobs: Job[] = []
  private readonly active = new Map<string, Active>()
  private readonly running = new Set<string>()
  /** Why a session's turn failed (the model's error: a rate limit, say), until its next turn starts. */
  private readonly turnErrors = new Map<string, string>()
  private readonly failures = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private readonly runs = new Map<string, ReviewRun>()
  private syncRun: SyncRun | undefined
  /** Pull request diffs by `key@head`, least recently used first. */
  private readonly diffs = new Map<string, Promise<PullDiff>>()
  /** Pull requests' review threads and remarks, by key: read once a diff or a sheet asks, again when stale or asked fresh. */
  private readonly talks = new Map<string, { at: number; talk: Promise<Talk> }>()
  /** Explanations by pull request, at the head their diff shows. */
  private readonly books = new Map<string, Promise<Book>>()
  /** Explanation versions restart with the host: a client's `since` from before never matches. */
  private readonly boot = randomUUID().slice(0, 8)
  private disposed = false

  constructor(host: ReviewHost) {
    this.host = host
    this.github = host.github ?? new GitHub()
    const git = host.git ?? runGit
    // Fetches share the clone's ref and FETCH_HEAD locks (worktrees too): two at once fail with
    // "cannot lock ref", as when every pull request is analysed at once. One fetch at a time.
    this.git = (args, cwd, options) => args[0] === 'fetch' ? this.locked(FETCH_LOCK, () => git(args, cwd, options)) : git(args, cwd, options)
    this.now = host.now ?? Date.now
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  /** The repository a read-only review session works in; undefined for any other session, a response session included. */
  sessionRepo(sessionId: string | undefined): string | undefined {
    const entry = sessionId === undefined ? undefined : this.bySession.get(sessionId)
    return entry === undefined || entry.author === true ? undefined : entry.repo
  }

  /** Whether this is a response session (my own pull request): it works on its branch freely, like any session. */
  responding(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.bySession.get(sessionId)?.author === true
  }

  /** The system prompt section of a review session, or of a response session. */
  section(sessionId: string | undefined): string | undefined {
    const entry = sessionId === undefined ? undefined : this.bySession.get(sessionId)
    if (entry === undefined) return undefined
    return entry.author === true ? respondSection() : reviewSection(this.host.settings().style)
  }

  /** A session's turn started or ended. An ended analysis frees its slot and is checked for stray edits. */
  status(sessionId: string, running: boolean): void {
    if (running) {
      this.running.add(sessionId)
      this.turnErrors.delete(sessionId)
      return
    }
    this.running.delete(sessionId)
    const error = this.turnErrors.get(sessionId)
    this.turnErrors.delete(sessionId)
    this.release(sessionId, error)
  }

  /** A session's turn failed: its end reports why, rather than a sheet merely left unfinished. */
  turnError(sessionId: string, error: unknown): void {
    if (this.active.has(sessionId) || this.bySession.has(sessionId)) this.turnErrors.set(sessionId, message(error))
  }

  /** Free a session's slot and end its run: done, stalled, or failed with its turn's error. */
  private release(sessionId: string, error?: string): void {
    const active = this.active.get(sessionId)
    if (active === undefined) return
    this.active.delete(sessionId)
    if (active.fix === true) void this.fixed(active, error)
    else {
      void this.checkTree(active)
      void this.finish(active, error)
    }
    this.pump()
  }

  /**
   * A fix turn ended: the sheet is fixed at the tree's head now, unless the turn was stopped (then
   * it is as before: fixed when an earlier turn fixed it, else ready; what the turn left is the tree's to show).
   * A turn that failed (`error`) is taken as stopped, and its run fails with the error.
   */
  private async fixed(active: Active, error?: string): Promise<void> {
    const stopped = error !== undefined || this.runs.get(active.key)?.step === 'cancelled'
    const head = (await this.git(['rev-parse', 'HEAD'], active.repo, { read: true, timeoutMs: 15_000 }).catch(() => undefined))?.stdout.trim()
    await this.locked(active.path, async () => {
      const sheet = (await this.load(active.path).catch(() => undefined))?.sheet
      if (sheet?.role !== 'author' || sheet.status !== 'fixing') return
      await this.write(active.path, stopped ? { ...sheet, status: sheet.fixed === undefined ? 'ready' : 'fixed' } : { ...sheet, status: 'fixed', ...(head ? { fixed: head } : {}) })
    }).catch((error: unknown) => this.host.log(`response ${active.key} not marked fixed: ${message(error)}`))
    if (error !== undefined) this.fail(active.key, error)
    else this.step(active.key, 'done')
  }

  /** A turn ended: the run is done when the sheet is, else it failed (with the turn's error) or stalled. */
  private async finish(active: Active, error?: string): Promise<void> {
    const cached = await this.load(active.path).catch(() => undefined)
    if (error !== undefined && cached?.sheet?.status !== 'ready') this.fail(active.key, error)
    else if (cached?.sheet === undefined) this.fail(active.key, cached?.error ?? 'The session ended without a readable review sheet', 'stalled')
    else if (cached.sheet.status === 'analyzing') this.fail(active.key, 'The session stopped before the sheet was finished', 'stalled')
    else this.step(active.key, 'done')
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  private begin(key: string, manual: boolean): void {
    const at = this.now()
    this.runs.set(key, { key, manual, mode: 'fresh', step: 'queued', startedAt: at, log: [{ step: 'queued', at }] })
  }

  /** Move a run on; an ended run stays as it ended. */
  private step(key: string, step: RunStep, info?: RunInfo): void {
    const run = this.runs.get(key)
    if (run === undefined || runEnded(run.step)) return
    const at = this.now()
    run.step = step
    run.log.push({ step, at, ...(info === undefined ? {} : { info }) })
    if (runEnded(step)) run.endedAt = at
    for (const changed of this.runChanges) changed()
  }

  /** Add what the current step learned. */
  private learn(key: string, info: RunInfo): void {
    const entry = this.runs.get(key)?.log.at(-1)
    if (entry !== undefined) entry.info = { ...entry.info, ...info }
  }

  private fail(key: string, error: string, code?: ReviewRun['code']): void {
    const run = this.runs.get(key)
    if (run === undefined || runEnded(run.step)) return
    run.error = error
    if (code !== undefined) run.code = code
    this.step(key, 'failed')
  }

  /** Runs in flight and recently ended, copied: the RPC never hands out the live objects. */
  progress(): ReviewProgress {
    const now = this.now()
    for (const [key, run] of this.runs) if (run.endedAt !== undefined && now - run.endedAt > KEEP_RUN_MS) this.runs.delete(key)
    return {
      now,
      ...(this.syncRun === undefined ? {} : { sync: { ...this.syncRun } }),
      runs: [...this.runs.values()].map((run) => ({
        ...run,
        log: run.log.map((entry) => ({ ...entry, ...(entry.info === undefined ? {} : { info: { ...entry.info } }) })),
      })),
    }
  }

  private async checkTree(active: Active): Promise<void> {
    const after = await this.trackedChanges(active.repo)
    if (after !== undefined && after !== active.status) this.dirty.add(active.key)
  }

  private async trackedChanges(repo: string): Promise<string | undefined> {
    const result = await this.git(['status', '--porcelain', '--untracked-files=no'], repo, { read: true, timeoutMs: 30_000 }).catch(() => undefined)
    return result?.code === 0 ? result.stdout : undefined
  }

  /** Index every sheet of the registered repositories, so guards know review sessions after a restart. */
  async warm(): Promise<void> {
    const groups = await this.host.repos().catch(() => [])
    await Promise.all(groups.map((group) => this.readSheets(group.key).catch(() => [])))
  }

  // ── Requests ────────────────────────────────────────────────────────────

  async handle(payload: Record<string, unknown>): Promise<ReviewReply<unknown>> {
    const request = payload as ReviewRequest
    try {
      switch (request.op) {
        case 'state': return { ok: true, value: await this.state(request.fresh === true, scopeOf(request.scope)) }
        case 'sync': return { ok: true, value: await this.sync(true, false, scopeOf(request.scope)) }
        case 'analyzeAll': return { ok: true, value: await this.analyzeAll(scopeOf(request.scope)) }
        case 'analyze': return {
          ok: true,
          value: await this.analyze(String(request.key), request.fresh === true, scopeOf(request.scope), typeof request.bot === 'string' ? request.bot : undefined, treeChoice(request.tree),
            Array.isArray(request.context) ? request.context.filter((entry): entry is string => typeof entry === 'string') : undefined),
        }
        case 'places': return { ok: true, value: await this.placesOf(String(request.key)) }
        case 'fix': return { ok: true, value: await this.fix(String(request.path)) }
        case 'cancel': return { ok: true, value: await this.cancel(String(request.key), scopeOf(request.scope)) }
        case 'cancelAll': return { ok: true, value: await this.cancelAll(scopeOf(request.scope)) }
        case 'progress': return { ok: true, value: this.progress() }
        case 'sheet': return { ok: true, value: await this.sheet(String(request.path), typeof request.since === 'string' ? request.since : undefined) }
        case 'patch': return { ok: true, value: await this.patch(String(request.path), Array.isArray(request.ops) ? request.ops : [], typeof request.key === 'string' ? request.key : undefined) }
        case 'ask': return { ok: true, value: await this.ask(String(request.path), String(request.id), String(request.question ?? '')) }
        case 'rewrite': return { ok: true, value: await this.rewrite(String(request.path), String(request.id), typeof request.hint === 'string' ? request.hint : undefined) }
        case 'tell': return { ok: true, value: await this.tell(String(request.path), String(request.text ?? '')) }
        case 'preview': return { ok: true, value: await this.preview(String(request.path)) }
        case 'submit': return { ok: true, value: await this.submit(String(request.path)) }
        case 'diff': return { ok: true, value: await this.diff(String(request.key), typeof request.file === 'string' ? request.file : undefined) }
        case 'explain': return {
          ok: true,
          value: await this.explain(String(request.key), {
            ...(request.target === undefined ? {} : { target: request.target }),
            ...(typeof request.id === 'string' ? { id: request.id } : {}),
            ...(typeof request.question === 'string' ? { question: request.question } : {}),
            lang: request.lang === 'en' ? 'en' : 'zh',
          }),
        }
        case 'compose': return {
          ok: true,
          value: await this.compose(String(request.key), String(request.bot ?? ''), String(request.text ?? ''), request.target, typeof request.thread === 'string' ? request.thread : undefined),
        }
        case 'threads': return { ok: true, value: await this.threads(String(request.key), request.fresh === true) }
        case 'remarks': return { ok: true, value: (await this.talk(String(request.key))).remarks }
        case 'seen': return { ok: true, value: await this.markSeen(String(request.key), scopeOf(request.scope)) }
        case 'reply': return { ok: true, value: await this.replyThread(String(request.key), String(request.thread ?? ''), String(request.body ?? '')) }
        case 'explained': return { ok: true, value: await this.explained(String(request.key), typeof request.since === 'string' ? request.since : undefined) }
        case 'mergeState': return { ok: true, value: await this.mergeState(String(request.key)) }
        case 'merge': return {
          ok: true,
          value: await this.merge(String(request.key), mergeMethodOf(request.method), request.auto === true, typeof request.head === 'string' ? request.head : undefined),
        }
        case 'cancelAutoMerge': return { ok: true, value: await this.cancelAutoMerge(String(request.key)) }
        case 'draft': return { ok: true, value: await this.setDraft(String(request.key), request.draft === true) }
        default: return { ok: false, error: 'unknown review request' }
      }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  // ── The list ────────────────────────────────────────────────────────────

  private async configured(): Promise<RepoGroup[]> {
    const wanted = this.host.settings().repos.map(pathKey)
    if (wanted.length === 0) return []
    return (await this.host.repos()).filter((group) => wanted.includes(pathKey(group.key)))
  }

  /**
   * A GitHub list, cached; a failed read keeps the pull requests it had, with the error. `stale`: what
   * a list asked for slightly different things had, served at once while this one is read behind it.
   */
  private listOf<T>(read: () => Promise<T[]>, what: string, stale?: readonly T[]): Cache<Listed<T>> {
    const list: Cache<Listed<T>> = cached(() => read().then((pulls) => ({ pulls }), (error: unknown) => {
      if (!(error instanceof GhError)) this.host.log(`${what} failed: ${message(error)}`)
      return { pulls: list.peek()?.value.pulls ?? [], error: message(error) }
    }), LIST_TTL_MS, () => this.now(), stale === undefined ? undefined : { pulls: [...stale] })
    return list
  }

  /** The open pull requests of these repositories; asked for other repositories, read again. */
  private openPulls(slugs: readonly string[]): Cache<Listed<Pull>> {
    const key = [...new Set(slugs.map((slug) => slug.toLowerCase()))].sort().join(' ')
    if (this.others?.slugs !== key) {
      this.others = { slugs: key, list: this.listOf(() => (key === '' ? Promise.resolve([]) : this.github.open(key.split(' '))), 'GitHub open list') }
    }
    return this.others.list
  }

  /**
   * Which of these pull requests (keys) are still open; asked for others, read again. Asked for fewer,
   * the last answer has them all: it serves while GitHub is asked; a new one is waited for, as it may be closed.
   */
  private pickedPulls(keys: readonly string[]): Cache<Listed<Pull>> {
    const wanted = new Set(keys.map((entry) => entry.toLowerCase()))
    const key = [...wanted].sort().join(' ')
    if (this.picked?.keys !== key) {
      const before = this.picked
      const known = new Set(before?.keys.split(' ') ?? [])
      const last = before?.list.peek()?.value
      const stale = last !== undefined && last.error === undefined && [...wanted].every((entry) => known.has(entry))
        ? last.pulls.filter((pull) => wanted.has(pullKey(pull).toLowerCase()))
        : undefined
      this.picked = { keys: key, list: this.listOf(() => (key === '' ? Promise.resolve([]) : this.github.stillOpen(key.split(' '))), 'GitHub lookup of analysed pull requests', stale) }
    }
    return this.picked.list
  }

  /**
   * Where these submitted reviews' pull requests (keys) stand, and what happened on them; those merged
   * or closed are remembered. Asked for others, what was known of these serves while GitHub is asked:
   * one not known yet shows as its sheet has it until then.
   */
  private sentPulls(keys: readonly string[]): Cache<Listed<PullState>> {
    const wanted = new Set(keys.map((entry) => entry.toLowerCase()))
    const key = [...wanted].sort().join(' ')
    if (this.sent?.keys !== key) {
      const last = this.sent?.list.peek()?.value.pulls
      this.sent = {
        keys: key,
        list: this.listOf(async () => {
          const [states, viewer] = await Promise.all([
            key === '' ? [] : this.github.pullStates(key.split(' '), true),
            Promise.resolve().then(() => this.github.viewer()).catch(() => this.viewer),
          ])
          this.viewer = viewer
          for (const entry of states) {
            if (entry.state !== 'OPEN') this.landed.set(pullKey(entry.pull).toLowerCase(), { phase: entry.state === 'MERGED' ? 'merged' : 'closed', at: entry.at })
          }
          return states
        }, 'GitHub lookup of submitted pull requests', last?.filter((entry) => wanted.has(pullKey(entry.pull).toLowerCase()))),
      }
    }
    return this.sent.list
  }

  /** A submitted review's pull request as last looked up. */
  private sentState(key: string): PullState | undefined {
    const want = key.toLowerCase()
    return this.sent?.list.peek()?.value.pulls.find((entry) => pullKey(entry.pull).toLowerCase() === want)
  }

  /** What is stacked with a list's pull requests; listing others, looked up again. `complete`: every open one of their repositories is among them. */
  private stackedPulls(scope: ReviewScope, pulls: readonly Pull[], complete: boolean): Cache<Listed<Stacked>> {
    const key = `${complete}|${pulls.map((pull) => `${pullKey(pull)}:${pull.branch}>${pull.base}`.toLowerCase()).sort().join(' ')}`
    const slot = this.stacked.get(scope)
    if (slot?.keys === key) return slot.list
    // The list changed a little (one requested, one landed): its stacks as they were serve while they are looked up again.
    const list = this.listOf(() => this.stacks(pulls, complete), 'GitHub lookup of stacked pull requests', slot?.list.peek()?.value.pulls)
    this.stacked.set(scope, { keys: key, list })
    return list
  }

  /**
   * The pull requests stacked with these, each with its parent: the open one whose branch its base
   * is (not a fork's, not the default branch). Their neighbours are asked for level by level; with
   * `complete`, everything open is here already, and only the default branches are asked for.
   */
  private async stacks(pulls: readonly Pull[], complete: boolean): Promise<Stacked[]> {
    const usable = pulls.filter((pull) => pull.branch !== '' && pull.base !== '')
    const known = new Map(usable.map((pull) => [pullKey(pull), pull]))
    const where = (pull: Pull, branch: string): string => `${pull.slug.toLowerCase()}\n${branch}`
    const trunks = new Map<string, string>()
    const asked = new Set<string>()
    let frontier = usable
    if (complete) {
      const heads = new Set(usable.filter((pull) => !pull.cross).map((pull) => where(pull, pull.branch)))
      const bases = new Set(usable.map((pull) => where(pull, pull.base)))
      frontier = usable.filter((pull) => heads.has(where(pull, pull.base)) || (!pull.cross && bases.has(where(pull, pull.branch))))
    }
    for (let round = 0; round < STACK_ROUNDS && frontier.length > 0 && known.size < STACK_PULLS; round++) {
      for (const pull of frontier) asked.add(pullKey(pull))
      const found: Pull[] = []
      for (const answer of await this.github.neighbors(frontier)) {
        const pull = known.get(answer.key)
        const slug = (pull?.slug ?? answer.key.slice(0, answer.key.lastIndexOf('#'))).toLowerCase()
        if (answer.trunk !== '') trunks.set(slug, answer.trunk)
        // Nothing is stacked on the default branch, and a pull request from it is a release, not a stack's bottom.
        const near = [...answer.up.filter((up) => up.branch !== answer.trunk), ...(pull?.branch === answer.trunk ? [] : answer.down)]
        for (const next of near) {
          if (next.branch === '' || next.base === '' || known.has(pullKey(next))) continue
          known.set(pullKey(next), next)
          found.push(next)
        }
      }
      if (complete) break
      frontier = found.filter((pull) => !asked.has(pullKey(pull)))
    }
    // A branch's open pull request: the latest when there is more than one.
    const heads = new Map<string, Pull>()
    for (const pull of known.values()) {
      if (pull.cross || pull.branch === trunks.get(pull.slug.toLowerCase())) continue
      const at = where(pull, pull.branch)
      const other = heads.get(at)
      if (other === undefined || other.updatedAt < pull.updatedAt) heads.set(at, pull)
    }
    const parentOf = new Map<string, string>()
    for (const pull of known.values()) {
      const parent = heads.get(where(pull, pull.base))
      if (parent !== undefined && parent !== pull) parentOf.set(pullKey(pull), pullKey(parent))
    }
    const parents = new Set(parentOf.values())
    return [...known.values()].flatMap((pull) => {
      const key = pullKey(pull)
      const parent = parentOf.get(key)
      return parent !== undefined ? [{ ...pull, parent }] : parents.has(key) ? [pull] : []
    })
  }

  /** A repository's GitHub remote: origin when it is on GitHub, else the first remote that is. */
  private slugOf(repo: string): Promise<{ remote: string; slug: string } | undefined> {
    const key = pathKey(repo)
    let slug = this.slugs.get(key)
    if (slug === undefined) {
      slug = cached(() => this.git(['config', '--get-regexp', '^remote\\..*\\.url$'], repo, { read: true, timeoutMs: 15_000 }).then((result) => {
        const remotes = result.stdout.split('\n').flatMap((line) => {
          const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim())
          const found = match === null ? undefined : repoSlug(match[2]!)
          return match === null || found === undefined ? [] : [{ remote: match[1]!, slug: found }]
        })
        return remotes.find((item) => item.remote === 'origin') ?? remotes[0]
      }, () => undefined), SLUG_TTL_MS, () => this.now())
      this.slugs.set(key, slug)
    }
    // Past its age it is read again before answering, not served stale.
    const hit = slug.peek()
    return slug.get(hit !== undefined && this.now() - hit.at >= SLUG_TTL_MS)
  }

  /** A repository's sheets, each read again only when its file changed. */
  private async readSheets(repo: string): Promise<Array<{ path: string; number: number; cached: Cached }>> {
    const dir = join(repo, REVIEW_DIR)
    const names = await readdir(dir).catch(() => [] as string[])
    const out: Array<{ path: string; number: number; cached: Cached }> = []
    await Promise.all(names.map(async (name) => {
      const match = /^pr-(\d+)\.md$/i.exec(name)
      if (match === null) return
      const path = join(dir, name)
      const cached = await this.load(path).catch(() => undefined)
      if (cached !== undefined) out.push({ path, number: Number(match[1]), cached })
    }))
    return out
  }

  private async load(path: string): Promise<Cached> {
    const info = await stat(path)
    const version = `${info.mtimeMs}-${info.size}`
    const hit = this.sheets.get(path)
    if (hit?.version === version) return hit
    const text = await readFile(path, 'utf8')
    const parsed = parseSheet(text)
    const session = 'sheet' in parsed ? parsed.sheet.session : /^session:\s*(\S+)\s*$/m.exec(text)?.[1]
    const cached: Cached = {
      version,
      ...('sheet' in parsed ? { sheet: parsed.sheet } : { error: parsed.error }),
      ...(session === undefined ? {} : { session }),
    }
    this.sheets.set(path, cached)
    if (session !== undefined) {
      const author = 'sheet' in parsed ? parsed.sheet.role === 'author' : /^role:\s*author\s*$/m.test(text)
      this.bySession.set(session, { repo: dirname(dirname(path)), path, ...(author ? { author } : {}) })
    }
    return cached
  }

  /**
   * The lane's list. `mine`: the pull requests waiting for my review, those I analysed unasked while
   * they are open, and my submitted ones for a while. `own`: the open ones I opened. `all`: every open pull request of the repositories set
   * for review besides, mine first.
   */
  async state(fresh = false, scope: ReviewScope = 'mine'): Promise<ReviewState> {
    const settings = this.host.settings()
    const bots = this.host.bots().map(({ id, description }) => ({ id, ...(description?.trim() ? { description: description.trim() } : {}) }))
    const identity = { bots, defaultBot: settings.bot, ...(settings.commentBot?.trim() ? { commentBot: settings.commentBot.trim() } : {}) }
    const groups = await this.configured()
    if (groups.length === 0) return { enabled: false, ...identity, scope, items: [], syncing: this.syncing !== undefined, progress: this.progress() }
    const all = scope === 'all'
    const ownScope = scope === 'own'
    const remotes = await Promise.all(groups.map((group) => this.slugOf(group.key)))
    const slugs = remotes.flatMap((remote) => (remote === undefined ? [] : [remote.slug]))
    const [sheetsOf] = await Promise.all([
      Promise.all(groups.map((group) => this.readSheets(group.key))),
      this.requested.get(fresh), all ? this.openPulls(slugs).get(fresh) : undefined, ownScope ? this.authored.get(fresh) : undefined,
    ])
    const mineList = this.requested.peek()
    const othersList = all ? this.others?.list.peek() : undefined
    const ownList = this.authored.peek()
    const pulls = mineList?.value.pulls ?? []
    // Analysed at my asking though not asked of me: listed with those that are, while GitHub has them open.
    const asked = new Set(pulls.map((pull) => `${pull.slug}#${pull.number}`.toLowerCase()))
    const unasked = groups.flatMap((_, index) => {
      const slug = remotes[index]?.slug
      return slug === undefined ? [] : sheetsOf[index]!
        .filter(({ cached: { sheet } }) => sheet !== undefined && sheet.role !== 'author' && sheet.status !== 'submitted')
        .map((entry) => `${slug}#${entry.number}`).filter((key) => !asked.has(key.toLowerCase()))
    })
    // GitHub's list failed, so which are asked of me is unsure: those picked stay as last read.
    const unsure = mineList?.value.error !== undefined
    const pickedList = unsure ? this.picked?.list : unasked.length === 0 ? undefined : this.pickedPulls(unasked)
    if (!unsure) await pickedList?.get(fresh)
    const picked = pickedList?.peek()?.value.pulls ?? []
    // Submitted reviews: what followed them, and (not asked of me again) whether their pull request landed since, not yet known to have.
    const keepDays = Math.max(0, settings.keepMerged ?? KEEP_MERGED_DAYS)
    const keepMerged = keepDays * DAY_MS
    const now = this.now()
    const sentAt = (sheet: Sheet): number => Date.parse(sheet.submitted ?? '') || 0
    const unlanded = groups.flatMap((_, index) => {
      const slug = remotes[index]?.slug
      return slug === undefined ? [] : sheetsOf[index]!
        .filter(({ cached: { sheet } }) => sheet?.status === 'submitted' && sheet.role !== 'author' && now - sentAt(sheet) <= KEEP_SUBMITTED_MS + keepMerged)
        .map((entry) => `${slug}#${entry.number}`).filter((key) => !this.landed.has(key.toLowerCase()))
    })
    if (unlanded.length > 0) await this.sentPulls(unlanded).get(fresh)
    const others = othersList?.value.pulls ?? []
    const owned = ownList?.value.pulls ?? []
    const items: ReviewItem[] = []
    let mineCount = 0
    let ownCount = 0
    // What the list is made of, for its stacks; and where each repository's sheets are.
    const onHand: Pull[] = []
    const places = new Map<string, { repo: string; byNumber: Map<number, { path: string; cached: Cached }> }>()
    await Promise.all(groups.map(async (group, index) => {
      const remote = remotes[index]
      const sheets = sheetsOf[index]!
      const slug = remote?.slug.toLowerCase()
      const mine = slug === undefined ? [] : pulls.filter((pull) => pull.slug.toLowerCase() === slug)
      const byNumber = new Map(sheets.map((entry) => [entry.number, entry]))
      const requested = new Set(mine.map((pull) => pull.number))
      const chosen = slug === undefined ? [] : picked.filter((pull) => pull.slug.toLowerCase() === slug && !requested.has(pull.number))
      const listed = new Set([...requested, ...chosen.map((pull) => pull.number)])
      const own = slug === undefined ? [] : owned.filter((pull) => pull.slug.toLowerCase() === slug)
      ownCount += own.length
      if (slug !== undefined) places.set(slug, { repo: group.key, byNumber })
      onHand.push(...(ownScope ? own : [...mine, ...chosen]))
      if (ownScope) for (const pull of own) items.push(this.item(group.key, pull, byNumber.get(pull.number), false, true, pull))
      else {
        for (const pull of mine) items.push(this.item(group.key, pull, byNumber.get(pull.number)))
        for (const pull of chosen) items.push({ ...this.item(group.key, pull, byNumber.get(pull.number), false, true), picked: true })
      }
      if (slug !== undefined) {
        for (const pull of others) {
          if (pull.slug.toLowerCase() !== slug || listed.has(pull.number)) continue
          listed.add(pull.number)
          onHand.push(pull)
          items.push(this.item(group.key, pull, byNumber.get(pull.number), false, true))
        }
      }
      mineCount += mine.length + chosen.length
      for (const entry of sheets) {
        const sheet = entry.cached.sheet
        // A response of mine is not a review of mine: it shows with its pull request while that is open.
        if (requested.has(entry.number) || sheet?.status !== 'submitted' || sheet.role === 'author') continue
        const at = sentAt(sheet)
        // Merged or closed while it was on the board: it stays a few days more, from then.
        const land = slug === undefined ? undefined : this.landed.get(`${slug}#${entry.number}`)
        if (land === undefined ? now - at > KEEP_SUBMITTED_MS : land.at - at > KEEP_SUBMITTED_MS || now - land.at > keepMerged) continue
        mineCount++
        if (ownScope || listed.has(entry.number)) continue
        const { slug: pr } = parsePr(sheet.pr)
        // Still open as last looked up: as GitHub has it now, so what followed the review shows.
        const looked = slug === undefined ? undefined : this.sentState(`${slug}#${entry.number}`)
        const open = looked?.state === 'OPEN' ? looked.pull : undefined
        // Its branch known, it is looked up for its stack like the others: a review sent stays on its rail.
        if (open !== undefined) onHand.push(open)
        const item = this.item(group.key, open ?? {
          slug: pr, number: entry.number, title: sheet.title, url: sheet.url ?? `https://github.com/${pr}/pull/${entry.number}`, draft: false,
          head: sheet.head, branch: '', base: sheet.base, author: sheet.author, updatedAt: at, cross: false,
        }, entry, false, open !== undefined)
        items.push(land === undefined || item.phase !== 'submitted' ? item : { ...item, phase: land.phase, updatedAt: land.at })
      }
    }))
    // Mine (asked of me or picked) lead the whole list. In each part, what wants analysing first, then
    // what waits to be sent, then what was sent (我的 keeps its own order); newest first within.
    const lead = (item: ReviewItem): boolean => item.requested || item.picked === true
    items.sort((a, b) => (all && lead(a) !== lead(b) ? (lead(a) ? -1 : 1) : 0)
      || (ownScope ? 0 : reviewRank(a) - reviewRank(b)) || b.updatedAt - a.updatedAt)
    if (othersList !== undefined) this.allCount = items.length
    // The stacks: each listed pull request's parent, and those stacked with it that the list leaves out.
    const stackedList = this.stackedPulls(scope, onHand, all && othersList?.value.error === undefined)
    await stackedList.get(fresh)
    const stacked = stackedList.peek()?.value.pulls ?? []
    const parents = new Map(stacked.flatMap((pull) => (pull.parent === undefined ? [] : [[pullKey(pull), pull.parent] as const])))
    const withParent = (item: ReviewItem): ReviewItem => {
      const parent = parents.get(item.key)
      return parent === undefined ? item : { ...item, parent }
    }
    const listedKeys = new Set(items.map((item) => item.key))
    const related = stacked.flatMap((pull) => {
      const place = places.get(pull.slug.toLowerCase())
      if (place === undefined || listedKeys.has(pullKey(pull))) return []
      const mineToo = owned.find((own) => pullKey(own) === pullKey(pull))
      return [withParent(this.item(place.repo, pull, place.byNumber.get(pull.number), false, true, mineToo))]
    })
    const list = all ? othersList : ownScope ? ownList : mineList
    const error = ownScope ? ownList?.value.error : mineList?.value.error ?? othersList?.value.error
    return {
      enabled: true,
      repos: groups.map((group) => group.key),
      ...identity,
      scope,
      items: items.map(withParent),
      ...(related.length === 0 ? {} : { related }),
      keepMerged: keepDays,
      counts: { mine: mineCount, ...(ownList === undefined ? {} : { own: ownCount }), ...(this.allCount === undefined ? {} : { all: this.allCount }) },
      syncing: this.syncing !== undefined,
      progress: this.progress(),
      ...(list === undefined ? {} : { syncedAt: list.at }),
      ...(error === undefined ? {} : { error }),
    }
  }

  /** A pull request on the board: waiting for me, mine, (once those lists have been read) any open one, or one stacked with them. */
  private async find(key: string): Promise<ReviewItem | undefined> {
    return (await this.board(key))?.item
  }

  /** A pull request on the board, and every pull request its list shows beside it: the stacks are read from them. */
  private async board(key: string): Promise<{ item: ReviewItem; peers: ReviewItem[] } | undefined> {
    const scopes: ReviewScope[] = ['mine', ...(this.authored.peek() === undefined ? [] : ['own' as const]), ...(this.others?.list.peek() === undefined ? [] : ['all' as const])]
    for (const scope of scopes) {
      const state = await this.state(false, scope)
      const peers = [...state.items, ...state.related ?? []]
      const item = peers.find((entry) => entry.key === key)
      if (item !== undefined) return { item, peers }
    }
    return undefined
  }

  /**
   * `live`: the pull request as GitHub lists it now, so its head tells whether the sheet is behind.
   * `own`: a pull request of mine as that list has it (what waits on me); a response sheet in another list is mine too.
   */
  private item(repo: string, pull: Pull, entry: { path: string; cached: Cached } | undefined, requested = true, live = requested, own?: OwnPull): ReviewItem {
    const key = `${pull.slug}#${pull.number}`
    const sheet = entry?.cached.sheet
    const mineToAnswer = own !== undefined || sheet?.role === 'author'
    const answered = mineToAnswer ? ownPhase(sheet, entry?.cached.error, own?.pending) : undefined
    const phase = answered?.phase ?? phaseOf(sheet, entry?.cached.error, live ? pull.head : undefined)
    const findings = sheet?.findings ?? []
    const again = phase === 'submitted' && requested && !mineToAnswer && pull.updatedAt > (Date.parse(sheet?.submitted ?? '') || Infinity) + REREQUEST_GRACE_MS
    const follow = phase === 'submitted' && !mineToAnswer && live && sheet !== undefined ? followOf(sheet, pull.head, this.sentState(key)?.activity, this.viewer) : undefined
    const session = entry?.cached.session
    const failure = this.failures.get(key)
    const error = entry?.cached.error ?? failure
    return {
      key, repo, number: pull.number, title: pull.title || sheet?.title || '', author: pull.author || sheet?.author || '', url: pull.url,
      draft: pull.draft, branch: pull.branch, base: pull.base || sheet?.base || '', head: pull.head, updatedAt: pull.updatedAt, phase, requested,
      path: entry?.path ?? join(repo, REVIEW_DIR, sheetName(pull.number)),
      must: findings.filter((item) => item.severity === 'must' && !isMine(item)).length,
      nice: findings.filter((item) => item.severity === 'nice' && !isMine(item)).length,
      checked: findings.filter((item) => item.checked).length,
      ...(sheet === undefined ? {} : { decision: sheet.decision, round: sheet.round }),
      ...(session === undefined ? {} : { session }),
      ...(error === undefined ? {} : { error }),
      ...(again ? { rerequested: true } : {}),
      ...(follow === undefined ? {} : { follow }),
      ...(this.dirty.has(key) ? { dirty: true } : {}),
      ...(this.job(key) !== undefined ? { queued: true } : {}),
      ...(session !== undefined && (this.running.has(session) || this.active.has(session)) ? { running: true } : {}),
      ...(mineToAnswer ? {
        own: true,
        ...(own === undefined ? {} : { pending: own.pending.length, cross: own.cross, ...(own.decision === undefined ? {} : { reviewDecision: own.decision }) }),
        ...(answered?.unseen === undefined ? {} : { unseen: answered.unseen }),
        ...(sheet?.tree === undefined ? {} : { tree: sheet.tree }),
      } : {}),
    }
  }

  // ── Sync and analysis ───────────────────────────────────────────────────

  /**
   * What an analysis is due for: new, with new commits (a submitted review's too; comments alone
   * only show), or stalled (its session ended, failed or went away with a restart, the sheet unfinished).
   */
  private due(items: readonly ReviewItem[]): ReviewItem[] {
    return items.filter((item) => item.requested && !item.draft
      && (item.phase === 'new' || item.phase === 'stale' || stalled(item) || unanalysed(item) || (item.phase === 'submitted' && (item.follow?.commits ?? 0) > 0)))
      .filter((item) => this.job(item.key) === undefined && item.running !== true)
  }

  /** Read GitHub now; only analysing syncs queue reviews. Scheduling belongs to DSH. */
  async sync(manual = false, analyze = true, scope: ReviewScope = 'mine'): Promise<ReviewState> {
    await this.syncBatch(manual, analyze, scope)
    return this.state(false, scope)
  }

  /** Keep references to exactly this batch, even after another sync or board history pruning. */
  private async syncBatch(manual: boolean, analyze: boolean, scope: ReviewScope): Promise<{ sync: SyncRun; runs: ReviewRun[] }> {
    // A list-only sync in flight does not stand in for one that analyses, nor one of mine for one of all: that one follows it.
    while (this.syncing !== undefined && ((analyze && !this.syncingAnalyses) || (scope === 'all' && this.syncingScope !== 'all'))) await this.syncing.catch(() => {})
    if (this.syncing === undefined) {
      this.syncingAnalyses = analyze
      this.syncingScope = scope
      this.syncing = (async () => {
        const run: SyncRun = { manual, step: 'list', startedAt: this.now() }
        const runs: ReviewRun[] = []
        this.syncRun = run
        try {
          const state = await this.state(true, scope)
          run.found = state.items.filter((item) => item.requested).length
          if (scope === 'all') run.total = state.items.length
          if (analyze) {
            const due = this.due(state.items).slice(0, Math.max(1, this.host.settings().maxPerRun))
            for (const item of due) {
              this.begin(item.key, manual)
              runs.push(this.runs.get(item.key)!)
              this.jobs.push({ key: item.key, fresh: false })
            }
            run.due = due.length
          }
          if (state.error === undefined) run.step = 'done'
          else Object.assign(run, { step: 'failed', error: state.error })
          this.pump()
        } catch (error) {
          Object.assign(run, { step: 'failed', error: message(error) })
          throw error
        } finally {
          run.endedAt = this.now()
        }
        return { sync: run, runs }
      })().finally(() => { this.syncing = undefined })
    }
    return this.syncing
  }

  /** One tool call owns one batch; duplicate calls while it waits share the same result. */
  runScheduled(signal?: AbortSignal): Promise<ScheduledReport> {
    if (this.scheduledRun !== undefined) return this.scheduledRun
    this.scheduledRun = (async () => {
      const startedAt = this.now()
      if (this.disposed || signal?.aborted) return scheduledReport({ manual: false, step: 'failed', startedAt, error: 'The scheduled sync was stopped before it started' }, [], this.now())
      try {
        const batch = await this.syncBatch(false, true, 'mine')
        await this.waitForBatch(batch.runs, signal)
        return scheduledReport(batch.sync, batch.runs, this.now())
      } catch (error) {
        return scheduledReport({ manual: false, step: 'failed', startedAt, error: message(error) }, [], this.now())
      }
    })().finally(() => { this.scheduledRun = undefined })
    return this.scheduledRun
  }

  /** Event-driven wait: no second scheduler and no polling timer. */
  private waitForBatch(runs: readonly ReviewRun[], signal?: AbortSignal): Promise<void> {
    if (runs.every((run) => runEnded(run.step)) || this.disposed || signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', finish)
        this.runChanges.delete(changed)
        resolve()
      }
      const changed = (): void => {
        if (this.disposed || runs.every((run) => runEnded(run.step))) finish()
      }
      const timeout = setTimeout(finish, REPORT_WAIT_MS)
      this.runChanges.add(changed)
      signal?.addEventListener('abort', finish, { once: true })
      changed()
    })
  }

  /** Queue an analysis of every pull request waiting for me that has none at its current head; analysed ones are left alone. */
  async analyzeAll(scope: ReviewScope = 'mine'): Promise<ReviewState> {
    const due = this.due((await this.state()).items)
    if (due.length === 0) throw new Error('Every pull request waiting for you is analysed already')
    for (const item of due) {
      this.failures.delete(item.key)
      this.begin(item.key, true)
      this.jobs.push({ key: item.key, fresh: false })
    }
    this.pump()
    return this.state(false, scope)
  }

  /**
   * Analyse one pull request now (or after the running ones); an explicit bot always opens a new
   * session. One of mine is answered, ahead of the queue: `tree` says where when no tree is on its branch.
   * `context`: the stack's pull requests to read beside it, when it has no sheet to keep them yet.
   */
  async analyze(key: string, fresh = false, scope: ReviewScope = 'mine', bot?: string, tree?: TreeChoice, context?: string[]): Promise<ReviewState> {
    const chosen = bot === undefined ? undefined : this.host.bots().find((profile) => profile.id === bot)
    if (bot !== undefined && chosen === undefined) throw new Error(`The bot "${bot}" is unavailable`)
    const item = await this.find(key)
    if (item === undefined) throw new Error('This pull request is no longer on the board')
    if (item.running === true) throw new Error('This pull request is being analysed now')
    if (item.own === true && item.cross === true) throw new Error('This pull request\'s branch is on a fork: it cannot be worked on here')
    if (this.job(key) !== undefined) return this.state(false, scope)
    this.failures.delete(key)
    const job: Job = {
      key, fresh: fresh || chosen !== undefined, ...(chosen === undefined ? {} : { bot: chosen.id }), ...(tree === undefined ? {} : { place: tree }),
      ...(context === undefined || item.own === true ? {} : { context }),
    }
    this.begin(key, true)
    // I am waiting on a response of mine; the reviews can wait their turn.
    if (item.own === true) this.jobs.unshift(job)
    else this.jobs.push(job)
    this.pump()
    return this.state(false, scope)
  }

  /**
   * Stop one pull request's analysis: out of the queue, or given up at the next step while it
   * starts, or its session's turn stopped while it analyses. The sheet stays as it was left.
   */
  async cancel(key: string, scope: ReviewScope = 'mine'): Promise<ReviewState> {
    if (!(await this.stop(key))) throw new Error('This pull request is not being analysed')
    return this.state(false, scope)
  }

  /** Stop every analysis queued, starting or running. */
  async cancelAll(scope: ReviewScope = 'mine'): Promise<ReviewState> {
    const keys = new Set([...this.jobs.map((job) => job.key), ...[...this.active.values()].map((active) => active.key), ...this.answering().keys()])
    if (keys.size === 0) throw new Error('No analysis is running')
    await Promise.all([...keys].map((key) => this.stop(key)))
    return this.state(false, scope)
  }

  /** Whether there was anything of the pull request's to stop. */
  private async stop(key: string): Promise<boolean> {
    const job = this.job(key)
    if (job !== undefined && job.starting !== true) {
      this.jobs.splice(this.jobs.indexOf(job), 1)
      this.step(key, 'cancelled')
      return true
    }
    const sessions = [...this.active].filter(([, active]) => active.key === key).map(([session]) => session)
    // Its sheet's session answering outside a run (asked to fix the sheet, say) stops too.
    const answering = this.answering().get(key)
    if (answering !== undefined && !sessions.includes(answering)) sessions.push(answering)
    if (job === undefined && sessions.length === 0) return false
    if (job !== undefined) job.stopping = true
    this.stopped(key)
    const host = this.host.sessions()
    await Promise.all(sessions.map((id) => host?.cancel(id).catch((error: unknown) => this.host.log(`review ${key} not stopped: ${message(error)}`))))
    // A session holding a slot with no turn running (its turn already ended, or its message never
    // started one) reports no end to wait for: free its slot now, or the card stays busy.
    for (const id of sessions) if (!this.running.has(id)) this.release(id)
    return true
  }

  /** Pull requests whose sheet's own session is answering now, with that session. */
  private answering(): Map<string, string> {
    const out = new Map<string, string>()
    for (const id of this.running) {
      const path = this.bySession.get(id)?.path
      const sheet = path === undefined ? undefined : this.sheets.get(path)?.sheet
      if (sheet !== undefined && sheet.session === id) out.set(sheet.pr, id)
    }
    return out
  }

  /** The run ends as stopped, not failed: what its session does after is no failure of it. */
  private stopped(key: string): void {
    const run = this.runs.get(key)
    if (run === undefined || runEnded(run.step)) return
    run.code = 'stopped'
    this.step(key, 'cancelled')
  }

  /** Give up a starting analysis asked to stop. */
  private halt(key: string): void {
    if (this.job(key)?.stopping === true) throw new Stopped()
  }

  /** The queued or starting analysis of a pull request. */
  private job(key: string): Job | undefined {
    return this.jobs.find((job) => job.key === key)
  }

  private pump(): void {
    if (this.disposed) return
    for (const [session, active] of this.active) {
      // A fix turn I asked for runs as long as it needs: its end marks the sheet fixed.
      if (active.fix === true || this.now() - active.startedAt <= SLOT_MS) continue
      this.active.delete(session)
      this.fail(active.key, 'The analysis did not report back in time', 'timeout')
    }
    for (;;) {
      const job = this.jobs.find((entry) => entry.starting !== true)
      if (job === undefined || this.active.size + this.jobs.filter((entry) => entry.starting === true).length >= MAX_ACTIVE) return
      job.starting = true
      const key = job.key
      const run = this.runs.get(key)
      if (run === undefined || runEnded(run.step)) this.begin(key, false)
      void this.start(key).catch((error: unknown) => {
        if (error instanceof Stopped) return
        this.failures.set(key, message(error))
        this.fail(key, message(error))
        this.host.log(`review ${key} not started: ${message(error)}`)
      }).finally(() => {
        const at = this.jobs.indexOf(job)
        if (at >= 0) this.jobs.splice(at, 1)
        this.pump()
      })
    }
  }

  private async start(key: string): Promise<void> {
    const found = await this.board(key)
    if (found === undefined) throw new Error('This pull request is no longer on the board')
    const { item, peers } = found
    if (item.own === true) return this.respond(item)
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('DSH sessions are unavailable')
    const remote = await this.slugOf(item.repo)
    if (remote === undefined) throw new Error('The repository has no GitHub remote')
    const { slug } = parsePr(key)
    const settings = this.host.settings()
    const existing = await this.load(item.path).catch(() => undefined)
    const old = existing?.sheet
    const context = this.job(key)?.context ?? old?.context ?? []
    this.halt(key)

    // The same head and a session that finished its sheet: ask it to look again rather than starting
    // over. A sheet still `analyzing` here never got its analysis, so that session has nothing to look again at.
    if (this.job(key)?.fresh !== true && old !== undefined && old.session !== undefined && sameCommit(old.head, item.head) && old.status === 'ready') {
      const run = this.runs.get(key)
      if (run !== undefined) run.mode = 'again'
      this.step(key, 'session', { round: old.round, head: old.head.slice(0, 12) })
      const stack = await this.stackContext(item, peers, context, remote.remote)
      const status = await this.trackedChanges(item.repo) ?? ''
      this.halt(key)
      // Its slot before the message: a turn that ends at once still finds the run.
      this.active.set(old.session, { key, repo: item.repo, startedAt: this.now(), status, path: item.path })
      const again = ['Review the pull request again with the current rules of the sheet and update the sheet; keep its format.', ...(stack === '' ? [] : ['', stack])].join('\n')
      await sessions.send(old.session, again, `review-again-${randomUUID()}`)
        .catch((error: unknown) => {
          this.active.delete(old.session!)
          throw error
        })
      await this.stopSent(key, old.session, sessions)
      this.step(key, 'analyzing')
      return
    }

    this.step(key, 'fetch')
    const base = REF.test(item.base || old?.base || '') ? (item.base || old!.base) : undefined
    const baseRef = base === undefined ? undefined : `refs/remotes/${remote.remote}/${base}`
    const ref = reviewRef(item.number)
    const specs = [`+refs/pull/${item.number}/head:${ref}`, ...(base === undefined ? [] : [`+refs/heads/${base}:${baseRef}`])]
    const fetched = await this.git(['fetch', '--no-tags', '--quiet', remote.remote, ...specs], item.repo, { timeoutMs: 180_000 })
    if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr.trim().split('\n').pop() ?? fetched.code}`)
    const stack = await this.stackContext(item, peers, context, remote.remote)
    this.halt(key)
    const head = (await this.git(['rev-parse', '--verify', `${ref}^{commit}`], item.repo, { read: true })).stdout.trim() || item.head
    this.learn(key, { head: head.slice(0, 12) })
    this.step(key, 'context')
    const range = baseRef === undefined ? `${ref}~1..${ref}` : `${baseRef}...${ref}`
    const stat = await this.git(['diff', '--stat=160', '--stat-count=200', range], item.repo, { read: true, timeoutMs: 60_000, maxBytes: 256 << 10, allowPartial: true }).catch(() => undefined)
    const threads = await this.github.threads(slug, item.number).catch(() => [])
    // After a review of mine went out: how its comments were answered, and what else was said since.
    const followed = old?.status === 'submitted' && old.role === undefined && old.submitted !== undefined
      ? await Promise.resolve().then(() => this.github.conversation(slug, item.number)).then((conversation) => {
        const talk = talkOf(conversation, item, old)
        return followSection({ submitted: old.submitted!, viewer: conversation.viewer, threads: talk.threads.filter((thread) => thread.mine === true), remarks: talk.remarks, findings: old.findings })
      }).catch(() => '')
      : ''
    const repoRules = await readFile(join(item.repo, REVIEW_DIR, 'RULES.md'), 'utf8').catch(() => '')
    const rules = [settings.rules ?? '', repoRules, old?.rules ?? ''].map((part) => part.trim()).filter(Boolean).join('\n\n')
    this.learn(key, { ...diffCounts(stat?.stdout ?? ''), threads: threads.length })
    // The last point where nothing is changed yet: past it the old round moves aside and a session opens.
    this.halt(key)

    // A new round: the last one's sheet is kept beside it.
    let round = old?.round ?? 1
    let previous: { head: string; sheet: string } | undefined
    if (old !== undefined && (!sameCommit(old.head, head) || old.status === 'submitted')) {
      const kept = join(item.repo, REVIEW_DIR, `pr-${item.number}.round${old.round}.md`)
      await rename(item.path, kept).catch(() => {})
      previous = { head: old.head, sheet: `${REVIEW_DIR}/${basename(kept)}` }
      round = old.round + 1
    }

    this.step(key, 'session', { round })
    const selectedBot = this.job(key)?.bot
    const botId = selectedBot ?? settings.bot
    const bot = this.host.bots().find((profile) => profile.id === botId)
    if (selectedBot !== undefined && bot === undefined) throw new Error(`The bot "${selectedBot}" is unavailable`)
    const group = (await this.host.repos()).find((entry) => pathKey(entry.key) === pathKey(item.repo))
    const workspaceId = group?.members.find((member) => member.main)?.workspaceId
    const before = await this.trackedChanges(item.repo) ?? ''
    await this.ensureDir(item.repo)
    const session = await sessions.start({
      cwd: item.repo,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      title: `Review #${item.number} · ${item.title}`.slice(0, 120),
      ...(bot === undefined ? {} : { route: { provider: BOT_ROUTE, model: bot.id } }),
    })
    // My own comments outlive the analysis; once posted, they stay with the round they went out in.
    const mine = old === undefined || old.status === 'submitted' ? [] : old.findings.filter(isMine)
    const sheet = blankSheet({
      pr: key, title: item.title, author: item.author, url: item.url, base: base ?? '', head, round, session, ...(old?.rules ? { rules: old.rules } : {}), context,
      ...(mine.length === 0 ? {} : { findings: mine }),
    })
    await this.write(item.path, sheet)
    this.dirty.delete(key)
    this.active.set(session, { key, repo: item.repo, startedAt: this.now(), status: before, path: item.path })
    await sessions.send(session, firstMessage({
      slug, number: item.number, title: item.title, url: item.url, author: item.author, base: base ?? '?',
      baseRef: baseRef ?? `${ref}~1`, head, round, stat: stat?.stdout ?? '', threads, rules, stack,
      ...(bot === undefined ? { analysis: defaultAnalysis() } : {}),
      ...(previous === undefined ? {} : { previous }),
      ...(followed === '' ? {} : { followed }),
    }), `review-${key}-${head.slice(0, 12)}-${round}`).catch((error: unknown) => {
      this.active.delete(session)
      throw error
    })
    await this.stopSent(key, session, sessions)
    this.step(key, 'analyzing')
  }

  /**
   * The stack around a pull request, told to its analysis: what it builds on and what is built on
   * it, the ones picked as context fetched to their refs (`refs/reviews/pr-<n>`) with their bases,
   * so the session can read them. A fetch that fails leaves them named only. Empty: no stack.
   */
  private async stackContext(item: ReviewItem, peers: readonly ReviewItem[], picked: readonly string[], remote: string): Promise<string> {
    const stacks = stacksOf(peers)
    const byKey = new Map(peers.map((peer) => [peer.key, peer]))
    const near = (keys: string[]): ReviewItem[] => keys.flatMap((key) => byKey.get(key) ?? [])
    const below = near(stacks.below(item.key))
    const above = near(stacks.above(item.key))
    if (below.length + above.length === 0) return ''
    const want = new Set(picked)
    const chosen = [...below, ...above].filter((peer) => want.has(peer.key) && REF.test(peer.base))
    const specs = new Set(chosen.flatMap((peer) => [`+refs/pull/${peer.number}/head:${reviewRef(peer.number)}`, `+refs/heads/${peer.base}:refs/remotes/${remote}/${peer.base}`]))
    const fetched = specs.size === 0 ? false
      : (await this.git(['fetch', '--no-tags', '--quiet', remote, ...specs], item.repo, { timeoutMs: 180_000 }).catch(() => undefined))?.code === 0
    const read = new Set(fetched ? chosen.map((peer) => peer.key) : [])
    const entry = (peer: ReviewItem): StackPull => ({
      number: peer.number, title: peer.title, author: peer.author,
      ...(read.has(peer.key) ? { range: `refs/remotes/${remote}/${peer.base}...${reviewRef(peer.number)}` } : {}),
    })
    return stackSection({ below: below.map(entry), above: above.map(entry) })
  }

  /** Asked to stop while its message was being sent: the stop may have come before the turn did, so stop it now. */
  private async stopSent(key: string, session: string, sessions: SessionHost): Promise<void> {
    if (this.job(key)?.stopping !== true) return
    await sessions.cancel(session).catch((error: unknown) => this.host.log(`review ${key} not stopped: ${message(error)}`))
  }

  /** `.reviews/` with a .gitignore that ignores the folder itself. */
  private async ensureDir(repo: string): Promise<void> {
    const dir = join(repo, REVIEW_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {})
  }

  // ── My own pull requests ────────────────────────────────────────────────

  /** A repository's working trees, the gone ones left out. */
  private async treesOf(repo: string): Promise<Worktree[]> {
    const trees = this.host.trees
    if (trees === undefined) throw new Error('Working trees are unavailable')
    return (await trees.list(repo)).filter((tree) => tree.prunable === undefined)
  }

  /** Where my pull request's branch is worked on, or could be: each other tree with whether it can switch now. */
  async placesOf(key: string): Promise<TreePlaces> {
    const item = await this.find(key)
    if (item?.own !== true) throw new Error('This is not one of your pull requests')
    const trees = await this.treesOf(item.repo)
    const on = trees.find((tree) => tree.branch === item.branch)
    const options = await Promise.all(trees.filter((tree) => tree !== on).map(async (tree) => ({
      path: tree.path,
      ...(tree.branch === undefined ? {} : { branch: tree.branch }),
      main: tree.main,
      ...(tree.workspace === undefined ? {} : { workspaceId: tree.workspace.id }),
      // Unreadable counts as changed: nothing is switched on a guess.
      dirty: (await this.trackedChanges(tree.path)) !== '',
    })))
    return {
      branch: item.branch,
      ...(on === undefined ? {} : { existing: { path: on.path, ...(on.workspace === undefined ? {} : { workspaceId: on.workspace.id }) } }),
      options,
      ...(item.cross === true ? { cross: true } : {}),
    }
  }

  /**
   * The working tree on the branch: the one already on it, else the choice made: a new worktree,
   * or a tree without changes switched to it (tracking the remote's branch when there is no local one).
   */
  private async placeTree(item: ReviewItem, remote: string, choice: TreeChoice | undefined): Promise<WorktreeOpened> {
    const trees = this.host.trees!
    const listed = await this.treesOf(item.repo)
    const on = listed.find((tree) => tree.branch === item.branch)
    if (on !== undefined) return trees.open(item.repo, on.path)
    if (choice === undefined) throw new Error(`No working tree is on ${item.branch}: choose where to work on it`)
    if (choice.kind === 'new') return trees.add(item.repo, item.branch)
    const target = listed.find((tree) => pathKey(tree.path) === pathKey(choice.path))
    if (target === undefined) throw new Error(`${choice.path} is not a working tree of this repository`)
    if ((await this.trackedChanges(target.path)) !== '') throw new Error(`${target.path} has uncommitted changes: commit or stash them first`)
    const local = (await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${item.branch}`], target.path, { read: true, timeoutMs: 15_000 })).code === 0
    const switched = await this.git(local ? ['switch', item.branch] : ['switch', '--track', '-c', item.branch, `${remote}/${item.branch}`], target.path, { timeoutMs: 120_000 })
    if (switched.code !== 0) throw new Error(`git switch failed: ${switched.stderr.trim().split('\n').pop() ?? switched.code}`)
    return trees.open(item.repo, target.path)
  }

  /** Bring the tree's branch up to the remote's when that is a fast-forward of a clean tree; else say how they differ. */
  private async fastForward(tree: string, upstream: string): Promise<string | undefined> {
    const counted = await this.git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], tree, { read: true, timeoutMs: 30_000 }).catch(() => undefined)
    if (counted?.code !== 0) return undefined
    const [ahead = 0, behind = 0] = counted.stdout.trim().split(/\s+/).map(Number)
    if (behind === 0) return undefined
    if (ahead > 0) return `the branch and ${upstream} have diverged (${ahead} local and ${behind} remote commits); do not rebase or merge, the user settles it`
    if ((await this.trackedChanges(tree)) === '') {
      const merged = await this.git(['merge', '--ff-only', '--quiet', upstream], tree, { timeoutMs: 120_000 }).catch(() => undefined)
      if (merged?.code === 0) return undefined
    }
    return `the branch is ${behind} commits behind ${upstream} and could not be fast-forwarded (uncommitted changes); read the remote's commits with git if they matter`
  }

  /**
   * A response round: the branch fetched and its tree placed and caught up, the comments waiting on
   * me read, the last round's sheet kept beside, then the sheet's session (or a new one, on the
   * chosen bot) told to triage them into the sheet.
   */
  private async respond(item: ReviewItem): Promise<void> {
    const key = item.key
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('DSH sessions are unavailable')
    if (this.host.trees === undefined) throw new Error('Working trees are unavailable')
    if (item.cross === true) throw new Error('This pull request\'s branch is on a fork: it cannot be worked on here')
    if (!REF.test(item.branch)) throw new Error('The pull request has no branch to work on')
    const remote = await this.slugOf(item.repo)
    if (remote === undefined) throw new Error('The repository has no GitHub remote')
    const { slug } = parsePr(key)
    const settings = this.host.settings()
    const old = (await this.load(item.path).catch(() => undefined))?.sheet
    this.halt(key)

    this.step(key, 'fetch')
    const base = REF.test(item.base) ? item.base : undefined
    const upstream = `${remote.remote}/${item.branch}`
    const specs = [`+refs/heads/${item.branch}:refs/remotes/${upstream}`, ...(base === undefined ? [] : [`+refs/heads/${base}:refs/remotes/${remote.remote}/${base}`])]
    const fetched = await this.git(['fetch', '--no-tags', '--quiet', remote.remote, ...specs], item.repo, { timeoutMs: 180_000 })
    if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr.trim().split('\n').pop() ?? fetched.code}`)
    this.halt(key)
    const tree = await this.placeTree(item, remote.remote, this.job(key)?.place)
    const note = await this.fastForward(tree.path, upstream)
    const read = { read: true, timeoutMs: 60_000 }
    const head = (await this.git(['rev-parse', 'HEAD'], tree.path, read)).stdout.trim()
    this.learn(key, { head: head.slice(0, 12) })
    this.halt(key)

    this.step(key, 'context')
    const baseRef = base === undefined ? 'HEAD~1' : `${remote.remote}/${base}`
    const range = `${baseRef}...HEAD`
    const [stat, diff, conversation, repoRules] = await Promise.all([
      this.git(['diff', '--stat=160', '--stat-count=200', range], tree.path, { ...read, maxBytes: 256 << 10, allowPartial: true }).catch(() => undefined),
      this.git(['diff', '--no-ext-diff', '--no-color', range], tree.path, { ...read, maxBytes: 256 << 10, allowPartial: true }).catch(() => undefined),
      this.github.conversation(slug, item.number),
      readFile(join(item.repo, REVIEW_DIR, 'RULES.md'), 'utf8').catch(() => ''),
    ])
    const readAt = new Date(this.now()).toISOString()
    const items = waiting(conversation, old)
    const rules = [settings.rules ?? '', repoRules, old?.rules ?? ''].map((part) => part.trim()).filter(Boolean).join('\n\n')
    this.learn(key, { ...diffCounts(stat?.stdout ?? ''), threads: items.threads.length })
    // The last point where nothing is changed yet: past it the old round moves aside and a session is told.
    this.halt(key)

    // A new round, the last one's sheet kept beside it; a sheet never finished is simply replaced.
    let round = 1
    let previous: string | undefined
    if (old !== undefined && old.status !== 'analyzing') {
      const kept = join(item.repo, REVIEW_DIR, `pr-${item.number}.round${old.round}.md`)
      await rename(item.path, kept).catch(() => {})
      previous = kept
      round = old.round + 1
    } else if (old !== undefined) round = old.round

    this.step(key, 'session', { round })
    // The same session goes on while it works in the same tree: it knows the change and what it answered.
    const reuse = this.job(key)?.fresh !== true && old?.session !== undefined && old.tree !== undefined && pathKey(old.tree) === pathKey(tree.path)
    let session: string
    if (reuse) session = old.session!
    else {
      const selectedBot = this.job(key)?.bot
      const botId = selectedBot ?? settings.bot
      const bot = this.host.bots().find((profile) => profile.id === botId)
      if (selectedBot !== undefined && bot === undefined) throw new Error(`The bot "${selectedBot}" is unavailable`)
      session = await sessions.start({
        cwd: tree.path,
        ...(tree.workspaceId === undefined ? {} : { workspaceId: tree.workspaceId }),
        title: `Respond #${item.number} · ${item.title}`.slice(0, 120),
        ...(bot === undefined ? {} : { route: { provider: BOT_ROUTE, model: bot.id } }),
      })
    }
    await this.ensureDir(item.repo)
    await this.write(item.path, blankSheet({
      pr: key, title: item.title, author: item.author, url: item.url, base: base ?? '', head, round, session,
      role: 'author', branch: item.branch, tree: tree.path, read: readAt, ...(old?.rules ? { rules: old.rules } : {}),
    }))
    this.dirty.delete(key)
    const before = await this.trackedChanges(tree.path) ?? ''
    this.active.set(session, { key, repo: tree.path, startedAt: this.now(), status: before, path: item.path })
    // The request id is new each attempt: a retry in the same session (same round and head after a
    // failed turn) would otherwise be taken as a resend and dropped, leaving the run waiting on no turn.
    await sessions.send(session, respondMessage({
      slug, number: item.number, title: item.title, url: item.url, branch: item.branch, base: base ?? '?', baseRef, head, round,
      // A bot's persona is its own way of working; how to sort the comments comes with every round.
      sheet: item.path, stat: stat?.stdout ?? '', diff: diff?.stdout ?? '', waiting: items, rules, analysis: defaultResponse(),
      ...(previous === undefined ? {} : { previous }),
      ...(note === undefined ? {} : { note }),
    }), `respond-${key}-${round}-${head.slice(0, 12)}-${randomUUID().slice(0, 8)}`).catch((error: unknown) => {
      this.active.delete(session)
      throw error
    })
    await this.stopSent(key, session, sessions)
    this.step(key, 'analyzing')
  }

  /**
   * Fix what the response sheet picked: the sheet becomes `fixing` and the session is told which
   * items. The turn's end marks it fixed.
   */
  async fix(path: string): Promise<SheetReply> {
    await this.checkPath(path)
    return this.locked(path, async () => {
      const sheet = await this.current(path)
      if (sheet.role !== 'author') throw new Error('Only a response sheet is fixed')
      if (sheet.session === undefined || sheet.tree === undefined) throw new Error('This sheet has no session working on its branch')
      if (sheet.status === 'analyzing' || sheet.status === 'submitted') throw new Error(sheet.status === 'analyzing' ? 'The sheet is not finished yet' : 'This response was posted already')
      const key = sheet.pr
      if (this.running.has(sheet.session) || this.active.has(sheet.session) || this.job(key) !== undefined) throw new Error('Its session is busy now')
      if (!sheet.findings.some((item) => item.checked && item.severity === 'must')) throw new Error(`Nothing to fix: pick items under ${localized({ zh: '修改', en: 'Fix' })} first`)
      const sessions = this.host.sessions()
      if (sessions === undefined) throw new Error('DSH sessions are unavailable')
      this.begin(key, true)
      const run = this.runs.get(key)
      if (run !== undefined) run.mode = 'fix'
      this.step(key, 'session')
      const written = await this.write(path, { ...sheet, status: 'fixing' })
      this.active.set(sheet.session, { key, repo: sheet.tree, startedAt: this.now(), status: '', path, fix: true })
      try {
        await sessions.send(sheet.session, fixMessage(sheet, path), `respond-fix-${randomUUID()}`)
      } catch (error) {
        this.active.delete(sheet.session)
        await this.write(path, { ...sheet, status: sheet.status })
        this.fail(key, message(error))
        throw error
      }
      this.step(key, 'analyzing')
      return { version: written.version, ...(written.sheet === undefined ? {} : { sheet: written.sheet }) }
    })
  }

  /** What posting a response would do, from the tree as it is and the remote's branch. */
  private async respondPreview(sheet: Sheet, repo: string): Promise<{ preview: ResponsePreview; remote?: string }> {
    const remote = (await this.slugOf(repo))?.remote
    const tree = sheet.tree
    const branch = sheet.branch ?? ''
    if (tree === undefined || remote === undefined || !REF.test(branch)) {
      return { preview: buildResponse(sheet, { commits: [], behind: 0, dirty: false }), ...(remote === undefined ? {} : { remote }) }
    }
    const read = { read: true, timeoutMs: 30_000 }
    const current = (await this.git(['symbolic-ref', '--quiet', 'HEAD'], tree, read).catch(() => undefined))?.stdout.trim().replace(/^refs\/heads\//, '')
    if (current !== branch) throw new Error(`${tree} is no longer on ${branch}`)
    const upstream = `${remote}/${branch}`
    await this.git(['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${upstream}`], tree, { timeoutMs: 120_000 }).catch(() => undefined)
    const known = (await this.git(['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`], tree, read).catch(() => undefined))?.code === 0
    const [log, behind, dirty] = await Promise.all([
      this.git(['log', '--format=%H%x09%s', known ? `${upstream}..HEAD` : 'HEAD', '-n', '50'], tree, read).catch(() => undefined),
      known ? this.git(['rev-list', '--count', `HEAD..${upstream}`], tree, read).catch(() => undefined) : undefined,
      this.trackedChanges(tree),
    ])
    const commits = known
      ? (log?.stdout ?? '').split('\n').filter(Boolean).map((line) => ({ sha: line.slice(0, line.indexOf('\t')), subject: line.slice(line.indexOf('\t') + 1) }))
      : []
    return { preview: buildResponse(sheet, { commits, behind: Number(behind?.stdout.trim() ?? 0) || 0, dirty: dirty !== '' }), remote }
  }

  /**
   * Post the response the preview showed: push the new commits, reply on each picked thread (a
   * reply of mine with the same words already there counts), resolve the fixed ones, then one
   * conversation comment. Each step is safe to run again, so a failure part way is retried as a whole.
   */
  private async respondSubmit(path: string, sheet: Sheet): Promise<{ preview: ResponsePreview; posted?: ResponsePosted }> {
    const repo = dirname(dirname(path))
    const { preview, remote } = await this.respondPreview(sheet, repo)
    if (preview.problems.length > 0) return { preview }
    let pushed: string | undefined
    if (preview.commits.length > 0 && remote !== undefined && sheet.tree !== undefined) {
      const result = await this.git(['push', '--quiet', remote, `HEAD:refs/heads/${preview.branch}`], sheet.tree, { timeoutMs: 180_000 })
      if (result.code !== 0) throw new Error(`git push failed: ${result.stderr.trim().split('\n').pop() ?? result.code}`)
      pushed = preview.commits[0]!.sha
    }
    const { slug, number } = parsePr(sheet.pr)
    const conversation = await this.github.conversation(slug, number)
    const me = conversation.viewer.toLowerCase()
    const said = (comments: ReadonlyArray<{ author: string; body: string }>, body: string): boolean =>
      comments.some((comment) => comment.author.toLowerCase() === me && comment.body.trim() === body.trim())
    let replies = 0
    let resolved = 0
    for (let at = 0; at < preview.replies.length; at += REPLIES_PARALLEL) {
      await Promise.all(preview.replies.slice(at, at + REPLIES_PARALLEL).map(async (reply) => {
        const thread = conversation.threads.find((entry) => entry.id === reply.thread)
        if (thread === undefined) return
        if (reply.body !== '') {
          if (!said(thread.comments, reply.body)) await this.github.reply(reply.thread, reply.body)
          replies++
        }
        if (reply.resolve && !thread.resolved) {
          await this.github.resolve(reply.thread)
          resolved++
        }
      }))
    }
    if (preview.comment !== '' && !said(conversation.comments, preview.comment)) await this.github.comment(slug, number, preview.comment)
    // Called holding the sheet's lock: no edit lands between reading it and this.
    await this.write(path, { ...sheet, status: 'submitted', submitted: new Date(this.now()).toISOString() })
    this.authored.invalidate()
    return { preview, posted: { ...(pushed === undefined ? {} : { pushed }), replies, resolved, ...(sheet.url === undefined ? {} : { url: sheet.url }) } }
  }

  // ── The sheet ───────────────────────────────────────────────────────────

  /** A sheet path inside a registered repository, or a refusal. */
  private async checkPath(path: string): Promise<string> {
    if (!SHEET_PATH.test(path)) throw new Error('not a review sheet')
    const repo = dirname(dirname(path))
    const groups = await this.host.repos()
    if (!groups.some((group) => pathKey(group.key) === pathKey(repo))) throw new Error('the sheet is not in a registered repository')
    return path
  }

  private async write(path: string, sheet: Sheet): Promise<Cached> {
    await writeText(path, serializeSheet(sheet))
    if (sheet.session !== undefined) this.bySession.set(sheet.session, { repo: dirname(dirname(path)), path, ...(sheet.role === 'author' ? { author: true } : {}) })
    this.sheets.delete(path)
    return this.load(path)
  }

  /** One change at a time per sheet: each reads the file as it is now. */
  private locked<T>(path: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(body)
    this.locks.set(path, next)
    void next.catch(() => {}).finally(() => { if (this.locks.get(path) === next) this.locks.delete(path) })
    return next
  }

  async sheet(path: string, since?: string): Promise<SheetReply> {
    await this.checkPath(path)
    const cached = await this.load(path).catch(() => undefined)
    if (cached === undefined) return { version: '', error: 'The sheet does not exist yet' }
    if (since !== undefined && since === cached.version) return { version: cached.version, unchanged: true }
    const item = cached.sheet === undefined ? undefined : await this.find(cached.sheet.pr)
    return {
      version: cached.version,
      ...(cached.sheet === undefined ? {} : { sheet: cached.sheet }),
      ...(cached.error === undefined ? {} : { error: cached.error }),
      ...(item === undefined ? {} : { item }),
    }
  }

  /** The UI's edits; `key` opens a sheet for a comment of mine on a pull request that has none yet. */
  async patch(path: string, ops: Parameters<typeof applyOps>[1], key?: string): Promise<SheetReply> {
    await this.checkPath(path)
    const adding = ops.length > 0 && ops.every((op) => op.op === 'add')
    // Read before the lock: finding the card can take a GitHub read.
    const opened = adding && key !== undefined && !(await exists(path)) ? await this.opening(path, key) : undefined
    return this.locked(path, async () => {
      const current: { sheet?: Sheet; error?: string } = opened !== undefined && !(await exists(path)) ? { sheet: opened } : await this.load(path)
      if (current.sheet === undefined) throw new Error(current.error ?? 'The sheet cannot be read')
      if (adding) {
        if (current.sheet.role === 'author') throw new Error('Your own pull request takes no review comments here')
        if (current.sheet.status === 'analyzing') throw new Error('The analysis is writing the sheet: comment once it is done')
        if (current.sheet.status === 'submitted') throw new Error('This review is posted already')
      }
      if (opened !== undefined) await this.ensureDir(dirname(dirname(path)))
      const written = await this.write(path, applyOps(current.sheet, ops))
      return { version: written.version, ...(written.sheet === undefined ? {} : { sheet: written.sheet }) }
    })
  }

  /** A sheet for a pull request nobody analysed yet, at the head its diff shows: ready for my comments. */
  private async opening(path: string, key: string): Promise<Sheet> {
    const item = await this.find(key)
    if (item === undefined) throw new Error('This pull request is no longer on the board')
    if (pathKey(item.path) !== pathKey(path)) throw new Error('This sheet is not the pull request\'s')
    if (item.own === true) throw new Error('Your own pull request takes no review comments here')
    if (!/^[0-9a-f]{7,64}$/i.test(item.head)) throw new Error('The pull request has no head commit')
    return blankSheet({ pr: key, title: item.title, author: item.author, url: item.url, base: item.base, head: item.head, round: 1, status: 'ready' })
  }

  private async current(path: string): Promise<Sheet> {
    await this.checkPath(path)
    const cached = await this.load(path)
    if (cached.sheet === undefined) throw new Error(cached.error ?? 'The sheet cannot be read')
    return cached.sheet
  }

  /** Send the sheet's session a message: fix what it wrote (even a sheet that cannot be read), apply new rules. */
  async tell(path: string, text: string): Promise<{ sent: boolean }> {
    await this.checkPath(path)
    const { session } = await this.load(path)
    const sessions = this.host.sessions()
    if (session === undefined || sessions === undefined) throw new Error('This sheet has no session to tell')
    if (text.trim() === '') throw new Error('Nothing to send')
    await sessions.send(session, text.trim(), `review-tell-${randomUUID()}`)
    return { sent: true }
  }

  private complete(system: string, user: string): Promise<string> {
    return this.generate(system, [{ role: 'user', text: user }])
  }

  /** A helper model's answer to a conversation; `onText` hears it as it streams. */
  private async generate(system: string, turns: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>, onText?: (text: string) => void, on?: Route): Promise<string> {
    const llm = this.host.llm()
    const route = on ?? await this.host.helper()
    if (llm === undefined || route === undefined) throw new Error(localized({ zh: 'No helper model: pick one in 设置 → Agent Hub → 审核', en: 'No helper model: pick one in Settings → Agent Hub → Review' }))
    const text = (await replyText(llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      // DSH reads where an assistant message came from (to replay or drop provider state): this route's model.
      messages: turns.map((turn) => ({
        role: turn.role,
        content: [{ type: 'text', text: turn.text }],
        ...(turn.role === 'assistant' ? { source: { kind: 'model', provider: route.provider, model: route.model } } : {}),
      })),
      maxTokens: 4096,
      purpose: 'agent-hub-review',
      signal: AbortSignal.timeout(120_000),
    }), onText)).trim()
    if (text === '') throw new Error('The helper model gave no answer')
    return text
  }

  /** The finding's file at the pull request's head, around its line, numbered; and its part of the diff. */
  private async context(path: string, sheet: Sheet, finding: Sheet['findings'][number]): Promise<{ hunk: string; file: string }> {
    if (finding.path === undefined) return { hunk: '', file: '' }
    const main = dirname(dirname(path))
    const { number } = parsePr(sheet.pr)
    // A response's code is its tree's branch; a review's, the pull request's ref.
    const own = sheet.role === 'author' && sheet.tree !== undefined
    const repo = own ? sheet.tree! : main
    const ref = own ? 'HEAD' : reviewRef(number)
    const remote = await this.slugOf(main)
    const baseRef = remote !== undefined && REF.test(sheet.base) ? `refs/remotes/${remote.remote}/${sheet.base}` : `${ref}~1`
    const [diff, show] = await Promise.all([
      this.git(['diff', `${baseRef}...${ref}`, '--', finding.path], repo, { read: true, timeoutMs: 30_000, maxBytes: 256 << 10, allowPartial: true }).catch(() => undefined),
      this.git(['show', `${ref}:${finding.path}`], repo, { read: true, timeoutMs: 30_000, maxBytes: 4 << 20, allowPartial: true }).catch(() => undefined),
    ])
    const lines = (show?.code === 0 ? show.stdout : '').split('\n')
    const center = finding.line ?? 1
    const from = Math.max(1, (finding.start ?? center) - 80)
    const to = Math.min(lines.length, center + 80)
    const file = lines.slice(from - 1, to).map((line, index) => `${String(from + index).padStart(5)}  ${line}`).join('\n')
    return { hunk: (diff?.stdout ?? '').slice(0, 20_000), file }
  }

  async ask(path: string, id: string, question: string): Promise<SheetReply> {
    if (question.trim() === '') throw new Error('Ask a question first')
    const sheet = await this.current(path)
    const finding = sheet.findings.find((item) => item.id === id)
    if (finding === undefined) throw new Error(`no finding ${id} in the sheet`)
    const { hunk, file } = await this.context(path, sheet, finding)
    const prompt = askPrompt({ finding, question, hunk, file, ...(finding.path === undefined ? {} : { path: finding.path }) })
    const answer = await this.complete(prompt.system, prompt.user)
    return this.locked(path, async () => {
      const latest = await this.current(path)
      const note = `### ${id} · ${question.trim().replace(/\s+/g, ' ')}\n\n${answer}`
      const written = await this.write(path, { ...latest, notes: [latest.notes.trim(), note].filter(Boolean).join('\n\n') })
      return { version: written.version, ...(written.sheet === undefined ? {} : { sheet: written.sheet }) }
    })
  }

  async rewrite(path: string, id: string, hint?: string): Promise<SheetReply> {
    const sheet = await this.current(path)
    const finding = sheet.findings.find((item) => item.id === id)
    if (finding === undefined) throw new Error(`no finding ${id} in the sheet`)
    const prompt = sheet.role === 'author'
      ? replyPrompt({ text: finding.text, en: finding.en, ...(hint === undefined ? {} : { hint }) })
      : rewritePrompt({ finding, style: this.host.settings().style, ...(hint === undefined ? {} : { hint }) })
    const text = (await this.complete(prompt.system, prompt.user)).replace(/^(["“'])([\s\S]*)(["”'])$/, '$2').trim()
    return this.patch(path, [{ op: 'en', id, text }])
  }

  /**
   * A comment of mine as a bot makes it (translated, polished): its persona and the comment style
   * on its model, the lines it is on for context. Only the text comes back: nothing is written, and
   * no session sees it.
   */
  async compose(key: string, botId: string, text: string, target?: ExplainTarget, threadId?: string): Promise<string> {
    if (text.trim() === '') throw new Error('Write the comment first')
    if (!this.host.bots().some((profile) => profile.id === botId)) throw new Error(`The bot "${botId}" is unavailable`)
    if (await this.find(key) === undefined) throw new Error('This pull request is no longer on the board')
    const where = target !== undefined && typeof target.path === 'string' && typeof target.diff === 'string' ? target : undefined
    if (threadId !== undefined) {
      const thread = (await this.threads(key)).find((entry) => entry.id === threadId)
      if (thread === undefined) throw new Error('This review thread is no longer on the pull request')
      const author = (await this.find(key))?.own === true
      const answer = await this.botText(botId, (persona) => threadReplyPrompt({
        persona, text, thread: thread.comments, author, ...(where === undefined ? {} : { path: where.path, diff: where.diff }),
      }))
      return answer.replace(/^(["“'])([\s\S]*)(["”'])$/, '$2').trim()
    }
    const answer = await this.botText(botId, (persona) => composePrompt({
      persona, style: this.host.settings().style, text,
      ...(where === undefined ? {} : { path: where.path, diff: where.diff, ...(where.start === undefined ? {} : { start: where.start }), ...(where.end === undefined ? {} : { end: where.end }) }),
    }))
    return answer.replace(/^(["“'])([\s\S]*)(["”'])$/, '$2').trim()
  }

  /** A pull request's review threads, every one, resolved too: the diff draws them on their lines. */
  async threads(key: string, fresh = false): Promise<PullThread[]> {
    return (await this.talk(key, fresh)).threads
  }

  /**
   * A pull request's review threads and, someone else's, what others said outside them since my
   * review was submitted. Read again after a minute, or when asked fresh.
   */
  private async talk(key: string, fresh = false): Promise<Talk> {
    const now = this.now()
    const kept = this.talks.get(key)
    if (!fresh && kept !== undefined && now - kept.at < THREADS_TTL_MS) return kept.talk
    const { item, sheet } = await this.pullOf(key)
    const { slug, number } = parsePr(key)
    const talk = this.github.conversation(slug, number).then((conversation) => talkOf(conversation, item, sheet))
    // Those past their age are read again anyway: not kept meanwhile.
    for (const [other, entry] of this.talks) if (now - entry.at >= THREADS_TTL_MS) this.talks.delete(other)
    this.talks.set(key, { at: now, talk })
    talk.catch(() => { if (this.talks.get(key)?.talk === talk) this.talks.delete(key) })
    return talk
  }

  /** Caught up with what followed my submitted review: only what comes after now (and past the head now) is news. */
  async markSeen(key: string, scope: ReviewScope = 'mine'): Promise<ReviewState> {
    const item = await this.find(key)
    if (item === undefined) throw new Error('This pull request is no longer on the board')
    if (item.phase !== 'submitted' || item.own === true) throw new Error('Only a submitted review is followed up')
    await this.locked(item.path, async () => {
      const sheet = await this.current(item.path)
      if (sheet.status !== 'submitted') throw new Error('This review is not submitted')
      await this.write(item.path, { ...sheet, read: new Date(this.now()).toISOString(), ...(/^[0-9a-f]{7,64}$/i.test(item.head) ? { seen: item.head } : {}) })
    })
    return this.state(false, scope)
  }

  /** Reply on a review thread, now: no sheet, no preview. The threads come back as they are after it. */
  async replyThread(key: string, threadId: string, body: string): Promise<PullThread[]> {
    if (body.trim() === '') throw new Error('Write the reply first')
    if (!(await this.threads(key)).some((thread) => thread.id === threadId)) throw new Error('This review thread is no longer on the pull request')
    const own = (await this.find(key))?.own === true
    await this.github.reply(threadId, body.trim())
    // What waits on me changed: the list is read again for the lane's count, its last value kept meanwhile (the card stays findable).
    if (!own) this.sent?.list.invalidate()
    const [list] = await Promise.all([this.threads(key, true), own ? this.authored.get(true).catch(() => undefined) : undefined])
    return list
  }

  // ── Merging my own pull request ─────────────────────────────────────────

  /** The pull request behind a card of mine; anyone else's is not merged from here. */
  private async ownPr(key: string): Promise<{ slug: string; number: number }> {
    const item = await this.find(key)
    if (item === undefined) throw new Error('This pull request is no longer on the board')
    if (item.own !== true) throw new Error('Only your own pull requests can be merged here')
    return parsePr(key)
  }

  async mergeState(key: string): Promise<MergeState> {
    const { slug, number } = await this.ownPr(key)
    const { id: _id, ...state } = await this.github.mergeState(slug, number)
    return state
  }

  /** Merge now, or by auto-merge; GitHub's word after it comes back, and the lane's list is read again behind it. */
  async merge(key: string, method: MergeMethod, auto: boolean, head?: string): Promise<MergeState> {
    const { slug, number } = await this.ownPr(key)
    const { id } = await this.github.mergeState(slug, number)
    await this.github.merge(id, method, auto, head)
    const { id: _id, ...state } = await this.github.mergeState(slug, number)
    void this.authored.get(true).catch(() => {})
    return state
  }

  async cancelAutoMerge(key: string): Promise<MergeState> {
    const { slug, number } = await this.ownPr(key)
    const { id } = await this.github.mergeState(slug, number)
    await this.github.cancelAutoMerge(id)
    const { id: _id, ...state } = await this.github.mergeState(slug, number)
    return state
  }

  /** A draft again, or ready for review; the lane's list of mine is read again behind it. */
  async setDraft(key: string, draft: boolean): Promise<MergeState> {
    const { slug, number } = await this.ownPr(key)
    const { id } = await this.github.mergeState(slug, number)
    await this.github.setDraft(id, draft)
    const { id: _id, ...state } = await this.github.mergeState(slug, number)
    void this.authored.get(true).catch(() => {})
    return state
  }

  /**
   * One answer from a bot outside any session (a comment, a new ticket's draft): `brief` gets its
   * persona, its model answers (the helper model when it only answers conversations).
   */
  async botText(botId: string, brief: (persona: string) => { system: string; user: string }): Promise<string> {
    const bot = this.host.bots().find((profile) => profile.id === botId)
    if (bot === undefined) throw new Error(`The bot "${botId}" is unavailable`)
    const route = await this.botRoute(bot)
    const prompt = brief(personaText(bot))
    return (await this.generate(prompt.system, [{ role: 'user', text: prompt.user }], undefined, route)).trim()
  }

  // ── The diff ────────────────────────────────────────────────────────────

  /** A card's pull request and its sheet. */
  private async pullOf(key: string): Promise<{ item: ReviewItem; sheet?: Sheet }> {
    const item = await this.find(key)
    if (item === undefined) throw new Error('This pull request is not on the board')
    const sheet = (await this.load(item.path).catch(() => undefined))?.sheet
    return { item, ...(sheet === undefined ? {} : { sheet }) }
  }

  /**
   * What the diff compares: the merge base with the base branch, and the head the sheet was analysed
   * at (the remote one before any analysis). A commit this clone lacks is fetched without a ref of
   * its own: nothing checked out moves, no branch is made.
   */
  private async commits(item: ReviewItem, sheet: Sheet | undefined): Promise<{ head: string; base: string }> {
    const head = sheet?.head || item.head
    if (!/^[0-9a-f]{7,64}$/i.test(head)) throw new Error('The pull request has no head commit')
    const branch = item.base || sheet?.base || ''
    const base = REF.test(branch) ? branch : undefined
    const remote = await this.slugOf(item.repo)
    const baseRef = remote === undefined || base === undefined ? undefined : `refs/remotes/${remote.remote}/${base}`
    const has = async (rev: string): Promise<boolean> =>
      (await this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], item.repo, { read: true, timeoutMs: 15_000 }).catch(() => undefined))?.code === 0
    const [haveHead, haveBase] = await Promise.all([has(head), baseRef === undefined ? true : has(baseRef)])
    if (!haveHead || !haveBase) {
      if (remote === undefined) throw new Error('The repository has no GitHub remote')
      const fetch = async (specs: string[]): Promise<void> => {
        const fetched = await this.git(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote.remote, ...specs], item.repo, { timeoutMs: 180_000 })
        if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr.trim().split('\n').pop() ?? fetched.code}`)
      }
      await fetch([...(haveHead ? [] : [`refs/pull/${item.number}/head`]), ...(haveBase ? [] : [`+refs/heads/${base}:${baseRef}`])])
      // The pull request moved on since its sheet was written: ask for that commit itself.
      if (!await has(head)) {
        await fetch([head]).catch(() => {})
        if (!await has(head)) throw new Error(`Commit ${head.slice(0, 7)} is no longer on the remote`)
      }
    }
    const read = { read: true, timeoutMs: 30_000 }
    const merged = baseRef === undefined ? undefined : (await this.git(['merge-base', baseRef, head], item.repo, read).catch(() => undefined))?.stdout.trim()
    const from = merged || (await this.git(['rev-parse', '--verify', '--quiet', `${head}~1^{commit}`], item.repo, read).catch(() => undefined))?.stdout.trim()
    if (!from) throw new Error('No base to compare the pull request with')
    const full = (await this.git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], item.repo, read)).stdout.trim() || head
    return { head: full, base: from }
  }

  /** The pull request's diff: every file's patch but those held back; `file` reads a held one. */
  async diff(key: string, file?: string): Promise<PullDiff> {
    const { item, sheet } = await this.pullOf(key)
    const id = `${key}@${sheet?.head || item.head}`
    let whole = this.diffs.get(id)
    if (whole === undefined) {
      const reading = this.readDiff(item, sheet)
      whole = reading
      reading.catch(() => { if (this.diffs.get(id) === reading) this.diffs.delete(id) })
    } else this.diffs.delete(id)
    this.diffs.set(id, whole)
    while (this.diffs.size > KEEP_DIFFS) this.diffs.delete(this.diffs.keys().next().value!)
    const pull = await whole
    if (file === undefined) return pull
    const found = pull.files.find((entry) => entry.path === file)
    if (found === undefined) throw new Error(`${file} is not changed in this pull request`)
    const result = await this.git(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-color', '-M', pull.base, pull.head, '--', ...(found.from === undefined ? [] : [found.from]), found.path],
      item.repo, { read: true, timeoutMs: 60_000, maxBytes: FILE_BYTES, allowPartial: true })
    if (result.code !== 0 && !result.truncated && !result.overflow) throw new Error(result.stderr.trim() || 'git diff failed')
    const cut = result.truncated === true || result.overflow === true
    const { held: _held, ...rest } = found
    return { ...pull, files: [{ ...rest, patch: result.stdout, ...(cut ? { truncated: true } : {}) }] }
  }

  private async readDiff(item: ReviewItem, sheet: Sheet | undefined): Promise<PullDiff> {
    const { head, base } = await this.commits(item, sheet)
    const range = ['--no-ext-diff', '--no-color', '-M', base, head]
    const read = { read: true, timeoutMs: 60_000 }
    const [names, numbers] = await Promise.all([
      this.git(['diff', '-z', '--name-status', ...range], item.repo, read),
      this.git(['diff', '-z', '--numstat', ...range], item.repo, read),
    ])
    if (names.code !== 0 || numbers.code !== 0) throw new Error((names.stderr || numbers.stderr).trim() || 'git diff failed')
    const files: PullFile[] = parseCommitFiles(names.stdout, numbers.stdout).map((entry) => ({
      path: entry.path, ...(entry.from ? { from: entry.from } : {}), code: entry.code, added: entry.added, deleted: entry.deleted, binary: entry.binary,
    }))
    for (const entry of files) {
      if (entry.binary) continue
      if (GENERATED.test(entry.path)) entry.held = 'generated'
      else if (entry.added + entry.deleted > LARGE_LINES) entry.held = 'large'
    }
    const shown = files.filter((entry) => entry.held === undefined)
    if (shown.length === 0) return { base, head, files }
    const excluded = files.filter((entry) => entry.held !== undefined).flatMap((entry) => [entry.path, ...(entry.from === undefined ? [] : [entry.from])])
    const patch = await this.git(['diff', ...range, ...(excluded.length === 0 ? [] : ['--', '.', ...excluded.map((path) => `:(exclude,literal)${path}`)])],
      item.repo, { ...read, maxBytes: DIFF_BYTES, allowPartial: true })
    const cut = patch.truncated === true || patch.overflow === true
    if (patch.code !== 0 && !cut) throw new Error(patch.stderr.trim() || 'git diff failed')
    const parts = splitPatches(patch.stdout, shown.length, cut)
    shown.forEach((entry, index) => {
      const part = parts[index]
      if (part === undefined) entry.held = 'large'
      else entry.patch = part
    })
    return { base, head, files }
  }

  // ── Explanations ────────────────────────────────────────────────────────

  private explainFile(book: Pick<Book, 'repo' | 'number'>): string {
    return join(book.repo, REVIEW_DIR, `pr-${book.number}.explain.json`)
  }

  /** A pull request's explanations at the head its diff shows, read from disk the first time. */
  private async book(key: string): Promise<Book> {
    const { item } = await this.pullOf(key)
    const pull = await this.diff(key)
    for (let hit = this.books.get(key); hit !== undefined; hit = this.books.get(key)) {
      const book = await hit.catch(() => undefined)
      // Another call replaced it meanwhile: look at that one.
      if (this.books.get(key) !== hit) continue
      if (book !== undefined && book.head === pull.head && book.base === pull.base) return book
      break
    }
    const loading = (async (): Promise<Book> => {
      const book: Book = { key, repo: item.repo, number: item.number, head: pull.head, base: pull.base, version: 0, items: new Map() }
      try {
        const saved = JSON.parse(await readFile(this.explainFile(book), 'utf8')) as { head?: unknown; base?: unknown; items?: unknown }
        if (saved.head === pull.head && saved.base === pull.base && Array.isArray(saved.items)) {
          for (const entry of saved.items as Entry[]) {
            if (typeof entry?.id !== 'string' || typeof entry.diff !== 'string' || !Array.isArray(entry.turns)) continue
            const turns = entry.turns.filter((turn) => typeof turn?.answer === 'string' && turn.answer !== '').map((turn) => ({ ...turn, done: true }))
            if (turns.length > 0) book.items.set(entry.id, { ...entry, turns })
          }
        }
      } catch {
        // None yet, or unreadable: start afresh.
      }
      return book
    })()
    this.books.set(key, loading)
    return loading
  }

  /** What a client sees of an entry: no diff, no prompt, the turns copied. */
  private static view(entry: Entry): Explanation {
    return {
      id: entry.id, path: entry.path, kind: entry.kind,
      ...(entry.start === undefined ? {} : { start: entry.start }),
      ...(entry.end === undefined ? {} : { end: entry.end }),
      turns: entry.turns.map((turn) => ({ ...turn })),
    }
  }

  async explained(key: string, since?: string): Promise<Explained> {
    const book = await this.book(key)
    const version = `${this.boot}.${book.version}`
    if (since === version) return { head: book.head, version, items: [], unchanged: true }
    return { head: book.head, version, items: [...book.items.values()].map(ReviewService.view) }
  }

  /** Explain part of the diff, or ask a follow-up; the answer streams into the entry, the entry comes back at once. */
  async explain(key: string, input: { target?: ExplainTarget; id?: string; question?: string; lang: ExplainLang }): Promise<Explanation> {
    const book = await this.book(key)
    let entry: Entry | undefined
    if (input.id !== undefined) {
      entry = book.items.get(input.id)
      if (entry === undefined) throw new Error('This explanation is gone; explain the change again')
      const question = input.question?.trim() ?? ''
      if (question === '') throw new Error('Ask a question first')
      if (entry.turns.some((turn) => !turn.done)) throw new Error('Still answering the last question')
      if (entry.turns[0]?.error !== undefined) throw new Error('Explain the change again first')
      // A follow-up that failed is asked again rather than kept.
      if (entry.turns.length > 1 && entry.turns.at(-1)?.error !== undefined) entry.turns.pop()
      entry.turns.push({ question, answer: '', done: false })
    } else {
      const target = input.target
      if (target === undefined || typeof target.path !== 'string' || target.path === '' || !EXPLAIN_KINDS.includes(target.kind) || typeof target.diff !== 'string' || target.diff.trim() === '') {
        throw new Error('Nothing to explain')
      }
      const line = (value: unknown): number | undefined => (Number.isInteger(value) && (value as number) > 0 ? value as number : undefined)
      const start = line(target.start)
      const end = line(target.end)
      const diff = target.diff.slice(0, EXPLAIN_DIFF_CHARS)
      const anchor = anchorOf({ path: target.path, kind: target.kind, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) })
      const id = createHash('sha1').update(`${book.head}\n${book.base}\n${anchor}\n${diff}`).digest('hex').slice(0, 16)
      entry = book.items.get(id)
      const first = entry?.turns[0]
      // Answered, or answering: the same entry. A first answer that failed is tried again.
      if (entry !== undefined && first !== undefined && first.error === undefined) return ReviewService.view(entry)
      entry ??= { id, path: target.path, kind: target.kind, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), diff, turns: [] }
      entry.turns = [{ answer: '', done: false }]
      book.items.set(id, entry)
    }
    book.version++
    void this.answer(book, entry, input.lang)
    return ReviewService.view(entry)
  }

  private async answer(book: Book, entry: Entry, lang: ExplainLang): Promise<void> {
    const turn = entry.turns.at(-1)!
    try {
      entry.prompt ??= await this.explainContext(book, entry, lang)
      const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: entry.prompt.user }]
      entry.turns.forEach((past, index) => {
        if (index > 0) turns.push({ role: 'user', text: past.question ?? '' })
        if (past !== turn) turns.push({ role: 'assistant', text: past.answer })
      })
      const bot = this.explainBot()
      const route = bot === undefined ? undefined : await this.botRoute(bot)
      await this.generate(entry.prompt.system, turns, (text) => {
        turn.answer += text
        book.version++
      }, route)
      turn.answer = turn.answer.trim()
    } catch (error) {
      turn.error = message(error)
    }
    turn.done = true
    book.version++
    await this.saveBook(book).catch((error: unknown) => this.host.log(`review: explanations not saved: ${message(error)}`))
  }

  /** The prompt for an entry: the pull request's intent, the diff, the file around it, and where the names it touches are used. */
  private async explainContext(book: Book, entry: Entry, lang: ExplainLang): Promise<{ system: string; user: string }> {
    const { item, sheet } = await this.pullOf(book.key).catch(() => ({ item: undefined, sheet: undefined }))
    const read = { read: true, timeoutMs: 30_000, allowPartial: true }
    const show = await this.git(['show', `${book.head}:${entry.path}`], book.repo, { ...read, maxBytes: 4 << 20 }).catch(() => undefined)
    const lines = show?.code === 0 ? show.stdout.split('\n') : []
    let excerpt = ''
    if (lines.length > 0) {
      const from = entry.kind === 'file' ? 1 : Math.max(1, (entry.start ?? 1) - 60)
      const to = Math.min(lines.length, entry.kind === 'file' ? 400 : (entry.end ?? entry.start ?? 1) + 60)
      excerpt = lines.slice(from - 1, to).map((text, index) => `${String(from + index).padStart(5)}  ${text}`).join('\n')
    }
    const uses: string[] = []
    for (const name of symbolsOf(entry.diff)) {
      const found = await this.git(['grep', '-n', '-w', '-I', '-F', '--max-count=3', '-e', name, book.head, '--'], book.repo, { ...read, maxBytes: 64 << 10 }).catch(() => undefined)
      const hits = (found?.stdout ?? '').split('\n').filter(Boolean).map((hit) => hit.startsWith(`${book.head}:`) ? hit.slice(book.head.length + 1) : hit)
        .filter((hit) => {
          const match = /^(.*?):(\d+):/.exec(hit)
          if (match === null) return false
          const at = Number(match[2])
          return !(match[1] === entry.path && entry.start !== undefined && at >= entry.start && at <= (entry.end ?? entry.start))
        })
        .slice(0, 8)
        .map((hit) => (hit.length > 220 ? `${hit.slice(0, 220)}…` : hit))
      if (hits.length > 0) uses.push(`# ${name}`, ...hits)
      if (uses.length > 40) break
    }
    const label = entry.kind === 'file'
      ? `\`${entry.path}\` (the whole file)`
      : `\`${entry.path}\` ${entry.start === undefined ? '' : entry.end === undefined || entry.end === entry.start ? `line ${entry.start}` : `lines ${entry.start}-${entry.end}`}`.trim()
    const bot = this.explainBot()
    const prompt = explainPrompt({
      lang,
      title: sheet?.title || item?.title || book.key,
      overview: (sheet?.overview ?? '').slice(0, 4000),
      path: entry.path,
      label,
      diff: entry.diff,
      excerpt,
      uses: uses.join('\n'),
      guide: this.host.settings().explain ?? '',
    })
    // The bot's persona leads: it says who explains, the prompt what to explain.
    return bot === undefined ? prompt : { ...prompt, system: `${personaText(bot)}\n\n${prompt.system}` }
  }

  /** The bot set to explain changes; undefined when none is set or it no longer exists. */
  private explainBot(): AgentProfile | undefined {
    const id = this.host.settings().explainBot?.trim() ?? ''
    return id === '' ? undefined : this.host.bots().find((profile) => profile.id === id)
  }

  /** Where a bot answers one request outside a session. */
  private async botRoute(bot: AgentProfile): Promise<Route> {
    const route = this.host.botRoute === undefined ? await this.host.helper() : await this.host.botRoute(bot)
    if (route === undefined) throw new Error(`The bot "${bot.id}" has no model that can answer here`)
    return route
  }

  /** Answered turns, kept beside the sheet: reopening costs nothing, even after a restart. */
  private async saveBook(book: Book): Promise<void> {
    const items = [...book.items.values()].map((entry) => ({
      id: entry.id, path: entry.path, kind: entry.kind,
      ...(entry.start === undefined ? {} : { start: entry.start }),
      ...(entry.end === undefined ? {} : { end: entry.end }),
      diff: entry.diff,
      turns: entry.turns.filter((turn) => turn.done && turn.error === undefined && turn.answer !== '').map(({ question, answer }) => ({ ...(question === undefined ? {} : { question }), answer, done: true })),
    })).filter((entry) => entry.turns.length > 0)
    await this.ensureDir(book.repo)
    await writeText(this.explainFile(book), JSON.stringify({ head: book.head, base: book.base, items }, null, 1))
  }

  // ── Posting ─────────────────────────────────────────────────────────────

  private async build(sheet: Sheet): Promise<{ preview: ReviewPreview; commit: string }> {
    const { slug, number } = parsePr(sheet.pr)
    const [remote, current, viewer] = await Promise.all([
      this.github.pull(slug, number).catch(() => undefined),
      this.github.commentable(slug, number).catch(() => undefined),
      this.github.viewer().catch(() => undefined),
    ])
    // New commits since the analysis: the review goes on the commit it read, so its lines are that diff's.
    const moved = remote !== undefined && !sameCommit(remote.head, sheet.head)
    const lines = moved ? await this.analysedLines(sheet) : current
    const preview = buildReview(sheet, {
      ...(lines === undefined ? {} : { lines }),
      ...(viewer === undefined ? {} : { viewer }),
      ...(remote === undefined ? {} : { author: remote.author, remoteHead: remote.head }),
    })
    const commit = remote !== undefined && sameCommit(remote.head, sheet.head) ? remote.head : sheet.head
    return { preview, commit }
  }

  /** The commentable lines of the diff the analysis read; undefined when it cannot be read (every finding then joins the body). */
  private async analysedLines(sheet: Sheet): Promise<Map<string, Set<number>> | undefined> {
    const pull = await this.diff(sheet.pr).catch(() => undefined)
    if (pull === undefined || !sameCommit(pull.head, sheet.head)) return undefined
    return new Map(pull.files.map((file) => [file.path, commentableLines(file.patch)]))
  }

  async preview(path: string): Promise<ReviewPreview | ResponsePreview> {
    const sheet = await this.current(path)
    if (sheet.role === 'author') return (await this.respondPreview(sheet, dirname(dirname(path)))).preview
    return (await this.build(sheet)).preview
  }

  /** Post the review (or my response) the preview showed; refused while anything in it is a problem. */
  async submit(path: string): Promise<{ preview: ReviewPreview; posted?: { id: string; url?: string } } | { preview: ResponsePreview; posted?: ResponsePosted }> {
    await this.checkPath(path)
    return this.locked(path, async () => {
      const sheet = await this.current(path)
      if (sheet.role === 'author') return this.respondSubmit(path, sheet)
      const { preview, commit } = await this.build(sheet)
      if (preview.problems.length > 0) return { preview }
      const { slug, number } = parsePr(sheet.pr)
      // Posted already (a retry after a failure on our side): the same body on the same commit.
      const mine = await this.github.myReviews(slug, number).catch(() => [])
      const known = mine.find((review) => sameCommit(review.commit, commit) && review.body.trim() === preview.body.trim())
      const posted = known ?? await this.github.submit(slug, number, reviewPayload(preview, commit))
      await this.write(path, { ...sheet, status: 'submitted', review: posted.id, submitted: new Date(this.now()).toISOString() })
      const repo = dirname(dirname(path))
      void this.git(['update-ref', '-d', reviewRef(number)], repo).catch(() => {})
      if (sheet.session !== undefined) void this.host.sessions()?.archive(sheet.session).catch((error: unknown) => this.host.log(`review session not archived: ${message(error)}`))
      this.requested.invalidate()
      return { preview, posted: { id: posted.id, ...(posted.url === undefined ? {} : { url: posted.url }) } }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const changed of this.runChanges) changed()
    this.jobs.length = 0
  }
}
