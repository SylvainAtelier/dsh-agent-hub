/** Event delegation over the active Range only; no transcript scans or mutation observers. */
import { MAX_QUOTE } from '../../discussion/types.ts'
import type { DiscussionHub, SelectionDraft } from './store.ts'
const ROW = '[data-chat-flow-kind="user"], [data-chat-flow-kind="assistant-step"]'
/** A reader article: its discussions are kept with it (`doc:<key>`), not with a session. */
const DOC = '[data-discussion-doc]'
const EXCLUDED = 'button, input, textarea, [contenteditable="true"], [data-conversation-region="composer"], [data-discussion-ui], [data-variant="think"], [data-turn-process-inline], [inert]'
const element = (node: Node | null): Element | null => node instanceof Element ? node : node?.parentElement ?? null
export function selectedDiscussion(selection: Selection | null): SelectionDraft | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return
  const anchor = element(selection.anchorNode)
  const focus = element(selection.focusNode)
  if (anchor === null || focus === null || anchor.closest(EXCLUDED) !== null || focus.closest(EXCLUDED) !== null) return
  const doc = anchor.closest<HTMLElement>(DOC)
  const row = doc ?? anchor.closest(ROW)
  if (row === null || focus.closest(doc === null ? ROW : DOC) !== row) return
  const session = doc === null ? row.closest<HTMLElement>('[data-conversation-session]') : null
  const sessionId = doc?.dataset.discussionDoc ?? session?.dataset.conversationSession
  if (!sessionId) return
  const range = selection.getRangeAt(0)
  // A text selection crossing an excluded reasoning/tool region must not leak it into the quote.
  const ancestor = range.commonAncestorContainer
  if (ancestor instanceof Element && ancestor.querySelector('[data-variant="think"], [data-turn-process-inline]') !== null) return
  const quote = selection.toString().trim()
  if (quote === '' || quote.length > MAX_QUOTE) return
  const rects = range.getClientRects()
  const first = rects[0]
  const rect = rects[rects.length - 1]
  if (first === undefined || rect === undefined || rect.width === 0 && rect.height === 0) return
  // The selection end must still be on screen: scrolled under the composer or out of view hides the trigger.
  const hit = document.elementFromPoint(Math.max(0, rect.right - 1), (rect.top + rect.bottom) / 2)
  if (hit === null || !row.contains(hit) && hit.closest('[data-discussion-ui]') === null) return
  const composer = session?.querySelector('[data-conversation-region="composer"]')?.getBoundingClientRect().top
  return { sessionId, quote, source: (doc === null ? row.getAttribute('data-chat-node-key') : doc.dataset.discussionSource) ?? undefined, x: rect.right, y: rect.bottom, top: first.top, floor: Math.min(innerHeight, composer ?? innerHeight) }
}
export function watchSelection(hub: DiscussionHub): () => void {
  let frame = 0
  let dragging = false
  const update = (): void => {
    frame = 0
    if (dragging || document.visibilityState === 'hidden') return
    const active = document.activeElement
    if (active?.closest('[data-discussion-ui]')) return
    const next = selectedDiscussion(window.getSelection())
    if (next !== undefined && hub.client(next.sessionId).getSnapshot().state?.enabled === false) return
    hub.select(next)
  }
  const schedule = (): void => { if (!dragging && frame === 0) frame = requestAnimationFrame(update) }
  const down = (event: PointerEvent): void => { if (!(event.target instanceof Element) || event.target.closest('[data-discussion-ui]') === null) dragging = true }
  const up = (): void => { dragging = false; schedule() }
  // Follow the selection instead of dropping it: a stick-to-bottom transcript scrolls by itself as layout settles.
  const scroll = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('[data-discussion-ui]') !== null) return
    schedule()
  }
  document.addEventListener('selectionchange', schedule)
  document.addEventListener('pointerdown', down, { passive: true })
  document.addEventListener('pointerup', up, { passive: true })
  document.addEventListener('pointercancel', up, { passive: true })
  document.addEventListener('keyup', schedule)
  document.addEventListener('scroll', scroll, { capture: true, passive: true })
  window.addEventListener('resize', scroll)
  return () => {
    cancelAnimationFrame(frame)
    document.removeEventListener('selectionchange', schedule)
    document.removeEventListener('pointerdown', down)
    document.removeEventListener('pointerup', up)
    document.removeEventListener('pointercancel', up)
    document.removeEventListener('keyup', schedule)
    document.removeEventListener('scroll', scroll, true)
    window.removeEventListener('resize', scroll)
  }
}
