import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { applyProfile, personaText, profileFor, rosterText, validProfiles, type AgentProfile } from '../src/team/profiles.ts'
import { mentioned, TEAM_NOTE } from '../src/team/mentions.ts'
import { standardSchema, teamBridge, zodShape, type ToolRegistry } from '../src/claude/bridge.ts'
import { pendingInput } from '../src/claude/translate.ts'
import { createTeam, type Agent } from '../src/team/index.ts'

const profiles: AgentProfile[] = [
  { id: 'review', description: 'generic' },
  { id: 'reviewer', description: 'reads diffs', provider: 'minimax-cn', model: 'MiniMax-M3', persona: 'You are strict.', tools: ['read', 'grep', 'nope'] },
  { id: 'claude', provider: 'claude-agent', model: 'opus', persona: 'You write code.', tools: ['bash'] },
]

test('profiles: a teammate takes the longest profile its name names', () => {
  assert.equal(profileFor('reviewer', profiles)?.id, 'reviewer')
  assert.equal(profileFor('reviewer-2', profiles)?.id, 'reviewer')
  assert.equal(profileFor('review-x', profiles)?.id, 'review')
  assert.equal(profileFor('reviewers', profiles), undefined)
  assert.equal(profileFor('coder', profiles), undefined)
  assert.deepEqual(validProfiles([{ id: 'ok' }, { id: 'Bad Id' }, { id: 'ok' }, null, { id: 'two-2' }]).map((p) => p.id), ['ok', 'two-2'])
  assert.match(rosterText(profiles), /- reviewer \[minimax-cn\/MiniMax-M3\]: reads diffs/)
})

test('profiles: a teammate that is a bot runs on the bot route; the persona names the bot', () => {
  const prompt = [{ type: 'text', text: 'task' }]
  const teammate = applyProfile({ prompt, parent: {} }, profiles[1]!)
  assert.deepEqual(teammate.agentOptions, { provider: 'agent-hub-bot', model: 'reviewer' })
  assert.equal(teammate.prompt, prompt)
  assert.equal(personaText(profiles[1]!), 'You are "reviewer": reads diffs.\n\nYou are strict.')
  assert.equal(personaText({ id: 'x' }), 'You are "x".')
})

test('mentions: roster names only, after whitespace, CJK punctuation, and @all', () => {
  const roster = ['reviewer', 'coder', 'coder-2']
  assert.deepEqual(mentioned('@reviewer 看一下 @coder-2', roster), ['reviewer', 'coder-2'])
  assert.deepEqual(mentioned('@reviewer，帮我看看', roster), ['reviewer'])
  assert.deepEqual(mentioned('@Reviewer请看', roster), ['reviewer'])
  assert.deepEqual(mentioned('mail me at a@reviewer.com', roster), [])
  assert.deepEqual(mentioned('@nobody hi', roster), [])
  assert.deepEqual(mentioned('@all 同步一下', roster), roster)
  assert.deepEqual(mentioned('@全员 同步', roster), roster)
  // Bots are named only explicitly: @all addresses members, not every bot there is.
  assert.deepEqual(mentioned('@all and @coder', ['coder', 'tester'], []), ['coder'])
})

/** A live agent with a scoped context that records what was registered on it. */
function fakeAgent(id: string): Agent & { sections: Map<string, string>; preStep?: Parameters<Agent['ctx']['on']>[1] } {
  const agent = {
    id,
    sections: new Map<string, string>(),
    preStep: undefined as Parameters<Agent['ctx']['on']>[1] | undefined,
    ctx: {
      on(_event: 'agent/pre-step', listener: Parameters<Agent['ctx']['on']>[1]) {
        agent.preStep = listener
        return () => { agent.preStep = undefined }
      },
      systemPrompt: {
        section(section: { name: string; text: string }) {
          agent.sections.set(section.name, section.text)
          return () => { agent.sections.delete(section.name) }
        },
        getSectionOrder: () => 100,
      },
    },
  }
  return agent
}

test('team: teammates start with their profile, Leads see the profiles and route @mentions', async () => {
  const lead = fakeAgent('lead-session')
  const roster = [
    { id: 'lead-session', name: 'lead', role: 'lead' as const, status: 'running' },
    { id: 'c1', name: 'reviewer-2', role: 'teammate' as const, status: 'provisioning', context: 'fresh' },
    { id: 'c2', name: 'forked', role: 'teammate' as const, status: 'inactive', context: 'fork' },
  ]
  const sent: Array<{ target: string; text: string }> = []
  const started: unknown[] = []
  class Runtime {
    async startContinuable(spec: unknown): Promise<unknown> {
      started.push(spec)
      return { childId: 'x' }
    }
  }
  const runtime = new Runtime()
  const listeners = new Map<string, (agent: Agent) => void>()
  let current = profiles
  const team = createTeam({
    agents: { list: () => [lead], get: (id) => (id === lead.id ? lead : undefined) },
    teams: {
      tryMembership: (agent) => (agent === lead ? { role: 'lead' } : { role: 'teammate' }),
      listMembers: () => roster,
      async sendMessage(_agent, request) { sent.push({ target: request.target, text: request.content[0]!.text }) },
      async spawnTeammate() { throw new Error('not in this test') },
    },
    subagents: runtime,
    onAgent: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    profiles: () => current,
    note: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: TEAM_NOTE }),
    log: () => {},
  })

  // The team runtime calls through the instance; the profile lands in the request.
  await runtime.startContinuable({ childId: 'c1', provider: 'spawn', request: { prompt: [], parent: lead } })
  await runtime.startContinuable({ childId: 'c2', provider: 'fork', request: { prompt: [], parent: lead } })
  await runtime.startContinuable({ childId: 'zz', provider: 'spawn', request: { prompt: [], parent: lead } })
  const [withProfile, forked, unknown] = started as Array<{ request: { agentOptions?: unknown } }>
  assert.deepEqual(withProfile!.request.agentOptions, { provider: 'agent-hub-bot', model: 'reviewer' })
  assert.equal(forked!.request.agentOptions, undefined)
  assert.equal(unknown!.request.agentOptions, undefined)

  assert.match(lead.sections.get('agent-hub:team-profiles')!, /reviewer/)
  current = []
  team.refresh()
  assert.equal(lead.sections.size, 0)

  const enter = { kind: 'enter' as const, messages: ['claimed'] }
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const signal = new AbortController().signal
  const plain = await lead.preStep!({ messages: [user('hello')], signal }, async () => enter)
  assert.equal(plain, enter)
  // Mid-turn (step 2) the Lead runs anyway, and is told the member already has the message.
  const routed = await lead.preStep!({ messages: [user('@reviewer-2 请复查')], step: 2, signal }, async () => enter) as unknown as { messages: Array<{ role?: string; source?: unknown }> }
  assert.deepEqual(sent.map((m) => m.target), ['reviewer-2'])
  assert.match(sent[0]!.text, /请复查/)
  assert.equal(routed.messages.length, 2)
  assert.deepEqual(routed.messages[1]!.source, TEAM_NOTE)
  // A teammate's own messages are never routed.
  await lead.preStep!({ messages: [{ role: 'user', content: [{ type: 'text', text: '@reviewer-2 x' }], source: { kind: 'team-message' } }], signal }, async () => enter)
  assert.equal(sent.length, 1)

  team.dispose()
  assert.equal(Object.hasOwn(runtime, 'startContinuable'), false)
  assert.equal(lead.preStep, undefined)
})

test('team: since DSH 0.2.1 teammates start through startActivation, which gets the profile', async () => {
  const lead = fakeAgent('lead-session')
  const started: Array<{ request: { agentOptions?: unknown } }> = []
  class Runtime {
    async startActivation(spec: { request: { agentOptions?: unknown } }): Promise<unknown> {
      started.push(spec)
      return { childId: 'x' }
    }
  }
  const runtime = new Runtime()
  const team = createTeam({
    agents: { list: () => [lead], get: (id) => (id === lead.id ? lead : undefined) },
    teams: {
      tryMembership: (agent) => (agent === lead ? { role: 'lead' } : { role: 'teammate' }),
      listMembers: () => [{ id: 'c1', name: 'reviewer-2', role: 'teammate', status: 'provisioning', context: 'fresh' }],
      async sendMessage() {},
      async spawnTeammate() {},
    },
    subagents: runtime,
    onAgent: () => () => {},
    profiles: () => profiles,
    note: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: TEAM_NOTE }),
    log: () => {},
  })
  await runtime.startActivation({ childId: 'c1', provider: 'spawn', delivery: 'parent', request: { prompt: [], parent: lead } } as never)
  assert.deepEqual(started[0]!.request.agentOptions, { provider: 'agent-hub-bot', model: 'reviewer' })
  assert.equal(Object.hasOwn(runtime, 'startContinuable'), false)
  team.dispose()
  assert.equal(Object.hasOwn(runtime, 'startActivation'), false)
})

test('bridge: the real team tools convert to valid object schemas with the same fields', () => {
  // Captured from @deepseek-ai/dsh-experimental-tool-agent-team as its registry serves them.
  const tools = JSON.parse(readFileSync(new URL('./fixtures/team-tools.json', import.meta.url), 'utf8')) as Array<{ name: string; parameters: { properties: Record<string, unknown>; required?: string[] } }>
  assert.equal(tools.length, 9)
  for (const tool of tools) {
    const json = z.toJSONSchema(z.object(zodShape(tool.parameters))) as { type: string; properties: Record<string, unknown>; required?: string[] }
    assert.equal(json.type, 'object', tool.name)
    assert.deepEqual(Object.keys(json.properties).sort(), Object.keys(tool.parameters.properties).sort(), tool.name)
    assert.deepEqual([...(json.required ?? [])].sort(), [...(tool.parameters.required ?? [])].sort(), tool.name)
  }
})

test('bridge: DSH tool schemas become zod shapes and calls run as the session agent', async () => {
  const parameters = {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'who' },
      when: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['a', 'b'] },
      owners: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', properties: { x: { type: 'string', required: true } } },
    },
    required: ['target'],
  }
  assert.deepEqual(standardSchema({ type: 'object', properties: { x: { type: 'string', required: true }, y: { type: 'number' } } }),
    { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } }, required: ['x'] })
  const shape = z.object(zodShape(parameters))
  assert.ok(shape.safeParse({ target: 'lead', status: 'a', owners: ['x'], nested: { x: 'y' } }).success)
  assert.ok(!shape.safeParse({ status: 'a' }).success)
  assert.ok(!shape.safeParse({ target: 'lead', status: 'c' }).success)

  const calls: unknown[] = []
  const registry: ToolRegistry = {
    schemas: () => [
      { name: 'send_message', description: 'send', parameters },
      { name: 'bash', description: 'shell', parameters: {} },
    ],
    async execute(exec) {
      calls.push(exec)
      return { isError: false, content: [{ type: 'text', text: '{"ok":true}' }] }
    },
  }
  assert.equal(teamBridge(registry, () => undefined), undefined)
  assert.equal(teamBridge({ ...registry, schemas: () => [] }, () => 'agent'), undefined)
  const server = teamBridge(registry, () => 'the-agent')!
  assert.equal(server.name, 'dsh')
  const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: (args: object, extra: object) => Promise<unknown> }> })._registeredTools
  assert.deepEqual(Object.keys(tools), ['send_message'])
  const result = await tools.send_message!.handler({ target: 'lead' }, { signal: new AbortController().signal })
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"ok":true}' }] })
  assert.equal((calls[0] as { agent: unknown; name: string }).agent, 'the-agent')
})

test('claude: team messages and the @mention note reach Claude Code', () => {
  const { prompt } = pendingInput([
    { role: 'user', content: [{ type: 'text', text: 'build it' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: 'from reviewer: done' }], source: { kind: 'team-message' } },
    { role: 'user', content: [{ type: 'text', text: 'note' }], source: TEAM_NOTE },
    { role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } },
  ], 'claude-agent')
  assert.equal(prompt, 'build it\n\nfrom reviewer: done\n\nnote')
})
