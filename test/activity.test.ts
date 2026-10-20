import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActivity, merge, tally } from '../src/client/repos/activity.ts'

test('activity: counts listed sessions and keeps the most urgent state', () => {
  const sessions = {
    byId: {
      a: { running: false },
      b: { running: true },
      c: {},
      sub: { origin: 'subagent', running: true },
      blank: { blank: true },
      shown: { blank: true, retainedBy: { mainView: 1 } },
      old: {},
    },
  }
  const statuses = new Map([['a', { completionUnread: true }], ['c', { pendingInteraction: { kind: 'approval' } }]])
  const out = tally([
    { workspaceId: 'w1', sessionIds: ['a', 'b', 'sub', 'blank', 'old', 'missing'] },
    { workspaceId: 'w2', sessionIds: ['c', 'shown'] },
    { workspaceId: 'w3', sessionIds: ['a'] },
    { workspaceId: 'w4', sessionIds: [] },
  ], { sessions, statuses }, new Set(['old']))
  assert.deepEqual(out.get('w1'), { sessions: 2, state: 'ongoing' })
  assert.deepEqual(out.get('w2'), { sessions: 2, state: 'warning' })
  assert.deepEqual(out.get('w3'), { sessions: 1, state: 'done' })
  assert.deepEqual(out.get('w4'), { sessions: 0 })
})

test('activity: merging sums counts, the higher state wins', () => {
  assert.deepEqual(merge({ sessions: 1, state: 'done' }, { sessions: 2, state: 'ongoing' }), { sessions: 3, state: 'ongoing' })
  assert.deepEqual(merge({ sessions: 1, state: 'warning' }, { sessions: 0, state: 'done' }), { sessions: 1, state: 'warning' })
  assert.deepEqual(merge({ sessions: 1 }, { sessions: 1 }), { sessions: 2 })
})

test('activity: the store notifies only on new snapshots', () => {
  const store = createActivity()
  let calls = 0
  store.subscribe(() => calls++)
  const sessions = { byId: {} }
  store.set({ sessions })
  store.set({ sessions })
  assert.equal(calls, 1)
})
