/**
 * The left sidebar's top, above the workspace list: DSH's 新会话 button and its panel list (one
 * full row per panel, more with every plugin that adds one). On a phone they leave the
 * workspace list a few rows, so the top folds: folded, the panels become one grid of icons
 * (wrapping, never scrolling out of sight) with 新会话 as its first cell, in its own raised
 * look, as the primary action. Every entry stays one tap away; only the titles fold. The cells
 * are sized to the sidebar's width so they stay on one row whenever they fit at 36px (40px on
 * touch); past that the rows are balanced rather than leaving a lone cell.
 *
 * One toggle folds and unfolds. It sits just left of DSH's own sidebar toggle, wherever DSH
 * puts that: the strip above the logo on the macOS desktop (beside the traffic lights), the
 * logo's row elsewhere. It takes DSH's button look, takes no row of its own, folded or not, and
 * reads as a header action rather than one of the panels. Its icon is a disclosure triangle,
 * pointing down while the titles show and right while they are folded, turning between the two.
 * Untouched, the top follows the device: folded on a phone (the same narrow touch screen the
 * mobile layer targets), as DSH draws it elsewhere. A choice that differs from that default is
 * remembered (per browser, so a phone and a desktop keep their own); choosing the default again
 * forgets it.
 *
 * The panel icons are drawn in one weight: the plugin's own at DSH's 1px stroke, and the
 * context plugin's filled sheet (which reads paler than its neighbours) repainted as a 1px
 * outline, matched by its mask's id so a changed icon is left alone.
 *
 * Pure CSS on DSH's CSS-module class suffixes, keyed by one attribute on <html>, which React
 * never touches. The only element added is the toggle; nothing of DSH's is moved. A header
 * not drawn the expected way leaves the toggle at the panel list's right edge instead. The
 * collapsed rail is left alone.
 */

import { t } from '../git/i18n.ts'
import { follow } from '../dom.ts'

const NAV = 'nav[class*="_panelList"]'
/** The sidebar while wide (not the collapsed rail). */
const WIDE = ':not([class*="_collapsed"])'
const NEW = '[class$="_newSession"]'
const ROW = '[class*="_panelRow"]'
/** The sidebar's header rows: the macOS desktop's strip above the logo, and the logo's row. */
const HEAD = ':is([class*="_topStrip"], [class*="_logoRow"])'
/** DSH's sidebar toggle in a header row; the fold toggle goes just before it. */
const SIDE = '[class*="_toggle"]'
const TOGGLE = 'ah-top-toggle'
const ATTR = 'data-ah-top'
const KEY = 'dsh-agent-hub.sidebar.top'
/** The devices whose top folds by default: the mobile layer's narrow touch screens. */
const AUTO = '(pointer: coarse) and (max-width: 820px)'
const svg = (body: string): string => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
/** A disclosure triangle, pointing down; turned to point right while folded. */
const TRIANGLE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round" aria-hidden="true"><path d="M4.75 6.25h6.5L8 10.25z"/></svg>'
/** The context plugin's insights entry, as a 1px outline sheet (a mask, painted in the row's color). */
const SHEET = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="2"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3"/></svg>')}")`

type Mode = 'compact' | 'full'

/** The folded layout, under `scope` (the <html> that asks for it). */
function folded(scope: string): string {
  const nav = `${scope} ${WIDE} > ${NAV}`
  const lead = `${scope} ${WIDE} > ${NEW}:has(+ ${NAV})`
  return `
${nav} {
  display: grid; grid-template-columns: repeat(auto-fill, var(--ah-top-cell)); justify-content: space-between;
  gap: 4px 2px; margin: 0 2px 8px;
}
/* The first cell is 新会话's, which sits on it. */
${lead} + nav::before { content: ''; }
${nav} > ${ROW} { position: relative; width: var(--ah-top-cell); height: var(--ah-top-tall); min-height: 0; margin: 0; padding: 0; justify-content: center; }
${nav} [class*="_panelTitle"] { display: none; }
${nav} > .${TOGGLE} { position: relative; top: auto; right: auto; grid-column: -2 / -1; order: 1; width: var(--ah-top-cell); height: var(--ah-top-tall); opacity: 1; }
${lead} {
  position: relative; z-index: 1; align-self: flex-start; width: var(--ah-top-cell); height: var(--ah-top-tall);
  min-width: 0; min-height: 0; margin-right: 0; margin-bottom: calc(-1 * var(--ah-top-tall)); margin-left: 2px; padding: 0;
  overflow: visible;
}
${lead} [class*="_newSessionLabelMask"] { flex: none; mask-image: none; -webkit-mask-image: none; }
${lead} [class*="_newSessionContent"] { width: auto; }
${lead} [class*="_newSessionContent"] > span, ${lead} [class*="_newSessionShortcut"] { display: none; }
${lead} svg { width: 16px; height: 16px; }
/* Titles folded away: a pointer still reads them, as DSH's own tooltip would show them. */
@media (hover: hover) {
  ${nav} > ${ROW}::after, ${lead}::after {
    content: attr(aria-label); position: absolute; top: calc(100% + 6px); left: 50%; z-index: 100; transform: translateX(-50%);
    width: max-content; padding: 3px 7px; border-radius: var(--dsw-radius-sm, 4px); pointer-events: none;
    background: var(--dsw-alias-tooltip-bg, #1f2328); color: var(--dsw-static-neutral-bluish-00, #fff);
    font-size: 13px; font-weight: 400; line-height: 20px; white-space: nowrap;
    opacity: 0; visibility: hidden; transition: opacity 120ms ease, visibility 0s linear 120ms;
  }
  ${nav} > ${ROW}:first-of-type::after, ${lead}::after { left: 0; transform: none; }
  ${nav} > ${ROW}:hover::after, ${lead}:hover::after { opacity: 1; visibility: visible; transition-delay: 500ms, 500ms; }
}
`
}

const CSS = `
/* Six cells (新会话 and five panels) share a row of a 280px sidebar; a finger gets taller ones. */
:root { --ah-top-cell: 40px; --ah-top-tall: 40px; }
@media (pointer: coarse) { :root { --ah-top-tall: 44px; } }
.${TOGGLE} { position: relative; }
.${TOGGLE}:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
/* Beside DSH's sidebar toggle, the two read as one pair (the logo row's gap closed, leaving the logo its width). */
[class*="_logoRow"] > .${TOGGLE} { margin-right: -8px; }
/* Full screen moves the strip's toggle to the left edge: the fold toggle follows it there. */
[data-fullscreen] [class*="_topStrip"] > .${TOGGLE} { order: 1; }
.${TOGGLE} > svg { transition: transform 160ms ease-out; }
.${TOGGLE}[aria-expanded="false"] > svg { transform: rotate(-90deg); }
@media (prefers-reduced-motion: reduce) { .${TOGGLE} > svg { transition: none; } }
[class*="_collapsed"] .${TOGGLE} { display: none; }
@media (pointer: coarse) {
  ${HEAD} > .${TOGGLE}::after { content: ''; position: absolute; inset: -8px 0; }
}
/* No header to sit on: the panel list's right edge, found by a pointer where it looks. */
${WIDE} > ${NAV} { position: relative; }
${NAV} > .${TOGGLE} {
  appearance: none; position: absolute; top: 6px; right: 6px; z-index: 1; box-sizing: border-box; display: inline-flex;
  align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none;
  border-radius: var(--dsw-radius-md, 6px); background: transparent; color: var(--dsw-alias-label-tertiary, currentColor); cursor: pointer;
}
${NAV} > .${TOGGLE}:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); color: var(--dsw-alias-label-primary, currentColor); }
@media (hover: hover) {
  ${NAV}:not(:hover, :focus-within) > .${TOGGLE}[aria-expanded="true"] { opacity: 0; }
}
/* The context plugin's filled sheet, redrawn in the 1px outline of its neighbours. */
${NAV} > ${ROW} svg:has(> defs > mask[id^="dsh-context-sheet"]) {
  background: currentColor; -webkit-mask: ${SHEET} center / 100% no-repeat; mask: ${SHEET} center / 100% no-repeat;
}
${NAV} > ${ROW} svg:has(> defs > mask[id^="dsh-context-sheet"]) > * { display: none; }
${folded(`html[${ATTR}="compact"]`)}
@media ${AUTO} {
${folded(`html:not([${ATTR}])`)}
}
`

function stored(): Mode | undefined {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'compact' || value === 'full' ? value : undefined
  } catch {
    return undefined
  }
}

function store(mode: Mode | undefined): void {
  try {
    if (mode === undefined) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch {
    // Private mode: the choice lasts the page.
  }
}

/** Folded cell widths: narrow enough to keep the cells on one row, never under what a tap or click needs. */
const CELL_MIN = 36
const CELL_MIN_TOUCH = 40
const CELL_MAX = 48
const CELL_GAP = 2

/**
 * Sizes the folded cells (--ah-top-cell on <html>) to the panel list's width: as many cells per
 * row as fit at the minimum size, rows balanced (never one orphan cell on a second row), the
 * cells then widened to fill the row up to the maximum. Re-run on a resize and when panels come
 * or go. The height is untouched, so a target only ever gets wider than its floor.
 */
function fitCells(html: HTMLElement, toggle: HTMLElement): { attach(nav: Element | null): void; dispose(): void } {
  const coarse = matchMedia('(pointer: coarse)')
  let current: Element | null = null
  const measure = (): void => {
    if (current === null) return
    const width = current.clientWidth
    if (width === 0) return
    const lead = current.previousElementSibling?.matches(NEW) === true ? 1 : 0
    const inside = toggle.parentElement === current ? 1 : 0
    const count = current.querySelectorAll(`:scope > ${ROW}`).length + lead + inside
    if (count === 0) return
    const min = coarse.matches ? CELL_MIN_TOUCH : CELL_MIN
    const perRow = Math.max(1, Math.floor((width + CELL_GAP) / (min + CELL_GAP)))
    const cols = Math.ceil(count / Math.ceil(count / perRow))
    const cell = Math.min(CELL_MAX, Math.max(min, Math.floor((width - CELL_GAP * (cols - 1)) / cols)))
    html.style.setProperty('--ah-top-cell', `${cell}px`)
  }
  const resize = new ResizeObserver(measure)
  const mutate = new MutationObserver(measure)
  coarse.addEventListener('change', measure)
  return {
    attach(nav) {
      if (nav === current) return
      resize.disconnect()
      mutate.disconnect()
      current = nav
      if (nav === null) return
      resize.observe(nav)
      mutate.observe(nav, { childList: true })
      measure()
    },
    dispose() {
      resize.disconnect()
      mutate.disconnect()
      coarse.removeEventListener('change', measure)
      html.style.removeProperty('--ah-top-cell')
    },
  }
}

export function foldTop(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || typeof matchMedia === 'undefined' || typeof ResizeObserver === 'undefined') return () => {}
  const html = document.documentElement
  const auto = matchMedia(AUTO)
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.top'
  style.textContent = CSS
  document.head.appendChild(style)

  let choice = stored()
  const mode = (): Mode => choice ?? (auto.matches ? 'compact' : 'full')

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = TOGGLE
  toggle.innerHTML = TRIANGLE
  const sync = (): void => {
    if (choice === undefined) html.removeAttribute(ATTR)
    else html.setAttribute(ATTR, choice)
    const expanded = mode() === 'full'
    const text = t(expanded ? 'panelsCollapse' : 'panelsExpand')
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-label', text)
    toggle.title = text
  }
  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    const next: Mode = mode() === 'full' ? 'compact' : 'full'
    // Back to the device's default: forget the choice, so the default leads again.
    choice = next === (auto.matches ? 'compact' : 'full') ? undefined : next
    store(choice)
    sync()
  })
  auto.addEventListener('change', sync)
  sync()

  const fit = fitCells(html, toggle)

  // The toggle lives in a header row (or in the panel list), all children of the sidebar; the
  // sidebar is what is followed, and the header row too: unfolding the rail draws the logo in
  // before DSH's toggle, which is after the fold toggle. A row re-rendering may drop the toggle
  // without its parent noticing: each tick puts it back too.
  const followed = follow({
    locate: () => document.querySelector(NAV)?.parentElement ?? undefined,
    apply: (parent) => {
      const nav = parent.querySelector(`:scope > ${NAV}`)
      const side = parent.querySelector(`:scope > ${HEAD} > ${SIDE}`)
      fit.attach(nav)
      if (nav === null) toggle.remove()
      else if (side === null) {
        toggle.className = TOGGLE
  toggle.innerHTML = TRIANGLE
        if (toggle.parentElement !== nav) nav.appendChild(toggle)
      } else {
        // DSH's button look (its hover, size and icon box), under its hashed class name.
        toggle.className = [TOGGLE, ...[...side.classList].filter((name) => name.endsWith('_iconButton'))].join(' ')
        if (toggle.nextElementSibling !== side) side.before(toggle)
      }
    },
    observe: { childList: true },
    ours: (node) => node === toggle,
    tick: () => followed.schedule(),
  })
  const head = follow({
    locate: () => document.querySelector(`${HEAD}:has(> ${SIDE})`) ?? undefined,
    apply: () => followed.schedule(),
    observe: { childList: true },
    ours: (node) => node === toggle,
  })

  return () => {
    head.dispose()
    followed.dispose()
    fit.dispose()
    auto.removeEventListener('change', sync)
    toggle.remove()
    style.remove()
    html.removeAttribute(ATTR)
  }
}
