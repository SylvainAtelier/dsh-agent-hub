import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVisibility, NO_MODELS, presentModels, visibleModels, type LlmRegistry, type ModelEntry, type VisibilitySettings } from '../src/visibility.ts'

class FakeAdapter {
  private ids: string[]
  constructor(ids: string[]) { this.ids = ids }
  async listModels(provider: string): Promise<ModelEntry[]> {
    return this.ids.map((id) => ({ provider, id, name: id.toUpperCase() }))
  }
}

function registry(adapters: Record<string, FakeAdapter>): LlmRegistry {
  return {
    listProviders: () => Object.keys(adapters).map((id) => ({ id, name: id })),
    listModels: (provider) => adapters[provider]!.listModels(provider),
    registration(provider) {
      const adapter = adapters[provider]
      if (adapter === undefined) throw new Error('no adapter')
      return { adapter }
    },
  }
}

const ids = (models: ModelEntry[]): string[] => models.map((model) => model.id)

test('visibility: models the plan includes come first, tagged; untagged lists are left alone', async () => {
  const listed: ModelEntry[] = [
    { provider: 'cursor-agent', id: 'grok', name: 'Grok', billing: 'on-demand' },
    { provider: 'cursor-agent', id: 'composer-2.5', name: 'Composer 2.5', billing: 'included' },
    { provider: 'cursor-agent', id: 'opus', name: 'Opus', billing: 'on-demand' },
    { provider: 'cursor-agent', id: 'auto', name: 'Auto', billing: 'included' },
  ]
  assert.deepEqual(presentModels(listed, 'Included').map((model) => model.name), ['Composer 2.5 · Included', 'Auto · Included', 'Grok', 'Opus'])
  const plain = [{ id: 'v4', name: 'V4' }]
  assert.equal(presentModels(plain), plain)

  const adapter = { listModels: async (_provider: string) => listed }
  const llm: LlmRegistry = { listProviders: () => [{ id: 'cursor-agent', name: 'Cursor' }], listModels: (provider) => adapter.listModels(provider), registration: () => ({ adapter }) }
  const visibility = createVisibility(llm, () => ({ hiddenProviders: [], enabled: { 'cursor-agent': ['grok', 'auto'] } }))
  visibility.sync()
  assert.deepEqual(ids(await llm.listModels('cursor-agent')), ['auto', 'grok'])
  // The settings page reads the catalog as the adapter lists it.
  assert.deepEqual((await visibility.unfiltered.listModels('cursor-agent')).map((model) => model.name), ['Grok', 'Composer 2.5', 'Opus', 'Auto'])
  visibility.dispose()
})

test('visibility: Codex selections update live without changing hidden-model routing', async () => {
  class CodexAdapter extends FakeAdapter {
    async resolveModel(_provider: string, model: string): Promise<object> { return { id: model } }
    async prepareCall(_provider: string, model: string): Promise<{ model: object }> { return { model: { id: model } } }
  }
  const adapter = new CodexAdapter(['gpt-5.4', 'gpt-5.3-codex'])
  const llm = registry({ 'openai-codex': adapter, 'deepseek-official': new FakeAdapter(['v4']) })
  let enabled: string[] = []
  const visibility = createVisibility(llm, () => ({ hiddenProviders: [], enabled: { 'openai-codex': enabled } }))
  visibility.sync()
  assert.deepEqual(ids(await llm.listModels('openai-codex')), ['gpt-5.4', 'gpt-5.3-codex'])
  enabled = ['gpt-5.4']
  assert.deepEqual(ids(await llm.listModels('openai-codex')), ['gpt-5.4'])
  enabled = [NO_MODELS]
  assert.deepEqual(ids(await llm.listModels('openai-codex')), [])
  assert.deepEqual(ids(await visibility.unfiltered.listModels('openai-codex')), ['gpt-5.4', 'gpt-5.3-codex'])
  // Existing/default sessions and background routes still resolve hidden models.
  assert.deepEqual(await adapter.resolveModel('openai-codex', 'gpt-5.3-codex'), { id: 'gpt-5.3-codex' })
  assert.deepEqual(await adapter.prepareCall('openai-codex', 'gpt-5.3-codex'), { model: { id: 'gpt-5.3-codex' } })
  assert.deepEqual(ids(await llm.listModels('deepseek-official')), ['v4'])
  enabled = []
  assert.deepEqual(ids(await llm.listModels('openai-codex')), ['gpt-5.4', 'gpt-5.3-codex'])
  visibility.dispose()
})

test('visibility: hidden providers list nothing, enabled lists narrow, empty lists keep all', () => {
  const models = [{ id: 'opus' }, { id: 'sonnet' }]
  assert.deepEqual(visibleModels({ hiddenProviders: ['p'], enabled: {} }, 'p', models), [])
  assert.deepEqual(visibleModels({ hiddenProviders: [], enabled: { p: ['sonnet'] } }, 'p', models), [{ id: 'sonnet' }])
  assert.deepEqual(visibleModels({ hiddenProviders: [], enabled: { p: [] } }, 'p', models), models)
  // 全不选 in the settings stores NO_MODELS, which no agent lists: nothing is offered.
  assert.deepEqual(visibleModels({ hiddenProviders: [], enabled: { p: [NO_MODELS] } }, 'p', models), [])
})

test('visibility: wraps every adapter, reads settings live, and restores on dispose', async () => {
  const adapters = { 'deepseek-official': new FakeAdapter(['v4']), 'claude-agent': new FakeAdapter(['opus', 'sonnet']) }
  const llm = registry(adapters)
  let settings: VisibilitySettings = { hiddenProviders: ['deepseek-official'], enabled: { 'claude-agent': ['opus'] } }
  const visibility = createVisibility(llm, () => settings)
  visibility.sync()
  visibility.sync()
  assert.deepEqual(ids(await llm.listModels('deepseek-official')), [])
  assert.deepEqual(ids(await llm.listModels('claude-agent')), ['opus'])
  // The settings page still sees everything.
  assert.deepEqual(ids(await visibility.unfiltered.listModels('deepseek-official')), ['v4'])
  assert.deepEqual(ids(await visibility.unfiltered.listModels('claude-agent')), ['opus', 'sonnet'])
  settings = { hiddenProviders: [], enabled: {} }
  assert.deepEqual(ids(await llm.listModels('deepseek-official')), ['v4'])
  settings = { hiddenProviders: ['deepseek-official'], enabled: {} }
  visibility.dispose()
  assert.equal(Object.hasOwn(adapters['deepseek-official'], 'listModels'), false)
  assert.deepEqual(ids(await llm.listModels('deepseek-official')), ['v4'])
})

test('visibility: a proxied adapter whose methods call its target at call time does not recurse', async () => {
  // As dsh-codex-subscription registers its adapter: `prepareCall` reads the target's own when called.
  class Target extends FakeAdapter {
    calls = 0
    async prepareCall(_provider: string, model: string): Promise<{ model: object }> {
      this.calls++
      return { model: { id: model } }
    }
  }
  const target = new Target(['m'])
  const proxy = new Proxy(target, {
    get(inner, property) {
      if (property === 'prepareCall') return async (...args: [string, string]) => ({ ...(await inner.prepareCall(...args)), wrapped: true })
      const value = Reflect.get(inner, property, inner)
      return typeof value === 'function' ? value.bind(inner) : value
    },
  })
  const llm = registry({ p: proxy })
  const visibility = createVisibility(llm, () => ({ hiddenProviders: [], enabled: {} }))
  visibility.sync()
  const call = await (llm.registration!('p').adapter as unknown as Target).prepareCall('p', 'm')
  assert.deepEqual(call, { model: { id: 'm' }, wrapped: true })
  assert.equal(target.calls, 1)
  visibility.dispose()
  assert.equal(Object.hasOwn(target, 'prepareCall'), false)
})

test('visibility: reloads in place keep a proxied adapter callable, whatever copy wraps or disposes first', async () => {
  class Target extends FakeAdapter {
    calls = 0
    async prepareCall(_provider: string, model: string): Promise<{ model: object }> {
      this.calls++
      return { model: { id: model } }
    }
  }
  const target = new Target(['m'])
  const proxy = new Proxy(target, {
    get(inner, property) {
      if (property === 'prepareCall') return async (...args: [string, string]) => ({ ...(await inner.prepareCall(...args)), wrapped: true })
      const value = Reflect.get(inner, property, inner)
      return typeof value === 'function' ? value.bind(inner) : value
    },
  })
  const llm = registry({ p: proxy })
  const call = async (): Promise<void> => {
    const before = target.calls
    assert.deepEqual(await (proxy as unknown as Target).prepareCall('p', 'm'), { model: { id: 'm' }, wrapped: true })
    assert.equal(target.calls, before + 1)
  }
  // What a copy from before the fix left on the target: it calls the proxy's closure, which calls the target's method.
  const stale = proxy.prepareCall
  const left = async (...args: [string, string]): Promise<unknown> => stale(...args)
  ;(target as unknown as Record<string, unknown>).prepareCall = left
  const settings = (): VisibilitySettings => ({ hiddenProviders: [], enabled: {} })
  const first = createVisibility(llm, settings)
  first.sync()
  await call()
  // The next copy wraps before the first is disposed, then the first goes.
  const second = createVisibility(llm, settings)
  second.sync()
  await call()
  first.dispose()
  await call()
  const third = createVisibility(llm, settings)
  third.sync()
  await call()
  third.dispose()
  second.dispose()
  // Every copy gone: the target holds what it held before them.
  assert.equal(Object.getOwnPropertyDescriptor(target, 'prepareCall')?.value, left)
})

test('visibility: an adapter registered later is wrapped on the next sync', async () => {
  const adapters: Record<string, FakeAdapter> = {}
  const llm = registry(adapters)
  const visibility = createVisibility(llm, () => ({ hiddenProviders: ['late'], enabled: {} }))
  visibility.sync()
  adapters.late = new FakeAdapter(['x'])
  assert.deepEqual(ids(await llm.listModels('late')), ['x'])
  visibility.sync()
  assert.deepEqual(ids(await llm.listModels('late')), [])
})

test('visibility: without adapter registrations it changes nothing and says so once', async () => {
  const adapter = new FakeAdapter(['v4'])
  const logs: string[] = []
  const llm: LlmRegistry = { listProviders: () => [{ id: 'p', name: 'P' }], listModels: (provider) => adapter.listModels(provider) }
  const visibility = createVisibility(llm, () => ({ hiddenProviders: ['p'], enabled: {} }), (message) => logs.push(message))
  visibility.sync()
  visibility.sync()
  assert.deepEqual(ids(await llm.listModels('p')), ['v4'])
  assert.equal(logs.length, 1)
})
