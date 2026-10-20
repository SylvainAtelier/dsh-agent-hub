/**
 * Appearance module: the fonts DSH's pages use, one for the interface and one
 * for code (code blocks, the editor, diffs, the Git terminal). Stored in the
 * plugin's Config, so every browser showing this DSH, a phone over Tailscale
 * included, reads the same choice through {@link APPEARANCE_METHOD}.
 */

export const APPEARANCE_METHOD = 'agent-hub/appearance'

/**
 * IDE-friendly fonts recommended by ui-ux-pro-max, ordered by Google Fonts
 * popularity rank: Roboto Mono, JetBrains Mono, Source Code Pro, Fira Code,
 * then IBM Plex Mono. Every non-default face ships with the plugin.
 */
export const FONTS = ['default', 'roboto-mono', 'jetbrains-mono', 'source-code-pro', 'fira-code', 'ibm-plex-mono'] as const
export type FontId = typeof FONTS[number]

/**
 * Interface text scale, in percent of DSH's own sizes. DSH sizes its chrome
 * (sidebar, menus, buttons, settings) with fixed pixel values that differ from
 * place to place, so the scale multiplies each of them and their hierarchy
 * stays as designed. Conversation text is not part of it: DSH's 通用设置 →
 * 字号大小 owns that size.
 */
export const MIN_UI_SCALE = 80
export const MAX_UI_SCALE = 130
export const DEFAULT_UI_SCALE = 100
/** One stepper click, for the whole interface and for a region alike. */
export const UI_SCALE_STEP = 5

/**
 * Where the interface can be tuned apart from the whole: the left sidebar,
 * the main column (conversation chrome, plugin pages), the right panel, the
 * settings window, and whatever floats outside them (menus, tooltips, dialogs).
 */
export const SCALE_REGIONS = ['sidebar', 'main', 'panel', 'settings', 'popup'] as const
export type ScaleRegion = typeof SCALE_REGIONS[number]
/** A region moves at most this many percentage points away from the whole. */
export const MAX_REGION_OFFSET = 20

export interface AppearanceSettings {
  uiFont: FontId
  codeFont: FontId
  /** Percent applied to every fixed interface text size. */
  uiScale: number
  /** Per region, percentage points added to {@link uiScale}; 0 follows the whole. */
  regions: Record<ScaleRegion, number>
}

const fontOf = (value: unknown): FontId => (FONTS as readonly unknown[]).includes(value) ? value as FontId : 'default'
const integerIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback

/** Region offsets from whatever was stored; missing or invalid ones follow the whole. */
export function regionsOf(value: unknown): Record<ScaleRegion, number> {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return Object.fromEntries(SCALE_REGIONS.map((region) => [region, integerIn(record[region], -MAX_REGION_OFFSET, MAX_REGION_OFFSET, 0)])) as Record<ScaleRegion, number>
}

/** Whatever arrived (a config doc, an RPC reply, a cached value), as settings; invalid values use safe defaults. */
export function appearanceOf(value: unknown): AppearanceSettings {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    uiFont: fontOf(record.uiFont),
    codeFont: fontOf(record.codeFont),
    uiScale: integerIn(record.uiScale, MIN_UI_SCALE, MAX_UI_SCALE, DEFAULT_UI_SCALE),
    regions: regionsOf(record.regions),
  }
}

/** The percent a region's fixed text sizes are shown at. */
export const regionScale = (settings: Pick<AppearanceSettings, 'uiScale' | 'regions'>, region: ScaleRegion): number =>
  settings.uiScale + settings.regions[region]

/** Whether any interface text differs from DSH's own size. */
export const scaled = (settings: Pick<AppearanceSettings, 'uiScale' | 'regions'>): boolean =>
  SCALE_REGIONS.some((region) => regionScale(settings, region) !== 100)
