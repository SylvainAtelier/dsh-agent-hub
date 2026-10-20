import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampColumn, columnRoom, COLUMN_DEFAULTS, fitColumns, readWidths, writeWidths } from '../src/client/git/columns.ts'
import { commitMatches, findKey, splitMatches } from '../src/client/git/find.ts'
import { keepRef, readStarred, scopeNames, writeStarred } from '../src/client/git/scope.ts'
import type { Commit, Ref } from '../src/git/types.ts'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key) },
    setItem: (key, value) => { data.set(key, String(value)) },
  }
}

test('columns: wide panes show every column at its width, narrow ones drop hash, then author, then date', () => {
  assert.deepEqual(fitColumns(1000, {}, 48), { graph: 48, ...COLUMN_DEFAULTS })
  const mid = fitColumns(560, {}, 48)
  assert.equal(mid.hash, 0)
  assert.ok(mid.author > 0 && mid.date > 0)
  const narrow = fitColumns(400, {}, 48)
  assert.deepEqual([narrow.hash, narrow.author, narrow.date > 0], [0, 0, true])
  const phone = fitColumns(260, {}, 48)
  assert.deepEqual([phone.hash, phone.author, phone.date], [0, 0, 0])
})

test('columns: user widths are clamped and the graph never takes more than 60%', () => {
  const fitted = fitColumns(1600, { graph: 900, author: 5, date: 1000 }, 48)
  assert.equal(fitted.graph, 480)
  assert.equal(fitted.author, 48)
  assert.equal(fitted.date, 220)
  assert.equal(fitColumns(300, { graph: 400 }, 48).graph, 180)
  assert.equal(clampColumn('hash', 64.4), 64)
})

test('columns: widths persist per repository and survive bad storage', () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage?: Storage }).localStorage = memoryStorage()
  try {
    assert.deepEqual(readWidths('/a'), {})
    writeWidths('/a', { graph: 90, author: 140 })
    writeWidths('/b', { date: 150 })
    assert.deepEqual(readWidths('/a'), { graph: 90, author: 140 })
    assert.deepEqual(readWidths('/b'), { date: 150 })
    writeWidths('/a', {})
    assert.deepEqual(readWidths('/a'), {})
    localStorage.setItem('dsh-agent-hub.git.graph.columns', JSON.stringify({ '/c': { graph: 'x', author: 9999 } }))
    assert.deepEqual(readWidths('/c'), { author: 320 })
    localStorage.setItem('dsh-agent-hub.git.graph.columns', '{broken')
    assert.deepEqual(readWidths('/c'), {})
  } finally {
    ;(globalThis as { localStorage?: Storage }).localStorage = original
  }
})

test('find: matches subject, author, email, hash prefix and ref names', () => {
  const commit: Commit = { hash: 'abcdef1234', parents: [], author: 'Ada Lovelace', email: 'ada@example.com', at: 0, subject: 'Fix the Graph layout' }
  const refs: Ref[] = [{ kind: 'head', name: 'feature/search', hash: 'abcdef1234' }]
  assert.equal(findKey('  GRAPH '), 'graph')
  for (const query of ['graph', 'lovelace', 'example.com', 'abcd', 'search']) assert.ok(commitMatches(commit, refs, findKey(query)), query)
  assert.ok(!commitMatches(commit, refs, 'abc'))
  assert.ok(!commitMatches(commit, refs, 'missing'))
  assert.ok(!commitMatches(commit, refs, ''))
  assert.deepEqual(splitMatches('Graph the graph', 'graph'), ['', 'Graph', ' the ', 'graph', ''])
  assert.deepEqual(splitMatches('nothing', 'x'), ['nothing'])
})

test('columns: a column can only widen as far as the description can spare', () => {
  const fitted = fitColumns(700, {}, 48)
  const room = columnRoom(700, fitted, 'author')
  assert.ok(room > fitted.author)
  const wider = fitColumns(700, { author: room }, 48)
  assert.ok(wider.author > 0 && wider.date > 0, 'widening to the room keeps the other columns')
  assert.equal(fitColumns(700, { author: room + 40 }, 48).hash, 0)
  assert.ok(columnRoom(700, fitted, 'graph') <= 420)
})

test('scope: a scoped graph keeps its own branch, its upstream or tracking twin, and tags', () => {
  const refs: Ref[] = [
    { kind: 'head', name: 'main', hash: 'a', upstream: 'origin/main' },
    { kind: 'head', name: 'wt1', hash: 'b' },
    { kind: 'remote', name: 'origin/main', hash: 'a' },
    { kind: 'remote', name: 'origin/wt1', hash: 'b' },
    { kind: 'tag', name: 'v1', hash: 'b' },
  ]
  const names = scopeNames(refs, 'main')
  assert.deepEqual(refs.filter((ref) => keepRef(ref, names)).map((ref) => ref.name), ['main', 'origin/main', 'v1'])
  assert.deepEqual([...scopeNames(refs, 'origin/main')].sort(), ['main', 'origin/main'])
  assert.deepEqual([...scopeNames(refs, 'v1')], ['v1'])
})

test('scope: starred refs are remembered per repository, deduplicated, and cleared when empty', () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage
  const storage = memoryStorage()
  ;(globalThis as { localStorage?: Storage }).localStorage = storage
  try {
    assert.deepEqual(readStarred('/repo'), [])
    writeStarred('/repo', ['main', 'origin/dev', 'main'])
    writeStarred('/other', ['v1.0'])
    assert.deepEqual(readStarred('/repo'), ['main', 'origin/dev'])
    assert.deepEqual(readStarred('/other'), ['v1.0'])
    writeStarred('/repo', [])
    assert.deepEqual(readStarred('/repo'), [])
    assert.ok(!(storage.getItem('dsh-agent-hub.git.graph.starred') ?? '').includes('/repo'))
    storage.setItem('dsh-agent-hub.git.graph.starred', '{"/repo":["ok",3,null]}')
    assert.deepEqual(readStarred('/repo'), ['ok'])
    // Stars saved under a worktree path are read as the fallback for the shared key, then replaced by it.
    storage.setItem('dsh-agent-hub.git.graph.starred', '{"/repo/.worktrees/a":["dev"]}')
    assert.deepEqual(readStarred('/repo/.git', '/repo/.worktrees/a'), ['dev'])
    writeStarred('/repo/.git', [], '/repo/.worktrees/a')
    assert.deepEqual(readStarred('/repo/.git', '/repo/.worktrees/a'), [])
    writeStarred('/repo/.git', ['main'], '/repo')
    assert.deepEqual(readStarred('/repo/.git', '/repo/.worktrees/b'), ['main'])
  } finally {
    ;(globalThis as { localStorage?: Storage }).localStorage = original
  }
})
