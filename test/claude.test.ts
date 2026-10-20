import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { isResumedConversationRequest, pendingInput, REFERENCE_INLINE_MAX, REMOTE_ECHO, remoteEchoes, skillNote, summarizeTool, transcriptPrompt, TurnTranslator, type Chunk, type HarnessMessage } from '../src/claude/translate.ts'

const P = 'claude-agent'
const user = (text: string, kind = 'user'): HarnessMessage => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } })
const reply = (text: string, provider: string, session?: string): HarnessMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider, model: provider === P ? 'opus' : 'deepseek-v4', ...(session === undefined ? {} : { replayState: { claude: { session } } }) },
})

test('claude: a reconstructed failed turn can continue after switching accounts without a process-local marker', () => {
  const messages = [user('old prompt'), reply('earlier response', P, 'old-account-session'), user('继续')]
  const request = { sessionId: 'existing-dsh-session', messages }
  assert.equal(isAgentLoopRequest(request), false)
  assert.equal(isResumedConversationRequest(request), true)
  assert.equal(pendingInput(messages, P, 'new-account').resume, undefined)
  assert.match(pendingInput(messages, P, 'new-account').prompt, /earlier response[\s\S]*继续/)
  assert.equal(isResumedConversationRequest({ ...request, purpose: 'title' }), false)
  assert.equal(isResumedConversationRequest({ ...request, sessionId: undefined }), false)
  assert.equal(isResumedConversationRequest({ ...request, messages: [user('hi'), reply('done', P)] }), false)
  assert.equal(isResumedConversationRequest({ ...request, messages: [user('hi', 'runtime-context')] }), false)
  assert.equal(isResumedConversationRequest({ ...request, messages: [user('')] }), false)
  assert.equal(isResumedConversationRequest({ ...request, messages: [user('hi'), reply('done', P), echo('from phone')] }), true)
})

test('claude: a fresh session sends just the prompt', () => {
  assert.deepEqual(pendingInput([user('hi')], P), { prompt: 'hi' })
})

test('claude: resumes after its own last reply and sends only what came after', () => {
  const input = pendingInput([user('one'), reply('a', P, 's1'), user('two'), user('ctx', 'runtime-context'), user('three')], P)
  assert.deepEqual(input, { resume: 's1', prompt: 'two\n\nthree' })
})

test('claude: replies from another model since then become context', () => {
  const input = pendingInput([user('one'), reply('a', P, 's1'), user('two'), reply('b', 'deepseek'), user('three')], P)
  assert.equal(input.resume, 's1')
  assert.match(input.prompt, /^<prior_conversation>[\s\S]*User: two\n\nAssistant \(deepseek-v4\): b\n<\/prior_conversation>\n\nthree$/)
})

test('claude: starting mid-conversation carries the whole history', () => {
  const input = pendingInput([user('one'), reply('a', 'deepseek'), user('two')], P)
  assert.equal(input.resume, undefined)
  assert.match(input.prompt, /User: one[\s\S]*Assistant \(deepseek-v4\): a[\s\S]*\n\ntwo$/)
})

const reference = (text: string, label = 'IPA'): HarnessMessage => ({
  role: 'user', content: [{ type: 'text', text }], source: { kind: 'session-reference', references: [{ label }] },
})

test('claude: an @session snapshot DSH placed after the prompt goes with it', () => {
  const messages = [user('one'), reply('a', P, 's1'), user('look at @IPA'), reference('## Referenced sessions\n{"x":1}'), user('ctx', 'runtime-context')]
  assert.deepEqual(pendingInput(messages, P), { resume: 's1', prompt: 'look at @IPA\n\n## Referenced sessions\n{"x":1}' })
  // Context alone is no new input: it never starts a subscription turn.
  assert.equal(isResumedConversationRequest({ sessionId: 's', messages: [reply('a', P), reference('snapshot')] }), false)
})

const skill = (name: string): HarnessMessage => ({
  role: 'user', content: [{ type: 'text', text: `<skill_content name="${name}">body</skill_content>` }], source: { kind: 'skill-invocation', name },
})

test('claude: a skill invoked with /name goes ahead of the prompt so the external agent does not parse it as its own command', () => {
  const input = pendingInput([user('one'), reply('a', P, 's1'), user('/review PR 12'), user('also this'), skill('review'), user('ctx', 'runtime-context')], P)
  assert.deepEqual(input, {
    resume: 's1',
    prompt: '<skill_content name="review">body</skill_content>\n\n/review PR 12\n\nalso this',
    skills: ['review'],
  })
  assert.equal(skillNote('review'), '⚡ Skill /review')
  // A skill DSH injected in an earlier turn of another model is carried as context, not named again.
  const later = pendingInput([user('/review'), skill('review'), reply('b', 'deepseek'), user('now')], P)
  assert.equal(later.skills, undefined)
  assert.match(later.prompt, /User: \/review\n\n<skill_content name="review">body<\/skill_content>\n\nAssistant/)
})

test('claude: an earlier snapshot carried over from another model is not quoted as the user', () => {
  const input = pendingInput([user('see @IPA'), reference('## Referenced sessions\nbody'), reply('b', 'deepseek'), user('now')], P)
  assert.match(input.prompt, /User: see @IPA\n\n## Referenced sessions\nbody\n\nAssistant \(deepseek-v4\): b/)
})

test('claude: a snapshot too large to inline is saved and named by its path', () => {
  const big = '## Referenced sessions\n' + 'x'.repeat(REFERENCE_INLINE_MAX)
  const saved: Array<[string, readonly string[]]> = []
  const spill = { dir: '/refs', save: (text: string, labels: readonly string[]) => { saved.push([text, labels]); return '/refs/abc.md' } }
  const { prompt } = pendingInput([user('see @IPA'), reference(big)], P, 'default', spill)
  assert.deepEqual(saved, [[big, ['IPA']]])
  assert.match(prompt, /^see @IPA\n\n## Referenced sessions\n\nThe user referenced @IPA\. The snapshot \(65 KB\)[\s\S]*\/refs\/abc\.md[\s\S]*untrusted/)
  assert.ok(prompt.length < 2000)
  // A small one stays inline; a failed save keeps it inline too.
  assert.equal(pendingInput([user('a'), reference('small')], P, 'default', spill).prompt, 'a\n\nsmall')
  const failing = { dir: '/refs', save: () => { throw new Error('disk full') } }
  assert.equal(pendingInput([user('a'), reference(big)], P, 'default', failing).prompt, `a\n\n${big}`)
})

const echo = (text: string): HarnessMessage => ({ role: 'user', content: [{ type: 'text', text }], source: { ...REMOTE_ECHO } })

test('claude: Remote Control echoes since the last reply start a turn that follows them', () => {
  assert.deepEqual(remoteEchoes([user('one'), reply('a', P, 's1'), echo('from phone'), user('ctx', 'runtime-context'), echo('and more')]), ['from phone', 'and more'])
  assert.deepEqual(remoteEchoes([user('one'), reply('a', P, 's1'), user('two')]), [])
  // Someone also typed here: an ordinary turn, which never resends the echo.
  const mixed = [user('one'), reply('a', P, 's1'), echo('from phone'), user('two')]
  assert.deepEqual(remoteEchoes(mixed), [])
  assert.deepEqual(pendingInput(mixed, P), { resume: 's1', prompt: 'two' })
})

test('claude: a Remote Control prompt is read from the transcript by its uuids, never guessed', () => {
  const transcript = [
    { type: 'user', uuid: 'a', message: { role: 'user', content: 'earlier' } },
    { type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'reply' }] } },
    { type: 'user', uuid: 'c', message: { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'image' }] } },
    { type: 'user', uuid: 'd', message: { role: 'user', content: 'second' } },
  ]
  assert.equal(transcriptPrompt(transcript, new Set(['c', 'd'])), 'first\n\nsecond')
  assert.equal(transcriptPrompt(transcript, new Set(['b'])), undefined)
  assert.equal(transcriptPrompt(transcript, new Set(['missing'])), undefined)
})

test('claude: tool summaries pick the telling field and stay one short line', () => {
  assert.equal(summarizeTool('Bash', { command: 'ls\n  -la' }), 'Bash: ls -la')
  assert.equal(summarizeTool('Read', { file_path: '/a/b.ts' }), 'Read: /a/b.ts')
  assert.equal(summarizeTool('Thing', {}), 'Thing')
  assert.equal(summarizeTool('Bash', { command: 'x'.repeat(200) }).length, 'Bash: '.length + 120)
})

const event = (value: object): SDKMessage => ({ type: 'stream_event', event: value, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage
const assistant = (content: object[], id = 'm1'): SDKMessage => ({ type: 'assistant', message: { id, content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 2 } }, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage
const result = (text = 'done'): SDKResultMessage => ({ type: 'result', subtype: 'success', result: text, is_error: false, usage: { output_tokens: 42 }, session_id: 's' }) as unknown as SDKResultMessage

function settle(chunks: Chunk[]): Array<{ type: string; text: string }> {
  const blocks = new Map<number, { type: string; text: string }>()
  for (const chunk of chunks) if (chunk.type === 'block-end') blocks.set(chunk.index, chunk.block)
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block)
}

test('claude: streamed text and thinking become DSH blocks; tool calls become notes', () => {
  const t = new TurnTranslator()
  const chunks = [
    ...t.push(event({ type: 'message_start', message: { id: 'm1' } })),
    ...t.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })),
    ...t.push(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })),
    ...t.push(event({ type: 'content_block_stop', index: 0 })),
    ...t.push(event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })),
    ...t.push(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } })),
    ...t.push(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } })),
    ...t.push(event({ type: 'content_block_stop', index: 1 })),
    // The full message repeats streamed content: only its tool call is new.
    ...t.push(assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }])),
    ...t.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom\nmore' }] }, parent_tool_use_id: null, session_id: 's' } as unknown as SDKMessage),
    ...t.finish(result(), 's'),
  ]
  assert.deepEqual(settle(chunks), [
    { type: 'reasoning', text: 'hmm' },
    { type: 'text', text: 'Hello' },
    { type: 'reasoning', text: '→ Bash: ls' },
    { type: 'reasoning', text: '✗ Bash: boom' },
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 42, cacheReadTokens: 100, cacheWriteTokens: 2, totalTokens: 154 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' }, replayState: { claude: { session: 's' } } })
})

test('claude: unstreamed messages and subagent traffic', () => {
  const t = new TurnTranslator()
  // Subagent text is a note, never the turn's visible answer.
  const inner = t.push({ ...assistant([{ type: 'text', text: 'inner' }], 'm0'), parent_tool_use_id: 'x' } as SDKMessage)
  const chunks = [...t.push(assistant([{ type: 'text', text: 'whole' }], 'm2')), ...t.finish(result('whole'), 's')]
  // Visible text already came from the message, so the result text is not repeated.
  assert.deepEqual(settle([...inner, ...chunks]), [{ type: 'reasoning', text: '↳ [subagent] inner' }, { type: 'text', text: 'whole' }])
})

test('claude: background tasks become notes; a turn waiting on them counts every result\'s output', () => {
  const t = new TurnTranslator()
  const system = (value: object): SDKMessage => ({ type: 'system', session_id: 's', ...value }) as unknown as SDKMessage
  const chunks = [
    ...t.push(system({ subtype: 'task_started', task_id: 't1', description: 'scan repo', is_backgrounded: true })),
    ...t.push(system({ subtype: 'task_started', task_id: 't2', description: 'inline', is_backgrounded: false })),
    ...t.push(system({ subtype: 'task_started', task_id: 't3', description: 'watch', is_backgrounded: true, ambient: true })),
    ...t.push(system({ subtype: 'task_progress', task_id: 't1', description: 'scan repo', usage: {}, summary: 'reading src' })),
    ...t.push(system({ subtype: 'task_progress', task_id: 't1', description: 'scan repo', usage: {}, summary: 'reading src' })),
    ...t.push(system({ subtype: 'task_progress', task_id: 't1', description: 'scan repo', usage: {} })),
    ...t.push(system({ subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '', summary: 'found 3' })),
    ...t.push(system({ subtype: 'task_notification', task_id: 't4', status: 'failed', output_file: '', summary: 'crashed' })),
  ]
  assert.deepEqual(settle(chunks).map((block) => block.text), [
    '⇢ Background: scan repo',
    '… scan repo: reading src',
    '✓ Background completed: found 3',
    '✗ Background failed: crashed',
  ])
  t.carry(result())
  const usage = t.finish(result(), 's').find((chunk) => chunk.type === 'usage') as { usage: { outputTokens: number } }
  assert.equal(usage.usage.outputTokens, 84)
})

test('claude: a subagent\'s text, thinking, tool calls and failures become notes under its description', () => {
  const t = new TurnTranslator()
  const sub = (content: object[], type: 'assistant' | 'user' = 'assistant'): SDKMessage => ({ type, message: { role: type, content }, parent_tool_use_id: 'agent1', session_id: 's' }) as unknown as SDKMessage
  const chunks = [
    ...t.push(assistant([{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'Map providers', prompt: 'look' } }])),
    ...t.push(sub([{ type: 'thinking', thinking: 'where first?' }, { type: 'text', text: 'Checking llm/' }, { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'provider' } }])),
    ...t.push(sub([{ type: 'tool_result', tool_use_id: 'g1', is_error: true, content: 'bad regex' }], 'user')),
    ...t.push({ ...event({ type: 'message_start', message: { id: 'sub-stream' } }), parent_tool_use_id: 'agent1' } as SDKMessage),
  ]
  assert.deepEqual(settle(chunks).map((block) => block.text), [
    '→ Agent: Map providers',
    '↳ [Map providers] thinking: where first?',
    '↳ [Map providers] Checking llm/',
    '↳ [Map providers] → Grep: provider',
    '↳ [Map providers] ✗ Grep: bad regex',
  ])
})

test('claude: long-running tools and tasks get heartbeat notes at 1, 2, 5, 10, 20, 30 minutes, then every 30', () => {
  const t = new TurnTranslator()
  const progress = (seconds: number, parent: string | null = null): SDKMessage => ({ type: 'tool_progress', tool_use_id: 'b1', tool_name: 'Bash', parent_tool_use_id: parent, elapsed_time_seconds: seconds, session_id: 's' }) as unknown as SDKMessage
  const chunks = [
    ...t.push(assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pytest -q' } }])),
    ...[30, 61, 90, 125, 300, 599, 600, 1200, 1800, 3500, 3600, 5400].flatMap((seconds) => t.push(progress(seconds))),
    ...t.push({ type: 'system', subtype: 'task_progress', task_id: 'bg', description: 'full suite', usage: { duration_ms: 125_000 }, session_id: 's' } as unknown as SDKMessage),
  ]
  assert.deepEqual(settle(chunks).map((block) => block.text), [
    '→ Bash: pytest -q',
    ...['1m', '2m', '5m', '10m', '20m', '30m', '1h', '1h30m'].map((mark) => `⏳ Bash: pytest -q · ${mark}`),
    '⏳ full suite · 2m',
  ])
})

test('claude: API retries, compaction, unstreamed thinking, usage limits and CLI warnings become notes', () => {
  const t = new TurnTranslator()
  const system = (value: object): SDKMessage => ({ type: 'system', session_id: 's', ...value }) as unknown as SDKMessage
  const thinking = (tokens: number): SDKMessage => system({ subtype: 'thinking_tokens', estimated_tokens: tokens, estimated_tokens_delta: 0 })
  const limit = (info: object): SDKMessage => ({ type: 'rate_limit_event', rate_limit_info: info, session_id: 's' }) as unknown as SDKMessage
  const chunks = [
    ...t.push(system({ subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 30_000, error_status: 529, error: 'overloaded' })),
    ...t.push(system({ subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: null, error: 'unknown', no_response: { waited_ms: 90_000, retry_wait_ms: 90_000 } })),
    ...t.push(system({ subtype: 'status', status: 'compacting' })),
    ...t.push(system({ subtype: 'status', status: 'compacting' })),
    ...t.push(system({ subtype: 'status', status: null, compact_result: 'success' })),
    ...t.push(system({ subtype: 'status', status: 'requesting' })),
    ...t.push(event({ type: 'message_start', message: { id: 'm1' } })),
    ...[1_000, 5_200, 7_000, 12_000, 25_000, 39_000, 41_000].flatMap((tokens) => t.push(thinking(tokens))),
    // A new block counts from zero again.
    ...t.push(thinking(6_000)),
    ...t.push(limit({ status: 'allowed_warning', rateLimitType: 'five_hour', surpassedThreshold: 0.9 })),
    ...t.push(limit({ status: 'allowed_warning', rateLimitType: 'five_hour', surpassedThreshold: 0.9 })),
    ...t.push(limit({ status: 'rejected', rateLimitType: 'seven_day' })),
    ...t.push(limit({ status: 'allowed' })),
    ...t.push(system({ subtype: 'informational', level: 'warning', content: 'Stop hook blocked continuation ' })),
    ...t.push(system({ subtype: 'informational', level: 'info', content: 'quiet' })),
  ]
  assert.deepEqual(settle(chunks).map((block) => block.text), [
    '⟳ API retry 2/10 · 529 overloaded · next in 30s',
    '⟳ API retry 1/1 · no response after 2m · next in 0s',
    '⇣ Compacting context…',
    '✓ Context compacted',
    '💭 Thinking · ~5k tokens',
    '💭 Thinking · ~10k tokens',
    '💭 Thinking · ~20k tokens',
    '💭 Thinking · ~40k tokens',
    '💭 Thinking · ~5k tokens',
    '⚠ Approaching usage limit (five hour) · 90% used',
    '✗ Usage limit reached (seven day)',
    '⚠ Stop hook blocked continuation',
  ])
})

test('claude: thinking-token notes stay out while thinking text streams', () => {
  const t = new TurnTranslator()
  const chunks = [
    ...t.push(event({ type: 'message_start', message: { id: 'm1' } })),
    ...t.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })),
    ...t.push(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })),
    ...t.push({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 8_000, estimated_tokens_delta: 0, session_id: 's' } as unknown as SDKMessage),
    ...t.push(event({ type: 'content_block_stop', index: 0 })),
  ]
  assert.deepEqual(settle(chunks).map((block) => block.text), ['hmm'])
})

test('claude: a turn with no visible text falls back to the result text', () => {
  const t = new TurnTranslator()
  assert.deepEqual(settle(t.finish(result('only result'), 's')), [{ type: 'text', text: 'only result' }])
})

test('claude: a thinking block with no text (redacted) leaves no empty block', () => {
  const t = new TurnTranslator()
  const chunks = [
    ...t.push(event({ type: 'message_start', message: { id: 'm1' } })),
    ...t.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })),
    ...t.push(event({ type: 'content_block_stop', index: 0 })),
    ...t.push(event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })),
    ...t.push(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'OK' } })),
    ...t.push(event({ type: 'content_block_stop', index: 1 })),
  ]
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-start'), [{ type: 'block-start', index: 0, blockType: 'text' }])
  assert.deepEqual(settle(chunks), [{ type: 'text', text: 'OK' }])
})
