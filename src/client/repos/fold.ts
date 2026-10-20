/**
 * One button in the left sidebar's workspace header, right beside its search button, that folds
 * or unfolds every workspace at once. It shows what a click will do: while any workspace is open
 * (in sight), its two chevrons point inward and a click folds them all, nested ones and `root`
 * rows included; once all are folded they point outward and a click opens them all, level by
 * level, as each level's children appear.
 *
 * It acts as a person would: by clicking each row's own toggle (DSH's, or `root`'s), so DSH's
 * persisted fold state stays the only truth. It sits outside DSH's header actions (whose width
 * DSH caps), so it takes none of their room: the section label gives way first. It hides with
 * the actions while the search is open, in the rail, and whenever no row folds (the flat list,
 * search results).
 */

import { t } from '../git/i18n.ts'
import { follow } from '../dom.ts'

const HEADER = '[class*="_sectionHeader"]'
const SLOT = '[class*="_searchSlot"]'
/** Every row that folds: DSH's workspace rows and our `root` rows. */
const FOLDS = '[data-row-key^="workspace:"][aria-expanded], [data-ah-root][aria-expanded]'
const BUTTON = 'ah-fold-all'
/** How many levels "expand all" opens, at most (each level appears after the last one opened). */
const MAX_PASSES = 12
const PASS_MS = 60
/** Two chevrons; each flips on its own center between "fold" (inward) and "unfold" (outward). */
const ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5 8 6l3.5-3.5"/><path d="M4.5 13.5 8 10l3.5 3.5"/></svg>'

const EASE = 'var(--ds-ease-in-out, ease)'
const CSS = `
.${BUTTON} {
  appearance: none; box-sizing: border-box; display: inline-flex; flex: none; align-items: center; justify-content: center;
  width: 28px; height: 28px; max-width: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm, 4px);
  background: transparent; color: var(--dsw-alias-label-secondary, currentColor); cursor: pointer; overflow: hidden;
  opacity: 1; visibility: visible;
  transition: max-width .18s ${EASE}, margin .18s ${EASE}, opacity .12s ${EASE}, transform .18s ${EASE}, visibility 0s linear, background-color .12s ${EASE};
}
.${BUTTON}[hidden] { display: none; }
.${BUTTON}:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); }
.${BUTTON}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight)); outline-offset: -2px;
}
.${BUTTON} > svg path { transform-box: fill-box; transform-origin: center; transition: transform .2s ${EASE}; }
.${BUTTON}[data-action="expand"] > svg path { transform: scaleY(-1); }
/* The search open: away with DSH's actions, the same way. */
${SLOT}[class*="_searchSlotExpanded"] ~ .${BUTTON} {
  max-width: 0; margin-left: -4px; opacity: 0; visibility: hidden; pointer-events: none; transform: translateX(4px);
  transition-delay: 0s, 0s, 0s, 0s, .18s, 0s;
}
/* A narrow sidebar: the label gives way before any button does. */
${HEADER}:has(> .${BUTTON}:not([hidden])) > [class*="_sectionLabel"] { flex-shrink: 1; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) {
  .${BUTTON}, .${BUTTON} > svg path { transition: none; }
}
`

type Action = 'collapse' | 'expand'

const open = (row: Element): boolean => row.getAttribute('aria-expanded') === 'true'
/** In sight: not under a folded repository (our hidden sections keep their own fold). */
const shown = (row: Element): boolean => row.closest('[data-ah-hidden]') === null
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function foldAll(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.fold'
  style.textContent = CSS
  document.head.appendChild(style)

  let root: Element | undefined
  let busy = false
  let disposed = false
  const button = document.createElement('button')
  button.type = 'button'
  button.className = BUTTON
  button.innerHTML = ICON
  button.hidden = true

  const show = (action: Action): void => {
    if (button.dataset.action === action) return
    const text = t(action === 'collapse' ? 'workspacesCollapse' : 'workspacesExpand')
    button.dataset.action = action
    button.setAttribute('aria-label', text)
    button.title = text
  }

  const apply = (target: Element): void => {
    root = target
    const slot = target.querySelector(`:scope > ${HEADER} > ${SLOT}`)
    // The rail (no search slot): nothing to fold there.
    if (slot === null) return button.remove()
    if (button.previousElementSibling !== slot) slot.after(button)
    const rows = [...target.querySelectorAll(FOLDS)]
    button.hidden = rows.length === 0
    if (!busy) show(rows.some((row) => open(row) && shown(row)) ? 'collapse' : 'expand')
  }

  const collapse = (scope: Element): void => {
    // Deepest first: a folded parent may take its children's rows away.
    for (const row of [...scope.querySelectorAll<HTMLElement>(FOLDS)].filter(open).reverse()) row.click()
  }

  const expand = async (scope: Element): Promise<void> => {
    const tried = new Set<Element>()
    for (let pass = 0; pass < MAX_PASSES && !disposed; pass++) {
      // Rows drawn anew get their turn; a row that stayed folded once is not clicked again.
      const rows = [...scope.querySelectorAll<HTMLElement>(FOLDS)].filter((row) => !open(row) && !tried.has(row))
      if (rows.length === 0) return
      for (const row of rows) {
        tried.add(row)
        row.click()
      }
      // The next level appears once DSH (and the tree layer) have drawn this one.
      await wait(PASS_MS)
    }
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (busy || root === undefined) return
    const scope = root
    const action = button.dataset.action === 'collapse' ? 'collapse' : 'expand'
    // The icon turns right away; the rows follow.
    show(action === 'collapse' ? 'expand' : 'collapse')
    if (action === 'collapse') {
      collapse(scope)
      return followed.schedule()
    }
    busy = true
    void expand(scope).finally(() => {
      busy = false
      followed.schedule()
    })
  })

  // The workspace browser: its header (where the button lives) and its list (what it reads).
  const followed = follow({
    locate: () => document.querySelector(HEADER)?.parentElement ?? undefined,
    apply,
    observe: { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] },
    ours: (node) => node === button,
  })

  return () => {
    disposed = true
    followed.dispose()
    button.remove()
    style.remove()
  }
}
