/**
 * Commit graph layout. Walks commits newest-first, keeping one lane per
 * expected parent. Lanes never shift sideways once assigned (freed slots are
 * reused), so a branch reads as a straight line; joins and forks are drawn as
 * curves into and out of the commit's node in the row's top/bottom half.
 */

export interface LaneLine {
  /** Lane index at the segment's top end. */
  from: number
  /** Lane index at the segment's bottom end. */
  to: number
  /** top: row top → node height; bottom: node height → row bottom. */
  half: 'top' | 'bottom'
  color: number
  dashed: boolean
}

export interface GraphRow {
  lane: number
  color: number
  lines: LaneLine[]
  /** Lanes in use across this row. */
  width: number
}

export interface GraphInput {
  hash: string
  parents: readonly string[]
}

export interface Layout {
  rows: GraphRow[]
  width: number
}

/** Pseudo-commit standing for uncommitted changes; its line to HEAD is dashed. */
export const WORKTREE = '*'

export function layout(commits: readonly GraphInput[]): Layout {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  const dashed: boolean[] = []
  let nextColor = 0
  let widest = 0
  const rows: GraphRow[] = []
  const free = (skip = -1): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== skip) return i
    return lanes.length
  }

  for (const commit of commits) {
    const before = lanes.slice()
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = free()
      lanes[lane] = commit.hash
      colors[lane] = nextColor++
      dashed[lane] = false
    }
    const lines: LaneLine[] = []
    for (let j = 0; j < before.length; j++) {
      const expected = before[j]
      if (expected == null) continue
      if (expected === commit.hash) {
        lines.push({ from: j, to: lane, half: 'top', color: colors[j]!, dashed: dashed[j]! })
        if (j !== lane) lanes[j] = null
      } else {
        lines.push({ from: j, to: j, half: 'top', color: colors[j]!, dashed: dashed[j]! })
      }
    }
    const color = colors[lane]!
    const fromWorktree = commit.hash === WORKTREE
    const parents = commit.parents
    if (parents.length === 0) {
      lanes[lane] = null
    } else {
      lanes[lane] = parents[0]!
      dashed[lane] = fromWorktree
    }
    const forks: LaneLine[] = []
    for (let p = 1; p < parents.length; p++) {
      const parent = parents[p]!
      let target = lanes.indexOf(parent)
      if (target < 0) {
        target = free(lane)
        lanes[target] = parent
        colors[target] = nextColor++
        dashed[target] = fromWorktree
      }
      forks.push({ from: lane, to: target, half: 'bottom', color: colors[target]!, dashed: fromWorktree })
    }
    for (let j = 0; j < lanes.length; j++) {
      const expected = lanes[j]
      if (expected == null) continue
      if (j === lane) lines.push({ from: lane, to: lane, half: 'bottom', color, dashed: dashed[lane]! })
      else if (before[j] === expected) lines.push({ from: j, to: j, half: 'bottom', color: colors[j]!, dashed: dashed[j]! })
    }
    lines.push(...forks)
    const width = Math.max(before.length, lanes.length, lane + 1)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    widest = Math.max(widest, width)
    rows.push({ lane, color, lines, width })
  }
  return { rows, width: widest }
}
