/**
 * Author filtering for the graph. `git log --author` drops commits without
 * rewriting their children's parents, so lanes would dangle into commits that
 * never arrive. Instead the history is read whole (once per refs state), and
 * filtered here: each kept commit's parents become its nearest kept ancestors,
 * so a filtered graph still reads as connected branches.
 */

import type { Author, Commit } from './types.ts'

/** One identity per email (case-insensitive); the name when there is no email. */
export const authorKey = (email: string, name: string): string => (email.trim() || name.trim()).toLowerCase()

/** Ancestors kept per dropped commit at most: bounds memory on merge-heavy histories. */
const MAX_NEAREST = 8

function merge(into: string[], from: readonly string[]): void {
  for (const hash of from) if (into.length < MAX_NEAREST && !into.includes(hash)) into.push(hash)
}

/**
 * The commits by `keys`, in the given order, parents rewritten. `commits` must
 * list children before parents (git's date or topo order). A parent outside
 * the list (a history cut short) is dropped.
 */
export function filterByAuthors(commits: readonly Commit[], keys: ReadonlySet<string>): Commit[] {
  const kept = new Set<string>()
  for (const commit of commits) if (keys.has(authorKey(commit.email, commit.author))) kept.add(commit.hash)
  // Nearest kept ancestors of each dropped commit, resolved oldest first so parents are ready.
  const nearest = new Map<string, readonly string[]>()
  const resolve = (hash: string): readonly string[] => (kept.has(hash) ? [hash] : nearest.get(hash) ?? [])
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i]!
    if (kept.has(commit.hash)) continue
    const found: string[] = []
    for (const parent of commit.parents) merge(found, resolve(parent))
    if (found.length > 0) nearest.set(commit.hash, found)
  }
  const out: Commit[] = []
  for (const commit of commits) {
    if (!kept.has(commit.hash)) continue
    const parents: string[] = []
    for (const parent of commit.parents) merge(parents, resolve(parent))
    out.push({ ...commit, parents })
  }
  return out
}

/** Everyone in `commits`, most commits first; each named as in their newest commit. */
export function listAuthors(commits: readonly Commit[]): Author[] {
  const byKey = new Map<string, Author>()
  for (const commit of commits) {
    const key = authorKey(commit.email, commit.author)
    if (key === '') continue
    const found = byKey.get(key)
    if (found === undefined) byKey.set(key, { key, name: commit.author || commit.email, email: commit.email, count: 1 })
    else found.count++
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
