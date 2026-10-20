/** Fixed-height row geometry, with one optional block of free height inserted after a row. */

export interface Gap {
  after: number
  height: number
}

/** Where row `index` starts: rows below the inserted block shift down by its height. */
export function rowTop(index: number, rowHeight: number, gap?: Gap): number {
  return index * rowHeight + (gap !== undefined && index > gap.after ? gap.height : 0)
}

/** The row whose lines hold line `line`, given each row's first line (`starts`, count + 1 entries). */
export function rowAtLine(starts: readonly number[], line: number): number {
  let low = 0
  let high = starts.length - 2
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= line) low = mid
    else high = mid - 1
  }
  return Math.max(0, low)
}
