/**
 * The git pane: branch + sync header, Changes/Graph switch, the command line
 * drawer. Like Git Graph, the pane never navigates for details: a commit
 * expands in place inside the graph, and a file's diff opens over the middle
 * (agent) column through the diff stage, leaving this pane exactly as it was.
 * Only without a stage host does a diff fall back to a panel here.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createBranch, openTree, runPush, treeOf } from './actions.tsx'
import { ChangesView, stashDialog } from './Changes.tsx'
import { ownUpstream, PaneContext, useRepo, type DiffTarget, type MenuState, type Panel, type PaneApi, type View } from './context.ts'
import { stage } from './stage.ts'
import { CommitPanel, DiffPanel, TreeToggle } from './Detail.tsx'
import { GraphView, locateHead } from './Graph.tsx'
import { WorktreesView } from './Worktrees.tsx'
import { t } from './i18n.ts'
import { IconBranch, IconChevronDown, IconCloudDown, IconCloudUp, IconDown, IconForce, IconLocate, IconMore, IconPlus, IconStash, IconSync, IconTerminal, IconUp, IconWorktree } from './icons.tsx'
import { Dialog, Menu, Toasts, useCoarse, useWidth, type DialogSpec, type MenuEntry } from './kit.tsx'
import type { RepoStore } from './store.ts'
import { ConsoleDrawer, consoleFor, type ConsoleCall } from './Console.tsx'
import { preloadScreen, TerminalDrawer } from './Terminals.tsx'
import type { GitTerminals } from './terminal-host.ts'
import type { ConnectorsStore } from '../connectors/api.ts'
import type { StartIssue } from './context.ts'

const CONSOLE_KEY = 'dsh-agent-hub.git.console'
const noSubscribe = (): (() => void) => () => {}
const readFlag = (key: string, fallback: boolean): boolean => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}
const writeFlag = (key: string, value: boolean): void => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Not persisted.
  }
}

const views = new Map<string, View>()

export interface PaneProps {
  repo: RepoStore
  consoleCall?: ConsoleCall
  /** DSH's terminal service for this session: the drawer then holds real terminals instead of the command line. */
  terminals?: { host: GitTerminals; sessionId: string }
  /** The pane is on screen (false while its sidebar tab is hidden). */
  visible?: boolean
  openTerminal?: (element: Element) => void
  openFile?: (absolutePath: string) => void
  insert?: (text: string) => boolean
  backToSession?: () => void
  /** Start a session in a DSH workspace (where a worktree's sessions run), its composer prefilled with `draft`. */
  openWorkspace?: (workspaceId: string, draft?: string) => void
  /** Linear tickets for the worktree picker and rows. */
  tickets?: ConnectorsStore
  startIssue?: StartIssue
  /** Hand the tab's refresh command to the pane. */
  bindRefresh?: (refresh: () => void) => (() => void) | void
}

export function GitPane(props: PaneProps): ReactNode {
  const { repo } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useWidth(rootRef)
  const coarse = useCoarse()
  const status = useRepo(repo, (state) => state.status)
  const error = useRepo(repo, (state) => state.error)
  const busy = useRepo(repo, (state) => state.busy)
  const [view, setViewState] = useState<View>(() => views.get(repo.cwd) ?? 'changes')
  const trees = useRepo(repo, (state) => state.trees?.list?.worktrees.length)
  const [stack, setStack] = useState<Panel[]>([])
  const [leaving, setLeaving] = useState<Panel | undefined>()
  const [menu, setMenu] = useState<MenuState | undefined>()
  const [dialog, setDialog] = useState<DialogSpec | undefined>()
  // The command line's drawer is one pane-wide flag; the terminal panel is open or closed per
  // session (a session left with its terminals in view comes back with them), the pane-wide
  // flag deciding for a session never set.
  const [flagOpen, setFlagOpen] = useState(() => readFlag(CONSOLE_KEY, false))
  const host = props.terminals?.host
  const terminalSession = props.terminals?.sessionId
  const drawerOpen = useSyncExternalStore(host?.subscribe ?? noSubscribe, () => (host === undefined || terminalSession === undefined ? undefined : host.drawer(terminalSession, flagOpen)))
  const consoleOpen = drawerOpen ?? flagOpen
  const toggleConsole = useCallback(() => {
    const next = !consoleOpen
    if (host !== undefined && terminalSession !== undefined) host.setDrawer(terminalSession, next)
    else {
      writeFlag(CONSOLE_KEY, next)
      setFlagOpen(next)
    }
  }, [consoleOpen, host, terminalSession])
  const session = useMemo(() => (props.consoleCall === undefined ? undefined : consoleFor(repo, props.consoleCall)), [repo, props.consoleCall])
  const openTerminal = props.openTerminal
  const openFullTerminal = useCallback(() => { if (rootRef.current !== null) openTerminal?.(rootRef.current) }, [openTerminal])

  // Fast polling only while the tab is on screen; a hidden tab leaves the header badge's slow pace.
  const shown = props.visible !== false
  useEffect(() => (shown ? repo.retain() : undefined), [repo, shown])
  useEffect(() => props.bindRefresh?.(() => { void repo.refresh(); if (repo.getSnapshot().log) void repo.loadLog(); if (repo.getSnapshot().trees) void repo.loadTrees() }) ?? undefined, [repo, props.bindRefresh])
  // The terminal's xterm chunk is fetched while idle, so opening the drawer does not wait on it.
  const hasTerminals = props.terminals !== undefined
  useEffect(() => (shown && hasTerminals ? preloadScreen() : undefined), [shown, hasTerminals])
  // Read once on open: the tab shows how many trees there are, and branch menus know which branch lives in which tree.
  useEffect(() => { if (repo.getSnapshot().trees === undefined) void repo.loadTrees() }, [repo])

  const setView = useCallback((next: View) => {
    views.set(repo.cwd, next)
    setViewState(next)
    setStack([])
  }, [repo])

  // A repository opened without a remembered view lands on the graph when there is nothing to
  // commit; the first status read decides, later edits do not switch the view.
  const decided = useRef(views.has(repo.cwd))
  useEffect(() => {
    if (decided.current || status === undefined) return
    decided.current = true
    const clean = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length === 0
    if (clean && status.operation === undefined && status.head !== undefined) setViewState('graph')
  }, [status])

  const overlay = width > 0 && width < 760
  const columns = width >= 1200 ? 2 : 1
  // The stage's diff, when it belongs to this repository: rows highlight it.
  const staged = useSyncExternalStore(stage.subscribe, stage.get)
  const stagedTarget = staged?.repo === repo ? staged.target : undefined

  const open = useCallback((panel: Panel, mode: 'push' | 'replace' | 'reset' = 'push') => {
    setStack((old) => {
      if (mode === 'reset') return [panel]
      if (mode === 'replace' && old.length > 0) return [...old.slice(0, -1), panel]
      return [...old, panel]
    })
  }, [])
  const back = useCallback(() => {
    setStack((old) => {
      if (old.length === 0) return old
      if (overlay && old.length === 1) {
        // Slide the last panel out before it unmounts.
        setLeaving(old[0])
        setTimeout(() => setLeaving(undefined), 160)
      }
      return old.slice(0, -1)
    })
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-gp-base] [data-cursor]')?.focus({ preventScroll: true }))
  }, [overlay])

  const openFileProp = props.openFile
  const showDiff = useCallback((target: DiffTarget, siblings?: DiffTarget[], context?: string) => {
    if (stage.available()) {
      stage.show({ repo, target, insert: props.insert, backToSession: props.backToSession, ...(siblings ? { siblings } : {}), ...(context ? { context } : {}), ...(openFileProp ? { openFile: openFileProp } : {}) })
      return
    }
    open({ kind: 'diff', target, ...(siblings ? { siblings } : {}) }, stack[stack.length - 1]?.kind === 'diff' ? 'replace' : 'push')
  }, [repo, openFileProp, open, stack, props.insert, props.backToSession])
  const top = stack[stack.length - 1]
  const activeDiff = stagedTarget ?? (top?.kind === 'diff' ? top.target : undefined)

  const api = useMemo<PaneApi>(() => ({
    repo,
    root: status?.root,
    common: status?.common,
    width,
    coarse,
    visible: props.visible,
    open,
    back,
    top: stack[stack.length - 1],
    stack,
    dialog: setDialog,
    menu: setMenu,
    ...(props.openFile === undefined ? {} : { openFile: props.openFile }),
    insert: props.insert,
    backToSession: props.backToSession,
    ...(props.openWorkspace === undefined ? {} : { openWorkspace: props.openWorkspace }),
    ...(props.tickets === undefined ? {} : { tickets: props.tickets }),
    ...(props.startIssue === undefined ? {} : { startIssue: props.startIssue }),
    setView,
    showDiff,
    ...(activeDiff === undefined ? {} : { activeDiff }),
  }), [repo, status?.root, status?.common, width, coarse, open, back, stack, props.openFile, props.openWorkspace, props.tickets, props.startIssue, props.insert, props.backToSession, props.visible, setView, showDiff, activeDiff])

  // A diff or commit that no longer exists (file committed, branch reset) closes itself on the next open.
  let content: ReactNode
  if (status === undefined && error === undefined) {
    content = <div className="gp-skeleton-list" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="gp-skeleton-row" />)}</div>
  } else if (status === undefined) {
    content = (
      <div className="gp-state">
        <p>{error!.code === 'not-repo' ? t('notRepo') : error!.code === 'denied' ? t('denied') : t('loadFailed', { error: error!.message })}</p>
        {error!.code === 'not-repo'
          ? <button type="button" className="ah-btn" data-variant="primary" disabled={busy !== undefined} onClick={() => void repo.run({ op: 'init' }, { done: 'done' })}>{t('init')}</button>
          : error!.code !== 'denied' && <button type="button" className="ah-btn" onClick={() => void repo.refresh()}>{t('retry')}</button>}
      </div>
    )
  }

  // The same element while the view and status hold: opening or closing the drawer, a menu or a
  // dialog re-renders the pane, not its (possibly long) lists.
  const baseView = useMemo(() => (status === undefined ? undefined
    : view === 'changes' ? <ChangesView status={status} /> : view === 'graph' ? <GraphView status={status} /> : <WorktreesView />), [view, status])

  const visible = overlay ? stack.slice(-1) : stack.slice(-columns)
  const changeCount = status === undefined ? 0 : status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length

  return (
    <PaneContext.Provider value={api}>
      <div ref={rootRef} className="gp-root" data-layout={overlay ? 'overlay' : 'split'} data-coarse={coarse ? '' : undefined}>
        <Header repo={repo} view={view} console={session === undefined && props.terminals === undefined ? undefined : { open: consoleOpen, toggle: toggleConsole }} />
        {status !== undefined && (
          <div className="gp-tabs" role="tablist" data-view={view}>
            <button type="button" role="tab" aria-selected={view === 'changes'} className="gp-tab" onClick={() => setView('changes')}>
              {t('changes')}{changeCount > 0 && <span className="gp-count">{changeCount}</span>}
            </button>
            <button type="button" role="tab" aria-selected={view === 'graph'} className="gp-tab" onClick={() => setView('graph')}>{t('graph')}</button>
            <button type="button" role="tab" aria-selected={view === 'trees'} className="gp-tab" onClick={() => setView('trees')}>
              {t('trees')}{trees !== undefined && trees > 1 && <span className="gp-count">{trees}</span>}
            </button>
            <span className="gp-tab-ink" aria-hidden="true" />
          </div>
        )}
        <div className="gp-body">
          {content ?? (
            <>
              <div className="gp-base" data-gp-base="" data-covered={overlay && stack.length > 0 ? '' : undefined}
                style={!overlay && stack.length > 0 ? { flex: `0 0 ${columns === 2 ? (visible.length === 2 && visible[1]!.kind === 'diff' ? 26 : 34) : 42}%` } : undefined}>
                {baseView}
              </div>
              {visible.map((panel, i) => (
                <div key={`${stack.length - visible.length + i}:${panel.kind}`} className="gp-detail" data-overlay={overlay ? '' : undefined}
                  style={!overlay && visible.length === 2 && i === 0 && visible[1]!.kind === 'diff' ? { flex: '0 0 28%' } : undefined}>
                  {panel.kind === 'diff' ? <DiffPanel target={panel.target} siblings={panel.siblings} /> : <CommitPanel hash={panel.hash} />}
                </div>
              ))}
              {overlay && leaving !== undefined && stack.length === 0 && (
                <div className="gp-detail" data-overlay="" data-leaving="" aria-hidden="true">
                  {leaving.kind === 'diff' ? <DiffPanel target={leaving.target} siblings={leaving.siblings} /> : <CommitPanel hash={leaving.hash} />}
                </div>
              )}
            </>
          )}
        </div>
        {consoleOpen && props.terminals !== undefined && (status !== undefined || error?.code === 'not-repo') && (
          <TerminalDrawer terminals={props.terminals.host} sessionId={props.terminals.sessionId} repo={repo} visible={props.visible !== false} onClose={toggleConsole} backToSession={props.backToSession}
            {...(openTerminal === undefined ? {} : { openTerminal: openFullTerminal })} />
        )}
        {consoleOpen && props.terminals === undefined && session !== undefined && status !== undefined && (
          <ConsoleDrawer session={session} coarse={coarse} onClose={toggleConsole}
            {...(openTerminal === undefined ? {} : { openTerminal: openFullTerminal })} />
        )}
        <Toasts repo={repo} />
        {menu !== undefined && (
          <Menu anchor={menu.anchor} entries={menu.entries} label={menu.label} onClose={() => setMenu(undefined)}
            {...(menu.className === undefined ? {} : { className: menu.className })}
            onSelect={(id) => {
              setMenu(undefined)
              menu.onSelect(id)
            }} />
        )}
        {dialog !== undefined && <Dialog spec={dialog} onClose={() => setDialog(undefined)} />}
      </div>
    </PaneContext.Provider>
  )
}

function Header(props: { repo: RepoStore; view: View; console?: { open: boolean; toggle: () => void } }): ReactNode {
  const { repo } = props
  const status = useRepo(repo, (state) => state.status)
  const busy = useRepo(repo, (state) => state.busy)
  const [picker, setPicker] = useState<DOMRect | undefined>()
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number; rect: DOMRect } | undefined>()
  const pane = usePaneSafe()
  const loading = status === undefined || busy !== undefined

  const sync = async (): Promise<void> => {
    if (status === undefined) return
    if (status.branch !== undefined && !ownUpstream(status)) {
      await repo.run({ op: 'push', setUpstream: true }, { done: 'done.push' })
      return
    }
    // Behind only by its own rewritten commits: pulling would merge them back; a lease push (confirmed) replaces them.
    if (status.behind > 0 && status.rewritten === true && status.ahead > 0 && pane !== null) {
      runPush(`lease:${status.branch}`, pane)
      return
    }
    if (status.behind > 0) {
      const pulled = await repo.run({ op: 'pull' }, { done: 'done.pull' })
      if (!pulled.ok) return
    }
    const after = repo.getSnapshot().status
    if ((after?.ahead ?? 0) > 0) await repo.run({ op: 'push' }, { done: 'done.push' })
    else if (status.behind === 0) await repo.run({ op: 'fetch' }, { done: 'done.fetch' })
  }

  const branchLabel = status === undefined ? '' : status.branch ?? (status.head ? `${t('detached')} ${status.head.slice(0, 7)}` : t('unborn'))
  const unpublished = status !== undefined && status.branch !== undefined && !ownUpstream(status) && status.head !== undefined

  const moreEntries: MenuEntry[] = [
    { id: 'pull', label: t('pull'), icon: <IconDown size={14} />, disabled: status?.upstream === undefined },
    { id: 'push', label: t('push'), icon: <IconUp size={14} />, disabled: status?.branch === undefined },
    // Force pushes only go to the branch's own upstream: an unpublished branch publishes first.
    { id: `lease:${status?.branch ?? ''}`, label: t('forceLease'), icon: <IconForce size={14} />, disabled: status === undefined || !ownUpstream(status) },
    { id: `force:${status?.branch ?? ''}`, label: t('forcePush'), danger: true, disabled: status === undefined || !ownUpstream(status) },
    { id: 'fetch', label: t('fetch'), icon: <IconSync size={14} /> },
    { separator: true },
    { id: 'branch', label: t('newBranch'), icon: <IconPlus size={14} />, disabled: status?.head === undefined },
    { id: 'stash', label: t('stashPush'), icon: <IconStash size={14} />, disabled: status === undefined || status.staged.length + status.unstaged.length + status.untracked.length === 0 },
  ]

  return (
    <div className="gp-head" data-busy={loading && status !== undefined ? '' : undefined}>
      {status !== undefined && (
        <button type="button" className="gp-branch" aria-haspopup="menu" title={branchLabel}
          onClick={(event) => {
            if (repo.getSnapshot().log === undefined) void repo.loadLog()
            void repo.loadTrees()
            setPicker(event.currentTarget.getBoundingClientRect())
          }}>
          <IconBranch size={14} />
          <span className="gp-branch-name">{branchLabel}</span>
          <IconChevronDown size={12} />
        </button>
      )}
      {status?.head !== undefined && pane !== null && (
        <button type="button" className="ah-icon-btn gp-locate" aria-label={t('locateHead')} title={t('locateHead')}
          onClick={() => {
            pane.setView('graph')
            locateHead(repo.cwd)
          }}>
          <IconLocate size={15} />
        </button>
      )}
      <span className="gp-grow" />
      {status !== undefined && status.head !== undefined && (unpublished || status.upstream !== undefined) && (
        <button type="button" className="gp-sync" disabled={busy !== undefined}
          title={unpublished ? t('publish') : t(status.rewritten === true ? 'rewrittenTip' : 'syncTip', { ahead: status.ahead, behind: status.behind })}
          aria-label={unpublished ? t('publish') : t('sync')} onClick={() => void sync()}>
          {unpublished
            ? <><IconCloudUp size={15} />{pane !== null && pane.width >= 440 && <span>{t('publish')}</span>}</>
            : <>
              <IconSync size={14} className={busy === 'pull' || busy === 'push' || busy === 'fetch' ? 'gp-spin' : undefined} />
              {status.behind > 0 && <span className="gp-sync-n">{status.behind}↓</span>}
              {status.ahead > 0 && <span className="gp-sync-n">{status.ahead}↑</span>}
            </>}
        </button>
      )}
      {props.view === 'changes' && status !== undefined && <TreeToggle />}
      {props.console !== undefined && status !== undefined && (
        <button type="button" className="ah-icon-btn" aria-label={t('consoleToggle')} title={t('consoleToggle')} aria-pressed={props.console.open}
          onClick={props.console.toggle}>
          <IconTerminal size={15} />
        </button>
      )}
      {status !== undefined && (
        <button type="button" className="ah-icon-btn" aria-label={t('fetch')} title={t('fetchTip')} disabled={busy !== undefined}
          aria-busy={busy === 'fetch' || undefined} onClick={() => void repo.run({ op: 'fetch' }, { done: 'done.fetch' })}>
          <IconCloudDown size={15} className={busy === 'fetch' ? 'gp-pulse' : undefined} />
        </button>
      )}
      {status !== undefined && (
        <button type="button" className="ah-icon-btn" aria-label={t('more')} title={t('more')} aria-haspopup="menu" disabled={busy !== undefined}
          onClick={(event) => setMoreMenu({ x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect() })}>
          <IconMore size={15} />
        </button>
      )}
      <span className="gp-progress" aria-hidden="true" />
      {moreMenu !== undefined && pane !== null && (
        <Menu anchor={{ ...moreMenu, align: 'end' }} entries={moreEntries} label={t('more')} onClose={() => setMoreMenu(undefined)}
          onSelect={(id) => {
            setMoreMenu(undefined)
            if (id === 'pull') void repo.run({ op: 'pull' }, { done: 'done.pull' })
            else if (id === 'push') void repo.run({ op: 'push', setUpstream: status === undefined || !ownUpstream(status) }, { done: 'done.push' })
            else if (id === 'fetch') void repo.run({ op: 'fetch' }, { done: 'done.fetch' })
            else if (id === 'branch') createBranch(pane)
            else if (id === 'stash') stashDialog(pane)
            else runPush(id, pane)
          }} />
      )}
      {picker !== undefined && pane !== null && <BranchPicker rect={picker} onClose={() => setPicker(undefined)} />}
    </div>
  )
}

function usePaneSafe(): PaneApi | null {
  return useContext(PaneContext)
}

function BranchPicker(props: { rect: DOMRect; onClose: () => void }): ReactNode {
  const pane = usePaneSafe()!
  const { repo } = pane
  const refs = useRepo(repo, (state) => state.log?.refs)
  const branch = useRepo(repo, (state) => state.status?.branch)
  const elsewhere = useRepo(repo, (state) => state.trees?.list?.worktrees)
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const entries = useMemo<MenuEntry[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (name: string): boolean => q === '' || name.toLowerCase().includes(q)
    const heads = (refs ?? []).filter((ref) => ref.kind === 'head' && match(ref.name))
      .sort((a, b) => Number(b.name === branch) - Number(a.name === branch) || a.name.localeCompare(b.name))
    const localNames = new Set((refs ?? []).filter((ref) => ref.kind === 'head').map((ref) => ref.name))
    const remotes = (refs ?? []).filter((ref) => ref.kind === 'remote' && match(ref.name) && !localNames.has(ref.name.slice(ref.name.indexOf('/') + 1)))
      .sort((a, b) => a.name.localeCompare(b.name))
    const create: MenuEntry = { id: 'new', label: q !== '' ? `${t('newBranch').replace(/…$/, '')}「${query.trim()}」` : t('newBranch'), icon: <IconPlus size={14} /> }
    // Typing narrows to branches first, so Enter switches to the best match; creating comes last.
    const list: MenuEntry[] = q === '' ? [create] : []
    const inTree = new Set((elsewhere ?? []).filter((tree) => !tree.current && tree.branch !== undefined).map((tree) => tree.branch!))
    if (heads.length > 0) {
      list.push({ heading: t('branches') }, ...heads.map((ref) => inTree.has(ref.name)
        ? { id: `h:${ref.name}`, label: ref.name, icon: <IconWorktree size={14} />, hint: t('inTree') }
        : { id: `h:${ref.name}`, label: ref.name, checked: ref.name === branch, icon: <IconBranch size={14} /> }))
    }
    if (remotes.length > 0) list.push({ heading: t('remotes') }, ...remotes.slice(0, 200).map((ref) => ({ id: `r:${ref.name}`, label: ref.name, icon: <IconBranch size={14} /> })))
    if (refs === undefined) list.push({ heading: t('loading') })
    else if (heads.length + remotes.length === 0 && q !== '') list.push({ heading: t('noMatch') })
    if (q !== '') list.push({ separator: true }, create)
    return list
  }, [refs, branch, query, elsewhere])
  return (
    <Menu anchor={{ x: props.rect.left, y: props.rect.bottom, rect: props.rect }} entries={entries} label={t('searchBranch')} keepFocus
      className="gp-picker" onClose={props.onClose}
      top={<input ref={input} className="gp-input gp-picker-search" placeholder={t('searchBranch')} value={query} spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)} />}
      onSelect={(id) => {
        props.onClose()
        if (id === 'new') {
          const name = query.trim()
          if (name !== '') void repo.run({ op: 'branch-create', name, checkout: true }, { done: 'done.checkout', doneParams: { name } })
          else createBranch(pane)
        } else if (id.startsWith('h:')) {
          const name = id.slice(2)
          const tree = treeOf(pane, name)
          if (tree !== undefined) void openTree(pane, tree)
          else if (name !== branch) void repo.run({ op: 'checkout', ref: name, kind: 'branch' }, { done: 'done.checkout', doneParams: { name } })
        } else if (id.startsWith('r:')) {
          const name = id.slice(2)
          void repo.run({ op: 'checkout', ref: name, kind: 'remote' }, { done: 'done.checkout', doneParams: { name: name.slice(name.indexOf('/') + 1) } })
        }
      }} />
  )
}
