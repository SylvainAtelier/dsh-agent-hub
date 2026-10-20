/**
 * What a review session may not do: it reads the pull request from `refs/reviews/pr-<n>` and
 * writes its sheet, never the project's code. Checked before a tool runs, for every model (a Sentry
 * analysis session too):
 *
 * - git: nothing that moves a branch, touches the index or the working tree, or rewrites refs
 *   (checkout, switch, reset, commit, stash, …); fetching and every read stay allowed.
 * - gh: reads only. Posting the review is the host's job, after the user confirms it in the sheet.
 * - Files: not in a folder of the project holding a tracked file, in any of its working trees, nor
 *   under `.git`. Folders git does not track (`.reviews/`, build output, caches, scratch) and
 *   everything outside the project are fine. Until the tracked folders have been read, only
 *   `<repo>/.reviews/` and the system's temporary folder.
 *
 * A shell redirect into a tracked file slips past a command check; the host looks at
 * `git status` after each analysis and flags the card (index.ts).
 *
 * A response session (my own pull request) is not a review session: none of this applies to it.
 */

import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { cached, type Cached } from '../cached.ts'
import { parseWorktrees } from '../git/parse.ts'
import { pathKey, within, type Runner } from '../git/service.ts'
import { programName, simpleCommands, unwrap } from '../guard.ts'
import { REVIEW_DIR } from './types.ts'

/** Subcommands that change the working tree, the index, branches or history. */
const GIT_WRITES = new Set([
  'checkout', 'switch', 'reset', 'restore', 'merge', 'rebase', 'pull', 'commit', 'push', 'stash', 'clean', 'cherry-pick',
  'revert', 'am', 'apply', 'worktree', 'rm', 'mv', 'add', 'update-ref', 'gc', 'prune', 'filter-branch', 'filter-repo', 'replace',
  'bisect', 'init', 'clone', 'commit-tree', 'read-tree', 'checkout-index', 'update-index', 'reflog', 'maintenance', 'repack',
])
/** git's own options that take the next word as their value. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
/** Subcommands that write only with some arguments: the read-only ones listed. */
const GIT_READ_ONLY_ARGS: Record<string, (args: readonly string[]) => boolean> = {
  branch: (args) => !args.some((arg) => /^-([dDmMcCfu]|-delete|-move|-copy|-force|-set-upstream-to.*|-unset-upstream|-edit-description)$/.test(arg))
    && (positional(args).length === 0 || args.some((arg) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(arg))),
  tag: (args) => !args.some((arg) => /^-([dafsmFu]|-delete|-annotate|-force|-sign|-message|-file)$/.test(arg))
    && (positional(args).length === 0 || args.some((arg) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|-n\d*)$/.test(arg))),
  config: (args) => !args.some((arg) => /^--(unset|unset-all|add|replace-all|rename-section|remove-section|edit)$|^-e$/.test(arg))
    && (positional(args).length < 2 || args.some((arg) => /^--get/.test(arg))),
  remote: (args) => !['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'].includes(positional(args)[0] ?? ''),
  'symbolic-ref': (args) => positional(args).length < 2 && !args.includes('-d') && !args.includes('--delete'),
  notes: (args) => ['', 'list', 'show'].includes(positional(args)[0] ?? ''),
  submodule: (args) => ['', 'status', 'summary'].includes(positional(args)[0] ?? ''),
  'sparse-checkout': (args) => ['list', ''].includes(positional(args)[0] ?? ''),
}

const positional = (args: readonly string[]): string[] => args.filter((arg) => !arg.startsWith('-'))

/** gh: the read-only commands, by group. */
const GH_READS: Record<string, ReadonlySet<string> | true> = {
  pr: new Set(['view', 'diff', 'list', 'status', 'checks']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list', 'watch']),
  release: new Set(['view', 'list']),
  search: true,
  status: true,
  browse: true,
  auth: new Set(['status']),
}

const READ_ONLY = 'Blocked: this is a read-only review session. Do not switch branches, change tracked files, '
  + 'or post anything to GitHub; read the pull request from its ref (`git show`, `git diff`, `git grep`). '
  + `Write the review sheet under ${REVIEW_DIR}/; other files only in folders git does not track (build output, caches, scratch) or outside the project. `
  + 'The review is posted by the host after the user confirms it in the sheet.'

/** git's subcommand and its arguments, past git's own options. */
function gitCommand(words: readonly string[]): { sub: string; args: string[] } | undefined {
  let i = 1
  while (i < words.length && words[i]!.startsWith('-')) {
    if (GIT_VALUED.has(words[i]!)) i++
    i++
  }
  return i < words.length ? { sub: words[i]!.toLowerCase(), args: words.slice(i + 1) } : undefined
}

function gitWrites(words: readonly string[]): boolean {
  const command = gitCommand(words)
  if (command === undefined) return false
  if (GIT_WRITES.has(command.sub)) return true
  const reads = GIT_READ_ONLY_ARGS[command.sub]
  return reads !== undefined && !reads(command.args)
}

/** `gh api` reads: GET, or a GraphQL query that is not a mutation. */
function apiReads(args: readonly string[]): boolean {
  let method: string | undefined
  let fields = false
  let mutation = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    // -X POST, -XPOST, --method POST, --method=POST
    const inline = /^(?:-X|--method=?)(.+)$/.exec(arg)
    if (inline !== null) method = inline[1]
    else if (arg === '-X' || arg === '--method') method = args[++i]
    else if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(arg)) {
      fields = true
      const value = arg.includes('=') && !/^-[fF]$/.test(arg) ? arg.slice(arg.indexOf('=') + 1) : args[i + 1] ?? ''
      if (/\bmutation\b/.test(value)) mutation = true
      if (!arg.includes('=')) i++
    }
  }
  const graphql = positional(args)[0] === 'graphql'
  if (method !== undefined) return method.toUpperCase() === 'GET' || (graphql && method.toUpperCase() === 'POST' && !mutation)
  return !fields || (graphql && !mutation)
}

function ghWrites(words: readonly string[]): boolean {
  const args = words.slice(1)
  const [group = '', sub = ''] = positional(args)
  if (group === 'api') return !apiReads(args.slice(args.indexOf('api') + 1))
  const reads = GH_READS[group]
  if (reads === undefined) return true
  return reads !== true && !reads.has(sub)
}

/** Why a review session may not run this shell command, or undefined. */
export function reviewCommandReason(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined
  for (const words of simpleCommands(command)) {
    const bare = unwrap(words)
    if (bare.length === 0) continue
    const program = programName(bare[0]!)
    if ((program === 'git' && gitWrites(bare)) || (program === 'gh' && ghWrites(bare))) return READ_ONLY
  }
  return undefined
}


const fold = (path: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path)

/**
 * A project's working trees, each with its folders that hold a tracked file: relative, `/`-separated,
 * folded as paths compare here; `''` the tree's root. Absent: the tree could not be read, so all of it is kept.
 */
export type TrackedTrees = ReadonlyArray<{ root: string; dirs?: ReadonlySet<string> }>

/** The folders holding tracked files, in every working tree of `repo`. */
export async function readTracked(repo: string, git: Runner): Promise<TrackedTrees> {
  const list = await git(['worktree', 'list', '--porcelain', '-z'], repo, { read: true, timeoutMs: 15_000 })
  if (list.code !== 0) throw new Error(list.stderr.trim() || 'git worktree list failed')
  const roots = parseWorktrees(list.stdout).filter((tree) => !tree.bare).map((tree) => tree.path)
  return Promise.all(roots.map(async (root) => {
    const files = await git(['ls-files', '-z'], root, { read: true, timeoutMs: 30_000, maxBytes: 64 << 20 }).catch(() => undefined)
    if (files?.code !== 0 || files.overflow === true) return { root }
    const dirs = new Set([''])
    // A tracked path counts itself: a submodule is one, and nothing is written inside it.
    for (const file of files.stdout.split('\0')) {
      for (let at = fold(file); at !== '' && !dirs.has(at); at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) dirs.add(at)
    }
    return { root, dirs }
  }))
}

/**
 * The tracked folders of a project, read on first ask and again past `ttlMs` (served stale meanwhile):
 * guards ask synchronously, so the answer is undefined until the first read is done.
 */
export function trackedFolders(git: Runner, ttlMs = 60_000): (repo: string) => TrackedTrees | undefined {
  const byRepo = new Map<string, Cached<TrackedTrees>>()
  return (repo) => {
    const key = pathKey(repo)
    let entry = byRepo.get(key)
    if (entry === undefined) {
      entry = cached(() => readTracked(repo, git), ttlMs)
      byRepo.set(key, entry)
    }
    void entry.get().catch(() => {})
    return entry.peek()?.value
  }
}

/**
 * Why a review session may not write this file, or undefined. The sheets folder and temporary files
 * always; with `tracked`, also any folder of the project's working trees holding no tracked file
 * (`.git` never), and anything outside them.
 */
export function reviewWriteReason(path: unknown, repo: string, cwd: string = repo, tracked?: TrackedTrees): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined
  const target = fold(resolve(cwd, path))
  if (within(fold(join(repo, REVIEW_DIR)), target) || within(fold(resolve(tmpdir())), target)) return undefined
  if (tracked === undefined) return READ_ONLY
  // The innermost tree: a worktree may sit inside the main one.
  const tree = tracked.filter((entry) => within(entry.root, target)).sort((a, b) => b.root.length - a.root.length)[0]
  if (tree === undefined) return within(repo, target) ? READ_ONLY : undefined
  const parts = relative(fold(resolve(tree.root)), target).split(/[\\/]/)
  if (tree.dirs === undefined || parts.includes('.git')) return READ_ONLY
  return tree.dirs.has(parts.slice(0, -1).join('/')) ? READ_ONLY : undefined
}

/** The file a write tool names, for the tool names of DSH models and of Claude Code. */
export function writtenPath(tool: string, input: Record<string, unknown> | undefined): unknown {
  switch (tool) {
    case 'write': case 'edit': case 'Write': case 'Edit': case 'MultiEdit': return input?.file_path
    case 'NotebookEdit': return input?.notebook_path
    case 'str_replace_editor': return input?.command === 'view' ? undefined : input?.path
    default: return undefined
  }
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'read', 'search'])

/**
 * Whether a tool call in a review session needs no approval: nobody is there to give it. Reads, shell commands
 * that pass `blocked` (the review's own read-only rules included) and writes under `.reviews/` run at once;
 * anything else still goes to the approval dialog.
 */
export function reviewTrusts(
  tool: string, input: Record<string, unknown> | undefined, repo: string, cwd: string, blocked: (command: unknown) => string | undefined, tracked?: TrackedTrees,
): boolean {
  if (READ_TOOLS.has(tool)) return true
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'execute') {
    const command = input?.command
    return typeof command === 'string' && blocked(command) === undefined
  }
  const path = writtenPath(tool, input) ?? (tool === 'edit' ? input?.path ?? input?.file_path : undefined)
  return typeof path === 'string' && path !== '' && reviewWriteReason(path, repo, cwd, tracked) === undefined
}

/** Claude Code's file-writing tools, for its PreToolUse hook. */
export const CLAUDE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
