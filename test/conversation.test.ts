import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

/** A stand-in for one Claude Code process: the test plays its frames. */
interface FakeSession {
  frames: { push(frame: object): void; end(): void }
  sent: Array<{ uuid: string }>
  canUseTool: (toolName: string, input: object, context: object) => Promise<unknown>
  interrupts: number
  closes: number
  remoteConnections: number
  env?: Record<string, string | undefined>
  /** What the process was started with. */
  options: Record<string, unknown>
}

let session: FakeSession
let transcript: object[] = []
/** The options the latest Claude Code process was started with. */
let started: Record<string, unknown> = {}

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: ({ prompt, options }: { prompt: AsyncIterable<{ uuid: string }>; options: { canUseTool: FakeSession['canUseTool']; env?: Record<string, string | undefined> } }) => {
      started = options
      const frames = new Channel<object>()
      const current: FakeSession = { frames, sent: [], canUseTool: options.canUseTool, interrupts: 0, closes: 0, remoteConnections: 0, env: options.env, options }
      session = current
      void (async () => { for await (const message of prompt) current.sent.push(message) })()
      return {
        [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
        interrupt: async () => { current.interrupts++ },
        close: () => { current.closes++; frames.end() },
        setModel: async () => {},
        enableRemoteControl: async () => { current.remoteConnections++; return {} },
      }
    },
    getSessionMessages: async () => transcript,
    createSdkMcpServer: () => { throw new Error('Unexpected MCP bridge in this test') },
    tool: () => { throw new Error('Unexpected MCP tool in this test') },
  },
})

const cli = await import('../src/claude/cli.ts')
mock.module('../src/claude/cli.ts', { namedExports: { ...cli, findClaudeExecutable: () => 'claude' } })

const { Channel, Conversation } = await import('../src/claude/conversation.ts')
const { ClaudeAgentAdapter } = await import('../src/claude/adapter.ts')
import type { AdapterHost, AdapterSettings, StreamOptions } from '../src/claude/adapter.ts'
import type { HarnessMessage } from '../src/claude/translate.ts'
const { REMOTE_ECHO } = await import('../src/claude/translate.ts')

const tick = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const stream = (owner?: string): object => ({ type: 'stream_event', event: { type: 'message_start' }, session_id: 's', ...(owner === undefined ? {} : { user_message_uuid: owner }) })
const assistant = (): object => ({ type: 'assistant', message: { content: [] }, session_id: 's' })
const result = (): object => ({ type: 'result', subtype: 'success', session_id: 's' })

async function collect(turn: AsyncGenerator<{ type: string }>): Promise<string[]> {
  const types: string[] = []
  for await (const message of turn) types.push(message.type)
  return types
}

function open(approve: (agent: unknown) => void = () => {}): InstanceType<typeof Conversation> {
  transcript = []
  return new Conversation({
    executable: 'claude', cwd: '/w', model: 'opus', remoteControl: false, log: () => {},
    approve: async (agent) => { approve(agent); return { behavior: 'allow' } },
  })
}

/** Run one DSH turn to its end, so the conversation knows its DSH agent. */
async function answer(conversation: InstanceType<typeof Conversation>, agent: unknown): Promise<string[]> {
  const turn = collect(conversation.run('hi', agent, undefined))
  await tick()
  session.frames.push(stream(session.sent.at(-1)!.uuid))
  session.frames.push(assistant())
  session.frames.push(result())
  return turn
}

test('conversation: account-specific SDK process receives only its configuration directory', () => {
  const conversation = new Conversation({ executable: 'claude', cwd: '/w', model: 'opus', account: 'work', configDir: '/work/claude', remoteControl: false,
    log: () => {}, approve: async () => ({ behavior: 'allow' }) })
  assert.equal(session.env?.CLAUDE_CONFIG_DIR, '/work/claude')
  assert.equal(session.env?.ANTHROPIC_API_KEY, undefined)
  conversation.close()
})

test('conversation: a bot persona is appended to Claude Code\'s prompt, never snapshotted; none leaves the default', () => {
  const bot = new Conversation({
    executable: 'claude', cwd: '/w', model: 'opus', persona: 'You are "coder".', remoteControl: false, log: () => {},
    approve: async () => ({ behavior: 'allow' }),
  })
  assert.equal(bot.persona, 'You are "coder".')
  assert.deepEqual(session.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'You are "coder".', snapshot: false })
  bot.close()
  open().close()
  assert.equal(session.options.systemPrompt, undefined)
})

test('conversation: a DSH turn takes its frames, including those naming no user message', async () => {
  const conversation = open()
  assert.deepEqual(await answer(conversation, {}), ['stream_event', 'assistant', 'result'])
  assert.equal(conversation.busy, false)
  conversation.close()
})

test('conversation: a Remote Control turn is echoed to DSH and the DSH turn it starts follows it', async () => {
  const conversation = open()
  const followups: object[] = []
  const agent = { followup: (message: object) => followups.push(message) }
  await answer(conversation, agent)

  transcript = [{ type: 'user', uuid: 'r1', message: { role: 'user', content: 'from phone' } }]
  session.frames.push(stream('r1'))
  session.frames.push(assistant())
  await tick()
  assert.deepEqual(followups, [{ role: 'user', content: [{ type: 'text', text: 'from phone' }], source: REMOTE_ECHO }])

  // Frames buffer until DSH follows, even past the result.
  session.frames.push(result())
  await tick()
  assert.deepEqual(await collect(conversation.adopt(['from phone'], agent, undefined)), ['stream_event', 'assistant', 'result'])
  assert.deepEqual(conversation.takeNotices(), [])
  conversation.close()
})

test('conversation: a Remote Control turn whose prompt never reaches the transcript is only counted', async () => {
  const conversation = open()
  const followups: object[] = []
  await answer(conversation, { followup: (message: object) => followups.push(message) })
  session.frames.push(stream('r2'))
  session.frames.push(result())
  await tick()
  assert.deepEqual(followups, [])
  assert.match(conversation.takeNotices()[0] ?? '', /^1 turn\(s\) ran from Remote Control/)
  await assert.rejects(collect(conversation.adopt(['anything'], {}, undefined)), /no longer running/)
  conversation.close()
})

test('conversation: late frames of a turn DSH stopped reading are dropped, not taken for a remote turn', async () => {
  const conversation = open()
  const followups: object[] = []
  const controller = new AbortController()
  const turn = conversation.run('hi', { followup: (message: object) => followups.push(message) }, controller.signal)
  const first = turn.next()
  await tick()
  session.frames.push(stream(session.sent[0].uuid))
  await first
  controller.abort()
  await turn.return(undefined)
  assert.equal(session.interrupts, 1)

  session.frames.push(assistant())
  session.frames.push(result())
  await tick()
  assert.deepEqual(followups, [])
  assert.deepEqual(conversation.takeNotices(), [])
  // The next DSH turn reads only its own frames.
  assert.deepEqual(await answer(conversation, {}), ['stream_event', 'assistant', 'result'])
  conversation.close()
})

const tasks = (...ids: string[]): object => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: task_id })), session_id: 's' })
const notified = (summary: string): object => ({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '', summary, session_id: 's' })

test('conversation: a DSH turn stays open while its background tasks run and shows Claude Code answering them', async () => {
  const conversation = open()
  const followups: object[] = []
  const turn = collect(conversation.run('hi', { followup: (message: object) => followups.push(message) }, undefined))
  await tick()
  session.frames.push(stream(session.sent[0].uuid))
  session.frames.push(tasks('t1'))
  session.frames.push(result())
  await tick()
  assert.equal(conversation.busy, true)

  // Its progress and end reach the waiting turn; the turn Claude Code then starts names no user message.
  session.frames.push({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'scan', usage: {}, summary: 'reading', session_id: 's' })
  session.frames.push(tasks())
  session.frames.push(notified('found it'))
  session.frames.push(stream())
  session.frames.push(assistant())
  session.frames.push(result())
  assert.deepEqual(await turn, ['stream_event', 'system', 'result', 'system', 'system', 'system', 'stream_event', 'assistant', 'result'])
  assert.equal(conversation.busy, false)
  assert.deepEqual(followups, [])
  conversation.close()
})

test('conversation: background tasks answered after DSH stopped waiting are echoed with their summaries', async () => {
  const conversation = open()
  const followups: object[] = []
  const agent = { followup: (message: object) => followups.push(message) }
  const controller = new AbortController()
  const turn = collect(conversation.run('hi', agent, controller.signal))
  await tick()
  session.frames.push(stream(session.sent[0].uuid))
  session.frames.push(tasks('t1'))
  session.frames.push(result())
  await tick()
  controller.abort()
  assert.deepEqual(await turn, ['stream_event', 'system', 'result'])
  assert.equal(conversation.busy, false)

  session.frames.push(tasks())
  session.frames.push(notified('found it'))
  session.frames.push(stream())
  session.frames.push(assistant())
  await tick()
  assert.deepEqual(followups, [{ role: 'user', content: [{ type: 'text', text: 'Background task finished: found it' }], source: REMOTE_ECHO }])
  session.frames.push(result())
  await tick()
  assert.deepEqual(await collect(conversation.adopt(['Background task finished: found it'], agent, undefined)), ['stream_event', 'assistant', 'result'])
  conversation.close()
})

test('conversation: the turn DSH reads gets the running time of background tasks', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const conversation = open()
    const turn = conversation.run('hi', {}, undefined)
    const read: Array<{ type: string; subtype?: string; task_id?: string; usage?: { duration_ms: number } }> = []
    const reading = (async () => { for await (const message of turn) read.push(message as typeof read[number]) })()
    await tick()
    session.frames.push(stream(session.sent[0].uuid))
    session.frames.push(tasks('t1'))
    await tick()
    mock.timers.tick(20_000)
    await tick()
    assert.deepEqual(read.filter((message) => message.subtype === 'task_progress').map((message) => [message.task_id, message.usage?.duration_ms]), [['t1', 20_000]])
    session.frames.push(tasks())
    session.frames.push(result())
    await reading
    conversation.close()
  } finally { mock.timers.reset() }
})

test('conversation: a subagent still talking after its turn ended opens no turn', async () => {
  const conversation = open()
  const followups: object[] = []
  await answer(conversation, { followup: (message: object) => followups.push(message) })
  session.frames.push({ ...assistant(), parent_tool_use_id: 'agent1' })
  await tick()
  assert.equal(conversation.busy, false)
  assert.deepEqual(followups, [])
  assert.deepEqual(conversation.takeNotices(), [])
  conversation.close()
})

test('conversation: approvals go to the DSH agent reading the running turn, else wait for the remote device', async () => {
  const asked: unknown[] = []
  const conversation = open((agent) => asked.push(agent))
  const agent = { followup: () => {} }
  const turn = collect(conversation.run('hi', agent, undefined))
  await tick()
  session.frames.push(stream(session.sent[0].uuid))
  await tick()
  await session.canUseTool('Bash', {}, { signal: new AbortController().signal })
  assert.deepEqual(asked, [agent])
  session.frames.push(result())
  await turn

  // A remote turn nobody in DSH follows yet: answered on the device, which cancels the local request.
  transcript = []
  session.frames.push(stream('r3'))
  await tick()
  const controller = new AbortController()
  const pending = session.canUseTool('Bash', {}, { signal: controller.signal })
  controller.abort()
  assert.deepEqual(await pending, { behavior: 'deny', message: 'Answered elsewhere' })
  assert.equal(asked.length, 1)
  conversation.close()
})

test('conversation: bridged DSH tools run without a Claude Code approval', async () => {
  transcript = []
  const asked: string[] = []
  const conversation = new Conversation({
    executable: 'claude', cwd: '/w', model: 'opus', remoteControl: false, log: () => {}, trusted: ['mcp__dsh__'],
    approve: async (_agent, toolName) => { asked.push(toolName); return { behavior: 'allow' } },
  })
  const signal = new AbortController().signal
  assert.deepEqual(await session.canUseTool('mcp__dsh__send_message', { target: 'lead' }, { signal }), { behavior: 'allow', updatedInput: { target: 'lead' } })
  assert.deepEqual(asked, [])
  conversation.close()
})

test('conversation: full access starts Claude Code in bypass mode, otherwise it asks', () => {
  transcript = []
  const approve = async () => ({ behavior: 'allow' as const })
  const base = { executable: 'claude', cwd: '/w', model: 'opus', remoteControl: false, log: () => {}, approve }
  const normal = new Conversation(base)
  assert.equal(normal.fullAccess, false)
  normal.close()
  assert.equal(started.permissionMode, undefined)
  assert.equal(started.allowDangerouslySkipPermissions, undefined)
  const bypass = new Conversation({ ...base, fullAccess: true })
  assert.equal(bypass.fullAccess, true)
  bypass.close()
  assert.equal(started.permissionMode, 'bypassPermissions')
  assert.equal(started.allowDangerouslySkipPermissions, true)
})

test('conversation: blocked Bash commands are denied by a PreToolUse hook that reads the rules live', async () => {
  transcript = []
  let rules = ['root']
  const conversation = new Conversation({
    executable: 'claude', cwd: '/w', model: 'opus', remoteControl: false, log: () => {}, fullAccess: true,
    approve: async () => ({ behavior: 'allow' }),
    blocked: (command) => (rules.length > 0 && command === 'find / -name x' ? 'Blocked: find /' : undefined),
  })
  const [matcher] = (started.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<(input: object) => Promise<object>> }> }).PreToolUse
  assert.equal(matcher!.matcher, 'Bash|PowerShell')
  const call = (command: string) => matcher!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
  assert.deepEqual(await call('find / -name x'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked: find /' } })
  assert.deepEqual(await call('find . -name x'), {})
  rules = []
  assert.deepEqual(await call('find / -name x'), {})
  conversation.close()
  open().close()
  assert.equal(started.hooks, undefined)
})

test('conversation: a session that refuses writes also hooks the file tools', async () => {
  transcript = []
  const conversation = new Conversation({
    executable: 'claude', cwd: '/w', model: 'opus', remoteControl: false, log: () => {}, fullAccess: true,
    approve: async () => ({ behavior: 'allow' }),
    blocked: () => undefined,
    refused: (tool, input) => (tool === 'Edit' && input.file_path === '/w/src/a.ts' ? 'Blocked: read-only' : undefined),
  })
  const [matcher] = (started.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<(input: object) => Promise<object>> }> }).PreToolUse
  assert.equal(matcher!.matcher, 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit')
  const call = (tool: string, input: object) => matcher!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input })
  assert.deepEqual(await call('Edit', { file_path: '/w/src/a.ts' }), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked: read-only' } })
  assert.deepEqual(await call('Edit', { file_path: '/w/.reviews/pr-1.md' }), {})
  assert.deepEqual(await call('Bash', { command: 'ls' }), {})
  conversation.close()
})

function adapterFixture() {
  transcript = []
  const settings: AdapterSettings = { fullAccess: true, remoteControl: false, keepOnline: 0, idleHours: 24, models: [] }
  const agent = { session: { header: { cwd: '/w' } }, followup: (_message: object) => {} }
  const accounts = { ready: Promise.resolve(), selected: 'default', dir: (account: string) => account === 'default' ? undefined : '/work/claude' }
  const host = { accounts, agents: () => ({ currentInitiator: () => agent }), approval: () => undefined, log: () => {} } as unknown as AdapterHost
  const adapter = new ClaudeAgentAdapter(host, () => settings)
  const user = (text: string): HarnessMessage => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const options = (messages = [user('hi')]): StreamOptions => ({ provider: 'claude-agent', model: 'opus', sessionId: 'dsh', messages })
  const reply = (account = 'default'): HarnessMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'claude-agent', replayState: { claude: { session: 's', ...(account === 'default' ? {} : { account }) } } } })
  const collect = async (options_: StreamOptions) => { const chunks: object[] = []; for await (const chunk of adapter.stream(options_)) chunks.push(chunk); return chunks }
  const answer = async (options_ = options()) => {
    const turn = collect(options_)
    await tick()
    session.frames.push({ ...result(), result: 'done', is_error: false, usage: { output_tokens: 1 } })
    await turn
  }
  return { adapter, settings, agent, accounts, user, reply, options, collect, answer }
}

test('adapter: disabling full access leaves an active turn intact, then closes and resumes without bypass', async () => {
  const f = adapterFixture()
  try {
    const turn = f.collect(f.options())
    await tick()
    const original = session
    assert.equal(original.options.permissionMode, 'bypassPermissions')
    f.settings.fullAccess = false
    await assert.rejects(f.collect(f.options([f.user('overlapping turn')])), /already answering/)
    assert.equal(original.closes, 0)
    assert.equal(original.interrupts, 0)
    original.frames.push({ ...result(), result: 'done', is_error: false, usage: { output_tokens: 1 } })
    await turn
    await f.answer(f.options([f.user('hi'), f.reply(), f.user('next')]))
    assert.notEqual(session, original)
    assert.equal(original.closes, 1)
    assert.equal(original.interrupts, 0)
    assert.equal(session.options.resume, 's')
    assert.equal(session.options.forkSession, undefined)
    assert.equal(session.options.permissionMode, undefined)
    assert.equal(session.options.allowDangerouslySkipPermissions, undefined)
    const normal = session
    await f.answer()
    assert.equal(session, normal)
    f.settings.fullAccess = true
    await f.answer()
    assert.equal(session, normal, 'enabling must not upgrade an existing normal process')
    assert.equal(normal.closes, 0)
    assert.equal(session.options.permissionMode, undefined)
  } finally { f.adapter.dispose() }
})

test('adapter: cwd identity resumes in the new directory but normalized equivalents reuse the process', async () => {
  const f = adapterFixture()
  try {
    await f.answer()
    const original = session
    f.agent.session.header.cwd = '/w/./'
    await f.answer()
    assert.equal(session, original)
    f.agent.session.header.cwd = '/other'
    await f.answer()
    assert.equal(original.closes, 1)
    assert.equal(session.options.cwd, '/other')
    assert.equal(session.options.resume, 's')
  } finally { f.adapter.dispose() }
})

test('adapter: account changes never interrupt an active turn or resume another account session', async () => {
  const f = adapterFixture()
  try {
    const turn = f.collect(f.options())
    await tick()
    const original = session
    f.accounts.selected = 'work'
    f.settings.fullAccess = false
    await assert.rejects(f.collect(f.options()), /already answering/)
    assert.equal(original.closes, 0)
    assert.equal(original.interrupts, 0)
    original.frames.push({ ...result(), result: 'done', is_error: false, usage: { output_tokens: 1 } })
    await turn
    await f.answer(f.options([f.user('hi'), f.reply(), f.user('next')]))
    assert.equal(original.closes, 1)
    assert.equal(session.options.resume, undefined)
    assert.equal(session.env?.CLAUDE_CONFIG_DIR, '/work/claude')
  } finally { f.adapter.dispose() }
})

test('adapter: Remote Control settings only affect new processes; adoption survives pending permission/account/cwd changes', async () => {
  const f = adapterFixture()
  try {
    await f.answer()
    const original = session
    f.settings.remoteControl = true
    await f.answer()
    assert.equal(session, original)
    assert.equal(original.remoteConnections, 0)
    transcript = [{ type: 'user', uuid: 'remote', message: { role: 'user', content: 'phone' } }]
    original.frames.push(stream('remote'))
    original.frames.push(assistant())
    await tick()
    f.settings.fullAccess = false
    f.accounts.selected = 'work'
    f.agent.session.header.cwd = '/other'
    const echo: HarnessMessage = { role: 'user', content: [{ type: 'text', text: 'phone' }], source: { ...REMOTE_ECHO } }
    const adopted = f.collect(f.options([f.user('hi'), f.reply(), echo]))
    await tick()
    assert.equal(session, original)
    assert.equal(original.closes, 0)
    assert.equal(original.interrupts, 0)
    assert.equal(original.sent.length, 2)
    original.frames.push({ ...result(), result: 'done', is_error: false, usage: { output_tokens: 1 } })
    await adopted
    await f.answer(f.options([f.user('hi'), f.reply(), f.user('next')]))
    assert.equal(original.closes, 1)
    assert.equal(session.remoteConnections, 1)
    assert.equal(session.options.permissionMode, undefined)
  } finally { f.adapter.dispose() }
})

test('conversation: a turn the host closes names who closed it, in its error and the trace', async () => {
  transcript = []
  const traced: Array<[string, Record<string, unknown>]> = []
  const conversation = new Conversation({
    executable: 'claude', cwd: '/w', model: 'opus', remoteControl: false, log: () => {},
    approve: async () => ({ behavior: 'allow' }), trace: (event, fields) => traced.push([event, fields]),
  })
  const turn = collect(conversation.run('hi', {}, undefined))
  await tick()
  session.frames.push(stream(session.sent[0].uuid))
  await tick()
  conversation.close('dispose')
  await assert.rejects(turn, /mid-turn \(closed: dispose; last frame stream_event\)/)
  assert.deepEqual(traced.map(([event, fields]) => [event, fields.by]), [['end', 'closed: dispose'], ['mid-turn', 'closed: dispose']])
})
