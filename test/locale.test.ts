import assert from 'node:assert/strict'
import { test } from 'node:test'
import { english, hostLocale, locale, localized, setLocaleSource } from '../src/locale.ts'

const host = (entries: Array<{ name?: string; config?: { preference?: unknown } }>, loader = true) => ({
  get: (name: string) => (name === 'loader' && loader ? { entries: () => entries.map((options) => ({ options })) } : undefined),
})

test('locale: DSH\'s stored UI language, read live from the locale plugin\'s entry', () => {
  const entries: Array<{ name?: string; config?: { preference?: unknown } }> = [
    { name: '@deepseek-ai/dsh-settings' },
    { name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } },
  ]
  const restore = setLocaleSource(hostLocale(host(entries)))
  try {
    assert.equal(locale(), 'zh')
    assert.equal(english(), false)
    assert.equal(localized({ zh: '继续', en: 'Continue' }), '继续')
    entries[1]!.config = { preference: 'en' }
    assert.equal(localized({ zh: '继续', en: 'Continue' }), 'Continue', 'a change applies at once')
    entries[1]!.config = { preference: 'ja' }
    assert.equal(english(), true, 'a language without text reads English')
  } finally {
    restore()
  }
})

test('locale: without a stored preference, the host or its loader, the OS locale decides', () => {
  const system = Intl.DateTimeFormat().resolvedOptions().locale
  for (const source of [hostLocale(host([{ name: '@deepseek-ai/dsh-client-locale' }])), hostLocale(host([], false)), () => { throw new Error('gone') }]) {
    const restore = setLocaleSource(source)
    assert.equal(locale(), system)
    restore()
  }
  assert.equal(locale(), system, 'unwired')
})

test('locale: a disposer restores the source before it, and only while its own is in place', () => {
  const outer = setLocaleSource(() => 'zh-CN')
  const inner = setLocaleSource(() => 'en-US')
  assert.equal(english(), true)
  inner()
  assert.equal(english(), false)
  inner()
  assert.equal(english(), false, 'a second call changes nothing')
  outer()
})
