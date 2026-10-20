/**
 * The graph's column widths. The description column takes what is left; the
 * graph, author, hash and date columns keep the widths the user dragged them
 * to, remembered per repository. Columns that would squeeze the description
 * below a readable width step aside (hash first, then author, then date), so
 * the same widths work from a phone to a wide window.
 */

export type ColumnId = 'graph' | 'author' | 'hash' | 'date'

/** Widths the user set; a missing one uses its default (the graph's: as wide as its lanes). */
export type ColumnWidths = Partial<Record<ColumnId, number>>

export const COLUMN_DEFAULTS = { author: 112, hash: 64, date: 76 } as const

export const COLUMN_LIMITS: Record<ColumnId, readonly [number, number]> = {
  graph: [20, 480],
  author: [48, 320],
  hash: [48, 120],
  date: [48, 220],
}

/** Each row's own chrome: side insets, trailing padding, the more button and its gap. */
const ROW_CHROME = 4 + 4 + 4 + 24 + 8
const GAP = 8
/** The date column shows the full date from this width on, relative time below it. */
export const FULL_DATE_WIDTH = 132

export interface FittedColumns {
  graph: number
  /** 0: hidden. */
  author: number
  hash: number
  date: number
}

export const clampColumn = (id: ColumnId, width: number): number => {
  const [min, max] = COLUMN_LIMITS[id]
  return Math.round(Math.min(max, Math.max(min, width)))
}

const subjectMin = (width: number): number => Math.max(160, width * 0.4)

/** What the description column gets in `width` px with these columns. */
const subjectWidth = (width: number, fitted: FittedColumns): number => width - ROW_CHROME - fitted.graph - GAP
  - (['author', 'hash', 'date'] as const).reduce((sum, id) => sum + (fitted[id] > 0 ? fitted[id] + GAP : 0), 0)

/** Lay the columns out in `width` px: the graph at most 60% of it, the description at least ~40%. */
export function fitColumns(width: number, widths: ColumnWidths, autoGraph: number): FittedColumns {
  const graph = Math.min(clampColumn('graph', widths.graph ?? autoGraph), Math.max(COLUMN_LIMITS.graph[0], Math.floor(width * 0.6)))
  const fitted: FittedColumns = {
    graph,
    author: clampColumn('author', widths.author ?? COLUMN_DEFAULTS.author),
    hash: clampColumn('hash', widths.hash ?? COLUMN_DEFAULTS.hash),
    date: clampColumn('date', widths.date ?? COLUMN_DEFAULTS.date),
  }
  for (const id of ['hash', 'author', 'date'] as const) {
    if (subjectWidth(width, fitted) >= subjectMin(width)) break
    fitted[id] = 0
  }
  return fitted
}

/**
 * The widest a shown column can be dragged to before the description would
 * drop below its minimum, so widening a column never hides another one.
 */
export function columnRoom(width: number, fitted: FittedColumns, id: ColumnId): number {
  const room = fitted[id] + Math.max(0, subjectWidth(width, fitted) - subjectMin(width))
  return Math.max(fitted[id], id === 'graph' ? Math.min(room, Math.floor(width * 0.6)) : room)
}

const KEY = 'dsh-agent-hub.git.graph.columns'
/** Repositories remembered; the least recently changed are forgotten past this. */
const KEEP = 64

function readAll(): Record<string, ColumnWidths> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, ColumnWidths> : {}
  } catch {
    return {}
  }
}

export function readWidths(repo: string): ColumnWidths {
  const stored = readAll()[repo]
  const widths: ColumnWidths = {}
  if (stored === undefined || stored === null || typeof stored !== 'object') return widths
  for (const id of Object.keys(COLUMN_LIMITS) as ColumnId[]) {
    const value = stored[id]
    if (typeof value === 'number' && Number.isFinite(value)) widths[id] = clampColumn(id, value)
  }
  return widths
}

export function writeWidths(repo: string, widths: ColumnWidths): void {
  try {
    const all = readAll()
    delete all[repo]
    if (Object.keys(widths).length > 0) all[repo] = widths
    const names = Object.keys(all)
    for (const name of names.slice(0, Math.max(0, names.length - KEEP))) delete all[name]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // Not persisted.
  }
}
