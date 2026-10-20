import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffCells, pickDiff, selectionMenu } from '../src/client/git/selection.ts'
import { parseDiff, type DiffLine } from '../src/client/git/diff.ts'
import { editorShared, insertIntoSession, isMenuKey, textBlock } from '../src/client/editor/shared.ts'
import type { RepoStore } from '../src/client/git/store.ts'

const target = { path: 'src/a.ts', source: 'staged' as const, code: 'M' as const }
const lines = parseDiff('@@ -10,3 +10,3 @@\n before\n-old one\n-old two\n+new one\n+new two\n').lines

test('inline selection preserves deleted/added text, source and both line number spaces', () => {
  const cells = diffCells(lines, 'inline')
  const result = pickDiff(lines, cells, { cell: 2, offset: 0 }, { cell: 5, offset: 7 }, target)!
  assert.equal(result.text, 'old one\nold two\nnew one\nnew two')
  assert.match(result.draft, /Source: staged/)
  assert.match(result.draft, /old L11-12 · new L11-12/)
  assert.match(result.draft, /-old one\n-old two\n\+new one\n\+new two/)
  assert.doesNotMatch(result.draft, /@src/)
})

test('split selection down the old column never includes the new column', () => {
  const cells = diffCells(lines, 'split')
  const start = cells.findIndex((cell) => cell.side === 'old' && cell.index === 2)
  const end = cells.findIndex((cell) => cell.side === 'old' && cell.index === 3)
  const result = pickDiff(lines, cells, { cell: start, offset: 4 }, { cell: end, offset: 3 }, target)!
  assert.equal(result.text, 'one\nold')
  assert.match(result.draft, /Old version · old L11-12/)
  assert.doesNotMatch(result.draft, /new one|new two|New version/)
  assert.deepEqual(pickDiff(lines, cells, { cell: end, offset: 3 }, { cell: start, offset: 4 }, target), result)
})

test('split mixed-column selection discloses old and new as separate version sections', () => {
  const cells = diffCells(lines, 'split')
  const start = cells.findIndex((cell) => cell.side === 'old' && cell.index === 2)
  const end = cells.findIndex((cell) => cell.side === 'new' && cell.index === 5)
  const result = pickDiff(lines, cells, { cell: start, offset: 0 }, { cell: end, offset: 7 }, { ...target, source: 'commit', hash: 'abc123', from: 'src/old.ts' })!
  assert.match(result.draft, /Old version/)
  assert.match(result.draft, /New version/)
  assert.match(result.draft, /Source: commit abc123/)
  assert.match(result.draft, /from "src\/old.ts"/)
})

test('selection ending at the next line start does not include that line', () => {
  const cells = diffCells(lines, 'inline')
  const result = pickDiff(lines, cells, { cell: 2, offset: 0 }, { cell: 3, offset: 0 }, target)!
  assert.equal(result.text, 'old one')
  assert.match(result.draft, /old L11\n/)
})

test('model selection includes all intermediate lines without requiring mounted DOM rows', () => {
  const model: DiffLine[] = Array.from({ length: 2000 }, (_, index) => ({ kind: 'add', text: `line ${index}`, new: index + 1 }))
  const result = pickDiff(model, diffCells(model, 'inline'), { cell: 0, offset: 0 }, { cell: 1999, offset: 9 }, target)!
  assert.equal(result.text.split('\n').length, 2000)
  assert.match(result.draft, /new L1-2000/)
  assert.match(result.text, /line 1000/)
})

test('empty, invalid and collapsed selections are not expanded to the entire diff', () => {
  const cells = diffCells(lines, 'inline')
  assert.equal(pickDiff(lines, cells, { cell: 2, offset: 3 }, { cell: 2, offset: 3 }, target), undefined)
  assert.equal(pickDiff(lines, cells, { cell: -1, offset: 0 }, { cell: 2, offset: 3 }, target), undefined)
  assert.equal(pickDiff([], [], { cell: 0, offset: 0 }, { cell: 1, offset: 1 }, target), undefined)
})

test('selected text keeps whitespace, Unicode and blank intermediate lines', () => {
  const model: DiffLine[] = [{ kind: 'add', text: '\t你好🙂 ', new: 1 }, { kind: 'add', text: '', new: 2 }, { kind: 'add', text: '  tail', new: 3 }]
  const result = pickDiff(model, diffCells(model, 'inline'), { cell: 0, offset: 0 }, { cell: 2, offset: 6 }, target)!
  assert.equal(result.text, '\t你好🙂 \n\n  tail')
})

test('text fences cannot be closed by terminal or diff contents', () => {
  assert.equal(textBlock('a\n```\nb'), '````text\na\n```\nb\n````')
  assert.equal(textBlock('a\n'), '```text\na\n```')
  assert.equal(textBlock(''), '```text\n\n```')
})

test('composer insertion is scoped to the supplied session and preserves its insertion contract', () => {
  const writes: string[] = []
  const span = { position: 42 }
  editorShared.composers.set('selection-a', { captureInsertion: () => span, insertText: (text, captured) => { assert.equal(captured, span); writes.push(text); return true } })
  editorShared.composers.set('selection-b', { captureInsertion: () => { throw new Error('wrong session') }, insertText: () => false })
  try {
    assert.equal(insertIntoSession('selection-a', 'selected'), true)
    assert.deepEqual(writes, ['selected'])
    assert.equal(insertIntoSession('missing', 'selected'), false)
    editorShared.composers.set('selection-a', { captureInsertion: () => span, insertText: () => false })
    assert.equal(insertIntoSession('selection-a', 'selected'), false)
  } finally {
    editorShared.composers.delete('selection-a')
    editorShared.composers.delete('selection-b')
  }
})

test('the keyboard opens selection menus with the Menu key or Shift+F10 only', () => {
  assert.equal(isMenuKey({ key: 'ContextMenu', shiftKey: false }), true)
  assert.equal(isMenuKey({ key: 'F10', shiftKey: true }), true)
  assert.equal(isMenuKey({ key: 'F10', shiftKey: false }), false)
  assert.equal(isMenuKey({ key: 'Enter', shiftKey: true }), false)
})

test('selection menu: no snapshot disables both actions; add reports through the repo toast, offering the way back', () => {
  const toasts: Array<{ kind: string; text: string; action?: string }> = []
  const repo = { toast: (kind: string, text: string, _detail?: string, action?: { label: string; run(): void }) => {
    toasts.push({ kind, text, ...(action === undefined ? {} : { action: action.label }) })
  } } as unknown as RepoStore
  const drafts: string[] = []
  const empty = selectionMenu(undefined, { insert: () => true, repo })
  assert.deepEqual(empty.entries.map((entry) => 'id' in entry && entry.disabled), [true, true])
  empty.onSelect('add')
  assert.equal(toasts.length, 0)

  const pick = { text: 'x', draft: 'draft' }
  selectionMenu(pick, { insert: (draft) => { drafts.push(draft); return true }, repo, backToSession: () => {} }).onSelect('add')
  selectionMenu(pick, { insert: () => true, repo }).onSelect('add')
  selectionMenu(pick, { insert: () => false, repo, backToSession: () => {} }).onSelect('add')
  assert.deepEqual(drafts, ['draft'])
  assert.equal(toasts[0]!.kind, 'ok')
  assert.ok(toasts[0]!.action !== undefined, 'success offers Back to session when the shell has one')
  assert.equal(toasts[1]!.action, undefined)
  assert.equal(toasts[2]!.kind, 'error')
  assert.equal(toasts[2]!.action, undefined, 'a failed insert offers nothing to go back to')
})
