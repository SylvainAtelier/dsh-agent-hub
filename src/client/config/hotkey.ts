/** The hotkey recorder's side that needs no page: a keystroke named the way the native helper reads it. */

const KEYS: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: 'Minus', Equal: 'Equal', Comma: 'Comma', Period: 'Period', Slash: 'Slash', Semicolon: 'Semicolon', Quote: 'Quote',
  Backquote: 'Backquote', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Backslash: 'Backslash',
}

/** The helper's name for the key a keystroke is on: by position, so layouts and shift do not matter. */
function keyName(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return KEYS[code]
}

const MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', win: 'Cmd',
}
const ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd']
const NAMES = new Map([...new Set([...Object.values(KEYS), 'Return'])].map((name) => [name.toLowerCase(), name === 'Return' ? 'Enter' : name]))

/**
 * A typed accelerator ("ctrl + space") in the helper's spelling ("Ctrl+Space"), undefined when the
 * helper would refuse it. Typing is the way in for what a page never sees: a Chinese input method
 * takes Ctrl+Space for itself before the recorder can, while a global hotkey still comes first.
 */
export function normalizeAccelerator(text: string): string | undefined {
  const modifiers = new Set<string>()
  let key: string | undefined
  for (const part of text.split('+').map((part) => part.trim()).filter((part) => part !== '')) {
    const lower = part.toLowerCase()
    const modifier = MODIFIERS[lower]
    if (modifier !== undefined) {
      modifiers.add(modifier)
      continue
    }
    const name = /^[a-z0-9]$/.test(lower) ? lower.toUpperCase() : /^f([1-9]|1[0-9]|2[0-4])$/.test(lower) ? lower.toUpperCase() : NAMES.get(lower)
    if (name === undefined || key !== undefined) return undefined
    key = name
  }
  if (key === undefined || modifiers.size === 0) return undefined
  return [...ORDER.filter((name) => modifiers.has(name)), key].join('+')
}

/** "Ctrl+Alt+V" from a keystroke; undefined for a modifier alone or a key without a modifier. */
export function accelerator(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | undefined {
  const key = keyName(event.code)
  if (key === undefined) return undefined
  const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Cmd'].filter((name): name is string => name !== false)
  return modifiers.length === 0 ? undefined : [...modifiers, key].join('+')
}
