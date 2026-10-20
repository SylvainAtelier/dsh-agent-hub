/**
 * The terminal panel at the bottom of the git pane, laid out like VS Code's:
 * a tab per terminal (double-click renames, × ends the process, drag
 * reorders), + opens another, ⌄ picks the shell; right-click offers selection actions.
 * A tab splits side by side into up to four panes (⌘\ or Ctrl+Shift+5; ⌥⌘/Ctrl+Alt+←→
 * moves between them; the sash between two resizes, double-click evens them out); too
 * narrow for that, the panes stack instead. Each pane is a real PTY from
 * DSH's terminal service (see terminal-host.ts), so prompts, colors,
 * completion, full-screen programs and Ctrl+C behave as in the sidebar
 * terminal, and processes keep running while the panel is hidden or the page
 * reloads.
 *
 * Kept cheap: xterm loads as a separate chunk on first open; only the selected
 * tab's panes, while the git pane is visible, hold an output stream (the others stay
 * detached on the host and come back as a screen snapshot); output bypasses
 * React; tabs re-render only when a title or status changes.
 */

import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useDrawerHeight } from './Console.tsx'
import { t, type GitKey } from './i18n.ts'
import { IconChevronDown, IconClose, IconOpen, IconPlus, IconSplit, IconTerminal } from './icons.tsx'
import { Menu, type MenuAnchor, type MenuEntry } from './kit.tsx'
import { insertIntoSession, textBlock } from '../editor/shared.ts'
import { selectionMenu, type SelectionPick } from './selection.ts'
import type { ScreenProps } from './screen.tsx'
import type { RepoStore } from './store.ts'
import { injectGitStyle } from './style.ts'
import { groupsOf, MAX_PANES, type GitTerminals, type Shell, type TerminalEntry, type TerminalGroup, type TerminalMark, type TerminalState, type TerminalView } from './terminal-host.ts'

/** The host module loader's package-local chunk import (see scripts/build.mjs). */
declare const require: { async?: (spec: string) => Promise<unknown> }

let chunk: Promise<{ default: ComponentType<ScreenProps> }> | undefined

/** The xterm chunk, fetched and evaluated once; shared by the idle preload and the panel. */
function loadScreen(): Promise<{ default: ComponentType<ScreenProps> }> {
  chunk ??= (async () => {
    try {
      if (typeof require.async !== 'function') throw new Error('chunk loading unavailable')
      const loaded = await require.async('./client.terminal.js') as { TerminalScreen: ComponentType<ScreenProps> }
      return { default: loaded.TerminalScreen }
    } catch (error) {
      chunk = undefined
      const message = error instanceof Error ? error.message : String(error)
      return { default: () => <p className="gt-error" role="alert">{t('termFailed', { message })}</p> }
    }
  })()
  return chunk
}

/**
 * Fetch and evaluate xterm while the browser is idle, so opening the panel later does not
 * pay for a few hundred kilobytes of script in the click. Returns a cancel.
 */
export function preloadScreen(): () => void {
  if (chunk !== undefined) return () => {}
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback
  if (typeof idle === 'function') {
    const handle = idle(() => void loadScreen(), { timeout: 4000 })
    return () => (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback?.(handle)
  }
  const timer = setTimeout(() => void loadScreen(), 1500)
  return () => clearTimeout(timer)
}

const Screen = lazy(loadScreen)

/**
 * True one frame after the first paint: the drawer, its tabs and status show at once,
 * and xterm (which measures fonts and builds its DOM synchronously) is built in the
 * frame after, instead of inside the click that opened the panel.
 */
function usePainted(): boolean {
  const [painted, setPainted] = useState(false)
  useEffect(() => {
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPainted(true)) })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [])
  return painted
}

const ISSUES: Record<string, GitKey> = {
  missingTerminal: 'termMissing',
  terminalLimit: 'termLimit',
  inputFull: 'termInputFull',
  attachmentEnded: 'termDisconnected',
  invalidOutput: 'termDisconnected',
}

/** A slice of a view's state; re-renders only when one of the selected values changes. */
function useViewSelect<T extends readonly unknown[]>(view: TerminalView, select: (state: TerminalState) => T): T {
  const cache = useRef<{ view: TerminalView; value: T }>()
  const get = (): T => {
    const next = select(view.state.getSnapshot())
    const prev = cache.current
    if (prev !== undefined && prev.view === view && prev.value.length === next.length && prev.value.every((value, i) => Object.is(value, next[i]))) return prev.value
    cache.current = { view, value: next }
    return next
  }
  return useSyncExternalStore(view.state.subscribe, get)
}

/** How often a shown panel looks for terminals opened on another device. */
const ADOPT_MS = 10_000

export function TerminalDrawer(props: {
  terminals: GitTerminals
  sessionId: string
  repo: RepoStore
  /** The git tab is on screen; hidden, no terminal stays attached. */
  visible: boolean
  onClose: () => void
  openTerminal?: () => void
  backToSession?: () => void
}): ReactNode {
  const { terminals, sessionId, repo, onClose } = props
  const tabs = useSyncExternalStore(terminals.subscribe, () => terminals.tabs(sessionId))
  const [height, grip] = useDrawerHeight()
  const [shellMenu, setShellMenu] = useState<DOMRect | undefined>()

  // Opening the panel shows the terminals still running: the ones whose process is gone (DSH
  // restarted, the host reclaimed it, it exited or failed) are dropped, the ones opened on
  // another device are taken in, and with none left a new one starts, as VS Code does. A
  // listed terminal never starts a shell on its own. Checked in the background, together, and
  // changed in one update each.
  useEffect(() => {
    let live = true
    void terminals.prune(sessionId).then(() => terminals.adopt(sessionId)).then(() => {
      if (live && terminals.tabs(sessionId).list.length === 0) terminals.open(sessionId)
    })
    return () => { live = false }
  }, [terminals, sessionId])

  // While shown, a terminal opened on another device turns up within ADOPT_MS, and at once
  // when the page comes back to the front.
  useEffect(() => {
    if (!props.visible) return
    const adopt = (): void => { if (!document.hidden) void terminals.adopt(sessionId) }
    const timer = setInterval(adopt, ADOPT_MS)
    document.addEventListener('visibilitychange', adopt)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', adopt)
    }
  }, [terminals, sessionId, props.visible])

  const close = useCallback((key: string) => {
    terminals.close(sessionId, key)
    // Ending the last terminal hides the panel.
    if (terminals.tabs(sessionId).list.length === 0) onClose()
  }, [terminals, sessionId, onClose])
  const closeTab = useCallback((key: string) => {
    terminals.closeTab(sessionId, key)
    if (terminals.tabs(sessionId).list.length === 0) onClose()
  }, [terminals, sessionId, onClose])
  // A terminal whose process vanished while shown gives way to a fresh one.
  const replace = useCallback((key: string) => {
    terminals.close(sessionId, key)
    if (terminals.tabs(sessionId).list.length === 0) terminals.open(sessionId)
  }, [terminals, sessionId])

  // One status read shortly after a submitted line starts printing; the repo's
  // own polling (and its log reload on ref changes) covers anything later.
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const onSubmit = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void repo.refresh(), 900)
  }, [repo])
  useEffect(() => () => clearTimeout(timer.current), [])

  const groups = useMemo(() => groupsOf(tabs.list), [tabs.list])
  const current = groups.find((group) => group.panes.some((pane) => pane.key === tabs.active)) ?? groups[0]
  const focused = current === undefined ? undefined : terminals.focused(tabs, current)
  const full = current === undefined || current.panes.length >= MAX_PANES
  const split = useCallback((beside?: string) => { terminals.split(sessionId, beside) }, [terminals, sessionId])

  // VS Code's keys, taken before the terminal sees them: split, and the pane to either side.
  const onKeyDownCapture = (event: ReactKeyboardEvent): void => {
    if (current === undefined || event.nativeEvent.isComposing) return
    if (isSplitKey(event)) {
      if (!full) split()
    } else if (event.altKey && (MAC ? event.metaKey : event.ctrlKey) && STEPS[event.key] !== undefined && current.panes.length > 1) {
      const at = current.panes.findIndex((pane) => pane.key === focused?.key)
      const next = current.panes[(at + STEPS[event.key]! + current.panes.length) % current.panes.length]!
      terminals.select(sessionId, next.key)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <section className="gc-drawer gt-drawer" style={height > 0 ? { height } : undefined} aria-label={t('console')} onKeyDownCapture={onKeyDownCapture}>
      {grip}
      <div className="gc-head gt-head">
        <div className="gt-tabs" role="tablist" aria-label={t('console')}>
          {groups.map((group) => (
            <TerminalTab key={group.root.key} terminals={terminals} sessionId={sessionId} group={group}
              entry={terminals.focused(tabs, group)} active={group === current} onClose={closeTab} onKill={close} onSplit={split} />
          ))}
        </div>
        <button type="button" className="ah-icon-btn" aria-label={t('termNew')} title={t('termNew')}
          onClick={() => terminals.open(sessionId)}>
          <IconPlus size={14} />
        </button>
        <button type="button" className="ah-icon-btn gt-shell-btn" aria-label={t('termShell')} title={t('termShell')} aria-haspopup="menu"
          aria-expanded={shellMenu !== undefined}
          onClick={(event) => setShellMenu(shellMenu === undefined ? event.currentTarget.getBoundingClientRect() : undefined)}>
          <IconChevronDown size={12} />
        </button>
        <button type="button" className="ah-icon-btn" aria-label={t('termSplit')} disabled={full}
          title={current !== undefined && full ? t('termSplitFull', { n: MAX_PANES }) : `${t('termSplit')} (${SPLIT_HINT})`}
          onClick={() => split()}>
          <IconSplit size={14} />
        </button>
        <span className="gp-grow" />
        {props.openTerminal !== undefined && (
          <button type="button" className="ah-icon-btn" aria-label={t('consoleFull')} title={t('consoleFull')} onClick={props.openTerminal}><IconOpen size={14} /></button>
        )}
        <button type="button" className="ah-icon-btn" aria-label={t('termHide')} title={t('termHide')} onClick={onClose}><IconClose size={14} /></button>
      </div>
      <div className="gt-body">
        {current !== undefined && focused !== undefined && props.visible && (
          <SplitPanes terminals={terminals} sessionId={sessionId} group={current} focused={focused.key}
            backToSession={props.backToSession} onSubmit={onSubmit} repo={repo} onExit={close} onMissing={replace} onSplit={split} />
        )}
      </div>
      {shellMenu !== undefined && (
        <ShellMenu rect={shellMenu} terminals={terminals} sessionId={sessionId} onClose={() => setShellMenu(undefined)} />
      )}
    </section>
  )
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** VS Code's split keys: ⌘\ on a Mac; Ctrl+Shift+5 elsewhere, where Ctrl+\ belongs to the shell (SIGQUIT). */
const SPLIT_HINT = MAC ? '⌘\\' : 'Ctrl+Shift+5'
const isSplitKey = (event: ReactKeyboardEvent): boolean => MAC
  ? event.metaKey && !event.ctrlKey && !event.altKey && event.key === '\\'
  : event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'Digit5'
const STEPS: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }

function ShellMenu(props: { rect: DOMRect; terminals: GitTerminals; sessionId: string; onClose: () => void }): ReactNode {
  const { terminals, sessionId } = props
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ready'; shells: Shell[]; selected?: string } | { phase: 'failed'; message: string }>({ phase: 'loading' })
  useEffect(() => {
    const lifetime = new AbortController()
    setState({ phase: 'loading' })
    terminals.shells(sessionId, lifetime.signal).then(
      (result) => { if (!lifetime.signal.aborted) setState({ phase: 'ready', shells: result.shells, ...(result.selectedShell ? { selected: result.selectedShell } : {}) }) },
      (error: unknown) => { if (!lifetime.signal.aborted) setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => lifetime.abort()
  }, [terminals, sessionId, attempt])
  const entries: MenuEntry[] = state.phase === 'loading'
    ? [{ heading: t('termShellLoading') }]
    : state.phase === 'failed'
      ? [{ heading: t('termFailed', { message: state.message }) }, { id: 'retry', label: t('retry') }]
      : state.shells.length === 0
        ? [{ heading: t('termShellEmpty') }]
        : [{ heading: t('termShell') }, ...state.shells.map((shell) => ({ id: `s:${shell.path}`, label: shell.name, hint: shell.path, checked: shell.path === state.selected, icon: <IconTerminal size={14} /> }))]
  return (
    <Menu anchor={{ x: props.rect.left, y: props.rect.bottom, rect: props.rect }} entries={entries} label={t('termShell')}
      onClose={props.onClose}
      onSelect={(id) => {
        if (id === 'retry') {
          setAttempt((n) => n + 1)
          return
        }
        props.onClose()
        const path = id.slice(2)
        terminals.host.selectShell(path)
        terminals.open(sessionId, path)
      }} />
  )
}

let dragging: string | undefined

/** The pane's title, and whether its process is over. */
function usePaneTitle(view: TerminalView): readonly [string, boolean] {
  return useViewSelect(view, (state) => [
    state.info?.title ?? state.title ?? t('console'),
    state.info?.state === 'exited' || state.info?.state === 'failed' || state.phase === 'failed',
  ] as const)
}

/** The strongest mark among a tab's panes: one still running outweighs one finished. */
function groupMark(marks: ReadonlyMap<string, TerminalMark>, group: TerminalGroup): TerminalMark | undefined {
  let mark: TerminalMark | undefined
  for (const pane of group.panes) {
    const next = marks.get(pane.key)
    if (next === 'busy') return next
    mark ??= next
  }
  return mark
}

/**
 * A tab: a terminal and the panes split into it. It shows its focused pane (its title, the one
 * renamed); × and the middle click end every pane of it.
 */
function TerminalTab(props: {
  terminals: GitTerminals
  sessionId: string
  group: TerminalGroup
  /** The pane the tab shows: its focused one. */
  entry: TerminalEntry
  active: boolean
  /** Ends the tab, all its panes. */
  onClose: (key: string) => void
  /** Ends one pane. */
  onKill: (key: string) => void
  onSplit: (beside: string) => void
}): ReactNode {
  const { terminals, sessionId, group, entry } = props
  const root = group.root.key
  const panes = group.panes.length
  const view = useMemo(() => terminals.view(entry), [terminals, entry])
  const [title, ended] = usePaneTitle(view)
  const mark = useSyncExternalStore(terminals.subscribe, () => groupMark(terminals.marks(), group))
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>()
  const [drop, setDrop] = useState(false)
  const select = (): void => terminals.select(sessionId, root)
  const markText = mark === undefined ? undefined : t(mark === 'busy' ? 'termBusy' : 'termDone', { n: 1 })
  const tip = [title, panes > 1 ? t('termPanes', { n: panes }) : undefined, markText].filter(Boolean).join(' · ')
  const close = t(panes > 1 ? 'termKillTab' : 'termKill')
  const menuEntries: MenuEntry[] = [
    { id: 'rename', label: t('termRename'), hint: 'F2' },
    { id: 'split', label: t('termSplit'), hint: SPLIT_HINT, icon: <IconSplit size={14} />, disabled: panes >= MAX_PANES },
    { separator: true },
    ...(panes > 1 ? [{ id: 'kill', label: t('termKillPane'), danger: true }] : []),
    { id: 'close', label: close, danger: true },
  ]
  return (
    <div role="tab" aria-selected={props.active} tabIndex={props.active ? 0 : -1} className="gt-tab"
      data-ended={ended ? '' : undefined} data-drop={drop ? '' : undefined} title={tip}
      draggable={!editing}
      onDragStart={(event) => { dragging = root; event.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={() => { dragging = undefined }}
      onDragOver={(event) => { if (dragging !== undefined && dragging !== root) { event.preventDefault(); setDrop(true) } }}
      onDragLeave={() => setDrop(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDrop(false)
        if (dragging !== undefined) terminals.move(sessionId, dragging, root)
      }}
      onClick={select}
      onDoubleClick={() => setEditing(true)}
      onAuxClick={(event) => { if (event.button === 1) props.onClose(root) }}
      onContextMenu={(event) => {
        event.preventDefault()
        select()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      onKeyDown={(event) => {
        if (editing) return
        if (event.key === 'F2') setEditing(true)
        else if (event.key === 'Delete') props.onClose(root)
        else return
        event.preventDefault()
      }}>
      {mark !== undefined
        ? <span className="ah-term-mark" data-mark={mark} role="img" aria-label={markText} />
        : panes > 1 ? <IconSplit size={13} /> : <IconTerminal size={13} />}
      {editing
        ? (
          <input className="gt-rename" defaultValue={title} maxLength={120} aria-label={t('termRename')} autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') event.currentTarget.blur()
              else if (event.key === 'Escape') {
                event.currentTarget.value = title
                event.currentTarget.blur()
              }
            }}
            onBlur={(event) => {
              setEditing(false)
              const next = event.currentTarget.value.trim()
              if (next !== '' && next !== title) void view.rename(next)
            }} />
        )
        : <span className="gt-tab-title">{title}</span>}
      {panes > 1 && !editing && <span className="gt-tab-count" aria-hidden="true">{panes}</span>}
      <button type="button" className="gt-tab-close" aria-label={close} title={close}
        onClick={(event) => {
          event.stopPropagation()
          props.onClose(root)
        }}>
        <IconClose size={12} />
      </button>
      {menu !== undefined && (
        <Menu anchor={menu} label={title} onClose={() => setMenu(undefined)} entries={menuEntries}
          onSelect={(id) => {
            setMenu(undefined)
            if (id === 'rename') setEditing(true)
            else if (id === 'split') props.onSplit(entry.key)
            else if (id === 'kill') props.onKill(entry.key)
            else props.onClose(root)
          }} />
      )}
    </div>
  )
}

/** Narrower than this per pane, a tab's panes stack instead of standing side by side (about 30 columns). */
const MIN_COLUMN = 240
/** The least a pane gives way to its neighbour while the sash between them is dragged. */
const MIN_PANE = { row: 96, column: 56 }
/** One arrow key press on a sash: this share of the two panes it divides. */
const SASH_STEP = 0.05

/**
 * The selected tab's panes, side by side (stacked when the panel is too narrow), each with
 * its own screen. With more than one, each pane gets a slim header (its title, split, kill),
 * the focused one marked with the accent, and a sash between neighbours.
 */
function SplitPanes(props: {
  terminals: GitTerminals
  sessionId: string
  group: TerminalGroup
  focused: string
  onSubmit: () => void
  repo: RepoStore
  backToSession?: () => void
  onExit: (key: string) => void
  onMissing: (key: string) => void
  onSplit: (beside: string) => void
}): ReactNode {
  const { terminals, sessionId, group } = props
  const panes = group.panes
  const ref = useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = useState(false)
  // Widths while a sash is dragged; written to the list once it is let go.
  const [draft, setDraft] = useState<Record<string, number>>()
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const measure = (): void => setStacked(panes.length > 1 && node.clientWidth > 0 && node.clientWidth < panes.length * MIN_COLUMN)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [panes.length])
  const weight = (entry: TerminalEntry): number => draft?.[entry.key] ?? entry.weight ?? 1
  const axis = stacked ? 'column' : 'row'

  /** The sash after pane `index`: moves the boundary between it and the next by `delta` pixels. */
  const shift = (index: number, delta: number, from: { a: number; b: number }): Record<string, number> => {
    const a = panes[index]!
    const b = panes[index + 1]!
    const total = from.a + from.b
    const min = Math.min(MIN_PANE[axis], total / 2)
    const size = Math.max(min, Math.min(total - min, from.a + delta))
    const sum = weight(a) + weight(b)
    return { [a.key]: (sum * size) / total, [b.key]: (sum * (total - size)) / total }
  }
  /** The two panes' sizes along the axis, measured on screen. */
  function sizes(index: number): { a: number; b: number } | undefined {
    const cells = ref.current?.querySelectorAll<HTMLElement>(':scope > .gt-cell')
    const a = cells?.[index]?.getBoundingClientRect()
    const b = cells?.[index + 1]?.getBoundingClientRect()
    if (a === undefined || b === undefined) return undefined
    return stacked ? { a: a.height, b: b.height } : { a: a.width, b: b.width }
  }
  const startDrag = (index: number, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const from = sizes(index)
    if (from === undefined) return
    event.preventDefault()
    const sash = event.currentTarget
    sash.setPointerCapture(event.pointerId)
    const start = stacked ? event.clientY : event.clientX
    let last: Record<string, number> | undefined
    const move = (e: PointerEvent): void => {
      last = shift(index, (stacked ? e.clientY : e.clientX) - start, from)
      setDraft(last)
    }
    const up = (): void => {
      sash.removeEventListener('pointermove', move)
      sash.removeEventListener('pointerup', up)
      sash.removeEventListener('pointercancel', up)
      if (last !== undefined) terminals.resize(sessionId, last)
      setDraft(undefined)
    }
    sash.addEventListener('pointermove', move)
    sash.addEventListener('pointerup', up)
    sash.addEventListener('pointercancel', up)
  }
  const onSashKey = (index: number, event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const back = stacked ? 'ArrowUp' : 'ArrowLeft'
    const forth = stacked ? 'ArrowDown' : 'ArrowRight'
    if (event.key === 'Enter') terminals.evenOut(sessionId, group.root.key)
    else if (event.key === back || event.key === forth) {
      const from = sizes(index)
      if (from === undefined) return
      terminals.resize(sessionId, shift(index, (event.key === back ? -1 : 1) * SASH_STEP * (from.a + from.b), from))
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  const split = panes.length > 1
  // Pointing at or tabbing into a pane focuses it; its header's buttons act on it without moving the focus.
  const focus = (key: string, target: EventTarget): void => {
    if (key !== props.focused && !(target instanceof Element && target.closest('.gt-pane-btn') !== null)) terminals.select(sessionId, key)
  }
  const total = panes.reduce((sum, pane) => sum + weight(pane), 0)
  return (
    <div ref={ref} className="gt-split" data-axis={axis} data-dragging={draft === undefined ? undefined : ''}>
      {panes.map((entry, index) => {
        // The sash's value: the share of the pane before it.
        const share = index === 0 ? 0 : Math.round((100 * weight(panes[index - 1]!)) / total)
        // By position: the first pane keeps its screen (and xterm) when another tab is selected.
        return (
          <Fragment key={index}>
            {index > 0 && (
              <div className="gt-sash" role="separator" tabIndex={0}
                aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-label={t('termResizePanes')}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} title={t('termResizeHint')}
                onPointerDown={(event) => startDrag(index - 1, event)}
                onKeyDown={(event) => onSashKey(index - 1, event)}
                onDoubleClick={() => terminals.evenOut(sessionId, group.root.key)} />
            )}
            <div className="gt-cell" style={{ flex: `${weight(entry)} 1 0` }}
              data-focused={split && entry.key === props.focused ? '' : undefined}
              onPointerDownCapture={(event) => focus(entry.key, event.target)}
              onFocusCapture={(event) => focus(entry.key, event.target)}>
              {split && (
                <PaneHead terminals={terminals} entry={entry} full={panes.length >= MAX_PANES}
                  onSplit={props.onSplit} onKill={props.onExit} />
              )}
              <ActiveTerminal terminals={terminals} sessionId={sessionId} view={terminals.view(entry)} entryKey={entry.key} focused={entry.key === props.focused}
                backToSession={props.backToSession} onSubmit={props.onSubmit} repo={props.repo} onExit={props.onExit} onMissing={props.onMissing} />
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

/** A split pane's own header: its title, and splitting or ending just this pane. */
function PaneHead(props: { terminals: GitTerminals; entry: TerminalEntry; full: boolean; onSplit: (beside: string) => void; onKill: (key: string) => void }): ReactNode {
  const { terminals, entry } = props
  const view = useMemo(() => terminals.view(entry), [terminals, entry])
  const [title, ended] = usePaneTitle(view)
  return (
    <div className="gt-pane-head" data-ended={ended ? '' : undefined}>
      <IconTerminal size={12} />
      <span className="gt-pane-title" title={title}>{title}</span>
      <button type="button" className="gt-pane-btn" aria-label={t('termSplit')} title={props.full ? t('termSplitFull', { n: MAX_PANES }) : t('termSplit')}
        disabled={props.full} onClick={() => props.onSplit(entry.key)}>
        <IconSplit size={12} />
      </button>
      <button type="button" className="gt-pane-btn" aria-label={t('termKill')} title={t('termKill')} onClick={() => props.onKill(entry.key)}>
        <IconClose size={12} />
      </button>
    </div>
  )
}

/** How long a finished-task notice stays, unless pointed at or focused. */
const NOTICE_MS = 8000
const NOTICE_MAX = 3

interface Notice {
  id: number
  sessionId: string
  keys: string[]
}

let noticeSeq = 0

/**
 * Notices for terminal commands that finished off screen, over the whole window: one per
 * Session (a second finish in the same Session joins the first), at most three. View goes to
 * the Session with that terminal in front. A notice leaves after a few seconds, when closed,
 * or as soon as its terminals are seen some other way.
 */
export function TerminalNotices(props: {
  terminals: { subscribe(listener: () => void): () => void; get(): GitTerminals | undefined }
  sessionTitle: (sessionId: string) => string | undefined
  open: (sessionId: string, key: string) => void
}): ReactNode {
  const host = useSyncExternalStore(props.terminals.subscribe, props.terminals.get)
  const [notices, setNotices] = useState<Notice[]>([])
  useEffect(() => host?.onDone((done) => setNotices((list) => {
    const same = list.find((notice) => notice.sessionId === done.sessionId)
    const rest = list.filter((notice) => notice !== same)
    const keys = [...new Set([...(same?.keys ?? []), ...done.keys])]
    // A joined notice is a new one: it moves to the end and its time starts again.
    return [...rest, { id: ++noticeSeq, sessionId: done.sessionId, keys }].slice(-NOTICE_MAX)
  })), [host])
  // Seen another way (the user went there): its notice goes.
  const marks = useSyncExternalStore(host?.subscribe ?? noSubscribe, () => host?.marks())
  useEffect(() => {
    setNotices((list) => {
      const kept = list.filter((notice) => notice.keys.some((key) => marks?.get(key) === 'done'))
      return kept.length === list.length ? list : kept
    })
  }, [marks])
  useEffect(injectGitStyle, [])
  const dismiss = useCallback((id: number): void => setNotices((list) => list.filter((notice) => notice.id !== id)), [])
  if (host === undefined || notices.length === 0) return null
  return (
    <div className="gt-notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <TerminalNotice key={notice.id} notice={notice} title={props.sessionTitle(notice.sessionId)}
          onView={() => {
            dismiss(notice.id)
            props.open(notice.sessionId, notice.keys[notice.keys.length - 1]!)
          }}
          onDismiss={dismiss} />
      ))}
    </div>
  )
}

const noSubscribe = (): (() => void) => () => {}

function TerminalNotice(props: { notice: Notice; title: string | undefined; onView: () => void; onDismiss: (id: number) => void }): ReactNode {
  const { onDismiss } = props
  const { id } = props.notice
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => onDismiss(id), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [held, onDismiss, id])
  const session = props.title?.trim() || t('termDoneUntitled')
  const n = props.notice.keys.length
  const text = n > 1 ? t('termDoneToastMany', { n }) : t('termDoneToast')
  // The message stays whole; a long session title is what gives way.
  return (
    <div className="gt-notice" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false) }}>
      <span className="ah-term-mark" data-mark="done" aria-hidden="true" />
      <span className="gt-notice-text">
        <span className="gt-notice-title">{text}</span>
        <span className="gt-notice-session" title={session}>{session}</span>
      </span>
      <button type="button" className="gp-text-btn gt-notice-view" onClick={props.onView}>{t('termView')}</button>
      <button type="button" className="ah-icon-btn gt-notice-close" aria-label={t('dismiss')} title={t('dismiss')} onClick={() => onDismiss(id)}>
        <IconClose size={12} />
      </button>
    </div>
  )
}

/** A pane on screen: its status line and its screen. */
function ActiveTerminal(props: { terminals: GitTerminals; sessionId: string; view: TerminalView; entryKey: string; focused: boolean; onSubmit: () => void; repo: RepoStore; backToSession?: () => void; onExit: (key: string) => void; onMissing: (key: string) => void }): ReactNode {
  const { terminals, view, entryKey, onExit, onMissing } = props
  const [menu, setMenu] = useState<{ pick?: SelectionPick; sessionId: string; anchor: MenuAnchor; refocus: () => void }>()
  useEffect(() => { setMenu(undefined) }, [props.sessionId, view])
  const menuSpec = menu === undefined ? undefined
    : selectionMenu(menu.pick, { insert: (draft) => insertIntoSession(menu.sessionId, draft), repo: props.repo, backToSession: props.backToSession })
  // On screen: seen, and not probed; leaving the screen has it looked at.
  useEffect(() => terminals.show(entryKey), [terminals, entryKey])
  const [phase, writable, created, infoState, exitCode, issueKey, error] = useViewSelect(view, (state) => [
    state.phase, state.writable, state.info !== undefined, state.info?.state, state.info?.exitCode, state.issue, state.error ?? state.info?.error,
  ] as const)
  // A shell that exits cleanly closes its tab, as in VS Code; a failure stays readable.
  useEffect(() => {
    if (infoState === 'exited' && exitCode === 0) onExit(entryKey)
  }, [infoState, exitCode, onExit, entryKey])
  useEffect(() => {
    if (issueKey === 'missingTerminal') onMissing(entryKey)
  }, [issueKey, onMissing, entryKey])

  const ended = infoState === 'exited' || phase === 'closed'
  let status: string | undefined
  if (issueKey === 'missingTerminal') status = undefined
  else if (phase === 'idle' || phase === 'loading') status = t('termLoading')
  else if (phase === 'creating') status = t('termStarting')
  else if (phase === 'connecting') status = t('termConnecting')
  else if (phase === 'disconnected') status = t('termDisconnected')
  else if (infoState === 'exited') status = t('termExited', { code: String(exitCode ?? '—') })
  else if (infoState === 'failed') status = t('termUnavailable')
  const painted = usePainted()
  const retry = !ended && (phase === 'failed' || phase === 'disconnected') && issueKey !== 'missingTerminal' && issueKey !== 'terminalLimit'
  const readOnly = phase === 'connected' && infoState === 'running' && !writable
  const issue = issueKey === undefined ? undefined : ISSUES[issueKey]
  const message = phase === 'disconnected' ? undefined : issue !== undefined ? t(issue) : error

  return (
    <div className="gt-pane" role="tabpanel">
      {(status !== undefined || retry || readOnly) && (
        <div className="gt-status" role="status">
          {status}
          {readOnly && <>{t('termReadonly')}<button type="button" className="gp-text-btn" onClick={() => view.connect()}>{t('termControl')}</button></>}
          {retry && (
            <button type="button" className="gp-text-btn" onClick={() => (created ? view.connect() : void view.refresh())}>
              {t(phase === 'disconnected' ? 'termReconnect' : 'retry')}
            </button>
          )}
        </div>
      )}
      {issueKey !== 'missingTerminal' && issueKey !== 'terminalLimit' && (
        painted
          ? (
            <Suspense fallback={<div className="gt-screen" />}>
              <Screen view={view} label={t('console')} focused={props.focused} onSubmit={props.onSubmit}
                onSelectionMenu={(text, anchor, refocus) => setMenu({ anchor, refocus, sessionId: props.sessionId,
                  ...(text === '' ? {} : { pick: { text, draft: `\nTerminal: ${JSON.stringify(view.state.getSnapshot().info?.title ?? t('console'))}\n${textBlock(text)}\n` } }) })} />
            </Suspense>
          )
          : <div className="gt-screen" />
      )}
      {menu !== undefined && menuSpec !== undefined && <Menu anchor={menu.anchor} label={menuSpec.label} entries={menuSpec.entries}
        onClose={() => { setMenu(undefined); menu.refocus() }}
        onSelect={(id) => { setMenu(undefined); menuSpec.onSelect(id); menu.refocus() }} />}
      {message !== undefined && <p className="gt-error" role="alert">{issue !== undefined ? message : t('termFailed', { message })}</p>}
    </div>
  )
}
