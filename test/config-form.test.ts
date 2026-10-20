import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTOSAVE_DELAY, ConfigFormModel, parseNumber, FIELDS, type ConfigScope, type Op } from '../src/client/config/form.ts'

const defaults = { codex: { models: [] }, claude: { remoteControl: true, fullAccess: false, keepOnline: 3, idleHours: 2, models: [] }, models: { hiddenProviders: [] }, remote: { httpsPort: 443, http: true, phoneSettings: false }, git: {}, team: { agents: [] } }

/** A stand-in for ui-settings' shared form: the host merges the user layer over the defaults. */
function fakeScope(user: Record<string, Record<string, unknown>> = {}, accept = true) {
  const listeners = new Set<() => void>()
  const writes: Array<{ ops: Op[]; revision: number | undefined }> = []
  let revision = 1
  const merged = () => Object.fromEntries(Object.entries(defaults).map(([section, values]) => [section, { ...values, ...user[section] }]))
  let snapshot: ReturnType<ConfigScope['getSnapshot']> = { status: 'ready', value: merged(), base: defaults, user, revision, writable: true }
  const scope: ConfigScope = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, expected) {
      writes.push({ ops, revision: expected })
      if (!accept) return false
      for (const op of ops) {
        const [section, key] = op.path as [string, string]
        const next = { ...user[section] }
        if (op.op === 'set') next[key] = op.value
        else delete next[key]
        user = { ...user, [section]: next }
      }
      snapshot = { status: 'ready', value: merged(), base: defaults, user, revision: ++revision, writable: true }
      for (const listener of listeners) listener()
      return true
    },
  }
  return { scope, writes }
}

test('config form: Codex visibility saves selected and none, and resets to all', async () => {
  const { scope, writes } = fakeScope()
  const form = new ConfigFormModel(scope)
  assert.deepEqual(form.getSnapshot().fields['codex.models']!.value, [])
  for (const models of [['gpt-5.4'], ['(none)'], []]) {
    form.edit('codex.models', models)
    await form.save()
    assert.deepEqual(form.getSnapshot().fields['codex.models']!.value, models)
    assert.deepEqual(writes.at(-1)!.ops, [{ op: 'set', path: ['codex', 'models'], value: models }])
  }
  form.reset('codex.models')
  await form.save()
  assert.deepEqual(writes.at(-1)!.ops, [{ op: 'unset', path: ['codex', 'models'] }])
  assert.equal(form.getSnapshot().fields['codex.models']!.overridden, false)
  form.dispose()
})

test('config form: shows effective values and which ones the profile overrides', () => {
  const { scope } = fakeScope({ claude: { keepOnline: 1 } })
  const state = new ConfigFormModel(scope).getSnapshot()
  assert.equal(state.available, true)
  assert.equal(state.dirty, false)
  assert.deepEqual(state.fields['claude.keepOnline'], { value: 1, overridden: true, fallback: 3, invalid: false, dirty: false })
  assert.equal(state.fields['remote.httpsPort']!.overridden, false)
})

test('config form: edits saved together go out as one revision-fenced mutation', async () => {
  const { scope, writes } = fakeScope()
  const form = new ConfigFormModel(scope)
  form.edit('claude.remoteControl', false)
  form.edit('remote.httpsPort', '8443')
  form.edit('git.instructions', 'Use Conventional Commits')
  assert.equal(form.getSnapshot().dirty, true)
  await form.save()
  assert.deepEqual(writes, [{
    revision: 1,
    ops: [
      { op: 'set', path: ['claude', 'remoteControl'], value: false },
      { op: 'set', path: ['remote', 'httpsPort'], value: 8443 },
      { op: 'set', path: ['git', 'instructions'], value: 'Use Conventional Commits' },
    ],
  }])
  const state = form.getSnapshot()
  assert.equal(state.outcome, 'saved')
  assert.equal(state.dirty, false)
  assert.equal(state.fields['remote.httpsPort']!.value, 8443)
})

test('config form: an invalid number blocks the save and says so', async () => {
  const { scope, writes } = fakeScope()
  const form = new ConfigFormModel(scope)
  form.edit('remote.httpsPort', '70000')
  assert.equal(form.getSnapshot().invalid, true)
  assert.equal(form.getSnapshot().fields['remote.httpsPort']!.text, '70000')
  await form.save()
  assert.equal(writes.length, 0)
  form.edit('claude.keepOnline', '1.5')
  assert.equal(form.getSnapshot().fields['claude.keepOnline']!.invalid, true)
})

test('config form: reset and emptied text unset the override; untouched values write nothing', async () => {
  const { scope, writes } = fakeScope({ claude: { keepOnline: 1 }, git: { instructions: 'x' } })
  const form = new ConfigFormModel(scope)
  form.reset('claude.keepOnline')
  assert.equal(form.getSnapshot().fields['claude.keepOnline']!.value, 3)
  form.edit('git.instructions', '   ')
  form.edit('claude.idleHours', '2')
  await form.save()
  assert.deepEqual(writes[0]!.ops, [
    { op: 'unset', path: ['claude', 'keepOnline'] },
    { op: 'unset', path: ['git', 'instructions'] },
  ])
})

test('config form: a refused save keeps the drafts', async () => {
  const { scope } = fakeScope({}, false)
  const form = new ConfigFormModel(scope)
  form.edit('claude.idleHours', '0.5')
  await form.save()
  const state = form.getSnapshot()
  assert.equal(state.outcome, 'failed')
  assert.equal(state.fields['claude.idleHours']!.value, 0.5)
  form.discard()
  assert.equal(form.getSnapshot().fields['claude.idleHours']!.value, 2)
})

test('config form: numbers respect each field\'s kind and range', () => {
  const spec = (id: string) => FIELDS.find((field) => `${field.section}.${field.key}` === id)!
  assert.equal(parseNumber(spec('claude.idleHours'), '0.25'), 0.25)
  assert.equal(parseNumber(spec('claude.idleHours'), '0.1'), undefined)
  assert.equal(parseNumber(spec('remote.httpsPort'), ' 443 '), 443)
  assert.equal(parseNumber(spec('remote.httpsPort'), 'abc'), undefined)
})

test('config form: picking a catalog model writes provider and model together; default unsets both', async () => {
  const { scope, writes } = fakeScope({ git: { provider: 'old', model: 'x' } })
  const form = new ConfigFormModel(scope)
  form.editRoute('git.model', { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.equal(form.getSnapshot().fields['git.provider']!.value, 'deepseek-official')
  await form.save()
  assert.deepEqual(writes[0]!.ops, [
    { op: 'set', path: ['git', 'provider'], value: 'deepseek-official' },
    { op: 'set', path: ['git', 'model'], value: 'deepseek-v4-flash' },
  ])
  form.reset('git.model')
  await form.save()
  assert.deepEqual(writes[1]!.ops, [
    { op: 'unset', path: ['git', 'provider'] },
    { op: 'unset', path: ['git', 'model'] },
  ])
})

test('config form: team profiles stage as one list; bad or repeated names block the save', async () => {
  const { scope, writes } = fakeScope({ team: { agents: [{ id: 'reviewer' }] } })
  const form = new ConfigFormModel(scope)
  form.edit('team.agents', [{ id: 'reviewer' }])
  assert.equal(form.getSnapshot().dirty, false, 'the same list is no change')
  form.edit('team.agents', [{ id: 'reviewer' }, { id: 'Coder' }])
  assert.equal(form.getSnapshot().fields['team.agents']!.invalid, true)
  form.edit('team.agents', [{ id: 'reviewer' }, { id: 'reviewer' }])
  assert.equal(form.getSnapshot().invalid, true)
  await form.save()
  assert.equal(writes.length, 0)
  form.edit('team.agents', [{ id: 'reviewer' }, { id: 'coder', provider: 'openai-codex', model: 'gpt-5' }])
  assert.equal(form.getSnapshot().invalid, false)
  await form.save()
  assert.deepEqual(writes[0]!.ops, [{ op: 'set', path: ['team', 'agents'], value: [{ id: 'reviewer' }, { id: 'coder', provider: 'openai-codex', model: 'gpt-5' }] }])
})

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('config form: a pick saves itself at once, no save click', async () => {
  const { scope, writes } = fakeScope()
  const form = new ConfigFormModel(scope)
  form.edit('claude.remoteControl', false)
  await tick()
  await form.save()
  assert.deepEqual(writes, [{ revision: 1, ops: [{ op: 'set', path: ['claude', 'remoteControl'], value: false }] }])
  assert.equal(form.getSnapshot().outcome, 'saved')
  assert.equal(form.getSnapshot().dirty, false)
  form.dispose()
})

test('config form: typing saves once it pauses, and the text stays as typed until the field leaves focus', async () => {
  const { scope, writes } = fakeScope()
  const form = new ConfigFormModel(scope)
  form.edit('git.instructions', 'U')
  form.edit('git.instructions', 'Use ')
  await tick()
  assert.equal(writes.length, 0, 'still typing')
  await tick(AUTOSAVE_DELAY + 50)
  await form.save()
  assert.deepEqual(writes, [{ revision: 1, ops: [{ op: 'set', path: ['git', 'instructions'], value: 'Use ' }] }])
  form.edit('remote.httpsPort', '8443 ')
  await form.flush()
  assert.deepEqual(writes[1], { revision: 2, ops: [{ op: 'set', path: ['remote', 'httpsPort'], value: 8443 }] })
  assert.equal(form.getSnapshot().fields['remote.httpsPort']!.text, undefined, 'leaving the field shows what is stored')
  assert.equal(form.getSnapshot().fields['remote.httpsPort']!.value, 8443)
  form.dispose()
})

test('config form: an invalid field stays unsaved without holding back the valid ones', async () => {
  const { scope, writes } = fakeScope()
  const form = new ConfigFormModel(scope)
  form.edit('remote.httpsPort', '70000')
  form.edit('claude.keepOnline', '5')
  await form.flush()
  assert.deepEqual(writes, [{ revision: 1, ops: [{ op: 'set', path: ['claude', 'keepOnline'], value: 5 }] }])
  const state = form.getSnapshot()
  assert.equal(state.fields['remote.httpsPort']!.invalid, true)
  assert.equal(state.fields['remote.httpsPort']!.text, '70000')
  form.dispose()
})
