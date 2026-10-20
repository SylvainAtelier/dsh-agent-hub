/**
 * Git module wire types, shared by the host service and the sidebar pane.
 * One RPC method carries every operation; the payload's `op` picks it. Replies
 * are always `{ ok }` unions so git's own error text reaches the pane.
 */

import type { EffectiveIdentity, Identity, IdentityList } from './identity.ts'

export const GIT_METHOD = 'agent-hub/git'

/** Porcelain status letter: M A D R C T U, `?` untracked. */
export type ChangeCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  /** Rename/copy source. */
  from?: string
  code: ChangeCode
}

export interface Stash {
  index: number
  message: string
  at: number
}

export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface GitStatus {
  root: string
  /** The git dir shared by every worktree of the repository: per-repository settings key on it. */
  common?: string
  /** Checked-out branch; absent when detached or unborn without a name. */
  branch?: string
  /** HEAD commit; absent on an unborn branch. */
  head?: string
  upstream?: string
  /**
   * `upstream` is the remote branch of the same name, not (yet) configured as the upstream: a branch made
   * without tracking, or tracking another name. The next push or pull sets it.
   */
  upstreamGuessed?: boolean
  /**
   * Behind only because history here was rewritten (rebase, amend, reset): the remote's tip was once on
   * this branch. Pulling would bring the old commits back; it wants a push with --force-with-lease.
   */
  rewritten?: boolean
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: FileChange[]
  conflicts: FileChange[]
  /** The change lists were capped. */
  truncated: boolean
  operation?: Operation
  stashes: Stash[]
  /** Changes whenever refs move (fetch, branch, tag): the graph reloads on it. */
  refsKey: string
  /** Changes whenever anything in this reply changes. */
  key: string
  /** The host answers polls from a file watcher, so polling is nearly free. */
  watched?: boolean
  /** Who a commit here would be by; absent when git has no identity to give it (strict mode, unbound). */
  identity?: EffectiveIdentity
}

export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  at: number
  subject: string
}

export type RefKind = 'head' | 'remote' | 'tag'

export interface Ref {
  kind: RefKind
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string
  hash: string
  /** Local branches: their upstream's short name. */
  upstream?: string
}

export interface GitLog {
  commits: Commit[]
  refs: Ref[]
  head?: string
  branch?: string
  more: boolean
}

/** Someone with commits in the graph's history, keyed by `authorKey`. */
export interface Author {
  key: string
  name: string
  email: string
  count: number
}

export interface AuthorList {
  /** Most commits first. */
  authors: Author[]
  /** The configured user's key (user.email, else user.name). */
  me?: string
  /** Only the newest part of a very long history was read. */
  truncated: boolean
}

export interface CommitFile extends FileChange {
  added: number
  deleted: number
  binary: boolean
}

export interface CommitDetail extends Commit {
  committer: string
  committedAt: number
  body: string
  files: CommitFile[]
}

export type DiffSource = 'staged' | 'unstaged' | 'untracked' | 'conflict' | 'commit'

export interface DiffText {
  text: string
  binary: boolean
  truncated: boolean
  /** Image files: each side, absent where the file did not exist. */
  images?: { before?: DiffImage; after?: DiffImage }
}

export interface DiffImage {
  size: number
  /** Data URL; absent when the image is too large to send. */
  url?: string
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

/** One working tree of the repository, as `git worktree list` reports it, joined with DSH's workspace registry. */
export interface Worktree {
  path: string
  branch?: string
  head?: string
  /** The repository's own (first) working tree; it cannot be removed. */
  main: boolean
  /** The working tree this pane shows. */
  current: boolean
  /** Lock reason; '' when locked without one. */
  locked?: string
  /** Git can prune it: the directory is gone. */
  prunable?: string
  /** The DSH workspace registered at this directory: a session there works in this tree. */
  workspace?: { id: string; title: string; sessions: number }
  /** Uncommitted changes; absent when the tree could not be read. */
  changes?: number
}

export interface WorktreeList {
  worktrees: Worktree[]
  /** Where new working trees go: `<repo>/.worktrees`. */
  home: string
}

/** A working tree that has (or now has) a DSH workspace to open sessions in. */
export interface WorktreeOpened {
  path: string
  workspaceId?: string
}

/** A bot as the rebase picker lists it. */
export interface BotChoice {
  id: string
  description?: string
}

/** The session a bot's rebase runs in. */
export interface BotRebase {
  sessionId: string
  /** The DSH workspace of the tree the rebase runs in, when it is registered. */
  workspaceId?: string
  branch: string
}

export type GitRequest =
  /** `fresh`: read everything again rather than trust the watcher (explicit refreshes, after a command). */
  | { op: 'status'; fresh?: boolean }
  /**
   * `ref`: only that branch's (or tag's) history instead of every ref's.
   * `authors`: only these authors' commits (`authorKey`s), parents rewritten to the nearest kept ancestors.
   */
  | { op: 'log'; skip?: number; limit?: number; ref?: string; authors?: string[] }
  /** Who committed in the history `log` would show for `ref`. */
  | { op: 'authors'; ref?: string }
  | { op: 'show'; hash: string }
  | { op: 'diff'; source: DiffSource; path: string; from?: string; hash?: string; full?: boolean }
  | { op: 'head-message' }
  /** Draft a commit message for what would be committed, with the configured model. */
  | { op: 'suggest-message' }
  | { op: 'stage'; paths?: string[] }
  | { op: 'unstage'; paths?: string[] }
  | { op: 'discard'; paths: string[]; untracked: string[] }
  | { op: 'resolve'; path: string; side?: 'ours' | 'theirs' }
  /**
   * `as`: the email the pane showed; the commit is refused unless git would still use it.
   * `resetAuthor`: an amend takes the current identity instead of keeping the original author.
   */
  | { op: 'commit'; message: string; amend?: boolean; all?: boolean; as?: string; resetAuthor?: boolean }
  /** What the identity picker offers. */
  | { op: 'identities' }
  /** Bind the repository to `identity` (its `.git/config`), or drop its own binding. */
  | { op: 'identity-set'; identity?: Identity }
  | { op: 'checkout'; ref: string; kind: 'branch' | 'remote' | 'commit' }
  | { op: 'branch-create'; name: string; at?: string; checkout?: boolean }
  | { op: 'branch-delete'; name: string; force?: boolean }
  | { op: 'branch-rename'; from: string; to: string }
  | { op: 'merge'; ref: string }
  | { op: 'rebase'; ref: string }
  /** The bots a rebase can be handed to. */
  | { op: 'bots' }
  /** Hand the current branch's rebase onto `ref` to `bot`: a session opens in this tree and the bot runs it. */
  | { op: 'rebase-bot'; ref: string; bot: string }
  | { op: 'cherry-pick'; hash: string }
  | { op: 'revert'; hash: string }
  | { op: 'reset'; hash: string; mode: ResetMode }
  | { op: 'tag-create'; name: string; at: string; message?: string }
  | { op: 'tag-delete'; name: string }
  | { op: 'fetch' }
  | { op: 'pull' }
  /** Push a branch (default: the checked-out one); `force`: lease = --force-with-lease, force = --force. */
  | { op: 'push'; setUpstream?: boolean; branch?: string; force?: 'lease' | 'force' }
  | { op: 'stash-push'; message?: string }
  | { op: 'stash-apply' | 'stash-pop' | 'stash-drop'; index: number }
  | { op: 'abort' | 'continue' }
  | { op: 'init' }
  | { op: 'worktree-list' }
  /** Check `branch` out in a new tree at `<home>/<branch>`: an existing local branch, a remote one (tracked), else a new branch from `base` (default HEAD). */
  | { op: 'worktree-add'; branch: string; base?: string }
  /** Register a tree as a DSH workspace when it is not one yet. */
  | { op: 'worktree-open'; path: string }
  /** Remove a tree, its workspace registration (its sessions are archived), and optionally its branch. */
  | { op: 'worktree-remove'; path: string; force?: boolean; deleteBranch?: boolean }
  | { op: 'worktree-lock' | 'worktree-unlock'; path: string }
  | { op: 'worktree-prune' }
  /** Share the other trees' installed packages (in `node_modules`) with the main tree's, those installed alike. */
  | { op: 'worktree-reclaim' }

export type GitOp = GitRequest['op']

/** What `worktree-reclaim` did: the other trees' packages now shared with the main tree's. */
export interface Reclaimed {
  /** Bytes the disk has free now that it had not before; undefined when unreadable. */
  freed?: number
  /** Trees that share some of their packages now, and how many packages in all. */
  trees: number
  packages: number
}

export interface GitError {
  /** `not-repo`, `denied`, `invalid`, `failed`, `unavailable` (no model configured). */
  code: string
  message: string
}

export type GitReply<T> = { ok: true; value: T } | { ok: false; error: GitError }

/** What each operation answers with; mutations answer with git's output. */
export interface GitValues {
  status: GitStatus
  log: GitLog
  authors: AuthorList
  show: CommitDetail
  diff: DiffText
  'head-message': string
  'suggest-message': string
  identities: IdentityList
  'worktree-list': WorktreeList
  'worktree-add': WorktreeOpened
  'worktree-open': WorktreeOpened
  'worktree-reclaim': Reclaimed
  bots: BotChoice[]
  'rebase-bot': BotRebase
}

export type ValueOf<O extends GitOp> = O extends keyof GitValues ? GitValues[O] : string

/** What the commit-message model is shown: the change about to be committed. */
export interface SuggestInput {
  branch?: string
  /** Staged only, or every change because nothing is staged. */
  scope: 'staged' | 'all'
  /** `git diff --stat` summary. */
  stat: string
  /** Unified diff, capped. */
  patch: string
  /** Untracked files, with their head when text. */
  untracked: Array<{ path: string; text?: string }>
  /** Recent subjects, newest first, so the draft follows the repo's style. */
  recent: string[]
  truncated: boolean
}
