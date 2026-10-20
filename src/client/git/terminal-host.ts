/**
 * The git pane's terminals are DSH's own: the `webTerminals` service behind
 * the sidebar Terminal tab (@deepseek-ai/dsh-api-terminal-controller). Same
 * PTY, shells, permissions, per-Session limit and screen recovery; a reload
 * reattaches to the running processes. This module only remembers which
 * terminals the pane shows per worktree, and holds them the way open sidebar
 * tabs are held, so the host never counts them as abandoned (a held terminal
 * is never reclaimed; DSH reclaims only unheld ones idle for hours).
 *
 * The Sessions of one worktree share one list: a terminal opened in either
 * shows, and is driven, in both. DSH binds each process to the Session that
 * started it (its limit, its lifetime), so every entry keeps that Session and
 * every host call goes through it, whichever Session is on screen.
 *
 * The list is kept per browser, the processes on the host: a terminal opened on
 * another device (the phone, say) is taken in from the host's own list of the
 * worktree's Sessions (see `adopt`), as a tab of its own bound to that process.
 * Layout (order, splits, widths) stays each device's own.
 *
 * It also knows which terminals off screen are running a command, by DSH's own
 * activity probe (see `terminalActivity` on the host). Probing costs a process
 * table read on the host, so it is done only when needed: once when a terminal
 * leaves the screen (and once after load), then every few seconds for the ones
 * found busy, until they are not. A terminal on screen is never probed; one
 * that finished while away stays marked until it is shown again.
 */

export interface TerminalInfo {
  id: string
  title: string
  cols: number
  rows: number
  state: 'running' | 'exited' | 'failed'
  exitCode?: number | null
  error?: string
  controllerId?: string
}

/** A host terminal no view of this window shows yet. */
export interface HostTerminal {
  id: string
  state: TerminalInfo['state']
}

export type TerminalFrame =
  | { type: 'snapshot'; sequence: number; screen: string; info: TerminalInfo }
  | { type: 'output'; sequence: number; data: string }
  | { type: 'state'; info: TerminalInfo }

export interface TerminalState {
  phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closing' | 'closed'
  writable: boolean
  info?: TerminalInfo
  environment?: { maxCols: number; maxRows: number; scrollback: number; maxInputBytes: number }
  title?: string
  render?: { revision: number; frame: Exclude<TerminalFrame, { type: 'state' }> }
  /** Locale key of a known failure (`missingTerminal`, `terminalLimit`, …). */
  issue?: string
  error?: string
}

export interface TerminalView {
  readonly id: string
  readonly state: { getSnapshot(): TerminalState; subscribe(listener: () => void): () => void }
  mount(): () => void
  refresh(): Promise<void>
  connect(): void
  acknowledge(revision: number): void
  write(data: string): void
  resize(cols: number, rows: number): void
  rename(title: string): Promise<void>
}

/** One entry of the sidebar's open-tab inventory, the host's list of held terminals. */
export interface HoldTab {
  sessionId: string
  tabId: string
  kind: string
  contentId: string
}

export interface Shell {
  path: string
  name: string
}

/** The host service, as far as the pane uses it. */
export interface WebTerminals {
  view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): TerminalView
  launchShells(sessionId: string, signal: AbortSignal): Promise<{ shells: Shell[]; selectedShell?: string }>
  selectShell(path: string): void
  close(sessionId: string, key: string, contentId: string, terminalId?: string): void
  retainTabs(tabs: HoldTab[]): void
  openTabs?: HoldTab[]
  /** The Session's host terminals without a view in this window or a pending close. */
  recover?(sessionId: string): Promise<HostTerminal[]>
}

export interface TerminalEntry {
  /** The Session that started it: the host binds the process to it. */
  sessionId: string
  /** View key inside the host service; prefixed so it never meets a sidebar tab id. */
  key: string
  /** Content identity the host binds to its process (persisted by the host). */
  contentId: string
  /** Shell chosen for a new terminal; ignored once the process exists. */
  shellPath?: string
  /** The host terminal it was taken in for (see `adopt`): opened elsewhere, so this browser has no binding of its own. */
  terminalId?: string
  /** Split into another tab, beside its other panes: that tab's first pane. Absent on a tab's own first pane. */
  parent?: string
  /** Share of its tab's width (flex weight); absent: 1. */
  weight?: number
}

/**
 * A tab is its first pane followed by the panes split into it, kept together in this order:
 * `[tab, …its panes, next tab, …]`. `active` is the focused pane, whose tab is the selected one.
 */
export interface TerminalTabs {
  list: TerminalEntry[]
  active?: string
}

/** One tab: its panes left to right, the first being the tab's own entry. */
export interface TerminalGroup {
  root: TerminalEntry
  panes: TerminalEntry[]
}

/** Panes per tab, as in VS Code's practice: beyond this each is too narrow to use. */
export const MAX_PANES = 4

/** The tabs of a list, each with its panes. */
export function groupsOf(list: readonly TerminalEntry[]): TerminalGroup[] {
  const groups: TerminalGroup[] = []
  const byRoot = new Map<string, TerminalGroup>()
  for (const entry of list) {
    const group = entry.parent === undefined ? undefined : byRoot.get(entry.parent)
    if (group !== undefined) {
      group.panes.push(entry)
      continue
    }
    const created = { root: entry, panes: [entry] }
    byRoot.set(entry.key, created)
    groups.push(created)
  }
  return groups
}

/**
 * Every pane after its tab's first, every tab whole: a pane whose tab's first pane is gone
 * takes its place (the first such pane becomes the tab, the rest follow it).
 */
function normalize(list: readonly TerminalEntry[]): TerminalEntry[] {
  const roots = new Set<string>()
  const heirs = new Map<string, string>()
  return list.map((entry) => {
    const parent = entry.parent === undefined ? undefined : roots.has(entry.parent) ? entry.parent : heirs.get(entry.parent)
    if (parent === entry.parent && parent !== undefined) return entry
    if (parent !== undefined) return { ...entry, parent }
    if (entry.parent !== undefined) heirs.set(entry.parent, entry.key)
    roots.add(entry.key)
    if (entry.parent === undefined) return entry
    const { parent: _gone, ...rest } = entry
    return rest
  })
}

/** Off screen: running a command, or finished since last shown. */
export type TerminalMark = 'busy' | 'done'

/** DSH's activity probe through the host: terminal id → `busy` | `idle` | `unknown`. */
export type ActivityProbe = (sessionId: string, ids: string[]) => Promise<Record<string, string>>

/** Terminals that finished off screen together, one Session at a time. */
export interface DoneNotice {
  sessionId: string
  keys: string[]
}

const PREFIX = 'dsh-agent-hub.git.terminals.v2.'
/** Lists of the time before sharing, one per Session; folded into their worktree's once it is known. */
const LEGACY_PREFIX = 'dsh-agent-hub.git.terminals.v1.'
const DRAWER_KEY = 'dsh-agent-hub.git.terminals.drawer.v1'
const EMPTY: TerminalTabs = { list: [] }
/** How often a busy terminal is looked at again. */
const POLL_MS = 4000
/** A terminal leaving the screen is looked at after this long, so a command just entered has started. */
const SETTLE_MS = 800
/** The first look after load, out of the way of the page's own start. */
const START_MS = 2500
/** Sessions whose drawer state is remembered. */
const DRAWER_MAX = 200

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** @param owner - the Session of a legacy list, whose entries do not name it. */
function read(key: string, owner?: string): TerminalTabs | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as TerminalTabs | null
    if (parsed === null || !Array.isArray(parsed.list)) return undefined
    const valid = parsed.list
      .map((entry) => (owner === undefined ? entry : { ...entry, sessionId: owner }))
      .filter((entry) => typeof entry?.key === 'string' && typeof entry.contentId === 'string' && typeof entry.sessionId === 'string')
    const list = normalize(groupsOf(valid).flatMap((group) => group.panes))
    return { list, ...(typeof parsed.active === 'string' && list.some((entry) => entry.key === parsed.active) ? { active: parsed.active } : {}) }
  } catch {
    return undefined
  }
}

/** A terminal with nothing left to show: its process is gone, ended or never started. */
export function ended(state: TerminalState): boolean {
  return state.issue === 'missingTerminal' || state.info?.state === 'exited' || state.info?.state === 'failed' || state.phase === 'closed'
}

export class GitTerminals {
  /** Per worktree (see `group`). */
  private readonly groups = new Map<string, TerminalTabs>()
  /** Legacy per-Session lists whose worktree is not known yet; held all the same. */
  private readonly legacy = new Map<string, TerminalTabs>()
  private readonly worktreeOf: ((sessionId: string) => string | undefined) | undefined
  private readonly sessionIds: (() => Iterable<string>) | undefined
  /** Per list key, the `adopt` under way. */
  private readonly adopting = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private sidebarTabs: HoldTab[]
  private readonly unpatch: () => void
  readonly host: WebTerminals
  private readonly probe: ActivityProbe | undefined
  /** Per entry key; replaced, never mutated, so a snapshot read stays stable. */
  private markMap: ReadonlyMap<string, TerminalMark> = new Map()
  /** Entry keys on screen, with how many screens show each. */
  private readonly shown = new Map<string, number>()
  /** Entry keys to look at on the next probe. */
  private readonly watch = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private due = 0
  private probing = false
  private readonly doneListeners = new Set<(notice: DoneNotice) => void>()
  /** Whether each Session's terminal panel is open; absent: the legacy pane-wide flag decides. */
  private drawers: Record<string, boolean>
  /** The pane last focused in each tab, by its first pane's key; the tab shows it when selected again. */
  private readonly focus = new Map<string, string>()
  private readonly onVisible = (): void => { if (!pageHidden() && this.watch.size > 0) this.schedule(0) }

  /**
   * @param probe - DSH's activity probe; without it nothing is marked.
   * @param worktreeOf - a Session's folder; without it (or before it is known) a Session keeps a list of its own.
   * @param sessionIds - every known Session, for the terminals of a worktree's other Sessions (see `adopt`).
   */
  constructor(host: WebTerminals, probe?: ActivityProbe, worktreeOf?: (sessionId: string) => string | undefined, sessionIds?: () => Iterable<string>) {
    this.host = host
    this.probe = probe
    this.worktreeOf = worktreeOf
    this.sessionIds = sessionIds
    this.drawers = readDrawers()
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(PREFIX)) {
          const tabs = read(key)
          if (tabs !== undefined && tabs.list.length > 0) this.groups.set(key.slice(PREFIX.length), tabs)
        } else if (key?.startsWith(LEGACY_PREFIX)) {
          const sessionId = key.slice(LEGACY_PREFIX.length)
          const tabs = read(key, sessionId)
          if (tabs !== undefined && tabs.list.length > 0) this.legacy.set(sessionId, tabs)
        }
      }
    } catch {
      // Nothing restored.
    }
    // The host holds exactly the terminals in the list the sidebar hands it, and the
    // sidebar replaces that list on every layout change. Ours ride along with it.
    this.sidebarTabs = host.openTabs ?? []
    const original = host.retainTabs
    const patched = (tabs: HoldTab[]): void => {
      this.sidebarTabs = tabs
      original.call(host, [...tabs, ...this.holds()])
    }
    try {
      host.retainTabs = patched
    } catch {
      // Not patchable: the pane's terminals then live under the host's idle reclamation only.
    }
    this.unpatch = () => {
      if (host.retainTabs !== patched) return
      try {
        host.retainTabs = original
        original.call(host, this.sidebarTabs)
      } catch {
        // Already gone with the host.
      }
    }
    this.syncHolds()
    // Commands may have been running before this page loaded.
    if (probe !== undefined) {
      for (const tabs of [...this.groups.values(), ...this.legacy.values()]) for (const entry of tabs.list) this.watch.add(entry.key)
      if (this.watch.size > 0) this.schedule(START_MS)
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible)
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The terminals of the Session's worktree, the selected one shared by all its Sessions. */
  tabs(sessionId: string): TerminalTabs {
    return this.groups.get(this.group(sessionId)) ?? EMPTY
  }

  view(entry: TerminalEntry): TerminalView {
    return this.host.view(entry.sessionId, entry.key, entry.contentId, entry.terminalId, entry.shellPath)
  }

  /** A new terminal of this Session, selected in its worktree. */
  open(sessionId: string, shellPath?: string): TerminalEntry {
    const id = uuid()
    const entry: TerminalEntry = { sessionId, key: `dsh-agent-hub.git:${id}`, contentId: `dsh-agent-hub.git-terminal:${id}`, ...(shellPath ? { shellPath } : {}) }
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    this.set(group, { list: [...tabs.list, entry], active: entry.key })
    return entry
  }

  /**
   * Focus a pane. A tab's first pane stands for the whole tab: selecting it brings back the
   * pane last focused there, and leaves the focus alone when it is already in that tab.
   */
  select(sessionId: string, key: string): void {
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    const target = groupsOf(tabs.list).find((item) => item.panes.some((pane) => pane.key === key))
    if (target === undefined) return
    let next = key
    if (key === target.root.key) {
      if (target.panes.some((pane) => pane.key === tabs.active)) return
      const last = this.focus.get(key)
      if (last !== undefined && target.panes.some((pane) => pane.key === last)) next = last
    }
    if (tabs.active !== next) this.set(group, { ...tabs, active: next })
  }

  /** The pane a tab shows when selected: the one focused last. */
  focused(tabs: Pick<TerminalTabs, 'active'>, group: TerminalGroup): TerminalEntry {
    const key = group.panes.some((pane) => pane.key === tabs.active) ? tabs.active : this.focus.get(group.root.key)
    return group.panes.find((pane) => pane.key === key) ?? group.root
  }

  /** Moves a whole tab (by its first pane) before another, or to the end. */
  move(sessionId: string, key: string, before: string | undefined): void {
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    if (key === before) return
    const groups = groupsOf(tabs.list)
    const moving = groups.find((item) => item.root.key === key)
    if (moving === undefined) return
    const rest = groups.filter((item) => item !== moving)
    const at = before === undefined ? rest.length : rest.findIndex((item) => item.root.key === before)
    rest.splice(at < 0 ? rest.length : at, 0, moving)
    this.set(group, { ...tabs, list: rest.flatMap((item) => item.panes) })
  }

  /**
   * A new terminal split beside a pane (the focused one by default), in the same shell, and
   * focused; undefined when that tab is full.
   */
  split(sessionId: string, beside?: string): TerminalEntry | undefined {
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    const key = beside ?? tabs.active ?? tabs.list[0]?.key
    const source = tabs.list.find((entry) => entry.key === key)
    if (source === undefined) return undefined
    const root = source.parent ?? source.key
    const panes = tabs.list.filter((entry) => entry.key === root || entry.parent === root)
    if (panes.length >= MAX_PANES) return undefined
    const id = uuid()
    // Panes resized by hand: the new one takes half of the pane it splits, the others keep their
    // widths. Otherwise all stay equal, as in VS Code.
    const half = panes.some((entry) => entry.weight !== undefined) ? (source.weight ?? 1) / 2 : undefined
    const entry: TerminalEntry = {
      sessionId, key: `dsh-agent-hub.git:${id}`, contentId: `dsh-agent-hub.git-terminal:${id}`, parent: root,
      ...(source.shellPath ? { shellPath: source.shellPath } : {}),
      ...(half === undefined ? {} : { weight: half }),
    }
    const list = tabs.list.flatMap((item) => (item.key !== source.key ? [item] : [half === undefined ? item : { ...item, weight: half }, entry]))
    this.set(group, { list, active: entry.key })
    return entry
  }

  /** The panes' widths, by key (flex weights); the others keep theirs. */
  resize(sessionId: string, weights: Readonly<Record<string, number>>): void {
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    let changed = false
    const list = tabs.list.map((entry) => {
      const weight = weights[entry.key]
      if (weight === undefined || !(weight > 0) || weight === (entry.weight ?? 1)) return entry
      changed = true
      return { ...entry, weight }
    })
    if (changed) this.set(group, { ...tabs, list })
  }

  /** Back to equal widths across a tab. */
  evenOut(sessionId: string, root: string): void {
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    if (!tabs.list.some((entry) => (entry.key === root || entry.parent === root) && entry.weight !== undefined)) return
    const list = tabs.list.map((entry) => {
      if ((entry.key !== root && entry.parent !== root) || entry.weight === undefined) return entry
      const { weight: _weight, ...rest } = entry
      return rest
    })
    this.set(group, { ...tabs, list })
  }

  /**
   * Ends one pane's process (in the background, retried by the host) and drops it. The last pane
   * of a tab takes the tab with it; a tab's first pane hands the tab to the next.
   */
  close(sessionId: string, key: string): void {
    this.drop(sessionId, [key])
  }

  /** Ends every pane of a tab, by any of its panes. */
  closeTab(sessionId: string, key: string): void {
    const target = groupsOf(this.tabs(sessionId).list).find((item) => item.panes.some((pane) => pane.key === key))
    if (target !== undefined) this.drop(sessionId, target.panes.map((pane) => pane.key))
  }

  private drop(sessionId: string, keys: readonly string[]): void {
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    const gone = new Set(keys.filter((key) => tabs.list.some((entry) => entry.key === key)))
    if (gone.size === 0) return
    const list = normalize(tabs.list.filter((entry) => !gone.has(entry.key)))
    const active = tabs.active !== undefined && gone.has(tabs.active) ? this.successor(tabs, gone, list) : tabs.active
    this.forget(gone)
    this.set(group, { list, ...(active === undefined ? {} : { active }) })
    for (const entry of tabs.list) if (gone.has(entry.key)) this.host.close(entry.sessionId, entry.key, entry.contentId, entry.terminalId)
  }

  /**
   * Who takes the focus from a closed pane, as in VS Code: the pane to its right in the same
   * tab, else to its left; with the tab gone, the tab to the right, else to the left.
   */
  private successor(tabs: TerminalTabs, gone: ReadonlySet<string>, list: readonly TerminalEntry[]): string | undefined {
    const before = groupsOf(tabs.list)
    const index = before.findIndex((item) => item.panes.some((pane) => pane.key === tabs.active))
    const own = before[index]
    if (own === undefined) return list[0]?.key
    const at = own.panes.findIndex((pane) => pane.key === tabs.active)
    const pane = [...own.panes.slice(at + 1), ...own.panes.slice(0, at).reverse()].find((item) => !gone.has(item.key))
    if (pane !== undefined) return pane.key
    const next = [...before.slice(index + 1), ...before.slice(0, index).reverse()]
      .find((item) => item.panes.some((entry) => !gone.has(entry.key)))
    if (next === undefined) return undefined
    const keys = new Set(next.panes.map((entry) => entry.key))
    const after = groupsOf(list).find((item) => item.panes.some((entry) => keys.has(entry.key)))
    return after === undefined ? undefined : this.focused({}, after).key
  }

  /**
   * Drop the tabs whose process is gone. Each listed terminal is looked up once (the host
   * never starts a shell for a listed one; a missing process reports `missingTerminal`).
   * Resolves once the dead ones are closed.
   */
  async prune(sessionId: string): Promise<void> {
    const list = this.tabs(sessionId).list
    const dead = await Promise.all(list.map(async (entry) => {
      const view = this.view(entry)
      const before = view.state.getSnapshot()
      if (before.info === undefined && before.issue === undefined) await view.refresh().catch(() => {})
      return ended(view.state.getSnapshot()) ? entry.key : undefined
    }))
    const gone = new Set(dead.filter((key): key is string => key !== undefined))
    if (gone.size === 0) return
    // One update for all of them: one write, one hold sync, one re-render.
    const group = this.group(sessionId)
    const tabs = this.groups.get(group) ?? EMPTY
    const kept = normalize(tabs.list.filter((entry) => !gone.has(entry.key)))
    const active = tabs.active !== undefined && !gone.has(tabs.active) ? tabs.active : this.successor(tabs, gone, kept)
    this.forget(gone)
    this.set(group, { list: kept, ...(active === undefined ? {} : { active }) })
    for (const entry of tabs.list) if (gone.has(entry.key)) this.host.close(entry.sessionId, entry.key, entry.contentId, entry.terminalId)
  }

  /**
   * Take in the running terminals of the worktree's Sessions that no tab shows: ones opened on
   * another device, whose list this browser never saw. Each comes in as a tab of its own at the
   * end, bound to its host terminal, so nothing new starts. One lookup per Session; a Session
   * that cannot be asked is skipped. Calls made while one is under way share it.
   */
  adopt(sessionId: string): Promise<void> {
    const group = this.group(sessionId)
    const recover = this.host.recover
    if (recover === undefined) return Promise.resolve()
    const running = this.adopting.get(group)
    if (running !== undefined) return running
    const owners = new Set([sessionId])
    for (const id of this.sessionIds?.() ?? []) if (this.group(id) === group) owners.add(id)
    // Views for the listed ones first: the host leaves out what a view of this window shows.
    const known = new Set((this.groups.get(group) ?? EMPTY).list.map((entry) => this.view(entry).id))
    const task = Promise.all([...owners].map(async (owner) => {
      const found = await recover.call(this.host, owner).catch(() => [])
      return found.filter((info) => info.state === 'running' && !known.has(info.id)).map((info) => ({ owner, id: info.id }))
    })).then((results) => {
      const tabs = this.groups.get(group) ?? EMPTY
      // Taken in meanwhile (or listed since): not twice.
      const listed = new Set(tabs.list.map((entry) => entry.terminalId).filter((id) => id !== undefined))
      const fresh = results.flat().filter((item) => !listed.has(item.id)).map(({ owner, id }): TerminalEntry => {
        const local = uuid()
        return { sessionId: owner, key: `dsh-agent-hub.git:${local}`, contentId: `dsh-agent-hub.git-terminal:${local}`, terminalId: id }
      })
      if (fresh.length === 0) return
      const active = tabs.active ?? fresh[0]!.key
      this.set(group, { list: [...tabs.list, ...fresh], active })
      // Commands may be running in them: off screen, they are marked like any other.
      if (this.probe !== undefined) {
        for (const entry of fresh) this.watch.add(entry.key)
        this.schedule(SETTLE_MS)
      }
    }).finally(() => { this.adopting.delete(group) })
    this.adopting.set(group, task)
    return task
  }

  shells(sessionId: string, signal: AbortSignal): Promise<{ shells: Shell[]; selectedShell?: string }> {
    return this.host.launchShells(sessionId, signal)
  }

  /** The marks of off-screen terminals, by entry key. */
  marks(): ReadonlyMap<string, TerminalMark> {
    return this.markMap
  }

  /** The off-screen terminals of a Session's worktree: how many run a command, how many finished unseen. */
  sessionMarks(sessionId: string): { busy: number; done: number } {
    return this.marksIn([sessionId])
  }

  /** The same over the worktrees of these Sessions and folders (a sidebar workspace), each counted once. */
  marksIn(sessionIds: Iterable<string>, folders: Iterable<string | undefined> = []): { busy: number; done: number } {
    let busy = 0
    let done = 0
    if (this.markMap.size === 0) return { busy, done }
    const groups = new Set<string>()
    for (const sessionId of sessionIds) groups.add(this.group(sessionId))
    for (const dir of folders) {
      const key = folder(dir)
      if (key !== undefined) groups.add(key)
    }
    for (const group of groups) {
      for (const entry of this.groups.get(group)?.list ?? []) {
        const mark = this.markMap.get(entry.key)
        if (mark === 'busy') busy++
        else if (mark === 'done') done++
      }
    }
    return { busy, done }
  }

  /**
   * A screen shows this terminal until the returned release: it is seen (its mark goes),
   * and is not probed. Once no screen shows it, it is looked at again.
   */
  show(key: string): () => void {
    this.shown.set(key, (this.shown.get(key) ?? 0) + 1)
    this.watch.delete(key)
    if (this.markMap.has(key)) {
      this.forget([key])
      this.emit()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.shown.get(key) ?? 1) - 1
      if (count > 0) {
        this.shown.set(key, count)
        return
      }
      this.shown.delete(key)
      if (this.probe === undefined || this.locate(key) === undefined) return
      this.watch.add(key)
      this.schedule(SETTLE_MS)
    }
  }

  /** Called with the terminals that finished off screen; returns the unsubscribe. */
  onDone(listener: (notice: DoneNotice) => void): () => void {
    this.doneListeners.add(listener)
    return () => { this.doneListeners.delete(listener) }
  }

  /** Whether the Session's terminal panel is open; `fallback` when it was never set. */
  drawer(sessionId: string, fallback: boolean): boolean {
    return this.drawers[sessionId] ?? fallback
  }

  setDrawer(sessionId: string, open: boolean): void {
    if (this.drawers[sessionId] === open) return
    const { [sessionId]: _previous, ...rest } = this.drawers
    const ids = Object.keys(rest)
    // Oldest first (insertion order): drop the oldest beyond the cap.
    for (const id of ids.slice(0, Math.max(0, ids.length - DRAWER_MAX + 1))) delete rest[id]
    this.drawers = { ...rest, [sessionId]: open }
    try {
      localStorage.setItem(DRAWER_KEY, JSON.stringify(this.drawers))
    } catch {
      // Not persisted: holds until reload.
    }
    this.emit()
  }

  /** Make a terminal the Session's selected one with its panel open (shown once the pane is). */
  reveal(sessionId: string, key: string): void {
    this.select(sessionId, key)
    this.setDrawer(sessionId, true)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.watch.clear()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible)
    this.unpatch()
    this.listeners.clear()
    this.doneListeners.clear()
  }

  /**
   * The list a Session's terminals go in: its worktree's, else (folder not known) its own.
   * Legacy lists are folded in here, as soon as their Session's folder is known. Quietly:
   * this runs inside reads, and nothing held or shown changes, only where it is kept.
   */
  private group(sessionId: string): string {
    if (this.legacy.size > 0 && this.worktreeOf !== undefined) {
      for (const [owner, tabs] of [...this.legacy]) {
        const dir = folder(this.worktreeOf(owner))
        if (dir === undefined) continue
        this.legacy.delete(owner)
        const into = this.groups.get(dir)
        const fresh = tabs.list.filter((entry) => !into?.list.some((item) => item.key === entry.key))
        const active = into?.active ?? tabs.active
        this.store(dir, { list: [...(into?.list ?? []), ...fresh], ...(active === undefined ? {} : { active }) })
        try {
          localStorage.removeItem(LEGACY_PREFIX + owner)
        } catch {
          // Folded again next load; the keys already there are skipped.
        }
      }
    }
    return folder(this.worktreeOf?.(sessionId)) ?? sessionId
  }

  private locate(key: string): TerminalEntry | undefined {
    for (const tabs of [...this.groups.values(), ...this.legacy.values()]) {
      const entry = tabs.list.find((item) => item.key === key)
      if (entry !== undefined) return entry
    }
    return undefined
  }

  private forget(keys: Iterable<string>): void {
    let next: Map<string, TerminalMark> | undefined
    for (const key of keys) {
      this.watch.delete(key)
      if (!this.markMap.has(key)) continue
      next ??= new Map(this.markMap)
      next.delete(key)
    }
    if (next !== undefined) this.markMap = next
  }

  /** Look within `delay`; an earlier pending look stands. */
  private schedule(delay: number): void {
    if (this.probe === undefined) return
    const due = Date.now() + delay
    if (this.timer !== undefined && this.due <= due) return
    clearTimeout(this.timer)
    this.due = due
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.look()
    }, delay)
  }

  /** One probe of every watched terminal, one request per Session. */
  private async look(): Promise<void> {
    const probe = this.probe
    if (probe === undefined) return
    if (this.probing) {
      this.schedule(SETTLE_MS)
      return
    }
    // A hidden page waits: it looks again the moment it is shown.
    if (pageHidden()) return
    this.probing = true
    const finished: DoneNotice[] = []
    let next: Map<string, TerminalMark> | undefined
    const update = (key: string, mark: TerminalMark | undefined): void => {
      if (this.markMap.get(key) === mark) return
      next ??= new Map(this.markMap)
      if (mark === undefined) next.delete(key)
      else next.set(key, mark)
    }
    try {
      // The host knows a process by the Session that started it.
      const bySession = new Map<string, TerminalEntry[]>()
      for (const key of [...this.watch]) {
        const entry = this.locate(key)
        if (entry === undefined || this.shown.has(key)) {
          this.watch.delete(key)
          continue
        }
        bySession.set(entry.sessionId, [...(bySession.get(entry.sessionId) ?? []), entry])
      }
      await Promise.all([...bySession].map(async ([sessionId, entries]) => {
        const ids = entries.map((entry) => this.view(entry).id)
        let states: Record<string, string>
        try {
          states = await probe(sessionId, ids)
        } catch {
          // Not answered: the ones not known busy are dropped, the busy ones asked again.
          for (const entry of entries) if (this.markMap.get(entry.key) !== 'busy') this.watch.delete(entry.key)
          return
        }
        const done: string[] = []
        entries.forEach((entry, i) => {
          // Shown or closed while the probe was out: the screen owns it now.
          if (this.shown.has(entry.key) || this.locate(entry.key) === undefined) return
          if (states[ids[i]!] === 'busy') {
            update(entry.key, 'busy')
            return
          }
          this.watch.delete(entry.key)
          if (this.markMap.get(entry.key) === 'busy') {
            update(entry.key, 'done')
            done.push(entry.key)
          }
        })
        if (done.length > 0) finished.push({ sessionId, keys: done })
      }))
    } finally {
      this.probing = false
    }
    if (next !== undefined) {
      this.markMap = next
      this.emit()
    }
    for (const notice of finished) for (const listener of this.doneListeners) listener(notice)
    if (this.watch.size > 0) this.schedule(POLL_MS)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private holds(): HoldTab[] {
    return [...this.groups.values(), ...this.legacy.values()].flatMap((tabs) =>
      tabs.list.map((entry) => ({ sessionId: entry.sessionId, tabId: entry.key, kind: 'terminal', contentId: entry.contentId })))
  }

  private syncHolds(): void {
    try {
      this.host.retainTabs(this.sidebarTabs)
    } catch {
      // The host is going away.
    }
  }

  /** @param group - the list's key (see `group`). */
  private set(group: string, tabs: TerminalTabs): void {
    const active = tabs.list.find((entry) => entry.key === tabs.active)
    if (active !== undefined) this.focus.set(active.parent ?? active.key, active.key)
    this.store(group, tabs)
    this.syncHolds()
    this.emit()
  }

  private store(group: string, tabs: TerminalTabs): void {
    if (tabs.list.length === 0) this.groups.delete(group)
    else this.groups.set(group, tabs)
    try {
      if (tabs.list.length === 0) localStorage.removeItem(PREFIX + group)
      else localStorage.setItem(PREFIX + group, JSON.stringify(tabs))
    } catch {
      // Not persisted: the tabs last until reload.
    }
  }
}

/** A Session folder as a list key: one spelling per folder. */
function folder(dir: string | undefined): string | undefined {
  const path = dir?.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
  return path === undefined || path === '' ? undefined : path
}

const svg = (body: string): string => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`)}")`
/** `>` and `_`, two mask layers so the caret can blink on its own. */
const CHEVRON = svg('<path d="M3.2 4.2 7 8l-3.8 3.8" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')
const CARET = svg('<rect x="8.4" y="10.9" width="5.2" height="1.7" rx=".85"/>')

/**
 * The terminal mark, one look everywhere: `>_` with a blinking caret while a command runs,
 * steady in the accent color once it finished unseen. Used by the workspace rows and the
 * panel's tabs.
 */
const MARK_CSS = `
.ah-term-mark {
  flex: none; display: inline-block; width: 14px; height: 14px; vertical-align: middle;
  color: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 55%, transparent)); background-color: currentColor;
  -webkit-mask: ${CHEVRON} center / 100% 100% no-repeat, ${CARET} center / 100% 100% no-repeat;
  mask: ${CHEVRON} center / 100% 100% no-repeat, ${CARET} center / 100% 100% no-repeat;
}
.ah-term-mark[data-mark="busy"] { color: var(--dsw-alias-label-secondary, currentColor); animation: ah-term-caret 1.2s steps(1, end) infinite; }
.ah-term-mark[data-mark="done"] { color: var(--dsw-alias-state-business-primary, #3e7cf0); }
@keyframes ah-term-caret {
  50% { -webkit-mask-size: 100% 100%, 0 0; mask-size: 100% 100%, 0 0; }
}
@media (prefers-reduced-motion: reduce) { .ah-term-mark[data-mark="busy"] { animation: none; } }
`

/**
 * The terminal mark's look, for the panel's tabs and the left sidebar's workspace rows (see
 * repos/sidebar.ts). Session rows carry no mark: a worktree's terminals show on its workspace row.
 */
export function addTerminalMarkStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub'
  style.dataset.pluginCss = 'dsh-agent-hub/terminal-marks'
  style.textContent = MARK_CSS
  document.head.appendChild(style)
  return () => style.remove()
}

const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden

function readDrawers(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAWER_KEY) ?? '{}') as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean'))
  } catch {
    return {}
  }
}
