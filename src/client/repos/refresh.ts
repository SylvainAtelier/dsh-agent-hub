/**
 * A refresh button in the left sidebar's workspace header, right of its search button (first of
 * the header's actions, so it hides with them while the search is open). A click registers
 * every working tree of every registered repository: what registering a workspace does by
 * itself, for repositories that missed it (registered before this version, or while the plugin
 * was not running) and worktrees made later from the command line.
 *
 * DSH draws the header; the button is ours, styled as its add-workspace button and kept first
 * across re-renders. Only the header is watched. DSH caps the actions at two buttons' width
 * (`max-width: 60px; overflow: hidden`), which would clip its own last one, the add-workspace
 * button: while ours is there the cap is lifted, except while DSH hides the actions.
 */

import { t } from '../git/i18n.ts'
import type { ReposStore } from './api.ts'
import { follow } from '../dom.ts'

const SEARCH = '[class*="sectionHeader"] [class*="searchButton"]'
const HEADER = '[class*="sectionHeader"]'
const ACTIONS = '[class*="headerActions"]'
const BUTTON_ATTR = 'data-ah-adopt'
/** How long the outcome stays as the button's tooltip. */
const OUTCOME_MS = 4000
const CSS = `[class*="headerActions"]:has(> [${BUTTON_ATTR}]):not([class*="headerActionsHidden"]) { max-width: none; }`
const ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>'

function label(element: HTMLElement, text: string): void {
  element.setAttribute('aria-label', text)
  element.title = text
}

function button(store: ReposStore, sample: Element | null): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  if (sample !== null) element.className = sample.className
  element.setAttribute(BUTTON_ATTR, '')
  element.innerHTML = ICON
  label(element, t('treesAdopt'))
  let reset: ReturnType<typeof setTimeout> | undefined
  element.addEventListener('click', (event) => {
    event.stopPropagation()
    if (element.disabled) return
    clearTimeout(reset)
    element.disabled = true
    label(element, t('treesAdopting'))
    const spin = element.querySelector('svg')?.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity })
    store.adopt().then(
      (added) => label(element, added > 0 ? t('treesAdopted', { n: added }) : t('treesAdoptedNone')),
      (error: unknown) => label(element, t('treesAdoptFailed', { error: error instanceof Error ? error.message : String(error) })),
    ).finally(() => {
      spin?.cancel()
      element.disabled = false
      reset = setTimeout(() => label(element, t('treesAdopt')), OUTCOME_MS)
    })
  })
  return element
}

export function addRefresh(store: ReposStore): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let ours: HTMLButtonElement | undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.refresh'
  style.textContent = CSS
  document.head.appendChild(style)

  const apply = (header: Element): void => {
    const actions = header.querySelector<HTMLElement>(`:scope > ${ACTIONS}`)
    if (actions === null || actions === undefined) return
    ours ??= button(store, actions.querySelector('button[class*="iconButton"]') ?? actions.querySelector(`button:not([${BUTTON_ATTR}])`))
    if (actions.firstElementChild !== ours) actions.insertBefore(ours, actions.firstElementChild)
  }
  const followed = follow({
    locate: () => document.querySelector(SEARCH)?.closest(HEADER) ?? undefined,
    apply,
    // Our own button moving is not news.
    ours: (node) => node === ours,
  })

  return () => {
    followed.dispose()
    ours?.remove()
    style.remove()
  }
}
