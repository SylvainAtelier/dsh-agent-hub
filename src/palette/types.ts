/** Clipboard history and translation window: what the host and the settings page share. */

export const PALETTE_METHOD = 'agent-hub/palette'

export interface PaletteSettings {
  /** Run the window: the global hotkey, the clipboard history. Off on every machine until turned on there. */
  enabled: boolean
  /** The global hotkey, as the settings page records it ("Ctrl+Alt+V"). */
  hotkey: string
  /** Entries kept besides the pinned ones. */
  keep: number
  /** Programs whose copies are not kept, comma separated (keepass, 1password). */
  ignore: string
  /** The bot that translates, until another is picked in the window; blank: the helper model. */
  bot: string
  /** The Alt/⌥ digit of the first language; the others follow it. */
  langKey: number
}

/** A pinned text and when it was pinned (ms): what settings sync shares between machines. */
export interface PinItem {
  text: string
  at: number
}

/** Where the system stands, as 设置 shows it: what is configured is not always what is in force. */
export interface PaletteStatus {
  /** This system has the native helper and a window system for it. */
  supported: boolean
  enabled: boolean
  running: boolean
  /** The shortcut the system actually has registered for us, "" when none. */
  hotkey: { ok: boolean; accel: string; active?: string; error?: string } | null
  error?: string
}

/** The window's colours: DSH's light or dark theme, as the client shows it. */
export type PaletteTheme = 'light' | 'dark'

export type PaletteRequest = { op: 'status' } | { op: 'theme'; theme: PaletteTheme }
