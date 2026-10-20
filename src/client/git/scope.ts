/**
 * A scoped graph (one ref's history) can hide the names of other branches
 * that point into that history, e.g. a branch checked out at one of its
 * commits, so only the scoped ref (with its upstream or local twin) and tags
 * stay labelled. The choice is one flag for every repository.
 *
 * Refs starred in the scope picker sit on top of it, remembered per repository.
 */

import type { Ref } from '../../git/types.ts'

const KEY = 'dsh-agent-hub.git.graph.scopeRefsOnly'

export function readScopeRefsOnly(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function writeScopeRefsOnly(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
  } catch {
    // Not persisted.
  }
}

/**
 * The names a scoped graph keeps labelled: the scope itself, its upstream
 * when it is a local branch, the local branches tracking it when it is a
 * remote one. Tags are not branches and always stay.
 */
export function scopeNames(refs: readonly Ref[], scope: string): Set<string> {
  const names = new Set([scope])
  for (const ref of refs) {
    if (ref.kind === 'head' && ref.name === scope && ref.upstream !== undefined) names.add(ref.upstream)
    if (ref.kind === 'head' && ref.upstream === scope) names.add(ref.name)
  }
  return names
}

export const keepRef = (ref: Ref, names: ReadonlySet<string>): boolean => ref.kind === 'tag' || names.has(ref.name)

const STARRED_KEY = 'dsh-agent-hub.git.graph.starred'
/** Repositories remembered; the least recently changed are forgotten past this. */
const STARRED_KEEP = 64

function readAllStarred(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STARRED_KEY) ?? '{}')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** The ref names starred in this repository's scope picker. */
/** `fallback`: an older key the same stars may be saved under, read when `repo` has none. */
export function readStarred(repo: string, fallback?: string): string[] {
  const all = readAllStarred()
  const stored = all[repo] ?? (fallback === undefined ? undefined : all[fallback])
  return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : []
}

/** `replaces`: an older key for the same stars, dropped so it is not read back as a fallback. */
export function writeStarred(repo: string, names: readonly string[], replaces?: string): void {
  try {
    const all = readAllStarred()
    delete all[repo]
    if (replaces !== undefined) delete all[replaces]
    if (names.length > 0) all[repo] = [...new Set(names)]
    const repos = Object.keys(all)
    for (const name of repos.slice(0, Math.max(0, repos.length - STARRED_KEEP))) delete all[name]
    localStorage.setItem(STARRED_KEY, JSON.stringify(all))
  } catch {
    // Not persisted.
  }
}
