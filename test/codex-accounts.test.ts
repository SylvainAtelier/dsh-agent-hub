import assert from 'node:assert/strict'
import test from 'node:test'
import { codexAccountLabels } from '../src/client/codex/labels.ts'

test('codex switch labels prefer the email local part over generic labels', () => {
  const labels = codexAccountLabels([
    { id: 'a', label: 'Account 1', email: 'alice.long.name@example.com' },
    { id: 'b', label: 'Account 2', email: 'bob@example.com' },
    { id: 'c', label: 'Account 3' },
  ])
  assert.deepEqual([...labels], [['a', 'alice.long.name'], ['b', 'bob'], ['c', 'Account 3']])
})

test('codex switch labels keep the full email when local parts collide', () => {
  const labels = codexAccountLabels([
    { id: 'a', email: 'dev@one.com' },
    { id: 'b', email: 'dev@two.com' },
  ])
  assert.deepEqual([...labels], [['a', 'dev@one.com'], ['b', 'dev@two.com']])
})
