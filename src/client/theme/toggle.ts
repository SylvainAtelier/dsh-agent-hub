/**
 * A light/dark switch in the left sidebar's foot, right of the account button
 * (已登录 DeepSeek). The account button fills the host's `sidebar.settings`
 * slot, which takes a single entry, so the switch is placed into that row in
 * the page next to it and put back whenever the row re-renders without it.
 *
 * It drives ui-theme's own service: a click writes the opposite of the colour
 * scheme on screen as an explicit preference, the same write as 设置 → 外观.
 */

import { onBodyChange } from '../dom.ts'

/** The parts of ui-theme's `theme` service the switch uses. */
export interface ThemeService {
  getTheme(): { preference: string; active: { colorScheme?: 'light' | 'dark' } }
  setTheme(id: string): void
}

export interface ToggleDeps {
  theme: ThemeService
  /** Subscribe to `theme/change`; returns the unsubscribe. */
  onChange(listener: () => void): () => void
  label(key: 'theme.toLight' | 'theme.toDark'): string
}

/** The account row: settings-general's trigger row inside the sidebar's settings area. */
export const ROW = '[class*="settingsArea"] [class*="triggerRow"]'
export const ATTR = 'data-ah-theme-toggle'

/**
 * Keep `button` in the account row right after `anchorOf(row)`, and put it
 * back whenever the row re-renders without it. The row is remembered while it
 * stays on the page, so a check while the transcript streams is a few pointer
 * comparisons; the page is searched again only once the row is gone. Returns
 * the stop.
 */
export function keepInFoot(button: HTMLElement, anchorOf: (row: HTMLElement, launcher: Element) => Element): () => void {
  let row: HTMLElement | null = null
  const place = (): void => {
    if (row?.isConnected !== true) row = document.querySelector<HTMLElement>(ROW)
    if (row === null) return
    const launcher = row.firstElementChild
    if (launcher === null || launcher === button) return
    const anchor = anchorOf(row, launcher)
    if (button.parentElement === row && button.previousElementSibling === anchor) return
    anchor.after(button)
  }
  place()
  return onBodyChange(place)
}

const CSS = `
[${ATTR}] {
  flex: none; width: 28px; height: 28px; padding: 0; border: none; background: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary);
}
[${ATTR}]:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[${ATTR}]:focus-visible {
  outline: 2px solid var(--ah-focus);
  outline-offset: -2px;
}
[class*="railRow"] > [${ATTR}] { display: none; }
${ROW} > :first-child:not([${ATTR}]) {
  font-size: 0; flex: none; width: 28px; min-width: 0; max-width: none; height: 28px; padding: 0; gap: 0;
  border: none; background: none; box-shadow: none; cursor: pointer; overflow: hidden;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary);
}
${ROW} > :first-child:not([${ATTR}]):hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
${ROW} > :first-child:not([${ATTR}]):focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
${ROW} > :first-child:not([${ATTR}]) > * { flex: none; width: auto; min-width: 0; margin: 0; }
${ROW} > :first-child:not([${ATTR}]) *:not(svg):not(:has(svg)):not(:has(*)) { font-size: 0; }
`

const SVG = 'http://www.w3.org/2000/svg'
/** Sun: shown in dark mode, switches to light. */
const SUN = '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/>'
/** Moon: shown in light mode, switches to dark. */
const MOON = '<path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z"/>'

export function isDark(theme: ThemeService): boolean {
  const scheme = theme.getTheme().active.colorScheme
  return scheme !== undefined ? scheme === 'dark' : document.body.hasAttribute('data-ds-dark-theme')
}

export function mountThemeToggle(deps: ToggleDeps): () => void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)

  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(ATTR, '')
  const icon = document.createElementNS(SVG, 'svg')
  for (const [k, v] of Object.entries({ width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) icon.setAttribute(k, v)
  button.append(icon)

  const render = (): void => {
    const dark = isDark(deps.theme)
    icon.innerHTML = dark ? SUN : MOON
    const label = deps.label(dark ? 'theme.toLight' : 'theme.toDark')
    button.setAttribute('aria-label', label)
    button.title = label
  }
  button.addEventListener('click', () => {
    try {
      deps.theme.setTheme(isDark(deps.theme) ? 'light' : 'dark')
    } catch {
      // A registry without the built-in themes: leave the preference alone.
    }
    render()
  })

  render()
  // Right after the account launcher.
  const offPlace = keepInFoot(button, (_row, launcher) => launcher)
  const offChange = deps.onChange(render)
  return () => {
    offPlace()
    offChange()
    button.remove()
    style.remove()
  }
}
