/**
 * Parsers for git's machine formats. Every format here is NUL/US separated
 * (`-z`, `%x1f`), so paths with spaces, quotes or non-ASCII never need unquoting.
 */

import type { ChangeCode, Commit, CommitFile, FileChange, Ref, Stash } from './types.ts'

const US = '\x1f'

export interface ParsedStatus {
  branch?: string
  head?: string
  upstream?: string
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: FileChange[]
  conflicts: FileChange[]
  truncated: boolean
}

const code = (letter: string): ChangeCode => ('MADRCTU'.includes(letter) ? letter as ChangeCode : 'M')

/**
 * `git status --porcelain=v2 -z --branch`. Lists past `cap` entries in total
 * are dropped and flagged, so a stray build directory cannot flood the pane.
 */
export function parseStatus(raw: string, cap = 5000): ParsedStatus {
  const out: ParsedStatus = { ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [], truncated: false }
  const fields = raw.split('\0')
  let count = 0
  const push = (list: FileChange[], change: FileChange): void => {
    if (count >= cap) {
      out.truncated = true
      return
    }
    count++
    list.push(change)
  }
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]!
    if (line === '') continue
    const kind = line[0]
    if (kind === '#') {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid' && value !== '(initial)') out.head = value
      else if (key === 'branch.head' && value !== '(detached)') out.branch = value
      else if (key === 'branch.upstream') out.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          out.ahead = Number(match[1])
          out.behind = Number(match[2])
        }
      }
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = line.split(' ')
      const xy = parts[1]!
      const path = parts.slice(kind === '1' ? 8 : 9).join(' ')
      const from = kind === '2' ? fields[++i] : undefined
      const x = xy[0]!
      const y = xy[1]!
      if (x !== '.') push(out.staged, { path, code: code(x), ...(from !== undefined && (x === 'R' || x === 'C') ? { from } : {}) })
      if (y !== '.') push(out.unstaged, { path, code: code(y) })
    } else if (kind === 'u') {
      push(out.conflicts, { path: line.split(' ').slice(10).join(' '), code: 'U' })
    } else if (kind === '?') {
      push(out.untracked, { path: line.slice(2), code: '?' })
    }
  }
  return out
}

/** Log records: `%H US %P US %an US %ae US %at US %s`, NUL separated. */
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s'

export function parseLog(raw: string): Commit[] {
  const commits: Commit[] = []
  for (const record of raw.split('\0')) {
    const line = record.replace(/^\n/, '')
    if (line === '') continue
    const [hash, parents, author, email, at, ...subject] = line.split(US)
    if (hash === undefined || !/^[0-9a-f]+$/.test(hash)) continue
    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '',
      email: email ?? '',
      at: Number(at) * 1000,
      subject: subject.join(US),
    })
  }
  return commits
}

/** `for-each-ref --format=%(objectname)%1f%(*objectname)%1f%(refname)%1f%(upstream:short)`. */
export const REF_FORMAT = '%(objectname)%1f%(*objectname)%1f%(refname)%1f%(upstream:short)'

export function parseRefs(raw: string): Ref[] {
  const refs: Ref[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const [object, peeled, name, upstream] = line.split(US)
    if (object === undefined || name === undefined) continue
    const hash = peeled || object
    if (name.startsWith('refs/heads/')) {
      refs.push({ kind: 'head', name: name.slice(11), hash, ...(upstream ? { upstream } : {}) })
    } else if (name.startsWith('refs/remotes/')) {
      const short = name.slice(13)
      if (!short.endsWith('/HEAD')) refs.push({ kind: 'remote', name: short, hash })
    } else if (name.startsWith('refs/tags/')) {
      refs.push({ kind: 'tag', name: name.slice(10), hash })
    }
  }
  return refs
}

/** `git stash list -z --format=%gd%x1f%ct%x1f%s`. */
export function parseStashes(raw: string): Stash[] {
  const stashes: Stash[] = []
  for (const record of raw.split('\0')) {
    if (record === '') continue
    const [ref, at, ...message] = record.split(US)
    const match = /\{(\d+)\}/.exec(ref ?? '')
    if (!match) continue
    stashes.push({ index: Number(match[1]), at: Number(at) * 1000, message: message.join(US) })
  }
  return stashes
}

/**
 * Join `--name-status -z` and `--numstat -z` for the same range into one
 * list. Renames appear as `R100\0from\0to` and `a\td\t\0from\0to` respectively.
 */
export function parseCommitFiles(nameStatus: string, numstat: string): CommitFile[] {
  const files: CommitFile[] = []
  const names = nameStatus.split('\0')
  for (let i = 0; i < names.length; i++) {
    const status = names[i]!
    if (status === '') continue
    const letter = status[0]!
    if (letter === 'R' || letter === 'C') {
      const from = names[++i] ?? ''
      const path = names[++i] ?? ''
      files.push({ path, from, code: code(letter), added: 0, deleted: 0, binary: false })
    } else {
      files.push({ path: names[++i] ?? '', code: code(letter), added: 0, deleted: 0, binary: false })
    }
  }
  const stats = new Map<string, { added: number; deleted: number; binary: boolean }>()
  const nums = numstat.split('\0')
  for (let i = 0; i < nums.length; i++) {
    const record = nums[i]!
    if (record === '') continue
    const [a, d, path] = record.split('\t')
    let target = path ?? ''
    if (target === '') {
      i++ // rename: from
      target = nums[++i] ?? ''
    }
    stats.set(target, { added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d), binary: a === '-' })
  }
  for (const file of files) Object.assign(file, stats.get(file.path))
  return files
}

/**
 * Turn a file's text into an all-added unified diff, the way an untracked
 * file reads in a diff view.
 */
export function addedDiff(path: string, text: string): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = body === '' ? [] : body.split(/\r?\n/)
  const header = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n`
  if (lines.length === 0) return header
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
}

/** A bytes sample holds a NUL in its first 8000 bytes — git's own binary test. */
export function looksBinary(sample: Uint8Array): boolean {
  const end = Math.min(sample.length, 8000)
  for (let i = 0; i < end; i++) if (sample[i] === 0) return true
  return false
}

export interface ParsedWorktree {
  path: string
  head?: string
  /** Short branch name; absent when detached. */
  branch?: string
  bare: boolean
  locked?: string
  prunable?: string
}

/** `git worktree list --porcelain -z`: attribute lines per tree, trees separated by an empty field. */
export function parseWorktrees(raw: string): ParsedWorktree[] {
  const trees: ParsedWorktree[] = []
  let tree: ParsedWorktree | undefined
  for (const line of raw.split('\0')) {
    if (line === '') {
      tree = undefined
      continue
    }
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      tree = { path: value, bare: false }
      trees.push(tree)
    } else if (tree === undefined) {
      continue
    } else if (key === 'HEAD') tree.head = value
    else if (key === 'branch') tree.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'bare') tree.bare = true
    else if (key === 'locked') tree.locked = value
    else if (key === 'prunable') tree.prunable = value
  }
  return trees
}

/** Entries of `git status --porcelain=v2 -z`, without the header lines or rename sources. */
export function countChanges(raw: string): number {
  let count = 0
  let skip = false
  for (const field of raw.split('\0')) {
    if (skip) {
      skip = false
      continue
    }
    const kind = field[0]
    if (kind === '1' || kind === 'u' || kind === '?') count++
    else if (kind === '2') {
      count++
      skip = true
    }
  }
  return count
}
