/**
 * Drill-in panels: a commit's details and a file's diff. Diffs render through
 * the same fixed-row virtual list as the lists, so a 20,000-line diff opens
 * instantly; word-level highlights are computed only for rows in view.
 * Worktree diffs reload when the status changes, so an agent's edits show up
 * live while the diff is open.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { CommitDetail, CommitFile, DiffImage, DiffText, GitReply } from '../../git/types.ts'
import { buildTree, flattenTree, itemsOf, treeMode } from './tree.ts'
import { BadgeView, badgesFor, openCommitMenu, openRefMenu } from './actions.tsx'
import { CodeMark, discardFiles } from './Changes.tsx'
import { absolute, short, splitPath, usePane, useRepo, type DiffTarget } from './context.ts'
import { linesIn, parseConflict, parseDiff, splitRows, wordDiff, type DiffLine, type Span } from './diff.ts'
import { fullDate, t } from './i18n.ts'
import {
  IconBack, IconCheck, IconClose, IconCopy, IconDown, IconExpand, IconInline, IconMinus, IconMore, IconOpen, IconPlus, IconSplit, IconUndo, IconUp, IconWrap, IconChevron, IconFolder, IconList, IconTree,
} from './icons.tsx'
import { Menu, useWidth, VirtualList, type MenuAnchor } from './kit.tsx'
import { isMenuKey } from '../editor/shared.ts'
import { diffCells, diffPoint, pickDiff, selectionMenu, type DiffCell, type DiffPoint, type SelectionPick } from './selection.ts'

/** Where the touch selection toolbar shows; matches `.gp-selection-actions` in style.ts. */
const TOUCH_ACTIONS = '(pointer: coarse), (max-width: 559px)'

function PanelHeader(props: { children: ReactNode; actions?: ReactNode }): ReactNode {
  const pane = usePane()
  return (
    <div className="gp-panel-head">
      <button type="button" className="ah-icon-btn" aria-label={pane.chrome === 'stage' ? t('close') : t('back')}
        title={`${pane.chrome === 'stage' ? t('close') : t('back')} (Esc)`} onClick={pane.back}>
        {pane.chrome === 'stage' || pane.width >= 760 ? <IconClose size={15} /> : <IconBack size={16} />}
      </button>
      <div className="gp-panel-title">{props.children}</div>
      {props.actions !== undefined && <div className="gp-panel-actions">{props.actions}</div>}
    </div>
  )
}

export function withSpans(text: string, spans: readonly Span[] | undefined): ReactNode {
  if (spans === undefined || spans.length === 0) return text === '' ? ' ' : text
  const out: ReactNode[] = []
  let at = 0
  spans.forEach((span, i) => {
    if (span.start > at) out.push(text.slice(at, span.start))
    out.push(<mark key={i}>{text.slice(span.start, span.end)}</mark>)
    at = span.end
  })
  if (at < text.length) out.push(text.slice(at))
  return out
}

const MODE_KEY = 'dsh-agent-hub.git.diffMode'
const WRAP_KEY = 'dsh-agent-hub.git.diffWrap'

/** Width of one monospace column inside `ref`, measured once from a hidden run of digits. */
function useCharWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const probe = document.createElement('span')
    probe.className = 'gp-probe'
    probe.setAttribute('aria-hidden', 'true')
    probe.textContent = '0'.repeat(100)
    element.appendChild(probe)
    setWidth(probe.offsetWidth / 100)
    probe.remove()
  }, [ref])
  return width
}

type Loaded = { state: 'loading' } | { state: 'ready'; diff: DiffText } | { state: 'error'; message: string }

const sameDiff = (a: DiffText, b: DiffText): boolean =>
  a.text === b.text && a.binary === b.binary && a.truncated === b.truncated
  && a.images?.before?.url === b.images?.before?.url && a.images?.before?.size === b.images?.before?.size
  && a.images?.after?.url === b.images?.after?.url && a.images?.after?.size === b.images?.after?.size

export function DiffPanel(props: { target: DiffTarget; siblings?: DiffTarget[] }): ReactNode {
  const { target, siblings } = props
  const pane = usePane()
  const { repo } = pane
  const statusKey = useRepo(repo, (state) => (target.source === 'commit' ? undefined : state.status?.key))
  const [full, setFull] = useState(false)
  // Two remembered choices: the docked sidebar defaults to inline, the workspace view to side by side.
  const inWorkspace = pane.chrome === 'stage'
  const modeKey = inWorkspace ? `${MODE_KEY}.workspace` : MODE_KEY
  const [modes, setModes] = useState<Record<string, 'inline' | 'split'>>({})
  const stored = modes[modeKey] ?? localStorage.getItem(modeKey)
  const mode: 'inline' | 'split' = stored === 'split' || (stored !== 'inline' && inWorkspace) ? 'split' : 'inline'
  const setMode = (next: 'inline' | 'split'): void => setModes((old) => ({ ...old, [modeKey]: next }))
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === '1')
  const toggleWrap = (): void => {
    localStorage.setItem(WRAP_KEY, wrap ? '0' : '1')
    setWrap(!wrap)
  }
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const root = useRef<HTMLDivElement>(null)
  const targetKey = `${target.source}:${target.hash ?? ''}:${target.path}`
  const lastTarget = useRef(targetKey)

  useEffect(() => {
    let live = true
    // Same file re-read after a status change: keep showing the old diff meanwhile.
    if (lastTarget.current !== targetKey) setLoaded({ state: 'loading' })
    lastTarget.current = targetKey
    void repo.diff({ op: 'diff', source: target.source, path: target.path, ...(target.from ? { from: target.from } : {}), ...(target.hash ? { hash: target.hash } : {}), full })
      .then((reply) => {
        if (!live) return
        // An unrelated change elsewhere in the tree re-reads this file too: an identical diff keeps its parse and render.
        setLoaded((old) => reply.ok && old.state === 'ready' && sameDiff(old.diff, reply.value) ? old
          : reply.ok ? { state: 'ready', diff: reply.value } : { state: 'error', message: reply.error.message })
      })
    return () => { live = false }
  }, [targetKey, full, statusKey, repo])

  useEffect(() => { root.current?.focus({ preventScroll: true }) }, [targetKey])

  const index = siblings?.findIndex((item) => item.source === target.source && item.path === target.path) ?? -1
  const go = (step: number): void => {
    const next = siblings?.[index + step]
    if (next !== undefined) pane.open({ kind: 'diff', target: next, siblings }, 'replace')
  }
  // Side by side needs room in this panel itself, not the whole pane (three columns share it).
  const ownWidth = useWidth(root)
  const images = loaded.state === 'ready' ? loaded.diff.images : undefined
  const canSplit = (ownWidth || pane.width) >= 640 && target.source !== 'conflict' && target.source !== 'untracked' && images === undefined
  const effective = canSplit ? mode : 'inline'
  const conflict = target.source === 'conflict'
  const { name, dir } = splitPath(target.path)
  const parsed = useMemo(() => (loaded.state === 'ready' && !conflict ? parseDiff(loaded.diff.text) : undefined), [loaded, conflict])
  const conflictView = useMemo(() => (loaded.state === 'ready' && conflict ? parseConflict(loaded.diff.text) : undefined), [loaded, conflict])
  const busy = useRepo(repo, (state) => state.busy)
  const cells = useMemo(() => diffCells(parsed?.lines ?? [], effective), [parsed, effective])
  // Conflict text is picked through the same model as a one-column diff.
  const conflictModel = useMemo(() => {
    if (conflictView === undefined) return undefined
    const lines = conflictView.lines.map((line): DiffLine => ({ kind: 'ctx', text: line.text, new: line.no }))
    return { lines, cells: diffCells(lines, 'inline') }
  }, [conflictView])
  // The last selection in this diff as two model points: cheap to keep on every selectionchange and still
  // valid while a menu or the touch toolbar holds focus. Its text and draft are built only when acted on.
  const points = useRef<{ anchor: DiffPoint; head: DiffPoint }>()
  const [selected, setSelected] = useState(false)
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; pick?: SelectionPick }>()
  const readPoints = (): { anchor: DiffPoint; head: DiffPoint } | undefined => {
    const element = root.current
    const selection = window.getSelection()
    if (element === null || selection === null || selection.isCollapsed) return undefined
    const anchor = diffPoint(element, selection.anchorNode, selection.anchorOffset)
    const head = diffPoint(element, selection.focusNode, selection.focusOffset)
    return anchor === undefined || head === undefined ? undefined : { anchor, head }
  }
  const pickAt = (at: { anchor: DiffPoint; head: DiffPoint } | undefined): SelectionPick | undefined => {
    const model: { lines: readonly DiffLine[]; cells: readonly DiffCell[] } | undefined = conflictModel ?? (parsed === undefined ? undefined : { lines: parsed.lines, cells })
    if (at === undefined || model === undefined) return undefined
    const source = pane.root === undefined ? target : { ...target, path: absolute(pane.root, target.path), ...(target.from ? { from: absolute(pane.root, target.from) } : {}) }
    return pickDiff(model.lines, model.cells, at.anchor, at.head, source)
  }
  const readPick = (): SelectionPick | undefined => pickAt(readPoints())
  useEffect(() => {
    setMenu(undefined)
    points.current = undefined
    setSelected(false)
  }, [targetKey, loaded, effective, pane.insert, pane.visible])
  useEffect(() => {
    const changed = (): void => {
      // The menu and touch toolbar must keep their snapshot while they own focus.
      const active = document.activeElement
      if (active instanceof Element && active.closest('.gp-menu, .gp-selection-actions')) return
      points.current = readPoints()
      // Only the touch toolbar shows this state: re-render when it appears or goes, not on every drag step.
      setSelected(points.current !== undefined && matchMedia(TOUCH_ACTIONS).matches && pickAt(points.current) !== undefined)
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [parsed, conflictModel, cells, targetKey, pane.root])
  const selectionDeps = { insert: (draft: string) => pane.insert?.(draft) === true, repo, backToSession: pane.backToSession }
  const runSelection = (id: string, captured: SelectionPick | undefined): void => {
    setMenu(undefined)
    selectionMenu(captured, selectionDeps).onSelect(id)
    root.current?.focus({ preventScroll: true })
  }
  /** The keyboard menu opens at the selection when it is in view, else at the panel's corner. */
  const keyboardAnchor = (): MenuAnchor => {
    const panel = root.current!.getBoundingClientRect()
    const box = readPoints() === undefined ? undefined : window.getSelection()?.getRangeAt(0).getBoundingClientRect()
    if (box === undefined || (box.width === 0 && box.height === 0)) return { x: panel.left + 16, y: panel.top + 48 }
    return { x: Math.min(Math.max(box.left, panel.left), panel.right - 16), y: Math.min(Math.max(box.bottom, panel.top + 48), panel.bottom - 8) }
  }

  const actions = (
    <>
      {siblings !== undefined && siblings.length > 1 && <>
        <button type="button" className="ah-icon-btn" disabled={index <= 0} aria-label={t('prev')} title={`${t('prev')} (Alt+↑)`} onClick={() => go(-1)}><IconUp size={15} /></button>
        <button type="button" className="ah-icon-btn" disabled={index < 0 || index >= siblings.length - 1} aria-label={t('next')} title={`${t('next')} (Alt+↓)`} onClick={() => go(1)}><IconDown size={15} /></button>
      </>}
      {canSplit && (
        <button type="button" className="ah-icon-btn" aria-label={effective === 'split' ? t('inline') : t('split')} title={effective === 'split' ? t('inline') : t('split')}
          onClick={() => {
            const next = mode === 'split' ? 'inline' : 'split'
            localStorage.setItem(modeKey, next)
            setMode(next)
          }}>
          {effective === 'split' ? <IconInline size={15} /> : <IconSplit size={15} />}
        </button>
      )}
      {parsed !== undefined && (
        <button type="button" className="ah-icon-btn" aria-pressed={wrap} aria-label={t('wrapLines')} title={`${t('wrapLines')} (Alt+Z)`}
          onClick={toggleWrap}><IconWrap size={15} /></button>
      )}
      {!conflict && target.source !== 'untracked' && images === undefined && (
        <button type="button" className="ah-icon-btn" aria-pressed={full} aria-label={full ? t('hunksOnly') : t('fullFile')} title={full ? t('hunksOnly') : t('fullFile')}
          onClick={() => setFull(!full)}><IconExpand size={15} /></button>
      )}
      {target.source !== 'commit' && target.code !== 'D' && pane.openFile !== undefined && pane.root !== undefined && (
        <button type="button" className="ah-icon-btn" aria-label={t('openFile')} title={t('openFile')} onClick={() => pane.openFile!(absolute(pane.root!, target.path))}><IconOpen size={14} /></button>
      )}
      {(target.source === 'unstaged' || target.source === 'untracked') && <>
        <button type="button" className="ah-icon-btn" aria-label={t('discard')} title={t('discard')} disabled={busy !== undefined}
          onClick={() => discardFiles(pane, [{ path: target.path, code: target.code }])}><IconUndo size={15} /></button>
        <button type="button" className="ah-btn ah-btn-sm" title={t('stage')} aria-label={t('stage')} disabled={busy !== undefined} onClick={() => void repo.run({ op: 'stage', paths: [target.path] })}>
          <IconPlus size={13} />{pane.width >= 480 && <span>{t('stage')}</span>}
        </button>
      </>}
      {target.source === 'staged' && (
        <button type="button" className="ah-btn ah-btn-sm" title={t('unstage')} aria-label={t('unstage')} disabled={busy !== undefined} onClick={() => void repo.run({ op: 'unstage', paths: [target.path] })}>
          <IconMinus size={13} />{pane.width >= 480 && <span>{t('unstage')}</span>}
        </button>
      )}
    </>
  )

  let body: ReactNode
  if (loaded.state === 'loading') body = <div className="gp-skeleton-list gp-mono">{Array.from({ length: 10 }, (_, i) => <div key={i} className="gp-skeleton-row" style={{ width: `${40 + ((i * 37) % 55)}%` }} />)}</div>
  else if (loaded.state === 'error') body = <div className="gp-state"><p>{t('loadFailed', { error: loaded.message })}</p></div>
  else if (images !== undefined && (images.before !== undefined || images.after !== undefined)) body = <ImageBody before={images.before} after={images.after} />
  else if (loaded.diff.binary) body = <div className="gp-state"><p>{t('binary')}</p></div>
  else if (conflictView !== undefined) body = <ConflictBody view={conflictView} path={target.path} />
  else if (parsed !== undefined && parsed.lines.length === 0) body = <div className="gp-state"><p>{t('emptyDiff')}</p></div>
  else if (parsed !== undefined) body = <DiffBody lines={parsed.lines} width={parsed.width} mode={effective} wrap={wrap} />

  return (
    <div ref={root} className="gp-panel" tabIndex={-1}
      onMouseDownCapture={(event) => { if (event.button === 2 && readPick() !== undefined) event.preventDefault() }}
      onContextMenu={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest('.gp-diff')) return
        event.preventDefault()
        event.stopPropagation()
        setMenu({ anchor: { x: event.clientX, y: event.clientY }, pick: readPick() })
      }} onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (isMenuKey(event)) {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ anchor: keyboardAnchor(), pick: readPick() ?? pickAt(points.current) })
        return
      }
      if (event.key === 'Escape') pane.back()
      else if (event.altKey && event.key === 'ArrowUp') go(-1)
      else if (event.altKey && event.key === 'ArrowDown') go(1)
      // By key position: Option+Z on a Mac types Ω.
      else if (event.altKey && event.code === 'KeyZ' && parsed !== undefined) toggleWrap()
      else return
      event.preventDefault()
      event.stopPropagation()
    }}>
      <PanelHeader actions={actions}>
        <CodeMark code={target.code} />
        <span className="gp-panel-name" title={target.path}>{name}</span>
        {pane.width >= 420 && <span className="gp-file-dir">{dir}</span>}
        {parsed !== undefined && (parsed.added > 0 || parsed.deleted > 0) && (
          <span className="gp-stat"><span data-k="add">+{parsed.added}</span><span data-k="del">−{parsed.deleted}</span></span>
        )}
      </PanelHeader>
      {loaded.state === 'ready' && loaded.diff.truncated && <p className="gp-note">{t('diffTruncated')}</p>}
      {body}
      {selected && <div className="gp-selection-actions" role="toolbar" aria-label={t('selectionMenu')}>
        <button type="button" className="gp-text-btn" onClick={() => runSelection('copy', pickAt(points.current))}>{t('copySelection')}</button>
        <button type="button" className="gp-text-btn" onClick={() => runSelection('add', pickAt(points.current))}>{t('addToSession')}</button>
      </div>}
      {menu !== undefined && <Menu anchor={menu.anchor} {...selectionMenu(menu.pick, selectionDeps)}
        onSelect={(id) => runSelection(id, menu.pick)} onClose={() => { setMenu(undefined); root.current?.focus({ preventScroll: true }) }} />}
    </div>
  )
}

function DiffBody(props: { lines: DiffLine[]; width: number; mode: 'inline' | 'split'; wrap: boolean }): ReactNode {
  const { lines, mode, wrap } = props
  const pane = usePane()
  const rowHeight = pane.coarse ? 22 : 20
  const spans = useMemo(() => new Map<number, Span[]>(), [lines])
  const spansOf = (index: number): Span[] | undefined => {
    const line = lines[index]!
    if (line.pair === undefined) return undefined
    let found = spans.get(index)
    if (found === undefined) {
      const other = lines[line.pair]!
      const [del, add] = line.kind === 'del' ? wordDiff(line.text, other.text) : wordDiff(other.text, line.text)
      spans.set(line.kind === 'del' ? index : line.pair, del)
      spans.set(line.kind === 'add' ? index : line.pair, add)
      found = spans.get(index)!
    }
    return found
  }
  const digits = String(lines.reduce((max, line) => Math.max(max, line.old ?? 0, line.new ?? 0), 0)).length
  if (mode === 'split') return <SplitDiff lines={lines} width={props.width} digits={digits} rowHeight={rowHeight} spansOf={spansOf} wrap={wrap} />
  return <InlineDiff lines={lines} width={props.width} digits={digits} rowHeight={rowHeight} spansOf={spansOf} wrap={wrap} />
}

function InlineDiff(props: { lines: DiffLine[]; width: number; digits: number; rowHeight: number; spansOf: (index: number) => Span[] | undefined; wrap: boolean }): ReactNode {
  const { lines, digits, rowHeight, spansOf, wrap } = props
  const listRef = useRef<HTMLDivElement>(null)
  const listWidth = useWidth(listRef)
  const charWidth = useCharWidth(listRef)
  const gutter = `${Math.max(2, digits) + 1}ch`
  // Wrapped: text columns left beside two gutters (each 10px of padding), the marker and a little room on the right.
  const room = wrap && charWidth > 0 && listWidth > 0
    ? Math.max(20, Math.floor((listWidth - 2 * ((Math.max(2, digits) + 1) * charWidth + 10) - 14 - 8) / charWidth)) : 0
  const fullRoom = wrap && charWidth > 0 && listWidth > 0 ? Math.max(20, Math.floor((listWidth - 16) / charWidth)) : 0
  const starts = useMemo(() => {
    if (room === 0) return undefined
    const out = [0]
    for (const line of lines) out.push(out[out.length - 1]! + linesIn(line.text, line.kind === 'hunk' || line.kind === 'note' ? fullRoom : room))
    return out
  }, [lines, room, fullRoom])
  const textStyle = room === 0 ? undefined : { width: `${room}ch` }
  return (
    <VirtualList listRef={listRef} className={wrap ? 'gp-diff gp-mono gp-wrap' : 'gp-diff gp-mono'} count={lines.length} rowHeight={rowHeight} starts={starts}
      innerWidth={wrap ? undefined : `calc(${props.width}ch + ${digits * 2 + 6}ch)`}
      render={(index, style) => {
        const line = lines[index]!
        if (line.kind === 'hunk' || line.kind === 'note') {
          return <div key={index} style={style} className="gp-dl" data-k={line.kind} data-diff-cell={index}><span className="gp-dt" style={room === 0 ? undefined : { width: `${fullRoom}ch` }}>{line.text}</span></div>
        }
        return (
          <div key={index} style={style} className="gp-dl" data-k={line.kind} data-diff-cell={index}>
            <span className="gp-ln" style={{ width: gutter }}>{line.old}</span>
            <span className="gp-ln" style={{ width: gutter }}>{line.new}</span>
            <span className="gp-dm">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span className="gp-dt" style={textStyle}>{withSpans(line.text, line.kind === 'ctx' ? undefined : spansOf(index))}</span>
          </div>
        )
      }} />
  )
}

/**
 * Side by side: each half is exactly half the panel, whatever the line
 * lengths. Long lines scroll horizontally under one shared offset (wheel,
 * Shift+wheel or the bar below), with line numbers pinned. Wrapped, a row is as tall as its taller half.
 */
function SplitDiff(props: { lines: DiffLine[]; width: number; digits: number; rowHeight: number; spansOf: (index: number) => Span[] | undefined; wrap: boolean }): ReactNode {
  const { lines, digits, spansOf } = props
  const split = useMemo(() => splitRows(lines), [lines])
  const cellIndices = useMemo(() => new Map(diffCells(lines, 'split').map((cell, index) => [`${cell.side}:${cell.index}`, index])), [lines])
  const gutter = `${Math.max(2, digits) + 1}ch`
  const wrap = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const wrapWidth = useWidth(wrap)
  const [charWidth, setCharWidth] = useState(0)
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => { if (probe.current !== null) setCharWidth(probe.current.offsetWidth / 100) }, [])
  // Text room per half: half the panel minus the line-number gutter (its ch plus 10px padding) and the divider.
  const room = wrapWidth / 2 - (Math.max(2, digits) + 1) * charWidth - 11
  const measured = charWidth > 0 && wrapWidth > 0
  const overflow = !measured || props.wrap ? 0 : Math.max(0, Math.ceil(props.width * charWidth + 16 - room))
  // Wrapped text columns per half (8px kept on the right; 10px off the list for its scrollbar) and across both.
  const halfRoom = props.wrap && measured ? Math.max(10, Math.floor(((wrapWidth - 10) / 2 - (Math.max(2, digits) + 1) * charWidth - 11 - 8) / charWidth)) : 0
  const fullRoom = props.wrap && measured ? Math.max(20, Math.floor((wrapWidth - 10 - 16) / charWidth)) : 0
  const starts = useMemo(() => {
    if (halfRoom === 0) return undefined
    const out = [0]
    for (const row of split) {
      const height = row.full !== undefined ? linesIn(lines[row.full]!.text, fullRoom)
        : Math.max(row.left === undefined ? 1 : linesIn(lines[row.left]!.text, halfRoom), row.right === undefined ? 1 : linesIn(lines[row.right]!.text, halfRoom))
      out.push(out[out.length - 1]! + height)
    }
    return out
  }, [split, lines, halfRoom, fullRoom])
  const halfStyle = halfRoom === 0 ? undefined : { width: `${halfRoom}ch` }
  useEffect(() => {
    const element = wrap.current
    if (element === null || overflow === 0) return
    const onWheel = (event: WheelEvent): void => {
      const dx = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0
      if (dx === 0 || bar.current === null) return
      event.preventDefault()
      bar.current.scrollLeft += dx
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [overflow])

  const half = (index: number | undefined, side: 'old' | 'new'): ReactNode => {
    if (index === undefined) return <div className="gp-dl gp-half" data-k="none" />
    const line = lines[index]!
    return (
      <div className="gp-dl gp-half" data-k={line.kind} data-diff-cell={cellIndices.get(`${side}:${index}`)}>
        <span className="gp-ln" style={{ width: gutter }}>{side === 'old' ? line.old : line.new}</span>
        <span className="gp-dt" style={halfStyle}>{withSpans(line.text, line.kind === 'ctx' ? undefined : spansOf(index))}</span>
      </div>
    )
  }
  return (
    <div ref={wrap} className="gp-split-wrap" style={{ '--gp-sx': `${Math.min(offset, overflow)}px` } as CSSProperties}>
      <span ref={probe} className="gp-mono gp-probe" aria-hidden="true">{'0'.repeat(100)}</span>
      <VirtualList className={props.wrap ? 'gp-diff gp-mono gp-wrap' : 'gp-diff gp-mono'} count={split.length} rowHeight={props.rowHeight} starts={starts}
        render={(index, style) => {
          const row = split[index]!
          if (row.full !== undefined) {
            const line = lines[row.full]!
            return <div key={index} style={style} className="gp-dl" data-k={line.kind} data-diff-cell={cellIndices.get(`inline:${row.full}`)}><span className="gp-dt" style={fullRoom === 0 ? undefined : { width: `${fullRoom}ch` }}>{line.text}</span></div>
          }
          return <div key={index} style={style} className="gp-split-row">{half(row.left, 'old')}{half(row.right, 'new')}</div>
        }} />
      {overflow > 0 && (
        <div ref={bar} className="gp-hbar" onScroll={(event) => setOffset(event.currentTarget.scrollLeft)}>
          <div style={{ width: `calc(100% + ${overflow}px)` }} />
        </div>
      )}
    </div>
  )
}

const byteSize = (size: number): string =>
  size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

/** A changed image: the old and new versions side by side (stacked when narrow), each fit to its half. */
function ImageBody(props: { before?: DiffImage; after?: DiffImage }): ReactNode {
  const [dims, setDims] = useState<Record<string, string>>({})
  const side = (key: 'before' | 'after', image: DiffImage | undefined): ReactNode => (
    <figure className="gp-img-side" data-k={key === 'before' ? 'del' : 'add'}>
      <figcaption>
        <span>{key === 'before' ? t('imageBefore') : t('imageAfter')}</span>
        {image !== undefined && <span className="gp-muted">{[dims[key], byteSize(image.size)].filter(Boolean).join(' · ')}</span>}
      </figcaption>
      <div className="gp-img-frame">
        {image?.url !== undefined
          ? <img src={image.url} alt="" onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            setDims((old) => ({ ...old, [key]: `${naturalWidth}×${naturalHeight}` }))
          }} />
          : <span className="gp-muted">{image === undefined ? t('imageNone') : t('imageTooLarge')}</span>}
      </div>
    </figure>
  )
  return (
    <div className="gp-img-diff" data-gp-scroll="">
      {side('before', props.before)}
      {side('after', props.after)}
    </div>
  )
}

function ConflictBody(props: { view: ReturnType<typeof parseConflict>; path: string }): ReactNode {
  const { view, path } = props
  const pane = usePane()
  const busy = useRepo(pane.repo, (state) => state.busy)
  const rowHeight = pane.coarse ? 22 : 20
  const gutter = `${Math.max(2, String(view.lines.length).length) + 1}ch`
  const resolve = async (side?: 'ours' | 'theirs'): Promise<void> => {
    const reply = await pane.repo.run({ op: 'resolve', path, ...(side === undefined ? {} : { side }) }, { done: 'done' })
    if (reply.ok) pane.back()
  }
  return (
    <>
      <div className="gp-conflict-bar">
        <span>{t('conflicts')} · {view.blocks}</span>
        <span className="gp-grow" />
        <button type="button" className="ah-btn ah-btn-sm" disabled={busy !== undefined} onClick={() => void resolve('ours')}>{t('takeOurs')}</button>
        <button type="button" className="ah-btn ah-btn-sm" disabled={busy !== undefined} onClick={() => void resolve('theirs')}>{t('takeTheirs')}</button>
        <button type="button" className="ah-btn ah-btn-sm" data-variant="primary" disabled={busy !== undefined} onClick={() => void resolve()}>
          <IconCheck size={13} /><span>{t('resolve')}</span>
        </button>
      </div>
      <VirtualList className="gp-diff gp-mono" count={view.lines.length} rowHeight={rowHeight} innerWidth={`calc(${view.width}ch + 8ch)`}
        render={(index, style) => {
          const line = view.lines[index]!
          return (
            <div key={index} style={style} className="gp-dl" data-region={line.region} data-diff-cell={index}>
              <span className="gp-ln" style={{ width: gutter }}>{line.no}</span>
              <span className="gp-dt">{line.text === '' ? ' ' : line.text}</span>
            </div>
          )
        }} />
    </>
  )
}

export function CommitPanel(props: { hash: string }): ReactNode {
  const pane = usePane()
  const { repo } = pane
  const [reply, setReply] = useState<GitReply<CommitDetail> | undefined>()
  const refs = useRepo(repo, (state) => state.log?.refs)
  const branch = useRepo(repo, (state) => state.status?.branch)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    setReply(undefined)
    void repo.show(props.hash).then((value) => { if (live) setReply(value) })
    return () => { live = false }
  }, [props.hash, repo])
  useEffect(() => { root.current?.focus({ preventScroll: true }) }, [props.hash])
  const detail = reply?.ok ? reply.value : undefined
  const commitRefs = useMemo(() => (refs ?? []).filter((ref) => ref.hash === detail?.hash), [refs, detail?.hash])
  const tree = useSyncExternalStore(treeMode.subscribe, treeMode.get)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const fileTree = useMemo(() => (detail === undefined ? undefined : buildTree(detail.files, (file) => file.path)), [detail])
  // Diff prev/next follows what is on screen: tree order (folders first) or the commit's own order.
  const targets = useMemo<DiffTarget[]>(() => {
    if (detail === undefined) return []
    const files = tree && fileTree !== undefined ? itemsOf(fileTree) : detail.files
    return files.map((file) => ({ source: 'commit', hash: detail.hash, path: file.path, code: file.code, ...(file.from ? { from: file.from } : {}) }))
  }, [detail, tree, fileTree])
  const added = detail?.files.reduce((sum, file) => sum + file.added, 0) ?? 0
  const deleted = detail?.files.reduce((sum, file) => sum + file.deleted, 0) ?? 0
  const openedPath = pane.activeDiff?.source === 'commit' && pane.activeDiff.hash === detail?.hash ? pane.activeDiff.path : undefined
  const openFile = (path: string): void => {
    const target = targets.find((item) => item.path === path)
    if (target !== undefined && detail !== undefined) pane.showDiff(target, targets, `${short(detail.hash)} · ${detail.subject}`)
  }

  return (
    <div ref={root} className="gp-panel" tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        pane.back()
      }
    }}>
      <PanelHeader actions={detail !== undefined && (
        <button type="button" className="ah-icon-btn" aria-label={t('more')} aria-haspopup="menu"
          onClick={(event) => openCommitMenu(pane, detail, commitRefs, { x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), align: 'end' })}>
          <IconMore size={15} />
        </button>
      )}>
        <span className="gp-panel-name gp-mono">{short(props.hash)}</span>
      </PanelHeader>
      {reply === undefined && <div className="gp-skeleton-list">{Array.from({ length: 6 }, (_, i) => <div key={i} className="gp-skeleton-row" />)}</div>}
      {reply !== undefined && !reply.ok && <div className="gp-state"><p>{t('loadFailed', { error: reply.error.message })}</p></div>}
      {detail !== undefined && (
        <div className="gp-commit-detail" data-gp-scroll="">
          <h3 className="gp-detail-subject">{detail.subject}</h3>
          {detail.body !== '' && <pre className="gp-detail-body">{detail.body}</pre>}
          {commitRefs.length > 0 && (
            <div className="gp-detail-refs">
              {badgesFor(commitRefs, branch).map((badge) => (
                <BadgeView key={`${badge.ref.kind}:${badge.ref.name}`} badge={badge} onMenu={(anchor) => openRefMenu(pane, badge.ref, anchor)} />
              ))}
            </div>
          )}
          <div className="gp-detail-meta">
            <span className="gp-avatar" aria-hidden="true">{detail.author.slice(0, 1).toUpperCase()}</span>
            <div className="gp-detail-who">
              <span title={detail.email}>{detail.author}</span>
              <span className="gp-muted">{fullDate(detail.at)}{detail.committer !== detail.author ? ` · ${t('committer')} ${detail.committer}` : ''}</span>
            </div>
          </div>
          <div className="gp-detail-hashes">
            <button type="button" className="gp-chip gp-mono" title={t('copyHash')}
              onClick={() => void navigator.clipboard?.writeText(detail.hash).then(() => repo.toast('ok', t('copied')))}>
              <IconCopy size={12} />{short(detail.hash)}
            </button>
            {detail.parents.length > 0 && <span className="gp-muted">{t('parents')}</span>}
            {detail.parents.map((parent) => (
              <button key={parent} type="button" className="gp-chip gp-mono" onClick={() => pane.open({ kind: 'commit', hash: parent }, 'replace')}>{short(parent)}</button>
            ))}
          </div>
          <div className="gp-detail-files-head">
            <span>{t('files', { n: detail.files.length })}</span>
            <span className="gp-grow" />
            <span className="gp-stat"><span data-k="add">+{added}</span><span data-k="del">−{deleted}</span></span>
            <TreeToggle />
          </div>
          <div className="gp-detail-files" role="list">
            {tree && fileTree !== undefined
              ? flattenTree(fileTree, closed).slice(0, 3000).map((row) => {
                if (row.kind === 'dir') {
                  return (
                    <div key={`d:${row.dir.path}`} role="button" tabIndex={0} className="gp-row gp-dir" aria-expanded={row.open}
                      style={{ paddingLeft: 2 + row.depth * 14 }} title={row.dir.path}
                      onClick={() => setClosed((old) => {
                        const next = new Set(old)
                        if (next.has(row.dir.path)) next.delete(row.dir.path)
                        else next.add(row.dir.path)
                        return next
                      })}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.click() }}>
                      <span className="gp-chevron" data-open={row.open ? '' : undefined}><IconChevron size={12} /></span>
                      <span className="gp-file-icon"><IconFolder size={14} /></span>
                      <span className="gp-file-name">{row.dir.name}</span>
                      <span className="gp-dir-count">{row.dir.count}</span>
                    </div>
                  )
                }
                const file = row.file.item
                return <CommitFileRow key={file.path} file={file} name={row.file.name} dir="" indent={2 + row.depth * 14 + 22}
                  active={openedPath === file.path} onOpen={() => openFile(file.path)} />
              })
              : detail.files.slice(0, 2000).map((file) => {
                const { name, dir } = splitPath(file.path)
                return <CommitFileRow key={file.path} file={file} name={name} dir={dir} active={openedPath === file.path} onOpen={() => openFile(file.path)} />
              })}
          </div>
        </div>
      )}
    </div>
  )
}

export function CommitFileRow(props: { file: CommitFile; name: string; dir: string; indent?: number; active: boolean; onOpen: () => void }): ReactNode {
  const { file } = props
  return (
    <div role="button" tabIndex={0} className="gp-row gp-file" data-active={props.active ? '' : undefined}
      style={props.indent === undefined ? undefined : { paddingLeft: props.indent }}
      title={file.from ? `${file.from} → ${file.path}` : file.path}
      onClick={props.onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onOpen() }}>
      <span className="gp-file-name">{props.name}</span>
      <span className="gp-file-dir">{props.dir}</span>
      {!file.binary && <span className="gp-stat gp-stat-sm"><span data-k="add">+{file.added}</span><span data-k="del">−{file.deleted}</span></span>}
      <CodeMark code={file.code} />
    </div>
  )
}

/** List ⇄ tree switch for changed-file lists; the choice is shared by every list. */
export function TreeToggle(): ReactNode {
  const tree = useSyncExternalStore(treeMode.subscribe, treeMode.get)
  const label = tree ? t('viewAsList') : t('viewAsTree')
  return (
    <button type="button" className="ah-icon-btn" aria-label={label} title={label} aria-pressed={tree} onClick={() => treeMode.set(!tree)}>
      {tree ? <IconList size={15} /> : <IconTree size={15} />}
    </button>
  )
}
