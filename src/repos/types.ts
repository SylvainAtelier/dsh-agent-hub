/**
 * Repositories: DSH workspaces grouped by the git repository they belong to.
 * A repository is identified by its main working tree (the folder holding the
 * shared `.git`), so every worktree of it lands in the same group. Shared by
 * the host and the browser: the sidebar nests worktrees under their
 * repository, connectors are linked to repositories, and the board filters by
 * them.
 */

export const REPOS_METHOD = 'agent-hub/repos'

export interface RepoMember {
  workspaceId: string
  path: string
  title: string
  /** Checked-out branch; absent on a detached HEAD. */
  branch?: string
  /** This is the repository's main working tree. */
  main: boolean
}

export interface RepoGroup {
  /** The main working tree's path: the repository's identity. */
  key: string
  /** Its folder name. */
  name: string
  /** Main tree first (when registered), then the registry's order. */
  members: RepoMember[]
}

/** `adopt`: register every working tree of every registered repository; answers how many were new. */
export type ReposRequest = { op: 'list' } | { op: 'adopt' }

/** One spelling per path for comparisons made in the browser (the host compares with `pathKey`). */
export function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => path.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const x = norm(a)
  const y = norm(b)
  return x === y || x.toLowerCase() === y.toLowerCase() && /^[a-z]:\//i.test(x)
}
