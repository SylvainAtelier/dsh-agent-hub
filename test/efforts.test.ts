import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseEffort, nearestEffort, withDefaultEffort, type EffortSettings } from '../src/efforts.ts'
import { createVisibility, type LlmRegistry, type ModelEntry, type VisibilitySettings } from '../src/visibility.ts'
import { listModelGroups } from '../src/models.ts'

const DEEPSEEK = ['off', 'low', 'high', 'max']
const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max']

test('efforts: the shared level falls back to the nearest lower level, else the nearest higher one', () => {
  assert.equal(nearestEffort('high', DEEPSEEK), 'high')
  assert.equal(nearestEffort('medium', DEEPSEEK), 'low')
  assert.equal(nearestEffort('xhigh', DEEPSEEK), 'high')
  assert.equal(nearestEffort('off', CLAUDE), 'low')
  assert.equal(nearestEffort('minimal', ['medium', 'low']), 'low')
  assert.equal(nearestEffort('', CLAUDE), undefined)
  // Levels outside the ladder only match exactly.
  assert.equal(nearestEffort('turbo', CLAUDE), undefined)
  assert.equal(nearestEffort('turbo', ['turbo']), 'turbo')
})

test('efforts: a per-model rule wins when the model offers it', () => {
  const settings: EffortSettings = { effort: 'high', rules: [{ provider: 'p', model: 'm', effort: 'max' }, { provider: 'p', model: 'n', effort: 'medium' }] }
  assert.equal(chooseEffort(settings, 'p', 'm', DEEPSEEK), 'max')
  assert.equal(chooseEffort(settings, 'q', 'm', DEEPSEEK), 'high')
  // A rule naming a level the model lacks falls back to the shared level.
  assert.equal(chooseEffort(settings, 'p', 'n', DEEPSEEK), 'high')
})

test('efforts: rewrites the default effort only when it changes', () => {
  const info = { id: 'm', reasoning: { efforts: DEEPSEEK.map((id) => ({ id })), defaultEffort: 'off' } }
  assert.deepEqual(withDefaultEffort(info, { effort: 'high', rules: [] }, 'p', 'm').reasoning.defaultEffort, 'high')
  assert.equal(withDefaultEffort(info, { effort: '', rules: [] }, 'p', 'm'), info)
  assert.equal(withDefaultEffort(info, { effort: 'off', rules: [] }, 'p', 'm'), info)
  const plain = { id: 'm' }
  assert.equal(withDefaultEffort(plain, { effort: 'high', rules: [] }, 'p', 'm'), plain)
})

class ReasoningAdapter {
  async listModels(provider: string): Promise<ModelEntry[]> {
    return [{ provider, id: 'm', name: 'M' }]
  }
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: DEEPSEEK.map((id) => ({ id, name: id.toUpperCase() })), defaultEffort: 'off' } }
  }
  async prepareCall(provider: string, model: string) {
    return { model: await this.resolveModel(provider, model), stream: () => 'stream' }
  }
}

test('visibility: resolveModel and prepareCall carry the configured default effort; bots are left alone', async () => {
  const adapters: Record<string, ReasoningAdapter> = { p: new ReasoningAdapter(), bots: new ReasoningAdapter() }
  const llm: LlmRegistry = {
    listProviders: () => Object.keys(adapters).map((id) => ({ id, name: id })),
    listModels: (provider) => adapters[provider]!.listModels(provider),
    registration: (provider) => ({ adapter: adapters[provider]! }),
  }
  let settings: VisibilitySettings = { hiddenProviders: [], enabled: {}, efforts: { effort: 'medium', rules: [] }, inherited: ['bots'] }
  const visibility = createVisibility(llm, () => settings)
  visibility.sync()
  const effort = (info: object): unknown => (info as { reasoning: { defaultEffort: string } }).reasoning.defaultEffort
  assert.equal(effort(await adapters.p!.resolveModel('p', 'm')), 'low')
  const call = await adapters.p!.prepareCall('p', 'm')
  assert.equal(effort(call.model), 'low')
  assert.equal(call.stream(), 'stream')
  assert.equal(effort(await adapters.bots!.resolveModel('bots', 'm')), 'off')
  settings = { ...settings, efforts: { effort: 'medium', rules: [{ provider: 'p', model: 'm', effort: 'max' }] } }
  assert.equal(effort(await adapters.p!.resolveModel('p', 'm')), 'max')
  // The settings page reads each model's own default and levels.
  const groups = await listModelGroups(visibility.unfiltered, [], true)
  assert.deepEqual(groups[0]!.models[0]!.reasoning, { efforts: DEEPSEEK.map((id) => ({ id, name: id.toUpperCase() })), defaultEffort: 'off' })
  assert.equal((await listModelGroups(visibility.unfiltered))[0]!.models[0]!.reasoning, undefined)
  visibility.dispose()
  assert.equal(Object.hasOwn(adapters.p!, 'resolveModel'), false)
  assert.equal(Object.hasOwn(adapters.p!, 'prepareCall'), false)
  assert.equal(effort(await adapters.p!.resolveModel('p', 'm')), 'off')
})
