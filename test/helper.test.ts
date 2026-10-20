import { test } from 'node:test'
import assert from 'node:assert/strict'
import { helperRequest, helperRoute } from '../src/claude/helper.ts'
import { ClaudeAgentAdapter, PROVIDER, type AdapterHost, type StreamOptions } from '../src/claude/adapter.ts'
import type { ModelCatalog } from '../src/models.ts'

const BOTS = 'agent-hub-bot'
const catalog: ModelCatalog = {
  listProviders: () => [{ id: PROVIDER, name: 'Claude Agent' }, { id: BOTS, name: 'Bots' }, { id: 'empty', name: 'Empty' }, { id: 'deepseek', name: 'DeepSeek' }],
  async listModels(provider) {
    if (provider === 'empty') return []
    return [{ id: `${provider}-1`, name: `${provider} one` }, { id: `${provider}-2`, name: `${provider} two` }]
  },
}
const exclude = [PROVIDER, BOTS]

test('helper: background requests go to the configured model, else the default, else the first other model', async () => {
  const deepseek = { provider: 'deepseek', model: 'flash' }
  assert.deepEqual(await helperRoute({ helperProvider: ' minimax ', helperModel: ' m2 ' }, () => deepseek, () => catalog, exclude), { provider: 'minimax', model: 'm2' })
  // Half a route, or Claude Agent / a bot (a bot may run on Claude Agent), is never used.
  assert.deepEqual(await helperRoute({ helperProvider: 'minimax' }, () => deepseek, () => catalog, exclude), deepseek)
  assert.deepEqual(await helperRoute({ helperProvider: PROVIDER, helperModel: 'opus' }, () => deepseek, () => catalog, exclude), deepseek)
  assert.deepEqual(await helperRoute({}, () => ({ provider: PROVIDER, model: 'opus' }), () => catalog, exclude), { provider: 'deepseek', model: 'deepseek-1' })
  assert.deepEqual(await helperRoute({}, () => ({ provider: BOTS, model: 'reviewer' }), () => catalog, exclude), { provider: 'deepseek', model: 'deepseek-1' })
  assert.equal(await helperRoute({}, () => undefined, () => undefined, exclude), undefined)
  const onlyClaude: ModelCatalog = { listProviders: () => [{ id: PROVIDER, name: 'Claude Agent' }], listModels: async () => [{ id: 'opus', name: 'Opus' }] }
  assert.equal(await helperRoute({}, () => undefined, () => onlyClaude, exclude), undefined)
})

test('helper: the forwarded request keeps everything but the route, the persona and the reasoning effort', () => {
  const signal = new AbortController().signal
  const request = { provider: PROVIDER, model: 'opus', purpose: 'compaction', sessionId: 's1', persona: 'You review', reasoningEffort: 'high', messages: [], maxTokens: 9, signal }
  assert.deepEqual(helperRequest(request, { provider: 'deepseek', model: 'flash' }), { provider: 'deepseek', model: 'flash', purpose: 'compaction', sessionId: 's1', messages: [], maxTokens: 9, signal })
})

test('claude agent: compaction and titles are answered through the delegate; without one they fail as before', async () => {
  const forwarded: StreamOptions[] = []
  const host = (delegate?: AdapterHost['delegate']): AdapterHost => ({
    accounts: {} as AdapterHost['accounts'],
    agents: () => undefined,
    approval: () => undefined,
    log: () => {},
    ...(delegate === undefined ? {} : { delegate }),
  })
  const settings = () => ({ remoteControl: false, fullAccess: false, keepOnline: 0, idleHours: 2, models: [] })
  const adapter = new ClaudeAgentAdapter(host(async function* (options) {
    forwarded.push(options)
    yield { type: 'text-delta', text: 'summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }), settings)
  const read = async (options: StreamOptions): Promise<object[]> => {
    const out: object[] = []
    for await (const chunk of adapter.stream(options)) out.push(chunk)
    return out
  }
  const compaction = { provider: PROVIDER, model: 'opus', purpose: 'compaction', sessionId: 's1', messages: [] }
  assert.deepEqual(await read(compaction), [{ type: 'text-delta', text: 'summary' }, { type: 'finish', reason: { kind: 'stop' } }])
  assert.deepEqual(forwarded, [compaction])
  // A session title has no session id at all.
  await read({ provider: PROVIDER, model: 'opus', purpose: 'session-title', messages: [] })
  assert.equal(forwarded.length, 2)
  // Another provider's request is still refused, never forwarded.
  await assert.rejects(read({ provider: 'deepseek', model: 'x', purpose: 'compaction', sessionId: 's1', messages: [] }), /only answers conversation turns/)
  assert.equal(forwarded.length, 2)

  const bare = new ClaudeAgentAdapter(host(), settings)
  await assert.rejects(async () => { for await (const _ of bare.stream(compaction)) { /* drain */ } }, /only answers conversation turns/)
  adapter.dispose()
  bare.dispose()
})
