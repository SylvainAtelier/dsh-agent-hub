import { test } from 'node:test'
import assert from 'node:assert/strict'
import { automationManagement, requireAutomationLocal, saveAutomationDefinitions } from '../src/automation-management.ts'
import type { AutomationReply, ScriptTask } from '../src/automation/types.ts'
import { createPhoneSettings } from '../src/remote/settings.ts'
import { sharedPatch } from '../src/sync/portable.ts'
import { upstreamHeaders } from '../src/remote/proxy.ts'
import { automationNode, qoderCnInstalled } from '../src/automation-preset.ts'

const definition: ScriptTask = { id: 'sample', title: 'Sample', command: 'C:/runtime/node.exe', args: ['C:/tasks/check.mjs'], cwd: 'C:/tasks', provider: 'test', model: 'small', timeoutMs: 60000 }
function fixture() {
  let definitions: ScriptTask[] = []
  let active = false
  let saves = 0
  let routes = 0
  const read = async (): Promise<AutomationReply> => ({ definitions: structuredClone(definitions), tasks: [] })
  const request = automationManagement({
    service: {
      handle: read,
      async withDefinitionMutation(_id, work) { if (active) throw new Error('Disable first'); return work() },
    },
    definitions: () => definitions,
    async save(next) { saves++; definitions = structuredClone(next) },
    async validateRoute() { routes++ },
    preset: () => definition,
    presetAvailable: () => false,
  })
  return { request, saves: () => saves, routes: () => routes, active: () => { active = true } }
}

test('the CN preset selects a real Node binary, never the Electron desktop executable', () => {
  const options = { execPath: 'C:\\app\\DeepSeek Harness.exe', electron: '40.0', platform: 'win32' as const, path: '.;"C:\\node";C:\\other' }
  assert.equal(automationNode(options, (file) => file === 'C:\\node\\node.exe'), 'C:\\node\\node.exe')
  assert.throws(() => automationNode({ ...options, path: '.' }, () => true), /Node is unavailable/)
  assert.equal(automationNode({ execPath: '/usr/bin/node', platform: 'linux', path: '' }, () => true), '/usr/bin/node')
})

test('the CN template is offered only on Windows with the Qoder CN desktop profile', () => {
  const profile = 'C:\\Users\\me\\AppData\\Roaming\\com.qodercn.app.stable'
  const exists = (file: string): boolean => file === profile
  assert.equal(qoderCnInstalled({ platform: 'win32', appData: 'C:\\Users\\me\\AppData\\Roaming' }, exists), true)
  assert.equal(qoderCnInstalled({ platform: 'win32', appData: 'C:\\Users\\other\\AppData\\Roaming' }, exists), false)
  assert.equal(qoderCnInstalled({ platform: 'win32' }, () => true), false)
  assert.equal(qoderCnInstalled({ platform: 'darwin', appData: '/Users/me' }, () => true), false)
})

test('script management is loopback only, independent of phone settings', () => {
  for (const origin of ['http://localhost:123', 'http://127.0.0.1:123', 'http://[::1]:123']) assert.doesNotThrow(() => requireAutomationLocal(new Request(origin)))
  for (const origin of ['https://example.com', 'http://100.99.1.2:123', 'http://localhost.example.com']) assert.throws(() => requireAutomationLocal(new Request(origin)), /computer running DSH/)
})
test('DSH bridge requests are judged by their Host header, not the fixed dsh.internal URL', () => {
  // DSH's http bridge rebuilds every request as http://dsh.internal/...; desktop forwards to 127.0.0.1.
  const bridged = (host?: string) => new Request('http://dsh.internal/api/agent-hub/automation', { method: 'POST', headers: host ? { host } : {} })
  for (const host of ['127.0.0.1:52341', 'localhost:8080', '[::1]:9000', '127.0.0.2']) assert.doesNotThrow(() => requireAutomationLocal(bridged(host)), host)
  for (const host of ['device.tailnet.ts.net', '192.168.1.5:8080', 'localhost.example.com', undefined]) assert.throws(() => requireAutomationLocal(bridged(host)), /computer running DSH/)
})
test('remote script management follows the phone-settings switch', () => {
  const phone = new Request('http://127.0.0.1:123/api/agent-hub/automation', { headers: { host: '127.0.0.1:123', 'x-dsh-agent-hub-remote': '1' } })
  assert.throws(() => requireAutomationLocal(phone, false), /computer running DSH/)
  assert.doesNotThrow(() => requireAutomationLocal(phone, true))
})
test('the remote proxy cannot make script management local by rewriting Host', () => {
  const headers = upstreamHeaders({ host: 'device.tailnet.ts.net', 'x-dsh-agent-hub-remote': '0' }, 123)
  assert.equal(headers['x-dsh-agent-hub-remote'], '1')
  assert.throws(() => requireAutomationLocal(new Request('http://127.0.0.1:123/api/agent-hub/automation', { headers: { 'x-dsh-agent-hub-remote': String(headers['x-dsh-agent-hub-remote']) } })), /computer running DSH/)
})

test('script definitions are hidden from phone settings and excluded from default profile sync', async () => {
  let writes = 0
  const handle = createPhoneSettings({ enabled: () => true, settings: () => ({
    writable: true, describe: () => [{ ns: 'agent-hub', revision: 1, value: { automation: { tasks: [definition] } } }],
    async mutate() { writes++ },
  }) })
  const reply = await handle({ op: 'read' })
  assert.ok(reply.view.enabled)
  assert.equal(Object.hasOwn(reply.view.value, 'automation'), false)
  await assert.rejects(handle({ op: 'mutate', revision: 1, ops: [{ op: 'set', path: ['automation', 'tasks'], value: [] }] }), /computer/)
  assert.equal(writes, 0)
  const yaml = '- id: agent-hub\n  config:\n    automation:\n      tasks:\n        - id: local-only\n          command: C:/secret/task.exe\n    prompt:\n      canvas: true\n'
  assert.doesNotMatch(sharedPatch(yaml), /local-only|task.exe|automation/)
  assert.match(sharedPatch(yaml), /canvas/)
})

test('list and preset never save, authorize or execute a script', async () => {
  const f = fixture()
  assert.deepEqual((await f.request({ action: 'list' })).definitions, [])
  assert.equal((await f.request({ action: 'preset' })).preset?.id, definition.id)
  assert.equal((await f.request({ action: 'list' })).presetAvailable, false)
  assert.equal(f.saves(), 0)
  assert.equal(f.routes(), 0)
})
test('definition edits require the exact editor baseline and remain disabled', async () => {
  const f = fixture()
  await f.request({ action: 'upsert', definition, expected: null })
  assert.equal(f.saves(), 1)
  await assert.rejects(f.request({ action: 'upsert', definition: { ...definition, title: 'Changed' }, expected: null }), /changed/)
  await assert.rejects(f.request({ action: 'remove', id: definition.id }), /changed/)
  const next = { ...definition, title: 'Changed' }
  await f.request({ action: 'upsert', definition: next, expected: definition })
  await assert.rejects(f.request({ action: 'remove', id: definition.id, expected: definition }), /changed/)
  await f.request({ action: 'remove', id: definition.id, expected: next })
  assert.equal(f.saves(), 3)
})
test('active definitions cannot be edited, removed or replaced', async () => {
  const f = fixture()
  await f.request({ action: 'upsert', definition, expected: null })
  f.active()
  await assert.rejects(f.request({ action: 'remove', id: definition.id, expected: definition }), /Disable/)
  await assert.rejects(f.request({ action: 'upsert', definition, expected: definition }), /Disable/)
  assert.equal(f.saves(), 1)
})
test('the settings write fences unrelated concurrent task edits after async route validation', async () => {
  let current = [definition]
  let revision = 1
  let writes = 0
  const settings = {
    writable: true,
    describe: () => [{ ns: 'agent-hub', revision, value: { automation: { tasks: current } } }],
    async mutate(_ns: string, _ops: unknown, expectedRevision?: number) { assert.equal(expectedRevision, revision); writes++ },
  }
  const baseline = structuredClone(current)
  current = [...current, { ...definition, id: 'another', title: 'Another' }]
  revision++
  await assert.rejects(saveAutomationDefinitions(settings, [{ ...definition, title: 'Edited' }], baseline), /changed/)
  assert.equal(writes, 0)
  await saveAutomationDefinitions(settings, current, current)
  assert.equal(writes, 1)
})

test('unsafe definitions never reach persistence or route validation', async () => {
  const f = fixture()
  await assert.rejects(f.request({ action: 'upsert', definition: { ...definition, command: 'node' }, expected: null }), /absolute/)
  await assert.rejects(f.request({ action: 'upsert', definition: { ...definition, args: ['secret\0value'] }, expected: null }), /arguments/)
  assert.equal(f.saves(), 0)
  assert.equal(f.routes(), 0)
})
