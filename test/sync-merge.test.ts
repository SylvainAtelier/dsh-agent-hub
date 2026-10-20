import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSettings } from '../src/sync/merge.ts'
import { PATCH_FILE, PLUGINS_FILE } from '../src/sync/portable.ts'

const files = (patch: string, plugins?: { bundles: string[]; dependencies?: Record<string, string> }): Record<string, string> => ({
  [PATCH_FILE]: patch,
  ...(plugins === undefined ? {} : { [PLUGINS_FILE]: JSON.stringify({ dependencies: {}, ...plugins }) }),
})

test('sync merge: what only one side changed is taken without asking, comments and !!js kept', () => {
  const base = files('- id: ui-theme\n  config:\n    preference: dark\n- id: agent-hub\n  config:\n    claude:\n      idleHours: 2\n')
  const local = files('- id: ui-theme\n  config:\n    preference: dark\n- id: agent-hub\n  config:\n    claude:\n      idleHours: 4\n')
  const remote = files('# shared theme\n- id: ui-theme\n  config:\n    preference: light\n    when: !!js ctx.dark\n- id: agent-hub\n  config:\n    claude:\n      idleHours: 2\n')
  const result = mergeSettings(base, local, remote)
  assert.deepEqual(result.conflicts, [])
  const patch = result.files![PATCH_FILE]!
  assert.match(patch, /# shared theme/)
  assert.match(patch, /preference: light/)
  assert.match(patch, /when: !!js ctx\.dark/)
  assert.match(patch, /idleHours: 4/)
})

test('sync merge: a setting both sides changed differently waits for a choice', () => {
  const base = files('- id: agent-hub\n  config:\n    claude:\n      idleHours: 2\n    git:\n      model: a\n')
  const local = files('- id: agent-hub\n  config:\n    claude:\n      idleHours: 4\n    git:\n      model: a\n')
  const remote = files('- id: agent-hub\n  config:\n    claude:\n      idleHours: 6\n    git:\n      model: b\n')
  const first = mergeSettings(base, local, remote)
  assert.equal(first.files, undefined)
  assert.equal(first.conflicts.length, 1)
  const [conflict] = first.conflicts
  assert.deepEqual({ path: conflict!.path, local: conflict!.local, remote: conflict!.remote, setting: conflict!.setting }, { path: ['config', 'claude', 'idleHours'], local: '4', remote: '6', setting: 'agent-hub.config.claude.idleHours' })
  const chosen = mergeSettings(base, local, remote, { [conflict!.key]: 'local' })
  assert.match(chosen.files![PATCH_FILE]!, /idleHours: 4/)
  assert.match(chosen.files![PATCH_FILE]!, /model: b/)
})

test('sync merge: bots added on two machines are both kept; an entry one side removed goes', () => {
  const base = files('- id: agent-hub\n  config:\n    team:\n      agents:\n        - id: reviewer\n          model: opus\n- id: old\n  config:\n    x: 1\n')
  const local = files('- id: agent-hub\n  config:\n    team:\n      agents:\n        - id: reviewer\n          model: opus\n        - id: coder\n          model: gpt\n- id: old\n  config:\n    x: 1\n')
  const remote = files('- id: agent-hub\n  config:\n    team:\n      agents:\n        - id: reviewer\n          model: sonnet\n        - id: writer\n          model: m3\n')
  const result = mergeSettings(base, local, remote)
  assert.deepEqual(result.conflicts, [])
  const patch = result.files![PATCH_FILE]!
  assert.match(patch, /id: reviewer\n\s+model: sonnet/)
  assert.match(patch, /id: writer/)
  assert.match(patch, /id: coder\n\s+model: gpt/)
  assert.doesNotMatch(patch, /id: old/)
})

test('sync merge: plugins switch, order and versions merge per plugin', () => {
  const base = files('[]\n', { bundles: ['base', 'a'], dependencies: { a: '1.0.0', b: '1.0.0' } })
  const local = files('[]\n', { bundles: ['base', 'a', 'local-new'], dependencies: { a: '1.0.0', b: '2.0.0', 'local-new': '1.0.0' } })
  const remote = files('[]\n', { bundles: ['base', 'remote-new', 'a'], dependencies: { a: '1.1.0', b: '1.0.0', 'remote-new': '3.0.0' } })
  const result = mergeSettings(base, local, remote)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(JSON.parse(result.files![PLUGINS_FILE]!), {
    bundles: ['base', 'remote-new', 'a', 'local-new'],
    dependencies: { a: '1.1.0', b: '2.0.0', 'local-new': '1.0.0', 'remote-new': '3.0.0' },
  })
})

test('sync merge: without a base every difference is a conflict; without a remote this machine wins', () => {
  const local = files('- id: ui-theme\n  config:\n    preference: dark\n')
  const remote = files('- id: ui-theme\n  config:\n    preference: light\n    size: 2\n')
  const result = mergeSettings(undefined, local, remote)
  assert.deepEqual(result.conflicts.map((item) => item.path.join('.')), ['config.preference'])
  const all = mergeSettings(undefined, local, remote, { [result.conflicts[0]!.key]: 'remote' })
  assert.match(all.files![PATCH_FILE]!, /preference: light\n\s+size: 2/)
  assert.equal(mergeSettings(undefined, local, undefined).files![PATCH_FILE], local[PATCH_FILE])
})
