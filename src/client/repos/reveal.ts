/**
 * Going to a session (from a toast, the board, a review, the Git pane, a shortcut) shows it in
 * the left sidebar: every row between it and the top unfolds, as far as needed and no further,
 * the list scrolls it into sight, and the row lights up once. DSH reveals a session only when
 * one is picked from its own search; everywhere else the session may sit in a folded workspace,
 * under a folded repository or `root` row, or past the "show more" button.
 *
 * It acts as a person would: by clicking each row's own toggle (DSH's workspace rows, the tree
 * layer's `root` rows, DSH's overflow button), so DSH's persisted fold state stays the only
 * truth. Only a change of session counts: a session picked in the sidebar is already in sight,
 * and a workspace folded afterwards stays folded. Nothing happens while the search shows.
 *
 * The session on screen also reads as such: its row carries a tint of the accent color rather
 * than the hover's grey alone.
 */

import type { ReposStore } from './api.ts'
import type { ActivitySource } from './sidebar.ts'
import { placements, TREE_VIEW, viewMode, type Placement } from './sidebar.ts'
import type { WorkspaceItem } from './activity.ts'

/** The workspace list's root: its tree, else the left sidebar. */
const ROOT = '[role="tree"], [data-pane="sidebar"], [class*="sidebarCol"]'
const SEARCHING = '[class*="_searchSlotExpanded"]'
const FLASH = 'ahReveal'
const FLASH_MS = 1600
/** How long a reveal keeps trying (the list may still be loading), and its pace. */
const DEADLINE_MS = 3000
const PASS_MS = 80

const ACCENT = 'var(--dsw-alias-state-business-primary, #3b82f6)'
const STYLE = `
[data-row-key^="session:"][aria-selected="true"] {
  background: color-mix(in srgb, ${ACCENT} 12%, var(--dsw-alias-interactive-bg-hover, transparent));
}
[data-row-key^="session:"][aria-selected="true"]:hover {
  background: color-mix(in srgb, ${ACCENT} 18%, var(--dsw-alias-interactive-bg-hover, transparent));
}
[data-ah-reveal] { animation: ah-reveal ${FLASH_MS}ms var(--ds-ease-in-out, ease-out) 1; }
@keyframes ah-reveal {
  0%, 35% {
    background: color-mix(in srgb, ${ACCENT} 26%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, ${ACCENT} 55%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) { [data-ah-reveal] { animation: none; } }
`

const sep = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')
const trim = (path: string): string => path.replace(/[\\/]+$/, '')

/**
 * The workspaces whose rows hold `id`'s in the sidebar, outermost first: in the tree view, its
 * repository (for a worktree) and the workspaces whose folders contain its folder, as DSH nests
 * them; in the other views, none.
 */
export function ancestry(id: string, items: readonly WorkspaceItem[], placed: ReadonlyMap<string, Placement>, tree: boolean): string[] {
  if (!tree) return []
  const pathOf = new Map(items.map((item) => [item.workspaceId, trim(item.path ?? '')]))
  const parentOf = (child: string): string | undefined => {
    const head = placed.get(child)?.head
    if (head !== undefined) return head
    const path = pathOf.get(child) ?? ''
    if (path === '') return undefined
    let best: string | undefined
    let length = -1
    for (const [other, folder] of pathOf) {
      if (other === child || folder === '' || folder === path || !path.startsWith(`${folder}${sep(path)}`)) continue
      if (folder.length > length) [best, length] = [other, folder.length]
    }
    return best
  }
  const out: string[] = []
  for (let key = parentOf(id); key !== undefined && key !== id && !out.includes(key); key = parentOf(key)) out.push(key)
  return out.reverse()
}

/** The session on screen in the main view. */
export function currentSession(byId: Record<string, { retainedBy?: { mainView?: number } } | undefined> | undefined): string | undefined {
  return Object.entries(byId ?? {}).find(([, summary]) => (summary?.retainedBy?.mainView ?? 0) > 0)?.[0]
}

const shown = (row: Element): boolean => row.closest('[data-ah-hidden]') === null && row.getClientRects().length > 0

function scroller(row: HTMLElement): HTMLElement | undefined {
  for (let element = row.parentElement; element !== null; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight) return element
  }
  return undefined
}

/** In sight within its scrolling list. */
function inView(row: HTMLElement): boolean {
  const box = scroller(row)?.getBoundingClientRect()
  const own = row.getBoundingClientRect()
  return box === undefined || (own.top >= box.top && own.bottom <= box.bottom)
}

/** Scroll the list (only the list: on a phone the sidebar is a drawer) to bring the row near its middle. */
function bring(row: HTMLElement): void {
  const box = scroller(row)
  if (box === undefined || inView(row)) return
  const outer = box.getBoundingClientRect()
  const own = row.getBoundingClientRect()
  const top = box.scrollTop + own.top - outer.top - (box.clientHeight - own.height) / 2
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
  box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
}

const flashes = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

function flash(row: HTMLElement): void {
  clearTimeout(flashes.get(row))
  // Restart the animation on a row lit a moment ago.
  delete row.dataset[FLASH]
  void row.offsetWidth
  row.dataset[FLASH] = ''
  flashes.set(row, setTimeout(() => { delete row.dataset[FLASH] }, FLASH_MS))
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function revealSessions(store: ReposStore, activity: ActivitySource): () => void {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.reveal'
  style.textContent = STYLE
  document.head.appendChild(style)

  const scope = (): ParentNode => document.querySelector('[data-row-key^="workspace:"]')?.closest(ROOT) ?? document
  let run = 0
  let disposed = false
  const reveal = async (session: string): Promise<void> => {
    const mine = ++run
    const live = (): boolean => !disposed && mine === run
    const find = (): HTMLElement | null => scope().querySelector<HTMLElement>(`[data-row-key="session:${CSS.escape(session)}"]`)
    const first = find()
    // Already in sight (picked in the sidebar, most likely): nothing to show.
    if (first !== null && shown(first) && inView(first)) return
    const until = Date.now() + DEADLINE_MS
    // Each toggle is clicked once: one DSH has not redrawn yet must not fold back.
    const tried = new WeakSet<Element>()
    const click = (element: Element | null): void => {
      if (element === null || tried.has(element) || element.getAttribute('aria-expanded') !== 'false') return
      tried.add(element)
      ;(element as HTMLElement).click()
    }
    while (live() && Date.now() < until) {
      if (document.querySelector(SEARCHING) !== null) return
      const row = find()
      if (row !== null && shown(row)) {
        bring(row)
        flash(row)
        return
      }
      const list = activity.workspaces()
      const items = list?.items ?? []
      const workspace = items.find((item) => item.sessionIds.includes(session))?.workspaceId ?? ''
      const tree = viewMode() === TREE_VIEW
      const root = scope()
      const at = (key: string): Element | null => root.querySelector(`[data-row-key="workspace:${CSS.escape(key)}"]`)
      // Outermost first; a row unfolded now draws its children by the next pass.
      for (const key of ancestry(workspace, items, placements(store.getSnapshot().repos ?? []), tree)) click(at(key))
      click(at(workspace))
      click(root.querySelector(`[data-ah-root="${CSS.escape(workspace)}"]`))
      if (row === null) click(root.querySelector(`[data-row-key="overflow:${CSS.escape(workspace)}"]`))
      await wait(PASS_MS)
    }
  }

  let last = currentSession(activity.store.get().sessions?.byId)
  if (last !== undefined) void reveal(last)
  const off = activity.store.subscribe(() => {
    const next = currentSession(activity.store.get().sessions?.byId)
    if (next === last) return
    last = next
    if (next !== undefined) void reveal(next)
  })

  return () => {
    disposed = true
    off()
    style.remove()
    for (const row of document.querySelectorAll<HTMLElement>('[data-ah-reveal]')) delete row.dataset[FLASH]
  }
}
