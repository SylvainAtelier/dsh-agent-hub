/**
 * What the font runtime (main bundle) and the terminal chunk agree on. The
 * chunks are separate bundles with their own module copies, so they meet on
 * the page: an attribute on <html> and a window event, never shared state.
 */

import type { FontId } from '../../appearance.ts'

/** Plugin-private family names prevent an installed font of another version from mixing in. */
export const FONT_FAMILIES: Readonly<Record<Exclude<FontId, 'default'>, string>> = {
  'roboto-mono': 'Agent Hub Roboto Mono',
  'jetbrains-mono': 'Agent Hub JetBrains Mono',
  'source-code-pro': 'Agent Hub Source Code Pro',
  'fira-code': 'Agent Hub Fira Code',
  'ibm-plex-mono': 'Agent Hub IBM Plex Mono',
}

/** Kept as a named export for callers and tests concerned specifically with Fira Code. */
export const FIRA_FAMILY = FONT_FAMILIES['fira-code']

/** DSH's interface stack (ui-theme's `--dsw-font-family`): the fallback for every glyph a selected font lacks. */
export const UI_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif'

/** DSH's code stack (ui-theme's `--ds-font-family-code`), ending in the generic family. */
export const CODE_STACK = '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei", monospace'

/** The selected bundled face first, then the default stack glyph by glyph. */
export const withFont = (font: FontId, stack: string): string => font === 'default' ? stack : `"${FONT_FAMILIES[font]}", ${stack}`
/** Backward-compatible Fira helper. */
export const withFira = (stack: string): string => withFont('fira-code', stack)

/**
 * On <html> once code text uses a bundled font and its faces are loaded: canvas-measured text
 * (xterm) reads it, since measuring before the font is ready would size the cells wrong.
 */
export const CODE_FONT_ATTR = 'data-ah-code-font'

/** Dispatched on window whenever {@link CODE_FONT_ATTR} changes. */
export const CODE_FONT_EVENT = 'dsh-agent-hub:code-font'

/** The code font for canvas-measured text, or `fallback` while DSH's default applies. */
export function codeFontFor(fallback: string): string {
  const selected = document.documentElement.getAttribute(CODE_FONT_ATTR)
  return selected !== null && Object.hasOwn(FONT_FAMILIES, selected) ? withFont(selected as FontId, fallback) : fallback
}
