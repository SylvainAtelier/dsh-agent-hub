/**
 * Applies appearance settings to every DSH page, desktop and phone alike.
 * Font families override the host's root tokens; the interface scale mirrors
 * DSH's fixed text sizes (see scale.ts). Conversation text keeps the size of
 * DSH's own 通用设置 → 字号大小, which nothing here overrides.
 *
 * Cost: one tiny token stylesheet while anything differs from DSH's defaults.
 * Each bundled font is a separate lazy chunk, fetched only when selected and
 * then cached by the browser. The scale mirror exists only while a scale is set.
 * The last settings are cached locally to avoid a default-font flash on reload.
 */

import { appearanceOf, scaled, type AppearanceSettings, type FontId } from '../../appearance.ts'
import type { FaceSource } from './chunk.ts'
import { CODE_FONT_ATTR, CODE_FONT_EVENT, CODE_STACK, FONT_FAMILIES, UI_STACK, withFont } from './shared.ts'
import { mountScaler, scaleVarsCss } from './scale.ts'

/** The host module loader's package-local chunk import (see scripts/build.mjs). */
declare const require: { async?: (spec: string) => Promise<unknown> }

const CACHE_KEY = 'dsh-agent-hub.fonts.v2'
/** A page shown again re-reads the settings (a phone cannot be told), at most this often. */
const RECHECK_MS = 30_000

type BundledFontId = Exclude<FontId, 'default'>
interface FontChunk { FACES: readonly FaceSource[] }
const faces = new Map<BundledFontId, Promise<void>>()

/** Register one font's faces once per page and wait for its basic Latin face. */
function loadFont(font: BundledFontId): Promise<void> {
  const current = faces.get(font)
  if (current !== undefined) return current
  const loading = (async () => {
    if (typeof require.async !== 'function') throw new Error('chunk loading unavailable')
    const chunk = await require.async(`./client.font.${font}.js`) as FontChunk
    const family = FONT_FAMILIES[font]
    for (const face of chunk.FACES) {
      document.fonts.add(new FontFace(family, `url(data:font/woff2;base64,${face.data}) format("woff2")`, {
        weight: face.weight ?? '300 800',
        style: face.style ?? 'normal',
        unicodeRange: face.unicodeRange,
        display: 'swap',
      }))
    }
    await document.fonts.load(`16px "${family}"`)
  })().catch((error: unknown) => {
    faces.delete(font)
    throw error
  })
  faces.set(font, loading)
  return loading
}

/** The tiny token style sheet for `settings`, '' at DSH's defaults; font files remain separately lazy. */
export function fontCss(settings: AppearanceSettings): string {
  const root: string[] = []
  if (settings.uiFont !== 'default') root.push(`--dsw-font-family: ${withFont(settings.uiFont, UI_STACK)};`)
  if (settings.codeFont !== 'default') {
    const code = withFont(settings.codeFont, CODE_STACK)
    root.push(`--ds-font-family-code: ${code};`, `--dsw-font-mono: ${code};`)
  }
  const rules: string[] = []
  // Doubled :root outranks ui-theme's own :root block wherever either sheet sits.
  if (root.length > 0) rules.push(`:root:root { ${root.join(' ')} }`)
  const scale = scaleVarsCss(settings)
  if (scale !== '') rules.push(scale)
  return rules.join(' ')
}

function readCache(): AppearanceSettings | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw === null ? undefined : appearanceOf(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function writeCache(settings: AppearanceSettings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings))
  } catch {
    // Not remembered: the next start waits for the host's answer.
  }
}

export interface Fonts {
  /** Apply settings from any source (the host's reply, the settings form); unchanged ones cost nothing. */
  set(value: unknown): void
  dispose(): void
}

/** `load` reads settings from the host; asked now and when a hidden page is shown again. */
export function mountFonts(load: () => Promise<unknown>): Fonts {
  let style: HTMLStyleElement | undefined
  let applied = ''
  /** Bumped by every change, so a font load that finishes late only lands if still wanted. */
  let generation = 0
  let checked = 0
  let disposed = false
  const scaler = mountScaler((node) => node === style)

  const markCode = (font: FontId): void => {
    const root = document.documentElement
    const before = root.getAttribute(CODE_FONT_ATTR)
    if (font === 'default') root.removeAttribute(CODE_FONT_ATTR)
    else root.setAttribute(CODE_FONT_ATTR, font)
    if (before !== root.getAttribute(CODE_FONT_ATTR)) window.dispatchEvent(new Event(CODE_FONT_EVENT))
  }

  const set = (value: unknown): void => {
    if (disposed) return
    const settings = appearanceOf(value)
    const key = JSON.stringify(settings)
    if (key === applied) return
    applied = key
    writeCache(settings)
    const css = fontCss(settings)
    if (css === '') {
      style?.remove()
      style = undefined
    } else {
      if (style === undefined) {
        style = document.createElement('style')
        style.dataset.plugin = 'dsh-agent-hub'
        style.dataset.pluginCss = 'dsh-agent-hub/fonts'
        document.head.append(style)
      }
      style.textContent = css
    }
    scaler.enable(scaled(settings))

    const current = ++generation
    if (settings.uiFont !== 'default') void loadFont(settings.uiFont).catch(() => {})
    if (settings.codeFont === 'default') {
      markCode('default')
    } else {
      // Canvas-measured surfaces switch only after the selected face is ready.
      loadFont(settings.codeFont).then(() => {
        if (current === generation && !disposed) markCode(settings.codeFont)
      }, () => {
        // The CSS stack still falls through to a locally installed or system font.
      })
    }
  }

  const refresh = (): void => {
    checked = Date.now()
    load().then(set, () => {
      // Host unreachable: keep what is applied.
    })
  }
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && Date.now() - checked >= RECHECK_MS) refresh()
  }

  const cached = readCache()
  if (cached !== undefined) set(cached)
  refresh()
  document.addEventListener('visibilitychange', onVisible)
  return {
    set,
    dispose() {
      disposed = true
      document.removeEventListener('visibilitychange', onVisible)
      scaler.dispose()
      style?.remove()
      style = undefined
      markCode('default')
    },
  }
}
