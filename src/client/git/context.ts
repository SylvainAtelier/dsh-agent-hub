/** What every part of one git pane reaches for: the repo, navigation, overlays. */

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ChangeCode, DiffSource, GitStatus } from '../../git/types.ts'
import type { DialogSpec, MenuAnchor, MenuEntry } from './kit.tsx'
import type { RepoState, RepoStore } from './store.ts'
import type { ConnectorsStore } from '../connectors/api.ts'
import type { BoardReply, StartResult } from '../../board/types.ts'
import type { Issue } from '../../connectors/types.ts'

/** Start work on a ticket in the repository `cwd` is in: the board's own start (worktree, then the ticket moves). */
export type StartIssue = (issue: Pick<Issue, 'identifier' | 'title' | 'branch'>, cwd: string, base?: string) => Promise<BoardReply<StartResult>>

export interface DiffTarget {
  source: DiffSource
  path: string
  from?: string
  hash?: string
  code: ChangeCode
}

export type Panel =
  | { kind: 'diff'; target: DiffTarget; siblings?: DiffTarget[] }
  | { kind: 'commit'; hash: string }

export type View = 'changes' | 'graph' | 'trees'

export interface MenuState {
  anchor: MenuAnchor
  entries: MenuEntry[]
  onSelect: (id: string) => void
  label?: string
  className?: string
}

export interface PaneApi {
  repo: RepoStore
  /** Repository root as the host resolved it. */
  root: string | undefined
  /** The git dir every worktree of the repository shares. */
  common?: string | undefined
  width: number
  coarse: boolean
  visible?: boolean
  /** Open a panel. `replace` swaps the top panel (next/prev file) instead of stacking. */
  open(panel: Panel, mode?: 'push' | 'replace' | 'reset'): void
  back(): void
  top: Panel | undefined
  /** Every open panel, bottom first. */
  stack: readonly Panel[]
  dialog(spec: DialogSpec): void
  menu(state: MenuState): void
  openFile?: (absolutePath: string) => void
  /** Bound to the originating session, never inferred from the repository or active DOM. */
  insert?: (text: string) => boolean
  backToSession?: () => void
  /** Start a session in a DSH workspace (a worktree's), its composer prefilled with `draft`; absent where the shell offers no navigation. */
  openWorkspace?: (workspaceId: string, draft?: string) => void
  /** Linear tickets (connectors module); `getSnapshot().issues` says whether Linear is connected. */
  tickets?: ConnectorsStore
  /** Start work on a picked ticket; absent without the board. */
  startIssue?: StartIssue
  setView(view: View): void
  /** The diff on screen (stage or panel), for highlighting its row. */
  activeDiff?: DiffTarget
  /** Show a file's diff: over the middle column when the stage host is mounted, else as a panel. */
  showDiff(target: DiffTarget, siblings?: DiffTarget[], context?: string): void
  /** `stage`: this pane API drives the diff stage (its header closes rather than goes back). */
  chrome?: 'stage'
}

export const PaneContext = createContext<PaneApi | null>(null)

export function usePane(): PaneApi {
  const pane = useContext(PaneContext)
  if (pane === null) throw new Error('git pane context missing')
  return pane
}

export function useRepo<T>(repo: RepoStore, select: (state: RepoState) => T): T {
  return useSyncExternalStore(repo.subscribe, () => select(repo.getSnapshot()))
}

export const sameTarget = (a: DiffTarget | undefined, b: DiffTarget | undefined): boolean =>
  a !== undefined && b !== undefined && a.source === b.source && a.path === b.path && a.hash === b.hash

export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

export const short = (hash: string): string => hash.slice(0, 7)

/**
 * The branch tracks a remote branch of its own name. One started from origin/main tracks main, but a push
 * never goes there: such a branch is still to be published under its name.
 */
export const tracksOwn = (branch: string | undefined, upstream: string | undefined): boolean =>
  branch !== undefined && upstream !== undefined && upstream.slice(upstream.indexOf('/') + 1) === branch
export const ownUpstream = (status: GitStatus): boolean => tracksOwn(status.branch, status.upstream)

/** Join the repo root and a repo-relative path in the root's own separator style. */
export function absolute(root: string, path: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${sep === '\\' ? path.replace(/\//g, '\\') : path}`
}
