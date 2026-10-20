import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, writeFile, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Canvases, isCanvasName } from '../src/canvas/index.ts'

test('canvas: only plain .html names are canvases', () => {
  assert.ok(isCanvasName('sales-q3.html'))
  assert.ok(isCanvasName('销售.HTML'))
  for (const bad of ['../x.html', 'a/b.html', 'a\\b.html', '.hidden.html', 'x.txt', 'x.html\0', 3, undefined]) assert.ok(!isCanvasName(bad), String(bad))
})

test('canvas: lists newest first with titles, reads and removes by name', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'canvas-')), 'canvases')
  const canvases = new Canvases(dir, join(dir, '..', 'references'))
  assert.deepEqual((await canvases.list()).items, [])
  await writeFile(join(dir, 'old.html'), '<html><head><title>Old &amp; gold</title></head></html>')
  await writeFile(join(dir, 'new.html'), '<h1>no title</h1>')
  await writeFile(join(dir, 'notes.txt'), 'x')
  await writeFile(join(dir, 'new.delivery.json'), '{}')
  await writeFile(join(dir, 'old.delivery.json'), '{}')
  await utimes(join(dir, 'old.html'), new Date(2026, 0, 1), new Date(2026, 0, 1))
  const { items } = await canvases.list()
  assert.deepEqual(items.map((item) => [item.name, item.title]), [['new.html', 'new'], ['old.html', 'Old & gold']])
  assert.equal(items[0]!.path, join(dir, 'new.html'))
  assert.equal(await canvases.read('new.html'), '<h1>no title</h1>')
  await assert.rejects(canvases.read('../escape.html'), /invalid canvas name/)
  assert.deepEqual(((await canvases.handle({ op: 'remove', name: 'new.html' })) as { items: unknown[] }).items.length, 1)
  assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'x')
  // Archify's receipt goes with its page, and only with its page.
  await assert.rejects(access(join(dir, 'new.delivery.json')))
  await access(join(dir, 'old.delivery.json'))
})

test('canvas: an @session snapshot is saved once per content, listed and read as a reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-'))
  const canvases = new Canvases(join(root, 'canvases'), join(root, 'references'))
  const path = canvases.save('## Referenced sessions\n\n{"a":1}', ['IPA 分析', 'Login'])
  assert.equal(canvases.save('## Referenced sessions\n\n{"a":1}', ['IPA 分析', 'Login']), path)
  assert.match(await readFile(path, 'utf8'), /^# @IPA 分析, @Login\n\n## Referenced sessions/)
  const list = await canvases.list()
  assert.deepEqual(list.items, [])
  assert.deepEqual(list.references.map((item) => [item.kind, item.path, item.title]), [['reference', path, '@IPA 分析, @Login']])
  const name = list.references[0]!.name
  assert.match(await canvases.read(name, 'reference'), /\{"a":1\}/)
  await assert.rejects(canvases.read(name), /invalid canvas name/)
  await assert.rejects(canvases.read('../x.md', 'reference'), /invalid snapshot name/)
  assert.equal(((await canvases.handle({ op: 'remove', name, kind: 'reference' })) as { references: unknown[] }).references.length, 0)
})

test('canvas: the source is the session whose log writes the page, a subagent counting for its parent', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const { mkdir } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'canvas-'))
  const sessions = join(root, 'sessions')
  const canvases = new Canvases(join(root, 'canvases'), join(root, 'references'), { sessions, archived: (id) => id === 'session-archived' })
  await canvases.list()
  const page = join(root, 'canvases', 'chart.html')
  await writeFile(page, '<title>Chart</title>')
  await utimes(page, new Date(2026, 0, 1), new Date(2026, 0, 1))
  const at = new Date(2026, 0, 1).getTime()
  const log = async (id: string, header: Record<string, unknown>, events: Array<Record<string, unknown>>): Promise<void> => {
    await mkdir(join(sessions, 'project', id), { recursive: true })
    const lines = [{ type: 'session', version: 4, id, ...header }, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n'
    await writeFile(join(sessions, 'project', id, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
  }
  assert.equal(await canvases.source('chart.html'), null)
  // A later reply that only mentions the page loses to the write; the archived session's write is not offered.
  await log('session-reader', {}, [{ type: 'assistant/message', time: at, data: { message: { content: [{ type: 'text', text: `see ${page}` }] } } }])
  await log('session-archived', {}, [{ type: 'tool/call', time: at, data: { name: 'write', arguments: JSON.stringify({ file_path: page }) } }])
  await log('sub', { origin: 'subagent', parentSession: 'session-maker' }, [{ type: 'tool/call', time: at + 5_000, data: { name: 'write', arguments: JSON.stringify({ file_path: page }) } }])
  await log('session-maker', {}, [{ type: 'session/title', data: { title: 'Make a chart' } }])
  // An unknown answer is kept for a while: a page whose maker's reply has not come yet is asked again later.
  assert.equal(await canvases.source('chart.html'), null)
  await utimes(page, new Date(2026, 0, 1, 0, 0, 1), new Date(2026, 0, 1, 0, 0, 1))
  assert.deepEqual(await canvases.handle({ op: 'source', name: 'chart.html' }), { sessionId: 'session-maker', title: 'Make a chart' })
  await assert.rejects(canvases.source('../x.html'), /invalid canvas name/)
})
