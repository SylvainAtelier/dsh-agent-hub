import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTree, flattenTree, itemsOf, treeOrder } from '../src/client/git/tree.ts'
import { AuthNotices, authMessage, isAuthText } from '../src/claude/auth.ts'

const paths = ['src/client/git/a.ts', 'src/client/git/b.ts', 'src/git/x.ts', 'README.md', 'docs/deep/only/file.md']

test('tree: folders first, alphabetical, single-child chains compacted', () => {
  const root = buildTree(paths, (p) => p)
  assert.deepEqual(root.dirs.map((d) => [d.name, d.path, d.count]), [['docs/deep/only', 'docs/deep/only', 1], ['src', 'src', 3]])
  assert.deepEqual(root.files.map((f) => f.name), ['README.md'])
  const src = root.dirs[1]!
  assert.deepEqual(src.dirs.map((d) => d.name), ['client/git', 'git'])
  assert.equal(root.count, 5)
})

test('tree: flatten respects collapsed folders and keeps depth', () => {
  const root = buildTree(paths, (p) => p)
  const open = flattenTree(root, new Set())
  assert.deepEqual(open.map((r) => (r.kind === 'dir' ? `${r.depth}+${r.dir.name}` : `${r.depth}-${r.file.name}`)), [
    '0+docs/deep/only', '1-file.md', '0+src', '1+client/git', '2-a.ts', '2-b.ts', '1+git', '2-x.ts', '0-README.md',
  ])
  const closed = flattenTree(root, new Set(['src/client/git', 'docs/deep/only']))
  assert.deepEqual(closed.map((r) => (r.kind === 'dir' ? `${r.dir.name}${r.open ? '' : '▸'}` : r.file.name)), [
    'docs/deep/only▸', 'src', 'client/git▸', 'git', 'x.ts', 'README.md',
  ])
  assert.deepEqual(itemsOf(root.dirs[1]!), ['src/client/git/a.ts', 'src/client/git/b.ts', 'src/git/x.ts'])
  assert.deepEqual(treeOrder(paths, (p) => p), ['docs/deep/only/file.md', 'src/client/git/a.ts', 'src/client/git/b.ts', 'src/git/x.ts', 'README.md'])
})

test('auth: recognizes Claude CLI sign-in failures, not other errors', () => {
  assert.ok(isAuthText('Invalid API key · Please run /login'))
  assert.ok(isAuthText('OAuth token has expired. Please obtain a new token'))
  assert.ok(isAuthText('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'))
  assert.ok(!isAuthText('rate limit exceeded'))
  assert.ok(!isAuthText('Overloaded'))
  assert.match(authMessage('Claude Code: Invalid API key · Please run /login'), /\/login/)
})

test('auth: notices wake waiters and resync after a host restart', async () => {
  const notices = new AuthNotices()
  const first = await notices.wait(undefined, undefined)
  assert.equal(first.epoch, 0)
  const pending = notices.wait(first.boot, first.epoch, 5000)
  notices.report('expired')
  const woke = await pending
  assert.equal(woke.epoch, 1)
  assert.equal(woke.last?.detail, 'expired')
  // A stale boot id (host restarted) answers at once.
  const restarted = await notices.wait('other-boot', 5, 5000)
  assert.equal(restarted.boot, first.boot)
  const timedOut = await notices.wait(first.boot, 1, 20)
  assert.equal(timedOut.epoch, 1)
  notices.dispose()
})

import { rowTop } from '../src/client/git/rows.ts'

test('virtual list: rows below an expanded block shift by its height', () => {
  assert.equal(rowTop(0, 28), 0)
  assert.equal(rowTop(3, 28, { after: 2, height: 200 }), 3 * 28 + 200)
  assert.equal(rowTop(2, 28, { after: 2, height: 200 }), 2 * 28)
})
