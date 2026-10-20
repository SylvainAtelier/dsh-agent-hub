/** Diff selection is resolved against model cells, never the virtual list's mounted text. */
import { splitRows, type DiffLine } from './diff.ts'
import { copyText, textBlock } from '../editor/shared.ts'
import type { DiffTarget, MenuState } from './context.ts'
import { t } from './i18n.ts'
import type { RepoStore } from './store.ts'

export interface DiffCell {
  index: number
  side: 'inline' | 'old' | 'new'
}

export interface DiffPoint {
  cell: number
  offset: number
}

/** A captured selection: the raw text to copy and the composer draft to add. */
export interface SelectionPick {
  text: string
  draft: string
}

/** DOM order, with stable model indices even when intermediate rows are unmounted. */
export function diffCells(lines: readonly DiffLine[], mode: 'inline' | 'split'): DiffCell[] {
  if (mode === 'inline') return lines.map((_, index) => ({ index, side: 'inline' }))
  return splitRows([...lines]).flatMap((row): DiffCell[] => row.full !== undefined
    ? [{ index: row.full, side: 'inline' }]
    : [...(row.left === undefined ? [] : [{ index: row.left, side: 'old' as const }]),
      ...(row.right === undefined ? [] : [{ index: row.right, side: 'new' as const }])])
}

function ranges(values: number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!
    let end = start
    while (sorted[i + 1] === end + 1) end = sorted[++i]!
    out.push(start === end ? `L${start}` : `L${start}-${end}`)
  }
  return out.join(', ')
}

export function pickDiff(lines: readonly DiffLine[], cells: readonly DiffCell[], anchor: DiffPoint, head: DiffPoint, target: DiffTarget): SelectionPick | undefined {
  if (!cells[anchor.cell] || !cells[head.cell]) return undefined
  const [start, end] = anchor.cell < head.cell || (anchor.cell === head.cell && anchor.offset <= head.offset) ? [anchor, head] : [head, anchor]
  if (start.cell === end.cell && start.offset === end.offset) return undefined
  const side = cells[start.cell]!.side === cells[end.cell]!.side ? cells[start.cell]!.side : undefined
  const picked: { cell: DiffCell; line: DiffLine; text: string }[] = []
  for (let i = start.cell; i <= end.cell; i++) {
    const cell = cells[i]!
    // Selecting down one split column must not include the opposite column's text.
    if (side !== undefined && cell.side !== side && cell.side !== 'inline') continue
    const line = lines[cell.index]!
    const from = i === start.cell ? Math.max(0, Math.min(start.offset, line.text.length)) : 0
    const to = i === end.cell ? Math.max(0, Math.min(end.offset, line.text.length)) : line.text.length
    if (i === end.cell && to === 0 && i !== start.cell) continue
    if (from === to && line.text.length > 0) continue
    picked.push({ cell, line, text: line.text.slice(from, to) })
  }
  if (picked.length === 0) return undefined
  const source = target.source === 'commit' ? `commit ${target.hash ?? '(unknown)'}` : target.source
  const sections: string[] = []
  const sides = [...new Set(picked.map(({ cell }) => cell.side))]
  for (const selectedSide of sides) {
    const part = picked.filter(({ cell }) => cell.side === selectedSide)
    const old = ranges(part.flatMap(({ line }) => line.old === undefined ? [] : [line.old]))
    const next = ranges(part.flatMap(({ line }) => line.new === undefined ? [] : [line.new]))
    const location = [selectedSide === 'inline' ? 'Diff' : selectedSide === 'old' ? 'Old version' : 'New version',
      ...(old && selectedSide !== 'new' ? [`old ${old}`] : []), ...(next && selectedSide !== 'old' ? [`new ${next}`] : [])].join(' · ')
    const text = part.map(({ line, text }) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'ctx' ? ' ' : ''}${text}`).join('\n')
    sections.push(`${location}\n${textBlock(text, 'diff')}`)
  }
  return {
    text: picked.map(({ text }) => text).join('\n'),
    draft: `\nDiff: ${JSON.stringify(target.path)}${target.from ? ` (from ${JSON.stringify(target.from)})` : ''}\nSource: ${source}\n${sections.join('\n\n')}\n`,
  }
}

/** Read just a boundary and its UTF-16 text offset, excluding gutters and controls. */
export function diffPoint(root: HTMLElement, node: Node | null, offset: number): DiffPoint | undefined {
  if (node === null || !root.contains(node)) return undefined
  const element = node instanceof Element ? node : node.parentElement
  const cell = element?.closest<HTMLElement>('[data-diff-cell]')
  if (cell === null || cell === undefined || !root.contains(cell)) return undefined
  const text = cell.matches('.gp-dt') ? cell : cell.querySelector<HTMLElement>('.gp-dt')
  if (text === null) return undefined
  const index = Number(cell.dataset.diffCell)
  if (!Number.isInteger(index)) return undefined
  if (!text.contains(node)) return { cell: index, offset: 0 }
  const range = document.createRange()
  range.selectNodeContents(text)
  range.setEnd(node, offset)
  return { cell: index, offset: range.toString().length }
}

/**
 * Copy / add-to-session over a captured selection, shared by the diff panel and the terminal.
 * `insert` is bound to the originating session when the snapshot is taken; feedback is the repo's toasts.
 */
export function selectionMenu(pick: SelectionPick | undefined, deps: { insert: (draft: string) => boolean; repo: RepoStore; backToSession?: (() => void) | undefined }): Pick<MenuState, 'label' | 'entries' | 'onSelect'> {
  return {
    label: t('selectionMenu'),
    entries: [
      { id: 'copy', label: t('copySelection'), disabled: pick === undefined },
      { id: 'add', label: t('addToSession'), disabled: pick === undefined },
    ],
    onSelect: (id) => {
      if (pick === undefined) return
      if (id === 'copy') {
        void copyText(pick.text).then(() => deps.repo.toast('ok', t('copied')), () => deps.repo.toast('error', t('copyFailed')))
      } else if (deps.insert(pick.draft)) {
        deps.repo.toast('ok', t('addedToSession'), undefined, deps.backToSession && { label: t('backToSession'), run: deps.backToSession })
      } else deps.repo.toast('error', t('noComposer'))
    },
  }
}
