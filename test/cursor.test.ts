import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AcpAgent, type Child, type ConfigOption } from '../src/cursor/acp.ts'
import { CursorCatalog, effortChanges, effortsOf, modelsOf, thoughtSpec } from '../src/cursor/models.ts'
import { onDemand, planQuota, sumEvents } from '../src/cursor/usage.ts'
import { CursorTurn, dollars, toolLine, type Chunk } from '../src/cursor/translate.ts'
import { CURSOR_PROVIDER, CursorAgentAdapter } from '../src/cursor/adapter.ts'
import { cursorBilling } from '../src/cursor/billing.ts'
import { accessToken, latestVersion, versionRank } from '../src/cursor/cli.ts'
import { readCursor } from '../src/usage/sources/cursor.ts'
import { HttpError } from '../src/usage/sources/http.ts'
import { emptyEntry, fold, totals } from '../src/usage/tokens.ts'

// Config options as `agent acp` 2026.10.01 lists them (parameterized model picker).
const select = (id: string, category: string, currentValue: string, values: string[]): ConfigOption =>
  ({ id, name: id, category, type: 'select', currentValue, options: values.map((value) => ({ value, name: value === 'xhigh' ? 'Extra High' : value[0]!.toUpperCase() + value.slice(1) })) })
const model = (id: string): ConfigOption => select('model', 'model', id, ['auto-smart', 'composer-2.5', 'claude-opus-5', 'claude-haiku-5-5', 'gpt-5.6-sol'])
const OPUS_5 = [model('claude-opus-5'), select('thinking', 'thought_level', 'true', ['false', 'true']), select('context', 'model_config', '300k', ['300k', '1m']), select('effort', 'thought_level', 'high', ['low', 'medium', 'high', 'xhigh', 'max']), select('fast', 'model_config', 'false', ['false', 'true'])]
const SOL = [model('gpt-5.6-sol'), select('reasoning', 'thought_level', 'medium', ['none', 'low', 'medium', 'high', 'xhigh', 'max'])]
const COMPOSER = [model('composer-2.5'), select('fast', 'model_config', 'true', ['false', 'true'])]
const SWITCH_ONLY = [model('x'), select('thinking', 'thought_level', 'false', ['false', 'true'])]

test('cursor: reasoning knobs fold into one picker on the effort ladder', () => {
  const opus = thoughtSpec(OPUS_5)!
  assert.deepEqual(effortsOf(opus).map((effort) => effort.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(opus.defaultEffort, 'high')
  assert.equal(effortsOf(opus).find((effort) => effort.id === 'xhigh')?.name, 'Extra High')
  // `none` reads as off.
  const sol = thoughtSpec(SOL)!
  assert.deepEqual(effortsOf(sol).map((effort) => effort.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(sol.defaultEffort, 'medium')
  // Speed and context are not reasoning.
  assert.equal(thoughtSpec(COMPOSER), undefined)
  // A switch alone: off, and "On" on the ladder's lowest thinking rung.
  const toggle = thoughtSpec(SWITCH_ONLY)!
  assert.deepEqual(effortsOf(toggle), [{ id: 'off', name: 'Off' }, { id: 'low', name: 'On' }])
  assert.equal(toggle.defaultEffort, 'off')
})

test('cursor: picking a level changes only the knobs that differ', () => {
  const opus = thoughtSpec(OPUS_5)!
  assert.deepEqual(effortChanges(opus, 'high', OPUS_5), [])
  assert.deepEqual(effortChanges(opus, 'max', OPUS_5), [['effort', 'max']])
  assert.deepEqual(effortChanges(opus, 'off', OPUS_5), [['thinking', 'false']])
  const thinkingOff = OPUS_5.map((option) => option.id === 'thinking' ? { ...option, currentValue: 'false' } : option)
  assert.deepEqual(effortChanges(opus, 'low', thinkingOff), [['thinking', 'true'], ['effort', 'low']])
  assert.deepEqual(effortChanges(thoughtSpec(SOL)!, 'off', SOL), [['reasoning', 'none']])
  assert.deepEqual(effortChanges(thoughtSpec(SWITCH_ONLY)!, 'low', SWITCH_ONLY), [['thinking', 'true']])
  assert.deepEqual(modelsOf(OPUS_5).map((entry) => entry.id), ['auto-smart', 'composer-2.5', 'claude-opus-5', 'claude-haiku-5-5', 'gpt-5.6-sol'])
})

// GetCurrentPeriodUsage / GetPlanInfo / GetHardLimit as a team account answered them.
const CURRENT = {
  billingCycleStart: '1790439666000',
  billingCycleEnd: '1793031666000',
  planUsage: { totalSpend: 33048, includedSpend: 2000, bonusSpend: 31048, limit: 2000, autoPercentUsed: 12.39, apiPercentUsed: 100, totalPercentUsed: 26.4384 },
  spendLimitUsage: { totalSpend: 283871, pooledLimit: '900000', pooledUsed: 283871, pooledRemaining: '616129', individualUsed: 21948, limitType: 'team' },
}

test('cursor: the plan reads as one card, Auto and API under it, on-demand spend as the CLI shows it', () => {
  const quota = planQuota(CURRENT, { planInfo: { planName: 'Team', billingCycleEnd: '1793031666000' } }, { hardLimit: 9000 }, 5)
  assert.equal(quota.plan, 'Team')
  assert.equal(quota.windows.length, 3)
  assert.deepEqual(quota.windows[0], { key: 'month', usedPercent: 26.4384, resetsAt: 1793031666000, windowMs: 1793031666000 - 1790439666000 })
  assert.deepEqual(quota.windows.slice(1).map((window) => [window.label, window.group, window.usedPercent]), [['Auto', 'Included', 12.39], ['API', 'Included', 100]])
  assert.deepEqual(quota.spend, { used: 219.48 })
  assert.equal(quota.error, undefined)
  // A personal cap wins; a team that forbids on-demand turns it off; a fixed hard limit caps it.
  assert.deepEqual(onDemand({ spendLimitUsage: { individualUsed: 500, individualLimit: 2000, limitType: 'team' } }, { hardLimit: 9000 }), { used: 5, limit: 20 })
  assert.deepEqual(onDemand({ spendLimitUsage: { individualUsed: 0, limitType: 'team' } }, { hardLimit: 0 }), { used: 0, disabled: true })
  assert.deepEqual(onDemand({ spendLimitUsage: { individualUsed: 1234 } }, { hardLimit: 50 }), { used: 12.34, limit: 50 })
  assert.deepEqual(onDemand({ spendLimitUsage: { individualUsed: 1234 } }, { hardLimit: 2_147_483_647 }), { used: 12.34 })
})

test('cursor: a turn\'s usage is its conversation\'s events after the last one counted', () => {
  const event = (timestamp: number, conversationId: string, model: string, input: number, cents: number) =>
    ({ timestamp: String(timestamp), model, conversationId, chargedCents: cents, tokenUsage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 100 } })
  const events = [event(30, 's1', 'composer-2.5-fast', 5, 1.5), event(20, 's1', 'claude-opus-5-5-high', 7, 2), event(25, 's2', 'x', 1000, 99), event(10, 's1', 'composer-2.5-fast', 1, 1)]
  const usage = sumEvents(events, 's1', 10)!
  assert.equal(usage.through, 30)
  assert.equal(usage.input, 12)
  assert.equal(usage.output, 20)
  assert.equal(usage.cacheRead, 200)
  assert.equal(usage.cents, 3.5)
  assert.deepEqual(Object.keys(usage.byModel).sort(), ['claude-opus-5-5-high', 'composer-2.5-fast'])
  assert.equal(sumEvents(events, 's1', 30), undefined)
  assert.equal(dollars(1.2498), '$0.012')
  assert.equal(dollars(124), '$1.24')
})

test('cursor: updates stream as text and thinking, tools as one-line notes, failures marked', () => {
  const turn = new CursorTurn()
  const chunks: Chunk[] = [
    ...turn.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } }),
    ...turn.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' more' } }),
    ...turn.push({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '`npm test`', kind: 'execute', status: 'pending' }),
    ...turn.push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { exitCode: 1, stdout: '', stderr: 'boom\nmore' } }),
    ...turn.push({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
    ...turn.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } }),
  ]
  const ends = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => (chunk as { block: { type: string; text: string } }).block)
  assert.deepEqual(ends, [
    { type: 'reasoning', text: 'Thinking more' },
    { type: 'reasoning', text: '→ Shell: npm test' },
    { type: 'reasoning', text: '✗ Shell: npm test: exit 1, boom' },
  ])
  const finish = turn.finish({ cursor: { session: 's', since: 1, total: {} } }, { through: 9, input: 1200, output: 34, cacheRead: 0, cacheWrite: 0, cents: 2.5, byModel: { 'composer-2.5': { input: 1200, output: 34, cacheRead: 0, cacheWrite: 0 } } })
  const blocks = finish.filter((chunk) => chunk.type === 'block-end').map((chunk) => (chunk as { block: { text: string } }).block.text)
  assert.deepEqual(blocks, ['Done', 'Cursor usage: 1.2K in · 34 out · $0.025 (composer-2.5)'])
  assert.deepEqual(finish.at(-2), { type: 'usage', usage: { inputTokens: 0, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 34 } })
  assert.equal(toolLine('read', 'src/a.ts'), 'Read: src/a.ts')
  assert.equal(toolLine('read', 'Read src/a.ts'), 'Read: src/a.ts')
  assert.equal(toolLine(undefined, 'Something'), 'Something')
})

test('cursor: running tools and silences get heartbeat notes at 1, 2, 5, 10, 20, 30 minutes', () => {
  const minute = 60_000
  const turn = new CursorTurn(0)
  const texts = (chunks: Chunk[]): string[] => chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => (chunk as { block: { text: string } }).block.text)
  // Nothing from Cursor for a while.
  assert.deepEqual(texts([...turn.tick(30_000), ...turn.tick(61_000), ...turn.tick(90_000), ...turn.tick(2 * minute)]), [
    '⏳ No output from Cursor · 1m',
    '⏳ No output from Cursor · 2m',
  ])
  // A running tool takes over from the silence; the silence counts again from its last update.
  turn.push({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '`npm test`', kind: 'execute', status: 'pending' }, 3 * minute)
  turn.push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }, 3 * minute)
  assert.deepEqual(texts([4, 5, 8, 13].flatMap((at) => turn.tick(at * minute))), [
    '⏳ Shell: npm test · 1m',
    '⏳ Shell: npm test · 2m',
    '⏳ Shell: npm test · 5m',
    '⏳ Shell: npm test · 10m',
  ])
  turn.push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, 14 * minute)
  assert.deepEqual(texts([...turn.tick(14.5 * minute), ...turn.tick(15 * minute)]), ['⏳ No output from Cursor · 1m'])
})

test('cursor: the CLI\'s newest version folder is the one that runs', async () => {
  assert.ok(versionRank('2026.10.01-e373342') > versionRank('2026.9.30-abcdef0'))
  assert.ok(Number.isNaN(versionRank('notes')))
  const root = await mkdtemp(join(tmpdir(), 'cursor-versions-'))
  const { mkdir } = await import('node:fs/promises')
  for (const name of ['2026.9.30-abc1234', '2026.10.01-e373342', 'tmp']) await mkdir(join(root, name))
  assert.equal(latestVersion(root), join(root, '2026.10.01-e373342'))
})

test('cursor: the login token comes from the keychain first, then the auth file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-auth-'))
  const file = join(dir, 'auth.json')
  const none = async () => undefined
  assert.equal(await accessToken(file, none), undefined)
  await writeFile(file, JSON.stringify({ accessToken: 'from-file' }))
  assert.equal(await accessToken(file, none), 'from-file')
  assert.equal(await accessToken(file, async () => 'from-keychain'), 'from-keychain')
})

test('cursor: the usage card hides without the CLI and asks for a sign-in when signed out', async () => {
  assert.deepEqual(await readCursor(undefined, () => false, async () => undefined), [])
  assert.equal((await readCursor(undefined, () => true, async () => undefined))[0]?.error?.code, 'not-signed-in')
  const refused = async (): Promise<never> => { throw new HttpError(401) }
  assert.equal((await readCursor(refused, () => true, async () => 'token'))[0]?.error?.code, 'not-signed-in')
  const ok = async (method: string) => method === 'GetCurrentPeriodUsage' ? CURRENT : method === 'GetHardLimit' ? { hardLimit: 9000 } : {}
  const [quota] = await readCursor(ok, () => true, async () => 'token')
  assert.equal(quota?.windows[0]?.usedPercent, 26.4384)
})

test('cursor: the token ledger counts the growth of a Cursor session\'s totals', () => {
  const entry = emptyEntry()
  const reply = (time: number, total: Record<string, object>) => ({
    type: 'assistant/message', time,
    data: { usage: { inputTokens: 0, outputTokens: 1 }, message: { source: { provider: CURSOR_PROVIDER, model: 'composer-2.5', replayState: { cursor: { session: 's', since: 1, total } } } } },
  })
  fold(entry, reply(Date.UTC(2026, 9, 12, 12), {}))
  fold(entry, reply(Date.UTC(2026, 9, 12, 13), { 'composer-2.5-fast': { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 } }))
  fold(entry, reply(Date.UTC(2026, 9, 12, 14), { 'composer-2.5-fast': { input: 15, output: 9, cacheRead: 300, cacheWrite: 0 } }))
  const rows = totals([entry]).rows
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0], day: undefined }, { day: undefined, provider: CURSOR_PROVIDER, model: 'composer-2.5-fast', input: 15, output: 9, cacheRead: 300, cacheWrite: 0 })
})

/**
 * A minimal `agent acp`: sessions with a model and reasoning knobs, a prompt
 * that streams a thought, a tool call needing permission and a message, and
 * the CLI's habit of saving config choices to its settings file.
 */
class FakeCursor {
  sessions = new Map<string, ConfigOption[]>()
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  permissions: unknown[] = []
  configFile: string | undefined
  started = 0

  child(): Child {
    this.started++
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let buffer = ''
    const pending = new Map<number, (result: unknown) => void>()
    let next = 1000
    const send = (message: object): void => { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
    const ask = (method: string, params: object): Promise<unknown> => new Promise((resolve) => {
      const id = next++
      pending.set(id, resolve)
      send({ id, method, params })
    })
    const update = (sessionId: string, value: object): void => send({ method: 'session/update', params: { sessionId, update: value } })
    stdin.on('data', (data) => {
      buffer += String(data)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
        buffer = buffer.slice(end + 1)
        if (message.method === undefined) {
          pending.get(message.id!)?.(message.result)
          continue
        }
        this.calls.push({ method: message.method, params: message.params ?? {} })
        void this.handle(message.method, message.params ?? {}, send, ask, update).then((result) => {
          if (message.id !== undefined) send(result instanceof Error ? { id: message.id, error: { code: -32000, message: result.message } } : { id: message.id, result })
        })
      }
    })
    const exits: Array<(code: number | null) => void> = []
    return {
      stdin, stdout, stderr: null,
      kill: () => { for (const exit of exits) exit(null) },
      once: (event: string, listener: (value: never) => void) => { if (event === 'exit') exits.push(listener as (code: number | null) => void) },
    }
  }

  private options(modelId: string): ConfigOption[] {
    if (modelId === 'claude-opus-5') return OPUS_5
    return [model(modelId), ...(modelId === 'composer-2.5' ? COMPOSER.slice(1) : [])]
  }

  private async handle(method: string, params: Record<string, unknown>, _send: (message: object) => void, ask: (method: string, params: object) => Promise<unknown>, update: (sessionId: string, value: object) => void): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      case 'session/new': {
        const id = `s${this.sessions.size + 1}`
        this.sessions.set(id, this.options('composer-2.5'))
        return { sessionId: id, configOptions: this.sessions.get(id) }
      }
      case 'session/load': {
        const id = String(params.sessionId)
        if (!this.sessions.has(id)) return new Error('Session not found')
        update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } })
        return { configOptions: this.sessions.get(id) }
      }
      case 'session/set_config_option': {
        const id = String(params.sessionId)
        let options = this.sessions.get(id)!
        if (params.configId === 'model') options = this.options(String(params.value))
        else options = options.map((option) => option.id === params.configId ? { ...option, currentValue: String(params.value) } : option)
        this.sessions.set(id, options)
        if (this.configFile !== undefined) await writeFile(this.configFile, JSON.stringify({ changedBy: 'set_config_option' }))
        return { configOptions: options }
      }
      case 'session/prompt': {
        const id = String(params.sessionId)
        update(id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning' } })
        update(id, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`echo hi`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } })
        const answer = await ask('session/request_permission', {
          sessionId: id,
          toolCall: { toolCallId: 't1', title: '`echo hi`', kind: 'execute', rawInput: { command: 'echo hi' } },
          options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'allow-always', kind: 'allow_always' }, { optionId: 'reject-once', kind: 'reject_once' }],
        })
        this.permissions.push(answer)
        update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } })
        return { stopReason: 'end_turn' }
      }
      default:
        return new Error(`unexpected ${method}`)
    }
  }
}

test('cursor: the ACP client restores the CLI settings the agent rewrites, and drops replayed history', async () => {
  const fake = new FakeCursor()
  const dir = await mkdtemp(join(tmpdir(), 'cursor-config-'))
  const file = join(dir, 'cli-config.json')
  await writeFile(file, '{"mine":true}')
  fake.configFile = file
  const acp = new AcpAgent({ start: () => fake.child(), configFile: file, log: () => {} })
  const { sessionId } = await acp.newSession(dir)
  const options = await acp.configure(sessionId, 'model', 'claude-opus-5')
  assert.equal(options.find((option) => option.id === 'effort')?.currentValue, 'high')
  assert.equal(await readFile(file, 'utf8'), '{"mine":true}')
  const seen: string[] = []
  const load = acp.loadSession(sessionId, dir)
  await load
  await acp.prompt(sessionId, [{ type: 'text', text: 'hi' }], {
    update: (update) => seen.push(update.sessionUpdate),
    permission: async () => 'reject-once',
  })
  assert.ok(!seen.includes('replayed'), 'history replayed by session/load is not a turn')
  assert.deepEqual(seen, ['agent_thought_chunk', 'tool_call', 'agent_message_chunk'])
  assert.deepEqual(fake.permissions, [{ outcome: { outcome: 'selected', optionId: 'reject-once' } }])
  acp.close()
})

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function request(messages: object[], extra: object = {}) {
  const options = { provider: CURSOR_PROVIDER, model: 'claude-opus-5', sessionId: 'dsh-1', messages, ...extra } as Parameters<CursorAgentAdapter['stream']>[0]
  markAgentLoopRequest(options)
  return options
}

async function drain(stream: AsyncIterable<object>): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  for await (const chunk of stream) chunks.push(chunk as Chunk)
  return chunks
}

test('cursor: a turn sets model and level, asks DSH to approve tools, and ends with its usage', async () => {
  const fake = new FakeCursor()
  const approvals: object[] = []
  const usageReads: Array<[string, number]> = []
  const acp = new AcpAgent({ start: () => fake.child(), log: () => {} })
  const adapter = new CursorAgentAdapter({
    acp,
    agents: () => ({ currentInitiator: () => ({ session: { header: { cwd: tmpdir() } } }) }),
    approval: () => ({ request: async (value: object) => { approvals.push(value); return 'allowed-once' } }),
    log: () => {},
    instructions: () => 'Answer in Chinese.',
    usage: async (conversation, after) => {
      usageReads.push([conversation, after])
      return { through: 500, input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cents: 1.25, byModel: { 'claude-opus-5-thinking-max': { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 } } }
    },
  })
  try {
    const chunks = await drain(adapter.stream(request([user('fix the bug')], { reasoningEffort: 'max' })))
    const configured = fake.calls.filter((call) => call.method === 'session/set_config_option').map((call) => [call.params.configId, call.params.value])
    assert.deepEqual(configured, [['model', 'claude-opus-5'], ['effort', 'max']])
    const prompt = fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>
    assert.match(prompt[0]!.text, /^<system-reminder>\nAnswer in Chinese\.\n<\/system-reminder>\n\nfix the bug$/)
    assert.equal(approvals.length, 1)
    assert.equal((approvals[0] as { reason: string }).reason, 'Shell: echo hi')
    assert.deepEqual(fake.permissions, [{ outcome: { outcome: 'selected', optionId: 'allow-once' } }])
    assert.deepEqual(usageReads, [['s1', 0]])
    const finish = chunks.at(-1) as Extract<Chunk, { type: 'finish' }>
    assert.equal(finish.replayState.cursor.session, 's1')
    assert.equal(finish.replayState.cursor.through, 500)
    assert.equal(finish.replayState.cursor.cents, 1.25)
    assert.deepEqual(finish.replayState.cursor.total, { 'claude-opus-5-thinking-max': { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 } })

    // The next turn, after the CLI restarted: the session is loaded, only the new prompt is sent,
    // instructions are not repeated, and usage is read after the last event counted.
    acp.close()
    const replied = { role: 'assistant', content: [{ type: 'text', text: 'Done' }], source: { kind: 'model', provider: CURSOR_PROVIDER, model: 'claude-opus-5', replayState: finish.replayState } }
    fake.calls = []
    await drain(adapter.stream(request([user('fix the bug'), replied, user('and the test')], { reasoningEffort: 'max' })))
    assert.deepEqual(fake.calls.map((call) => call.method).filter((method) => method !== 'session/request_permission'), ['initialize', 'session/load', 'session/prompt'])
    assert.equal((fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>)[0]!.text, 'and the test')
    assert.deepEqual(usageReads[1], ['s1', 500])
  } finally {
    adapter.dispose()
  }
})

test('cursor: a session Cursor no longer has starts over with the conversation as context', async () => {
  const fake = new FakeCursor()
  const adapter = new CursorAgentAdapter({
    acp: new AcpAgent({ start: () => fake.child(), log: () => {} }),
    agents: () => ({ currentInitiator: () => ({ session: { header: { cwd: tmpdir() } } }) }),
    approval: () => ({ request: async () => 'rejected' }),
    log: () => {},
    usage: async () => undefined,
  })
  try {
    const gone = { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }], source: { kind: 'model', provider: CURSOR_PROVIDER, model: 'composer-2.5', replayState: { cursor: { session: 'lost', since: 1 } } } }
    const chunks = await drain(adapter.stream(request([user('first'), gone, user('second')], { model: 'composer-2.5' })))
    const prompt = (fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>)[0]!.text
    assert.match(prompt, /<prior_conversation>[\s\S]*User: first[\s\S]*Earlier answer[\s\S]*<\/prior_conversation>\n\nsecond$/)
    assert.deepEqual(fake.permissions, [{ outcome: { outcome: 'selected', optionId: 'reject-once' } }])
    const finish = chunks.at(-1) as Extract<Chunk, { type: 'finish' }>
    assert.equal(finish.replayState.cursor.session, 's1')
    // No usage read in time: totals are still stamped (empty), so the ledger keeps counting by difference.
    assert.deepEqual(finish.replayState.cursor.total, {})
  } finally {
    adapter.dispose()
  }
})

test('cursor: a skill invoked with /name leads the prompt and opens the reply with a note', async () => {
  const fake = new FakeCursor()
  const adapter = new CursorAgentAdapter({
    acp: new AcpAgent({ start: () => fake.child(), log: () => {} }),
    agents: () => ({ currentInitiator: () => ({ session: { header: { cwd: tmpdir() } } }) }),
    approval: () => ({ request: async () => 'rejected' }),
    log: () => {},
    usage: async () => undefined,
  })
  try {
    const skill = { role: 'user', content: [{ type: 'text', text: '<skill_content name="ship">steps</skill_content>' }], source: { kind: 'skill-invocation', name: 'ship' } }
    const chunks = await drain(adapter.stream(request([user('/ship now'), skill], { model: 'composer-2.5' })))
    const prompt = (fake.calls.find((call) => call.method === 'session/prompt')!.params.prompt as Array<{ text: string }>)[0]!.text
    assert.equal(prompt, '<skill_content name="ship">steps</skill_content>\n\n/ship now')
    assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: '⚡ Skill /ship' })
  } finally {
    adapter.dispose()
  }
})

test('cursor: background requests go to another model', async () => {
  const delegated: object[] = []
  const adapter = new CursorAgentAdapter({
    acp: new AcpAgent({ start: () => { throw new Error('must not start') }, log: () => {} }),
    agents: () => undefined,
    approval: () => undefined,
    log: () => {},
    async *delegate(options) { delegated.push(options); yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  try {
    await drain(adapter.stream({ provider: CURSOR_PROVIDER, model: 'composer-2.5', purpose: 'title', sessionId: 'x', messages: [user('hi')] } as Parameters<CursorAgentAdapter['stream']>[0]))
    assert.equal(delegated.length, 1)
  } finally {
    adapter.dispose()
  }
})

test('cursor: the catalog lists models at once and reads the model being picked first', async () => {
  const read: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const catalog = new CursorCatalog(() => ({
    open: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'claude-opus-5', name: 'Opus 5' }],
    options: async (id) => {
      read.push(id)
      await gate
      return id === 'claude-opus-5' ? OPUS_5 : [model(id)]
    },
    close: async () => {},
  }))
  // Listed while the first model's knobs are still being read.
  assert.deepEqual((await catalog.models()).map((entry) => entry.id), ['a', 'b', 'claude-opus-5'])
  const opus = catalog.thought('claude-opus-5')
  release()
  assert.deepEqual(effortsOf((await opus)!).map((effort) => effort.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(read.slice(0, 2), ['a', 'claude-opus-5'])
  assert.equal(await catalog.thought('b'), undefined)
})

test('cursor billing: Cursor\'s own models are included, the rest on demand', () => {
  for (const id of ['auto', 'auto-smart', 'composer-2.5', 'composer-2.5-fast']) assert.equal(cursorBilling(id), 'included', id)
  for (const id of ['claude-opus-5-5', 'gpt-5.5', 'grok-4.7', 'autobot', 'kimi-k3']) assert.equal(cursorBilling(id), 'on-demand', id)
})
