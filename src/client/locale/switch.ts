/**
 * An interface-language switch in the left sidebar's foot, last in the row of
 * small icon buttons right of the account button (after restart, else after
 * the light/dark switch). It drives the host's own locale service, the same
 * write as 设置 → 语言, so the choice persists and every surface follows.
 *
 * Two languages (the built-in 中文 / English): a click swaps them at once.
 * More (a language pack added through `addLanguage`): a click opens a small
 * menu of every language, the active one checked.
 */

import { t } from '../i18n.ts'
import { ATTR as THEME_ATTR, keepInFoot } from '../theme/toggle.ts'

/** The parts of the host's `locale` service the switch uses. */
export interface LocaleService {
  getLocale(): LocaleSnapshot
  setLocale(id: string): void
  subscribe(listener: () => void): () => void
}

export interface LocaleSnapshot {
  active: string
  locales: ReadonlyArray<{ id: string; label: string }>
}

export const ATTR = 'data-ah-locale-switch'
const RESTART_ATTR = 'data-ah-restart'
const MENU = 'ah-locale-menu'

/** The language a single click moves to: the other one of two, or none (open the menu). */
export function nextLocale(snapshot: LocaleSnapshot): { id: string; label: string } | undefined {
  if (snapshot.locales.length !== 2) return undefined
  return snapshot.locales.find((locale) => locale.id !== snapshot.active)
}

const CSS = `
[${ATTR}] {
  position: relative; flex: none; width: 28px; height: 28px; padding: 0; border: none; background: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary);
  -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease;
}
[${ATTR}]:hover, [${ATTR}][aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[${ATTR}]:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
/* A finger-tall target without widening the row or covering the neighbours. */
@media (pointer: coarse) { [${ATTR}]::before { content: ""; position: absolute; inset: -8px 0; } }
[class*="railRow"] > [${ATTR}] { display: none; }

.${MENU} {
  position: fixed; z-index: var(--ah-z-menu, 10000); min-width: 140px; max-width: min(240px, calc(100vw - 16px));
  margin: 0; padding: 4px; box-sizing: border-box; border: 1px solid var(--ah-line); border-radius: var(--ah-radius, 8px);
  background: var(--ah-popup); color: var(--ah-fg); box-shadow: var(--ah-shadow); font: inherit; font-size: 13px;
  transform-origin: bottom left; animation: ah-locale-in 140ms var(--ah-ease);
}
.${MENU} > button {
  appearance: none; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 0 8px;
  border: 0; border-radius: var(--ah-radius-sm, 6px); background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer;
}
.${MENU} > button:hover, .${MENU} > button:focus-visible { background: var(--ah-hover); outline: none; }
.${MENU} > button > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${MENU} > button > svg { flex: none; visibility: hidden; color: var(--ah-fg2); }
.${MENU} > button[aria-checked="true"] { font-weight: 600; }
.${MENU} > button[aria-checked="true"] > svg { visibility: visible; }
@media (pointer: coarse) { .${MENU} > button { min-height: 40px; } }
@keyframes ah-locale-in { from { opacity: 0; transform: translateY(4px) scale(.97); } }
@media (prefers-reduced-motion: reduce) {
  [${ATTR}] { transition: none; }
  .${MENU} { animation: none; }
}
`

/** Lucide "languages": 文 and A, recognisable at 15px. */
const ICON = '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

export function mountLocaleSwitch(locale: LocaleService): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub'
  style.textContent = CSS
  document.head.append(style)

  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(ATTR, '')
  button.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON}</svg>`

  let menu: HTMLDivElement | undefined
  let offMenu: (() => void) | undefined

  const snapshot = (): LocaleSnapshot | undefined => {
    try {
      return locale.getLocale()
    } catch {
      return undefined
    }
  }

  const render = (): void => {
    const current = snapshot()
    const next = current === undefined ? undefined : nextLocale(current)
    const label = next !== undefined ? t('locale.switchTo', { name: next.label }) : t('locale.choose')
    button.setAttribute('aria-label', label)
    button.title = label
    if (next === undefined) button.setAttribute('aria-haspopup', 'menu')
    else {
      button.removeAttribute('aria-haspopup')
      button.removeAttribute('aria-expanded')
    }
    button.hidden = current === undefined || current.locales.length < 2
  }

  const set = (id: string): void => {
    try {
      locale.setLocale(id)
    } catch {
      // A language removed meanwhile: keep the current one.
    }
  }

  const closeMenu = (refocus: boolean): void => {
    offMenu?.()
    offMenu = undefined
    menu?.remove()
    menu = undefined
    button.setAttribute('aria-expanded', 'false')
    if (refocus && button.isConnected) button.focus()
  }

  const openMenu = (current: LocaleSnapshot): void => {
    const list = document.createElement('div')
    list.className = MENU
    list.setAttribute('role', 'menu')
    list.setAttribute('aria-label', t('locale.choose'))
    for (const item of current.locales) {
      const row = document.createElement('button')
      row.type = 'button'
      row.setAttribute('role', 'menuitemradio')
      row.setAttribute('aria-checked', String(item.id === current.active))
      row.tabIndex = -1
      const name = document.createElement('span')
      name.textContent = item.label
      row.append(name)
      row.insertAdjacentHTML('beforeend', CHECK)
      row.addEventListener('click', () => {
        closeMenu(true)
        set(item.id)
      })
      list.append(row)
    }
    document.body.append(list)
    menu = list
    button.setAttribute('aria-expanded', 'true')

    // Above the button, its left edge aligned, kept inside the viewport.
    const anchor = button.getBoundingClientRect()
    const box = list.getBoundingClientRect()
    list.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`
    list.style.top = `${Math.max(8, anchor.top - box.height - 6)}px`

    const rows = [...list.querySelectorAll<HTMLButtonElement>('button')]
    const checked = rows.find((row) => row.getAttribute('aria-checked') === 'true') ?? rows[0]
    checked?.focus()

    const onKey = (event: KeyboardEvent): void => {
      const at = rows.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        rows[(at + step + rows.length) % rows.length]?.focus()
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus()
      }
    }
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.contains(target) && !button.contains(target)) closeMenu(false)
    }
    const onResize = (): void => closeMenu(false)
    list.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('resize', onResize)
    offMenu = () => {
      list.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('resize', onResize)
    }
  }

  button.addEventListener('click', () => {
    if (menu !== undefined) return closeMenu(true)
    const current = snapshot()
    if (current === undefined) return
    const next = nextLocale(current)
    if (next !== undefined) set(next.id)
    else openMenu(current)
  })

  render()
  // Last of the foot's icon buttons.
  const offPlace = keepInFoot(button, (row, launcher) => row.querySelector(`:scope > [${RESTART_ATTR}]`) ?? row.querySelector(`:scope > [${THEME_ATTR}]`) ?? launcher)
  // The host updates <html lang> with the switch; read the copy after it settles.
  const offLocale = locale.subscribe(() => queueMicrotask(render))
  return () => {
    offPlace()
    offLocale()
    closeMenu(false)
    button.remove()
    style.remove()
  }
}
