/**
 * The ref badges' quick tooltip: a badge's name is cut at 140px, and the
 * native title waits a second before it shows. One element on <body>, moved
 * from badge to badge, so the memoised graph rows hold no hover state: it
 * opens after a short beat, flush with the badge's left edge as if the badge
 * had grown, and closes on leave, press, scroll or Escape.
 */

export interface TipContent {
  /** Shown whole; folders before the last slash are quieter. */
  name: string
  /** Lane color, drawn as the edge stripe. */
  color?: string
  /** One quiet line under the name. */
  meta?: string
  /** More names, one per line (the "+3" badge). */
  list?: readonly string[]
}

const DELAY = 90
const GAP = 6
const MARGIN = 8

let tip: HTMLDivElement | undefined
let owner: Element | undefined
let timer: ReturnType<typeof setTimeout> | undefined

function nameNode(name: string): HTMLElement {
  const node = document.createElement('div')
  node.className = 'gp-tip-name'
  const cut = name.lastIndexOf('/') + 1
  if (cut > 0) {
    const head = document.createElement('span')
    head.className = 'gp-tip-dir'
    // A break after each slash, so a long path wraps between its parts.
    for (const part of name.slice(0, cut).split(/(?<=\/)/)) head.append(part, document.createElement('wbr'))
    node.append(head)
  }
  node.append(name.slice(cut))
  return node
}

function onAway(event: Event): void {
  if (event instanceof KeyboardEvent && event.key !== 'Escape') return
  hideTip()
}

function place(target: Element): void {
  if (tip === undefined) return
  const anchor = target.getBoundingClientRect()
  const box = tip.getBoundingClientRect()
  const left = Math.max(MARGIN, Math.min(anchor.left - 1, innerWidth - box.width - MARGIN))
  const above = anchor.top - GAP - box.height
  const top = above >= MARGIN ? above : Math.min(anchor.bottom + GAP, innerHeight - box.height - MARGIN)
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  tip.dataset.side = above >= MARGIN ? 'top' : 'bottom'
}

function open(target: Element, content: TipContent): void {
  if (!target.isConnected) return
  tip ??= Object.assign(document.createElement('div'), { className: 'gp-tip', role: 'tooltip', id: 'gp-tip' })
  tip.replaceChildren(nameNode(content.name))
  if (content.list !== undefined) {
    const list = document.createElement('ul')
    list.className = 'gp-tip-list'
    for (const name of content.list) list.append(Object.assign(document.createElement('li'), { textContent: name }))
    tip.append(list)
  }
  if (content.meta !== undefined) tip.append(Object.assign(document.createElement('div'), { className: 'gp-tip-meta', textContent: content.meta }))
  tip.style.setProperty('--gp-lane', content.color ?? 'var(--ah-accent)')
  tip.style.transform = 'translate(-9999px, 0)'
  if (!tip.isConnected) document.body.append(tip)
  place(target)
  tip.dataset.open = ''
  target.setAttribute('aria-describedby', 'gp-tip')
  addEventListener('scroll', onAway, { capture: true, passive: true })
  addEventListener('wheel', onAway, { capture: true, passive: true })
  addEventListener('keydown', onAway, true)
  addEventListener('blur', onAway)
}

/** Open for `target` after a beat; moving straight from one badge to the next switches without one. */
export function showTip(target: Element, content: TipContent): void {
  clearTimeout(timer)
  owner = target
  if (tip?.dataset.open !== undefined) open(target, content)
  else timer = setTimeout(() => { if (owner === target) open(target, content) }, DELAY)
}

/** Close, if `target` (when given) is still the one it is open for. */
export function hideTip(target?: Element): void {
  if (target !== undefined && target !== owner) return
  clearTimeout(timer)
  owner?.removeAttribute('aria-describedby')
  owner = undefined
  if (tip !== undefined) delete tip.dataset.open
  removeEventListener('scroll', onAway, { capture: true })
  removeEventListener('wheel', onAway, { capture: true })
  removeEventListener('keydown', onAway, true)
  removeEventListener('blur', onAway)
}

/** Pointer and keyboard-focus handlers for an element that carries a tip; touch keeps its long-press menu. */
export function tipHandlers(content: () => TipContent): {
  onPointerEnter: (event: { pointerType: string; currentTarget: Element }) => void
  onPointerLeave: (event: { currentTarget: Element }) => void
  onPointerDown: (event: { currentTarget: Element }) => void
  onFocus: (event: { currentTarget: Element }) => void
  onBlur: (event: { currentTarget: Element }) => void
} {
  return {
    onPointerEnter: (event) => { if (event.pointerType === 'mouse') showTip(event.currentTarget, content()) },
    onPointerLeave: (event) => hideTip(event.currentTarget),
    onPointerDown: (event) => hideTip(event.currentTarget),
    onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) showTip(event.currentTarget, content()) },
    onBlur: (event) => hideTip(event.currentTarget),
  }
}
