/**
 * The branch graph: every ref's history (or one ref's, when scoped) in date
 * order, lanes drawn per row as a tiny SVG so only visible rows cost
 * anything. Uncommitted changes sit on top as a dashed node leading into HEAD.
 * Pages of 400 commits load as the list nears its end.
 *
 * Above the rows: the scope picker, the author filter, the find field, and column headers whose
 * edges drag to resize (widths remembered per repository). Column widths ride
 * on CSS variables, so a drag restyles rows without re-rendering them.
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { authorKey } from '../../git/authors.ts'
import type { AuthorList, Commit, GitReply, GitStatus, Ref } from '../../git/types.ts'
import { BadgeView, badgesFor, openCommitMenu, openRefMenu, runRefAction, type Badge } from './actions.tsx'
import { clampColumn, columnRoom, COLUMN_LIMITS, fitColumns, FULL_DATE_WIDTH, readWidths, writeWidths, type ColumnId, type ColumnWidths } from './columns.ts'
import { short, usePane, useRepo } from './context.ts'
import { commitMatches, findKey, splitMatches } from './find.ts'
import { ago, fullDate, t, type GitKey } from './i18n.ts'
import { IconBranch, IconChevronDown, IconClose, IconDown, IconFilter, IconMore, IconSearch, IconStar, IconTag, IconUp, IconUser } from './icons.tsx'
import { Menu, pressHandlers, rowTop, useWidth, VirtualList, type MenuEntry } from './kit.tsx'
import { InlineDetails } from './Inline.tsx'
import { tipHandlers } from './tip.ts'
import { keepRef, readScopeRefsOnly, readStarred, scopeNames, writeScopeRefsOnly, writeStarred } from './scope.ts'
import { layout, WORKTREE, type GraphRow } from './lanes.ts'

/** The expanded commit and the find query per repository, so they survive tab switches. */
const expandedBy = new Map<string, string>()
const queryBy = new Map<string, string>()
/** Author lists last read, per repository and scope, shown at once while a fresh read runs. */
const authorsBy = new Map<string, AuthorList>()
/** The configured user's author key per repository, once an author list told it. */
const meBy = new Map<string, string>()

/** Lane colors readable on both host themes. */
export const LANE_COLORS = ['#4f8ff7', '#f5a524', '#30a46c', '#e93d82', '#8e4ec6', '#12a594', '#e5484d', '#a18072', '#3e63dd', '#d6a01d']
export const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length]!

const LANE_W = 14
/** Pages a single "next" may load looking for an older match. */
const SEEK_PAGES = 10
/** How long a located row stays marked. */
const LOCATE_MS = 1800

/**
 * Repositories whose graph should bring HEAD into view: asked from the header,
 * served by the graph once it is mounted and has HEAD's page loaded.
 */
const locateWanted = new Set<string>()
const locateListeners = new Set<() => void>()
export function locateHead(cwd: string): void {
  locateWanted.add(cwd)
  for (const listener of locateListeners) listener()
}

function Lanes(props: { row: GraphRow; height: number; head: boolean; merge: boolean; worktree: boolean; located: boolean }): ReactNode {
  const { row, height } = props
  const mid = height / 2
  const x = (lane: number): number => LANE_W / 2 + lane * LANE_W + 2
  const paths: ReactNode[] = []
  row.lines.forEach((line, i) => {
    const x1 = x(line.from)
    const x2 = x(line.to)
    const [y1, y2] = line.half === 'top' ? [0, mid] : [mid, height]
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
    paths.push(<path key={i} d={d} stroke={laneColor(line.color)} strokeDasharray={line.dashed ? '2 3' : undefined} />)
  })
  const cx = x(row.lane)
  const color = laneColor(row.color)
  return (
    <svg className="gp-lanes" height={height} aria-hidden="true">
      <g fill="none" strokeWidth="1.6">{paths}</g>
      {props.located && <circle className="gp-locate-ring" cx={cx} cy={mid} r={4.5} fill="none" stroke={color} strokeWidth="2" />}
      {props.worktree
        ? <circle cx={cx} cy={mid} r={4} fill="var(--ah-bg)" stroke={color} strokeWidth="1.6" strokeDasharray="2 2" />
        : props.head
          ? <circle cx={cx} cy={mid} r={4.5} fill="var(--ah-bg)" stroke={color} strokeWidth="2.2" />
          : <circle cx={cx} cy={mid} r={props.merge ? 3.2 : 4} fill={color} />}
    </svg>
  )
}

/** `text` with the find key's occurrences marked. */
function Marked(props: { text: string; find: string | undefined }): ReactNode {
  if (props.find === undefined) return props.text
  const parts = splitMatches(props.text, props.find)
  if (parts.length === 1) return props.text
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className="gp-mark">{part}</mark> : part))
}

interface Columns { author: boolean; hash: boolean; date: boolean; fullDate: boolean }

interface RowProps {
  commit: Commit
  row: GraphRow
  index: number
  style: CSSProperties
  height: number
  badges: Badge[]
  head: boolean
  selected: boolean
  cursor: boolean
  columns: Columns
  changeCount: number
  /** The find key, on matching rows only. */
  find: string | undefined
  /** A find is on and this row does not match it. */
  dim: boolean
  /** The match the find is at. */
  found: boolean
  /** Just brought into view by the header's locate button. */
  located: boolean
  onOpen: (commit: Commit) => void
  onMenu: (commit: Commit, anchor: { x: number; y: number; rect?: DOMRect }) => void
  onRef: (badge: Badge, anchor: { x: number; y: number; rect?: DOMRect }) => void
  onCheckout: (badge: Badge) => void
}

const MAX_BADGES = 3

const CommitRow = memo(function CommitRow(props: RowProps): ReactNode {
  const { commit, row, columns } = props
  const worktree = commit.hash === WORKTREE
  const press = pressHandlers((anchor) => { if (!worktree) props.onMenu(commit, anchor) })
  const shown = props.badges.slice(0, MAX_BADGES)
  const hidden = props.badges.length - shown.length
  return (
    <div style={props.located ? { ...props.style, '--gp-locate': laneColor(row.color) } as CSSProperties : props.style} className="gp-row gp-commit-row" data-row={props.index} role="option" aria-selected={props.selected}
      data-selected={props.selected ? '' : undefined} data-cursor={props.cursor ? '' : undefined}
      data-worktree={worktree ? '' : undefined} data-dim={props.dim ? '' : undefined} data-found={props.found ? '' : undefined}
      data-located={props.located ? '' : undefined} tabIndex={props.cursor ? 0 : -1}
      title={worktree ? undefined : `${short(commit.hash)} · ${commit.author} · ${fullDate(commit.at)}\n${commit.subject}`}
      onClick={() => props.onOpen(commit)} {...press}>
      <Lanes row={row} height={props.height} head={props.head} merge={commit.parents.length > 1} worktree={worktree} located={props.located} />
      <div className="gp-commit-main">
        {shown.map((badge) => (
          <BadgeView key={`${badge.ref.kind}:${badge.ref.name}`} badge={badge} color={laneColor(row.color)}
            onMenu={(anchor) => props.onRef(badge, anchor)} onActivate={() => props.onCheckout(badge)} clickMenu={false} />
        ))}
        {hidden > 0 && <span className="gp-badge gp-badge-more" title=""
          {...tipHandlers(() => ({ name: t('tipMore', { count: hidden }), color: laneColor(row.color), list: props.badges.slice(MAX_BADGES).map((b) => b.ref.name) }))}>+{hidden}</span>}
        <span className="gp-subject">{worktree ? `${t('uncommitted')} (${props.changeCount})` : <Marked text={commit.subject} find={props.find} />}</span>
      </div>
      {!worktree && columns.author && <span className="gp-author"><Marked text={commit.author} find={props.find} /></span>}
      {!worktree && columns.hash && <span className="gp-hash">{short(commit.hash)}</span>}
      {!worktree && columns.date && <span className="gp-date">{columns.fullDate ? fullDate(commit.at) : ago(commit.at)}</span>}
      {!worktree && (
        <button type="button" className="ah-icon-btn gp-row-more" aria-label={t('more')} aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation()
            props.onMenu(commit, { x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect() })
          }}>
          <IconMore size={15} />
        </button>
      )}
    </div>
  )
})

type Resize = (id: ColumnId, width: number | undefined, done: boolean) => void

/**
 * A column edge to drag (or arrow-key) for width; double-click restores the
 * default. `end`: the column's right edge (the graph); `start`: its left edge
 * (columns right of the description, which take width from it).
 */
function ColumnHandle(props: { id: ColumnId; edge: 'start' | 'end'; width: number; name: string; onResize: Resize }): ReactNode {
  const { id, edge, onResize } = props
  const drag = useRef<{ x: number; width: number; last: number } | undefined>(undefined)
  const sign = edge === 'end' ? 1 : -1
  const [min, max] = COLUMN_LIMITS[id]
  return (
    <span className="gp-col-handle" data-edge={edge} role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t('colResize', { name: props.name })} title={t('colResizeTip')}
      aria-valuenow={props.width} aria-valuemin={min} aria-valuemax={max}
      onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width: props.width, last: props.width }
        onResize(id, props.width, false)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (start === undefined) return
        start.last = clampColumn(id, start.width + sign * (event.clientX - start.x))
        onResize(id, start.last, false)
      }}
      onPointerUp={() => {
        const start = drag.current
        drag.current = undefined
        if (start !== undefined) onResize(id, start.last, true)
      }}
      onPointerCancel={() => {
        const start = drag.current
        drag.current = undefined
        if (start !== undefined) onResize(id, start.width, true)
      }}
      onDoubleClick={() => onResize(id, undefined, true)}
      onKeyDown={(event) => {
        const step = (event.shiftKey ? 32 : 8) * sign
        if (event.key === 'ArrowRight') onResize(id, clampColumn(id, props.width + step), true)
        else if (event.key === 'ArrowLeft') onResize(id, clampColumn(id, props.width - step), true)
        else if (event.key === 'Enter' || event.key === 'Delete' || event.key === 'Backspace') onResize(id, undefined, true)
        else return
        event.preventDefault()
        event.stopPropagation()
      }} />
  )
}

function ColumnHeader(props: { graph: number; author: number; hash: number; date: number; onResize: Resize }): ReactNode {
  const cell = (id: ColumnId, key: GitKey, edge: 'start' | 'end', width: number): ReactNode => (
    <span className="gp-hcell" data-col={id}>
      <span className="gp-hlabel">{t(key)}</span>
      <ColumnHandle id={id} edge={edge} width={width} name={t(key)} onResize={props.onResize} />
    </span>
  )
  return (
    <div className="gp-ghead">
      {cell('graph', 'colGraph', 'end', props.graph)}
      <span className="gp-hcell" data-col="subject"><span className="gp-hlabel">{t('colSubject')}</span></span>
      {props.author > 0 && cell('author', 'colAuthor', 'start', props.author)}
      {props.hash > 0 && cell('hash', 'colHash', 'start', props.hash)}
      {props.date > 0 && cell('date', 'colDate', 'start', props.date)}
      <span className="gp-hcell" data-col="more" />
    </div>
  )
}

const findShortcut = (): string => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘F' : 'Ctrl+F')

/** Pick whose history the graph shows: every ref, or one branch, remote branch or tag. Starred refs sit on top. */
function ScopeMenu(props: {
  rect: DOMRect; refs: readonly Ref[]; scope: string | undefined; branch: string | undefined
  /** Other branches' names hidden in a scoped graph. */
  refsOnly: boolean
  onRefsOnly: (value: boolean) => void
  starred: readonly string[]
  onStar: (name: string) => void
  onPick: (scope: string | undefined) => void
  onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const entries = useMemo<MenuEntry[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (ref: Ref): boolean => q === '' || ref.name.toLowerCase().includes(q)
    const byName = (a: Ref, b: Ref): number => Number(b.name === props.branch) - Number(a.name === props.branch) || a.name.localeCompare(b.name)
    const starred = new Set(props.starred)
    const group = (kind: Ref['kind'] | 'starred'): Ref[] => props.refs
      .filter((ref) => (kind === 'starred' ? starred.has(ref.name) : ref.kind === kind && !starred.has(ref.name)) && match(ref)).sort(byName)
    const item = (ref: Ref): MenuEntry => {
      const on = starred.has(ref.name)
      return {
        id: `r:${ref.name}`, label: ref.name, checked: ref.name === props.scope,
        icon: ref.kind === 'tag' ? <IconTag size={14} /> : <IconBranch size={14} />,
        ...(ref.kind === 'head' && ref.name === props.branch ? { hint: 'HEAD' } : {}),
        trail: { id: `s:${ref.name}`, label: t(on ? 'scopeUnstar' : 'scopeStar'), icon: <IconStar size={14} filled={on} />, on },
      }
    }
    const list: MenuEntry[] = []
    if (q === '' && props.scope !== undefined) {
      list.push({ id: 'refs-only', label: t('scopeRefsOnly'), checked: props.refsOnly, icon: <span className="gp-menu-box" aria-hidden="true" />, hint: t('scopeRefsOnlyHint') }, { separator: true })
    }
    if (q === '') list.push({ id: '*', label: t('scopeAll'), checked: props.scope === undefined, icon: <IconFilter size={14} /> })
    const sections: [GitKey, Ref[]][] = [['scopeStarred', group('starred')], ['branches', group('head')], ['remotes', group('remote')], ['tags', group('tag')]]
    for (const [heading, refs] of sections) if (refs.length > 0) list.push({ heading: t(heading) }, ...refs.slice(0, 200).map(item))
    if (list.length === 0) list.push({ heading: t('noMatch') })
    return list
  }, [query, props.refs, props.scope, props.branch, props.refsOnly, props.starred])
  return (
    <Menu anchor={{ x: props.rect.left, y: props.rect.bottom, rect: props.rect }} entries={entries} label={t('scopeSearch')} keepFocus
      className="gp-picker" onClose={props.onClose}
      top={<input ref={input} className="gp-input gp-picker-search" placeholder={t('scopeSearch')} value={query} spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)} />}
      onSelect={(id) => {
        // A display option: the menu stays open to show it took.
        if (id === 'refs-only') return props.onRefsOnly(!props.refsOnly)
        if (id.startsWith('s:')) return props.onStar(id.slice(2))
        props.onClose()
        props.onPick(id === '*' ? undefined : id.slice(2))
      }} />
  )
}

/** Pick whose commits the graph shows: everyone's, only mine, or any set of authors (they toggle, the menu stays open). */
function AuthorMenu(props: {
  rect: DOMRect; cwd: string; scope: string | undefined
  selected: readonly string[] | undefined
  load: () => Promise<GitReply<AuthorList>>
  onPick: (authors: string[] | undefined) => void
  onClose: () => void
}): ReactNode {
  const cacheKey = `${props.cwd}\0${props.scope ?? ''}`
  const [query, setQuery] = useState('')
  const [data, setData] = useState<AuthorList | { error: string } | undefined>(() => authorsBy.get(cacheKey))
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    let live = true
    void props.load().then((reply) => {
      if (!live) return
      if (reply.ok) {
        authorsBy.set(cacheKey, reply.value)
        if (reply.value.me !== undefined) meBy.set(props.cwd, reply.value.me)
        setData(reply.value)
      } else if (authorsBy.get(cacheKey) === undefined) setData({ error: reply.error.message })
    })
    return () => { live = false }
  }, [cacheKey])
  const selected = props.selected
  const entries = useMemo<MenuEntry[]>(() => {
    const q = query.trim().toLowerCase()
    const chosen = new Set(selected ?? [])
    const list: MenuEntry[] = []
    const people = data !== undefined && 'authors' in data ? data.authors : []
    const me = data !== undefined && 'authors' in data ? data.me : undefined
    const mine = me === undefined ? undefined : people.find((author) => author.key === me)
    if (q === '') {
      list.push({ id: '*', label: t('authorsAll'), checked: selected === undefined, icon: <IconFilter size={14} /> })
      if (me !== undefined) {
        list.push({ id: 'me', label: t('authorsMine'), checked: selected?.length === 1 && selected[0] === me, icon: <IconUser size={14} />, ...(mine === undefined ? {} : { hint: mine.name }) })
      }
      list.push({ separator: true })
    }
    if (data === undefined) return [...list, { heading: t('authorsLoading') }]
    if ('error' in data) return [...list, { heading: t('authorsFailed', { error: data.error }) }]
    const names = new Map<string, number>()
    for (const author of people) names.set(author.name, (names.get(author.name) ?? 0) + 1)
    const match = (text: string): boolean => text.toLowerCase().includes(q)
    // Picked keys this history has no commits by still show, so they can be unpicked.
    const absent = [...chosen].filter((key) => !people.some((author) => author.key === key) && match(key))
      .map((key) => ({ key, name: key, email: '', count: 0 }))
    const shown = [...(mine !== undefined && match(mine.name + mine.email) ? [mine] : []), ...absent,
      ...people.filter((author) => author !== mine && (q === '' || match(author.name) || match(author.email)))]
    list.push({ heading: data.truncated ? `${t('authorsHeading')} · ${t('authorsTruncated', { n: data.authors.reduce((sum, a) => sum + a.count, 0) })}` : t('authorsHeading') })
    if (shown.length === 0) list.push({ heading: t('noMatch') })
    for (const author of shown.slice(0, 300)) {
      const name = (names.get(author.name) ?? 0) > 1 ? `${author.name} <${author.email}>` : author.name
      list.push({
        id: `a:${author.key}`, label: author === mine ? `${name} (${t('authorsMe')})` : name, checked: chosen.has(author.key),
        icon: <span className="gp-menu-box" aria-hidden="true" />, hint: String(author.count),
      })
    }
    return list
  }, [query, data, selected])
  return (
    <Menu anchor={{ x: props.rect.left, y: props.rect.bottom, rect: props.rect }} entries={entries} label={t('authorsFilter')} keepFocus
      className="gp-picker" onClose={props.onClose}
      top={<input ref={input} className="gp-input gp-picker-search" placeholder={t('authorsSearch')} aria-label={t('authorsSearch')} value={query} spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)} />}
      onSelect={(id) => {
        if (id.startsWith('a:')) {
          const key = id.slice(2)
          const next = (selected ?? []).filter((item) => item !== key)
          if (next.length === (selected ?? []).length) next.push(key)
          return props.onPick(next.length === 0 ? undefined : next)
        }
        props.onClose()
        const me = meBy.get(props.cwd)
        props.onPick(id === 'me' && me !== undefined ? [me] : undefined)
      }} />
  )
}

const EMPTY_REFS: Ref[] = []

export function GraphView(props: { status: GitStatus }): ReactNode {
  const { status } = props
  const pane = usePane()
  const { repo } = pane
  const log = useRepo(repo, (state) => state.log)
  useEffect(() => { if (repo.getSnapshot().log === undefined) void repo.loadLog() }, [repo])
  const scope = log?.scope
  const authors = log?.authors
  const changeCount = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length
  const head = log?.head ?? status.head
  const commits = useMemo(() => {
    const list = log?.commits ?? []
    // A scoped or author-filtered graph shows the uncommitted node only where HEAD is in it.
    const headShown = (scope === undefined && authors === undefined) || list.some((commit) => commit.hash === head)
    return changeCount > 0 && head !== undefined && list.length > 0 && headShown
      ? [{ hash: WORKTREE, parents: [head], author: '', email: '', at: Date.now(), subject: '' }, ...list]
      : list
  }, [log?.commits, changeCount > 0, head, scope, authors])
  const graph = useMemo(() => layout(commits), [commits])
  const refsByHash = useMemo(() => {
    const map = new Map<string, Ref[]>()
    for (const ref of log?.refs ?? []) {
      const list = map.get(ref.hash)
      if (list === undefined) map.set(ref.hash, [ref])
      else list.push(ref)
    }
    return map
  }, [log?.refs])
  // Scoped, other branches pointing into this history can go unlabelled (tags stay).
  const [refsOnly, setRefsOnlyState] = useState(readScopeRefsOnly)
  const setRefsOnly = useCallback((value: boolean) => {
    writeScopeRefsOnly(value)
    setRefsOnlyState(value)
  }, [])
  const shownNames = useMemo(() => (scope !== undefined && refsOnly ? scopeNames(log?.refs ?? EMPTY_REFS, scope) : undefined), [scope, refsOnly, log?.refs])
  const shownRefs = useCallback((hash: string): Ref[] => {
    const refs = refsByHash.get(hash) ?? EMPTY_REFS
    return shownNames === undefined ? refs : refs.filter((ref) => keepRef(ref, shownNames))
  }, [refsByHash, shownNames])
  const badgeCache = useMemo(() => new Map<string, Badge[]>(), [shownRefs, status.branch, status.upstream])
  const badges = (hash: string): Badge[] => {
    let found = badgeCache.get(hash)
    if (found === undefined) {
      found = badgesFor(shownRefs(hash), status.branch, status.upstream)
      badgeCache.set(hash, found)
    }
    return found
  }
  // A scope whose ref is gone (deleted, pruned) falls back to every ref.
  useEffect(() => {
    if (scope !== undefined && log !== undefined && !log.loading && log.error === undefined && !log.refs.some((ref) => ref.name === scope)) void repo.setScope(undefined)
  }, [scope, log, repo])

  const rowHeight = pane.coarse ? 36 : 28
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ownWidth = useWidth(wrapRef)
  // This column's own width: in split layouts the graph gets only part of the pane.
  const width = ownWidth || pane.width

  // Column widths: what the user dragged, per repository; the description takes the rest.
  const repoKey = pane.root ?? repo.cwd
  const [widths, setWidths] = useState<ColumnWidths>(() => readWidths(repoKey))
  useEffect(() => setWidths(readWidths(repoKey)), [repoKey])
  // Refs starred in the scope picker, per repository: every worktree shares them. Stars saved per tree before are read once as a fallback.
  const starKey = pane.common ?? repoKey
  const [starred, setStarredState] = useState(() => readStarred(starKey, repoKey))
  useEffect(() => setStarredState(readStarred(starKey, repoKey)), [starKey, repoKey])
  const toggleStar = useCallback((name: string) => {
    setStarredState((old) => {
      const next = old.includes(name) ? old.filter((other) => other !== name) : [...old, name]
      writeStarred(starKey, next, repoKey)
      return next
    })
  }, [starKey, repoKey])
  const [resizing, setResizing] = useState(false)
  const maxLanes = Math.max(3, Math.floor((width * 0.35) / LANE_W))
  // Wide enough for its header label even with a single lane.
  const autoGraph = Math.max(40, Math.min(graph.width, maxLanes) * LANE_W + 6)
  const fitted = fitColumns(width, widths, autoGraph)
  const graphWidth = fitted.graph
  const columns = useMemo<Columns>(() => ({ author: fitted.author > 0, hash: fitted.hash > 0, date: fitted.date > 0, fullDate: fitted.date >= FULL_DATE_WIDTH }),
    [fitted.author > 0, fitted.hash > 0, fitted.date > 0, fitted.date >= FULL_DATE_WIDTH])
  // Room is measured from where the drag started, so a column never grows past what the description can spare.
  const room = useRef<{ id: ColumnId; max: number } | undefined>(undefined)
  const fittedRef = useRef(fitted)
  fittedRef.current = fitted
  const onResize = useCallback<Resize>((id, value, done) => {
    if (room.current?.id !== id) room.current = { id, max: columnRoom(width, fittedRef.current, id) }
    const max = room.current.max
    if (done) room.current = undefined
    setResizing(!done)
    setWidths((old) => {
      const next = { ...old }
      if (value === undefined) delete next[id]
      else next[id] = clampColumn(id, Math.min(value, max))
      if (done) writeWidths(repoKey, next)
      return next
    })
  }, [repoKey, width])
  const vars = {
    '--gp-c-graph': `${fitted.graph}px`, '--gp-c-author': `${fitted.author}px`, '--gp-c-hash': `${fitted.hash}px`, '--gp-c-date': `${fitted.date}px`,
  } as CSSProperties

  const [expanded, setExpandedState] = useState<string | undefined>(() => expandedBy.get(repo.cwd))
  const setExpanded = useCallback((hash: string | undefined) => {
    if (hash === undefined) expandedBy.delete(repo.cwd)
    else expandedBy.set(repo.cwd, hash)
    setExpandedState(hash)
  }, [repo])
  const expandedIndex = expanded === undefined ? -1 : commits.findIndex((commit) => commit.hash === expanded)
  const [gapHeight, setGapHeight] = useState(240)
  const [cursor, setCursor] = useState(0)
  // A commit that left the list (reset, amended, page reload) folds its details away.
  useEffect(() => { if (expanded !== undefined && expandedIndex < 0 && !log?.loading) setExpanded(undefined) }, [expanded, expandedIndex, log?.loading, setExpanded])

  /**
   * Scroll so the expanded commit and its details are in view: the row at the
   * top when they don't fit together, otherwise the least movement.
   */
  const reveal = useCallback((index: number, height: number) => {
    const list = listRef.current
    if (list === null || index < 0) return
    const top = index * rowHeight
    const bottom = top + rowHeight + height
    const view = list.clientHeight
    let next = list.scrollTop
    if (bottom - top > view || top < list.scrollTop) next = Math.max(0, top - 4)
    else if (bottom > list.scrollTop + view) next = bottom - view + 8
    if (next !== list.scrollTop) list.scrollTo({ top: next, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [rowHeight])
  const revealPending = useRef(false)
  const onGapHeight = useCallback((height: number) => {
    setGapHeight((old) => (old === height ? old : height))
  }, [])
  useEffect(() => {
    if (revealPending.current && expandedIndex >= 0) {
      revealPending.current = false
      reveal(expandedIndex, gapHeight)
    }
  }, [gapHeight, expandedIndex, reveal])

  const expand = useCallback((hash: string | undefined) => {
    setExpanded(hash)
    revealPending.current = hash !== undefined
    if (hash !== undefined) {
      const index = commits.findIndex((commit) => commit.hash === hash)
      if (index >= 0) setCursor(index)
      // Measured height arrives with the details; reveal once more if it is already known.
      requestAnimationFrame(() => {
        const at = commits.findIndex((commit) => commit.hash === hash)
        if (at >= 0) reveal(at, gapHeight)
      })
    }
  }, [setExpanded, commits, reveal, gapHeight])

  // Click toggles the details in place. The second click of a double-click
  // (a badge's checkout; the row itself does nothing on double-click) must not fold them again.
  const lastClick = useRef<{ hash: string; at: number } | undefined>(undefined)
  const onOpen = useCallback((commit: Commit) => {
    const now = Date.now()
    const previous = lastClick.current
    lastClick.current = { hash: commit.hash, at: now }
    if (previous?.hash === commit.hash && now - previous.at < 350) return
    expand(expanded === commit.hash ? undefined : commit.hash)
  }, [expand, expanded])
  const onMenu = useCallback((commit: Commit, anchor: { x: number; y: number; rect?: DOMRect }) => {
    openCommitMenu(pane, commit, refsByHash.get(commit.hash) ?? EMPTY_REFS, { ...anchor, align: 'end' })
  }, [pane, refsByHash])
  const onRef = useCallback((badge: Badge, anchor: { x: number; y: number; rect?: DOMRect }) => openRefMenu(pane, badge.ref, anchor), [pane])
  // Double-click a badge: check it out, or pull when it is the current branch's upstream.
  const onCheckout = useCallback((badge: Badge) => { if (!badge.current && badge.ref.kind !== 'tag') runRefAction('checkout', badge.ref, pane) }, [pane])
  const onEnd = useCallback(() => { void repo.loadMore() }, [repo])
  const gap = expandedIndex >= 0 ? { after: expandedIndex, height: gapHeight } : undefined

  const focusRow = (index: number): void => {
    setCursor(index)
    const list = listRef.current
    if (list === null) return
    const y = rowTop(index, rowHeight, gap)
    if (y < list.scrollTop) list.scrollTop = y
    else if (y + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = y + rowHeight - list.clientHeight
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus({ preventScroll: true }))
  }

  // Find: matching rows stand out, the rest dim; Enter steps through matches, loading older pages past the last one.
  const [query, setQueryState] = useState(() => queryBy.get(repo.cwd) ?? '')
  const setQuery = useCallback((next: string) => {
    if (next === '') queryBy.delete(repo.cwd)
    else queryBy.set(repo.cwd, next)
    setQueryState(next)
  }, [repo])
  const key = findKey(useDeferredValue(query))
  const matches = useMemo(() => {
    if (key === '') return []
    const found: number[] = []
    commits.forEach((commit, i) => { if (commit.hash !== WORKTREE && commitMatches(commit, shownRefs(commit.hash), key)) found.push(i) })
    return found
  }, [commits, shownRefs, key])
  const matchSet = useMemo(() => new Set(matches), [matches])
  const [foundHash, setFoundHash] = useState<string | undefined>()
  const foundAt = foundHash === undefined ? -1 : matches.findIndex((index) => commits[index]?.hash === foundHash)
  const findInput = useRef<HTMLInputElement>(null)
  const seek = useRef<{ from: number; pages: number } | undefined>(undefined)
  const [seeking, setSeeking] = useState(false)

  const showRow = useCallback((index: number) => {
    const list = listRef.current
    if (list === null) return
    const y = rowTop(index, rowHeight, gap)
    if (y < list.scrollTop || y + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, y - Math.floor(list.clientHeight / 3))
  }, [rowHeight, gap?.after, gap?.height])
  const goMatch = useCallback((index: number) => {
    setFoundHash(commits[index]!.hash)
    setCursor(index)
    showRow(index)
  }, [commits, showRow])
  const more = log?.more === true
  const step = (direction: 1 | -1): void => {
    if (key === '') return
    const next = foundAt < 0 ? (direction === 1 ? 0 : matches.length - 1) : foundAt + direction
    if (next >= matches.length && more) {
      seek.current = { from: matches.length, pages: 0 }
      setSeeking(true)
      void repo.loadMore()
    } else if (matches.length > 0) {
      goMatch(matches[(next + matches.length) % matches.length]!)
    }
  }
  // A new query lands on its first (newest) match.
  useEffect(() => {
    seek.current = undefined
    setSeeking(false)
    if (matches.length > 0) goMatch(matches[0]!)
    else setFoundHash(undefined)
  }, [key])
  // Looking past the last loaded match: take the first new one, or load another page.
  useEffect(() => {
    const pending = seek.current
    if (pending === undefined || log === undefined || log.loading) return
    if (matches.length > pending.from) {
      seek.current = undefined
      setSeeking(false)
      goMatch(matches[pending.from]!)
    } else if (log.more && log.error === undefined && pending.pages + 1 < SEEK_PAGES) {
      pending.pages++
      void repo.loadMore()
    } else {
      seek.current = undefined
      setSeeking(false)
      if (matches.length > 0) goMatch(matches[0]!)
    }
  }, [matches, log?.loading])

  const [scopeMenu, setScopeMenu] = useState<DOMRect | undefined>()
  const pickScope = (next: string | undefined): void => {
    setExpanded(undefined)
    setCursor(0)
    listRef.current?.scrollTo({ top: 0 })
    void repo.setScope(next)
  }
  const [authorMenu, setAuthorMenu] = useState<DOMRect | undefined>()
  const pickAuthors = (next: string[] | undefined): void => {
    setExpanded(undefined)
    setCursor(0)
    listRef.current?.scrollTo({ top: 0 })
    void repo.setAuthors(next)
  }
  // The button names one author as their commits do; several by count.
  const authorsName = authors === undefined ? undefined
    : authors.length > 1 ? t('authorsN', { n: authors.length })
      : authors[0] === meBy.get(repo.cwd) ? t('authorsMineShort')
        : log?.commits.find((commit) => authorKey(commit.email, commit.author) === authors[0])?.author ?? authors[0]

  // Locate: bring HEAD's row to the middle and mark it briefly. A scope or author filter without HEAD is dropped,
  // and older pages load (as far as find goes) until HEAD's commit is in the list.
  const [locateTick, setLocateTick] = useState(0)
  useEffect(() => {
    const listener = (): void => setLocateTick((n) => n + 1)
    locateListeners.add(listener)
    return () => { locateListeners.delete(listener) }
  }, [])
  const [located, setLocated] = useState<string | undefined>()
  const locatePages = useRef(0)
  useEffect(() => {
    if (!locateWanted.has(repo.cwd) || log === undefined || log.loading) return
    const index = head === undefined ? -1 : commits.findIndex((commit) => commit.hash === head)
    if (index < 0 && head !== undefined && log.error === undefined) {
      if (authors !== undefined) return pickAuthors(undefined)
      if (scope !== undefined) return pickScope(undefined)
      if (log.more && locatePages.current < SEEK_PAGES) {
        locatePages.current++
        void repo.loadMore()
        return
      }
    }
    locateWanted.delete(repo.cwd)
    locatePages.current = 0
    const list = listRef.current
    if (index < 0 || list === null) return
    setCursor(index)
    // Cleared for a frame first, so locating the same row again replays the cue.
    setLocated(undefined)
    requestAnimationFrame(() => setLocated(head))
    const y = rowTop(index, rowHeight, gap)
    const top = Math.max(0, y - Math.floor((list.clientHeight - rowHeight) / 2))
    // Long distances jump: a smooth scroll through thousands of rows is only a blur.
    const far = Math.abs(top - list.scrollTop) > list.clientHeight * 3
    const smooth = !far && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    list.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    const focus = (): void => list.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus({ preventScroll: true })
    if (smooth && top !== list.scrollTop) setTimeout(focus, 360)
    else requestAnimationFrame(focus)
  }, [locateTick, log, commits, head, scope, authors])
  useEffect(() => {
    if (located === undefined) return
    const timer = setTimeout(() => setLocated(undefined), LOCATE_MS)
    return () => clearTimeout(timer)
  }, [located])

  const finding = key !== ''
  const compact = width < 420 && query !== ''
  const countLabel = seeking ? t('findSearching')
    : matches.length === 0 ? t('findNone')
      : `${foundAt < 0 ? 0 : foundAt + 1}/${matches.length}${more ? '+' : ''}`
  const bar = (
    <div className="gp-gbar">
      <div className="gp-scope" data-on={scope !== undefined ? '' : undefined} data-compact={compact ? '' : undefined}>
        <button type="button" className="gp-scope-btn" aria-haspopup="menu" aria-label={t('scopeLabel', { name: scope ?? t('scopeAll') })}
          title={`${t('scopeLabel', { name: scope ?? t('scopeAll') })}${scope !== undefined && refsOnly ? ` · ${t('scopeRefsOnly')}` : ''}`}
          onClick={(event) => setScopeMenu(event.currentTarget.getBoundingClientRect())}>
          {scope === undefined ? <IconBranch size={14} /> : <IconFilter size={14} />}
          <span className="gp-scope-name">{scope ?? t('scopeAll')}</span>
          <IconChevronDown size={12} />
        </button>
        {scope !== undefined && (
          <button type="button" className="gp-scope-clear" aria-label={t('scopeClear')} title={t('scopeClear')} onClick={() => pickScope(undefined)}>
            <IconClose size={12} />
          </button>
        )}
      </div>
      <div className="gp-scope gp-who" data-on={authors !== undefined ? '' : undefined} data-compact={compact || width < 340 ? '' : undefined}>
        <button type="button" className="gp-scope-btn" aria-haspopup="menu"
          aria-label={authorsName === undefined ? t('authorsFilter') : t('authorsLabel', { name: authorsName })}
          title={authorsName === undefined ? t('authorsFilter') : t('authorsLabel', { name: authorsName })}
          onClick={(event) => setAuthorMenu(event.currentTarget.getBoundingClientRect())}>
          <IconUser size={14} />
          {authorsName !== undefined && <span className="gp-scope-name">{authorsName}</span>}
          <IconChevronDown size={12} />
        </button>
        {authors !== undefined && (
          <button type="button" className="gp-scope-clear" aria-label={t('authorsClear')} title={t('authorsClear')} onClick={() => pickAuthors(undefined)}>
            <IconClose size={12} />
          </button>
        )}
      </div>
      <div className="gp-find" data-none={finding && matches.length === 0 && !seeking ? '' : undefined}
        onPointerDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); findInput.current?.focus() } }}>
        <IconSearch size={14} />
        <input ref={findInput} className="gp-find-input" value={query} spellCheck={false} autoComplete="off" enterKeyHint="search"
          placeholder={t('findPlaceholder')} aria-label={t('findPlaceholder')} title={t('findTip', { key: findShortcut() })}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') step(event.shiftKey ? -1 : 1)
            else if (event.key === 'Escape') {
              if (query !== '') setQuery('')
              else listRef.current?.querySelector<HTMLElement>('[data-cursor]')?.focus({ preventScroll: true })
            } else if (event.key === 'ArrowDown' && foundAt >= 0) focusRow(matches[foundAt]!)
            else return
            event.preventDefault()
            event.stopPropagation()
          }} />
        {query !== '' && (
          <>
            <span className="gp-find-count" aria-live="polite" title={more && !seeking ? t('findMoreTip', { n: matches.length }) : undefined}>{countLabel}</span>
            <button type="button" className="ah-icon-btn" aria-label={t('findPrev')} title={t('findPrev')} disabled={matches.length === 0} onClick={() => step(-1)}>
              <IconUp size={14} />
            </button>
            <button type="button" className="ah-icon-btn" aria-label={t('findNext')} title={t('findNext')} disabled={matches.length === 0 && !more} onClick={() => step(1)}>
              <IconDown size={14} />
            </button>
            <button type="button" className="ah-icon-btn" aria-label={t('findClear')} title={t('findClear')}
              onClick={() => { setQuery(''); findInput.current?.focus() }}>
              <IconClose size={14} />
            </button>
          </>
        )}
      </div>
      {scopeMenu !== undefined && (
        <ScopeMenu rect={scopeMenu} refs={log?.refs ?? EMPTY_REFS} scope={scope} branch={status.branch} refsOnly={refsOnly} onRefsOnly={setRefsOnly}
          starred={starred} onStar={toggleStar}
          onPick={pickScope} onClose={() => setScopeMenu(undefined)} />
      )}
      {authorMenu !== undefined && (
        <AuthorMenu rect={authorMenu} cwd={repo.cwd} scope={scope} selected={authors}
          load={() => repo.request({ op: 'authors', ...(scope === undefined ? {} : { ref: scope }) })}
          onPick={pickAuthors} onClose={() => setAuthorMenu(undefined)} />
      )}
    </div>
  )

  let body: ReactNode
  if (log === undefined || (log.loading && log.commits.length === 0)) body = <div className="gp-skeleton-list" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="gp-skeleton-row" />)}</div>
  else if (log.error !== undefined && log.commits.length === 0) {
    body = (
      <div className="gp-state">
        <p>{t('loadFailed', { error: log.error })}</p>
        <button type="button" className="ah-btn" onClick={() => void repo.loadLog()}>{t('retry')}</button>
      </div>
    )
  } else if (commits.length === 0 && authors !== undefined) {
    body = (
      <div className="gp-state">
        <p>{t('authorsEmpty')}</p>
        <button type="button" className="ah-btn" onClick={() => pickAuthors(undefined)}>{t('authorsClear')}</button>
      </div>
    )
  } else if (commits.length === 0) {
    body = scope === undefined
      ? <div className="gp-state"><p>{t('noCommits')}</p></div>
      : (
        <div className="gp-state">
          <p>{t('scopeEmpty', { name: scope })}</p>
          <button type="button" className="ah-btn" onClick={() => pickScope(undefined)}>{t('scopeClear')}</button>
        </div>
      )
  } else {
    const expandedCommit = expandedIndex >= 0 ? commits[expandedIndex]! : undefined
    body = (
      <>
        <ColumnHeader graph={fitted.graph} author={fitted.author} hash={fitted.hash} date={fitted.date} onResize={onResize} />
        <VirtualList listRef={listRef} className="gp-list gp-graph" count={commits.length} rowHeight={rowHeight}
          role="listbox" label={t('graph')} onEndReached={log.more ? onEnd : undefined}
          {...(gap === undefined || expandedCommit === undefined ? {} : {
            gap: {
              ...gap,
              render: (style: CSSProperties) => (
                <InlineDetails key={`gi:${expandedCommit.hash}`} hash={expandedCommit.hash} worktree={expandedCommit.hash === WORKTREE}
                  status={status} refs={refsByHash.get(expandedCommit.hash) ?? EMPTY_REFS} lines={graph.rows[expandedIndex]!.lines}
                  graphWidth={graphWidth} style={style} onHeight={onGapHeight} onClose={() => expand(undefined)}
                  onSelect={(hash) => { if (commits.some((commit) => commit.hash === hash)) expand(hash) }} />
              ),
            },
          })}
          onKeyDown={(event) => {
            if ((event.target as HTMLElement).closest('[data-gi]') !== null) return
            // With details open, ↑↓ carry them to the neighbouring commit, as in Git Graph.
            const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
            if (delta !== 0) {
              const next = Math.max(0, Math.min(commits.length - 1, cursor + delta))
              focusRow(next)
              if (expanded !== undefined) expand(commits[next]!.hash)
            } else if (event.key === 'Home') focusRow(0)
            else if (event.key === 'End') focusRow(commits.length - 1)
            else if ((event.key === 'Enter' || event.key === ' ') && commits[cursor] !== undefined) expand(expanded === commits[cursor]!.hash ? undefined : commits[cursor]!.hash)
            else if (event.key === 'Escape' && expanded !== undefined) expand(undefined)
            else if (event.key === 'Escape' && query !== '') setQuery('')
            else return
            event.preventDefault()
          }}
          render={(index, style) => {
            const commit = commits[index]!
            const match = matchSet.has(index)
            return (
              <CommitRow key={commit.hash} commit={commit} row={graph.rows[index]!} index={index} style={style}
                height={rowHeight} badges={commit.hash === WORKTREE ? [] : badges(commit.hash)}
                head={commit.hash === head} selected={commit.hash === expanded} cursor={index === cursor}
                columns={columns} changeCount={changeCount}
                find={match ? key : undefined} dim={finding && !match} found={match && commit.hash === foundHash} located={commit.hash === located}
                onOpen={onOpen} onMenu={onMenu} onRef={onRef} onCheckout={onCheckout} />
            )
          }} />
      </>
    )
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const typing = (event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]') !== null
    if (((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') || (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      findInput.current?.focus()
      findInput.current?.select()
    }
  }

  return (
    <div ref={wrapRef} className="gp-graph-wrap" style={vars} data-resizing={resizing ? '' : undefined} data-finding={finding ? '' : undefined} onKeyDown={onKeyDown}>
      {bar}
      {body}
    </div>
  )
}
