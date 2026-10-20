/**
 * Host git service behind the sidebar pane. Every request names the session's
 * working directory; the gate requires it to sit inside a registered DSH
 * workspace (when the host exposes the registry), so the browser can never
 * point git at an arbitrary directory. Arguments the pane supplies are
 * validated before they reach argv, and file paths use literal pathspecs after `--`.
 *
 * Reads run with GIT_OPTIONAL_LOCKS=0 so status polling never contends with an
 * agent's own git commands for index.lock. Writes to one repository run one at
 * a time. Network commands never prompt (GIT_TERMINAL_PROMPT=0).
 *
 * Status polls are answered from a file watcher where the platform watches
 * recursively for free (Windows, macOS): while nothing in the work tree or
 * `.git` changed, a poll spawns no git at all. Named work-tree events are batched
 * through Git's ignore rules; visible changes re-read status while reusing refs,
 * stashes and the operation.
 *
 * Working trees are DSH workspaces: a new tree goes to `<repo>/.worktrees/<branch>`
 * (kept out of the main tree's status by the repository's local `info/exclude`)
 * and is registered at once, so sessions (and this pane) can work in it; removing
 * one archives its sessions and drops the registration with it. Living inside the
 * repository is what lets DSH's own 按工作区树 view nest a repository's trees under
 * it: that view puts a workspace under its nearest registered ancestor folder.
 */

import { exec } from '../exec.ts'
import { createHash } from 'node:crypto'
import { watch as watchTree, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  addedDiff, countChanges, LOG_FORMAT, looksBinary, parseCommitFiles, parseLog, parseRefs, parseStashes, parseStatus, parseWorktrees, REF_FORMAT, type ParsedStatus,
} from './parse.ts'
import { authorKey, filterByAuthors, listAuthors } from './authors.ts'
import { identEmail, identityOf, parseIdentity, remoteOwner, sameEmail, type Identity, type IdentityList } from './identity.ts'
import { applyStrict, isMainGlobal, mainGlobalFiles, readStash } from './strict.ts'
import { LOCKFILE_PATHSPECS, reclaimDeps, shareDeps } from './deps.ts'
import type {
  AuthorList, BotChoice, BotRebase, Commit, CommitDetail, DiffImage, DiffText, GitLog, GitReply, GitRequest, GitStatus, Operation, Reclaimed, SuggestInput, Worktree, WorktreeList, WorktreeOpened,
} from './types.ts'

/** Turns the change about to be committed into a message; absent when no model is set up. */
export type Suggest = (input: SuggestInput) => Promise<string>

/** What the commit-message model may read: enough for a summary, bounded for the request. */
const SUGGEST_PATCH_CAP = 48 << 10
const SUGGEST_UNTRACKED_CAP = 12 << 10
const SUGGEST_UNTRACKED_HEAD = 2 << 10

/** Commits an author-filtered graph reads at most: the newest part of a longer history. */
const HISTORY_MAX = 150_000
const HISTORY_BYTES = 96 << 20

/** One ref's history (or every ref's) read whole, for author filtering, at one refs state. */
interface History {
  key: string
  commits: Promise<Commit[]>
  /** The last filter applied, reused while paging. */
  filtered?: { authors: string; commits: Commit[] }
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** Actual process signal; code is never synthesized on overflow. */
  signal?: NodeJS.Signals | null
  overflow?: boolean
  truncated?: boolean
  timedOut?: boolean
}

export interface RunOptions {
  input?: string
  /** Read-only command: skip optional locks. */
  read?: boolean
  timeoutMs?: number
  maxBytes?: number
  maxStderrBytes?: number
  /** Only human-readable diff/suggestion reads may consume a bounded prefix. */
  allowPartial?: boolean
  /** Binary output (a blob): stdout comes back base64-encoded. */
  base64?: boolean
}

export type Runner = (args: readonly string[], cwd: string, options?: RunOptions) => Promise<RunResult>

const MAX_BYTES = 16 << 20
const DIFF_CAP = 3 << 20
const FILE_CAP = 1 << 20
/** Largest image shown in a diff, per side. */
const IMAGE_CAP = 6 << 20

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
}

const imageType = (path: string): string | undefined => IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]

export const runGit: Runner = async (args, cwd, options = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GCM_INTERACTIVE: 'never' }
  if (options.read) env.GIT_OPTIONAL_LOCKS = '0'
  const result = await exec('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
    cwd, env,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxBytes: options.maxBytes ?? MAX_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? MAX_BYTES,
    // Partial reads drain to close so a genuine git failure cannot look successful.
    partial: options.read === true && options.allowPartial === true,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.base64 ? { base64: true } : {}),
  })
  const { code, signal, stdout, stderr, overflow, timedOut } = result
  return { code, signal, stdout, stderr, overflow, truncated: overflow, timedOut }
}

class GitFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const fail = (code: string, message: string): never => { throw new GitFailure(code, message) }

function checkResult(result: RunResult, partial = false): void {
  if (result.timedOut) fail('timeout', 'git timed out')
  if ((result.overflow || result.truncated) && !partial) fail('overflow', 'git output exceeded the limit')
}

/** Which history a log reads: every ref's, or one ref's (validated: never an option). */
function logScope(ref: string | undefined): string[] {
  if (ref === undefined) return ['--exclude=refs/stash', '--all', 'HEAD']
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-') || /[\0\s]/.test(ref)) fail('invalid', `invalid ref: ${String(ref)}`)
  return ['--end-of-options', ref]
}

/** An unborn branch has no HEAD to log. */
function unborn(error: unknown): string {
  if (error instanceof GitFailure && /does not have any commits|unknown revision|bad revision/i.test(error.message)) return ''
  throw error
}

/** Expected absence may be ignored; incomplete machine output must never be. */
/**
 * The branch `symbolic-ref HEAD` names. Not `--short`: with a tag of the same name it says `heads/<name>`,
 * which a push would then take for another branch.
 */
function headBranch(text: string): string {
  const full = text.trim()
  return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : ''
}

function absent(error: unknown): string {
  if (error instanceof GitFailure && (error.code === 'overflow' || error.code === 'timeout')) throw error
  return ''
}

const READ_OPS = new Set(['status', 'log', 'authors', 'show', 'diff', 'head-message', 'suggest-message', 'worktree-list', 'identities', 'bots'])
/** Other repositories read for the picker's suggestion, at most. */
const USUAL_MAX = 40
const literal = (args: string[]): string[] => ['--literal-pathspecs', ...args]

/** The slice of DSH's workspace registry (`ctx.workspaceRegistry`) working trees are kept in step with. */
export interface Workspaces {
  list(): Array<{ id: string; path: string; title: string; sessionIds: readonly string[] }>
  create(path: string, title: string): Promise<{ id: string }>
  delete(id: string): Promise<unknown>
  /** Refuses (throws) while the session still has work running. */
  archiveSession(sessionId: string): Promise<unknown>
  unarchiveSession(sessionId: string): Promise<unknown>
}

/** One spelling per directory: git prints `C:/x` where the registry stores `C:\x`. */
export function pathKey(path: string): string {
  const normal = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? normal.toLowerCase() : normal
}

/** `child` is `parent` or lies under it, compared as {@link pathKey} does. */
export function within(parent: string, child: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Gate: may this directory be operated on? Returns its canonical form. */
export type Gate = (cwd: string) => Promise<string | undefined>

/** Allow directories at or under one of the registered workspace roots. */
export function workspaceGate(roots: () => readonly string[] | undefined): Gate {
  const same = process.platform === 'win32' || process.platform === 'darwin'
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b
  return async (cwd) => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
    let canonical: string
    try {
      canonical = await realpath(cwd)
    } catch {
      return undefined
    }
    const list = roots()
    if (list === undefined) return canonical
    for (const root of list) {
      const rel = relative(root, canonical)
      if (same(root, canonical) || rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return canonical
    }
    return undefined
  }
}

const HASH = /^[0-9a-f]{4,64}$/i
/** A ref the pane names: no option look-alikes, no whitespace, no revision syntax. */
const REF = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/

function hash(value: unknown): string {
  return typeof value === 'string' && HASH.test(value) ? value : fail('invalid', 'invalid commit')
}

function ref(value: unknown): string {
  return typeof value === 'string' && REF.test(value) && value.length < 256 ? value : fail('invalid', 'invalid ref name')
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) fail('invalid', 'invalid paths')
  return value as string[]
}

interface RepoInfo {
  root: string
  gitDir: string
  /** The git dir every worktree of the repository shares. */
  commonDir: string
}

/** New working trees go here, inside the main tree. */
export const WORKTREE_DIR = '.worktrees'
/** The local exclude line that keeps them out of the main tree's status. */
const WORKTREE_EXCLUDE = `/${WORKTREE_DIR}/`

/** Where recursive fs.watch is native and cheap; Linux emulates it with one inotify watch per directory. */
const WATCHES_CHEAPLY = process.platform === 'win32' || process.platform === 'darwin'
/** A watched status is re-read in full at least this often, in case the watcher missed something. */
const WATCH_MAX_AGE_MS = 30_000
/** A watcher nobody polled for this long is closed (the pane was closed). */
const WATCH_IDLE_MS = 3 * 60_000
/** Bound both event memory and the literal pathspec argv used to protect tracked descendants. */
const WATCH_PATH_CAP = 256
const WATCH_PATH_BYTES = 8 << 10

/** What changed since the last status read, per the watcher. */
interface Watch {
  watcher: FSWatcher
  /** An unknown, overflowed or ignore-rule change requires `git status`. */
  tree: boolean
  /** Named work-tree events, classified in one batch at the next poll. */
  paths: Set<string>
  pathBytes: number
  /** Something inside `.git` changed: refs, stashes and the operation must be read again too. */
  meta: boolean
  usedAt: number
  /** The last full read, and the parts a tree-only read reuses. */
  last?: { status: GitStatus; at: number; refs: string; stashes: string; operation: Operation | undefined; identity: string }
}

export interface GitServiceOptions {
  /** Answer unchanged status polls from a file watcher. Default: on Windows and macOS with the real git runner. */
  watch?: boolean
  /** DSH's workspace registry, read on use; without it working trees are plain git trees. */
  workspaces?: () => Workspaces | undefined
  /** Let go of a folder about to be deleted: processes the plugin runs there (Claude Code) are closed. */
  release?: (dir: string) => void
  /** Preset identities (`git.identities`) the picker offers, read on use. */
  identities?: () => readonly Identity[]
  /** Strict identity mode (`git.strict`), applied to the global git config whenever it changes. Absent: the global config is left alone. */
  strict?: () => boolean
  /** Bots that can run a rebase in a session of their own; without it the pane offers none. */
  bots?: () => readonly BotChoice[]
  /** Open a session on a bot in a folder (a workspace's, when given) and send it its first message. */
  agent?: (input: { cwd: string; workspaceId?: string; title: string; bot: string; text: string }) => Promise<string>
}

/** What a bot is told when a rebase is handed to it: the task alone, the rest is the bot's to decide. */
export function rebasePrompt(input: { branch: string; onto: string }): string {
  return `Rebase \`${input.branch}\` onto \`${input.onto}\`.`
}

export class GitService {
  private readonly repos = new Map<string, Promise<RepoInfo>>()
  private readonly writes = new Map<string, Promise<unknown>>()
  private readonly statusRuns = new Map<string, Promise<GitStatus>>()
  /** Per repository root: the history last read whole. */
  private readonly histories = new Map<string, History>()
  private readonly watches = new Map<string, Watch>()
  /** Roots whose watcher failed, and when to try again. */
  private readonly unwatchable = new Map<string, number>()
  private sweeper: ReturnType<typeof setInterval> | undefined

  private readonly gate: Gate
  private readonly run: Runner
  private readonly suggest: Suggest | undefined
  private readonly watching: boolean
  private readonly workspaces: () => Workspaces | undefined
  private readonly release: (dir: string) => void
  private readonly presets: () => readonly Identity[]
  private readonly strict: (() => boolean) | undefined
  private readonly botList: () => readonly BotChoice[]
  private readonly agent: GitServiceOptions['agent']
  /** The strict setting the global config last took, and the run applying one now. */
  private strictApplied: boolean | undefined
  private strictRun: Promise<void> | undefined

  constructor(gate: Gate, run: Runner = runGit, suggest?: Suggest, options: GitServiceOptions = {}) {
    this.gate = gate
    this.run = run
    this.suggest = suggest
    this.watching = options.watch ?? (WATCHES_CHEAPLY && run === runGit)
    this.workspaces = options.workspaces ?? (() => undefined)
    this.release = options.release ?? (() => {})
    this.presets = options.identities ?? (() => [])
    this.strict = options.strict
    this.botList = options.bots ?? (() => [])
    this.agent = options.agent
  }

  /**
   * Bring the global git config in line with `git.strict`, once per change of the setting.
   * A failure is not retried until the setting changes again: every request would repeat it.
   */
  syncStrict(): Promise<void> {
    const want = this.strict?.()
    if (want === undefined || want === this.strictApplied) return this.strictRun ?? Promise.resolve()
    if (this.strictRun !== undefined) return this.strictRun.then(() => this.syncStrict())
    const run = applyStrict((args, cwd) => this.run(args, cwd), want)
      .catch((error: unknown) => { console.warn('[agent-hub] git strict identity mode:', error instanceof Error ? error.message : error) })
      .finally(() => {
        this.strictApplied = want
        this.strictRun = undefined
        // The global identity moved: every watched status re-reads its identity.
        for (const watch of this.watches.values()) watch.meta = true
      })
    this.strictRun = run
    return run
  }

  dispose(): void {
    clearInterval(this.sweeper)
    this.sweeper = undefined
    for (const watch of this.watches.values()) watch.watcher.close()
    this.watches.clear()
  }

  async handle(payload: Record<string, unknown>): Promise<GitReply<unknown>> {
    try {
      const cwd = await this.gate(payload.cwd as string)
      if (cwd === undefined) return { ok: false, error: { code: 'denied', message: 'directory is not inside a workspace' } }
      const request = payload as unknown as GitRequest
      await this.syncStrict()
      if (request.op === 'init') return { ok: true, value: await this.serial(cwd, () => this.mutate(cwd, ['init'])) }
      const repo = await this.repo(cwd)
      const value = READ_OPS.has(request.op)
        ? await this.dispatch(repo, request)
        : await this.serial(repo.root, () => this.dispatch(repo, request))
      return { ok: true, value }
    } catch (error) {
      if (error instanceof GitFailure) return { ok: false, error: { code: error.code, message: error.message } }
      return { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  private repo(cwd: string): Promise<RepoInfo> {
    let found = this.repos.get(cwd)
    if (found === undefined) {
      found = this.run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], cwd, { read: true }).then((result) => {
        checkResult(result)
        if (result.code !== 0) fail('not-repo', result.stderr.trim() || 'not a git repository')
        const [root, gitDir, commonDir] = result.stdout.trim().split(/\r?\n/)
        return { root: resolve(root!), gitDir: resolve(gitDir!), commonDir: resolve(commonDir ?? gitDir!) }
      })
      this.repos.set(cwd, found)
      // A failed lookup (no repo yet, git missing) must be retried next time.
      found.catch(() => { this.repos.delete(cwd) })
    }
    return found
  }

  private async git(repo: RepoInfo, args: string[], options: RunOptions = {}): Promise<string> {
    const result = await this.result(repo, args, options)
    return result.stdout
  }

  private async result(repo: RepoInfo, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const result = await this.run(args, repo.root, options)
    checkResult(result, options.read === true && options.allowPartial === true)
    if (result.code !== 0) {
      // A vanished repository (deleted .git) must not stay cached.
      if (/not a git repository/i.test(result.stderr)) this.repos.clear()
      fail('failed', (result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`))
    }
    return result
  }

  private read(repo: RepoInfo, args: string[], options: RunOptions = {}): Promise<string> {
    return this.git(repo, args, { ...options, read: true })
  }

  /** Queue the entire operation, including its preflight reads and multiple writes. */
  private serial<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const key = pathKey(cwd)
    const previous = this.writes.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.writes.set(key, next)
    next.finally(() => { if (this.writes.get(key) === next) this.writes.delete(key) }).catch(() => {})
    return next
  }

  /** Already inside the operation queue: never acquire it recursively. */
  private async mutate(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
    const result = await this.run(args, cwd, options).finally(() => this.invalidate(cwd))
    checkResult(result)
    const message = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    if (result.code !== 0) fail('failed', message || `git ${args[0]} failed`)
    return message
  }

  private write(repo: RepoInfo, args: string[], options: RunOptions = {}): Promise<string> {
    return this.mutate(repo.root, args, options)
  }

  private dispatch(repo: RepoInfo, request: GitRequest): Promise<unknown> {
    const net = { timeoutMs: 180_000 }
    switch (request.op) {
      case 'status': return this.status(repo, request.fresh === true)
      case 'log': return this.log(repo, request.skip, request.limit, request.ref, request.authors)
      case 'authors': return this.authors(repo, request.ref)
      case 'show': return this.show(repo, hash(request.hash))
      case 'diff': return this.diff(repo, request)
      case 'head-message': return this.read(repo, ['log', '-1', '--format=%B']).then((text) => text.trim())
      case 'suggest-message': return this.suggestMessage(repo)
      case 'stage':
        return request.paths === undefined
          ? this.write(repo, ['add', '-A'])
          : this.write(repo, literal(['add', '-A', '--', ...paths(request.paths)]))
      case 'unstage': return this.unstage(repo, request.paths === undefined ? undefined : paths(request.paths))
      case 'discard': return this.discard(repo, paths(request.paths), paths(request.untracked))
      case 'resolve': return this.resolveConflict(repo, paths([request.path])[0]!, request.side)
      case 'commit': return this.commit(repo, request)
      case 'identities': return this.identities(repo)
      case 'identity-set': return this.setIdentity(repo, request.identity)
      case 'checkout': return this.checkout(repo, request.ref, request.kind)
      case 'branch-create': {
        const name = ref(request.name)
        const at = request.at === undefined ? [] : [ref(request.at)]
        // --no-track: a new branch started at a remote branch (origin/main) must not push back into it.
        return request.checkout === false
          ? this.write(repo, ['branch', '--no-track', name, ...at])
          : this.write(repo, ['switch', '--no-track', '-c', name, ...at])
      }
      case 'branch-delete': return this.write(repo, ['branch', request.force ? '-D' : '-d', ref(request.name)])
      case 'branch-rename': return this.write(repo, ['branch', '-m', ref(request.from), ref(request.to)])
      case 'merge': return this.write(repo, ['merge', '--no-edit', ref(request.ref)])
      case 'rebase': return this.write(repo, ['rebase', ref(request.ref)])
      case 'bots': return Promise.resolve(this.botList().map(({ id, description }) => ({ id, ...(description === undefined ? {} : { description }) })))
      case 'rebase-bot': return this.rebaseByBot(repo, ref(request.ref), String(request.bot ?? ''))
      case 'cherry-pick': return this.pick(repo, 'cherry-pick', hash(request.hash))
      case 'revert': return this.pick(repo, 'revert', hash(request.hash))
      case 'reset': {
        const mode = request.mode === 'soft' || request.mode === 'hard' ? request.mode : 'mixed'
        return this.write(repo, ['reset', `--${mode}`, hash(request.hash)])
      }
      case 'tag-create': {
        const args = typeof request.message === 'string' && request.message.trim() !== ''
          ? ['tag', '-a', ref(request.name), '-m', request.message, hash(request.at)]
          : ['tag', ref(request.name), hash(request.at)]
        return this.write(repo, args)
      }
      case 'tag-delete': return this.write(repo, ['tag', '-d', ref(request.name)])
      case 'fetch': return this.write(repo, ['fetch', '--all', '--prune'], net)
      case 'pull': return this.pull(repo)
      case 'push': return this.push(repo, request)
      case 'stash-push': {
        const message = typeof request.message === 'string' && request.message.trim() !== '' ? ['-m', request.message.trim()] : []
        return this.write(repo, ['stash', 'push', '--include-untracked', ...message])
      }
      case 'stash-apply': case 'stash-pop': case 'stash-drop': {
        const index = Number(request.index)
        if (!Number.isInteger(index) || index < 0) fail('invalid', 'invalid stash')
        return this.write(repo, ['stash', request.op.slice(6), `stash@{${index}}`])
      }
      case 'abort': case 'continue': return this.sequence(repo, request.op)
      case 'worktree-list': return this.worktrees(repo)
      case 'worktree-add': return this.addWorktree(repo, ref(request.branch), request.base === undefined || request.base === '' ? undefined : ref(request.base))
      case 'worktree-open': return this.openWorktree(repo, request.path)
      case 'worktree-remove': return this.removeWorktree(repo, request.path, request.force === true, request.deleteBranch === true)
      case 'worktree-lock': case 'worktree-unlock': {
        const verb = request.op === 'worktree-lock' ? 'lock' : 'unlock'
        return this.tree(repo, request.path).then((tree) => this.write(repo, ['worktree', verb, '--', tree.path]))
      }
      case 'worktree-prune': return this.write(repo, ['worktree', 'prune', '--verbose'])
      case 'worktree-reclaim': return this.reclaimWorktrees(repo)
      default: return Promise.reject(new GitFailure('invalid', 'unknown operation'))
    }
  }

  private async operation(repo: RepoInfo): Promise<Operation | undefined> {
    const exists = (name: string): Promise<boolean> => stat(join(repo.gitDir, name)).then(() => true, () => false)
    const [merge, rebaseMerge, rebaseApply, pick, revert] = await Promise.all([
      exists('MERGE_HEAD'), exists('rebase-merge'), exists('rebase-apply'), exists('CHERRY_PICK_HEAD'), exists('REVERT_HEAD'),
    ])
    if (rebaseMerge || rebaseApply) return 'rebase'
    if (merge) return 'merge'
    if (pick) return 'cherry-pick'
    if (revert) return 'revert'
    return undefined
  }

  /**
   * Concurrent polls of one repository share a single run. `fresh` (an explicit
   * refresh, or right after a command the watcher may not have reported yet)
   * waits out a run already in flight and reads everything again.
   */
  private async status(repo: RepoInfo, fresh = false): Promise<GitStatus> {
    let running = this.statusRuns.get(repo.root)
    if (fresh) {
      await running?.catch(() => {})
      this.invalidate(repo.root)
      running = this.statusRuns.get(repo.root)
    }
    if (running === undefined) {
      running = this.readStatus(repo).finally(() => { this.statusRuns.delete(repo.root) })
      this.statusRuns.set(repo.root, running)
    }
    return running
  }

  private async readStatus(repo: RepoInfo): Promise<GitStatus> {
    const watch = this.watchOf(repo)
    const last = watch?.last
    const now = Date.now()
    let full = last === undefined || watch!.meta || now - last.at >= WATCH_MAX_AGE_MS
    const dirty = watch?.tree ?? true
    const paths = watch?.paths ?? new Set<string>()
    // Detach this batch before ANY await: new events belong to the next poll,
    // including events arriving during check-ignore or the subsequent status read.
    if (watch !== undefined) {
      watch.paths = new Set()
      watch.pathBytes = 0
      watch.tree = false
      watch.meta = false
    }
    if (last !== undefined && !full && !dirty) {
      const ignored = paths.size === 0 || await this.allIgnored(repo, paths)
      // Metadata arriving during classification can change both ignores and the index.
      full = watch!.meta || Date.now() - last.at >= WATCH_MAX_AGE_MS
      if (ignored && !full && !watch!.tree) return last.status
    }
    let parts: { raw: string; refs: string; stashes: string; operation: Operation | undefined; identity: string }
    try {
      const [raw, refs, stashes, operation, identity] = await Promise.all([
        this.read(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
        full ? this.read(repo, ['for-each-ref', '--format=%(objectname) %(refname)']).catch(absent) : last!.refs,
        full ? this.read(repo, ['stash', 'list', '-z', '--format=%gd%x1f%ct%x1f%s']).catch(absent) : last!.stashes,
        full ? this.operation(repo) : last!.operation,
        full ? this.read(repo, ['config', '--show-scope', '--show-origin', '-z', '--get-regexp', '^user\\.(name|email)$']).catch(absent) : last!.identity,
      ])
      parts = { raw, refs, stashes, operation, identity }
    } catch (error) {
      if (watch !== undefined) {
        watch.tree = true
        watch.meta = true
      }
      throw error
    }
    const { raw, refs, stashes, operation } = parts
    const parsed = parseStatus(raw)
    const files = mainGlobalFiles()
    const identity = parseIdentity(parts.identity, process.env, (origin) => isMainGlobal(origin, files))
    const refsKey = createHash('sha1').update(refs).update(parsed.head ?? '').digest('hex').slice(0, 16)
    const key = createHash('sha1').update(raw).update(refsKey).update(stashes).update(operation ?? '')
      .update(identity === undefined ? '' : `${identity.source}\0${identity.name}\0${identity.email}`).digest('hex').slice(0, 16)
    const status: GitStatus = {
      root: repo.root,
      common: repo.commonDir,
      ...parsed,
      ...await this.tracking(repo, parsed, refsKey),
      stashes: parseStashes(stashes),
      ...(operation === undefined ? {} : { operation }),
      refsKey,
      key,
      ...(watch === undefined ? {} : { watched: true }),
      ...(identity === undefined ? {} : { identity }),
    }
    if (watch !== undefined) watch.last = { status, at: full ? now : last!.at, refs, stashes, operation, identity: parts.identity }
    return status
  }

  /** No ignore cache: index, nested rules and metadata are re-evaluated for every batch. */
  private async allIgnored(repo: RepoInfo, paths: Set<string>): Promise<boolean> {
    try {
      // Do not use --no-index: a force-added file under an ignore rule is still tracked.
      const result = await this.run(['check-ignore', '-z', '--stdin'], repo.root, {
        read: true, input: [...paths].join('\0') + '\0', timeoutMs: 5_000, maxBytes: WATCH_PATH_BYTES * 2,
      })
      checkResult(result)
      if (result.code !== 0 || !result.stdout.endsWith('\0')) return false
      const ignored = new Set(result.stdout.slice(0, -1).split('\0'))
      if (ignored.size !== paths.size || [...paths].some((path) => !ignored.has(path))) return false
      // A directory notification can hide force-added tracked descendants even
      // when check-ignore reports the directory itself ignored (also after deletion).
      const tracked = await this.run(literal(['ls-files', '--cached', '-z', '--', ...paths]), repo.root, {
        read: true, timeoutMs: 5_000, maxBytes: WATCH_PATH_BYTES * 2,
      })
      checkResult(tracked)
      return tracked.code === 0 && tracked.stdout === ''
    } catch {
      // Uncertain classification must never turn a potentially visible change clean.
      return false
    }
  }

  /** Per repository: the tracking details last worked out, and the refs they were worked out for. */
  private trackingBy = new Map<string, { key: string; value: Partial<GitStatus> }>()

  /**
   * What `git status` leaves out about where the branch pushes: the same-name remote branch standing in
   * for a missing or other-named upstream, and whether being behind is only local history rewritten.
   * Cached until the refs move, so polls cost nothing.
   */
  private async tracking(repo: RepoInfo, parsed: ParsedStatus, refsKey: string): Promise<Partial<GitStatus>> {
    const { branch, head } = parsed
    if (branch === undefined || head === undefined) return {}
    const own = parsed.upstream !== undefined && parsed.upstream.endsWith(`/${branch}`)
    if (own && parsed.behind === 0) return {}
    const key = `${refsKey}\0${parsed.upstream ?? ''}\0${parsed.ahead}\0${parsed.behind}`
    const cached = this.trackingBy.get(repo.root)
    if (cached?.key === key) return cached.value
    let value: Partial<GitStatus> = {}
    try {
      let upstream = own ? `${branch}@{upstream}` : undefined
      if (!own) {
        const twin = (await this.twins(repo, branch))[0]
        if (twin !== undefined) {
          upstream = `refs/remotes/${twin.name}`
          const [ahead = 0, behind = 0] = (await this.read(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).trim().split(/\s+/).map(Number)
          value = { upstream: twin.name, upstreamGuessed: true, ahead, behind }
        }
      }
      const behind = value.behind ?? parsed.behind
      if (upstream !== undefined && behind > 0 && await this.rewritten(repo, branch, upstream)) value = { ...value, rewritten: true }
    } catch (error) {
      absent(error)
      value = {}
    }
    this.trackingBy.set(repo.root, { key, value })
    return value
  }

  /** Remote branches named exactly `branch` (`origin/x`, `fork/x`), origin's first. */
  private async twins(repo: RepoInfo, branch: string): Promise<{ remote: string; name: string }[]> {
    const remotes = (await this.read(repo, ['remote']).catch(absent)).split(/\r?\n/).filter(Boolean)
    if (remotes.length === 0) return []
    // Each pattern spelled out: a glob such as refs/remotes/*/x would also match origin/team/x.
    const wanted = new Map(remotes.map((remote) => [`refs/remotes/${remote}/${branch}`, remote]))
    const found = (await this.read(repo, ['for-each-ref', '--format=%(refname)', ...wanted.keys()]).catch(absent)).split(/\r?\n/)
    return found.filter((line) => wanted.has(line)).map((line) => ({ remote: wanted.get(line)!, name: line.slice('refs/remotes/'.length) }))
      .sort((a, b) => Number(b.remote === 'origin') - Number(a.remote === 'origin'))
  }

  /**
   * Whether `tip` (the remote's) was once on `branch` here: the remote has nothing this branch never had,
   * so diverging from it is only history rewritten here. The same test as push --force-if-includes.
   */
  private async rewritten(repo: RepoInfo, branch: string, tip: string): Promise<boolean> {
    const [log, sha] = await Promise.all([
      this.read(repo, ['log', '-g', '-n', '200', '--format=%H', `refs/heads/${branch}`]).catch(absent),
      this.read(repo, ['rev-parse', '--verify', '-q', `${tip}^{commit}`]).catch(absent),
    ])
    const entries = [...new Set(log.split(/\r?\n/).filter(Boolean))]
    const at = sha.trim()
    if (entries.length === 0 || at === '') return false
    if (entries.includes(at)) return true
    return (await this.read(repo, ['rev-list', '--count', at, '--not', ...entries])).trim() === '0'
  }

  /**
   * The repository's watcher, started on first use. Only for the common layout
   * (`.git` directly in the work tree): a linked worktree's refs live elsewhere,
   * where this watcher would not see them move.
   */
  private watchOf(repo: RepoInfo): Watch | undefined {
    if (!this.watching) return undefined
    const found = this.watches.get(repo.root)
    if (found !== undefined) {
      found.usedAt = Date.now()
      return found
    }
    const retryAt = this.unwatchable.get(repo.root)
    if (retryAt !== undefined && Date.now() < retryAt) return undefined
    const own = join(repo.root, '.git')
    if ((process.platform === 'win32' ? own.toLowerCase() !== repo.gitDir.toLowerCase() : own !== repo.gitDir)) return undefined
    const give = (): void => {
      const current = this.watches.get(repo.root)
      current?.watcher.close()
      this.watches.delete(repo.root)
      this.unwatchable.set(repo.root, Date.now() + 60_000)
    }
    let watcher: FSWatcher
    try {
      watcher = watchTree(repo.root, { recursive: true, persistent: false }, (_event, name) => {
        const entry = this.watches.get(repo.root)
        if (entry === undefined) return
        const path = name === null ? undefined : process.platform === 'win32' ? String(name).replace(/\\/g, '/') : String(name)
        if (path === undefined) {
          // Overflowed or unnamed: anything may have changed.
          entry.tree = true
          entry.meta = true
        } else if (path === '.git' || path.startsWith('.git/')) {
          // Objects are written ahead of the refs or index that point at them.
          if (!path.startsWith('.git/objects/')) {
            entry.meta = true
            entry.tree = true
          }
        } else {
          const bytes = Buffer.byteLength(path) + 1
          if (path === '' || isAbsolute(path) || path.split('/').some((part) => part === '..' || part === '.gitignore')
            || path.includes('\0') || (!entry.paths.has(path) && (entry.paths.size >= WATCH_PATH_CAP || entry.pathBytes + bytes > WATCH_PATH_BYTES))) {
            entry.tree = true
            entry.paths.clear()
            entry.pathBytes = 0
          } else if (!entry.tree && !entry.paths.has(path)) {
            entry.paths.add(path)
            entry.pathBytes += bytes
          }
        }
      })
    } catch {
      this.unwatchable.set(repo.root, Date.now() + 60_000)
      return undefined
    }
    watcher.on('error', give)
    const watch: Watch = { watcher, tree: true, meta: true, paths: new Set(), pathBytes: 0, usedAt: Date.now() }
    this.watches.set(repo.root, watch)
    this.sweeper ??= setInterval(() => this.sweepWatches(), 60_000)
    this.sweeper.unref?.()
    return watch
  }

  /** Mark a repository's cached status stale: its own commands changed it, and the watcher may lag. */
  private invalidate(root: string): void {
    const watch = this.watches.get(root)
    if (watch === undefined) return
    watch.tree = true
    watch.meta = true
  }

  private sweepWatches(): void {
    const now = Date.now()
    for (const [root, watch] of this.watches) {
      if (now - watch.usedAt > WATCH_IDLE_MS) {
        watch.watcher.close()
        this.watches.delete(root)
      }
    }
    if (this.watches.size === 0) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
  }

  private async log(repo: RepoInfo, skipValue?: number, limitValue?: number, ref?: string, authors?: string[]): Promise<GitLog> {
    const skip = Number.isInteger(skipValue) && skipValue! > 0 ? skipValue! : 0
    const limit = Number.isInteger(limitValue) && limitValue! > 0 ? Math.min(limitValue!, 2000) : 400
    const scope = logScope(ref)
    if (authors !== undefined && (!Array.isArray(authors) || authors.length === 0 || authors.length > 100
      || authors.some((key) => typeof key !== 'string' || key === '' || key.length > 320))) fail('invalid', 'invalid authors')
    const state = Promise.all([
      this.read(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.read(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((text) => text.trim(), absent),
      this.read(repo, ['symbolic-ref', '-q', 'HEAD']).then(headBranch, absent),
    ])
    // Awaited below; a failed log read must not leave it rejecting unobserved.
    state.catch(() => {})
    let commits: Commit[]
    let more: boolean
    if (authors === undefined) {
      commits = parseLog(await this.read(repo, ['log', '--date-order', '-z', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, `--skip=${skip}`,
        ...scope, '--']).catch(unborn))
      more = commits.length === limit
    } else {
      const [rawRefs, head] = await state
      const history = this.history(repo, ref, rawRefs, head)
      const wanted = [...new Set(authors.map((key) => key.toLowerCase()))].sort().join('\n')
      if (history.filtered?.authors !== wanted) history.filtered = { authors: wanted, commits: filterByAuthors(await history.commits, new Set(wanted.split('\n'))) }
      const all = history.filtered.commits
      commits = all.slice(skip, skip + limit)
      more = skip + limit < all.length
    }
    const [rawRefs, head, branch] = await state
    return {
      commits,
      refs: parseRefs(rawRefs),
      ...(head ? { head } : {}),
      ...(branch ? { branch } : {}),
      more,
    }
  }

  /** The history `log` reads for `ref`, whole (up to HISTORY_MAX), reused while refs and HEAD stay put. */
  private history(repo: RepoInfo, ref: string | undefined, rawRefs: string, head: string): History {
    const key = `${ref ?? ''}\0${head}\0${rawRefs}`
    const found = this.histories.get(repo.root)
    if (found?.key === key) return found
    const commits = this.read(repo, ['log', '--date-order', '-z', `--format=${LOG_FORMAT}`, `--max-count=${HISTORY_MAX}`, ...logScope(ref), '--'],
      { maxBytes: HISTORY_BYTES }).catch(unborn).then(parseLog)
    const history: History = { key, commits }
    this.histories.set(repo.root, history)
    // A failed read must be retried next time.
    commits.catch(() => { if (this.histories.get(repo.root) === history) this.histories.delete(repo.root) })
    return history
  }

  private async authors(repo: RepoInfo, ref?: string): Promise<AuthorList> {
    logScope(ref)
    const [rawRefs, head, email, name] = await Promise.all([
      this.read(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.read(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((text) => text.trim(), absent),
      this.read(repo, ['config', '--get', 'user.email']).then((text) => text.trim(), absent),
      this.read(repo, ['config', '--get', 'user.name']).then((text) => text.trim(), absent),
    ])
    const commits = await this.history(repo, ref, rawRefs, head).commits
    const me = authorKey(email, name)
    return { authors: listAuthors(commits), ...(me === '' ? {} : { me }), truncated: commits.length === HISTORY_MAX }
  }

  private async show(repo: RepoInfo, commit: string): Promise<CommitDetail> {
    const meta = await this.read(repo, ['show', '-s', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1f%b', commit])
    const [full, parents, author, email, at, committer, committedAt, subject, ...body] = meta.replace(/\0+$/, '').split('\x1f')
    const parentList = parents ? parents.split(' ').filter(Boolean) : []
    const range = parentList.length === 0
      ? ['diff-tree', '--root', '-r', '-M', '-z', '--no-commit-id']
      : ['diff', '-M', '-z', parentList[0]!]
    const [names, nums] = await Promise.all([
      this.read(repo, [...range, '--name-status', full!]),
      this.read(repo, [...range, '--numstat', full!]),
    ])
    return {
      hash: full!,
      parents: parentList,
      author: author ?? '',
      email: email ?? '',
      at: Number(at) * 1000,
      committer: committer ?? '',
      committedAt: Number(committedAt) * 1000,
      subject: subject ?? '',
      body: body.join('\x1f').trim(),
      files: parseCommitFiles(names, nums),
    }
  }

  /** Repository-relative path → absolute, refusing anything outside the tree. */
  private inside(repo: RepoInfo, path: string): string {
    const absolute = resolve(repo.root, path)
    const rel = relative(repo.root, absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail('invalid', 'path outside repository')
    return absolute
  }

  private async readFileText(repo: RepoInfo, path: string): Promise<{ text: string; binary: boolean; truncated: boolean }> {
    const handle = await open(this.inside(repo, path), 'r')
    try {
      const buffer = Buffer.alloc(FILE_CAP + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, Math.min(bytesRead, FILE_CAP))
      if (looksBinary(bytes)) return { text: '', binary: true, truncated: false }
      return { text: bytes.toString('utf8'), binary: false, truncated: bytesRead > FILE_CAP }
    } finally {
      await handle.close()
    }
  }

  private async diff(repo: RepoInfo, request: Extract<GitRequest, { op: 'diff' }>): Promise<DiffText> {
    const path = paths([request.path])[0]!
    const from = typeof request.from === 'string' && request.from !== '' ? [request.from] : []
    const context = `-U${request.full ? 100000 : 3}`
    const type = imageType(path)
    if (type !== undefined) return { text: '', binary: true, truncated: false, images: await this.diffImages(repo, request, path, from[0] ?? path, type) }
    let output: RunResult
    if (request.source === 'untracked' || request.source === 'conflict') {
      const file = await this.readFileText(repo, path)
      if (file.binary) return { text: '', binary: true, truncated: false }
      const text = request.source === 'untracked' ? addedDiff(path, file.text) : file.text
      return { text, binary: false, truncated: file.truncated }
    }
    const base = ['--no-ext-diff', '--no-color', '-M', context]
    const partial = { read: true, allowPartial: true, maxBytes: DIFF_CAP }
    if (request.source === 'staged') {
      output = await this.result(repo, literal(['diff', '--cached', ...base, '--', ...from, path]), partial)
    } else if (request.source === 'unstaged') {
      output = await this.result(repo, literal(['diff', ...base, '--', path]), partial)
    } else {
      const commit = hash(request.hash)
      const parent = (await this.read(repo, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ')[1]
      output = parent === undefined
        ? await this.result(repo, literal(['diff-tree', '-p', '--root', ...base, commit, '--', path]), partial)
        : await this.result(repo, literal(['diff', ...base, parent, commit, '--', ...from, path]), partial)
    }
    const text = output.stdout
    const binary = /^Binary files .* differ$/m.test(text) && !/^@@/m.test(text)
    const truncated = output.truncated === true || output.overflow === true
    return { text: truncated ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text, binary, truncated }
  }

  /** Both sides of a changed image; a side is absent where the file did not exist. */
  private async diffImages(repo: RepoInfo, request: Extract<GitRequest, { op: 'diff' }>, path: string, oldPath: string, type: string): Promise<{ before?: DiffImage; after?: DiffImage }> {
    const blob = async (spec: string): Promise<DiffImage | undefined> => {
      const sized = await this.run(['cat-file', '-s', spec], repo.root, { read: true })
      const size = Number(sized.stdout.trim())
      checkResult(sized)
      if (sized.code !== 0 || !Number.isFinite(size)) return undefined
      if (size > IMAGE_CAP) return { size }
      const result = await this.run(['cat-file', 'blob', spec], repo.root, { read: true, base64: true, maxBytes: IMAGE_CAP })
      checkResult(result)
      return result.code === 0 ? { size, url: `data:${type};base64,${result.stdout}` } : undefined
    }
    const file = async (): Promise<DiffImage | undefined> => {
      const absolute = this.inside(repo, path)
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined || !info.isFile()) return undefined
      if (info.size > IMAGE_CAP) return { size: info.size }
      return { size: info.size, url: `data:${type};base64,${(await readFile(absolute)).toString('base64')}` }
    }
    const none = Promise.resolve(undefined)
    let before: Promise<DiffImage | undefined> = none
    let after: Promise<DiffImage | undefined> = none
    if (request.source === 'untracked') after = file()
    else if (request.source === 'staged') {
      before = blob(`HEAD:${oldPath}`)
      after = blob(`:${path}`)
    } else if (request.source === 'unstaged' || request.source === 'conflict') {
      before = blob(`:${path}`).then((found) => found ?? blob(`HEAD:${path}`))
      after = file()
    } else {
      const commit = hash(request.hash)
      const parent = (await this.read(repo, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ')[1]
      if (parent !== undefined) before = blob(`${parent}:${oldPath}`)
      after = blob(`${commit}:${path}`)
    }
    const [b, a] = await Promise.all([before, after])
    return { ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) }
  }

  private async suggestMessage(repo: RepoInfo): Promise<string> {
    if (this.suggest === undefined) fail('unavailable', 'no commit message model is configured')
    const input = await this.suggestInput(repo)
    if (input.stat.trim() === '' && input.untracked.length === 0) fail('invalid', 'nothing to commit')
    const text = (await this.suggest!(input).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code === 'unavailable' ? 'unavailable' : 'failed'
      return fail(code, error instanceof Error ? error.message : String(error))
    })).replace(/\r\n/g, '\n').trim()
    if (text === '') fail('failed', 'the model returned an empty message')
    return text
  }

  /** The change a commit would record now: the index when anything is staged, else everything (commit stages all). */
  private async suggestInput(repo: RepoInfo): Promise<SuggestInput> {
    const [born, stagedNames] = await Promise.all([
      this.read(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, (error: unknown) => { absent(error); return false }),
      this.read(repo, ['diff', '--cached', '--name-only', '-z']),
    ])
    const staged = stagedNames !== ''
    // An unborn branch has nothing tracked outside the index, so "everything" is the untracked files.
    const base = ['diff', ...(staged || !born ? ['--cached'] : ['HEAD']), '--no-ext-diff', '--no-color', '-M']
    const [stat, rawPatch, others, recent, branch] = await Promise.all([
      this.read(repo, [...base, '--stat=100']),
      this.result(repo, [...base, '-U2'], { read: true, allowPartial: true, maxBytes: SUGGEST_PATCH_CAP }),
      staged ? Promise.resolve('') : this.read(repo, ['ls-files', '--others', '--exclude-standard', '-z']),
      born ? this.read(repo, ['log', '-12', '--format=%s']).catch(absent) : Promise.resolve(''),
      this.read(repo, ['symbolic-ref', '-q', 'HEAD']).then(headBranch, absent),
    ])
    let truncated = rawPatch.truncated === true || rawPatch.overflow === true
    const patch = truncated ? rawPatch.stdout.slice(0, Math.max(0, rawPatch.stdout.lastIndexOf('\n'))) : rawPatch.stdout
    const untracked: SuggestInput['untracked'] = []
    let budget = SUGGEST_UNTRACKED_CAP
    for (const path of others.split('\0').filter(Boolean).slice(0, 200)) {
      if (budget <= 0) {
        untracked.push({ path })
        truncated = true
        continue
      }
      const text = await this.head(repo, path, Math.min(budget, SUGGEST_UNTRACKED_HEAD)).catch(() => undefined)
      if (text !== undefined) budget -= text.length
      untracked.push(text === undefined ? { path } : { path, text })
    }
    return {
      ...(branch ? { branch } : {}),
      scope: staged ? 'staged' : 'all',
      stat: stat.trimEnd(),
      patch,
      untracked,
      recent: recent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      truncated,
    }
  }

  /** The first bytes of a work-tree file as text; undefined for binary files. */
  private async head(repo: RepoInfo, path: string, bytes: number): Promise<string | undefined> {
    const handle = await open(this.inside(repo, path), 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
      const chunk = buffer.subarray(0, bytesRead)
      return looksBinary(chunk) ? undefined : chunk.toString('utf8')
    } finally {
      await handle.close()
    }
  }

  private async unstage(repo: RepoInfo, list?: string[]): Promise<string> {
    const born = await this.read(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, (error: unknown) => { absent(error); return false })
    if (!born) return this.write(repo, literal(['rm', '--cached', '-r', '-q', '--', ...(list ?? ['.'])]))
    return list === undefined ? this.write(repo, ['reset', '-q']) : this.write(repo, literal(['restore', '--staged', '--', ...list]))
  }

  private async discard(repo: RepoInfo, tracked: string[], untracked: string[]): Promise<string> {
    const output: string[] = []
    if (tracked.length > 0) output.push(await this.write(repo, literal(['restore', '--worktree', '--', ...tracked])))
    if (untracked.length > 0) output.push(await this.write(repo, literal(['clean', '-f', '-q', '--', ...untracked])))
    return output.filter(Boolean).join('\n')
  }

  private async resolveConflict(repo: RepoInfo, path: string, side?: 'ours' | 'theirs'): Promise<string> {
    if (side === 'ours' || side === 'theirs') await this.write(repo, literal(['checkout', `--${side}`, '--', path]))
    return this.write(repo, literal(['add', '--', path]))
  }

  private async commit(repo: RepoInfo, request: Extract<GitRequest, { op: 'commit' }>): Promise<string> {
    const amend = request.amend === true
    const text = typeof request.message === 'string' ? request.message.replace(/\r\n/g, '\n').trim() : ''
    if (text === '' && !amend) fail('invalid', 'empty commit message')
    if (typeof request.as === 'string') await this.expectIdentity(repo, request.as)
    if (request.all === true) await this.write(repo, ['add', '-A'])
    const args = ['commit', '--cleanup=strip']
    if (amend) args.push('--amend')
    if (amend && request.resetAuthor === true) args.push('--reset-author')
    if (text === '') args.push('--no-edit')
    else args.push('-F', '-')
    return this.write(repo, args, { ...(text === '' ? {} : { input: `${text}\n` }), timeoutMs: 300_000 })
  }

  /** Refuse to commit as anyone but `email`, the identity the pane showed (a terminal may have changed it since). */
  private async expectIdentity(repo: RepoInfo, email: string): Promise<void> {
    const ident = (name: string): Promise<string | undefined> => this.read(repo, ['var', name]).then(identEmail, () => undefined)
    const [author, committer] = await Promise.all([ident('GIT_AUTHOR_IDENT'), ident('GIT_COMMITTER_IDENT')])
    if (author === undefined || committer === undefined) fail('identity', 'this repository has no commit identity')
    if (!sameEmail(author, email) || !sameEmail(committer, email)) fail('identity', `git would commit as ${author}, not ${email}`)
  }

  private async identities(repo: RepoInfo): Promise<IdentityList> {
    const presets = this.presets().map(identityOf).filter((identity): identity is Identity => identity !== undefined)
    const [stashed, usual] = await Promise.all([
      this.strict === undefined ? undefined : readStash((args, cwd) => this.run(args, cwd)).catch(() => undefined),
      this.usual(repo).catch(() => undefined),
    ])
    return {
      presets,
      ...(stashed === undefined || presets.some((preset) => sameEmail(preset.email, stashed.email)) ? {} : { stashed }),
      ...(usual === undefined ? {} : { usual }),
    }
  }

  /** The identity other registered repositories with this one's remote owner (github.com/acme) are bound to most. */
  private async usual(repo: RepoInfo): Promise<string | undefined> {
    const own = remoteOwner(await this.read(repo, ['config', '--get', 'remote.origin.url']).catch(absent))
    if (own === undefined) return undefined
    const others = [...new Set((this.workspaces()?.list() ?? []).map((workspace) => workspace.path))]
      .filter((path) => !within(repo.root, path) && !within(path, repo.root)).slice(0, USUAL_MAX)
    const counts = new Map<string, number>()
    await Promise.all(others.map(async (path) => {
      const result = await this.run(['config', '--local', '-z', '--get-regexp', '^(user\\.email|remote\\.origin\\.url)$'], path, { read: true, timeoutMs: 5000 })
      if (result.code !== 0) return
      const values = new Map(result.stdout.split('\0').filter(Boolean).map((record) => {
        const cut = record.indexOf('\n')
        return [record.slice(0, cut).toLowerCase(), record.slice(cut + 1)] as const
      }))
      const email = values.get('user.email')?.trim().toLowerCase()
      if (email && remoteOwner(values.get('remote.origin.url') ?? '') === own) counts.set(email, (counts.get(email) ?? 0) + 1)
    }))
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }

  /** The repository's own `user.*`, shared by all its worktrees; a key the identity lacks is removed, not inherited from the previous one. */
  private async setIdentity(repo: RepoInfo, value: unknown): Promise<string> {
    const unset = async (key: string): Promise<void> => {
      const result = await this.run(['config', '--local', '--unset-all', key], repo.root).finally(() => this.invalidate(repo.root))
      // 5: already absent.
      if (result.code !== 0 && result.code !== 5) fail('failed', result.stderr.trim() || `git config --unset ${key} failed`)
    }
    if (value === undefined || value === null) {
      for (const key of ['user.name', 'user.email', 'user.signingkey']) await unset(key)
      return ''
    }
    const identity = identityOf(value) ?? fail('invalid', 'invalid identity')
    await this.write(repo, ['config', '--local', 'user.name', identity.name])
    await this.write(repo, ['config', '--local', 'user.email', identity.email])
    if (identity.signingKey === undefined) await unset('user.signingkey')
    else await this.write(repo, ['config', '--local', 'user.signingkey', identity.signingKey])
    return ''
  }

  private async checkout(repo: RepoInfo, name: unknown, kind: unknown): Promise<string> {
    if (kind === 'commit') return this.write(repo, ['switch', '--detach', hash(name)])
    const target = ref(name)
    if (kind === 'remote') {
      const remote = target.slice(0, target.indexOf('/'))
      const local = target.slice(target.indexOf('/') + 1)
      // Refresh the remote branch first; offline or gone from the remote, the last fetched tip still serves.
      await this.write(repo, ['fetch', remote, local], { timeoutMs: 180_000 }).catch(() => undefined)
      const exists = await this.read(repo, ['show-ref', '--verify', '-q', `refs/heads/${local}`]).then(() => true, (error: unknown) => { absent(error); return false })
      if (!exists) return this.write(repo, ['switch', '-c', local, '--track', target])
      // An existing local branch catches up with the remote one; diverged, git refuses and says so.
      const switched = await this.write(repo, ['switch', local])
      return switched + await this.write(repo, ['merge', '--ff-only', target])
    }
    return this.write(repo, ['switch', target])
  }

  private async pick(repo: RepoInfo, verb: 'cherry-pick' | 'revert', commit: string): Promise<string> {
    const parents = (await this.read(repo, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ').length - 1
    return this.write(repo, [verb, ...(verb === 'revert' ? ['--no-edit'] : []), ...(parents > 1 ? ['-m', '1'] : []), commit])
  }

  /**
   * Push a branch (the checked-out one unless named). A branch only ever lands on the remote branch of
   * its own name, as git's default push.default=simple insists: one started from origin/main tracks main,
   * and following that upstream (as VS Code does) would put the work on main. So, in order:
   * - a push remote is configured (branch.<name>.pushRemote, remote.pushDefault): pushed there;
   * - it tracks `<remote>/<its name>`: pushed there;
   * - a remote already has a branch of its name (origin's first): pushed there, which becomes the upstream;
   * - otherwise: published to origin (else the first remote) under its name, which becomes the upstream.
   * Every push names both ends (`refs/heads/x:refs/heads/x`), so a tag or a push.default setting can't
   * redirect it. `force` picks --force-with-lease, with --force-if-includes so a background fetch can't
   * vouch for commits never seen here, or a plain --force; both only onto a remote branch of its name
   * this repository knows (never while publishing). `setUpstream` is accepted for older clients.
   */
  private async push(repo: RepoInfo, request: Extract<GitRequest, { op: 'push' }>): Promise<string> {
    const net = { timeoutMs: 180_000 }
    const branch = request.branch === undefined
      ? headBranch(await this.read(repo, ['symbolic-ref', '-q', 'HEAD']).catch(absent))
      : ref(request.branch)
    if (branch === '') fail('invalid', 'HEAD is detached: check out a branch to push')
    const config = async (key: string): Promise<string> => (await this.read(repo, ['config', '--get', key]).catch(absent)).trim()
    const [remote, merge, pushRemote, pushDefault, list] = await Promise.all([
      config(`branch.${branch}.remote`), config(`branch.${branch}.merge`), config(`branch.${branch}.pushRemote`), config('remote.pushDefault'),
      this.read(repo, ['remote']),
    ])
    const remotes = list.split(/\r?\n/).filter(Boolean)
    if (remotes.length === 0) fail('failed', 'no remote configured')
    const own = remote !== '' && remote !== '.' && merge === `refs/heads/${branch}`
    const configured = pushRemote !== '' ? pushRemote : pushDefault
    let target: string | undefined
    let track = false
    if (configured !== '' && configured !== '.') {
      target = configured
      track = remote === ''
    } else if (own) {
      target = remote
    } else {
      target = (await this.twins(repo, branch))[0]?.remote
      track = true
    }
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`
    let force: string[] = []
    if (request.force !== undefined) {
      if (target === undefined) fail('invalid', `${branch} is not on any remote yet: publish it before force-pushing`)
      force = request.force === 'force' ? ['--force'] : ['--force-with-lease', ...(await this.gitAtLeast(repo, 2, 30) ? ['--force-if-includes'] : [])]
    }
    if (target !== undefined) return this.write(repo, ['push', ...force, ...(track ? ['-u'] : []), target, refspec], net)
    const publish = remotes.includes('origin') ? 'origin' : remotes[0]!
    return this.write(repo, ['push', '-u', publish, refspec], net)
  }

  /**
   * Pull the branch's upstream. A branch without one of its own name takes the remote branch of its
   * name as its upstream first (the status already shows that one); with neither, git explains.
   */
  private async pull(repo: RepoInfo): Promise<string> {
    const net = { timeoutMs: 180_000 }
    const branch = headBranch(await this.read(repo, ['symbolic-ref', '-q', 'HEAD']).catch(absent))
    if (branch !== '') {
      const merge = (await this.read(repo, ['config', '--get', `branch.${branch}.merge`]).catch(absent)).trim()
      const twin = merge === `refs/heads/${branch}` ? undefined : (await this.twins(repo, branch))[0]
      if (twin !== undefined) await this.write(repo, ['branch', `--set-upstream-to=${twin.name}`, branch])
    }
    return this.write(repo, ['pull'], net)
  }

  private version: Promise<number[]> | undefined
  /** Whether the git in use is at least `major.minor` (unknown counts as older). */
  private async gitAtLeast(repo: RepoInfo, major: number, minor: number): Promise<boolean> {
    this.version ??= this.read(repo, ['version'], { timeoutMs: 15_000 })
      .then((out) => (/(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number), () => {
        this.version = undefined
        return []
      })
    const [a = 0, b = 0] = await this.version
    return a > major || (a === major && b >= minor)
  }

  /**
   * Hand the current branch's rebase to a bot: refuse what git would refuse (an operation in
   * progress, uncommitted changes, a detached HEAD) before any session opens, then a session
   * opens in this tree on the bot with the task. Nothing is rebased here.
   */
  private async rebaseByBot(repo: RepoInfo, onto: string, bot: string): Promise<BotRebase> {
    if (this.agent === undefined) fail('unavailable', 'sessions are unavailable')
    if (!this.botList().some((item) => item.id === bot)) fail('invalid', `the bot "${bot}" is unavailable`)
    const status = await this.status(repo, true)
    if (status.branch === undefined) fail('invalid', 'HEAD is detached: check out a branch to rebase')
    if (status.operation !== undefined) fail('invalid', `a ${status.operation} is in progress: continue or abort it first`)
    if (status.staged.length + status.unstaged.length + status.conflicts.length > 0) fail('invalid', 'there are uncommitted changes: commit or stash them first')
    const branch = status.branch!
    const rev = async (name: string): Promise<string> => (await this.read(repo, ['rev-parse', '--short', '--verify', `${name}^{commit}`]).catch(absent)).trim()
    if ((await rev(onto)) === '') fail('invalid', `${onto} is not a commit`)
    const workspace = this.workspaces()?.list().find((item) => pathKey(item.path) === pathKey(repo.root))
    const sessionId = await this.agent!({
      cwd: repo.root,
      ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
      title: `Rebase ${branch} onto ${onto}`.slice(0, 120),
      bot,
      text: rebasePrompt({ branch, onto }),
    })
    return { sessionId, branch, ...(workspace === undefined ? {} : { workspaceId: workspace.id }) }
  }

  private async sequence(repo: RepoInfo, action: 'abort' | 'continue'): Promise<string> {
    const operation = await this.operation(repo)
    if (operation === undefined) fail('invalid', 'no operation in progress')
    // `-c core.editor=true` accepts the prepared message instead of opening an editor.
    return this.write(repo, ['-c', 'core.editor=true', operation!, `--${action}`])
  }

  /** Every working tree, with its workspace and how many changes it holds. */
  private async worktrees(repo: RepoInfo): Promise<WorktreeList> {
    const parsed = parseWorktrees(await this.read(repo, ['worktree', 'list', '--porcelain', '-z'])).filter((tree) => !tree.bare)
    const registered = new Map((this.workspaces()?.list() ?? []).map((workspace) => [pathKey(workspace.path), workspace]))
    const current = pathKey(repo.root)
    const worktrees = await Promise.all(parsed.map(async (tree, index): Promise<Worktree> => {
      const path = resolve(tree.path)
      const workspace = registered.get(pathKey(path))
      const changes = tree.prunable === undefined
        ? await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=normal'], path, { read: true, timeoutMs: 20_000 })
          .then((result) => { checkResult(result); return result.code === 0 ? countChanges(result.stdout) : undefined }, () => undefined)
        : undefined
      return {
        path,
        ...(tree.branch === undefined ? {} : { branch: tree.branch }),
        ...(tree.head === undefined ? {} : { head: tree.head }),
        main: index === 0,
        current: pathKey(path) === current,
        ...(tree.locked === undefined ? {} : { locked: tree.locked }),
        ...(tree.prunable === undefined ? {} : { prunable: tree.prunable }),
        ...(workspace === undefined ? {} : { workspace: { id: workspace.id, title: workspace.title, sessions: workspace.sessionIds.length } }),
        ...(changes === undefined ? {} : { changes }),
      }
    }))
    const main = worktrees[0]?.path ?? repo.root
    return { worktrees, home: join(main, WORKTREE_DIR) }
  }

  /** A tree the pane names must be one of this repository's. */
  private async tree(repo: RepoInfo, path: unknown): Promise<Worktree> {
    if (typeof path !== 'string' || path === '') fail('invalid', 'invalid working tree')
    const found = (await this.worktrees(repo)).worktrees.find((tree) => pathKey(tree.path) === pathKey(path as string))
    return found ?? fail('invalid', 'not a working tree of this repository')
  }

  /** The tree's workspace, registered now if it has none; undefined without a registry. */
  /** `title` overrides the default: the folder name for the main tree, `<repo> · <branch>` for the others. */
  private async register(tree: { path: string; branch?: string }, main: string, title?: string): Promise<string | undefined> {
    const workspaces = this.workspaces()
    if (workspaces === undefined) return undefined
    const existing = workspaces.list().find((workspace) => pathKey(workspace.path) === pathKey(tree.path))
    if (existing !== undefined) return existing.id
    // The main tree is titled as DSH titles a folder added by hand: by its name.
    title ??= pathKey(tree.path) === pathKey(main) ? basename(main) : `${basename(main)} · ${tree.branch ?? basename(tree.path)}`
    return (await workspaces.create(tree.path, title)).id
  }

  private async addWorktree(repo: RepoInfo, branch: string, base: string | undefined): Promise<WorktreeOpened> {
    const { worktrees, home } = await this.worktrees(repo)
    const path = join(home, ...branch.split('/'))
    if (await stat(path).then(() => true, () => false)) fail('invalid', `${path} already exists`)
    await this.excludeWorktrees(repo)
    const has = (name: string): Promise<boolean> => this.read(repo, ['show-ref', '--verify', '-q', name]).then(() => true, (error: unknown) => { absent(error); return false })
    let args: string[]
    if (await has(`refs/heads/${branch}`)) {
      args = ['worktree', 'add', '--', path, branch]
    } else {
      const remotes = (await this.twins(repo, branch)).map((twin) => twin.name)
      // A base that is one of those remote branches (asked for from its menu) is tracked as well.
      const remote = base === undefined ? remotes[0] : remotes.find((name) => name === base)
      args = remote !== undefined
        ? ['worktree', 'add', '--track', '-b', branch, '--', path, remote]
        // --no-track: a base such as origin/main must not become the new branch's upstream.
        : ['worktree', 'add', '--no-track', '-b', branch, '--', path, base ?? 'HEAD']
    }
    await this.write(repo, args, { timeoutMs: 300_000 })
    const main = worktrees[0]?.path ?? repo.root
    // The main tree's packages, cloned in the background: the tree opens at once, and an install there finds them.
    void this.lockfiles(main).then((lockfiles) => shareDeps(main, path, lockfiles)).catch(() => {})
    // A registration that fails still leaves a usable tree; the pane offers to register it again.
    const id = await this.register({ path, branch }, main).catch(() => undefined)
    return { path, ...(id === undefined ? {} : { workspaceId: id }) }
  }

  /** The main tree's tracked lockfiles, relative to it. */
  private async lockfiles(main: string): Promise<string[]> {
    const result = await this.run(['ls-files', '-z', '--', ...LOCKFILE_PATHSPECS], main, { read: true, timeoutMs: 20_000 })
    return result.code === 0 ? result.stdout.split('\0').filter(Boolean) : []
  }

  /** Every other tree's `node_modules` shared with the main tree's where they hold the same packages. */
  private async reclaimWorktrees(repo: RepoInfo): Promise<Reclaimed> {
    const { worktrees } = await this.worktrees(repo)
    const main = worktrees[0]?.path ?? repo.root
    const others = worktrees.filter((tree) => !tree.main && tree.prunable === undefined).map((tree) => tree.path)
    return reclaimDeps(main, others, await this.lockfiles(main))
  }

  /** Keep `.worktrees/` out of the main tree's status: once, in the repository's own unshared exclude file. */
  private async excludeWorktrees(repo: RepoInfo): Promise<void> {
    const common = (await this.read(repo, ['rev-parse', '--git-common-dir'])).trim()
    const file = join(isAbsolute(common) ? common : resolve(repo.root, common), 'info', 'exclude')
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text.split(/\r?\n/).some((line) => line.trim() === WORKTREE_EXCLUDE)) return
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${WORKTREE_EXCLUDE}\n`)
  }

  private async openWorktree(repo: RepoInfo, path: unknown): Promise<WorktreeOpened> {
    const tree = await this.tree(repo, path)
    if (tree.prunable !== undefined) fail('invalid', 'this working tree no longer exists; prune it')
    if (tree.workspace !== undefined) return { path: tree.path, workspaceId: tree.workspace.id }
    const main = (await this.worktrees(repo)).worktrees[0]?.path ?? repo.root
    const id = await this.register(tree, main)
    return { path: tree.path, ...(id === undefined ? {} : { workspaceId: id }) }
  }

  /**
   * Register every live working tree of the repository `dir` is in: opening one tree of a
   * repository opens them all. Not gated: the host calls it for a workspace just registered,
   * and the sidebar's refresh for every registered repository. Each is titled by its folder's
   * name, as DSH titles a folder added by hand. Returns how many it registered.
   */
  async adopt(dir: string): Promise<number> {
    const workspaces = this.workspaces()
    if (workspaces === undefined) return 0
    const result = await this.run(['worktree', 'list', '--porcelain', '-z'], dir, { read: true, timeoutMs: 15_000 }).catch(() => undefined)
    if (result?.code !== 0) return 0
    const trees = parseWorktrees(result.stdout).filter((tree) => !tree.bare && tree.prunable === undefined)
    const main = trees[0]?.path ?? dir
    const known = new Set(workspaces.list().map((workspace) => pathKey(workspace.path)))
    let added = 0
    for (const tree of trees) {
      const path = resolve(tree.path)
      if (!known.has(pathKey(path)) && await this.register({ ...tree, path }, main, basename(path)).then(() => true, () => false)) added++
    }
    return added
  }

  /**
   * Archive the tree's sessions first (refused while one is still working), then
   * let git remove the tree (refused with uncommitted changes unless forced),
   * then drop the registration. A refusal at any step undoes the archiving.
   */
  private async removeWorktree(repo: RepoInfo, path: unknown, force: boolean, deleteBranch: boolean): Promise<string> {
    const tree = await this.tree(repo, path)
    if (tree.main) fail('invalid', 'the main working tree cannot be removed')
    if (tree.current) fail('invalid', 'this pane shows that working tree; remove it from another one')
    const workspaces = this.workspaces()
    const sessions = tree.workspace === undefined
      ? []
      : workspaces?.list().find((workspace) => workspace.id === tree.workspace!.id)?.sessionIds ?? []
    const archived: string[] = []
    const restore = async (): Promise<void> => {
      for (const id of archived) await workspaces?.unarchiveSession(id).catch(() => {})
    }
    for (const id of sessions) {
      try {
        await workspaces!.archiveSession(id)
        archived.push(id)
      } catch (error) {
        await restore()
        fail('busy', error instanceof Error ? error.message : String(error))
      }
    }
    this.release(tree.path)
    let output: string
    try {
      output = tree.prunable !== undefined
        ? await this.write(repo, ['worktree', 'prune'])
        : await this.write(repo, ['worktree', 'remove', ...(force ? ['--force', '--force'] : []), '--', tree.path])
    } catch (error) {
      // Incomplete output/timeout is never a successful write, even if git already changed metadata.
      if (error instanceof GitFailure && (error.code === 'overflow' || error.code === 'timeout')) {
        await restore()
        throw error
      }
      // Git may have unregistered the tree and only failed to delete the folder (a process still
      // working in it on Windows). Then finish the removal rather than leave half of it.
      const still = (await this.worktrees(repo)).worktrees.some((other) => pathKey(other.path) === pathKey(tree.path))
      if (still) {
        await restore()
        throw error
      }
      output = await rm(tree.path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
        .then(() => '', () => `${tree.path} is no longer a worktree, but the folder could not be deleted: something is still using it.`)
    }
    if (tree.workspace !== undefined) await workspaces?.delete(tree.workspace.id).catch(() => {})
    if (deleteBranch && tree.branch !== undefined) {
      output = [output, await this.write(repo, ['branch', force ? '-D' : '-d', '--', tree.branch])].filter(Boolean).join('\n')
    }
    return output
  }

  /**
   * The folder of a workspace just deleted from DSH's list, when it is a linked worktree: git
   * removes it, uncommitted changes and all; its branch stays. The main tree, a plain folder,
   * a locked tree and a path registered again meanwhile are left alone. Its sessions are DSH's
   * to keep (they move to Ungrouped). Not gated: the workspace is already unregistered.
   * Answers whether it removed one.
   */
  async dropWorktree(path: string): Promise<boolean> {
    const result = await this.run(['worktree', 'list', '--porcelain', '-z'], path, { read: true, timeoutMs: 15_000 }).catch(() => undefined)
    if (result?.code !== 0) return false
    const trees = parseWorktrees(result.stdout).filter((tree) => !tree.bare)
    const main = trees[0]
    const tree = trees.slice(1).find((other) => pathKey(other.path) === pathKey(path))
    if (main === undefined || tree === undefined || tree.locked !== undefined) return false
    if (this.workspaces()?.list().some((workspace) => pathKey(workspace.path) === pathKey(path)) === true) return false
    const root = resolve(main.path)
    return this.serial(root, async () => {
      this.release(tree.path)
      try {
        await this.mutate(root, ['worktree', 'remove', '--force', '--', tree.path])
      } catch (error) {
        // Git may have unregistered the tree and only failed to delete the folder; finish it.
        const again = await this.run(['worktree', 'list', '--porcelain', '-z'], root, { read: true, timeoutMs: 15_000 }).catch(() => undefined)
        if (again?.code !== 0 || parseWorktrees(again.stdout).some((other) => pathKey(other.path) === pathKey(tree.path))) throw error
        await rm(tree.path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      }
      return true
    })
  }
}
