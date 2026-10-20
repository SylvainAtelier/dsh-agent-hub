import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrast, parseColor, solidSurface } from '../src/client/usage/surface.ts'

test('surface: an opaque layer is used as-is', () => {
  assert.deepEqual(solidSurface(['rgba(0, 0, 0, 0)', 'rgb(28, 29, 32)'], 'rgb(230, 230, 230)'),
    { background: 'rgb(28, 29, 32)', color: 'rgb(230, 230, 230)' })
})

test('surface: translucent layers composite over the first opaque one', () => {
  // 50% white over black → mid gray.
  assert.equal(solidSurface(['rgba(255, 255, 255, 0.5)', 'rgb(0, 0, 0)'], 'rgb(0, 0, 0)').background, 'rgb(128, 128, 128)')
})

test('surface: a fully transparent window falls back by text lightness', () => {
  assert.equal(solidSurface(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'], 'rgb(235, 235, 235)').background, 'rgb(30, 31, 34)')
  assert.equal(solidSurface(['transparent'], 'rgb(20, 20, 20)').background, 'rgb(255, 255, 255)')
  // Translucent dark tint over nothing still lands on a dark solid.
  assert.equal(solidSurface(['rgba(20, 20, 24, 0.4)'], 'rgb(235, 235, 235)').background, 'rgb(26, 27, 30)')
})

test('surface: text is forced to AA contrast and made opaque', () => {
  const low = solidSurface(['rgb(40, 40, 40)'], 'rgba(60, 60, 60, 0.9)')
  assert.ok(contrast(parseColor(low.color)!, parseColor(low.background)!) >= 4.5)
  assert.equal(solidSurface(['rgb(255, 255, 255)'], 'rgba(20, 20, 20, 0.6)').color, 'rgb(20, 20, 20)')
})

test('surface: parses modern space-separated syntax', () => {
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), [10, 20, 30, 0.5])
})
