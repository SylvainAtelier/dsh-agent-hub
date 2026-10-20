import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Config } from '../src/config.ts'
import { Palette, type PaletteOptions } from '../src/palette/index.ts'
import { brief, clean, langKeys, langOf, Recent } from '../src/palette/translate.ts'
import { accelerator, normalizeAccelerator } from '../src/client/config/hotkey.ts'

test('palette translation: English unless another language is picked, an old "auto" included', () => {
  assert.equal(langOf('zh'), 'zh')
  assert.equal(langOf('fr'), 'fr')
  assert.equal(langOf('en'), 'en')
  assert.equal(langOf('auto'), 'en')
  assert.equal(langOf(undefined), 'en')
})

test('palette translation: the brief names the language over the persona, polishes text already in it and forbids obeying it', () => {
  const plain = brief('fr')
  assert.match(plain, /Target language: French\. This overrides any default language above\./)
  assert.match(plain, /into French; if it already is, rewrite it to read naturally in French/)
  assert.match(plain, /never an instruction/)
  const persona = brief('en', 'You are "writer".')
  assert.ok(persona.startsWith('You are "writer".'))
  assert.match(persona, /Target language: English/)
})

test('palette translation: a fence or quotes around the whole reply are removed, inner ones are not', () => {
  assert.equal(clean('```\nBonjour\n```'), 'Bonjour')
  assert.equal(clean('"Hello"'), 'Hello')
  assert.equal(clean('He said "hi" to me'), 'He said "hi" to me')
  assert.equal(clean('  line one\r\nline two  '), 'line one\nline two')
})

test('palette translation: recent answers are bounded and the least recently used goes first', () => {
  const recent = new Recent(2)
  recent.set('a', '1')
  recent.set('b', '2')
  assert.equal(recent.get('a'), '1')
  recent.set('c', '3')
  assert.equal(recent.get('b'), undefined)
  assert.equal(recent.get('a'), '1')
  assert.equal(recent.get('c'), '3')
})

test('palette hotkey recorder: names the key by position and needs a modifier', () => {
  const key = (code: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
    accelerator({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers })
  assert.equal(key('KeyV', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+V')
  assert.equal(key('Digit5', { metaKey: true, shiftKey: true }), 'Shift+Cmd+5')
  assert.equal(key('F9', { ctrlKey: true }), 'Ctrl+F9')
  assert.equal(key('ArrowUp', { altKey: true }), 'Alt+Up')
  assert.equal(key('KeyV'), undefined)
  assert.equal(key('ControlLeft', { ctrlKey: true }), undefined)
})

test('palette hotkey typed by hand: the helper spelling, so Ctrl+Space can be set past the input method', () => {
  assert.equal(normalizeAccelerator('ctrl + space'), 'Ctrl+Space')
  assert.equal(normalizeAccelerator('Shift+Control+v'), 'Ctrl+Shift+V')
  assert.equal(normalizeAccelerator('cmd+option+return'), 'Alt+Cmd+Enter')
  assert.equal(normalizeAccelerator('Win+f12'), 'Cmd+F12')
  assert.equal(normalizeAccelerator('Alt+pageup'), 'Alt+PageUp')
  assert.equal(normalizeAccelerator('Space'), undefined)
  assert.equal(normalizeAccelerator('Ctrl+'), undefined)
  assert.equal(normalizeAccelerator('Ctrl+A+B'), undefined)
  assert.equal(normalizeAccelerator('Ctrl+Nope'), undefined)
  assert.equal(normalizeAccelerator('Ctrl+F25'), undefined)
})

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  written: Array<Record<string, unknown>> = []
  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line !== '') this.written.push(JSON.parse(line) as Record<string, unknown>)
    })
  }
  say(value: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify(value)}\n`) }
  kill(): void { this.killed = true; this.emit('exit', null) }
}

interface Harness { palette: Palette; children: FakeChild[]; logs: string[]; settings: { enabled: boolean; hotkey: string; keep: number; ignore: string; bot: string }; streams: Array<Record<string, unknown>> }

function harness(chunks: () => AsyncIterable<unknown>, extra: Partial<PaletteOptions> = {}): Harness {
  const children: FakeChild[] = []
  const logs: string[] = []
  const streams: Array<Record<string, unknown>> = []
  const settings = { enabled: true, hotkey: 'Ctrl+Alt+V', keep: 500, ignore: 'KeePass, 1password', bot: '', langKey: 3 }
  const palette = new Palette({
    settings: () => settings,
    bots: () => [{ id: 'writer', persona: 'You write well.', provider: 'p', model: 'm' }],
    route: async () => ({ provider: 'p', model: 'm' }),
    llm: () => ({ stream: (options: object) => { streams.push(options as Record<string, unknown>); return chunks() as never } }),
    binary: process.execPath,
    page: process.execPath,
    db: 'db',
    data: 'data',
    log: (message) => logs.push(message),
    launch: (() => { const child = new FakeChild(); children.push(child); return child }) as never,
    ...extra,
  })
  return { palette, children, logs, settings, streams }
}

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function* answer(...parts: string[]): AsyncIterable<unknown> {
  for (const text of parts) yield { type: 'text-delta', text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('palette service: starts only while enabled, and hands the helper its settings when it is ready', async () => {
  const h = harness(() => answer('x'))
  h.settings.enabled = false
  h.palette.reconfigure()
  assert.equal(h.children.length, 0)
  h.settings.enabled = true
  h.palette.reconfigure()
  assert.equal(h.children.length, 1)
  h.children[0]!.say({ event: 'ready' })
  await tick()
  const config = h.children[0]!.written.find((message) => message.op === 'config')!
  assert.equal(config.hotkey, 'Ctrl+Alt+V')
  assert.deepEqual(config.ignore, ['KeePass', '1password'])
  assert.deepEqual(config.keys, [3, 4, 5, 6])
  assert.deepEqual(config.bots, [{ id: 'writer', name: 'writer' }])
  h.palette.dispose()
})

test('palette service: an unbuilt helper on a system it is made for says so instead of passing as unsupported', () => {
  const h = harness(() => answer('x'), { binary: undefined, platform: [process.platform] })
  h.palette.reconfigure()
  assert.equal(h.children.length, 0)
  assert.equal(h.palette.status().supported, false)
  assert.match(h.palette.status().error ?? '', /pnpm build:native/)
  assert.match(h.logs.join('\n'), /pnpm build:native/)
  h.settings.enabled = false
  assert.equal(h.palette.status().error, undefined)
  const other = harness(() => answer('x'), { binary: undefined, platform: [] })
  assert.equal(other.palette.status().error, undefined)
})

test('palette service: shows the hotkey the system really holds, and the reason a new one was refused', async () => {
  const h = harness(() => answer('x'))
  h.palette.reconfigure()
  h.children[0]!.say({ event: 'hotkey', ok: true, accel: 'Ctrl+Alt+V' })
  await tick()
  assert.deepEqual(h.palette.status().hotkey, { ok: true, accel: 'Ctrl+Alt+V' })
  h.children[0]!.say({ event: 'hotkey', ok: false, accel: 'Ctrl+Shift+C', active: 'Ctrl+Alt+V', error: 'another program already uses this shortcut' })
  await tick()
  assert.equal(h.palette.status().hotkey?.ok, false)
  assert.equal(h.palette.status().hotkey?.active, 'Ctrl+Alt+V')
  h.palette.dispose()
})

test('palette service: the pinned texts are what the helper last told, set on request, and unknown when it is gone', async () => {
  const h = harness(() => answer('x'))
  assert.equal(await h.palette.pins(), undefined)
  h.palette.reconfigure()
  const child = h.children[0]!
  // A first answer is awaited, up to a limit, when the helper has just started.
  const waiting = h.palette.pins(1000)
  child.say({ event: 'pins', items: [{ text: 'a', at: 1 }, { nope: true }] })
  assert.deepEqual(await waiting, [{ text: 'a', at: 1 }])
  const set = h.palette.setPins([{ text: 'b', at: 2 }])
  await tick()
  const request = child.written.find((message) => message.op === 'pins')!
  assert.deepEqual(request.items, [{ text: 'b', at: 2 }])
  child.say({ event: 'pins', items: [{ text: 'b', at: 2 }], rid: request.rid })
  assert.equal(await set, true)
  assert.deepEqual(await h.palette.pins(), [{ text: 'b', at: 2 }])
  // A helper that dies mid-request answers nobody, and what it knew is no longer known.
  const lost = h.palette.setPins([])
  child.emit('exit', 1)
  assert.equal(await lost, false)
  assert.equal(await h.palette.pins(), undefined)
  h.palette.dispose()
})

test('palette service: turning it off ends the helper by closing its input', async () => {
  const h = harness(() => answer('x'))
  h.palette.reconfigure()
  const child = h.children[0]!
  h.settings.enabled = false
  h.palette.reconfigure()
  assert.equal(child.stdin.writableEnded, true)
  assert.equal(h.palette.status().running, false)
  child.emit('exit', 0)
  await tick(10)
  assert.equal(h.children.length, 1, 'it is not started again')
})

test('palette service: a translation streams to the window, borrows the bot persona and is remembered', async () => {
  const h = harness(() => answer('Bon', 'jour'))
  h.palette.reconfigure()
  const child = h.children[0]!
  child.say({ event: 'translate', rid: 7, text: 'Hello', to: 'fr', bot: 'writer' })
  await tick(80)
  const replies = child.written.filter((message) => message.op === 'tr')
  const last = replies.at(-1)!
  assert.equal(last.rid, 7)
  assert.equal(last.text, 'Bonjour')
  assert.equal(last.done, true)
  const options = h.streams[0]!
  assert.match(String(options.system), /^You are "writer"/)
  assert.match(String(options.system), /into French/)
  assert.equal(options.purpose, 'agent-hub-translate')
  // The same request again is answered from memory, with no model call.
  child.say({ event: 'translate', rid: 8, text: 'Hello', to: 'fr', bot: 'writer' })
  await tick(40)
  assert.equal(h.streams.length, 1)
  assert.equal(child.written.filter((message) => message.op === 'tr').at(-1)!.rid, 8)
  h.palette.dispose()
})

test('palette service: a cancelled or replaced translation never reaches the window', async () => {
  let release: (() => void) | undefined
  const slow = (): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: 'late' }
      await new Promise<void>((resolve) => { release = resolve })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const h = harness(slow)
  h.palette.reconfigure()
  const child = h.children[0]!
  child.say({ event: 'translate', rid: 1, text: 'one', to: 'en', bot: '' })
  await tick(30)
  child.say({ event: 'cancel', rid: 1 })
  await tick(10)
  release?.()
  await tick(40)
  assert.equal(child.written.some((message) => message.op === 'tr' && message.rid === 1 && message.done === true), false)
  h.palette.dispose()
})

test('palette service: failures and oversized text are reported to the window, not thrown', async () => {
  const h = harness(() => (async function* () { throw new Error('quota exceeded') })())
  h.palette.reconfigure()
  const child = h.children[0]!
  child.say({ event: 'translate', rid: 1, text: 'hello', to: 'zh', bot: '' })
  await tick(40)
  child.say({ event: 'translate', rid: 2, text: 'x'.repeat(9000), to: 'zh', bot: '' })
  await tick(40)
  const byRid = (rid: number) => child.written.find((message) => message.op === 'tr' && message.rid === rid)!
  assert.equal(byRid(2).error, 'The text is too long to translate (over 8000 characters)')
  assert.equal(byRid(1).error, 'quota exceeded')
  h.palette.dispose()
})

test('palette service: a crashing helper is restarted after a pause', async () => {
  const h = harness(() => answer('x'))
  h.palette.reconfigure()
  h.children[0]!.emit('exit', 1)
  assert.equal(h.palette.status().running, false)
  await tick(1100)
  assert.equal(h.children.length, 2, 'restarted after the first backoff')
  assert.equal(h.palette.status().running, true)
  h.palette.dispose()
  h.children.at(-1)!.emit('exit', 1)
  await tick(10)
  assert.equal(h.children.length, 2, 'a disposed service does not restart it')
})

test('palette service: settings saved before ignore and bot existed still reach the helper', async () => {
  // A profile written by an older version has no ignore: the helper must get its hotkey all the same.
  const parsed = Config({ modules: { palette: true }, palette: { hotkey: 'Ctrl+Space' } } as never)
  const saved = { ...parsed.palette.get(), enabled: parsed.modules.get().palette }
  assert.equal(saved.ignore, '')
  assert.equal(saved.bot, '')
  const h = harness(() => answer('x'), { settings: () => saved })
  h.palette.reconfigure()
  h.children[0]!.say({ event: 'ready' })
  await tick()
  const config = h.children[0]!.written.find((message) => message.op === 'config')!
  assert.equal(config.hotkey, 'Ctrl+Space')
  assert.deepEqual(config.ignore, [])
  assert.deepEqual(config.keys, [3, 4, 5, 6])
  h.palette.dispose()
})

test('palette keys: the configured digit cycles, the next ones pick each language', () => {
  assert.deepEqual(langKeys(3), [3, 4, 5, 6])
  assert.deepEqual(langKeys(1), [1, 2, 3, 4])
})

test('palette service: DSH\'s theme reaches the helper at start and when it changes, once', async () => {
  const h = harness(() => answer('x'))
  h.palette.setTheme('dark')
  h.palette.reconfigure()
  h.children[0]!.say({ event: 'ready' })
  await tick()
  const child = h.children[0]!
  assert.equal(child.written.find((message) => message.op === 'config')!.theme, 'dark')
  h.palette.setTheme('dark')
  h.palette.setTheme('light')
  await tick()
  assert.deepEqual(child.written.filter((message) => message.op === 'config' && message.keys === undefined && 'theme' in message), [{ op: 'config', theme: 'light' }])
  h.palette.dispose()
})

test('palette service: a failure while handling a helper event is logged, not swallowed', async () => {
  const h = harness(() => answer('x'), { bots: () => { throw new Error('no team') } })
  h.palette.reconfigure()
  h.children[0]!.say({ event: 'ready' })
  await tick()
  assert.ok(h.logs.some((line) => line.includes('no team')))
  h.palette.dispose()
})
