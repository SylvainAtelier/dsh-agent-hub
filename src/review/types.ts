/**
 * PR review: the pull requests waiting for my review, each analysed in a session of its own and
 * kept as one review sheet, `<repo>/.reviews/pr-<n>.md`. The sheet is the whole state: what the
 * agent found, what I picked, the decision and summary, the session it belongs to, the review it
 * became. The board's 待我审 lane and the sheet tab beside a session render it; only the host posts
 * to GitHub, after a preview I confirm. Shared by the host and the browser.
 *
 * My own pull requests (the lane's 我的) use the same sheet from the author's side, a response
 * sheet (`role: author`): one item per review comment waiting on me, to fix in code, to answer, or
 * to leave. Its session works in a worktree on the branch: it triages first, then does what I ask,
 * fixing included; the host pushes, replies and resolves after a preview.
 */

export const REVIEW_METHOD = 'agent-hub/review'

/** The folder of review sheets in a repository's main working tree; its own .gitignore ignores it all. */
export const REVIEW_DIR = '.reviews'

/** Where a pull request's checked-out head is kept, never in a working tree: `refs/reviews/pr-<n>`. */
export const reviewRef = (number: number): string => `refs/reviews/pr-${number}`

/** A sheet's file name in {@link REVIEW_DIR}. */
export const sheetName = (number: number): string => `pr-${number}.md`

/** Whether a path names a review sheet: `…/.reviews/pr-<n>.md`. */
export const SHEET_PATH = /(^|[\\/])\.reviews[\\/]pr-(\d+)\.md$/i

export type Decision = 'approve' | 'request-changes' | 'comment'
export const DECISIONS: readonly Decision[] = ['approve', 'request-changes', 'comment']

/** `fixing` and `fixed`: a response sheet's code changes, asked for and done. */
export type SheetStatus = 'analyzing' | 'ready' | 'fixing' | 'fixed' | 'submitted'

/** Whose side a sheet is written from: absent, a reviewer's; `author`, mine answering a review. */
export type SheetRole = 'author'

/** A response sheet reads `must` as 修改 (fix in code) and `nice` as 仅回复 (answer only). */
export type Severity = 'must' | 'nice'

export interface Finding {
  /** F1, F2, …: unique within the sheet. */
  id: string
  severity: Severity
  /** Picked to be posted. */
  checked: boolean
  /** Repository-relative file; absent for a remark on the whole change. */
  path?: string
  /** The (last) line on the pull request's head; `start` opens a range. */
  line?: number
  start?: number
  /** What the agent found, in the analysis language. */
  text: string
  /** The comment as it would be posted. */
  en: string
  /** A response item's review thread (GitHub's node id), replied to there; absent: a review summary or conversation comment. */
  thread?: string
  /** Who wrote the comment it answers. */
  reviewer?: string
}

/** What a response item comes to: a code change, an answer only, or nothing. */
export type Verdict = 'fix' | 'reply' | 'skip'
export const VERDICTS: readonly Verdict[] = ['fix', 'reply', 'skip']
export const verdictOf = (finding: Pick<Finding, 'severity' | 'checked'>): Verdict => (!finding.checked ? 'skip' : finding.severity === 'must' ? 'fix' : 'reply')

/**
 * A comment I wrote on the diff myself: M1, M2, … in the sheet's Mine section. Its `text` is what I
 * typed when a bot rewrote it, `en` what is posted, as written; no model ever analyses it.
 */
export const isMine = (finding: Pick<Finding, 'id'>): boolean => /^M\d+$/.test(finding.id)

export interface Sheet {
  /** `owner/repo#123`. */
  pr: string
  title: string
  author: string
  url?: string
  base: string
  /** The head commit the analysis read; a different remote head means new commits since. */
  head: string
  round: number
  status: SheetStatus
  decision: Decision
  summary: string
  /** The DSH session the analysis runs in. */
  session?: string
  /** The GitHub review it was posted as, and when. */
  review?: string
  submitted?: string
  /** What the change does. */
  overview: string
  findings: Finding[]
  /** Extra rules for this pull request alone. */
  rules: string
  notes: string
  /** Sections the format does not know, kept as written. */
  extra: string
  role?: SheetRole
  /** A response sheet's branch and the working tree its session changes code in. */
  branch?: string
  tree?: string
  /**
   * When its comments were read (ISO): the next round reads what came after. A submitted review's:
   * when I last caught up with what followed it, so only what came later is news.
   */
  read?: string
  /** A submitted review's: the pull request's head when I last caught up; commits past it are news. */
  seen?: string
  /** The tree's head once the fix turn ended. */
  fixed?: string
  /** Pull requests of its stack (`owner/repo#123`) the analysis reads as context, picked by me. */
  context?: string[]
}

/** One edit the sheet's UI makes; the host applies it to the file as it is now. */
export type SheetOp =
  | { op: 'check'; id: string; checked: boolean }
  | { op: 'en'; id: string; text: string }
  | { op: 'decision'; value: Decision }
  | { op: 'summary'; value: string }
  | { op: 'rules'; value: string }
  | { op: 'verdict'; id: string; value: Verdict }
  /** A comment of mine on new-side lines `start..line` of a file: picked, posted with the review. */
  | { op: 'add'; path: string; line: number; start?: number; text: string; en: string }
  /** Drop a comment of mine. */
  | { op: 'remove'; id: string }
  /** The stack's pull requests the analysis reads as context. */
  | { op: 'context'; keys: string[] }

/**
 * Where a card stands: derived from GitHub's list and the sheet, never stored. My own pull
 * requests add `fixing` and `fixed`; `stale` there means comments came that the sheet has not seen.
 * `merged` and `closed`: a submitted review's pull request landed (or was closed) since; its
 * `updatedAt` is then when.
 */
export type ReviewPhase = 'new' | 'analyzing' | 'ready' | 'fixing' | 'fixed' | 'stale' | 'submitted' | 'merged' | 'closed' | 'invalid'

/** A submitted review's pull request is merged or closed: nothing is left to do on it. */
export const landed = (item: Pick<ReviewItem, 'phase'>): boolean => item.phase === 'merged' || item.phase === 'closed'

/** GitHub's review decision on a pull request. */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

export interface ReviewItem {
  /** `owner/repo#123`. */
  key: string
  /** The repository's main working tree. */
  repo: string
  number: number
  title: string
  author: string
  url: string
  draft: boolean
  /** The pull request's branch: a Linear ticket shows through it. */
  branch: string
  /** The branch it merges into. */
  base: string
  /** The remote head now (the sheet's own when GitHub no longer lists it). */
  head: string
  updatedAt: number
  phase: ReviewPhase
  /** The sheet's absolute path. */
  path: string
  /** Still waiting for my review on GitHub. */
  requested: boolean
  /** Not asked of me, but analysed at my asking: listed with those that are while it is open, never analysed in a batch. */
  picked?: boolean
  must: number
  nice: number
  checked: number
  decision?: Decision
  session?: string
  round?: number
  /** Why the sheet cannot be read, or the last analysis start failed. */
  error?: string
  /** The analysis changed tracked files: the working tree needs a look. */
  dirty?: boolean
  /** Waiting for an analysis slot, or starting. */
  queued?: boolean
  /** Its session is answering now. */
  running?: boolean
  /** My own pull request: answered with a response sheet, never in a batch. */
  own?: boolean
  /** Mine: unresolved review threads whose last word is not mine, and how many of them the sheet has not seen. */
  pending?: number
  unseen?: number
  reviewDecision?: ReviewDecision
  /** Mine: its branch is on a fork, so no worktree here can push it. */
  cross?: boolean
  /** Mine: the working tree its response session works in. */
  tree?: string
  /** The open pull request whose branch this one is based on: the one below it in its stack. */
  parent?: string
  /** Submitted, and asked of me again since (changes I requested answered, say). */
  rerequested?: boolean
  /** Submitted (not mine): what followed the review on GitHub; absent while unknown. */
  follow?: FollowUp
}

/**
 * What followed a review I submitted: commits and comments since (or since I last caught up, see
 * {@link Sheet.read}), and where the threads I started stand. Derived from GitHub, never stored.
 */
export interface FollowUp {
  /** Commits past the head I last saw; at least 1 once the head moved, even when they cannot be counted (a rebase). */
  commits: number
  /** Comments by anyone but me (bots too): replies on threads, review summaries, the conversation. */
  comments: number
  /** Who wrote them, first come first. */
  authors: string[]
  /** My review threads by where they stand: answered (the last word not mine), resolved, outdated by later commits, or untouched. */
  mine: { replied: number; resolved: number; outdated: number; open: number }
}

/** Where one thread I started stands, in this order: resolved, answered, its lines changed since, or untouched. */
export type ThreadStand = 'resolved' | 'replied' | 'outdated' | 'open'
export const standOf = (thread: { resolved: boolean; outdated: boolean; replied: boolean }): ThreadStand =>
  thread.resolved ? 'resolved' : thread.replied ? 'replied' : thread.outdated ? 'outdated' : 'open'

/** Something followed a submitted review that I have not caught up with. */
export const followed = (item: Pick<ReviewItem, 'follow'>): boolean =>
  item.follow !== undefined && item.follow.commits + item.follow.comments > 0

/** Whitespace aside, the same text: a posted comment and the finding it came from. */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The finding a thread of mine was posted from: same file, same comment. */
export function findingOfThread<T extends Pick<Finding, 'path' | 'en'>>(thread: Pick<PullThread, 'path' | 'comments'>, findings: readonly T[]): T | undefined {
  const body = thread.comments[0]?.body
  if (body === undefined) return undefined
  const posted = squash(body)
  return findings.find((finding) => finding.path === thread.path && finding.en.trim() !== '' && squash(finding.en) === posted)
}

/** A sheet left `analyzing` with no session answering and nothing queued: its analysis never finished. */
export const stalled = (item: Pick<ReviewItem, 'phase' | 'running' | 'queued'>): boolean =>
  item.phase === 'analyzing' && item.running !== true && item.queued !== true

/** A sheet holding only my own comments: no analysis has run for it yet. */
export const unanalysed = (item: Pick<ReviewItem, 'phase' | 'session' | 'own'>): boolean =>
  item.phase === 'ready' && item.session === undefined && item.own !== true

/**
 * Where a card sorts in its list: 0 wants analysing (new, new commits, unreadable, unfinished, or
 * asked of me again or followed up since I sent it), 1 being analysed or waiting to be sent, 2 sent, 3 sent and merged or closed since.
 */
export const reviewRank = (item: Pick<ReviewItem, 'phase' | 'running' | 'queued' | 'session' | 'own' | 'rerequested' | 'follow'>): number =>
  landed(item) ? 3
    : item.phase === 'submitted' ? (item.rerequested === true || followed(item) ? 0 : 2)
    : item.phase === 'new' || item.phase === 'stale' || item.phase === 'invalid' || stalled(item) || unanalysed(item) ? 0 : 1

/**
 * The steps of one analysis run, in order. A fresh run fetches, reads and opens a session; `again`
 * asks the sheet's live session to look again, so it skips straight to `session`. The last three end it.
 */
export type RunStep = 'queued' | 'fetch' | 'context' | 'session' | 'analyzing' | 'done' | 'failed' | 'cancelled'
/** `fix`: a response sheet's code changes in its session; it goes straight to `analyzing`. */
export type RunMode = 'fresh' | 'again' | 'fix'
export const RUN_END: readonly RunStep[] = ['done', 'failed', 'cancelled']
export const runEnded = (step: RunStep): boolean => RUN_END.includes(step)

/** What a step learned, shown beside it. */
export interface RunInfo {
  head?: string
  files?: number
  added?: number
  removed?: number
  threads?: number
  round?: number
}

export interface RunEntry {
  step: RunStep
  /** When the step began (host ms). */
  at: number
  info?: RunInfo
}

/** One analysis, from the moment it is asked for to its end: the board shows it as it goes. */
export interface ReviewRun {
  key: string
  /** Asked for from the board, not by the daily run. */
  manual: boolean
  mode: RunMode
  step: RunStep
  startedAt: number
  endedAt?: number
  log: RunEntry[]
  error?: string
  /** `stalled`: the session's turn ended with the sheet unfinished; `timeout`: it never reported back; `stopped`: asked to stop (a `cancelled` run that had left the queue). */
  code?: 'stalled' | 'timeout' | 'stopped'
}

/** The last sync: GitHub read, analyses queued. */
export interface SyncRun {
  manual: boolean
  step: 'list' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  /** Pull requests waiting for me, and how many of them it started analysing (absent: it only read the list). */
  found?: number
  /** A sync of the `all` list: every open pull request it found, mine among them. */
  total?: number
  due?: number
  error?: string
}

/** Runs in flight and recently ended; `now` is the host's clock, so elapsed times survive a skewed client. */
export interface ReviewProgress {
  now: number
  sync?: SyncRun
  runs: ReviewRun[]
}

/**
 * Which pull requests the lane lists: `mine` those waiting for my review; `own` those I opened;
 * `all` every open one in the repositories set for review, mine among them (and first).
 */
export type ReviewScope = 'mine' | 'own' | 'all'
export const REVIEW_SCOPES: readonly ReviewScope[] = ['mine', 'own', 'all']
export const scopeOf = (value: unknown): ReviewScope => (value === 'all' || value === 'own' ? value : 'mine')

export interface ReviewBot {
  id: string
  /** A short role description shown in the manual bot picker. */
  description?: string
}

export interface ReviewState {
  /** Repositories are set for review in 设置 → Agent Hub → 审核. */
  enabled: boolean
  /** Those repositories (main working tree paths): the board shows the lane only for them (or all). */
  repos?: string[]
  /** Bots available for a manually started analysis. */
  bots: ReviewBot[]
  /** The bot used when an analysis is started without an explicit choice. */
  defaultBot: string
  /** The bot a comment of mine is processed by unless I pick another; blank: not processed. */
  commentBot?: string
  /** What `items` lists; absent: `mine`. */
  scope?: ReviewScope
  items: ReviewItem[]
  /** How many each scope lists: `own` and `all` once their lists have been read. */
  counts?: { mine: number; own?: number; all?: number }
  /** Days a merged or closed one stays at the list's end (设置 → 审核). */
  keepMerged?: number
  /** When GitHub was last read (ms): the scope's own list. */
  syncedAt?: number
  /** GitHub could not be read: gh missing, signed out, offline. */
  error?: string
  /** A sync is running. */
  syncing: boolean
  progress?: ReviewProgress
  /** Open pull requests stacked with listed ones but not listed themselves: shown in their stacks, asked for like any other. */
  related?: ReviewItem[]
}

/** Pull requests stacked on one another's branches, from each one's parent. */
export interface Stacks {
  /** The bottom of the stack a pull request is in; undefined when nothing is stacked with it. */
  rootOf(key: string): string | undefined
  /**
   * A stack from its bottom, depth first, side branches before the main line (the lowest-numbered
   * child); `level` grows where it forks, so a side branch is a line of its own.
   */
  rows(root: string): Array<{ key: string; level: number }>
  /** What a pull request builds on, nearest first. */
  below(key: string): string[]
  /** What is built on it, in the order of {@link Stacks.rows}. */
  above(key: string): string[]
}

/** The stacks among these pull requests: a parent not among them counts as none. */
export function stacksOf(items: Iterable<Pick<ReviewItem, 'key' | 'number' | 'parent'>>): Stacks {
  const all = [...items]
  const known = new Set(all.map((item) => item.key))
  const parentOf = new Map<string, string>()
  const children = new Map<string, string[]>()
  for (const item of [...all].sort((a, b) => a.number - b.number)) {
    if (item.parent === undefined || item.parent === item.key || !known.has(item.parent)) continue
    parentOf.set(item.key, item.parent)
    children.set(item.parent, [...(children.get(item.parent) ?? []), item.key])
  }
  const below = (key: string): string[] => {
    const out: string[] = []
    const seen = new Set([key])
    for (let at = parentOf.get(key); at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at)
      out.push(at)
    }
    return out
  }
  const rows = (root: string): Array<{ key: string; level: number }> => {
    const out: Array<{ key: string; level: number }> = []
    const seen = new Set<string>()
    const walk = (key: string, level: number): void => {
      if (seen.has(key)) return
      seen.add(key)
      out.push({ key, level })
      // Side branches before the main line: read top down, each sits right above where it forks off.
      const [main, ...side] = children.get(key) ?? []
      for (const child of side) walk(child, level + 1)
      if (main !== undefined) walk(main, level)
    }
    walk(root, 0)
    return out
  }
  return {
    rootOf(key) {
      if (!known.has(key) || (!parentOf.has(key) && !children.has(key))) return undefined
      return below(key).at(-1) ?? key
    },
    rows,
    below,
    above: (key) => rows(key).slice(1).map((row) => row.key),
  }
}

/**
 * Why a review cannot be posted: `dash` a comment uses — or –; `own` approving my own pull request;
 * `body` request changes without a summary; `nothing` nothing to post; `empty` a picked finding
 * without a comment; `analyzing` the analysis is still running; `submitted` already posted.
 */
export type ProblemCode = 'dash' | 'own' | 'body' | 'nothing' | 'empty' | 'analyzing' | 'submitted'
  /** A response: `fixing` its code changes still run; `unfixed` items to fix were never fixed; `behind` the remote branch has commits this one lacks. */
  | 'fixing' | 'unfixed' | 'behind'
export interface ReviewProblem { code: ProblemCode; ids?: string[] }

/** What is worth knowing before posting, but posts anyway: `stale` the pull request has commits the analysis did not read. */
/** `dirty`: a response's tree has changes not committed, so they are not pushed. */
export type WarningCode = 'stale' | 'dirty'
export interface ReviewWarning { code: WarningCode }

/** What would be posted: shown before I confirm. */
export interface ReviewPreview {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  comments: Array<{ id: string; path: string; line: number; start?: number; body: string }>
  /** Picked findings whose line is not part of the diff: they go into the body instead. */
  folded: string[]
  /** Reasons it cannot be posted as it is. */
  problems: ReviewProblem[]
  /** Shown before posting; none of them stops it. */
  warnings: ReviewWarning[]
  /** The head the sheet was analysed at, and the remote one now. */
  head: string
  remoteHead?: string
}

/**
 * What a response posts, shown before I confirm: the branch's new commits pushed, a reply on each
 * picked thread (resolved when it was fixed), and one conversation comment for the rest.
 */
export interface ResponsePreview {
  role: 'author'
  branch: string
  /** Commits on the branch the remote does not have yet. */
  commits: Array<{ sha: string; subject: string }>
  replies: Array<{ id: string; thread: string; path?: string; line?: number; reviewer?: string; body: string; resolve: boolean }>
  /** The summary and the replies to comments outside any thread; empty: none. */
  comment: string
  problems: ReviewProblem[]
  warnings: ReviewWarning[]
}

/** What posting a response did. */
export interface ResponsePosted {
  pushed?: string
  replies: number
  resolved: number
  url?: string
}

/**
 * A review thread on my own pull request, drawn on the diff's lines and answered there: every
 * comment in it, and whether its last word is someone else's (it waits on me).
 */
export interface PullThread {
  /** GitHub's node id: a reply goes to it. */
  id: string
  path: string
  /** Its (last) line on the head now; absent when GitHub no longer places it (outdated). */
  line?: number
  start?: number
  resolved: boolean
  outdated: boolean
  waiting: boolean
  /** Someone else's pull request: I started this thread (a comment of my review). */
  mine?: boolean
  comments: Array<{ id: string; author: string; body: string; at: string; url?: string }>
}

/** A comment outside the review threads: a review's summary, or one on the conversation. */
export interface PullRemark {
  author: string
  body: string
  /** ISO time. */
  at: string
  url?: string
  /** A review's verdict, for a review summary. */
  state?: string
}

/** Where a response session can work: a working tree of the repository, and whether it can switch to the branch now. */
export interface TreeOption {
  path: string
  branch?: string
  main: boolean
  workspaceId?: string
  /** Tracked changes: switching would carry them over, so it is refused. */
  dirty: boolean
}

/** Where my pull request's branch is worked on: the tree on it, or where it could go. */
export interface TreePlaces {
  branch: string
  existing?: { path: string; workspaceId?: string }
  options: TreeOption[]
  /** A fork's branch: nothing here can push it. */
  cross?: boolean
}

/** A response session's working tree: a new one on the branch, or this registered one switched to it. */
export type TreeChoice = { kind: 'new' } | { kind: 'path'; path: string }

/** How a pull request lands on its base: GitHub's names. */
export type MergeMethod = 'SQUASH' | 'MERGE' | 'REBASE'
export const MERGE_METHODS: readonly MergeMethod[] = ['SQUASH', 'MERGE', 'REBASE']

/** GitHub's word on whether a pull request can merge now; see `mergeStateStatus`. */
export type MergeStatus = 'CLEAN' | 'UNSTABLE' | 'HAS_HOOKS' | 'BLOCKED' | 'BEHIND' | 'DIRTY' | 'DRAFT' | 'UNKNOWN'

/** Where my pull request stands on merging: read when its detail opens, and again while something is pending. */
export interface MergeState {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  status: MergeStatus
  /** Conflicts with the base: `UNKNOWN` while GitHub is still working it out. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** The methods the repository allows, in GitHub's order. */
  methods: MergeMethod[]
  /** The method GitHub last saw me use here. */
  preferred?: MergeMethod
  /** Auto-merge can be turned on for it now (the repository allows it and something is still to come). */
  canAuto: boolean
  /** Auto-merge is on: it lands by itself once the requirements are met. */
  auto?: { method: MergeMethod; by: string }
  /** The head's checks, by outcome; skipped and neutral ones count as passed. */
  checks: { passed: number; failed: number; pending: number }
  decision?: ReviewDecision
  head: string
  base: string
  mergedAt?: string
}

export type ReviewRequest =
  | { op: 'state'; fresh?: boolean; scope?: ReviewScope }
  /** Read GitHub now (the scope's list); starts no analysis. */
  | { op: 'sync'; scope?: ReviewScope }
  /** Queue an analysis of every pull request waiting for me not analysed at its current head. */
  | { op: 'analyzeAll'; scope?: ReviewScope }
  /**
   * `fresh` opens a new session even when the sheet's own could look again. `bot` selects that new
   * session's bot. Mine: `tree` says where the branch is worked on when no tree is on it yet.
   * `context`: the stack's pull requests to read beside it, picked before it had a sheet to keep them.
   */
  | { op: 'analyze'; key: string; fresh?: boolean; bot?: string; scope?: ReviewScope; tree?: TreeChoice; context?: string[] }
  /** Mine: where its branch is worked on, or could be. */
  | { op: 'places'; key: string }
  /** A response sheet's code changes: its session fixes the checked items to fix. */
  | { op: 'fix'; path: string }
  /** Stop a pull request's analysis: out of the queue, or its session's turn stopped. */
  | { op: 'cancel'; key: string; scope?: ReviewScope }
  /** Stop every analysis queued, starting or running. */
  | { op: 'cancelAll'; scope?: ReviewScope }
  /** The runs alone: cheap, polled closely while something runs. */
  | { op: 'progress' }
  /** A sheet by path; `since` answers `unchanged` when the file is still that version. */
  | { op: 'sheet'; path: string; since?: string }
  /** `key`: the card's pull request, so a sheet is opened for it when there is none yet (a comment of mine before any analysis). */
  | { op: 'patch'; path: string; ops: SheetOp[]; key?: string }
  /** Ask the helper model about a finding; the answer joins the notes. */
  | { op: 'ask'; path: string; id: string; question: string }
  /** Rewrite a finding's comment in the configured style. */
  | { op: 'rewrite'; path: string; id: string; hint?: string }
  /** Tell the sheet's session what to fix (a sheet it wrote that cannot be read, a new rule). */
  | { op: 'tell'; path: string; text: string }
  | { op: 'preview'; path: string }
  | { op: 'submit'; path: string }
  /** The pull request's changes (the analysed head, else the remote one): fetched when missing, no branch touched. `file` reads one held file. */
  | { op: 'diff'; key: string; file?: string }
  /** Explain a part of the change with the helper model; with `id` and `question`, ask a follow-up. Answers stream into {@link Explained}. */
  | { op: 'explain'; key: string; target?: ExplainTarget; id?: string; question?: string; lang?: ExplainLang }
  /** A comment of mine processed by a bot (translated, polished): the text back, nothing written or analysed. */
  /** `thread`: the note is a reply on that review thread of my own pull request, not a reviewer's comment. */
  | { op: 'compose'; key: string; bot: string; text: string; target?: ExplainTarget; thread?: string }
  /** A pull request's review threads, for the diff and what followed my review; `fresh` reads GitHub again. */
  | { op: 'threads'; key: string; fresh?: boolean }
  /** Someone else's pull request: the review summaries and conversation comments of others since my review was submitted. */
  | { op: 'remarks'; key: string }
  /** Caught up with what followed my submitted review: only what comes after now is news. */
  | { op: 'seen'; key: string; scope?: ReviewScope }
  /** Reply on a review thread, posted now; the threads come back. */
  | { op: 'reply'; key: string; thread: string; body: string }
  /** The explanations of a pull request's diff; `since` answers `unchanged` when nothing moved. */
  | { op: 'explained'; key: string; since?: string }
  /** Where my own pull request stands on merging. */
  | { op: 'mergeState'; key: string }
  /**
   * Merge my own pull request now, or (`auto`) once its requirements are met. `head`: the head I saw;
   * GitHub refuses when it has moved since.
   */
  | { op: 'merge'; key: string; method: MergeMethod; auto?: boolean; head?: string }
  /** Turn auto-merge off again. */
  | { op: 'cancelAutoMerge'; key: string }
  /** Mark my own pull request a draft again, or ready for review. */
  | { op: 'draft'; key: string; draft: boolean }

export interface SheetReply {
  sheet?: Sheet
  /** Why it cannot be read. */
  error?: string
  /** The file's version (mtime and size): ask again with it to hear only of changes. */
  version: string
  unchanged?: boolean
  /** The card it belongs to, when GitHub lists it. */
  item?: ReviewItem
}

export type ReviewReply<T> = { ok: true; value: T } | { ok: false; error: string }

/** A changed file of a pull request. */
export interface PullFile {
  path: string
  from?: string
  /** git's letter: A, M, D, R, C, T. */
  code: string
  added: number
  deleted: number
  binary: boolean
  /** Its part of the unified diff; absent when held. */
  patch?: string
  /** Not read with the rest: a generated file, or one too big. Asked for alone. */
  held?: 'generated' | 'large'
  /** Its patch was cut at the size cap. */
  truncated?: boolean
}

/** A pull request's changes: the merge base against the head. */
export interface PullDiff {
  base: string
  head: string
  files: PullFile[]
}

export type ExplainLang = 'zh' | 'en'

/** What to explain: a hunk, lines picked, or a whole file; lines are the new side's (the old side's when it only deletes). */
export interface ExplainTarget {
  path: string
  kind: 'hunk' | 'lines' | 'file'
  start?: number
  end?: number
  /** The diff it covers, unified. */
  diff: string
}

export interface ExplainTurn {
  /** A follow-up's question; the first turn has none. */
  question?: string
  answer: string
  done: boolean
  error?: string
}

export interface Explanation {
  id: string
  path: string
  kind: ExplainTarget['kind']
  start?: number
  end?: number
  turns: ExplainTurn[]
}

/** The explanations of one pull request at its diff's head. */
export interface Explained {
  head: string
  version: string
  items: Explanation[]
  unchanged?: boolean
}

/** Where an explanation is anchored: what the diff marks it by. */
export const anchorOf = (target: Pick<ExplainTarget, 'path' | 'kind' | 'start' | 'end'>): string =>
  `${target.kind}:${target.path}:${target.start ?? ''}-${target.end ?? ''}`

/** Comments may not use these: the style rule is checked, not hoped for. */
export const DASHES = /[–—]/
