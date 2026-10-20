/**
 * The left sidebar's 按工作区树 view, nested by repository as well as by
 * folder. DSH's own tree view puts a workspace under the nearest registered
 * folder containing it, so a worktree in `<repo>/.worktrees/` nests by
 * itself, while one living elsewhere (`<repo>.wt/<branch>`, made by hand or
 * by an older version) stays a sibling of its repository. This layer lets git
 * decide instead: in the tree view, every worktree of a registered repository
 * shows under the repository, where DSH puts child workspaces (after the
 * repository's row, before its own sessions), indented one level, titled by
 * branch, and folding with it.
 *
 * The repository's own sessions are gathered under a row named `root`, a
 * sibling of its worktrees (the first one), so the main tree reads as one
 * worktree among the others instead of mixing its sessions with theirs.
 * `root` folds on its own; its fold is remembered per repository. While it
 * shows, the repository row's actions (its menu and new-session button) move
 * onto `root`, the row whose sessions they make, and move back when it goes.
 *
 * A repository's worktrees show as one run in DSH's own workspace order, wherever their folders
 * are, and move among themselves by our drag (`reorder.ts`, mouse, touch and keyboard), which
 * sets that order; DSH's drag stays on every other row.
 *
 * In every view, each workspace row (and `root`) shows on its title's line how many sessions
 * it holds and, by a dot, whether one waits on the person, runs, or finished unseen; in the
 * tree view a repository's row speaks for its worktrees too. Its terminals (the Git pane's)
 * running a command off screen, or finished unseen, show at the row's end by the same mark
 * the Git pane's terminal tabs carry, counted the same way (session rows carry none).
 *
 * In the tree view, each row of a repository's working tree shows its checked-out branch on the
 * title's line, as a chip: the repository's row (for its main tree), or `root` while that shows,
 * and every worktree's row unless its title already is the branch. A long branch gives up its
 * prefix (`feature/`) before its last segment, and a narrow sidebar keeps only the chip's icon;
 * the full name is the chip's tooltip. Branches are read again now and then, and when the page
 * comes back into view.
 *
 * Only the tree view changes. 按工作区 and the flat list stay exactly as DSH
 * draws them, so the two views keep their meaning: one row per workspace, or
 * a hierarchy.
 *
 * Nothing in DSH's DOM is removed, nothing but those actions is moved, and the only element added is the
 * `root` row (a copy of the repository's row, ours to remove): the repository's section
 * is laid out with `display: contents` inside a column flex list, and CSS
 * `order` places the adopted sections (and those of DSH's own child groups, likewise laid out
 * as contents); DSH's own indent variable indents
 * them. A title is shortened in place and restored when the view changes.
 * A list that is not drawn the expected way is left alone.
 */

import type { RepoGroup } from '../../repos/types.ts'
import { merge, tally, type ActivityStore, type Tally, type WorkspaceItem } from './activity.ts'
import type { ReposStore } from './api.ts'
import { follow } from '../dom.ts'
import { reorderWorktrees } from './reorder.ts'

const ROW = '[data-row-key^="workspace:"]'
/** A row's hover actions (its menu and new-session button). */
const ACTIONS = '[class*="rowActions"]'
/** A workspace row's label line (DSH's `projectText`). */
const TEXT = '[class*="projectText"]'
const SECTION = '[style*="--dsh-workspace-indent"]'
/** A workspace row's leading folder icon. */
const FOLDER = '[class*="folder"]'
/** The session row that is open. */
const CURRENT = '[class*="sessionRow"][class*="selected"]'
/** The workspace list's root: its tree, else the left sidebar. */
const ROOT = '[role="tree"], [data-pane="sidebar"], [class*="sidebarCol"]'
/** DSH's persisted workspace-browser view (ui-workspace's `dsh.workspace.view.v5` store). */
const VIEW_KEY = 'dsh.workspace.view.v5'
export const TREE_VIEW = 'workspace-tree'
/** DSH indents each tree level by this much. */
const LEVEL_PX = 12
/** The row that gathers a repository's own sessions, among its worktrees. */
const ROOT_TITLE = 'root'
/** The repositories whose `root` row is folded, by main workspace id. */
const FOLD_KEY = 'dsh-agent-hub.repos.rootFolded'
/** How often the branches are read again while the tree view shows (a checkout elsewhere). */
const BRANCH_MS = 15_000
const BRANCH = 'ah-branch'
/** A git branch: two commits and a fork, as a mask. */
const BRANCH_ICON = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="4.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 6.2c0 2.6-2.2 3.3-4.6 3.8-1.3.3-2.4.6-2.4 1"/></svg>')}")`

const CSS = `
[data-ah-list] { display: flex; flex-direction: column; }
[data-ah-head], [data-ah-group] { display: contents; }
/* A head laid out as contents loses its own top gap; its row keeps it. */
[data-ah-list] > [data-ah-head]:not(:first-child) > :first-child { margin-top: 4px; }
[data-ah-child], [data-ah-rooted], [data-ah-root] { --dsh-workspace-indent: var(--ah-indent, ${LEVEL_PX}px) !important; }
[data-ah-hidden] { display: none !important; }
/* Laid out in our column, items keep DSH's sizes (a long list would squeeze them), and root
   and every worktree keep the gap DSH puts between sibling workspaces, wherever they came from. */
[data-ah-ordered] { flex-shrink: 0; }
[data-ah-root], [data-ah-group] > [data-ah-ordered], [data-ah-child] { margin-top: 4px !important; }
/* The head's actions, lent to its root row, stay shown while their menu is open. */
[data-ah-head]:has(> [data-row-key][class*="menuOpen"], > * > [data-row-key][class*="menuOpen"]) > [data-ah-root] > [data-ah-lent] { display: inline-flex; }
/* root's folder, highlighted as DSH highlights a workspace holding the open session; its short
   title never gives way to the chip beside it. */
[data-ah-root] > [data-ah-active] { color: var(--dsw-alias-state-business-primary); }
[data-ah-root] ${TEXT} > [class*="title"] { flex-shrink: 0; }
/* A row's sessions: a state dot and a count, on the title's line, right after it. */
[data-ah-count], [data-ah-state], [data-ah-branch] { flex-direction: row !important; align-items: center; }
[data-ah-count] > *, [data-ah-state] > *, [data-ah-branch] > * { flex: 0 1 auto !important; }
/* The branch chip, between the title and the sessions: it gives way before the title does. */
[data-ah-branch] { container-type: inline-size; }
[data-ah-branch] > .${BRANCH} {
  flex: 0 3 auto !important; display: inline-flex; align-items: center; box-sizing: border-box;
  min-width: calc(23px + 2.4em); max-width: 45%; height: 16px; margin: 0 6px 0 4px; padding: 0 5px; overflow: hidden;
  border-radius: var(--dsw-radius-xs, 4px); font-size: 11px; line-height: 16px; white-space: nowrap;
  font-variant-ligatures: none; color: var(--dsw-alias-label-tertiary, currentColor);
  background: color-mix(in srgb, currentColor 9%, transparent);
}
.${BRANCH}::before {
  content: ''; flex: none; width: 10px; height: 10px; margin-right: 3px; background: currentColor;
  -webkit-mask: ${BRANCH_ICON} center / contain no-repeat; mask: ${BRANCH_ICON} center / contain no-repeat;
}
.${BRANCH} > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* The prefix gives way first (to nothing), then the last segment, down to a few letters. */
.${BRANCH} > .${BRANCH}-head { flex: 0 1000 auto; opacity: .75; }
.${BRANCH} > .${BRANCH}-tail { flex: 0 1 auto; min-width: 2.4em; }
/* A narrow sidebar: the icon alone says there is a branch; its name is the tooltip. */
@container (max-width: 140px) {
  [data-ah-branch] > .${BRANCH} { min-width: 18px; padding: 0 4px; }
  .${BRANCH}::before { margin-right: 0; }
  .${BRANCH} > span { display: none; }
}
[data-ah-count]::after {
  content: attr(data-ah-count); order: 2; flex: none; font-size: 11px; line-height: 16px;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, currentColor); opacity: .8;
}
[data-ah-state]::before {
  content: ''; order: 1; flex: none; box-sizing: border-box; width: 6px; height: 6px; margin-right: 4px;
  border-radius: 50%; background: currentColor;
}
[data-ah-state="done"]::before { color: var(--dsw-alias-state-success-primary, #2ea043); }
[data-ah-state="warning"]::before { color: var(--dsw-alias-state-warn-primary, #d29922); }
[data-ah-state="ongoing"]::before {
  width: 9px; height: 9px; background: none; color: var(--dsw-alias-label-tertiary, currentColor);
  border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent); border-top-color: currentColor;
  animation: ah-state-spin 1s linear infinite;
}
@keyframes ah-state-spin { to { transform: rotate(360deg); } }
/* The terminal mark (styled by the Git pane's terminals), before the row's hover actions. */
[data-ah-term] > .ah-term-mark { margin: 0 2px 0 6px; align-self: center; }
@media (prefers-reduced-motion: reduce) { [data-ah-state="ongoing"]::before { animation: none; } }
/*
 * A touch screen has no hover: a row's actions show all along (shown on the first touch instead,
 * they pushed the title aside under the finger, which then hit them), on tall rows with
 * finger-sized buttons. The files button stays off (the header has one), on root too; a long
 * press lifts a worktree to move it, so it opens no callout. A branch chip squeezed to its icon
 * goes: its name would only be a tooltip, which no finger reaches.
 */
@media (hover: none) and (pointer: coarse) {
  ${ROW}, [data-ah-root] { height: 44px; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  ${ROW} > ${ACTIONS}, [data-ah-root] > [data-ah-lent] { display: inline-flex !important; height: 44px !important; gap: 8px; margin-inline-start: 8px; }
  ${ROW} > ${ACTIONS} button, [data-ah-root] > [data-ah-lent] button { width: 40px; height: 44px; justify-content: center; align-items: center; }
  ${ROW} [data-ah-files], [data-ah-root] [data-ah-files] { display: none !important; }
  @container (max-width: 140px) { [data-ah-branch] > .${BRANCH} { display: none; } }
}
[data-ah-nodrag]:focus:not(:focus-visible) { outline: none; }
`

/** The grouping mode DSH's workspace browser shows, as persisted; undefined when unreadable. */
export function viewMode(storage: Pick<Storage, 'length' | 'key' | 'getItem'> | undefined = globalThis.localStorage): string | undefined {
  if (storage === undefined) return undefined
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== VIEW_KEY && !key?.startsWith(`${VIEW_KEY}.`)) continue
      const value = JSON.parse(storage.getItem(key) ?? 'null') as { state?: { groupBy?: unknown }; groupBy?: unknown } | null
      const mode = value?.state?.groupBy ?? value?.groupBy
      if (typeof mode === 'string') return mode
    }
  } catch {
    // Unreadable: treat as unknown, which changes nothing.
  }
  return undefined
}

/** ui-workspace's view store actions, as its `uiWorkspace` service holds them. */
export interface ViewActions {
  setGroupBy?(mode: string): void
}

/**
 * 按工作区树 by default: DSH starts 按工作区 until a view is first picked, so pick the tree
 * view while nothing is persisted. Through the live store when ui-workspace is up, else by
 * seeding its persisted state (its whole initial state, which rehydration replaces).
 */
export function preferTreeView(view: ViewActions | undefined, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  if (storage === undefined) return
  try {
    if (storage.getItem(VIEW_KEY) !== null) return
    if (view?.setGroupBy !== undefined) view.setGroupBy(TREE_VIEW)
    else storage.setItem(VIEW_KEY, JSON.stringify({ groupBy: TREE_VIEW, orderBy: 'updated', groupExpansion: {}, sessionOrderByAccount: {}, archivedFilter: 'default' }))
  } catch {
    // Storage unavailable: DSH's own default stays.
  }
}

export interface Placement {
  /** The repository's main tree's workspace. */
  head: string
  /** The worktree's and its head's titles as registered: how their rows' labels are found. */
  title: string
  headTitle: string
  /** The worktree's short title: its branch, when the title is the default `<repo> · <branch>`. */
  short?: string
}

/**
 * Which workspaces nest under which: every worktree of a repository whose main tree is
 * registered. A repository without a registered main tree, or without worktrees, stays flat.
 */
export function placements(groups: readonly RepoGroup[]): Map<string, Placement> {
  const out = new Map<string, Placement>()
  for (const group of groups) {
    const main = group.members.find((member) => member.main)
    if (main === undefined || group.members.length < 2) continue
    const prefix = `${group.name} · `
    for (const member of group.members) {
      if (member === main) continue
      const short = member.title.startsWith(prefix) && member.title.length > prefix.length ? member.title.slice(prefix.length) : undefined
      out.set(member.workspaceId, { head: main.workspaceId, title: member.title, headTitle: main.title, ...(short === undefined ? {} : { short }) })
    }
  }
  return out
}

export interface Arrangement<T> {
  /** The head's own items in DOM order: its row (`parts[0..rowLead]`), native child groups (`..lead`), sessions. */
  parts: readonly T[]
  lead: number
  /** Its worktrees, natively nested (inside those groups) or adopted alike, in the order they show. */
  worktrees: readonly T[]
  /** The `root` row gathering the head's sessions, and how many leading parts hold the head's row. */
  root?: { item: T; rowLead: number }
}

/**
 * The visual order of a list's items once worktrees join their heads: each head's own items
 * stay in place, and its worktrees (one run, however DSH nests them) go right after its row and
 * native child groups, before its sessions. With a `root` row, the sessions follow it, right
 * after the head's row and before every worktree. Items are opaque; `adopted` are the list's
 * own items placed by their heads.
 */
export function arrange<T>(items: readonly T[], heads: ReadonlyMap<T, Arrangement<T>>, adopted: ReadonlySet<T>): T[] {
  const out: T[] = []
  for (const item of items) {
    if (adopted.has(item)) continue
    const head = heads.get(item)
    if (head === undefined) {
      out.push(item)
      continue
    }
    if (head.root === undefined) out.push(...head.parts.slice(0, head.lead), ...head.worktrees, ...head.parts.slice(head.lead))
    else {
      const { item: root, rowLead } = head.root
      out.push(...head.parts.slice(0, rowLead), root, ...head.parts.slice(head.lead), ...head.parts.slice(rowLead, head.lead), ...head.worktrees)
    }
  }
  return out
}

const idOf = (row: Element): string => (row as HTMLElement).dataset.rowKey?.slice('workspace:'.length) ?? ''

/** The row's label: the innermost element whose whole text is the workspace's title (or our short form of it). */
function titleOf(row: Element, ...texts: Array<string | undefined>): HTMLElement | undefined {
  for (const element of row.querySelectorAll<HTMLElement>('span, div')) {
    if (element.children.length > 0 || element.closest(`button, .${BRANCH}`) !== null) continue
    const text = (element.textContent ?? '').trim()
    if (text !== '' && texts.includes(text)) return element
  }
  return undefined
}

function shorten(row: Element, full: string, short: string | undefined): void {
  const title = titleOf(row, full, short)
  if (title === undefined) return
  if (short === undefined) return restoreTitle(row)
  if (title.dataset.ahShort === short && title.textContent === short) return
  title.dataset.ahFull = title.textContent ?? ''
  title.dataset.ahShort = short
  title.textContent = short
  title.title = title.dataset.ahFull
}

function restoreTitle(row: Element): void {
  const title = row.querySelector<HTMLElement>('[data-ah-full]')
  if (title === null) return
  if (title.textContent === title.dataset.ahShort) title.textContent = title.dataset.ahFull ?? title.textContent
  delete title.dataset.ahFull
  delete title.dataset.ahShort
  title.removeAttribute('title')
}

/** Each lent actions element's own row. */
const homes = new WeakMap<HTMLElement, HTMLElement>()

/**
 * Lend the head row's actions (DSH's own elements, so its menu opens there and its buttons
 * work as before) to the `root` row: they act on the repository's main tree, whose sessions
 * `root` holds. Elements DSH replaced meanwhile go back, or away.
 */
function lend(rootEl: HTMLElement, headRow: HTMLElement): void {
  const own = headRow.querySelector<HTMLElement>(`:scope > ${ACTIONS}`)
  if (own === null) return
  giveBack(rootEl)
  own.dataset.ahLent = ''
  homes.set(own, headRow)
  rootEl.appendChild(own)
}

/** Return the actions lent to `rootEl` to their row; dropped when DSH drew that row anew. */
function giveBack(rootEl: HTMLElement): void {
  for (const actions of rootEl.querySelectorAll<HTMLElement>(':scope > [data-ah-lent]')) {
    delete actions.dataset.ahLent
    const home = homes.get(actions)
    if (home?.isConnected === true && home.querySelector(`:scope > ${ACTIONS}`) === null) home.appendChild(actions)
    else actions.remove()
  }
}

/** Undo everything this layer did inside `root`. */
function restore(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-ah-root]')) {
    giveBack(element)
    element.remove()
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-ah-list], [data-ah-head], [data-ah-group], [data-ah-child], [data-ah-rooted], [data-ah-hidden], [data-ah-ordered]')) {
    delete element.dataset.ahList
    delete element.dataset.ahHead
    delete element.dataset.ahGroup
    delete element.dataset.ahChild
    delete element.dataset.ahRooted
    delete element.dataset.ahHidden
    if (element.dataset.ahOrdered !== undefined) {
      element.style.removeProperty('order')
      delete element.dataset.ahOrdered
    }
    element.style.removeProperty('--ah-indent')
  }
  for (const row of root.querySelectorAll(ROW)) restoreTitle(row)
  for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
    showBranch(row, undefined)
    undraggable(row, false)
  }
}

/**
 * Take a worktree's row off DSH's drag (`draggable="false"`, which DSH does not set again) for
 * ours, or give it back. Ours moves it by keyboard too, so a click focuses it (out of the Tab
 * order, as DSH keeps its rows).
 */
function undraggable(row: HTMLElement, off: boolean): void {
  if (off === (row.dataset.ahNodrag !== undefined)) return
  if (off) {
    if (row.getAttribute('draggable') !== 'true') return
    row.dataset.ahNodrag = ''
    row.setAttribute('draggable', 'false')
    if (!row.hasAttribute('tabindex')) row.tabIndex = -1
  } else {
    delete row.dataset.ahNodrag
    row.setAttribute('draggable', 'true')
    if (row.tabIndex === -1) row.removeAttribute('tabindex')
  }
}

function unorder(list: HTMLElement): void {
  delete list.dataset.ahList
  for (const item of list.querySelectorAll<HTMLElement>(':scope > [data-ah-ordered], :scope > [data-ah-head] > [data-ah-ordered], :scope > [data-ah-head] > [data-ah-group] > [data-ah-ordered]')) {
    item.style.removeProperty('order')
    delete item.dataset.ahOrdered
  }
}

function readFolded(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Set<string> {
  try {
    const value = JSON.parse(storage?.getItem(FOLD_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * The `root` row of a head's section: a copy of the head's own row (so it looks like any
 * workspace row, icons and hover included) without its actions, retitled. Undefined when the
 * head's row is not drawn the expected way.
 */
function rootRow(head: HTMLElement, headRow: HTMLElement, headTitle: string, onToggle: (id: string) => void): HTMLElement | undefined {
  const existing = head.querySelector<HTMLElement>(':scope > [data-ah-root]')
  if (existing !== null) return existing
  const id = idOf(headRow)
  const row = headRow.cloneNode(true) as HTMLElement
  const title = titleOf(row, headTitle)
  if (id === '' || title === undefined) return undefined
  for (const element of [row, ...row.querySelectorAll<HTMLElement>('*')]) {
    for (const name of Object.keys(element.dataset)) if (name.startsWith('ah')) delete element.dataset[name]
  }
  for (const actions of row.querySelectorAll(`${ACTIONS}, button, .${BRANCH}`)) actions.remove()
  row.className = [...row.classList].filter((name) => !/menuOpen/.test(name)).join(' ')
  // The folder speaks for `root` alone (`showFolder`), not for the head it was copied from.
  const slot = row.querySelector<HTMLElement>(`:scope > ${FOLDER}`)
  if (slot !== null) {
    slot.className = [...slot.classList].filter((name) => !/folderActive/.test(name)).join(' ')
    slot.dataset.ahOpen = String(headRow.getAttribute('aria-expanded') !== 'false')
  }
  row.removeAttribute('data-row-key')
  row.removeAttribute('draggable')
  row.removeAttribute('title')
  row.dataset.ahRoot = id
  title.textContent = ROOT_TITLE
  title.removeAttribute('title')
  row.addEventListener('click', (event) => {
    // The head's own actions, lent to this row: theirs to handle (DSH listens at its root).
    if (event.target instanceof Element && event.target.closest(ACTIONS) !== null) return
    event.stopPropagation()
    onToggle(id)
  })
  head.appendChild(row)
  return row
}

/**
 * `root`'s folder, as DSH draws a workspace's: open while its sessions show, closed when folded,
 * and highlighted while the current session is among them. The icons are DSH's own, read off
 * its rows; until a row in that state is drawn, the icon stays as it is.
 */
function showFolder(rootEl: HTMLElement, open: boolean, active: boolean): void {
  const slot = rootEl.querySelector<HTMLElement>(`:scope > ${FOLDER}`)
  if (slot === null) return
  if (slot.dataset.ahOpen !== String(open)) {
    const icon = document.querySelector(`${ROW}[aria-expanded="${open}"] > ${FOLDER} svg`)
    if (icon !== null) {
      slot.replaceChildren(icon.cloneNode(true))
      slot.dataset.ahOpen = String(open)
    }
  }
  if (active) slot.dataset.ahActive = ''
  else delete slot.dataset.ahActive
}

function setOrder(element: HTMLElement, order: number): void {
  if (element.style.order !== String(order)) element.style.order = String(order)
  element.dataset.ahOrdered = ''
}

/** A workspace's terminals off screen: how many run a command, how many finished unseen. */
export interface TerminalTally {
  busy: number
  done: number
}

/** The Git pane's terminals, as the workspace rows show them. */
export interface WorkspaceTerminals {
  subscribe(listener: () => void): () => void
  marks(workspace: WorkspaceItem): TerminalTally
  /** The mark's spoken description. */
  describe(marks: TerminalTally): string
}

/** Where the sidebar reads the sessions' activity. */
export interface ActivitySource {
  store: ActivityStore
  /** DSH's `workspaces` list snapshot. */
  workspaces(): { items: readonly WorkspaceItem[]; archivedSessionIds?: readonly string[] } | undefined
  /**
   * Its changes: a new order may move no element DSH draws (a worktree adopted from elsewhere).
   * Undefined while the list is not up yet.
   */
  onWorkspaces?(listener: () => void): (() => void) | undefined
  /** Absent: no terminal marks. */
  terminals?: WorkspaceTerminals
}

const TERM_MARK = 'ah-term-mark'

function setData(element: HTMLElement, name: string, value: string | undefined): void {
  if (element.dataset[name] === value) return
  if (value === undefined) delete element.dataset[name]
  else element.dataset[name] = value
}

/** A row's label line: the title, then the state dot and the count. */
function show(row: Element, value: Tally | undefined): void {
  const label = row.querySelector<HTMLElement>(TEXT)
  if (label === null) return
  setData(label, 'ahCount', value !== undefined && value.sessions > 0 ? String(value.sessions) : undefined)
  setData(label, 'ahState', value?.state)
}

/** The row's terminal mark, kept right before its hover actions (or last); none without marks. */
function showTerminals(row: HTMLElement, marks: TerminalTally | undefined, describe: (marks: TerminalTally) => string): void {
  const mark = marks === undefined ? undefined : marks.busy > 0 ? 'busy' : marks.done > 0 ? 'done' : undefined
  let glyph = row.querySelector<HTMLElement>(`:scope > .${TERM_MARK}`)
  setData(row, 'ahTerm', mark)
  if (mark === undefined) {
    glyph?.remove()
    return
  }
  if (glyph === null) {
    glyph = document.createElement('span')
    glyph.className = TERM_MARK
    glyph.setAttribute('role', 'img')
  }
  const actions = row.querySelector<HTMLElement>(`:scope > ${ACTIONS}`)
  if (actions === null ? glyph !== row.lastElementChild : glyph.nextElementSibling !== actions) row.insertBefore(glyph, actions)
  if (glyph.dataset.mark !== mark) glyph.dataset.mark = mark
  const text = describe(marks!)
  if (glyph.getAttribute('aria-label') !== text) {
    glyph.setAttribute('aria-label', text)
    glyph.title = text
  }
}

/** The row's branch chip, last on its label line before the sessions; none without a branch, or when the title says it. */
function showBranch(row: HTMLElement, branch: string | undefined): void {
  const label = row.querySelector<HTMLElement>(TEXT)
  if (label === null) return
  let chip = label.querySelector<HTMLElement>(`:scope > .${BRANCH}`)
  if (branch !== undefined && titleOf(label, branch) !== undefined) branch = undefined
  setData(label, 'ahBranch', branch === undefined ? undefined : '')
  if (branch === undefined) {
    chip?.remove()
    return
  }
  if (chip === null) chip = document.createElement('span')
  if (chip.dataset.branch !== branch) {
    chip.className = BRANCH
    chip.dataset.branch = branch
    chip.title = branch
    const cut = branch.lastIndexOf('/', branch.length - 2) + 1
    const parts: Array<[string, string]> = cut > 0 ? [['head', branch.slice(0, cut)], ['tail', branch.slice(cut)]] : [['tail', branch]]
    chip.replaceChildren(...parts.map(([kind, text]) => {
      const span = document.createElement('span')
      span.className = `${BRANCH}-${kind}`
      span.textContent = text
      return span
    }))
  }
  if (chip !== label.lastElementChild) label.appendChild(chip)
}

const mergeTerminals = (a: TerminalTally, b: TerminalTally): TerminalTally => ({ busy: a.busy + b.busy, done: a.done + b.done })

/** `move` is DSH's reorder (its `insertBefore`); worktrees move by it in the tree view. */
export function nestWorktrees(store: ReposStore, activity: ActivitySource, move: (id: string, before: string | undefined) => Promise<void>): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.repos'
  style.textContent = CSS
  document.head.appendChild(style)

  let seen = ''
  let refresh: ReturnType<typeof setTimeout> | undefined
  let root: Element | undefined
  let mode: string | undefined
  let placed: ReadonlyMap<string, Placement> = new Map()
  const folded = readFolded()
  const toggleRoot = (id: string): void => {
    if (!folded.delete(id)) folded.add(id)
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...folded]))
    } catch {
      // Not persisted: the fold still holds until reload.
    }
    schedule()
  }

  const orderKey = (): string => (activity.workspaces()?.items ?? []).map((item) => item.workspaceId).join('\n')
  let lastOrder = orderKey()
  let offWorkspaces: (() => void) | undefined
  /** Follow DSH's order, once its list is up (it may come after this layer). */
  const watchOrder = (): void => {
    offWorkspaces ??= activity.onWorkspaces?.(() => {
      const next = orderKey()
      if (next === lastOrder) return
      lastOrder = next
      schedule()
    })
  }

  const apply = (target: Element): void => {
    root = target
    watchOrder()
    mode = viewMode()
    const rows = [...root.querySelectorAll<HTMLElement>(ROW)]
    // The registered workspaces changed: read the repositories again.
    const key = rows.map(idOf).filter(Boolean).sort().join('\n')
    if (key !== seen) {
      seen = key
      clearTimeout(refresh)
      if (key !== '') refresh = setTimeout(() => void store.load(), 300)
    }
    if (mode !== TREE_VIEW) {
      placed = new Map()
      restore(root)
      return mark(root, rows, placed)
    }
    placed = placements(store.getSnapshot().repos ?? [])
    const sectionOf = (row: Element): HTMLElement | null => row.closest<HTMLElement>(SECTION) ?? row.parentElement
    const rowById = new Map(rows.map((row) => [idOf(row), row]))

    // Per list (the top level, or a parent's child group): the heads and the sections they adopt.
    const lists = new Map<HTMLElement, Map<HTMLElement, { row: HTMLElement; title: string; adopted: HTMLElement[]; nested: number }>>()
    const touched = new Set<HTMLElement>()
    for (const [id, place] of placed) {
      const row = rowById.get(id)
      const headRow = rowById.get(place.head)
      if (row === undefined || headRow === undefined) continue
      const section = sectionOf(row)
      const head = sectionOf(headRow)
      if (section === null || head === null) continue
      shorten(row, place.title, place.short)
      const list = head.parentElement
      let heads = list === null ? undefined : lists.get(list)
      if (list !== null && heads === undefined) lists.set(list, heads = new Map())
      let entry = heads?.get(head)
      if (heads !== undefined && entry === undefined) heads.set(head, entry = { row: headRow, title: place.headTitle, adopted: [], nested: 0 })
      if (entry === undefined) continue
      // Already under it by folder (DSH's own nesting): nothing to move.
      if (head.contains(section)) {
        entry.nested++
        continue
      }
      // Only a sibling section can be placed next to its head.
      if (section.parentElement !== list) continue
      entry.adopted.push(section)
      touched.add(section)
    }

    // Undo what no longer applies (a worktree removed, a repository regrouped).
    for (const element of root.querySelectorAll<HTMLElement>('[data-ah-child]')) {
      if (!touched.has(element)) {
        delete element.dataset.ahChild
        delete element.dataset.ahHidden
        element.style.removeProperty('--ah-indent')
      }
    }
    for (const row of rows) if (!placed.has(idOf(row))) restoreTitle(row)
    const heads = new Set([...lists.values()].flatMap((map) => [...map.keys()]))
    for (const element of root.querySelectorAll<HTMLElement>('[data-ah-head]')) if (!heads.has(element)) delete element.dataset.ahHead

    // A repository's worktrees show in DSH's own order (the one a drag sets), however DSH nests them.
    const rank = new Map((activity.workspaces()?.items ?? []).map((item, index) => [item.workspaceId, index]))
    const rankOf = (section: Element): number => rank.get(idOf(section.querySelector(ROW) ?? section)) ?? Infinity
    const roots = new Set<HTMLElement>()
    const rooted = new Set<HTMLElement>()
    const ordered = new Set<HTMLElement>()
    const groups = new Set<HTMLElement>()
    for (const [list, map] of lists) {
      const plan = new Map<HTMLElement, Arrangement<HTMLElement>>()
      for (const [head, entry] of map) {
        const expanded = entry.row.getAttribute('aria-expanded') !== 'false'
        const count = entry.adopted.length + entry.nested
        const depth = Number.parseFloat(head.style.getPropertyValue('--dsh-workspace-indent')) || 0
        // The head's own parts: its row (possibly inside a hover wrapper), the native child
        // group, then its sessions (and their overflow button).
        const parts = ([...head.children] as HTMLElement[]).filter((part) => part.dataset.ahRoot === undefined)
        let rowLead = 0
        while (rowLead < parts.length && parts[rowLead]!.contains(entry.row)) rowLead++
        let lead = rowLead
        while (lead < parts.length && parts[lead]!.getAttribute('role') === 'group') lead++
        const sessions = parts.slice(lead)

        // The repository's own sessions gather under `root`, the first of its worktrees.
        const rootEl = expanded && count > 0 && sessions.length > 0 ? rootRow(head, entry.row, entry.title, toggleRoot) : undefined
        if (rootEl !== undefined) {
          roots.add(rootEl)
          lend(rootEl, entry.row)
          const open = !folded.has(idOf(entry.row))
          rootEl.style.setProperty('--ah-indent', `${depth + LEVEL_PX}px`)
          if (rootEl.getAttribute('aria-expanded') !== String(open)) rootEl.setAttribute('aria-expanded', String(open))
          const arrow = rootEl.querySelector<HTMLElement>('[class*="chevron"] svg')
          arrow?.style.setProperty('transform', open ? 'rotate(90deg)' : 'none')
          showFolder(rootEl, open, sessions.some((part) => part.matches(CURRENT) || part.querySelector(CURRENT) !== null))
          for (const part of sessions) {
            rooted.add(part)
            part.dataset.ahRooted = ''
            part.style.setProperty('--ah-indent', `${depth + LEVEL_PX}px`)
            if (open) delete part.dataset.ahHidden
            else part.dataset.ahHidden = ''
          }
        }

        if (entry.adopted.length === 0 && rootEl === undefined) {
          delete head.dataset.ahHead
          continue
        }
        head.dataset.ahHead = ''
        // DSH's own child groups open up, so their sections and the adopted ones sort as one run.
        const native = parts.slice(rowLead, lead).flatMap((group) => {
          groups.add(group)
          group.dataset.ahGroup = ''
          return [...group.children] as HTMLElement[]
        })
        const worktrees = [...native, ...entry.adopted].sort((a, b) => rankOf(a) - rankOf(b))
        for (const section of entry.adopted) {
          section.dataset.ahChild = ''
          section.style.setProperty('--ah-indent', `${depth + LEVEL_PX}px`)
          if (expanded) delete section.dataset.ahHidden
          else section.dataset.ahHidden = ''
        }
        plan.set(head, { parts, lead, worktrees, ...(rootEl === undefined ? {} : { root: { item: rootEl, rowLead } }) })
      }
      if (plan.size === 0) continue
      // Lay the list out as one column of items: a head's own parts count as items, so its
      // worktrees and `root` can sit among them.
      ordered.add(list)
      list.dataset.ahList = ''
      const items = [...list.children] as HTMLElement[]
      arrange(items, plan, new Set([...map.values()].flatMap((entry) => entry.adopted))).forEach((item, index) => setOrder(item, index))
    }

    // Undo what no longer applies (a head folded, its worktrees gone, its sessions moved).
    for (const element of root.querySelectorAll<HTMLElement>('[data-ah-root]')) {
      if (roots.has(element)) continue
      giveBack(element)
      element.remove()
    }
    for (const element of root.querySelectorAll<HTMLElement>('[data-ah-rooted]')) {
      if (rooted.has(element)) continue
      delete element.dataset.ahRooted
      if (element.dataset.ahChild === undefined) delete element.dataset.ahHidden
      element.style.removeProperty('--ah-indent')
    }
    for (const element of root.querySelectorAll<HTMLElement>('[data-ah-group]')) if (!groups.has(element)) delete element.dataset.ahGroup
    for (const element of root.querySelectorAll<HTMLElement>('[data-ah-list]')) if (!ordered.has(element)) unorder(element)
    // Worktrees move by our drag (DSH's would keep each kind among its own), the rest by DSH's.
    for (const row of rows) undraggable(row, placed.has(idOf(row)))
    mark(root, rows, placed)
    branches(root, rows, store.getSnapshot().repos ?? [])
  }

  /**
   * Each working tree's branch, on its row: the main tree's on `root` while that shows (the
   * repository's row then stands for all its trees), else on the repository's row.
   */
  const branches = (root: Element, rows: readonly HTMLElement[], groups: readonly RepoGroup[]): void => {
    const branchOf = new Map(groups.flatMap((group) => group.members.map((member) => [member.workspaceId, member.branch] as const)))
    const roots = [...root.querySelectorAll<HTMLElement>('[data-ah-root]')]
    const lent = new Set(roots.map((element) => element.dataset.ahRoot))
    for (const row of rows) showBranch(row, lent.has(idOf(row)) ? undefined : branchOf.get(idOf(row)))
    for (const element of roots) showBranch(element, branchOf.get(element.dataset.ahRoot ?? ''))
  }

  /**
   * Every workspace row's sessions: how many, and the most urgent state among them. In the tree
   * view a repository's row counts its worktrees' too (and `root`'s, its own), folded or not.
   */
  const mark = (root: Element, rows: readonly HTMLElement[], placed: ReadonlyMap<string, Placement>): void => {
    const list = activity.workspaces()
    const own = tally(list?.items ?? [], activity.store.get(), new Set(list?.archivedSessionIds ?? []))
    const totals = new Map(own)
    for (const [id, place] of placed) {
      const worktree = own.get(id)
      const head = totals.get(place.head)
      if (worktree !== undefined && head !== undefined) totals.set(place.head, merge(head, worktree))
    }
    for (const row of rows) show(row, totals.get(idOf(row)))
    for (const rootEl of root.querySelectorAll<HTMLElement>('[data-ah-root]')) show(rootEl, own.get(rootEl.dataset.ahRoot ?? ''))

    // The terminals, by the same rule: a repository's row counts its worktrees', `root` its own.
    const terminals = activity.terminals
    const ownTerms = new Map((list?.items ?? []).map((item) => [item.workspaceId, terminals?.marks(item) ?? { busy: 0, done: 0 }]))
    const termTotals = new Map(ownTerms)
    for (const [id, place] of placed) {
      const worktree = ownTerms.get(id)
      const head = termTotals.get(place.head)
      if (worktree !== undefined && head !== undefined) termTotals.set(place.head, mergeTerminals(head, worktree))
    }
    const describe = terminals?.describe ?? (() => '')
    for (const row of rows) showTerminals(row, termTotals.get(idOf(row)), describe)
    for (const rootEl of root.querySelectorAll<HTMLElement>('[data-ah-root]')) showTerminals(rootEl, ownTerms.get(rootEl.dataset.ahRoot ?? ''), describe)
  }

  const schedule = (): void => followed.schedule()
  // Only the workspace list is watched (a chat streaming elsewhere costs nothing). Our own
  // attributes and orders are not watched; a shortened title comes back once, finding nothing to do.
  // Classes are, for the session that opens (it lights `root`'s folder).
  const followed = follow({
    locate: () => document.querySelector(ROW)?.closest(ROOT) ?? undefined,
    apply,
    observe: { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'class'] },
    // A terminal mark or branch chip placed or moved is not news.
    ours: (node) => (node as Element).classList?.contains(TERM_MARK) === true || (node as Element).classList?.contains(BRANCH) === true,
    // Picking another view may change nothing the list announces.
    tick: () => { if (mode !== undefined && viewMode() !== mode) schedule() },
  })
  // Switching the view rewrites the persisted store; the list re-renders too, but a storage
  // event from another window needs a pass of its own.
  const onStorage = (event: StorageEvent): void => { if (event.key?.startsWith(VIEW_KEY) === true) schedule() }
  window.addEventListener('storage', onStorage)
  // Picking another view in DSH's view menu may leave the list's DOM as it was (nothing nested
  // natively), so nothing above fires: after any click or key, check whether the view changed.
  const recheck = (): void => { setTimeout(() => { if (viewMode() !== mode) schedule() }, 0) }
  document.addEventListener('click', recheck, true)
  document.addEventListener('keyup', recheck, true)
  // A branch checked out elsewhere (a terminal, another tool): read the branches again while
  // the tree view shows, and when the page comes back into view.
  const reread = (): void => { if (root !== undefined && mode === TREE_VIEW && document.visibilityState === 'visible') void store.load() }
  const rereader = setInterval(reread, BRANCH_MS)
  document.addEventListener('visibilitychange', reread)
  window.addEventListener('focus', reread)
  const off = store.subscribe(schedule)
  const offActivity = activity.store.subscribe(schedule)
  const offTerminals = activity.terminals?.subscribe(schedule)
  const offReorder = reorderWorktrees({
    active: () => mode === TREE_VIEW,
    heads: () => new Map([...placed].map(([id, place]) => [id, place.head])),
    order: () => (activity.workspaces()?.items ?? []).map((item) => item.workspaceId),
    move,
  })

  return () => {
    offReorder()
    followed.dispose()
    clearInterval(rereader)
    document.removeEventListener('visibilitychange', reread)
    window.removeEventListener('focus', reread)
    window.removeEventListener('storage', onStorage)
    document.removeEventListener('click', recheck, true)
    document.removeEventListener('keyup', recheck, true)
    off()
    offActivity()
    offTerminals?.()
    offWorkspaces?.()
    clearTimeout(refresh)
    if (root !== undefined) {
      restore(root)
      for (const label of root.querySelectorAll<HTMLElement>('[data-ah-count], [data-ah-state]')) {
        delete label.dataset.ahCount
        delete label.dataset.ahState
      }
      for (const row of root.querySelectorAll<HTMLElement>('[data-ah-term]')) {
        delete row.dataset.ahTerm
        row.querySelector(`:scope > .${TERM_MARK}`)?.remove()
      }
    }
    style.remove()
  }
}
