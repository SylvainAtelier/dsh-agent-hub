import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ancestry, currentSession } from '../src/client/repos/reveal.ts'
import type { Placement } from '../src/client/repos/sidebar.ts'

const items = [
  { workspaceId: 'home', path: '/u', sessionIds: [] },
  { workspaceId: 'repo', path: '/u/repo/', sessionIds: ['s1'] },
  { workspaceId: 'inner', path: '/u/repo/.worktrees/a', sessionIds: ['s2'] },
  { workspaceId: 'outer', path: '/u/repo.wt/b', sessionIds: ['s3'] },
  { workspaceId: 'sibling', path: '/u/repository', sessionIds: [] },
  { workspaceId: 'win', path: 'C:\\w\\x', sessionIds: [] },
  { workspaceId: 'winRoot', path: 'C:\\w', sessionIds: [] },
]
const placed = new Map<string, Placement>([
  ['inner', { head: 'repo', title: 'repo · a', headTitle: 'repo' }],
  ['outer', { head: 'repo', title: 'repo · b', headTitle: 'repo' }],
])

test('reveal: ancestry follows the repository, then folders, outermost first', () => {
  assert.deepEqual(ancestry('outer', items, placed, true), ['home', 'repo'])
  assert.deepEqual(ancestry('inner', items, placed, true), ['home', 'repo'])
  assert.deepEqual(ancestry('repo', items, placed, true), ['home'])
  // A shared name prefix is not a folder.
  assert.deepEqual(ancestry('sibling', items, placed, true), ['home'])
  assert.deepEqual(ancestry('win', items, placed, true), ['winRoot'])
  assert.deepEqual(ancestry('home', items, placed, true), [])
  assert.deepEqual(ancestry('', items, placed, true), [])
})

test('reveal: other views nest nothing', () => {
  assert.deepEqual(ancestry('outer', items, placed, false), [])
})

test('reveal: the session on screen is the one the main view retains', () => {
  assert.equal(currentSession({ a: {}, b: { retainedBy: { mainView: 0 } }, c: { retainedBy: { mainView: 1 } } }), 'c')
  assert.equal(currentSession({ a: {} }), undefined)
  assert.equal(currentSession(undefined), undefined)
})
