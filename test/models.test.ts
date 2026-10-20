import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listModelGroups, type ModelCatalog } from '../src/models.ts'

const llm: ModelCatalog = {
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'claude-agent', name: 'Claude Agent' },
    { id: 'broken', name: 'Broken' },
  ],
  async listModels(provider) {
    if (provider === 'broken') throw new Error('signed out')
    return [{ id: `${provider}-m`, name: 'M', description: 'kept' } as { id: string; name: string }]
  },
}

test('models: groups registered providers in order, skipping excluded routes', async () => {
  assert.deepEqual(await listModelGroups(llm, ['claude-agent']), [
    { provider: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-official-m', name: 'M', description: 'kept' }] },
    { provider: 'broken', name: 'Broken', models: [], failed: true },
  ])
})
