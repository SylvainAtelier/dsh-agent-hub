/**
 * Keyboard shortcuts for a session's composer: open its model menu, and step
 * its thinking level to the next one the model has (wrapping round). Both are
 * commands in DSH's own shortcuts service, so they show in its 快捷键 sheet,
 * share its conflict checks and its per-device keybindings; neither has a
 * default key. Outside a focused composer the key passes. The 模型选择 group
 * records their keys in place (ShortcutRows).
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { t, type ConfigKey } from './i18n.ts'

interface Binding {
  code: string
  secondCode?: string
  modifiers: string[]
}

interface Store<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The slice of DSH's `shortcuts` service used here. */
export interface Shortcuts {
  register(command: {
    id: string
    label(): string
    /** Search words in DSH's command palette; DSH iterates it, so it must be present. */
    aliases: string[]
    defaults: Record<string, Binding>
    regions: string[]
    modals: string[]
    resolve(context: { target: Element | null }): { status: 'pass' } | { status: 'handled'; run(): void }
  }): () => void
  catalog: Store<ReadonlyArray<{ id: string; label: string; keys: string[] }>>
  fixedCatalog: Store<ReadonlyArray<{ id: string; label: string }>>
  config: Store<{ revision: string; status: string }>
  describeBinding(binding: Binding): { binding: Binding | null; issue: string | null; conflicts: string[] }
  edit(edit: { type: 'set'; id: string; binding: Binding | null }, revision: string): Promise<{ status: string; conflicts?: string[] }>
  recording(active: boolean): Promise<void>
}

interface Selection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The slice of ui-model-selection's `modelDirectories` service used here. */
export interface ModelDirectories {
  directoryFor(sessionId: string): {
    store: {
      getSnapshot(): {
        current: Selection | null
        pending: Selection | null
        groups: ReadonlyArray<{ id: string; models: ReadonlyArray<{ id: string; reasoning?: { efforts: ReadonlyArray<{ id: string }>; defaultEffort?: string } }> }>
      }
    }
    load(): Promise<unknown>
    select(selection: Selection): Promise<unknown>
  }
}

const MODEL_MENU = 'agentHub.modelMenu'
const CYCLE_EFFORT = 'agentHub.cycleEffort'
const COMMANDS = [MODEL_MENU, CYCLE_EFFORT] as const

/** The focused composer's session, or undefined when focus is anywhere else. */
function composerAt(target: Element | null): { input: Element; sessionId: string } | undefined {
  const input = target?.closest('[data-composer-input]')
  const sessionId = input?.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
  return input == null || !sessionId ? undefined : { input, sessionId }
}

/**
 * Open the composer's model list and drive it from the keyboard: ↑/↓ browse the models from the
 * current one, Enter picks one, Esc backs out. The seat is DSH's ModelSelect (`_trigger`) or a
 * plugin's own picker in its place (dsh-codex-subscription's): either way the last menu button
 * (the model seat ends the bar), a `role="menu"` root opening on 模型 / 思考等级 cells, and
 * `menuitemradio` model rows, the current one `aria-checked`.
 */
function openModelMenu(input: Element): void {
  const trigger = seatOf(input)
  if (trigger === undefined || trigger.disabled || trigger.getAttribute('aria-expanded') === 'true') return
  const menu = menuOf(trigger)
  const release = holdKeys(trigger, input, menu)
  trigger.click()
  // Step into the model list once (its cell toggles, so never twice), then, once its rows are in
  // (the list may still be loading), start on the current model.
  let drilled = false
  let tries = 0
  const drill = (): void => {
    const root = menu()
    if (root !== null && !drilled) {
      drilled = true
      if (root.querySelector(ROW) === null) root.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
    }
    const current = root?.querySelector<HTMLButtonElement>(`${ROW}[aria-checked="true"]`)
    if (current == null) {
      if (++tries <= 60) requestAnimationFrame(drill)
    } else if (root!.querySelector('input') === null) {
      showFocus(current)
    }
  }
  requestAnimationFrame(drill)
  // Never opened (a lock, a failed load): nothing to hold.
  setTimeout(() => { if (trigger.getAttribute('aria-expanded') !== 'true') release() }, 500)
}

/** The model seat's trigger in this element's composer card: menu buttons inside an open menu (its cells) are not it. */
function seatOf(within: Element): HTMLButtonElement | undefined {
  const menus = [...within.closest('[data-composer-card]')?.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? []]
    .filter((button) => button.closest('[role="menu"]') === null)
  return menus.find((button) => /_trigger\b/.test(button.className)) ?? menus.at(-1)
}

const menuOf = (trigger: HTMLButtonElement) => (): HTMLElement | null => document.getElementById(trigger.getAttribute('aria-controls') ?? '')

/** Seat triggers whose menu the keys are held for: a menu opened by the shortcut is not held twice. */
const held = new WeakSet<HTMLButtonElement>()

/**
 * A model menu opened by the pointer gets the same keys once focus goes into it (a cell clicked,
 * a search box autofocused): a plugin's picker in the seat has no arrow keys of its own.
 */
function holdOnFocus(event: FocusEvent): void {
  const target = event.target instanceof Element ? event.target : null
  const input = target?.closest('[data-composer-card]')?.querySelector('[data-composer-input]')
  const trigger = target === null ? undefined : seatOf(target)
  if (input == null || trigger === undefined || held.has(trigger) || trigger.getAttribute('aria-expanded') !== 'true') return
  const menu = menuOf(trigger)
  if (menu()?.contains(target) !== true) return
  holdKeys(trigger, input, menu)
}

const ROW = '[role="menuitemradio"]:not([disabled])'

/** Focus a row with its ring: a picker without its own highlight shows the row by :focus-visible alone. */
const showFocus = (row: HTMLElement): void => row.focus({ focusVisible: true } as FocusOptions)

const keyEvent = (key: string): KeyboardEvent => new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })

/**
 * While the menu is open, ↑ ↓ Enter and Esc go to it wherever the keyboard focus is: the composer
 * (Lexical) may hold or take back focus, and a plugin's picker may have no arrow keys of its own.
 * A picker without its own highlight has its rows stepped here, by focus (which is all it shows),
 * search box or not; with DSH's search box ↑/↓ go to it, so ModelSelect steps its own highlight.
 * Enter clicks the row, Esc goes to the trigger as a key event (a level up, then closed). When the
 * menu closes with the keyboard still on its trigger (a pick, Esc), typing goes on in the composer.
 */
function holdKeys(trigger: HTMLButtonElement, input: Element, menu: () => HTMLElement | null): () => void {
  // Where the caret was: a bare focus back on the composer would put it at the start (or Lexical at the end).
  const selection = window.getSelection()
  const caretAt = selection !== null && selection.rangeCount > 0 && input.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null
  // The row ↑/↓ last reached, or the pointer last moved onto; before either, the focused or current one.
  let cursor: number | null = null
  let pointer = ''
  const onKey = (event: KeyboardEvent): void => {
    // Not our own forwarded keys: they are for the menu.
    // Modifiers are not checked: the shortcut's own may still read as held on the first key after it.
    if (!event.isTrusted || event.isComposing) return
    const root = menu()
    if (root === null || !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const rows = [...root.querySelectorAll<HTMLButtonElement>(ROW)]
    // Backed out of the list (Esc): the next one starts afresh.
    if (rows.length === 0) cursor = null
    // A search box takes ↑/↓ only in a picker that marks its own highlight (DSH's ModelSelect);
    // one without (dsh-codex-subscription's) is stepped here by focus like any other.
    const search = root.querySelector('[data-highlighted]') === null ? null : root.querySelector<HTMLInputElement>('input')
    const marked = (selector: string): number => rows.findIndex((row) => row.matches(selector))
    const focused = rows.findIndex((row) => row === document.activeElement)
    const at = cursor ?? (focused >= 0 ? focused : marked('[aria-checked="true"]'))
    if (event.key === 'Enter') {
      if (!event.repeat) rows[search === null ? at : marked('[data-highlighted]')]?.click()
    } else if (event.key === 'Escape') {
      trigger.dispatchEvent(keyEvent('Escape'))
    } else if (search !== null) {
      search.dispatchEvent(keyEvent(event.key))
    } else if (rows.length > 0) {
      const step = event.key === 'ArrowDown' ? 1 : -1
      cursor = at < 0 ? (step > 0 ? 0 : rows.length - 1) : (Math.min(at, rows.length - 1) + step + rows.length) % rows.length
      showFocus(rows[cursor]!)
    }
  }
  // A pointer that really moved takes the row under it; the same-spot moves a re-layout fakes do not.
  const onMove = (event: MouseEvent): void => {
    const at = `${event.screenX},${event.screenY}`
    if (at === pointer) return
    pointer = at
    const row = event.target instanceof Element ? event.target.closest(ROW) : null
    const index = row === null ? -1 : [...(menu()?.querySelectorAll(ROW) ?? [])].indexOf(row)
    if (index >= 0) cursor = index
  }
  const observer = new MutationObserver(() => {
    if (trigger.getAttribute('aria-expanded') === 'true') return
    release()
    setTimeout(() => {
      if ((document.activeElement !== trigger && document.activeElement !== document.body) || !input.isConnected) return
      const composer = input as HTMLElement
      composer.focus({ preventScroll: true })
      if (caretAt !== null && input.contains(caretAt.startContainer) && input.contains(caretAt.endContainer)) {
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(caretAt)
      }
    }, 0)
  })
  const release = (): void => {
    held.delete(trigger)
    observer.disconnect()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('mousemove', onMove, true)
  }
  held.add(trigger)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('mousemove', onMove, true)
  observer.observe(trigger, { attributes: true, attributeFilter: ['aria-expanded'] })
  return release
}

/** One step along the model's own levels, wrapping round; a second press before the first lands steps on from it. */
async function cycleEffort(models: ModelDirectories, sessionId: string): Promise<void> {
  const directory = models.directoryFor(sessionId)
  if (directory.store.getSnapshot().groups.length === 0) await directory.load()
  const { current, pending, groups } = directory.store.getSnapshot()
  const base = pending ?? current
  if (base === null) return
  const reasoning = groups.find((group) => group.id === base.provider)?.models.find((model) => model.id === base.model)?.reasoning
  const ids = reasoning?.efforts.map((effort) => effort.id) ?? []
  if (ids.length < 2) return
  const at = ids.indexOf(base.reasoningEffort ?? reasoning?.defaultEffort ?? '')
  await directory.select({ provider: base.provider, model: base.model, reasoningEffort: ids[(at + 1) % ids.length]! })
}

export function registerModelShortcuts(shortcuts: Shortcuts, models: ModelDirectories): () => void {
  const command = (id: string, run: (at: { input: Element; sessionId: string }) => void): (() => void) => shortcuts.register({
    id,
    label: () => t(`shortcut.${id}` as ConfigKey),
    aliases: [],
    defaults: {},
    regions: ['editable'],
    modals: [],
    resolve: ({ target }) => {
      const at = composerAt(target)
      return at === undefined ? { status: 'pass' } : { status: 'handled', run: () => run(at) }
    },
  })
  const offs = [
    command(MODEL_MENU, ({ input }) => openModelMenu(input)),
    command(CYCLE_EFFORT, ({ sessionId }) => void cycleEffort(models, sessionId).catch(() => {})),
  ]
  window.addEventListener('focusin', holdOnFocus, true)
  offs.push(() => window.removeEventListener('focusin', holdOnFocus, true))
  return () => offs.forEach((off) => off())
}

const MODIFIER = /^(Control|Alt|Shift|Meta)(Left|Right)$/

/** 模型选择 → 快捷键: each command's key, recorded in place into DSH's keybindings. */
export function ShortcutRows(props: { shortcuts: Shortcuts }): ReactNode {
  const { shortcuts } = props
  const catalog = useSyncExternalStore(shortcuts.catalog.subscribe, shortcuts.catalog.getSnapshot)
  const [recording, setRecording] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null)

  // While recording, every key goes to the recorder: DSH's own bindings (the settings modal's Esc too) stand aside.
  useEffect(() => {
    if (recording === null) return
    const id = recording
    let saving = false
    void shortcuts.recording(true).catch(() => {})
    const fail = (key: ConfigKey, params?: Record<string, string>): void => setProblem({ id, text: t(key, params) })
    const down = (event: KeyboardEvent): void => {
      if (event.isComposing || event.key === 'Dead' || event.getModifierState('AltGraph')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat || saving || MODIFIER.test(event.code)) return
      const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter((name) => event[`${name === 'control' ? 'ctrl' : name}Key`])
      if (event.key === 'Escape' && modifiers.length === 0) return setRecording(null)
      // Bound to text input: a key without Ctrl/Alt/⌘ would stop it typing.
      if (!modifiers.some((name) => name !== 'shift')) return fail('shortcut.modifier')
      let described: ReturnType<Shortcuts['describeBinding']>
      try {
        described = shortcuts.describeBinding({ code: event.code, modifiers })
      } catch {
        return fail('shortcut.unsupported')
      }
      const others = described.conflicts.filter((other) => other !== id)
      if (described.issue !== null || described.binding === null) return fail('shortcut.unsupported')
      if (others.length > 0) {
        const rows = [...shortcuts.catalog.getSnapshot(), ...shortcuts.fixedCatalog.getSnapshot()]
        return fail('shortcut.conflict', { commands: others.map((other) => rows.find((row) => row.id === other)?.label ?? other).join(', ') })
      }
      saving = true
      void shortcuts.edit({ type: 'set', id, binding: described.binding }, shortcuts.config.getSnapshot().revision).then((result) => {
        saving = false
        if (result.status === 'saved') {
          setProblem(null)
          setRecording(null)
        } else fail(result.status === 'conflict' ? 'shortcut.conflict' : 'shortcut.failed', { commands: (result.conflicts ?? []).join(', ') })
      }, () => {
        saving = false
        fail('shortcut.failed')
      })
    }
    window.addEventListener('keydown', down, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      void shortcuts.recording(false).catch(() => {})
    }
  }, [recording, shortcuts])

  const clear = (id: string): void => {
    setProblem(null)
    void shortcuts.edit({ type: 'set', id, binding: null }, shortcuts.config.getSnapshot().revision)
      .then((result) => { if (result.status !== 'saved') setProblem({ id, text: t('shortcut.failed') }) }, () => setProblem({ id, text: t('shortcut.failed') }))
  }

  return COMMANDS.map((id) => {
    const keys = catalog.find((row) => row.id === id)?.keys ?? []
    const active = recording === id
    const error = problem?.id === id ? problem.text : undefined
    return (
      <div key={id} className="ac-row">
        <div className="ac-row-text">
          <div className="ac-row-head"><span className="ac-label" id={`ac-shortcut-${id}`}>{t(`shortcut.${id}` as ConfigKey)}</span></div>
          <p className="ac-hint" data-invalid={error === undefined ? undefined : ''}>{error ?? t(`shortcut.${id}.hint` as ConfigKey)}</p>
        </div>
        <div className="ac-control ac-shortcut">
          <button type="button" className="ac-input ac-keys" aria-labelledby={`ac-shortcut-${id}`} aria-pressed={active}
            aria-invalid={error === undefined ? undefined : true} data-recording={active ? '' : undefined}
            onClick={() => {
              setProblem(null)
              setRecording(active ? null : id)
            }}
            onBlur={() => { if (active) setRecording(null) }}>
            {active ? t('shortcut.press') : keys.length === 0 ? t('shortcut.none') : keys.map((key, i) => (key === '+' ? <span key={i}>+</span> : <kbd key={i}>{key}</kbd>))}
          </button>
          {keys.length > 0 && !active && <button type="button" className="ac-link" onClick={() => clear(id)}>{t('shortcut.clear')}</button>}
        </div>
      </div>
    )
  })
}
