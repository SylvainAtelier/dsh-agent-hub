import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextLocale } from '../src/client/locale/switch.ts'

const zh = { id: 'zh', label: '中文' }
const en = { id: 'en', label: 'English' }

test('locale switch: two languages swap on a click', () => {
  assert.deepEqual(nextLocale({ active: 'zh', locales: [zh, en] }), en)
  assert.deepEqual(nextLocale({ active: 'en', locales: [zh, en] }), zh)
})

test('locale switch: three or more open the menu instead', () => {
  assert.equal(nextLocale({ active: 'zh', locales: [zh, en, { id: 'ja', label: '日本語' }] }), undefined)
  assert.equal(nextLocale({ active: 'en', locales: [en] }), undefined)
})
