import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EditorState, Text } from '@codemirror/state'
import { Buffers, changesTo, fileKey } from '../src/client/editor/chunk/buffers.ts'
import { changeMarkers } from '../src/client/editor/chunk/extensions.ts'
import { fileAddress, opensAsCode, parseAddress, type FilesCall } from '../src/client/editor/shared.ts'
import type { FilesReply, FilesRequest, FileText } from '../src/files/types.ts'

/** A one-file disk behind the files RPC, with the host's hash precondition. */
function disk(initial: string | undefined) {
  let text = initial
  const hash = (value: string): string => createHash('sha1').update(value).digest('hex')
  const file = (): FileText => ({ absolutePath: 'C:\\ws\\a.ts', path: 'a.ts', text: text!, hash: hash(text!), eol: 'lf', bom: false, size: text!.length })
  const call = (async (request: FilesRequest): Promise<FilesReply<unknown>> => {
    if (request.op === 'read') return text === undefined ? { ok: false, error: { code: 'not-found', message: 'gone' } } : { ok: true, value: file() }
    if (request.op === 'base') return { ok: true, value: {} }
    if (request.op === 'write') {
      const current = text === undefined ? null : hash(text)
      if (current !== request.base) {
        return { ok: false, error: { code: 'conflict', message: 'changed', ...(text === undefined ? { deleted: true } : { current: file() }) } }
      }
      text = request.text
      return { ok: true, value: { hash: hash(text), size: text.length } }
    }
    return { ok: false, error: { code: 'invalid', message: 'unexpected' } }
  }) as FilesCall
  return { call, get: () => text, set: (next: string | undefined) => { text = next } }
}

const settle = (ms = 100): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function openTab(buffers: Buffers, call: FilesCall, tab: string) {
  const result = await buffers.open(call, tab, 'C:\\ws', 'a.ts')
  assert.ok(result.ok)
  const buffer = result.buffer
  const { state } = buffer.unpark(tab, (doc) => EditorState.create({ doc }))
  buffer.parked.set(tab, { state, scroll: { top: 0, left: 0 } })
  /** Type into this tab, as its view would. */
  const type = (insert: string, at = 0): void => {
    const parked = buffer.parked.get(tab)!
    const tr = parked.state.update({ changes: { from: at, insert } })
    parked.state = tr.state
    buffer.edited(tab, tr)
  }
  return { buffer, type, doc: () => buffer.parked.get(tab)!.state.doc.toString() }
}

test('buffers: one per file, edits replayed into the other tabs, saved with its base', async () => {
  const files = disk('one\ntwo\n')
  const dirty = new Map<string, boolean>()
  const buffers = new Buffers((tabs, value) => { for (const tab of tabs) dirty.set(tab, value) })
  const a = await openTab(buffers, files.call, 'A')
  const b = await openTab(buffers, files.call, 'B')
  assert.equal(a.buffer, b.buffer)
  a.type('// ')
  assert.equal(b.doc(), '// one\ntwo\n')
  assert.equal(a.buffer.snapshot.dirty, true)
  assert.deepEqual([dirty.get('A'), dirty.get('B')], [true, true])
  assert.equal(await a.buffer.save(), true)
  assert.equal(files.get(), '// one\ntwo\n')
  assert.equal(a.buffer.snapshot.dirty, false)
  assert.equal(dirty.get('B'), false)
  // Typing back to the saved text is clean again (equal length: settled after a beat).
  a.type('x', 3)
  const tr = a.buffer.parked.get('A')!.state.update({ changes: { from: 3, to: 4 } })
  a.buffer.parked.get('A')!.state = tr.state
  a.buffer.edited('A', tr)
  await settle()
  assert.equal(a.buffer.snapshot.dirty, false)
  buffers.release('A')
  buffers.release('B')
})

test('buffers: a clean buffer follows the disk; a dirty one reports the conflict', async () => {
  const files = disk('a\n')
  const buffers = new Buffers(() => {})
  const tab = await openTab(buffers, files.call, 'A')
  files.set('a\nagent\n')
  await tab.buffer.checkDisk()
  assert.equal(tab.doc(), 'a\nagent\n')
  assert.equal(tab.buffer.snapshot.dirty, false)
  tab.type('mine ')
  files.set('a\nagent 2\n')
  await tab.buffer.checkDisk()
  assert.equal(tab.doc(), 'mine a\nagent\n')
  assert.equal(tab.buffer.snapshot.conflict?.text, 'a\nagent 2\n')
  // A save from the stale base is refused; overwriting is the person's call.
  assert.equal(await tab.buffer.save(), false)
  assert.equal(files.get(), 'a\nagent 2\n')
  assert.equal(await tab.buffer.save(true), true)
  assert.equal(files.get(), 'mine a\nagent\n')
  assert.equal(tab.buffer.snapshot.conflict, undefined)
  // Or take the disk version instead.
  tab.type('again ')
  files.set('theirs\n')
  await tab.buffer.checkDisk()
  tab.buffer.takeDisk()
  assert.equal(tab.doc(), 'theirs\n')
  assert.equal(tab.buffer.snapshot.dirty, false)
  // Deleted on disk: saving recreates it.
  files.set(undefined)
  await tab.buffer.checkDisk()
  assert.deepEqual(tab.buffer.snapshot.conflict, { hash: null })
  assert.equal(await tab.buffer.save(true), true)
  assert.equal(files.get(), 'theirs\n')
  buffers.release('A')
})

test('buffers: an agent writing the same text as the unsaved edit makes it clean', async () => {
  const files = disk('x\n')
  const buffers = new Buffers(() => {})
  const tab = await openTab(buffers, files.call, 'A')
  tab.type('y')
  files.set('yx\n')
  await tab.buffer.checkDisk()
  assert.equal(tab.buffer.snapshot.dirty, false)
  assert.equal(tab.buffer.snapshot.conflict, undefined)
  buffers.release('A')
})

test('minimal changes keep untouched text in place', () => {
  const doc = Text.of(['alpha', 'beta', 'gamma'])
  const changes = changesTo(doc, 'alpha\r\nBETA\r\ngamma')
  let touched = 0
  changes.iterChanges((fromA, toA) => { touched += toA - fromA })
  assert.equal(touched, 4)
  assert.equal(changes.apply(doc).toString(), 'alpha\nBETA\ngamma')
  assert.ok(changesTo(doc, 'alpha\nbeta\ngamma').empty)
  assert.equal(fileKey('C:\\Repo\\A.ts'), 'c:/repo/a.ts')
  assert.equal(fileKey('/home/A.ts'), '/home/A.ts')
})

test('change markers: added, modified and deleted lines against HEAD', () => {
  const base = Text.of(['a', 'b', 'c', 'd'])
  const doc = Text.of(['a', 'B', 'c', 'new', 'd'])
  const marks: Array<[number, string]> = []
  changeMarkers(base, doc).between(0, doc.length, (from, _to, marker) => { marks.push([doc.lineAt(from).number, (marker as unknown as { kind: string }).kind]) })
  assert.deepEqual(marks, [[2, 'modified'], [4, 'added']])
  const removed: Array<[number, string]> = []
  const shorter = Text.of(['a', 'd'])
  changeMarkers(base, shorter).between(0, shorter.length, (from, _to, marker) => { removed.push([shorter.lineAt(from).number, (marker as unknown as { kind: string }).kind]) })
  assert.deepEqual(removed, [[2, 'deleted']])
})

test('addresses: DSH file links round-trip, and only text files open as code', () => {
  const address = fileAddress('s 1', 'C:\\ws', 'C:\\ws\\src\\a b.ts')
  assert.equal(address, 'dsh-resource://file/session/s%201/src/a%20b.ts')
  assert.deepEqual(parseAddress(address), { sessionId: 's 1', path: 'src/a b.ts' })
  assert.deepEqual(parseAddress(fileAddress('s', 'C:\\ws', 'D:\\other\\x.py')), { sessionId: 's', path: 'D:/other/x.py' })
  for (const path of ['a.ts', 'src/main.rs', 'Dockerfile', '.gitignore', '.env.local', 'Makefile', 'notes.txt']) assert.ok(opensAsCode(path), path)
  for (const path of ['README.md', 'index.html', 'logo.png', 'doc.pdf', 'sheet.xlsx', 'data.csv']) assert.ok(!opensAsCode(path), path)
})
