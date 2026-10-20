/**
 * A workspace-files button on every workspace row of the left sidebar, among the row's hover
 * actions: right of its menu, left of its new-session button. The file tree is a tab of the
 * right sidebar, which belongs to the session on screen, so a click on another workspace's
 * row first shows that workspace (its latest session, else a new one, as DSH's new-session
 * button would), then the tab. On the workspace already shown it toggles the tab, as the
 * header's Files button does.
 *
 * DSH draws the rows; the button is ours, added to its actions and kept before the
 * new-session button across re-renders. Only the workspace list is watched.
 */

import type { SidebarControl } from './HeaderButton.tsx'
import { t } from './i18n.ts'
import { follow } from '../dom.ts'

/** DSH's own workspace file tree (ui-sidebar-files). */
export const FILES_KIND = 'files'

const ROW = '[data-row-key^="workspace:"]'
const ACTIONS = '[class*="rowActions"]'
const BUTTON_ATTR = 'data-ah-files'
/** The workspace list's root: its tree, else the left sidebar. */
const ROOT = '[role="tree"], [data-pane="sidebar"], [class*="sidebarCol"]'
/** How long a click waits for the workspace's session to come on screen. */
const REVEAL_MS = 3000
const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>'

interface Workspace {
  workspaceId: string
  path?: string
  sessionIds: readonly string[]
}

export interface RowFilesDeps {
  sidebar: SidebarControl
  /** DSH's `workspaces` list snapshot. */
  workspaces(): { items: readonly Workspace[]; archivedSessionIds?: readonly string[] } | undefined
  /** DSH's `sessions` list snapshot. */
  sessions(): { byId: Record<string, { cwd?: string; updatedAt?: number } | undefined> } | undefined
  openSession(sessionId: string): void
  openWorkspace(workspaceId: string): void
}

const screenSession = (sidebar: SidebarControl): string | undefined =>
  (sidebar.commandTarget(null) as { sessionId?: string } | undefined)?.sessionId

/** Show `workspaceId`'s files: toggle the tab on its session on screen, else bring one on screen first. */
export function openFiles(deps: RowFilesDeps, workspaceId: string): void {
  const find = (): Workspace | undefined => deps.workspaces()?.items.find((item) => item.workspaceId === workspaceId)
  const workspace = find()
  if (workspace === undefined) return
  const belongs = (sessionId: string | undefined): boolean => {
    if (sessionId === undefined) return false
    const current = find() ?? workspace
    return current.sessionIds.includes(sessionId) || (current.path !== undefined && deps.sessions()?.byId[sessionId]?.cwd === current.path)
  }
  const { sidebar } = deps
  const show = (): boolean => {
    const target = sidebar.commandTarget(null) as { sessionId?: string } | undefined
    if (target === undefined || !belongs(target.sessionId)) return false
    sidebar.openTabFromTarget(FILES_KIND, target)
    return true
  }

  if (belongs(screenSession(sidebar))) {
    const showing = (sidebar.isExpanded?.() ?? false) && sidebar.active?.()?.kind === FILES_KIND
    if (showing && sidebar.toggleExpanded !== undefined) sidebar.toggleExpanded()
    else show()
    return
  }

  const archived = new Set(deps.workspaces()?.archivedSessionIds ?? [])
  const byId = deps.sessions()?.byId ?? {}
  let latest: string | undefined
  let latestAt = Number.NEGATIVE_INFINITY
  for (const id of workspace.sessionIds) {
    const at = byId[id]?.updatedAt
    if (archived.has(id) || at === undefined || at <= latestAt) continue
    latest = id
    latestAt = at
  }
  if (latest === undefined) deps.openWorkspace(workspaceId)
  else deps.openSession(latest)
  const until = Date.now() + REVEAL_MS
  const wait = (): void => {
    if (!show() && Date.now() < until) requestAnimationFrame(wait)
  }
  requestAnimationFrame(wait)
}

function button(workspaceId: string, sample: HTMLElement | null, deps: RowFilesDeps): HTMLButtonElement {
  const label = t('headerFiles')
  const element = document.createElement('button')
  element.type = 'button'
  if (sample !== null) element.className = sample.className
  element.setAttribute(BUTTON_ATTR, workspaceId)
  element.setAttribute('aria-label', label)
  element.title = label
  element.innerHTML = ICON
  element.addEventListener('click', (event) => {
    // Not the row's own click (fold, or `root`'s fold).
    event.stopPropagation()
    openFiles(deps, element.getAttribute(BUTTON_ATTR) ?? workspaceId)
  })
  return element
}

export function addRowFiles(deps: RowFilesDeps): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const apply = (root: Element): void => {
    const known = deps.workspaces()?.items
    for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
      const id = row.dataset.rowKey!.slice('workspace:'.length)
      // The actions may be lent to the repository's `root` row; follow them there.
      const actions = row.querySelector<HTMLElement>(`:scope > ${ACTIONS}`)
        ?? root.querySelector<HTMLElement>(`[data-ah-root="${CSS.escape(id)}"] > ${ACTIONS}`)
      if (actions === null) continue
      // Not a workspace (the ungrouped bucket): no files of its own.
      if (known !== undefined && !known.some((item) => item.workspaceId === id)) {
        actions.querySelector(`:scope > [${BUTTON_ATTR}]`)?.remove()
        continue
      }
      // The new-session button: the one not inside the menu's anchor.
      const create = actions.querySelector<HTMLElement>(`:scope > button:not([${BUTTON_ATTR}])`)
      let ours = actions.querySelector<HTMLButtonElement>(`:scope > [${BUTTON_ATTR}]`)
      if (ours === null) ours = button(id, create, deps)
      else if (ours.getAttribute(BUTTON_ATTR) !== id) ours.setAttribute(BUTTON_ATTR, id)
      if (create === null) {
        if (ours.parentElement !== actions) actions.appendChild(ours)
      } else if (ours.nextElementSibling !== create) actions.insertBefore(ours, create)
    }
  }
  const followed = follow({
    locate: () => document.querySelector(ROW)?.closest(ROOT) ?? undefined,
    apply,
    // Our own button moving is not news.
    ours: (node) => (node as Element).hasAttribute?.(BUTTON_ATTR) === true,
  })

  return () => {
    followed.dispose()
    for (const element of document.querySelectorAll(`[${BUTTON_ATTR}]`)) element.remove()
  }
}
