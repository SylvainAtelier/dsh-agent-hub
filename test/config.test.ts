import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.ts'

test('config: an empty entry yields live sections with defaults', () => {
  const config = Config({} as never)
  assert.deepEqual(config.claude.get(), { remoteControl: true, fullAccess: false, keepOnline: 3, idleHours: 2, models: [] })
  assert.deepEqual(config.codex.get(), { models: [] })
  assert.deepEqual(config.models.get(), { hiddenProviders: [], efforts: [] })
  assert.deepEqual(config.remote.get(), { httpsPort: 443, http: true, phoneSettings: false })
  assert.deepEqual(config.git.get(), { identities: [], strict: true })
  assert.deepEqual(config.team.get(), { agents: [] })
  assert.deepEqual(config.prompt.get(), { canvas: true, archify: true, blockedScans: ['root', 'mount', 'drive', 'proc'], blockedCommands: [] })
})

test('config: global instructions keep their Markdown as written', () => {
  const instructions = '## Code\n- Keep the style\n'
  assert.equal(Config({ prompt: { instructions } } as never).prompt.get().instructions, instructions)
})

test('config: team profiles keep what was set', () => {
  const agents = [{ id: 'reviewer', provider: 'claude-agent', model: 'opus', tools: ['read'] }]
  const config = Config({ team: { agents } } as never)
  assert.equal(config.team.get().agents[0]!.id, 'reviewer')
  assert.deepEqual(config.team.get().agents[0]!.tools, ['read'])
  assert.throws(() => Config({ team: { agents: [{ description: 'no id' }] } } as never))
})

test('config: given fields override the defaults section by section', () => {
  const config = Config({ claude: { keepOnline: 0 }, remote: { httpsPort: 8443 }, git: { provider: 'p', model: 'm' } } as never)
  assert.deepEqual(config.claude.get(), { remoteControl: true, fullAccess: false, keepOnline: 0, idleHours: 2, models: [] })
  assert.equal(config.remote.get().httpsPort, 8443)
  assert.deepEqual(config.git.get(), { provider: 'p', model: 'm', identities: [], strict: true })
})

test('config: out-of-range values are refused', () => {
  assert.throws(() => Config({ remote: { httpsPort: 70000 } } as never))
  assert.throws(() => Config({ claude: { idleHours: 0 } } as never))
})

test('config: Codex accepts selected model ids and none but rejects non-string ids', () => {
  assert.deepEqual(Config({ codex: { models: ['gpt-5.4'] } } as never).codex.get(), { models: ['gpt-5.4'] })
  assert.deepEqual(Config({ codex: { models: ['(none)'] } } as never).codex.get(), { models: ['(none)'] })
  assert.throws(() => Config({ codex: { models: [123] } } as never))
})

test('config: every section is volatile, so the settings page may edit it', () => {
  const dict = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict
  for (const section of ['prompt', 'connectors', 'claude', 'codex', 'remote', 'git', 'team', 'models']) assert.equal(dict[section]!.meta.volatile, true, section)
})
