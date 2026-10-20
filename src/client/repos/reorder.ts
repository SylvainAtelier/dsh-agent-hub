/**
 * Moving a worktree among its repository's others, in the tree view. DSH's own drag keeps a
 * workspace among those it nests the same way (by folder), so a worktree made next to the
 * repository and one in its `.worktrees/` never trade places, and it needs a mouse. This one
 * takes over the worktree rows only (the sidebar layer turns DSH's drag off on them):
 *
 * - a mouse (or pen) presses a row and moves it a few pixels;
 * - a finger holds a row still for a moment, then moves it (the list does not scroll meanwhile);
 * - from the keyboard, Alt/⌥ with ↑ or ↓ moves the focused row by one.
 *
 * The row lifts (a copy follows the pointer, the original dims), a line shows where it lands,
 * and Escape puts it back. The order is DSH's own (its `insertBefore`), which the sidebar
 * layer shows: nothing is stored here.
 */

const ROW = '[data-row-key^="workspace:"]'
const SECTION = '[style*="--dsh-workspace-indent"]'
/** What a press on a row means for itself, not for the row. */
const CONTROL = 'button, a, input, textarea, select, [role="menu"], [class*="rowActions"]'
/** How far a mouse moves before the press becomes a drag; how far a finger may drift while held. */
const MOUSE_SLOP = 4
const TOUCH_SLOP = 8
const HOLD_MS = 350
/** Near this close to the list's top or bottom edge, a drag scrolls it. */
const EDGE_PX = 40

const STYLE = `
.ah-drag-ghost {
  position: fixed; z-index: 2147483000; margin: 0; pointer-events: none; box-sizing: border-box;
  border-radius: var(--dsw-radius-md, 8px); opacity: .95; color: var(--ah-fg, CanvasText);
  background: var(--ah-popup, Canvas); box-shadow: var(--ah-shadow, 0 6px 24px rgb(0 0 0 / .18)), 0 0 0 1px var(--ah-line-strong, transparent);
}
.ah-drag-line {
  position: fixed; z-index: 2147483000; height: 2px; margin-top: -1px; pointer-events: none;
  border-radius: 1px; background: var(--ah-accent, Highlight);
}
[data-ah-lifted] { opacity: .4; }
html[data-ah-dragging], html[data-ah-dragging] * { cursor: grabbing !important; -webkit-user-select: none !important; user-select: none !important; }
`

export interface ReorderDeps {
  /** The tree view shows: worktrees move here only then. */
  active(): boolean
  /** Each worktree's repository, as its main tree's workspace id. */
  heads(): ReadonlyMap<string, string>
  /** Every workspace, in DSH's order. */
  order(): readonly string[]
  /** DSH's move: `id` right before `before`, or last. */
  move(id: string, before: string | undefined): Promise<unknown>
}

const idOf = (row: Element): string => (row as HTMLElement).dataset.rowKey?.slice('workspace:'.length) ?? ''
const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`${ROW}[data-row-key="workspace:${CSS.escape(id)}"]`)
const sectionOf = (row: HTMLElement): HTMLElement => row.closest<HTMLElement>(SECTION) ?? row

interface Sibling {
  id: string
  row: HTMLElement
  section: HTMLElement
}

/** The worktrees `id` moves among (itself included), top to bottom as they show; none when it is no worktree. */
function siblings(deps: ReorderDeps, id: string): Sibling[] {
  const heads = deps.heads()
  const head = heads.get(id)
  if (head === undefined) return []
  const out: Sibling[] = []
  for (const [other, owner] of heads) {
    if (owner !== head) continue
    const row = rowOf(other)
    if (row === null || row.getClientRects().length === 0) continue
    out.push({ id: other, row, section: sectionOf(row) })
  }
  return out.sort((a, b) => a.row.getBoundingClientRect().top - b.row.getBoundingClientRect().top)
}

/**
 * Where `id` lands at `index` among `others` (its siblings without it): before the one there,
 * or, past the last, before whatever follows the last in DSH's order.
 */
function anchor(deps: ReorderDeps, id: string, others: readonly Sibling[], index: number): string | undefined {
  if (index < others.length) return others[index]!.id
  const order = deps.order().filter((other) => other !== id)
  const last = others.at(-1)
  return last === undefined ? undefined : order[order.indexOf(last.id) + 1]
}

/** Whether moving `id` before `before` changes DSH's order. */
function changes(deps: ReorderDeps, id: string, before: string | undefined): boolean {
  const order = deps.order()
  const next = order[order.indexOf(id) + 1]
  return before !== id && before !== next
}

function scroller(element: Element): HTMLElement | undefined {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return undefined
}

interface Drag {
  id: string
  row: HTMLElement
  section: HTMLElement
  others: Sibling[]
  ghost: HTMLElement
  line: HTMLElement
  /** The pointer's offset into the row, so the copy keeps its grip. */
  dy: number
  y: number
  index: number
  list?: HTMLElement
  frame?: number
}

interface Press {
  pointer: number
  touch: boolean
  row: HTMLElement
  x: number
  y: number
  hold?: ReturnType<typeof setTimeout>
}

export function reorderWorktrees(deps: ReorderDeps): () => void {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.repos.reorder'
  style.textContent = STYLE
  document.head.appendChild(style)

  let press: Press | undefined
  let drag: Drag | undefined

  const start = (from: Press, y: number): void => {
    press = undefined
    const id = idOf(from.row)
    const all = siblings(deps, id)
    const others = all.filter((sibling) => sibling.id !== id)
    if (others.length === 0) return
    const rect = from.row.getBoundingClientRect()
    const ghost = from.row.cloneNode(true) as HTMLElement
    ghost.removeAttribute('data-row-key')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.classList.add('ah-drag-ghost')
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    const line = document.createElement('div')
    line.className = 'ah-drag-line'
    document.body.append(ghost, line)
    const section = sectionOf(from.row)
    section.dataset.ahLifted = ''
    document.documentElement.dataset.ahDragging = ''
    const list = scroller(from.row)
    drag = { id, row: from.row, section, others, ghost, line, dy: from.y - rect.top, y, index: all.findIndex((sibling) => sibling.id === id), ...(list === undefined ? {} : { list }) }
    if (from.touch) navigator.vibrate?.(8)
    track(y)
    edge()
  }

  /** Follow the pointer: the copy moves, the line goes where the row would land. */
  const track = (y: number): void => {
    if (drag === undefined) return
    drag.y = y
    drag.ghost.style.top = `${y - drag.dy}px`
    let index = drag.others.findIndex((sibling) => {
      const rect = sibling.row.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })
    if (index === -1) index = drag.others.length
    drag.index = index
    const rowRect = drag.row.getBoundingClientRect()
    const at = index < drag.others.length
      ? drag.others[index]!.section.getBoundingClientRect().top
      : drag.others.at(-1)!.section.getBoundingClientRect().bottom
    const indent = drag.others[Math.min(index, drag.others.length - 1)]!.row.getBoundingClientRect().left
    Object.assign(drag.line.style, { top: `${at}px`, left: `${indent + 8}px`, width: `${Math.max(0, rowRect.right - indent - 16)}px` })
  }

  /** Near the list's edge, scroll it (and keep the line in step). */
  const edge = (): void => {
    if (drag?.list === undefined) return
    const { top, bottom } = drag.list.getBoundingClientRect()
    const step = drag.y < top + EDGE_PX ? -Math.ceil((top + EDGE_PX - drag.y) / 4) : drag.y > bottom - EDGE_PX ? Math.ceil((drag.y - bottom + EDGE_PX) / 4) : 0
    if (step !== 0) {
      drag.list.scrollTop += step
      track(drag.y)
    }
    drag.frame = requestAnimationFrame(edge)
  }

  const end = (commit: boolean): void => {
    const done = drag
    drag = undefined
    if (done === undefined) return
    if (done.frame !== undefined) cancelAnimationFrame(done.frame)
    done.ghost.remove()
    done.line.remove()
    delete done.section.dataset.ahLifted
    delete document.documentElement.dataset.ahDragging
    // The press ends in a click on the row, which would open or fold it.
    const swallow = (event: Event): void => { event.stopPropagation(); event.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    if (!commit) return
    const before = anchor(deps, done.id, done.others, done.index)
    if (changes(deps, done.id, before)) void deps.move(done.id, before).catch((error: unknown) => console.warn('[dsh-agent-hub] worktree move failed', error))
  }

  const cancelPress = (): void => {
    if (press?.hold !== undefined) clearTimeout(press.hold)
    press = undefined
  }

  const onDown = (event: PointerEvent): void => {
    if (drag !== undefined || !event.isPrimary || event.button !== 0 || !deps.active()) return
    const target = event.target instanceof Element ? event.target : null
    const row = target?.closest<HTMLElement>(ROW)
    if (row === null || row === undefined || target!.closest(CONTROL) !== null || !deps.heads().has(idOf(row))) return
    cancelPress()
    const touch = event.pointerType === 'touch'
    press = { pointer: event.pointerId, touch, row, x: event.clientX, y: event.clientY }
    if (touch) press.hold = setTimeout(() => { if (press !== undefined) start(press, press.y) }, HOLD_MS)
  }

  const onMove = (event: PointerEvent): void => {
    if (drag !== undefined) return track(event.clientY)
    if (press === undefined || event.pointerId !== press.pointer) return
    const far = Math.hypot(event.clientX - press.x, event.clientY - press.y)
    // A finger that moves before its hold is up scrolls; a mouse that moves drags.
    if (press.touch) { if (far > TOUCH_SLOP) cancelPress() } else if (far > MOUSE_SLOP) start(press, event.clientY)
  }

  const onUp = (): void => {
    cancelPress()
    end(true)
  }

  const onCancel = (): void => {
    cancelPress()
    end(false)
  }

  // While a finger drags, the list must not scroll, nor a long press open a callout.
  const onTouchMove = (event: TouchEvent): void => { if (drag !== undefined) event.preventDefault() }
  const onMenu = (event: Event): void => { if (drag !== undefined || press?.touch === true) event.preventDefault() }

  const onKey = (event: KeyboardEvent): void => {
    if (drag !== undefined && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      return end(false)
    }
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const row = document.activeElement?.closest<HTMLElement>(ROW)
    if (row === null || row === undefined || !deps.active()) return
    const id = idOf(row)
    const all = siblings(deps, id)
    const at = all.findIndex((sibling) => sibling.id === id)
    if (at === -1) return
    event.preventDefault()
    event.stopPropagation()
    const index = event.key === 'ArrowUp' ? at - 1 : at + 1
    if (index < 0 || index >= all.length) return
    const before = anchor(deps, id, all.filter((sibling) => sibling.id !== id), index)
    if (changes(deps, id, before)) void deps.move(id, before).then(() => rowOf(id)?.focus()).catch((error: unknown) => console.warn('[dsh-agent-hub] worktree move failed', error))
  }

  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', onCancel, true)
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  document.addEventListener('contextmenu', onMenu, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onCancel)

  return () => {
    onCancel()
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onCancel, true)
    document.removeEventListener('touchmove', onTouchMove, true)
    document.removeEventListener('contextmenu', onMenu, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onCancel)
    style.remove()
  }
}
