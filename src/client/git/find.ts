/** Finding commits in the graph: plain, case-insensitive substring matches. */

import type { Commit, Ref } from '../../git/types.ts'

/** The query as matching compares it: trimmed, lower case. */
export const findKey = (query: string): string => query.trim().toLowerCase()

/** A commit matches on its subject, author, email, a hash prefix (4+ hex digits) or a ref name at it. */
export function commitMatches(commit: Commit, refs: readonly Ref[], key: string): boolean {
  if (key === '') return false
  return commit.subject.toLowerCase().includes(key)
    || commit.author.toLowerCase().includes(key)
    || commit.email.toLowerCase().includes(key)
    || (key.length >= 4 && /^[0-9a-f]+$/.test(key) && commit.hash.startsWith(key))
    || refs.some((ref) => ref.name.toLowerCase().includes(key))
}

/** `text` cut into plain and matching runs, in order; matching runs sit at odd indexes. */
export function splitMatches(text: string, key: string): string[] {
  if (key === '') return [text]
  const lower = text.toLowerCase()
  // Lower-casing can change length (e.g. 'İ'); fall back to no highlight rather than cut wrongly.
  if (lower.length !== text.length) return [text]
  const parts: string[] = []
  let from = 0
  for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + key.length)) {
    parts.push(text.slice(from, at), text.slice(at, at + key.length))
    from = at + key.length
  }
  parts.push(text.slice(from))
  return parts
}
