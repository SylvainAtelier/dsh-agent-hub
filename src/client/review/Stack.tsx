/**
 * Stacked pull requests: one based on another's branch sits above it. The lane draws a stack as
 * one rail, its top first and its base branch at the foot, like `git log --graph`: the cards the
 * list shows on it, and the rest of the stack (not asked of me, or filtered out) as slim rows that
 * open the same detail. More than two such rows in a row fold into one until opened.
 *
 * The detail shows the stack again, the pull request open marked; a review picks there which of the
 * others its analysis reads as context (kept in its sheet, or until the analysis that writes one).
 * My own pull requests only show it.
 */

import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { stacksOf, type ReviewItem, type ReviewState, type Stacks } from '../../review/types.ts'
import type { ReviewStore } from './api.ts'
import { t } from './i18n.ts'
import { PhaseChip, useSheet } from './Sheet.tsx'

export interface StackIndex {
  stacks: Stacks
  byKey: Map<string, ReviewItem>
}

/** The stacks among the list and the pull requests stacked with it. */
export function stackIndex(state: ReviewState | undefined): StackIndex {
  const all = [...state?.items ?? [], ...state?.related ?? []]
  return { stacks: stacksOf(all), byKey: new Map(all.map((item) => [item.key, item])) }
}

interface Row {
  item: ReviewItem
  level: number
  /** A card of the list, not a slim row. */
  shown: boolean
}

export type LaneEntry =
  | { kind: 'card'; item: ReviewItem }
  /** Top of the stack first; `base` is the branch its bottom merges into. */
  | { kind: 'stack'; root: string; rows: Row[]; base: string }

/** A stack's rows, top first. */
function rowsOf(index: StackIndex, root: string, shown: (key: string) => boolean): Row[] {
  return index.stacks.rows(root).flatMap(({ key, level }) => {
    const item = index.byKey.get(key)
    return item === undefined ? [] : [{ item, level, shown: shown(key) }]
  }).reverse()
}

/** The lane's entries: a card alone, or its whole stack where its first card would be. */
export function laneEntries(items: readonly ReviewItem[], index: StackIndex): LaneEntry[] {
  const listed = new Set(items.map((item) => item.key))
  const placed = new Set<string>()
  const out: LaneEntry[] = []
  for (const item of items) {
    const root = index.stacks.rootOf(item.key)
    if (root === undefined) {
      out.push({ kind: 'card', item })
      continue
    }
    if (placed.has(root)) continue
    placed.add(root)
    out.push({ kind: 'stack', root, rows: rowsOf(index, root, (key) => listed.has(key)), base: index.byKey.get(root)?.base ?? '' })
  }
  return out
}

/** Consecutive slim rows past this many fold into one. */
const FOLD_OVER = 2

/** The rail's indent: a side branch's rows go one step in, joined to the rail. */
const level = (value: number): { style: CSSProperties; 'data-branch'?: '' } => ({ style: { '--rv-level': value } as CSSProperties, ...(value > 0 ? { 'data-branch': '' as const } : {}) })

/** Whose it is, beside a slim row's title: mine, or how far its review got. */
function Marks(props: { item: ReviewItem }): ReactNode {
  const { item } = props
  if (item.own === true) return <span className="ab-chip rv-own-chip">{t('mineChip')}</span>
  return item.phase === 'new' ? null : <PhaseChip item={item} />
}

/** A pull request of the stack the list does not show as a card: one line, opening its detail. */
function SlimRow(props: { item: ReviewItem; selected: boolean; onOpen(key: string): void }): ReactNode {
  const { item } = props
  const unasked = !item.requested && item.picked !== true && item.own !== true
  return (
    <button type="button" className="rv-slim" data-selected={props.selected ? '' : undefined} onClick={() => props.onOpen(item.key)}
      title={unasked ? t('stack.unaskedHint') : item.title} aria-label={`#${item.number} ${item.title}${unasked ? ` · ${t('stack.unasked')}` : ''}`}>
      <span className="rv-card-number">#{item.number}</span>
      <span className="rv-slim-title">{item.title}</span>
      {item.author !== '' && item.own !== true && <span className="rv-slim-author">@{item.author}</span>}
      <Marks item={item} />
    </button>
  )
}

/** A stack in the lane: its cards and slim rows on one rail, its base branch at the foot. */
export function StackRail(props: {
  entry: Extract<LaneEntry, { kind: 'stack' }>
  selected: string | undefined
  /** The selection key of a pull request (the board's prefix added). */
  selectKey(key: string): string
  card(item: ReviewItem): ReactNode
  onOpen(key: string): void
}): ReactNode {
  const { entry } = props
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  // Runs of slim rows, each folded when long and not opened.
  const parts: Array<{ rows: Row[]; fold: boolean }> = []
  for (const row of entry.rows) {
    const last = parts.at(-1)
    if (last !== undefined && !row.shown && !last.rows[0]!.shown) last.rows.push(row)
    else parts.push({ rows: [row], fold: false })
  }
  for (const part of parts) part.fold = !part.rows[0]!.shown && part.rows.length > FOLD_OVER && !open.has(part.rows[0]!.item.key)
  const total = entry.rows.length
  return (
    <div className="rv-stack" role="group" aria-label={t('stack.label', { n: total, base: entry.base })}>
      {parts.flatMap((part) => (part.fold
        ? [(
          <div key={`fold:${part.rows[0]!.item.key}`} className="rv-stack-row" {...level(0)}>
            <span className="rv-stack-node" data-fold="" aria-hidden="true" />
            <button type="button" className="rv-slim rv-slim-fold" aria-expanded="false"
              onClick={() => setOpen((current) => new Set(current).add(part.rows[0]!.item.key))}>
              {t('stack.folded', { n: part.rows.length })}
            </button>
          </div>
        )]
        : part.rows.map((row) => (
          <div key={row.item.key} className="rv-stack-row" {...level(row.level)} data-shown={row.shown ? '' : undefined}
            data-selected={props.selected === props.selectKey(row.item.key) ? '' : undefined}>
            <span className="rv-stack-node" aria-hidden="true" />
            {row.shown ? props.card(row.item) : <SlimRow item={row.item} selected={props.selected === props.selectKey(row.item.key)} onOpen={props.onOpen} />}
          </div>
        ))))}
      <div className="rv-stack-base"><code>{entry.base}</code></div>
    </div>
  )
}

/**
 * The stack in a pull request's detail: every pull request of it, the open one marked, each opening
 * its own detail. A review picks the others its analysis reads (`picked`, `onPick`); mine only shows it.
 */
function StackList(props: { item: ReviewItem; index: StackIndex; narrow: boolean; picked?: readonly string[]; onPick?: (keys: string[]) => void; onOpen(key: string): void }): ReactNode {
  const { item, index } = props
  const root = index.stacks.rootOf(item.key)
  if (root === undefined) return null
  const rows = rowsOf(index, root, () => true)
  const picked = new Set(props.picked ?? [])
  // Picks of pull requests no longer in the stack are dropped with the next change.
  const inStack = new Set(rows.map((row) => row.item.key))
  const count = [...picked].filter((key) => inStack.has(key)).length
  const at = rows.length - rows.findIndex((row) => row.item.key === item.key)
  const pick = (key: string, on: boolean): void => {
    const next = new Set([...picked].filter((entry) => inStack.has(entry)))
    if (on) next.add(key)
    else next.delete(key)
    props.onPick?.(rows.map((row) => row.item.key).filter((entry) => next.has(entry)).reverse())
  }
  const base = index.byKey.get(root)?.base ?? ''
  return (
    <details className="rv-stackp" open={!props.narrow}>
      <summary>
        <span className="rv-stackp-title">{t('stack.title', { at, n: rows.length })}</span>
        {props.onPick !== undefined && <span className="rv-stackp-count">{count === 0 ? t('stack.noneRead') : t('stack.reads', { n: count })}</span>}
      </summary>
      <ol className="rv-stack rv-stack-list" aria-label={t('stack.label', { n: rows.length, base })}>
        {rows.map((row) => {
          const current = row.item.key === item.key
          return (
            <li key={row.item.key} className="rv-stack-row" {...level(row.level)} data-current={current ? '' : undefined}
              data-shown={row.item.requested || row.item.picked === true || row.item.own === true ? '' : undefined}>
              <span className="rv-stack-node" aria-hidden="true" />
              <div className="rv-stackp-row">
                <button type="button" className="rv-stackp-pr" aria-current={current ? 'true' : undefined} disabled={current}
                  onClick={() => props.onOpen(row.item.key)} title={current ? undefined : t('stack.open')}>
                  <span className="rv-card-number">#{row.item.number}</span>
                  <span className="rv-slim-title">{row.item.title}</span>
                  {row.item.own !== true && row.item.author !== '' && <span className="rv-slim-author">@{row.item.author}</span>}
                  {current ? <span className="ab-chip rv-own-chip">{t('stack.here')}</span> : <Marks item={row.item} />}
                </button>
                {props.onPick !== undefined && !current && (
                  <label className="rv-stackp-pick" title={t('stack.pickHint')}>
                    <input type="checkbox" checked={picked.has(row.item.key)} onChange={(event) => pick(row.item.key, event.target.checked)} />
                    <span className="rv-sr">{t('stack.pick', { n: row.item.number })}</span>
                  </label>
                )}
              </div>
            </li>
          )
        })}
        <li className="rv-stack-base" aria-label={t('stack.base', { base })}><code>{base}</code></li>
      </ol>
      {props.onPick !== undefined && <p className="rv-stackp-hint">{t(count === 0 ? 'stack.pickNone' : 'stack.pickSome')}</p>}
    </details>
  )
}

/** The detail's stack: picks kept in the sheet once there is one, else by the store until the analysis. */
export function StackPanel(props: { store: ReviewStore; item: ReviewItem; index: StackIndex; narrow: boolean; onOpen(key: string): void }): ReactNode {
  const { store, item } = props
  if (props.index.stacks.rootOf(item.key) === undefined) return null
  if (item.own === true) return <StackList item={item} index={props.index} narrow={props.narrow} onOpen={props.onOpen} />
  return item.phase === 'new'
    ? <StackList item={item} index={props.index} narrow={props.narrow} picked={store.contextOf(item.key)} onPick={(keys) => store.setContext(item, keys)} onOpen={props.onOpen} />
    : <SheetStack {...props} />
}

function SheetStack(props: { store: ReviewStore; item: ReviewItem; index: StackIndex; narrow: boolean; onOpen(key: string): void }): ReactNode {
  const { store, item } = props
  const sheet = useSheet(store, item.path)?.sheet
  const onPick = useCallback((keys: string[]) => store.setContext(item, keys), [store, item])
  const picked = useMemo(() => sheet?.context ?? [], [sheet?.context])
  return <StackList item={item} index={props.index} narrow={props.narrow} picked={picked} {...(sheet === undefined ? {} : { onPick })} onOpen={props.onOpen} />
}
