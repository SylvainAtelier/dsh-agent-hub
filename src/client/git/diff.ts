/**
 * Unified diff → display rows, plus word-level highlighting for paired
 * deleted/added lines. Both are pure and cheap enough to run on every load;
 * word diffs are computed lazily per visible pair.
 */

export type LineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'note'

export interface DiffLine {
  kind: LineKind
  text: string
  old?: number
  new?: number
  /** Index of the opposite-side line this one pairs with (del ↔ add). */
  pair?: number
}

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  deleted: number
  /** Widest line, in characters (tabs counted as 4). */
  width: number
}

const visualWidth = (text: string): number => {
  let width = 0
  for (const char of text) width += char === '\t' ? 4 : 1
  return width
}

// Wide (CJK, emoji) characters take two columns, tabs four; a guess that errs on the tall side.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
function columns(text: string): number {
  let width = 0
  for (const char of text) width += char === '\t' ? 4 : char.charCodeAt(0) >= 0x1100 && WIDE.test(char) ? 2 : 1
  return width
}

/** Screen lines a diff line takes when wrapped at `room` columns. */
export const linesIn = (text: string, room: number): number => Math.max(1, Math.ceil(columns(text) / room))

export function parseDiff(text: string): ParsedDiff {
  const lines: DiffLine[] = []
  let added = 0
  let deleted = 0
  let width = 0
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  // Pending run of deletions waiting for the additions they pair with.
  let dels: number[] = []
  let adds = 0
  const raw = text.split('\n')
  if (raw[raw.length - 1] === '') raw.pop()
  for (const line of raw) {
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
      if (match) {
        oldNo = Number(match[1])
        newNo = Number(match[2])
        inHunk = true
        dels = []
        lines.push({ kind: 'hunk', text: line })
        continue
      }
    }
    if (!inHunk) continue
    const mark = line[0]
    const body = line.slice(1).replace(/\r$/, '')
    if (mark === '+') {
      const index = lines.length
      const partner = dels[adds]
      const entry: DiffLine = { kind: 'add', text: body, new: newNo++ }
      if (partner !== undefined) {
        entry.pair = partner
        lines[partner]!.pair = index
      }
      adds++
      lines.push(entry)
      added++
    } else if (mark === '-') {
      if (adds > 0) {
        dels = []
        adds = 0
      }
      dels.push(lines.length)
      lines.push({ kind: 'del', text: body, old: oldNo++ })
      deleted++
    } else if (mark === '\\') {
      lines.push({ kind: 'note', text: line.slice(2) })
      continue
    } else {
      dels = []
      adds = 0
      if (mark === ' ' || mark === undefined) lines.push({ kind: 'ctx', text: body, old: oldNo++, new: newNo++ })
      else continue
    }
    const w = visualWidth(body)
    if (w > width) width = w
  }
  return { lines, added, deleted, width }
}

/** Plain text (conflicted file) → context rows, conflict markers flagged. */
export interface ConflictLine {
  text: string
  no: number
  region: 'none' | 'ours' | 'theirs' | 'base' | 'marker'
}

export function parseConflict(text: string): { lines: ConflictLine[]; width: number; blocks: number } {
  const lines: ConflictLine[] = []
  let region: ConflictLine['region'] = 'none'
  let width = 0
  let blocks = 0
  const raw = text.split('\n')
  if (raw[raw.length - 1] === '') raw.pop()
  raw.forEach((value, i) => {
    const line = value.replace(/\r$/, '')
    let own = region
    if (line.startsWith('<<<<<<<')) {
      region = 'ours'
      own = 'marker'
      blocks++
    } else if (line.startsWith('|||||||') && region !== 'none') {
      region = 'base'
      own = 'marker'
    } else if (line.startsWith('=======') && region !== 'none') {
      region = 'theirs'
      own = 'marker'
    } else if (line.startsWith('>>>>>>>') && region !== 'none') {
      region = 'none'
      own = 'marker'
    }
    lines.push({ text: line, no: i + 1, region: own })
    width = Math.max(width, visualWidth(line))
  })
  return { lines, width, blocks }
}

/** A highlighted range inside a line, in UTF-16 offsets. */
export interface Span {
  start: number
  end: number
}

const TOKEN = /\w+|\s+|[^\w\s]/gu

/**
 * The changed ranges between two lines: token LCS for short lines, common
 * prefix/suffix otherwise. Returns `[deletedSpans, addedSpans]`.
 */
export function wordDiff(a: string, b: string): [Span[], Span[]] {
  if (a === b) return [[], []]
  const ta = a.match(TOKEN) ?? []
  const tb = b.match(TOKEN) ?? []
  if (ta.length * tb.length > 40_000) return affix(a, b)
  const n = ta.length
  const m = tb.length
  const dp = new Uint16Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = ta[i] === tb[j]
        ? dp[(i + 1) * (m + 1) + j + 1]! + 1
        : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!)
    }
  }
  const keepA = new Uint8Array(n)
  const keepB = new Uint8Array(m)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      keepA[i++] = 1
      keepB[j++] = 1
    } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++
    else j++
  }
  // Mostly rewritten lines read better whole than as confetti.
  const common = keepA.reduce((sum, keep, k) => sum + (keep ? ta[k]!.length : 0), 0)
  if (common < Math.min(a.length, b.length) * 0.3) return [[{ start: 0, end: a.length }], [{ start: 0, end: b.length }]]
  return [spans(ta, keepA), spans(tb, keepB)]
}

function spans(tokens: string[], keep: Uint8Array): Span[] {
  const out: Span[] = []
  let offset = 0
  for (let k = 0; k < tokens.length; k++) {
    const length = tokens[k]!.length
    if (!keep[k]) {
      const last = out[out.length - 1]
      if (last !== undefined && last.end === offset) last.end += length
      else out.push({ start: offset, end: offset + length })
    }
    offset += length
  }
  return out
}

function affix(a: string, b: string): [Span[], Span[]] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return [endA > start ? [{ start, end: endA }] : [], endB > start ? [{ start, end: endB }] : []]
}

/** Side-by-side rows: each pairs an old-side line with a new-side line. */
export interface SplitRow {
  left?: number
  right?: number
  /** Hunk header or note spanning both sides. */
  full?: number
}

export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind === 'del' || line.kind === 'add') {
      const dels: number[] = []
      const adds: number[] = []
      while (i < lines.length && lines[i]!.kind === 'del') dels.push(i++)
      while (i < lines.length && lines[i]!.kind === 'add') adds.push(i++)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const row: SplitRow = {}
        if (dels[k] !== undefined) row.left = dels[k]
        if (adds[k] !== undefined) row.right = adds[k]
        rows.push(row)
      }
    } else if (line.kind === 'ctx') {
      rows.push({ left: i, right: i })
      i++
    } else {
      rows.push({ full: i })
      i++
    }
  }
  return rows
}
