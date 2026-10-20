/**
 * A pull request's changes beside its review sheet: every file in one scrolling list, a header row
 * per file, word-level highlights, the sheet's findings marked on their lines. Rows are fixed
 * height and only those in view render, so a large pull request scrolls as lightly as a small one.
 *
 * A hunk, lines picked by their numbers, or a whole file can be explained by the helper model: the
 * answer streams into a panel under the diff, follow-up questions continue it, and every answer is
 * kept beside the sheet, so reopening one costs nothing. Generated and very large files are folded
 * and read only when shown.
 *
 * Lines picked on the new side (by their numbers, a drag down them, or a line's +) take a comment of
 * mine, written under the diff like an explanation and posted with the review after its preview.
 *
 * Review threads are drawn on their lines (and counted on their file's header), and one opens above
 * the same field to reply, posted at once: on my own pull request, which takes no comment of mine,
 * every thread; on someone else's, those I started wait on me once answered. A thread is placed on
 * the head the diff shows, or on no line when it was left on another and GitHub has moved on since.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { anchorOf, isMine, type Explained, type ExplainTarget, type Explanation, type Finding, type PullDiff, type PullFile, type PullThread, type ReviewItem } from '../../review/types.ts'
import { CodeMark } from '../git/Changes.tsx'
import { withSpans } from '../git/Detail.tsx'
import { linesIn, parseDiff, splitRows, wordDiff, type DiffLine, type Span } from '../git/diff.ts'
import { IconChevron, IconChevronDown, IconClose, IconDown, IconInline, IconSplit, IconUp, IconWrap } from '../git/icons.tsx'
import { Menu, useCoarse, useWidth, VirtualList, type MenuAnchor } from '../git/kit.tsx'
import { rowAtLine } from '../git/rows.ts'
import { injectGitStyle } from '../git/style.ts'
import type { ReviewStore } from './api.ts'
import { t, uiLang, type ReviewKey } from './i18n.ts'
import { Markdown } from './Markdown.tsx'
import { Composer, type CommentTarget } from './Compose.tsx'

/** Scroll the diff to a file (and line), picking the lines from `start`; `thread` opens that review thread there; `nonce` repeats the same place. */
export interface Reveal {
  path: string
  line?: number
  start?: number
  thread?: string
  nonce: number
}

type Mode = 'inline' | 'split'
const MODE_KEY = 'dsh-agent-hub.review.diffMode'
const WRAP_KEY = 'dsh-agent-hub.review.diffWrap'
/** Side by side needs this much of the diff's own width. */
const SPLIT_MIN = 900
const SPARK = '✦'
/** `path:12` or `path:12-20`, as the helper model cites code. */
const LOCATION = /^([^\s:`]+?):(\d+)(?:[-–](\d+))?$/

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** What the diff of a card is read again for: a new head, or a new round. */
export const diffStamp = (item: Pick<ReviewItem, 'head' | 'round'>): string => `${item.head}|${item.round ?? 0}`

interface Hunk {
  /** Its header's index in the file's lines, and the index after its last line. */
  at: number
  end: number
  /** The lines it spans, new side (old side when it only deletes). */
  start?: number
  last?: number
}

interface FileModel {
  file: PullFile
  lines: DiffLine[]
  width: number
  hunks: Hunk[]
  /** `held`: folded until read; `reading`: being read; `bare`: a mode or name change with no lines. */
  state: 'shown' | 'held' | 'reading' | 'binary' | 'bare'
  error?: string
}

type Row =
  | { t: 'head'; f: number }
  | { t: 'gap'; f: number }
  | { t: 'note'; f: number }
  | { t: 'line'; f: number; i: number }
  | { t: 'pair'; f: number; l?: number; r?: number }

interface Selection {
  f: number
  a: number
  b: number
}

interface Mark {
  /** A finding's own severity; `mine` for a comment of mine, drawn below the findings. */
  severity: Finding['severity'] | 'mine'
  ids: string[]
  /** The finding's own line: its dot links to the sheet. */
  dot: boolean
}

interface Panel {
  target: ExplainTarget
  label: string
  id?: string
  error?: string
}

function hunksOf(lines: readonly DiffLine[]): Hunk[] {
  const hunks: Hunk[] = []
  lines.forEach((line, index) => {
    if (line.kind !== 'hunk') return
    const last = hunks.at(-1)
    if (last !== undefined) last.end = index
    hunks.push({ at: index, end: lines.length })
  })
  for (const hunk of hunks) Object.assign(hunk, spanOf(lines, hunk.at, hunk.end - 1))
  return hunks
}

/** The lines `lo..hi` cover: new side, or old side when they only delete. */
function spanOf(lines: readonly DiffLine[], lo: number, hi: number): { start?: number; last?: number } {
  let start: number | undefined
  let last: number | undefined
  for (const side of ['new', 'old'] as const) {
    for (let i = lo; i <= hi; i++) {
      const line = lines[i]!
      if (line.kind === 'hunk' || line.kind === 'note' || (side === 'new' && line.kind === 'del')) continue
      const at = line[side]
      if (at === undefined) continue
      start = Math.min(start ?? at, at)
      last = Math.max(last ?? at, at)
    }
    if (start !== undefined) break
  }
  return { ...(start === undefined ? {} : { start }), ...(last === undefined ? {} : { last }) }
}

/** Lines back as unified diff text; a cut that starts inside a hunk takes its header along. */
function unified(lines: readonly DiffLine[], lo: number, hi: number): string {
  const out: string[] = []
  if (lines[lo]?.kind !== 'hunk') {
    for (let i = lo - 1; i >= 0; i--) {
      if (lines[i]!.kind === 'hunk') {
        out.push(lines[i]!.text)
        break
      }
    }
  }
  for (let i = lo; i <= hi; i++) {
    const line = lines[i]!
    out.push(line.kind === 'hunk' ? line.text : line.kind === 'note' ? `\\ ${line.text}` : `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
  }
  return out.join('\n')
}

/** The new-side lines `lo..hi` cover, for a comment; undefined when they only delete. */
function newSpan(lines: readonly DiffLine[], lo: number, hi: number): { start: number; last: number } | undefined {
  let start: number | undefined
  let last: number | undefined
  for (let i = lo; i <= hi; i++) {
    const line = lines[i]!
    if (line.kind === 'hunk' || line.kind === 'note' || line.kind === 'del' || line.new === undefined) continue
    start = Math.min(start ?? line.new, line.new)
    last = Math.max(last ?? line.new, line.new)
  }
  return start === undefined || last === undefined ? undefined : { start, last }
}

/** Why the card takes no comment of mine now; undefined when it does. */
function commentBlock(item: ReviewItem): ReviewKey | undefined {
  if (item.phase === 'submitted') return 'compose.off.submitted'
  if (item.phase === 'invalid') return 'compose.off.invalid'
  if (item.phase === 'analyzing' || item.running === true || item.queued === true) return 'compose.off.analyzing'
  return undefined
}

const rangeLabel = (start: number | undefined, last: number | undefined): string =>
  start === undefined ? '' : last === undefined || last === start ? t('explain.line', { n: start }) : t('explain.lines', { start, end: last })

function modelOf(file: PullFile, reading: boolean, error: string | undefined): FileModel {
  if (file.binary) return { file, lines: [], width: 0, hunks: [], state: 'binary' }
  if (file.patch === undefined) return { file, lines: [], width: 0, hunks: [], state: reading ? 'reading' : 'held', ...(error === undefined ? {} : { error }) }
  const parsed = parseDiff(file.patch)
  if (parsed.lines.length === 0) return { file, lines: [], width: 0, hunks: [], state: 'bare' }
  return { file, lines: parsed.lines, width: parsed.width, hunks: hunksOf(parsed.lines), state: 'shown' }
}

function useExplained(store: ReviewStore, key: string): Explained | undefined {
  const subscribe = useCallback((listener: () => void) => store.watchExplained(key, listener), [store, key])
  return useSyncExternalStore(subscribe, () => store.explained(key))
}

function useWrap(): [boolean, (wrap: boolean) => void] {
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) === '1')
  return [wrap, (next) => {
    localStorage.setItem(WRAP_KEY, next ? '1' : '0')
    setWrap(next)
  }]
}

function useMode(): [Mode, (mode: Mode) => void] {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'inline'))
  return [mode, (next) => {
    localStorage.setItem(MODE_KEY, next)
    setMode(next)
  }]
}

export function DiffPane(props: {
  store: ReviewStore
  item: ReviewItem
  findings: readonly Finding[]
  reveal?: Reveal
  /** A finding's dot was clicked: show it in the sheet. */
  onFinding(id: string): void
}): ReactNode {
  const { store, item } = props
  useEffect(injectGitStyle, [])
  const stamp = diffStamp(item)
  const [loaded, setLoaded] = useState<{ stamp: string; diff?: PullDiff; error?: string }>(() => {
    const diff = store.diffNow(item.key, stamp)
    return { stamp, ...(diff === undefined ? {} : { diff }) }
  })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    if (loaded.stamp === stamp && loaded.diff !== undefined) return
    store.diff(item.key, stamp).then(
      (diff) => { if (live) setLoaded({ stamp, diff }) },
      (error: unknown) => { if (live) setLoaded((old) => ({ ...old, stamp, error: message(error) })) },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, item.key, stamp, attempt])

  const root = useRef<HTMLDivElement>(null)
  if (loaded.diff === undefined) {
    return (
      <div ref={root} className="gp-root rv-diff">
        {loaded.error === undefined
          ? (
            <div className="gp-skeleton-list gp-mono" role="status" aria-label={t('diff.loading')}>
              {Array.from({ length: 12 }, (_, i) => <div key={i} className="gp-skeleton-row" style={{ width: `${36 + ((i * 37) % 58)}%` }} />)}
            </div>
          )
          : (
            <div className="gp-state" role="alert">
              <p>{t('diff.failed', { message: loaded.error })}</p>
              <button type="button" className="ah-btn" onClick={() => { setLoaded({ stamp }); setAttempt(attempt + 1) }}>{t('retry')}</button>
            </div>
          )}
      </div>
    )
  }
  return <DiffView {...props} diff={loaded.diff} />
}

function DiffView(props: {
  store: ReviewStore
  item: ReviewItem
  diff: PullDiff
  findings: readonly Finding[]
  reveal?: Reveal
  onFinding(id: string): void
}): ReactNode {
  const { store, item, diff } = props
  const key = item.key
  const coarse = useCoarse()
  const rowHeight = coarse ? 24 : 20
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const width = useWidth(root)
  const [chosen, setMode] = useMode()
  const canSplit = width >= SPLIT_MIN
  const mode: Mode = canSplit ? chosen : 'inline'
  const [wrapLines, setWrapLines] = useWrap()
  const explained = useExplained(store, key)
  // The bots a comment of mine can be processed by, from the board's list.
  const review = useSyncExternalStore(store.subscribe, store.getSnapshot).state
  useEffect(() => { if (store.getSnapshot().state === undefined) void store.load() }, [store])
  /** A review of someone else's pull request takes comments of mine; `blocked` says why not now. */
  const commentable = item.own !== true
  const blocked = commentBlock(item)

  // Its review threads, read as the diff opens and again as the card changes (a new comment, a new head).
  const [threads, setThreads] = useState<readonly PullThread[]>(() => store.threadsNow(key) ?? NO_THREADS)
  const followed = item.follow === undefined ? '' : `${item.follow.comments}|${item.follow.mine.replied}|${item.follow.mine.resolved}`
  useEffect(() => {
    let live = true
    store.threads(key).then((list) => { if (live) setThreads(list) }, (error: unknown) => { if (live) setSaid(t('thread.failed', { message: message(error) })) })
    return () => { live = false }
  }, [store, key, item.updatedAt, item.pending, followed])
  /** Thread ids by file and line (the line each one ends on), and every thread of a file, in order. */
  const { talks, byFile } = useMemo(() => {
    const talks = new Map<string, Map<number, string[]>>()
    const byFile = new Map<string, PullThread[]>()
    const sorted = [...threads].sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))
    for (const thread of sorted) {
      byFile.set(thread.path, [...(byFile.get(thread.path) ?? []), thread])
      if (thread.line === undefined) continue
      let byLine = talks.get(thread.path)
      if (byLine === undefined) talks.set(thread.path, byLine = new Map())
      byLine.set(thread.line, [...(byLine.get(thread.line) ?? []), thread.id])
    }
    return { talks, byFile }
  }, [threads])
  /** The threads lit on a line: those ending on it, and those whose range covers it. */
  const talkSpan = useMemo(() => {
    const out = new Map<string, Set<number>>()
    for (const thread of threads) {
      if (thread.line === undefined || thread.resolved) continue
      let lines = out.get(thread.path)
      if (lines === undefined) out.set(thread.path, lines = new Set())
      for (let at = Math.max(1, thread.start ?? thread.line); at <= thread.line && at - (thread.start ?? thread.line) < 400; at++) lines.add(at)
    }
    return out
  }, [threads])

  // Held files read on demand, and files folded by hand.
  const [extra, setExtra] = useState<ReadonlyMap<string, PullFile | { error: string } | 'reading'>>(() => new Map())
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const models = useMemo(() => diff.files.map((file) => {
    const got = extra.get(file.path)
    if (got !== undefined && got !== 'reading' && !('error' in got)) return modelOf(got, false, undefined)
    return modelOf(file, got === 'reading', got !== undefined && got !== 'reading' && 'error' in got ? got.error : undefined)
  }), [diff, extra])

  const { rows, rowOf, fileRows } = useMemo(() => {
    const rows: Row[] = []
    const rowOf = new Map<string, number>()
    const fileRows: number[] = []
    models.forEach((model, f) => {
      if (f > 0) rows.push({ t: 'gap', f })
      fileRows.push(rows.length)
      rows.push({ t: 'head', f })
      if (folded.has(model.file.path)) return
      if (model.state !== 'shown') {
        rows.push({ t: 'note', f })
        return
      }
      if (mode === 'inline') {
        model.lines.forEach((_, i) => {
          rowOf.set(`${f}:${i}`, rows.length)
          rows.push({ t: 'line', f, i })
        })
        return
      }
      for (const pair of splitRows(model.lines)) {
        if (pair.full !== undefined) {
          rowOf.set(`${f}:${pair.full}`, rows.length)
          rows.push({ t: 'line', f, i: pair.full })
          continue
        }
        if (pair.left !== undefined) rowOf.set(`${f}:${pair.left}`, rows.length)
        if (pair.right !== undefined) rowOf.set(`${f}:${pair.right}`, rows.length)
        rows.push({ t: 'pair', f, ...(pair.left === undefined ? {} : { l: pair.left }), ...(pair.right === undefined ? {} : { r: pair.right }) })
      }
    })
    return { rows, rowOf, fileRows }
  }, [models, folded, mode])

  // Word-level highlights, worked out for the rows in view only.
  const spans = useMemo(() => new Map<string, Span[]>(), [models])
  const spansOf = (f: number, i: number): Span[] | undefined => {
    const lines = models[f]!.lines
    const line = lines[i]!
    if (line.pair === undefined || line.kind === 'ctx') return undefined
    let found = spans.get(`${f}:${i}`)
    if (found === undefined) {
      const other = lines[line.pair]!
      const [del, add] = line.kind === 'del' ? wordDiff(line.text, other.text) : wordDiff(other.text, line.text)
      spans.set(`${f}:${line.kind === 'del' ? i : line.pair}`, del)
      spans.set(`${f}:${line.kind === 'add' ? i : line.pair}`, add)
      found = spans.get(`${f}:${i}`)!
    }
    return found
  }

  // The sheet's findings, on the lines they name.
  const marks = useMemo(() => {
    const out = new Map<string, Map<number, Mark>>()
    for (const finding of props.findings) {
      if (finding.path === undefined || finding.line === undefined) continue
      let byLine = out.get(finding.path)
      if (byLine === undefined) out.set(finding.path, byLine = new Map())
      const from = Math.max(1, Math.min(finding.start ?? finding.line, finding.line))
      const own = isMine(finding) ? 'mine' : finding.severity
      for (let at = from; at <= finding.line && at - from < 400; at++) {
        const old = byLine.get(at)
        const severity = old?.severity === 'must' || own === 'must' ? 'must' : old?.severity === 'nice' || own === 'nice' ? 'nice' : 'mine'
        const dot = at === finding.line
        byLine.set(at, { severity, ids: dot ? [...(old?.ids ?? []), finding.id] : old?.ids ?? [], dot: dot || old?.dot === true })
      }
    }
    return out
  }, [props.findings])
  const findingCount = (path: string): number => props.findings.filter((finding) => finding.path === path && !isMine(finding)).length

  // Explanations by where they are anchored.
  const anchors = useMemo(() => new Map((explained?.items ?? []).map((entry) => [anchorOf(entry), entry])), [explained])

  // Measured for side by side (one scroll offset) and wrapped lines (columns per row).
  const wrap = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const wrapWidth = useWidth(wrap)
  const [charWidth, setCharWidth] = useState(0)
  useLayoutEffect(() => { if (probe.current !== null) setCharWidth(probe.current.offsetWidth / 100) }, [mode, wrapLines])
  const digits = Math.max(2, ...models.map((model) => String(model.lines.reduce((max, line) => Math.max(max, line.old ?? 0, line.new ?? 0), 0)).length))

  // Wrapped: each row's first screen line. Text columns are what is left beside the gutter (its 12px
  // marker strip and 8px padding per number), the +/− marker, 8px on the right and 10px for the scrollbar.
  const starts = useMemo(() => {
    if (!wrapLines || charWidth === 0 || wrapWidth === 0) return undefined
    const list = wrapWidth - 10
    const room = Math.max(20, Math.floor((list - 12 - 2 * (digits * charWidth + 8) - 14 - 8) / charWidth))
    const half = Math.max(10, Math.floor((list / 2 - 12 - (digits * charWidth + 8) - 8) / charWidth))
    const out = [0]
    for (const row of rows) {
      let height = 1
      if (row.t === 'line') {
        const line = models[row.f]!.lines[row.i]!
        if (line.kind !== 'hunk' && line.kind !== 'note') height = linesIn(line.text, room)
      } else if (row.t === 'pair') {
        const lines = models[row.f]!.lines
        height = Math.max(row.l === undefined ? 1 : linesIn(lines[row.l]!.text, half), row.r === undefined ? 1 : linesIn(lines[row.r]!.text, half))
      }
      out.push(out[out.length - 1]! + height)
    }
    return { out, room, half }
  }, [wrapLines, charWidth, wrapWidth, digits, rows, models])
  const rowAt = (y: number): number => (starts === undefined ? Math.floor(y / rowHeight) : rowAtLine(starts.out, y / rowHeight))

  // Where the list is: the row at its top, for the current file and J/K.
  const [top, setTop] = useState(0)
  useEffect(() => {
    const element = list.current
    if (element === null) return
    let frame = 0
    const onScroll = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTop(rowAt(element.scrollTop)))
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener('scroll', onScroll)
    }
  }, [rowHeight, mode, starts])
  const current = rows[Math.min(top + 1, rows.length - 1)]?.f ?? 0

  const [selection, setSelection] = useState<Selection | undefined>()
  const [flash, setFlash] = useState<number | undefined>()
  // A word on what just happened (a comment added, a pick that takes none), gone after a while.
  const [said, setSaid] = useState<string | undefined>()
  useEffect(() => {
    if (said === undefined) return
    const timer = setTimeout(() => setSaid(undefined), 4000)
    return () => clearTimeout(timer)
  }, [said])
  useEffect(() => {
    if (flash === undefined) return
    const timer = setTimeout(() => setFlash(undefined), 1400)
    return () => clearTimeout(timer)
  }, [flash])

  const scrollTo = (row: number, align: 'top' | 'third' = 'top'): void => {
    const element = list.current
    if (element === null) return
    element.scrollTop = Math.max(0, (starts?.out[row] ?? row) * rowHeight - (align === 'third' ? element.clientHeight / 3 : rowHeight))
  }

  // Read a held file; `then` runs once it is in (a reveal waiting for it).
  const pending = useRef<Reveal | undefined>(undefined)
  const load = (path: string): void => {
    setExtra((old) => new Map(old).set(path, 'reading'))
    store.file(key, path).then(
      (file) => setExtra((old) => new Map(old).set(path, file)),
      (error: unknown) => setExtra((old) => new Map(old).set(path, { error: message(error) })),
    )
  }
  const toggleFold = (path: string): void => setFolded((old) => {
    const next = new Set(old)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  // Go to a file and line (a finding's location in the sheet, a citation in an explanation).
  const reveal = (place: Reveal): void => {
    const f = models.findIndex((model) => model.file.path === place.path)
    if (f < 0) return
    const model = models[f]!
    if (folded.has(place.path)) {
      pending.current = place
      toggleFold(place.path)
      return
    }
    if (model.state === 'held') {
      pending.current = place
      load(place.path)
      return
    }
    if (model.state === 'reading') {
      pending.current = place
      return
    }
    if (place.line === undefined || model.state !== 'shown') {
      scrollTo(fileRows[f]!)
      setFlash(fileRows[f]!)
      return
    }
    const near = (line: number): number => {
      const exact = model.lines.findIndex((entry) => entry.kind !== 'del' && entry.new === line)
      if (exact >= 0) return exact
      const after = model.lines.findIndex((entry) => entry.kind !== 'del' && entry.new !== undefined && entry.new >= line)
      return after >= 0 ? after : model.lines.length - 1
    }
    const to = near(place.line)
    const from = place.start === undefined ? to : near(place.start)
    const row = rowOf.get(`${f}:${to}`)
    if (row === undefined) return
    setSelection({ f, a: Math.min(from, to), b: Math.max(from, to) })
    scrollTo(row, 'third')
    setFlash(row)
  }
  // A thread asked for opens once the threads are in; any other place is shown at once.
  const [asked, setAsked] = useState<string | undefined>()
  useEffect(() => {
    if (props.reveal === undefined) return
    if (props.reveal.thread !== undefined) setAsked(props.reveal.thread)
    else reveal(props.reveal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.nonce])
  // A reveal that waited for a file to unfold or be read goes on once it is there.
  useEffect(() => {
    const place = pending.current
    if (place === undefined) return
    const model = models.find((entry) => entry.file.path === place.path)
    if (model === undefined || model.state === 'reading' || folded.has(place.path)) return
    pending.current = undefined
    if (model.state !== 'held') reveal(place)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, folded, rows])

  // ── Explaining ──
  const [panel, setPanel] = useState<Panel | undefined>()
  const entry = panel?.id === undefined ? undefined : explained?.items.find((item) => item.id === panel.id)
  const explain = (target: ExplainTarget, label: string): void => {
    const known = anchors.get(anchorOf(target))
    const next: Panel = { target, label, ...(known === undefined ? {} : { id: known.id }) }
    setCompose(undefined)
    setTalk(undefined)
    setPanel(next)
    // An answered one is shown as it is; anything else (new, or failed) is asked for.
    if (known !== undefined && known.turns[0]?.error === undefined) return
    store.explain(key, target, uiLang()).then(
      (value) => setPanel((old) => (old?.target === target ? { ...old, id: value.id } : old)),
      (error: unknown) => setPanel((old) => (old?.target === target ? { ...old, error: message(error) } : old)),
    )
  }
  const hunkTarget = (f: number, hunk: Hunk): [ExplainTarget, string] => {
    const model = models[f]!
    return [{
      path: model.file.path, kind: 'hunk', diff: unified(model.lines, hunk.at, hunk.end - 1),
      ...(hunk.start === undefined ? {} : { start: hunk.start }), ...(hunk.last === undefined ? {} : { end: hunk.last }),
    }, `${model.file.path} · ${rangeLabel(hunk.start, hunk.last)}`]
  }
  const selectionTarget = (pick: Selection): [ExplainTarget, string] => {
    const model = models[pick.f]!
    const lo = Math.min(pick.a, pick.b)
    const hi = Math.max(pick.a, pick.b)
    const { start, last } = spanOf(model.lines, lo, hi)
    return [{
      path: model.file.path, kind: 'lines', diff: unified(model.lines, lo, hi),
      ...(start === undefined ? {} : { start }), ...(last === undefined ? {} : { end: last }),
    }, `${model.file.path} · ${rangeLabel(start, last)}`]
  }
  const fileTarget = (f: number): [ExplainTarget, string] => {
    const model = models[f]!
    return [{ path: model.file.path, kind: 'file', diff: model.file.patch ?? '' }, `${model.file.path} · ${t('explain.whole')}`]
  }
  const explainSelection = (): void => {
    if (selection !== undefined) explain(...selectionTarget(selection))
  }
  const ask = async (question: string): Promise<string | undefined> => {
    if (panel?.id === undefined) return 'no explanation'
    try {
      await store.followUp(key, panel.id, question, uiLang())
      return undefined
    } catch (error) {
      return message(error)
    }
  }
  const retry = (): void => {
    if (panel === undefined) return
    setPanel({ target: panel.target, label: panel.label })
    store.explain(key, panel.target, uiLang()).then(
      (value) => setPanel((old) => (old?.target === panel.target ? { ...old, id: value.id } : old)),
      (error: unknown) => setPanel((old) => (old?.target === panel.target ? { ...old, error: message(error) } : old)),
    )
  }
  const locate = (path: string, line: number | undefined, start?: number): void => {
    const file = models.find((model) => model.file.path === path) ?? models.find((model) => model.file.path.endsWith(`/${path}`))
    if (file !== undefined) reveal({ path: file.file.path, ...(line === undefined ? {} : { line }), ...(start === undefined ? {} : { start }), nonce: Date.now() })
  }

  // ── A comment of mine ──
  const [compose, setCompose] = useState<CommentTarget | undefined>()

  // ── A thread of my own pull request, answered ──
  const [talk, setTalk] = useState<{ ids: readonly string[]; at: number } | undefined>()
  const talkThread = talk === undefined ? undefined : threads.find((thread) => thread.id === talk.ids[talk.at])
  const openTalk = (ids: readonly string[], at = 0): void => {
    if (ids.length === 0) return
    setPanel(undefined)
    setCompose(undefined)
    setTalk({ ids, at })
    const thread = threads.find((entry) => entry.id === ids[at])
    if (thread?.line !== undefined) locate(thread.path, thread.line, thread.start)
  }
  const closeTalk = (): void => {
    setTalk(undefined)
    root.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (asked === undefined || !threads.some((thread) => thread.id === asked)) return
    setAsked(undefined)
    openTalk([asked])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, threads])
  /** Where a thread is, as the reply field's place: its lines and their diff when the diff still has them. */
  const talkTarget = (thread: PullThread): CommentTarget => {
    const f = models.findIndex((model) => model.file.path === thread.path)
    const lines = f < 0 ? [] : models[f]!.lines
    const end = thread.line === undefined ? -1 : lines.findIndex((line) => line.kind !== 'del' && line.new === thread.line)
    const begin = end < 0 ? -1 : lines.findIndex((line) => line.kind !== 'del' && line.new === (thread.start ?? thread.line))
    const where = thread.line === undefined ? t('thread.outdated') : rangeLabel(thread.start ?? thread.line, thread.line)
    return {
      path: thread.path, line: thread.line ?? 0, ...(thread.start === undefined ? {} : { start: thread.start }),
      diff: end < 0 ? '' : unified(lines, Math.max(0, begin < 0 ? end : begin), end), label: `${thread.path} · ${where}`,
    }
  }
  /** The lines picked as a comment's place, or why they take none: new side only, within one hunk (as GitHub wants). */
  const commentOf = (pick: Selection): CommentTarget | ReviewKey => {
    const model = models[pick.f]!
    const lo = Math.min(pick.a, pick.b)
    const hi = Math.max(pick.a, pick.b)
    const span = newSpan(model.lines, lo, hi)
    if (span === undefined) return 'compose.newSide'
    const hunkOf = (i: number): Hunk | undefined => model.hunks.find((hunk) => i > hunk.at && i < hunk.end)
    if (hunkOf(lo) !== hunkOf(hi)) return 'compose.oneHunk'
    return {
      path: model.file.path, line: span.last, ...(span.start === span.last ? {} : { start: span.start }),
      diff: unified(model.lines, lo, hi), label: `${model.file.path} · ${rangeLabel(span.start, span.last)}`,
    }
  }
  const comment = (pick: Selection | undefined = selection): void => {
    if (pick === undefined || !commentable) return
    if (blocked !== undefined) {
      setSaid(t(blocked))
      return
    }
    const target = commentOf(pick)
    if (typeof target === 'string') {
      setSaid(t(target))
      return
    }
    setPanel(undefined)
    setTalk(undefined)
    setCompose(target)
  }
  /** A line's +: the lines picked when it is one of them, else that line alone. */
  const plus = (f: number, i: number): void => {
    if (selection !== undefined && picked(f, i)) return comment(selection)
    const pick = { f, a: i, b: i }
    setSelection(pick)
    comment(pick)
  }
  const closeCompose = (): void => {
    setCompose(undefined)
    root.current?.focus({ preventScroll: true })
  }

  // ── Hunks and files, by keyboard ──
  const hunkRows = useMemo(() => {
    const out: Array<{ row: number; f: number; hunk: Hunk }> = []
    models.forEach((model, f) => {
      for (const hunk of model.hunks) {
        const row = rowOf.get(`${f}:${hunk.at}`)
        if (row !== undefined) out.push({ row, f, hunk })
      }
    })
    return out
  }, [models, rowOf])
  const goHunk = (step: 1 | -1): void => {
    const here = top + 1
    const next = step > 0 ? hunkRows.find((entry) => entry.row > here) : [...hunkRows].reverse().find((entry) => entry.row < here)
    if (next !== undefined) scrollTo(next.row)
  }
  const goFile = (f: number): void => {
    const row = fileRows[Math.max(0, Math.min(models.length - 1, f))]
    if (row !== undefined) scrollTo(row + 1)
  }
  const currentHunk = (): { f: number; hunk: Hunk } | undefined => {
    const here = top + 2
    return [...hunkRows].reverse().find((entry) => entry.row <= here) ?? hunkRows[0]
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    // By key position: Option+Z on a Mac types Ω.
    if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyZ') {
      setWrapLines(!wrapLines)
      event.preventDefault()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key
    if (key === 'j' || key === 'J') goHunk(1)
    else if (key === 'k' || key === 'K') goHunk(-1)
    else if (key === ']') goFile(current + 1)
    else if (key === '[') goFile(current - 1)
    else if (key === 'e' || key === 'E') {
      if (selection !== undefined) explainSelection()
      else {
        const hunk = currentHunk()
        if (hunk !== undefined) explain(...hunkTarget(hunk.f, hunk.hunk))
      }
    } else if ((key === 'c' || key === 'C') && selection !== undefined && commentable) comment(selection)
    else if (key === 'Escape' && compose !== undefined) closeCompose()
    else if (key === 'Escape' && talk !== undefined) closeTalk()
    else if (key === 'Escape' && panel !== undefined) setPanel(undefined)
    else if (key === 'Escape' && selection !== undefined) setSelection(undefined)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  // A press on a line number dragged down others picks them all; its click then picks nothing more.
  const drag = useRef<{ f: number; i: number; moved: boolean } | undefined>(undefined)
  useEffect(() => {
    // The click follows the release: the drag is forgotten once it has been heard.
    const up = (): void => { setTimeout(() => { drag.current = undefined }, 0) }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])
  const press = (f: number, i: number, event: ReactMouseEvent): void => {
    if (event.button !== 0 || event.shiftKey) return
    drag.current = { f, i, moved: false }
  }
  const sweep = (f: number, i: number, event: ReactMouseEvent): void => {
    const from = drag.current
    if (from === undefined || from.f !== f || (event.buttons & 1) === 0 || (from.i === i && !from.moved)) return
    const line = models[f]!.lines[i]
    if (line === undefined || line.kind === 'hunk' || line.kind === 'note') return
    from.moved = true
    setSelection({ f, a: from.i, b: i })
  }

  // A click on a line number picks the line; Shift, or a second line while one is picked, extends to it.
  const pick = (f: number, i: number, extend: boolean): void => {
    if (drag.current?.moved === true) return
    const line = models[f]!.lines[i]
    if (line === undefined || line.kind === 'hunk' || line.kind === 'note') return
    setSelection((old) => {
      if (old !== undefined && old.f === f && (extend || old.a === old.b) && !(old.a === i && old.b === i)) return { f, a: old.a, b: i }
      if (old !== undefined && old.f === f && old.a === i && old.b === i) return undefined
      return { f, a: i, b: i }
    })
  }
  const picked = (f: number, i: number | undefined): boolean =>
    selection !== undefined && i !== undefined && selection.f === f && i >= Math.min(selection.a, selection.b) && i <= Math.max(selection.a, selection.b)

  // ── Rendering ──
  const widest = Math.max(0, ...models.map((model) => model.width))
  const totals = diff.files.reduce((sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }), { added: 0, deleted: 0 })
  const numberStyle: CSSProperties = { width: `${digits}ch` }

  const gutter = (f: number, i: number, sides: 'both' | 'old' | 'new'): ReactNode => {
    const model = models[f]!
    const line = model.lines[i]!
    const mark = line.kind === 'del' || line.new === undefined || sides === 'old' ? undefined : marks.get(model.file.path)?.get(line.new)
    const here = line.kind === 'del' || line.new === undefined || sides === 'old' ? undefined : talks.get(model.file.path)?.get(line.new)
    const lit = here?.map((id) => threads.find((thread) => thread.id === id)).filter((thread): thread is PullThread => thread !== undefined) ?? []
    const addable = commentable && blocked === undefined && sides !== 'old' && line.kind !== 'del' && line.new !== undefined && mark?.dot !== true
    return (
      <span className="rv-gut" onClick={(event) => pick(f, i, event.shiftKey)} onMouseDown={(event) => press(f, i, event)} onMouseEnter={(event) => sweep(f, i, event)}>
        <span className="rv-fm">
          {addable && (
            <button type="button" className="rv-add" tabIndex={-1} aria-label={t('diff.addComment')} title={t('diff.addComment')}
              onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); plus(f, i) }}>+</button>
          )}
          {lit.length > 0 && (
            <button type="button" className="rv-tdot" tabIndex={-1}
              data-state={lit.some((thread) => thread.waiting) ? 'waiting' : lit.every((thread) => thread.resolved) ? 'resolved' : undefined}
              title={t('thread.mark', { n: lit.reduce((sum, thread) => sum + thread.comments.length, 0) })}
              aria-label={t('thread.mark', { n: lit.reduce((sum, thread) => sum + thread.comments.length, 0) })}
              onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openTalk(here!) }} />
          )}
          {mark?.dot === true && lit.length === 0 && (
            <button type="button" className="rv-fdot" data-severity={mark.severity} title={t('diff.finding', { id: mark.ids.join(', ') })}
              aria-label={t('diff.finding', { id: mark.ids.join(', ') })}
              onClick={(event) => { event.stopPropagation(); props.onFinding(mark.ids[0]!) }} />
          )}
        </span>
        {sides !== 'new' && <span className="rv-ln" style={numberStyle}>{line.old}</span>}
        {sides !== 'old' && <span className="rv-ln" style={numberStyle}>{line.new}</span>}
      </span>
    )
  }
  const markOf = (f: number, i: number | undefined): string | undefined => {
    if (i === undefined) return undefined
    const model = models[f]!
    const line = model.lines[i]!
    if (line.kind === 'del' || line.new === undefined) return undefined
    return marks.get(model.file.path)?.get(line.new)?.severity ?? (talkSpan.get(model.file.path)?.has(line.new) === true ? 'thread' : undefined)
  }

  const hunkRow = (f: number, i: number, style: CSSProperties, index: number): ReactNode => {
    const model = models[f]!
    const hunk = model.hunks.find((entry) => entry.at === i)
    const done = hunk === undefined ? undefined : anchors.get(anchorOf({
      path: model.file.path, kind: 'hunk', ...(hunk.start === undefined ? {} : { start: hunk.start }), ...(hunk.last === undefined ? {} : { end: hunk.last }),
    }))
    return (
      <div key={index} style={style} className="gp-dl rv-dl" data-k="hunk" data-flash={flash === index ? '' : undefined}>
        <span className="gp-dt">{model.lines[i]!.text}</span>
        {hunk !== undefined && (
          <button type="button" className="rv-hx" data-done={done !== undefined && done.turns[0]?.error === undefined ? '' : undefined} title={t('explainHint')}
            onClick={() => explain(...hunkTarget(f, hunk))}>
            {SPARK} {done !== undefined && done.turns[0]?.error === undefined ? t('explained') : t('explain')}
          </button>
        )}
      </div>
    )
  }

  const render = (index: number, style: CSSProperties): ReactNode => {
    const row = rows[index]!
    const model = models[row.f]!
    const file = model.file
    if (row.t === 'gap') return <div key={index} style={style} className="rv-gap" aria-hidden="true" />
    if (row.t === 'head') {
      const open = !folded.has(file.path)
      const count = findingCount(file.path)
      const done = anchors.get(anchorOf({ path: file.path, kind: 'file' }))
      const slash = file.path.lastIndexOf('/')
      return (
        <div key={index} style={style} className="rv-fh" data-flash={flash === index ? '' : undefined}>
          <div className="rv-fh-main">
            <button type="button" className="rv-fh-fold" aria-expanded={open} aria-label={open ? t('diff.fold') : t('diff.unfold')} title={open ? t('diff.fold') : t('diff.unfold')}
              onClick={() => toggleFold(file.path)}>
              <span className="rv-chev" data-open={open ? '' : undefined}><IconChevron size={12} /></span>
            </button>
            <CodeMark code={file.code} />
            <span className="rv-fh-path" title={file.from === undefined ? file.path : `${file.from} → ${file.path}`}>
              {slash >= 0 && <span className="rv-fh-dir">{file.path.slice(0, slash + 1)}</span>}
              <span className="rv-fh-name">{file.path.slice(slash + 1)}</span>
            </span>
            {!file.binary && <span className="gp-stat gp-stat-sm"><span data-k="add">+{file.added}</span><span data-k="del">−{file.deleted}</span></span>}
            {count > 0 && <span className="rv-fh-count">{t('diff.findings', { n: count })}</span>}
            {(byFile.get(file.path)?.length ?? 0) > 0 && (() => {
              const list = byFile.get(file.path)!
              const open = list.filter((thread) => !thread.resolved)
              const shown = open.length > 0 ? open : list
              return (
                <button type="button" className="rv-fh-talk" data-waiting={list.some((thread) => thread.waiting) ? '' : undefined} title={t('thread.countHint')}
                  onClick={() => openTalk(shown.map((thread) => thread.id))}>
                  {t('thread.count', { n: shown.length })}
                </button>
              )
            })()}
          </div>
          {model.state === 'shown' && (
            <button type="button" className="rv-hx" data-done={done !== undefined && done.turns[0]?.error === undefined ? '' : undefined} title={t('explainHint')}
              onClick={() => explain(...fileTarget(row.f))}>{SPARK} {t('explainFile')}</button>
          )}
        </div>
      )
    }
    if (row.t === 'note') {
      let text: string
      let action: ReactNode = null
      if (model.state === 'binary') text = t('diff.binary')
      else if (model.state === 'bare') text = t('diff.noChange')
      else if (model.state === 'reading') text = t('diff.reading')
      else {
        text = model.error ?? (file.held === 'generated' ? t('diff.held.generated') : t('diff.held.large', { n: file.added + file.deleted }))
        action = <button type="button" className="rv-link" onClick={() => load(file.path)}>{model.error === undefined ? t('diff.load') : t('retry')}</button>
      }
      return <div key={index} style={style} className="rv-note"><span>{text}</span>{action}</div>
    }
    if (row.t === 'line') {
      const line = model.lines[row.i]!
      if (line.kind === 'hunk') return hunkRow(row.f, row.i, style, index)
      if (line.kind === 'note') return <div key={index} style={style} className="gp-dl" data-k="note"><span className="gp-dt">{line.text}</span></div>
      return (
        <div key={index} style={style} className="gp-dl rv-dl" data-k={line.kind} data-mark={markOf(row.f, row.i)}
          data-sel={picked(row.f, row.i) ? '' : undefined} data-flash={flash === index ? '' : undefined}>
          {gutter(row.f, row.i, 'both')}
          <span className="gp-dm">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
          <span className="gp-dt" style={starts === undefined ? undefined : { width: `${starts.room}ch` }}>{withSpans(line.text, spansOf(row.f, row.i))}</span>
        </div>
      )
    }
    const half = (i: number | undefined, side: 'old' | 'new'): ReactNode => {
      if (i === undefined) return <div className="gp-dl gp-half" data-k="none" />
      const line = model.lines[i]!
      return (
        <div className="gp-dl gp-half rv-dl" data-k={line.kind} data-mark={side === 'new' ? markOf(row.f, i) : undefined} data-sel={picked(row.f, i) ? '' : undefined}>
          {gutter(row.f, i, side)}
          <span className="gp-dt" style={starts === undefined ? undefined : { width: `${starts.half}ch` }}>{withSpans(line.text, spansOf(row.f, i))}</span>
        </div>
      )
    }
    return (
      <div key={index} style={style} className="gp-split-row" data-flash={flash === index ? '' : undefined}>
        {half(row.l, 'old')}{half(row.r, 'new')}
      </div>
    )
  }

  // Side by side: one horizontal offset for both halves, the line numbers staying put (as in the git pane).
  const bar = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const room = wrapWidth / 2 - (digits + 2) * charWidth - 24
  const overflow = mode !== 'split' || wrapLines || charWidth === 0 || wrapWidth === 0 ? 0 : Math.max(0, Math.ceil(widest * charWidth + 16 - room))
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

  const [menu, setMenu] = useState<MenuAnchor | undefined>()
  const currentFile = models[current]?.file
  const selectionLabel = selection === undefined ? undefined : (() => {
    const { start, last } = spanOf(models[selection.f]!.lines, Math.min(selection.a, selection.b), Math.max(selection.a, selection.b))
    return start === undefined ? '' : last === undefined || last === start ? `L${start}` : `L${start}–${last}`
  })()
  const stale = item.phase === 'stale' && diff.head.slice(0, 7) !== item.head.slice(0, 7)

  return (
    <div ref={root} className="gp-root rv-diff" tabIndex={-1} onKeyDown={onKeyDown} style={{ '--rv-vw': `${width}px` } as CSSProperties}>
      <div className="rv-diff-bar">
        <button type="button" className="rv-file-pick" aria-haspopup="menu" aria-expanded={menu !== undefined} title={t('diff.pick')}
          onClick={(event) => setMenu({ x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect() })}>
          {currentFile !== undefined && <CodeMark code={currentFile.code} />}
          <span className="rv-file-pick-name">{currentFile?.path.split('/').pop() ?? ''}</span>
          <IconChevronDown size={12} />
        </button>
        <button type="button" className="ah-icon-btn" disabled={current <= 0} aria-label={t('diff.prevFile')} title={t('diff.prevFile')} onClick={() => goFile(current - 1)}><IconUp size={14} /></button>
        <button type="button" className="ah-icon-btn" disabled={current >= models.length - 1} aria-label={t('diff.nextFile')} title={t('diff.nextFile')} onClick={() => goFile(current + 1)}><IconDown size={14} /></button>
        <span className="rv-diff-sum" title={t('diff.keys')}>
          {t('diff.files', { n: diff.files.length })}
          <span className="gp-stat gp-stat-sm"><span data-k="add">+{totals.added}</span><span data-k="del">−{totals.deleted}</span></span>
        </span>
        <span className="gp-grow" />
        {selection !== undefined && (
          <span className="rv-pick">
            {commentable && (() => {
              const target = commentOf(selection)
              const problem = blocked ?? (typeof target === 'string' ? target : undefined)
              return (
                <button type="button" className="rv-pick-go rv-pick-alt" aria-disabled={problem !== undefined} aria-label={t('compose')}
                  title={problem === undefined ? t('composeHint') : t(problem)} onClick={() => comment()}>+<span className="rv-pick-label"> {t('compose')}</span></button>
              )
            })()}
            <button type="button" className="rv-pick-go" title={t('explainHint')} onClick={explainSelection}>{SPARK} {t('explainLines', { range: selectionLabel ?? '' })}</button>
            <button type="button" className="ah-icon-btn" aria-label={t('clearSelection')} title={`${t('clearSelection')} (Esc)`} onClick={() => setSelection(undefined)}><IconClose size={12} /></button>
          </span>
        )}
        <button type="button" className="ah-icon-btn" aria-pressed={wrapLines} aria-label={t('diff.wrap')} title={`${t('diff.wrap')} (Alt+Z)`}
          onClick={() => setWrapLines(!wrapLines)}><IconWrap size={15} /></button>
        {canSplit && (
          <button type="button" className="ah-icon-btn" aria-label={mode === 'split' ? t('diff.inline') : t('diff.split')} title={mode === 'split' ? t('diff.inline') : t('diff.split')}
            onClick={() => setMode(mode === 'split' ? 'inline' : 'split')}>
            {mode === 'split' ? <IconInline size={15} /> : <IconSplit size={15} />}
          </button>
        )}
      </div>
      {said !== undefined && <p className="rv-diff-note rv-said" role="status">{said}</p>}
      {stale && <p className="rv-diff-note">{t('diff.stale', { head: diff.head.slice(0, 7) })}</p>}
      {models.some((model) => model.file.truncated === true) && <p className="rv-diff-note">{t('diff.truncated')}</p>}
      {rows.length === 0
        ? <div className="gp-state"><p>{t('diff.empty')}</p></div>
        : (
          <div ref={wrap} className="rv-diff-list" data-mode={mode} style={{ '--gp-sx': `${Math.min(offset, overflow)}px` } as CSSProperties}>
            {(mode === 'split' || wrapLines) && <span ref={probe} className="gp-mono gp-probe" aria-hidden="true">{'0'.repeat(100)}</span>}
            <VirtualList listRef={list} className={wrapLines ? 'gp-diff gp-mono gp-wrap' : 'gp-diff gp-mono'} count={rows.length} rowHeight={rowHeight} render={render} overscan={12}
              {...(starts === undefined ? {} : { starts: starts.out })}
              {...(mode === 'inline' && !wrapLines ? { innerWidth: `calc(${widest}ch + ${digits * 2}ch + 64px)` } : {})} label={t('view.diff')} />
            {overflow > 0 && (
              <div ref={bar} className="gp-hbar" onScroll={(event) => setOffset(event.currentTarget.scrollLeft)}>
                <div style={{ width: `calc(100% + ${overflow}px)` }} />
              </div>
            )}
          </div>
        )}
      {panel !== undefined && (
        <ExplainPanel key={panel.id ?? panel.label} panel={panel} entry={entry} onClose={() => setPanel(undefined)} onRetry={retry} onAsk={ask}
          onReveal={() => locate(panel.target.path, panel.target.end ?? panel.target.start, panel.target.start)} onLocate={locate} />
      )}
      {compose !== undefined && (
        <Composer key={`${compose.path}:${compose.start ?? compose.line}-${compose.line}`} store={store} pr={key} sheet={item.path} target={compose}
          bots={review?.bots ?? []} defaultBot={review?.commentBot ?? ''} onClose={closeCompose}
          onReveal={() => locate(compose.path, compose.line, compose.start)}
          onAdded={() => {
            closeCompose()
            setSelection(undefined)
            setSaid(t('compose.added'))
          }} />
      )}
      {talk !== undefined && talkThread !== undefined && (() => {
        const target = talkTarget(talkThread)
        return (
          <Composer key={`thread:${talkThread.id}`} store={store} pr={key} sheet={item.path} target={target}
            bots={review?.bots ?? []} defaultBot={review?.commentBot ?? ''} onClose={closeTalk}
            reply={{ thread: talkThread, at: talk.at, total: talk.ids.length, go: (step) => openTalk(talk.ids, Math.max(0, Math.min(talk.ids.length - 1, talk.at + step))) }}
            onReveal={() => locate(talkThread.path, talkThread.line, talkThread.start)}
            onAdded={() => {
              setThreads(store.threadsNow(key) ?? threads)
              setSaid(t('thread.replied'))
            }} />
        )
      })()}
      {menu !== undefined && (
        <Menu anchor={menu} label={t('diff.pick')} className="rv-file-menu" onClose={() => setMenu(undefined)}
          entries={models.map((model, f) => ({
            id: String(f), label: model.file.path, checked: f === current,
            hint: model.file.binary ? t('diff.binary') : `+${model.file.added} −${model.file.deleted}`,
          }))}
          onSelect={(id) => {
            setMenu(undefined)
            const f = Number(id)
            if (folded.has(models[f]!.file.path)) toggleFold(models[f]!.file.path)
            goFile(f)
            root.current?.focus({ preventScroll: true })
          }} />
      )}
    </div>
  )
}

/** The explanation under the diff: its answer as it streams, the follow-ups, and a field to ask one. */
function ExplainPanel(props: {
  panel: Panel
  entry: Explanation | undefined
  onClose(): void
  onRetry(): void
  onAsk(question: string): Promise<string | undefined>
  onReveal(): void
  onLocate(path: string, line: number | undefined, start?: number): void
}): ReactNode {
  const { panel, entry } = props
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const body = useRef<HTMLDivElement>(null)
  // Follow the answer down as it streams, unless the reader scrolled up.
  const stick = useRef(true)
  const turns = entry?.turns ?? []
  const answering = turns.some((turn) => !turn.done)
  const size = turns.reduce((sum, turn) => sum + turn.answer.length + (turn.question?.length ?? 0), 0)
  useLayoutEffect(() => {
    const element = body.current
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight
  }, [size, turns.length])
  // Citations of code the diff shows are links into it.
  useEffect(() => {
    for (const code of body.current?.querySelectorAll('code') ?? []) {
      if (code.closest('pre') === null && LOCATION.test(code.textContent?.trim() ?? '')) code.dataset.loc = ''
    }
  })
  const send = async (): Promise<void> => {
    const text = question.trim()
    if (text === '' || asking || answering) return
    setAsking(true)
    setNotice(undefined)
    stick.current = true
    const failure = await props.onAsk(text)
    setAsking(false)
    if (failure === undefined) setQuestion('')
    else setNotice(failure)
  }
  const first = turns[0]
  const failed = panel.error ?? first?.error
  return (
    <section className="rv-explain" aria-label={t('explain.title')}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose() } }}>
      <header className="rv-explain-head">
        <span className="rv-explain-spark" aria-hidden="true">{SPARK}</span>
        <button type="button" className="rv-explain-where" title={t('explain.reveal')} onClick={props.onReveal}>{panel.label}</button>
        {answering && <span className="rv-spin" role="status" aria-label={t('explain.answering')} />}
        <span className="gp-grow" />
        <button type="button" className="ah-icon-btn" aria-label={t('close')} title={`${t('close')} (Esc)`} onClick={props.onClose}><IconClose size={13} /></button>
      </header>
      <div ref={body} className="rv-explain-body" aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
        onClick={(event) => {
          const code = (event.target as Element).closest('code[data-loc]')
          const match = code === null ? null : LOCATION.exec(code.textContent?.trim() ?? '')
          if (match !== null) props.onLocate(match[1]!, Number(match[3] ?? match[2]), match[3] === undefined ? undefined : Number(match[2]))
        }}>
        {failed !== undefined
          ? (
            <p className="rv-banner" role="alert">
              {t('explain.failed', { message: failed })}
              <button type="button" className="rv-link" onClick={props.onRetry}>{t('retry')}</button>
            </p>
          )
          : first === undefined || (first.answer === '' && !first.done)
            ? (
              <div className="rv-explain-wait" role="status">
                <span>{t('explain.waiting')}</span>
                <div className="gp-skeleton-row" style={{ width: '82%' }} /><div className="gp-skeleton-row" style={{ width: '64%' }} /><div className="gp-skeleton-row" style={{ width: '74%' }} />
              </div>
            )
            : turns.map((turn, index) => (
              <div key={index} className="rv-turn">
                {turn.question !== undefined && <p className="rv-turn-q">{turn.question}</p>}
                {turn.error !== undefined
                  ? <p className="rv-banner" role="alert">{t('explain.failed', { message: turn.error })}</p>
                  : turn.answer === '' && !turn.done
                    ? <p className="rv-muted">{t('explain.answering')}</p>
                    : <Markdown className="rv-turn-a" text={turn.answer} />}
                {!turn.done && turn.answer !== '' && <span className="rv-caret" aria-hidden="true" />}
              </div>
            ))}
      </div>
      <form className="rv-explain-ask" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <input className="rv-input" value={question} placeholder={t('explain.followPlaceholder')} aria-label={t('explain.followUp')}
          disabled={entry === undefined || failed !== undefined}
          onChange={(event) => { setQuestion(event.target.value); setNotice(undefined) }} />
        <button type="submit" className="ah-btn" disabled={question.trim() === '' || asking || answering || entry === undefined}>
          {asking || answering ? t('explain.answering') : t('explain.followUp')}
        </button>
        {notice !== undefined && <span className="rv-warn" role="alert">{notice}</span>}
      </form>
    </section>
  )
}

export type View = 'sheet' | 'diff'
const VIEW_KEY = 'dsh-agent-hub.review.view'

/** Sheet or changes, remembered: a reviewer who reads the diff first keeps finding it first. */
export function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'diff' ? 'diff' : 'sheet'))
  return [view, (next) => {
    localStorage.setItem(VIEW_KEY, next)
    setView(next)
  }]
}

/** The sheet's findings, for the diff's marks; nothing is watched before the sheet exists. */
export function useFindings(store: ReviewStore, path: string | undefined): readonly Finding[] {
  const subscribe = useCallback((listener: () => void) => (path === undefined ? () => {} : store.watch(path, listener)), [store, path])
  return useSyncExternalStore(subscribe, () => (path === undefined ? undefined : store.sheet(path)))?.sheet?.findings ?? NO_FINDINGS
}
const NO_FINDINGS: readonly Finding[] = []
const NO_THREADS: readonly PullThread[] = []

export function ViewSwitch(props: { view: View; files?: number; onChange(view: View): void }): ReactNode {
  const option = (view: View, label: ReactNode): ReactNode => (
    <button type="button" role="tab" aria-selected={props.view === view} onClick={() => props.onChange(view)}>{label}</button>
  )
  return (
    <div className="ah-seg rv-switch" role="tablist" aria-label={t('view.label')}>
      {option('sheet', t('view.sheet'))}
      {option('diff', <>{t('view.diff')}{props.files !== undefined && <span className="rv-switch-n">{props.files}</span>}</>)}
    </div>
  )
}

/** Bring a finding of the sheet into view inside `scope`, and flash it. */
export function showFinding(scope: HTMLElement | null, id: string): void {
  // After the sheet is on screen again.
  setTimeout(() => {
    const element = scope?.querySelector<HTMLElement>(`[data-finding="${CSS.escape(id)}"]`)
    if (element === null || element === undefined) return
    element.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    element.dataset.flash = ''
    setTimeout(() => { delete element.dataset.flash }, 1400)
  }, 40)
}
