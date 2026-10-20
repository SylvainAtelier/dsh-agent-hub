import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../src/config.ts'
import { CODEX_PLUGIN, codexPlugin, setUpCodex, type BundleManager } from '../src/modules.ts'

const manager = (bundles: Array<{ name: string; installed: boolean; enabled: boolean }>, outcome: object = {}): BundleManager & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    listBundles: async () => bundles,
    installBundle: async (spec, options) => {
      calls.push(`install ${spec} ${options.enabled}`)
      bundles.push({ name: CODEX_PLUGIN, installed: true, enabled: true })
      return outcome
    },
    setBundleEnabled: async (name, enabled) => {
      calls.push(`enable ${name} ${enabled}`)
      for (const bundle of bundles) if (bundle.name === name) bundle.enabled = enabled
      return outcome
    },
  }
}

test('modules: optional modules start off, Codex on, and canvases draw Archify diagrams', () => {
  const config = Config({} as never)
  assert.deepEqual(config.modules.get(), { reader: false, relay: false, palette: false, device: false, codex: true })
  assert.equal(config.prompt.get().canvas, true)
  assert.equal(config.prompt.get().archify, true)
})

test('modules: the Codex plugin is missing, off or on; a manager that cannot tell asks for nothing', async () => {
  assert.equal(await codexPlugin(manager([])), 'missing')
  assert.equal(await codexPlugin(manager([{ name: CODEX_PLUGIN, installed: false, enabled: false }])), 'missing')
  assert.equal(await codexPlugin(manager([{ name: CODEX_PLUGIN, installed: true, enabled: false }])), 'off')
  assert.equal(await codexPlugin(manager([{ name: CODEX_PLUGIN, installed: true, enabled: true }])), 'on')
  assert.equal(await codexPlugin(undefined), 'on')
  assert.equal(await codexPlugin({ listBundles: async () => { throw new Error('busy') } }), 'on')
})

test('modules: installing or enabling Codex goes through the plugin manager and reports a due restart', async () => {
  const fresh = manager([], { application: 'restart-required' })
  assert.deepEqual(await setUpCodex(fresh, 'install'), { codex: 'on', restart: true })
  assert.deepEqual(fresh.calls, [`install ${CODEX_PLUGIN} true`])
  const off = manager([{ name: CODEX_PLUGIN, installed: true, enabled: false }], { application: 'applied' })
  assert.deepEqual(await setUpCodex(off, 'enable'), { codex: 'on' })
  assert.deepEqual(off.calls, [`enable ${CODEX_PLUGIN} true`])
  await assert.rejects(setUpCodex(manager([], { application: 'failed', error: { diagnostic: 'registry unreachable' } }), 'install'), /registry unreachable/)
  await assert.rejects(setUpCodex(undefined, 'install'), /plugin manager/)
})
