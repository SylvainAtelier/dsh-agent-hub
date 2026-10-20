/**
 * Interface text scale. DSH sizes its chrome with fixed pixel font sizes spread
 * over every plugin's stylesheet (13px in the sidebar, 11px on a tag, 16px on a
 * dialog title), and conversation text with its own content token. To scale the
 * chrome without touching layout or conversation text, each rule that sets a
 * fixed size is mirrored later in the cascade, under the same selector, as
 * `calc(<size> * var(--ah-ui-scale, 1))`. Equal specificity and a later position
 * make the mirror win exactly where the original did, so every place keeps its
 * size relative to the others. Sizes from DSH's content tokens, `em`, `%` and
 * `inherit` are left alone: content keeps DSH's setting, relative sizes follow
 * their already scaled parent.
 *
 * The variable is set per region on DSH's stable anchors (`data-slot`), and
 * custom properties inherit through `display: contents`, so a host button in the
 * sidebar takes the sidebar's scale and a menu portaled to <body> the root's.
 *
 * Cost: nothing while every region is at 100%. Otherwise one generated sheet,
 * rebuilt when <head> gains or loses a stylesheet; each sheet is read once.
 */

import { regionScale, scaled, SCALE_REGIONS, type AppearanceSettings, type ScaleRegion } from '../../appearance.ts'

export const SCALE_VAR = '--ah-ui-scale'

/**
 * Where each region's scale is set. The settings window and the shell's
 * columns carry stable attributes; `popup` is the root, inherited by whatever
 * floats outside the columns (menus, tooltips, dialogs portaled to <body>).
 */
export const REGION_SCOPES: Readonly<Record<ScaleRegion, string>> = {
  popup: ':root',
  sidebar: '[data-slot="sidebar"]',
  main: '[data-slot="main"]',
  panel: '[data-slot="rightbar"]',
  settings: '[data-shortcut-modal="settings"]',
}

/** The variable each region's mirrored sizes read; empty while nothing is scaled. */
export function scaleVarsCss(settings: Pick<AppearanceSettings, 'uiScale' | 'regions'>): string {
  if (!scaled(settings)) return ''
  return SCALE_REGIONS.map((region) => `${REGION_SCOPES[region]} { ${SCALE_VAR}: ${regionScale(settings, region) / 100}; }`).join(' ')
}

/** The slice of CSSOM the mirror reads, so it runs on plain objects in tests. */
export interface StyleLike {
  getPropertyValue(name: string): string
  getPropertyPriority(name: string): string
}
export interface RuleLike {
  cssText: string
  selectorText?: string
  style?: StyleLike
  cssRules?: ArrayLike<RuleLike>
}

const LENGTH = /^\d*\.?\d+(?:px|rem)$/
const PX = /^\d*\.?\d+px$/
/** DSH's interface type tokens (`--dsw-font-xs-13`); the Markdown ones belong to conversation text. */
const TYPE_TOKEN = /^var\((--dsw-font-(?!markdown)[a-z-]+?-(\d+))\)$/
/** The root's size is the `rem` base: scaling it would scale every `rem` rule twice. */
const ROOT = /^(?:html|:root)$/
const GROUP = /^@(?:media|supports|layer|container|scope)\b/

/** The scaled declarations mirroring `style`, or '' when it sets no fixed size. */
export function scaledDeclarations(style: StyleLike): string {
  const factor = `var(${SCALE_VAR}, 1)`
  const priority = (name: string): string => style.getPropertyPriority(name) === 'important' ? ' !important' : ''
  const size = style.getPropertyValue('font-size').trim()
  if (LENGTH.test(size)) {
    const out = [`font-size: calc(${size} * ${factor})${priority('font-size')}`]
    // A fixed line height set with the size belongs to it; scaled alone, the text would overflow its line.
    const height = style.getPropertyValue('line-height').trim()
    if (PX.test(height)) out.push(`line-height: calc(${height} * ${factor})${priority('line-height')}`)
    return out.join('; ')
  }
  if (size !== '') return ''
  // `font: var(--dsw-font-xs-13)` leaves the longhands pending; the token's own parts give the numbers.
  const token = TYPE_TOKEN.exec(style.getPropertyValue('font').trim())
  if (token === null) return ''
  const [, name, px] = token
  const important = priority('font')
  return `font-size: calc(var(${name}-font-size, ${px}px) * ${factor})${important}; `
    + `line-height: calc(var(${name}-line-height, ${Math.round(Number(px) * 1.5)}px) * ${factor})${important}`
}

/** The mirror of a rule list: only rules with a fixed size, inside the same conditions, layers and nesting. */
export function scaledRules(rules: ArrayLike<RuleLike>): string {
  let out = ''
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!
    if (rule.style !== undefined && rule.selectorText !== undefined) {
      if (ROOT.test(rule.selectorText.trim())) continue
      const own = scaledDeclarations(rule.style)
      const nested = rule.cssRules === undefined ? '' : scaledRules(rule.cssRules)
      if (own !== '' || nested !== '') out += `${rule.selectorText} { ${own === '' ? '' : `${own}; `}${nested}} `
    } else if (rule.cssRules !== undefined) {
      const brace = rule.cssText.indexOf('{')
      const prelude = brace < 0 ? '' : rule.cssText.slice(0, brace).trim()
      if (!GROUP.test(prelude)) continue
      const inner = scaledRules(rule.cssRules)
      if (inner !== '') out += `${prelude} { ${inner}} `
    }
  }
  return out
}

export interface Scaler {
  /** Mirror the page's stylesheets (true) or remove the mirror (false); repeated calls cost nothing. */
  enable(on: boolean): void
  dispose(): void
}

/** The mirror of every stylesheet on the page, kept last in <head> and current as sheets come and go. */
export function mountScaler(skip: (node: Node | null) => boolean): Scaler {
  const sheets = new WeakMap<CSSStyleSheet, string>()
  let style: HTMLStyleElement | undefined
  let observer: MutationObserver | undefined

  const mirrorOf = (sheet: CSSStyleSheet): string => {
    const known = sheets.get(sheet)
    if (known !== undefined) return known
    let text = ''
    try {
      text = scaledRules(sheet.cssRules as unknown as ArrayLike<RuleLike>)
    } catch {
      // A cross-origin sheet cannot be read; its sizes stay as they are.
    }
    sheets.set(sheet, text)
    return text
  }

  const own = (node: Node | null): boolean => node !== null && (node === style || skip(node))

  const rebuild = (): void => {
    if (style === undefined) return
    const parts: string[] = []
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      if (own(sheet.ownerNode)) continue
      const text = mirrorOf(sheet)
      if (text !== '') parts.push(text)
    }
    const css = parts.join('\n')
    if (style.textContent !== css) style.textContent = css
    // Later than every sheet it mirrors, so equal specificity resolves to the mirror.
    if (document.head.lastElementChild !== style) document.head.append(style)
  }

  const onMutations = (records: MutationRecord[]): void => {
    const relevant = records.some((record) => {
      if (own(record.target) || own(record.target.parentNode)) return false
      const nodes = [...record.addedNodes, ...record.removedNodes]
      return nodes.length === 0 || nodes.some((node) => !own(node))
    })
    if (relevant) rebuild()
  }
  // A <link> sheet has no rules until it loads.
  const onLoad = (event: Event): void => {
    if (event.target instanceof HTMLLinkElement) rebuild()
  }

  const enable = (on: boolean): void => {
    if (on === (style !== undefined)) return
    if (on) {
      style = document.createElement('style')
      style.dataset.plugin = 'dsh-agent-hub'
      style.dataset.pluginCss = 'dsh-agent-hub/scale'
      document.head.append(style)
      observer = new MutationObserver(onMutations)
      observer.observe(document.head, { childList: true, subtree: true, characterData: true })
      document.addEventListener('load', onLoad, true)
      rebuild()
    } else {
      observer?.disconnect()
      observer = undefined
      document.removeEventListener('load', onLoad, true)
      style?.remove()
      style = undefined
    }
  }

  return { enable, dispose: () => enable(false) }
}
