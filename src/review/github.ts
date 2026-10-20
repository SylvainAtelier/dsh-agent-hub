/**
 * GitHub through the `gh` CLI, signed in once on this machine: the pull requests waiting for my
 * review (one GraphQL search across every repository), every open one in given repositories (a
 * search per few repositories, run side by side, each paged inside one gh process), which of some pull requests are still
 * open (those I analysed unasked) or merged since (those I reviewed, with what followed my review there), the open neighbours of some pull requests in their stacks, a pull request's head, its review threads,
 * the lines its diff lets a comment land on, my reviews on it, and posting one. Nothing here asks
 * a question on a terminal; a missing or signed-out gh is reported as such.
 *
 * My own pull requests: the open ones I authored (one search, with which threads wait on me), a
 * pull request's whole conversation, and answering it: a reply on a thread, resolving a thread,
 * a comment on the conversation. Merging it: where it stands (checks, review, conflicts, what the
 * repository allows), merging now against the head I saw, and auto-merge on or off.
 */

import { homedir } from 'node:os'
import { exec, type Exec } from '../exec.ts'
import { MERGE_METHODS, type MergeMethod, type MergeState, type MergeStatus, type ReviewDecision } from './types.ts'

export interface Pull {
  /** `owner/repo`. */
  slug: string
  number: number
  title: string
  url: string
  draft: boolean
  head: string
  branch: string
  base: string
  author: string
  updatedAt: number
  /** Its branch is on a fork. */
  cross: boolean
}

/** Where a pull request stands; `at`: when it was merged or closed. `activity`: asked for, what happened on it. */
export type PullState = ({ pull: Pull; state: 'OPEN' } | { pull: Pull; state: 'MERGED' | 'CLOSED'; at: number }) & { activity?: PullActivity }

/**
 * What happened on a pull request, for what followed a review of mine: its latest commits, every
 * review thread (who started it, its latest comments), the review summaries and conversation comments.
 * Times are ms; authors are logins, bots' included.
 */
export interface PullActivity {
  /** Oldest first: the last {@link ACTIVITY_COMMITS}. */
  commits: Array<{ oid: string; at: number }>
  threads: Array<{ resolved: boolean; outdated: boolean; root: string; comments: Array<{ author: string; at: number }> }>
  /** `review`: a review's summary, `empty` when it has no body (its comments are on threads); `comment`: on the conversation. */
  remarks: Array<{ kind: 'review' | 'comment'; author: string; at: number; empty: boolean; state?: string }>
}

/** A pull request's neighbours in its stack: the open ones whose branch its base is, and those based on its branch. */
export interface Neighbors {
  key: string
  /** The repository's default branch: no stack starts above it. */
  trunk: string
  up: Pull[]
  down: Pull[]
}

export interface Thread {
  path: string
  line?: number
  author: string
  body: string
  outdated: boolean
}

/** A pull request I opened, with what waits on me there. */
export interface OwnPull extends Pull {
  decision?: ReviewDecision
  /** Unresolved review threads whose last comment is not mine, by id. */
  pending: string[]
}

export interface Remark {
  id: string
  author: string
  body: string
  /** ISO time. */
  at: string
  url?: string
}

/** A review thread in full: where it is, the code it was left on, every comment. */
export interface FullThread {
  id: string
  path: string
  line?: number
  start?: number
  /** Where it was left: its lines on the commit its first comment was made on. */
  original?: { commit: string; line?: number; start?: number }
  resolved: boolean
  outdated: boolean
  /** The diff hunk the first comment was left on. */
  hunk: string
  comments: Remark[]
}

/** A pull request's review in full: threads, review summaries, and the conversation's comments. */
export interface Conversation {
  viewer: string
  threads: FullThread[]
  reviews: Array<Remark & { state: string }>
  comments: Remark[]
}

export interface PostedReview {
  id: string
  url?: string
}

export interface ReviewPayload {
  commit_id: string
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  comments: Array<{ path: string; line: number; side: 'RIGHT'; start_line?: number; start_side?: 'RIGHT'; body: string }>
}

export class GhError extends Error {
  readonly code: 'missing' | 'auth' | 'failed'
  constructor(code: GhError['code'], message: string) {
    super(message)
    this.code = code
  }
}

const FIELDS = 'number title url isDraft headRefOid headRefName baseRefName updatedAt isCrossRepository author { login } repository { nameWithOwner }'

const SEARCH = `query { search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 100) {
  nodes { ... on PullRequest { ${FIELDS} } } } }`

/** Paged by gh itself (`--paginate` follows `$endCursor`): one process however many pages. */
const OPEN = `query($q: String!, $endCursor: String) { search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
  pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${FIELDS} } } } }`

/** Repositories per search: GitHub caps a query's length and its operators. */
const REPOS_PER_SEARCH = 6
/** Pull requests per lookup by number: one aliased field each. */
const PULLS_PER_QUERY = 50
/** Pull requests per lookup with their activity: each brings threads and comments along. */
const ACTIVITY_PER_QUERY = 20
/** Commits read for what followed a review: past them a push counts without its number. */
const ACTIVITY_COMMITS = 100
const ACTIVITY = `commits(last: ${ACTIVITY_COMMITS}) { nodes { commit { oid committedDate } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated root: comments(first: 1) { nodes { author { login } } } comments(last: 20) { nodes { author { login } createdAt } } } }
  reviews(last: 50) { nodes { author { login } state body submittedAt createdAt } }
  comments(last: 50) { nodes { author { login } createdAt } }`

/** Pull requests per lookup of stack neighbours: two lists each. */
const NEIGHBORS_PER_QUERY = 25

type PullNode = {
  number?: number; title: string; url: string; isDraft: boolean; headRefOid: string; headRefName: string; baseRefName: string
  updatedAt: string; isCrossRepository?: boolean; author: { login: string } | null; repository: { nameWithOwner: string }
}

type ActivityNode = {
  commits?: { nodes?: Array<{ commit: { oid: string; committedDate: string } } | null> }
  reviewThreads?: { nodes?: Array<{ isResolved: boolean; isOutdated: boolean; root: { nodes: Array<{ author: Login }> }; comments: { nodes: Array<{ author: Login; createdAt: string }> } } | null> }
  reviews?: { nodes?: Array<{ author: Login; state: string; body: string | null; submittedAt: string | null; createdAt: string } | null> }
  comments?: { nodes?: Array<{ author: Login; createdAt: string } | null> }
}

const activityOf = (node: ActivityNode): PullActivity => {
  const time = (value: string | null | undefined): number => Date.parse(value ?? '') || 0
  return {
    commits: (node.commits?.nodes ?? []).flatMap((entry) => (entry === null ? [] : [{ oid: entry.commit.oid, at: time(entry.commit.committedDate) }])),
    threads: (node.reviewThreads?.nodes ?? []).flatMap((thread) => (thread === null ? [] : [{
      resolved: thread.isResolved, outdated: thread.isOutdated, root: loginOf(thread.root.nodes[0]?.author ?? null),
      comments: thread.comments.nodes.map((comment) => ({ author: loginOf(comment.author), at: time(comment.createdAt) })),
    }])),
    remarks: [
      ...(node.reviews?.nodes ?? []).flatMap((review) => (review === null ? [] : [{
        kind: 'review' as const, author: loginOf(review.author), at: time(review.submittedAt ?? review.createdAt), empty: (review.body ?? '').trim() === '', state: review.state,
      }])),
      ...(node.comments?.nodes ?? []).flatMap((comment) => (comment === null ? [] : [{ kind: 'comment' as const, author: loginOf(comment.author), at: time(comment.createdAt), empty: false }])),
    ],
  }
}

const pullOf = (node: PullNode): Pull => ({
  slug: node.repository.nameWithOwner,
  number: node.number!,
  title: node.title,
  url: node.url,
  draft: node.isDraft,
  head: node.headRefOid,
  branch: node.headRefName,
  base: node.baseRefName,
  author: node.author?.login ?? '',
  updatedAt: Date.parse(node.updatedAt) || 0,
  cross: node.isCrossRepository === true,
})

const THREADS = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  reviewThreads(first: 100) { nodes { isResolved isOutdated path line comments(first: 1) { nodes { author { login } body } } } } } } }`

/** Mine, open: 100 is plenty for one person; each with its review decision and its threads' last word. */
const AUTHORED = `query { viewer { login } search(query: "is:open is:pr author:@me archived:false sort:updated-desc", type: ISSUE, first: 100) {
  nodes { ... on PullRequest { ${FIELDS} reviewDecision
    reviewThreads(first: 100) { nodes { id isResolved comments(last: 1) { nodes { author { login } } } } } } } } }`

const CONVERSATION = `query($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  reviewThreads(first: 100) { nodes { id isResolved isOutdated path line startLine originalLine originalStartLine
    comments(first: 50) { nodes { id author { login } body createdAt url diffHunk originalCommit { oid } } } } }
  reviews(last: 50) { nodes { id author { login } state body createdAt url } }
  comments(last: 100) { nodes { id author { login } body createdAt url } } } } }`

const REPLY = `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id url } } }`
const RESOLVE = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }`

const MERGE_STATE = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod pullRequest(number: $number) {
    id state isDraft mergedAt mergeable mergeStateStatus headRefOid baseRefName reviewDecision viewerCanEnableAutoMerge
    autoMergeRequest { mergeMethod enabledBy { login } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } } } } }`

const MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID) {
  mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { state } } }`
const AUTO_MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { state } } }`
const READY = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`
const TO_DRAFT = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`
const NO_AUTO_MERGE = `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { state } } }`

const STATUSES: readonly MergeStatus[] = ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN']
const methodOf = (value: unknown): MergeMethod | undefined => MERGE_METHODS.find((method) => method === value)

type Check = { __typename: string; status?: string; conclusion?: string | null; state?: string }

/** A check's outcome: a run not completed, or a status still expected, is pending. */
function outcome(check: Check): 'passed' | 'failed' | 'pending' {
  if (check.__typename === 'CheckRun') {
    if (check.status !== 'COMPLETED') return 'pending'
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? '') ? 'passed' : 'failed'
  }
  if (check.state === 'SUCCESS') return 'passed'
  return check.state === 'PENDING' || check.state === 'EXPECTED' ? 'pending' : 'failed'
}

type Login = { login: string } | null
const loginOf = (author: Login): string => author?.login ?? ''
const DECISIONS: readonly ReviewDecision[] = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']

/** Bots whose resolved threads are noise to a reviewer: Cursor's Bugbot and the like. */
export const BUGBOT = /bugbot|cursor/i

/** `owner/repo` of a GitHub remote URL (https, ssh, scp-like), or undefined. */
export function repoSlug(url: string): string | undefined {
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

/** The new-side lines a review comment can be placed on, from a file's unified diff. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>()
  if (patch === undefined) return lines
  let line = 0
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk !== null) {
      line = Number(hunk[1])
      continue
    }
    if (line === 0) continue
    // Added and context lines are on the new side; removed lines and "\ No newline" are not.
    if (text.startsWith('+') || text.startsWith(' ')) lines.add(line++)
  }
  return lines
}

/** gh processes at once: the rest wait their turn, sparing memory and GitHub's limits on concurrent requests. */
const GH_PARALLEL = 4

const ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '' }

export class GitHub {
  private readonly run: Exec
  private login: Promise<string> | undefined
  /** gh processes running, and those waiting for one to end. */
  private busy = 0
  private readonly waiting: Array<() => void> = []

  constructor(run: Exec = exec) {
    this.run = run
  }

  /** Run gh once a slot is free; its time limit counts from then. */
  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy >= GH_PARALLEL) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.busy++
    try {
      return await work()
    } finally {
      // The slot passes straight to the next in line, or is freed.
      const next = this.waiting.shift()
      if (next === undefined) this.busy--
      else next()
    }
  }

  /** `partial`: a GraphQL answer with errors beside its data (a field that resolves to nothing) is still an answer. */
  private async gh(args: readonly string[], input?: string, timeoutMs = 60_000, partial = false): Promise<string> {
    const result = await this.slot(() => this.run('gh', args, { cwd: homedir(), env: ENV, timeoutMs, maxBytes: 16 << 20, ...(input === undefined ? {} : { input }) }))
    if (result.missing) throw new GhError('missing', 'GitHub CLI (gh) is not installed: install it and run `gh auth login`')
    if (result.timedOut) throw new GhError('failed', 'GitHub did not answer in time')
    if (result.code !== 0) {
      const text = (result.stderr || result.stdout).trim()
      if (/gh auth login|not logged in|authentication|HTTP 401/i.test(text)) throw new GhError('auth', 'GitHub CLI is not signed in: run `gh auth login`')
      if (partial && /^\s*\{"data":\{/.test(result.stdout)) return result.stdout
      throw new GhError('failed', text.split('\n').slice(0, 3).join(' ') || `gh exited with ${result.code}`)
    }
    return result.stdout
  }

  private async json<T>(args: readonly string[], input?: string): Promise<T> {
    return JSON.parse(await this.gh(args, input)) as T
  }

  /** Lines of JSON (`--jq` with `--paginate`). */
  private async lines<T>(args: readonly string[], timeoutMs?: number): Promise<T[]> {
    return (await this.gh(args, undefined, timeoutMs)).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T)
  }

  /** The signed-in account. */
  viewer(): Promise<string> {
    this.login ??= this.gh(['api', 'user', '--jq', '.login']).then((text) => text.trim())
    this.login.catch(() => { this.login = undefined })
    return this.login
  }

  /** Open pull requests waiting for my review, in every repository. */
  async requested(): Promise<Pull[]> {
    const data = await this.json<{ data?: { search?: { nodes?: PullNode[] } } }>(['api', 'graphql', '-f', `query=${SEARCH}`])
    return (data.data?.search?.nodes ?? []).filter((node) => typeof node.number === 'number').map(pullOf)
  }

  /** Those of these pull requests (`owner/repo#123`) still open. */
  async stillOpen(keys: readonly string[]): Promise<Pull[]> {
    return (await this.pullStates(keys)).flatMap((entry) => (entry.state === 'OPEN' ? [entry.pull] : []))
  }

  /**
   * Where these pull requests (`owner/repo#123`) stand: open, merged or closed, and when they were
   * merged or closed. One query per {@link PULLS_PER_QUERY}, run side by side; one gone answers nothing.
   */
  async pullStates(keys: readonly string[], activity = false): Promise<PullState[]> {
    const size = activity ? ACTIVITY_PER_QUERY : PULLS_PER_QUERY
    const groups: string[][] = []
    for (let at = 0; at < keys.length; at += size) groups.push(keys.slice(at, at + size))
    const pages = await Promise.all(groups.map(async (group) => {
      const parts = group.map((key, index) => {
        const at = key.lastIndexOf('#')
        const [owner = '', name = ''] = key.slice(0, at).split('/')
        return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(key.slice(at + 1))}) { state mergedAt closedAt ${FIELDS}${activity ? ` ${ACTIVITY}` : ''} } }`
      })
      // One gone (a repository renamed away, a pull request deleted) answers null beside the others.
      const text = await this.gh(['api', 'graphql', '-f', `query=query { ${parts.join(' ')} }`], undefined, undefined, true)
      type Node = PullNode & { state: string; mergedAt?: string | null; closedAt?: string | null } & ActivityNode
      const data = JSON.parse(text) as { data?: Record<string, { pullRequest?: Node | null } | null> }
      return Object.values(data.data ?? {}).flatMap((repo): PullState[] => {
        const node = repo?.pullRequest
        if (node === null || node === undefined || typeof node.number !== 'number') return []
        const pull = pullOf(node)
        const extra = activity ? { activity: activityOf(node) } : {}
        if (node.state === 'OPEN') return [{ pull, state: 'OPEN', ...extra }]
        const merged = node.state === 'MERGED'
        if (!merged && node.state !== 'CLOSED') return []
        return [{ pull, state: merged ? 'MERGED' : 'CLOSED', at: Date.parse((merged ? node.mergedAt : node.closedAt) ?? '') || pull.updatedAt, ...extra }]
      })
    }))
    return pages.flat()
  }

  /**
   * Each pull request's open neighbours in its stack: those whose branch is its base (a fork's
   * branch is no one's base), and those based on its branch (asked of no fork's). One query per
   * {@link NEIGHBORS_PER_QUERY}, run side by side; a repository or pull request gone answers nothing.
   */
  async neighbors(pulls: readonly Pull[]): Promise<Neighbors[]> {
    const groups: Pull[][] = []
    for (let at = 0; at < pulls.length; at += NEIGHBORS_PER_QUERY) groups.push(pulls.slice(at, at + NEIGHBORS_PER_QUERY))
    const pages = await Promise.all(groups.map(async (group) => {
      const parts = group.map((pull, index) => {
        const [owner = '', name = ''] = pull.slug.split('/')
        const down = pull.cross ? '' : ` down: pullRequests(baseRefName: ${JSON.stringify(pull.branch)}, states: OPEN, first: 30) { nodes { ${FIELDS} } }`
        return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { defaultBranchRef { name }`
          + ` up: pullRequests(headRefName: ${JSON.stringify(pull.base)}, states: OPEN, first: 5) { nodes { ${FIELDS} } }${down} }`
      })
      const text = await this.gh(['api', 'graphql', '-f', `query=query { ${parts.join(' ')} }`], undefined, undefined, true)
      type Repo = { defaultBranchRef?: { name: string } | null; up?: { nodes?: PullNode[] }; down?: { nodes?: PullNode[] } } | null
      const data = JSON.parse(text) as { data?: Record<string, Repo> }
      return group.flatMap((pull, index): Neighbors[] => {
        const repo = data.data?.[`p${index}`]
        if (repo === null || repo === undefined) return []
        const list = (nodes: PullNode[] | undefined): Pull[] => (nodes ?? []).filter((node) => typeof node.number === 'number').map(pullOf)
        return [{
          key: `${pull.slug}#${pull.number}`,
          trunk: repo.defaultBranchRef?.name ?? '',
          up: list(repo.up?.nodes).filter((up) => !up.cross),
          down: list(repo.down?.nodes),
        }]
      })
    }))
    return pages.flat()
  }

  /** Every open pull request in these repositories (`owner/repo`), most recently updated first; up to 1000 a search, GitHub's cap. */
  async open(slugs: readonly string[]): Promise<Pull[]> {
    const groups: string[][] = []
    for (let at = 0; at < slugs.length; at += REPOS_PER_SEARCH) groups.push(slugs.slice(at, at + REPOS_PER_SEARCH))
    const pages = await Promise.all(groups.map((group) => this.lines<PullNode>([
      'api', 'graphql', '--paginate', '-f', `query=${OPEN}`, '-f', `q=is:open is:pr archived:false sort:updated-desc ${group.map((slug) => `repo:${slug}`).join(' ')}`,
      '--jq', '.data.search.nodes[] | select(.number != null)',
    ], 180_000)))
    const seen = new Set<string>()
    const out: Pull[] = []
    for (const node of pages.flat()) {
      const pull = pullOf(node)
      const key = `${pull.slug.toLowerCase()}#${pull.number}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(pull)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** A pull request's head now, its state and author. */
  async pull(slug: string, number: number): Promise<{ head: string; state: string; author: string }> {
    return this.json(['api', `repos/${slug}/pulls/${number}`, '--jq', '{head: .head.sha, state: .state, author: .user.login}'])
  }

  /** Unresolved review threads; resolved Bugbot threads are dropped, so a reviewer never repeats them. */
  async threads(slug: string, number: number): Promise<Thread[]> {
    const [owner, name] = slug.split('/')
    type Node = { isResolved: boolean; isOutdated: boolean; path: string; line: number | null; comments: { nodes: Array<{ author: { login: string } | null; body: string }> } }
    const data = await this.json<{ data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Node[] } } } } }>([
      'api', 'graphql', '-f', `query=${THREADS}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
    ])
    return (data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
      .filter((node) => !node.isResolved)
      .map((node) => {
        const first = node.comments.nodes[0]
        return {
          path: node.path,
          ...(node.line === null ? {} : { line: node.line }),
          author: first?.author?.login ?? '',
          body: first?.body ?? '',
          outdated: node.isOutdated,
        }
      })
  }

  /** The new-side lines a comment can land on, by file. */
  async commentable(slug: string, number: number): Promise<Map<string, Set<number>>> {
    const files = await this.lines<{ f: string; p?: string | null }>(['api', `repos/${slug}/pulls/${number}/files`, '--paginate', '--jq', '.[] | {f: .filename, p: .patch}'])
    return new Map(files.map((file) => [file.f, commentableLines(file.p ?? undefined)]))
  }

  /** My reviews on a pull request. */
  async myReviews(slug: string, number: number): Promise<Array<{ id: string; commit: string; body: string; url?: string }>> {
    const me = await this.viewer()
    const reviews = await this.lines<{ id: number; user: string; commit: string; body: string; url?: string }>([
      'api', `repos/${slug}/pulls/${number}/reviews`, '--paginate', '--jq', '.[] | {id, user: .user.login, commit: .commit_id, body, url: .html_url}',
    ])
    return reviews.filter((review) => review.user === me).map((review) => ({ id: String(review.id), commit: review.commit, body: review.body ?? '', ...(review.url ? { url: review.url } : {}) }))
  }

  /** My open pull requests in every repository, with the threads that wait on me. */
  async authored(): Promise<OwnPull[]> {
    type Node = PullNode & {
      reviewDecision?: string | null
      reviewThreads?: { nodes?: Array<{ id: string; isResolved: boolean; comments: { nodes: Array<{ author: Login }> } }> }
    }
    const data = await this.json<{ data?: { viewer?: { login: string }; search?: { nodes?: Node[] } } }>(['api', 'graphql', '-f', `query=${AUTHORED}`])
    const me = data.data?.viewer?.login ?? ''
    if (me !== '') this.login ??= Promise.resolve(me)
    return (data.data?.search?.nodes ?? []).filter((node) => typeof node.number === 'number').map((node) => {
      const decision = DECISIONS.find((value) => value === node.reviewDecision)
      return {
        ...pullOf(node),
        ...(decision === undefined ? {} : { decision }),
        pending: (node.reviewThreads?.nodes ?? [])
          .filter((thread) => !thread.isResolved && loginOf(thread.comments.nodes.at(-1)?.author ?? null).toLowerCase() !== me.toLowerCase())
          .map((thread) => thread.id),
      }
    })
  }

  /** A pull request's review in full: every thread with its comments, the review summaries, the conversation. */
  async conversation(slug: string, number: number): Promise<Conversation> {
    const [owner, name] = slug.split('/')
    type Comment = { id: string; author: Login; body: string; createdAt: string; url?: string; diffHunk?: string; state?: string; originalCommit?: { oid: string } | null }
    type Thread = {
      id: string; isResolved: boolean; isOutdated: boolean; path: string; line: number | null; startLine: number | null
      originalLine?: number | null; originalStartLine?: number | null; comments: { nodes: Comment[] }
    }
    const data = await this.json<{ data?: { viewer?: { login: string }; repository?: { pullRequest?: {
      reviewThreads?: { nodes?: Thread[] }; reviews?: { nodes?: Comment[] }; comments?: { nodes?: Comment[] }
    } } } }>(['api', 'graphql', '-f', `query=${CONVERSATION}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`])
    const pull = data.data?.repository?.pullRequest
    if (pull === undefined) throw new Error(`GitHub does not know ${slug}#${number}`)
    const remark = (comment: Comment): Remark => ({
      id: comment.id, author: loginOf(comment.author), body: comment.body ?? '', at: comment.createdAt, ...(comment.url ? { url: comment.url } : {}),
    })
    return {
      viewer: data.data?.viewer?.login ?? '',
      threads: (pull.reviewThreads?.nodes ?? []).map((thread) => ({
        id: thread.id,
        path: thread.path,
        ...(thread.line === null ? {} : { line: thread.line }),
        ...(thread.startLine === null || thread.startLine === thread.line ? {} : { start: thread.startLine }),
        ...(() => {
          const commit = thread.comments.nodes[0]?.originalCommit?.oid
          if (commit === undefined) return {}
          const line = thread.originalLine ?? undefined
          const start = thread.originalStartLine ?? undefined
          return { original: { commit, ...(line === undefined ? {} : { line }), ...(start === undefined || start === line ? {} : { start }) } }
        })(),
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        hunk: thread.comments.nodes[0]?.diffHunk ?? '',
        comments: thread.comments.nodes.map(remark),
      })),
      reviews: (pull.reviews?.nodes ?? []).map((review) => ({ ...remark(review), state: review.state ?? '' })),
      comments: (pull.comments?.nodes ?? []).map(remark),
    }
  }

  /** Reply on a review thread. */
  async reply(thread: string, body: string): Promise<{ id: string; url?: string }> {
    const data = await this.json<{ data?: { addPullRequestReviewThreadReply?: { comment?: { id: string; url?: string } } } }>([
      'api', 'graphql', '-f', `query=${REPLY}`, '-f', `thread=${thread}`, '-f', `body=${body}`,
    ])
    const comment = data.data?.addPullRequestReviewThreadReply?.comment
    if (comment === undefined) throw new Error('GitHub did not take the reply')
    return { id: comment.id, ...(comment.url ? { url: comment.url } : {}) }
  }

  async resolve(thread: string): Promise<void> {
    await this.json(['api', 'graphql', '-f', `query=${RESOLVE}`, '-f', `thread=${thread}`])
  }

  /** A comment on the pull request's conversation. */
  async comment(slug: string, number: number, body: string): Promise<{ id: string; url?: string }> {
    const posted = await this.json<{ id: number; html_url?: string }>(['api', '-X', 'POST', `repos/${slug}/issues/${number}/comments`, '--input', '-'], JSON.stringify({ body }))
    return { id: String(posted.id), ...(posted.html_url ? { url: posted.html_url } : {}) }
  }

  /** Where a pull request stands on merging, with its node id for the mutations. */
  async mergeState(slug: string, number: number): Promise<MergeState & { id: string }> {
    const [owner, name] = slug.split('/')
    type Pr = {
      id: string; state: MergeState['state']; isDraft: boolean; mergedAt: string | null; mergeable: MergeState['mergeable']; mergeStateStatus: string
      headRefOid: string; baseRefName: string; reviewDecision: string | null; viewerCanEnableAutoMerge: boolean
      autoMergeRequest: { mergeMethod: string; enabledBy: Login } | null
      commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: Check[] } } | null } }> }
    }
    type Repo = { mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean; viewerDefaultMergeMethod: string; pullRequest: Pr | null }
    const data = await this.json<{ data?: { repository?: Repo } }>([
      'api', 'graphql', '-f', `query=${MERGE_STATE}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
    ])
    const repo = data.data?.repository
    const pr = repo?.pullRequest
    if (repo === undefined || pr === undefined || pr === null) throw new Error(`GitHub does not know ${slug}#${number}`)
    const checks = { passed: 0, failed: 0, pending: 0 }
    for (const check of pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) checks[outcome(check)]++
    const decision = DECISIONS.find((value) => value === pr.reviewDecision)
    const preferred = methodOf(repo.viewerDefaultMergeMethod)
    const auto = methodOf(pr.autoMergeRequest?.mergeMethod)
    return {
      id: pr.id,
      state: pr.state,
      draft: pr.isDraft,
      status: STATUSES.find((value) => value === pr.mergeStateStatus) ?? 'UNKNOWN',
      mergeable: pr.mergeable,
      methods: [repo.squashMergeAllowed && 'SQUASH', repo.mergeCommitAllowed && 'MERGE', repo.rebaseMergeAllowed && 'REBASE'].filter((value): value is MergeMethod => value !== false),
      ...(preferred === undefined ? {} : { preferred }),
      canAuto: pr.viewerCanEnableAutoMerge,
      ...(auto === undefined ? {} : { auto: { method: auto, by: loginOf(pr.autoMergeRequest?.enabledBy ?? null) } }),
      checks,
      ...(decision === undefined ? {} : { decision }),
      head: pr.headRefOid,
      base: pr.baseRefName,
      ...(pr.mergedAt === null ? {} : { mergedAt: pr.mergedAt }),
    }
  }

  /** Merge now, or (`auto`) once the requirements are met; refused when the head is no longer `head`. */
  async merge(id: string, method: MergeMethod, auto: boolean, head?: string): Promise<void> {
    await this.json(['api', 'graphql', '-f', `query=${auto ? AUTO_MERGE : MERGE}`, '-f', `id=${id}`, '-f', `method=${method}`, ...(head === undefined ? [] : ['-f', `head=${head}`])])
  }

  async cancelAutoMerge(id: string): Promise<void> {
    await this.json(['api', 'graphql', '-f', `query=${NO_AUTO_MERGE}`, '-f', `id=${id}`])
  }

  /** A draft again, or ready for review. */
  async setDraft(id: string, draft: boolean): Promise<void> {
    await this.json(['api', 'graphql', '-f', `query=${draft ? TO_DRAFT : READY}`, '-f', `id=${id}`])
  }

  async submit(slug: string, number: number, payload: ReviewPayload): Promise<PostedReview> {
    const posted = await this.json<{ id: number; html_url?: string }>(['api', '-X', 'POST', `repos/${slug}/pulls/${number}/reviews`, '--input', '-'], JSON.stringify(payload))
    return { id: String(posted.id), ...(posted.html_url ? { url: posted.html_url } : {}) }
  }
}
