import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigFormModel, type ConfigScope, type Op } from '../src/client/config/form.ts'
import { EXPORT_FORMAT, exportConfig, exportFileName, parseExport, planImport, resolveRepo, serializeExport } from '../src/client/config/transfer.ts'
import type { RepoGroup } from '../src/repos/types.ts'

test('config transfer: Codex model visibility round-trips all, selected, and none', () => {
  for (const models of [[], ['gpt-5.4'], ['(none)']]) {
    const file = exportConfig({ codex: { models } })
    assert.deepEqual(file.config, { codex: { models } })
    const parsed = parseExport(serializeExport(file))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.skipped, [])
    assert.deepEqual(planImport(parsed.config, {}, []).ops, [{ op: 'set', path: ['codex', 'models'], value: models }])
  }
  assert.deepEqual(planImport({}, { codex: { models: ['gpt-5.4'] } }, []).ops, [{ op: 'unset', path: ['codex', 'models'] }])
  const invalid = parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, config: { codex: { models: [123] } } }))
  assert.ok(invalid.ok)
  assert.deepEqual(invalid.skipped, ['codex.models'])
})

const group = (key: string): RepoGroup => ({ key, name: key.split(/[\\/]/).filter(Boolean).pop()!, members: [] })
const windows = [group('C:\\pro\\app'), group('C:\\pro\\site')]
const linux = [group('/home/vi/src/app'), group('/home/vi/src/tools')]
const now = new Date('2026-10-11T08:00:00.000Z')

test('config transfer: exports only the profile overrides, with LF text and portable repositories', () => {
  const file = exportConfig({
    prompt: { instructions: '## Chat\r\n- reply in English\r\n' },
    claude: { keepOnline: 1, unknownKey: true },
    connectors: { servers: [{ id: 'linear', url: 'https://mcp.linear.app/mcp', repos: ['C:\\pro\\app\\'] }, { id: 'notion', url: 'https://mcp.notion.com/mcp' }] },
    team: { agents: [{ id: 'reviewer', persona: 'Strict.\r\nShort.' }] },
  }, windows, now)
  assert.equal(file.format, EXPORT_FORMAT)
  assert.equal(file.exportedAt, '2026-10-11T08:00:00.000Z')
  assert.deepEqual(file.config, {
    prompt: { instructions: '## Chat\n- reply in English\n' },
    connectors: { servers: [
      { id: 'linear', url: 'https://mcp.linear.app/mcp', repos: [{ name: 'app', path: 'C:/pro/app' }] },
      { id: 'notion', url: 'https://mcp.notion.com/mcp' },
    ] },
    claude: { keepOnline: 1 },
    team: { agents: [{ id: 'reviewer', persona: 'Strict.\nShort.' }] },
  })
  assert.equal(exportFileName(now), 'agent-hub-config-2026-10-11.json')
  assert.ok(!serializeExport(file).includes('\r'))
})

test('config transfer: a Windows export links the same-named repository on Linux', () => {
  const file = exportConfig({ connectors: { servers: [{ id: 'linear', url: 'https://mcp.linear.app/mcp', repos: ['C:\\pro\\app', 'C:\\pro\\site'] }] } }, windows, now)
  const parsed = parseExport(serializeExport(file))
  assert.ok(parsed.ok)
  const plan = planImport(parsed.config, {}, linux)
  assert.deepEqual(plan.ops, [{ op: 'set', path: ['connectors', 'servers'], value: [{ id: 'linear', url: 'https://mcp.linear.app/mcp', repos: ['/home/vi/src/app', 'C:/pro/site'] }] }])
  assert.deepEqual(plan.unmatched, ['site'])
})

test('config transfer: the same path wins over the name, and an ambiguous name is not guessed', () => {
  const twins = [group('/a/app'), group('/b/app')]
  assert.equal(resolveRepo({ name: 'app', path: '/b/app/' }, twins), '/b/app')
  assert.equal(resolveRepo({ name: 'app', path: 'D:/x/app' }, twins), undefined)
  assert.equal(resolveRepo({ name: 'APP', path: 'D:/x/app' }, [group('/a/app')]), '/a/app')
  assert.equal(resolveRepo({ name: 'app', path: 'c:/PRO/app' }, windows), 'C:\\pro\\app')
})

test('config transfer: import replaces the overrides, resetting what the file leaves at its default', () => {
  const plan = planImport({ claude: { remoteControl: false }, git: { model: 'm', provider: 'p' } }, { claude: { keepOnline: 1, remoteControl: true }, remote: { httpsPort: 8443 } }, [])
  assert.deepEqual(plan.ops, [
    { op: 'set', path: ['claude', 'remoteControl'], value: false },
    { op: 'unset', path: ['claude', 'keepOnline'] },
    { op: 'unset', path: ['remote', 'httpsPort'] },
    { op: 'set', path: ['git', 'provider'], value: 'p' },
    { op: 'set', path: ['git', 'model'], value: 'm' },
  ])
  assert.equal(plan.set, 3)
  assert.equal(plan.reset, 2)
})

test('config transfer: unreadable files are refused, unknown or invalid settings skipped', () => {
  assert.deepEqual(parseExport('{'), { ok: false, reason: 'json' })
  assert.deepEqual(parseExport('{"config":{}}'), { ok: false, reason: 'format' })
  assert.deepEqual(parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 99, config: {} })), { ok: false, reason: 'version' })
  const parsed = parseExport('\uFEFF' + JSON.stringify({
    format: EXPORT_FORMAT, version: 1, config: {
      claude: { keepOnline: 2, idleHours: 0.1, fullAccess: 'yes', later: 1 },
      prompt: { blockedScans: ['root', 'rm'], blockedCommands: ['git push --force', 3], instructions: 'a\r\nb' },
      team: { agents: [{ id: 'Bad Id' }] },
      connectors: { servers: [{ id: 'linear', url: 'https://mcp.linear.app/mcp', repos: ['C:\\pro\\app'] }] },
      future: { x: 1 },
    },
  }))
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.config, {
    claude: { keepOnline: 2 },
    prompt: { instructions: 'a\nb' },
    connectors: { servers: [{ id: 'linear', url: 'https://mcp.linear.app/mcp', repos: ['C:\\pro\\app'] }] },
  })
  assert.deepEqual(parsed.skipped, ['claude.idleHours', 'claude.fullAccess', 'claude.later', 'prompt.blockedScans', 'prompt.blockedCommands', 'team.agents', 'future.x'])
})

test('config transfer: the form applies an import as one revision-fenced mutation, dropping unsaved edits', async () => {
  const writes: Array<{ ops: Op[]; revision: number | undefined }> = []
  const listeners = new Set<() => void>()
  let user: Record<string, Record<string, unknown>> = { claude: { keepOnline: 1 } }
  const scope: ConfigScope = {
    getSnapshot: () => ({ status: 'ready', value: user, base: {}, user, revision: 7, writable: true }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, revision) {
      writes.push({ ops, revision })
      user = {}
      return true
    },
  }
  const form = new ConfigFormModel(scope)
  form.edit('git.instructions', 'typed but not saved')
  assert.deepEqual(await form.overrides(), user)
  writes.length = 0
  form.edit('git.instructions', 'another draft')
  const ops: Op[] = [{ op: 'unset', path: ['claude', 'keepOnline'] }]
  assert.equal(await form.apply(ops), true)
  assert.deepEqual(writes, [{ ops, revision: 7 }])
  assert.equal(form.getSnapshot().outcome, 'saved')
  assert.equal(form.getSnapshot().dirty, false)
  form.dispose()
})

test('config transfer: review and alert repositories stay local while portable settings travel', () => {
  const file = exportConfig({ review: { repos: ['C:\\pro\\app'], at: '08:30', bot: 'reviewer', style: 'Short.\r\n' }, alerts: { repo: 'C:\\pro\\app', url: 'https://acme.sentry.io/issues/?project=7', bot: 'reviewer' } }, windows, now)
  assert.deepEqual(file.config, { review: { at: '08:30', bot: 'reviewer', style: 'Short.\n' }, alerts: { url: 'https://acme.sentry.io/issues/?project=7', bot: 'reviewer' } })
  const parsed = parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, config: { review: { repos: ['/x'], at: '07:00', maxPerRun: 3 }, alerts: { repo: '/x', url: 'https://acme.sentry.io/issues/?project=7' } } }))
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.config, { review: { at: '07:00', maxPerRun: 3 }, alerts: { url: 'https://acme.sentry.io/issues/?project=7' } })
  assert.deepEqual(parsed.skipped, ['review.repos', 'alerts.repo'])
  // An import neither sets nor resets this machine's own repositories.
  const plan = planImport(parsed.config, { review: { repos: ['/home/vi/src/app'], bot: 'old' }, alerts: { repo: '/home/vi/src/app' } }, linux)
  assert.deepEqual(plan.ops, [
    { op: 'set', path: ['review', 'at'], value: '07:00' },
    { op: 'unset', path: ['review', 'bot'] },
    { op: 'set', path: ['review', 'maxPerRun'], value: 3 },
    { op: 'set', path: ['alerts', 'url'], value: 'https://acme.sentry.io/issues/?project=7' },
  ])
})
