import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appearanceOf, DEFAULT_UI_SCALE, FONTS, regionScale, scaled, SCALE_REGIONS } from '../src/appearance.ts'
import { fontCss } from '../src/client/font/index.ts'
import { REGION_SCOPES, scaledDeclarations, scaledRules, scaleVarsCss, type RuleLike } from '../src/client/font/scale.ts'
import { CODE_STACK, FONT_FAMILIES, UI_STACK } from '../src/client/font/shared.ts'

const NO_REGIONS = { sidebar: 0, main: 0, panel: 0, settings: 0, popup: 0 }
const DEFAULTS = { uiFont: 'default', codeFont: 'default', uiScale: DEFAULT_UI_SCALE, regions: NO_REGIONS } as const

test('appearance: unknown or missing values read as safe defaults', () => {
  assert.deepEqual(appearanceOf(undefined), DEFAULTS)
  assert.deepEqual(appearanceOf({ uiFont: 'comic-sans', codeFont: 'fira-code', uiScale: 400, regions: { sidebar: 50, main: 2.5, panel: 'x', nav: 5 } }), {
    ...DEFAULTS, codeFont: 'fira-code',
  })
})

test('appearance: every recommended IDE font and valid scale survives parsing', () => {
  for (const font of FONTS) assert.equal(appearanceOf({ uiFont: font }).uiFont, font)
  assert.equal(appearanceOf({ uiScale: 80 }).uiScale, 80)
  assert.equal(appearanceOf({ uiScale: 130 }).uiScale, 130)
  assert.equal(appearanceOf({ uiScale: 112.5 }).uiScale, DEFAULT_UI_SCALE)
  assert.deepEqual(appearanceOf({ regions: { sidebar: 10, popup: -20 } }).regions, { ...NO_REGIONS, sidebar: 10, popup: -20 })
})

test('appearance: the retired content size neither applies nor overrides DSH\'s own setting', () => {
  const settings = appearanceOf({ fontSize: 18 })
  assert.deepEqual(settings, DEFAULTS)
  assert.equal(fontCss(settings), '')
})

test('appearance: a bundled font comes first and default stacks follow for missing glyphs', () => {
  const ui = fontCss({ ...DEFAULTS, uiFont: 'jetbrains-mono' })
  assert.ok(ui.includes(`--dsw-font-family: "${FONT_FAMILIES['jetbrains-mono']}", ${UI_STACK};`))
  assert.ok(!ui.includes('--ds-font-family-code'))

  const code = fontCss({ ...DEFAULTS, codeFont: 'roboto-mono' })
  assert.ok(code.includes(`--ds-font-family-code: "${FONT_FAMILIES['roboto-mono']}", ${CODE_STACK};`))
  assert.ok(code.includes(`--dsw-font-mono: "${FONT_FAMILIES['roboto-mono']}", ${CODE_STACK};`))
  assert.ok(!code.includes('--dsw-font-family:'))
})

test('appearance: a region adds to the whole; at 100% everywhere nothing is scaled', () => {
  const settings = { uiScale: 110, regions: { ...NO_REGIONS, sidebar: -10, settings: 5 } }
  assert.equal(regionScale(settings, 'sidebar'), 100)
  assert.equal(regionScale(settings, 'settings'), 115)
  assert.equal(regionScale(settings, 'main'), 110)
  assert.equal(scaled({ uiScale: 100, regions: NO_REGIONS }), false)
  assert.equal(scaled({ uiScale: 95, regions: { ...NO_REGIONS, sidebar: 5 } }), true)
})

test('scale: every region gets its factor on its own anchor, popups on the root', () => {
  assert.equal(scaleVarsCss({ uiScale: 100, regions: NO_REGIONS }), '')
  const css = scaleVarsCss({ uiScale: 110, regions: { ...NO_REGIONS, panel: -15 } })
  for (const region of SCALE_REGIONS) assert.ok(css.includes(`${REGION_SCOPES[region]} { --ah-ui-scale:`), region)
  assert.ok(css.includes('[data-slot="rightbar"] { --ah-ui-scale: 0.95; }'))
  assert.ok(css.includes(':root { --ah-ui-scale: 1.1; }'))
  // The content size stays DSH's.
  assert.ok(!css.includes('--dsh-content-font-size'))
  assert.ok(!fontCss({ ...DEFAULTS, uiScale: 120 }).includes('--dsh-content-font-size'))
})

const style = (values: Record<string, string>, important: string[] = []) => ({
  getPropertyValue: (name: string) => values[name] ?? '',
  getPropertyPriority: (name: string) => important.includes(name) ? 'important' : '',
})
const rule = (selectorText: string, values: Record<string, string>, important?: string[]): RuleLike =>
  ({ cssText: `${selectorText} { }`, selectorText, style: style(values, important) })

test('scale: fixed sizes are mirrored, with their fixed line height and priority', () => {
  assert.equal(scaledDeclarations(style({ 'font-size': '13px', 'line-height': '20px' })),
    'font-size: calc(13px * var(--ah-ui-scale, 1)); line-height: calc(20px * var(--ah-ui-scale, 1))')
  assert.equal(scaledDeclarations(style({ 'font-size': '0.75rem', 'line-height': '1.5' })),
    'font-size: calc(0.75rem * var(--ah-ui-scale, 1))')
  assert.equal(scaledDeclarations(style({ 'font-size': '12px' }, ['font-size'])),
    'font-size: calc(12px * var(--ah-ui-scale, 1)) !important')
})

test('scale: conversation text and relative sizes are left alone', () => {
  for (const size of ['var(--dsh-content-font-size, 14px)', 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)', '0.875em', 'inherit', '100%']) {
    assert.equal(scaledDeclarations(style({ 'font-size': size, 'line-height': '20px' })), '', size)
  }
  assert.equal(scaledDeclarations(style({ font: 'var(--dsw-font-markdown-base)' })), '')
  assert.equal(scaledDeclarations(style({ font: 'var(--dsw-font-markdown-code-block-small)' })), '')
  assert.equal(scaledDeclarations(style({ 'line-height': '20px' })), '')
})

test('scale: interface type tokens scale through their own size and line height parts', () => {
  assert.equal(scaledDeclarations(style({ font: 'var(--dsw-font-xs-strong-13)' })),
    'font-size: calc(var(--dsw-font-xs-strong-13-font-size, 13px) * var(--ah-ui-scale, 1)); '
    + 'line-height: calc(var(--dsw-font-xs-strong-13-line-height, 20px) * var(--ah-ui-scale, 1))')
})

test('scale: the mirror keeps conditions, layers and nesting, drops the rest and the rem base', () => {
  const rules: RuleLike[] = [
    rule('html', { 'font-size': '16px' }),
    rule('._title_1', { 'font-size': '16px' }),
    rule('._gap_1', { gap: '4px' }),
    { cssText: '@media (max-width: 600px) { ._title_1 { font-size: 14px; } }', cssRules: [rule('._title_1', { 'font-size': '14px' })] },
    { cssText: '@keyframes spin { from { } }', cssRules: [rule('from', { 'font-size': '1px' })] },
    { cssText: '@layer base { }', cssRules: [rule('._base', { color: 'red' })] },
    { ...rule('._row', { 'font-size': '12px' }), cssRules: [rule('&:hover', { 'font-size': '13px' }), rule('&:focus', { color: 'red' })] },
  ]
  assert.equal(scaledRules(rules),
    '._title_1 { font-size: calc(16px * var(--ah-ui-scale, 1)); } '
    + '@media (max-width: 600px) { ._title_1 { font-size: calc(14px * var(--ah-ui-scale, 1)); } } '
    + '._row { font-size: calc(12px * var(--ah-ui-scale, 1)); &:hover { font-size: calc(13px * var(--ah-ui-scale, 1)); } } ')
})
