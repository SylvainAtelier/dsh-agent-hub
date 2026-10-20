import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { assemblyBot, BotAdapter, shapeAssembly, type Request } from '../src/team/route.ts'
import { createTeam, quietReply, type Agent, type Teams } from '../src/team/index.ts'
import { digest, groupLines, relayText, TEAM_NOTE } from '../src/team/mentions.ts'
import type { AgentProfile } from '../src/team/profiles.ts'
import type { Member } from '../src/team/types.ts'
import { mentionRows } from '../src/client/team/mentions.ts'

const bots: AgentProfile[] = [
  { id: 'reviewer', description: 'reads diffs', provider: 'deepseek', model: 'v4', persona: 'Be strict.', tools: ['read'] },
  { id: 'coder', provider: 'claude-agent', model: 'opus' },
  { id: 'plain' },
]

/** An inner adapter that records what it was asked and replies with replay state. */
function innerAdapter(calls: Request[]) {
  return {
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: `${model} name`, description: 'inner', context: { contextWindow: 1000 } }
    },
    async prepareCall(provider: string, model: string) {
      return {
        model: await this.resolveModel(provider, model),
        async *stream(options: Request) {
          calls.push(options)
          yield { type: 'usage', usage: {} }
          yield { type: 'finish', reason: { kind: 'stop' }, replayState: { session: `${provider}-state` } }
        },
      }
    },
  }
}

async function collect(stream: AsyncIterable<object>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of stream) out.push(chunk as Record<string, unknown>)
  return out
}

test('bot route: lists the bots and runs each on its own model, under its own name', async () => {
  const calls: Request[] = []
  let fallback: { provider: string; model: string } | undefined = { provider: 'deepseek', model: 'flash' }
  const route = new BotAdapter({ profiles: () => bots, adapter: () => innerAdapter(calls), defaultRoute: () => fallback })
  assert.deepEqual(await route.listModels('agent-hub-bot'), [
    { provider: 'agent-hub-bot', id: 'reviewer', name: 'reviewer', description: 'reads diffs' },
    { provider: 'agent-hub-bot', id: 'coder', name: 'coder' },
    { provider: 'agent-hub-bot', id: 'plain', name: 'plain' },
  ])

  // The underlying model's capabilities, the bot's identity.
  const call = await route.prepareCall('agent-hub-bot', 'reviewer')
  assert.deepEqual(call.model, { provider: 'agent-hub-bot', id: 'reviewer', name: 'reviewer', description: 'reads diffs', context: { contextWindow: 1000 } })

  const history = [
    { role: 'user', content: [] },
    // An earlier reply from this bot on the same route: its replay state goes back to that route.
    { role: 'assistant', content: [], source: { kind: 'model', provider: 'agent-hub-bot', model: 'reviewer', replayState: { via: { provider: 'deepseek', model: 'v4' }, state: 'mine' } } },
    // One from a bot on another route: plain history.
    { role: 'assistant', content: [], source: { kind: 'model', provider: 'agent-hub-bot', model: 'coder', replayState: { via: { provider: 'claude-agent', model: 'opus' }, state: 'theirs' } } },
  ]
  const request = markAgentLoopRequest({ provider: 'agent-hub-bot', model: 'reviewer', messages: history }) as Request
  const chunks = await collect(call.stream(request))
  const inner = calls[0]!
  assert.equal(inner.provider, 'deepseek')
  assert.equal(inner.model, 'v4')
  assert.ok(isAgentLoopRequest(inner))
  assert.equal(inner.persona, undefined)
  assert.deepEqual(inner.messages[1]!.source, { kind: 'model', provider: 'deepseek', model: 'v4', replayState: 'mine' })
  assert.deepEqual(inner.messages[2]!.source, { kind: 'model', provider: 'agent-hub-bot', model: 'coder' })
  assert.deepEqual(chunks.at(-1)!.replayState, { via: { provider: 'deepseek', model: 'v4' }, state: { session: 'deepseek-state' } })

  // Claude Code never reads DSH's system prompt: the persona travels with the request.
  await collect((await route.prepareCall('agent-hub-bot', 'coder')).stream({ provider: 'agent-hub-bot', model: 'coder', messages: [] }))
  assert.equal(calls[1]!.persona, 'You are "coder".')
  assert.ok(!isAgentLoopRequest(calls[1]!))

  // No model of its own: the default model; a default that is a bot, or no bot at all, is an error.
  await collect((await route.prepareCall('agent-hub-bot', 'plain')).stream({ provider: 'agent-hub-bot', model: 'plain', messages: [] }))
  assert.equal(calls[2]!.model, 'flash')
  fallback = { provider: 'agent-hub-bot', model: 'reviewer' }
  await assert.rejects(route.prepareCall('agent-hub-bot', 'plain'), /no model/)
  await assert.rejects(route.prepareCall('agent-hub-bot', 'ghost'), /no bot named/)
})

test('bot route: a bot\'s effort is where its model starts and what a call naming none runs at', async () => {
  const calls: Request[] = []
  const reasoning = { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' }
  const inner = {
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning }
    },
    async prepareCall(provider: string, model: string) {
      return {
        model: await this.resolveModel(provider, model),
        async *stream(options: Request) {
          calls.push(options)
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const profiles: AgentProfile[] = [
    { id: 'thinker', provider: 'deepseek', model: 'v4', effort: 'xhigh' },
    { id: 'plain', provider: 'deepseek', model: 'v4' },
  ]
  const route = new BotAdapter({ profiles: () => profiles, adapter: () => inner, defaultRoute: () => undefined })

  // xhigh is not one of the model's levels: the nearest lower one.
  assert.deepEqual((await route.resolveModel('agent-hub-bot', 'thinker')).reasoning, { ...reasoning, defaultEffort: 'high' })
  profiles[0]!.effort = 'low'
  const call = await route.prepareCall('agent-hub-bot', 'thinker')
  assert.equal((call.model.reasoning as typeof reasoning).defaultEffort, 'low')
  await collect(call.stream({ provider: 'agent-hub-bot', model: 'thinker', messages: [] }))
  assert.equal(calls[0]!.reasoningEffort, 'low')
  // A level picked in the selector wins.
  await collect(call.stream({ provider: 'agent-hub-bot', model: 'thinker', messages: [], reasoningEffort: 'max' }))
  assert.equal(calls[1]!.reasoningEffort, 'max')

  // No effort of its own: the model's, untouched.
  const plain = await route.prepareCall('agent-hub-bot', 'plain')
  assert.deepEqual(plain.model.reasoning, reasoning)
  await collect(plain.stream({ provider: 'agent-hub-bot', model: 'plain', messages: [] }))
  assert.equal(calls[2]!.reasoningEffort, undefined)
})

test('bot route: the persona replaces the deployment persona and the tools narrow, team tools kept', () => {
  const assembly = {
    sections: [{ name: 'identity', text: 'harness' }, { name: 'deployment:persona-prefix', text: 'You are {{model}}' }, { name: 'guide', text: 'g' }],
    tools: [{ name: 'read' }, { name: 'bash' }, { name: 'send_message' }],
    variables: { provider: 'agent-hub-bot', model: 'reviewer' },
  }
  const bot = assemblyBot(assembly, {}, bots)!
  assert.equal(bot.id, 'reviewer')
  const shaped = shapeAssembly(assembly, bot)
  assert.deepEqual(shaped.sections[1], { name: 'deployment:persona-prefix', text: 'You are "reviewer": reads diffs.\n\nBe strict.', interpolate: false })
  assert.deepEqual(shaped.tools.map((tool) => tool.name), ['read', 'send_message'])
  // A teammate started on the bot route, before any selection: its agent options say so.
  assert.equal(assemblyBot({ ...assembly, variables: {} }, { agent: { options: { provider: 'agent-hub-bot', model: 'coder' } } }, bots)?.id, 'coder')
  assert.equal(assemblyBot({ ...assembly, variables: { provider: 'deepseek', model: 'v4' } }, {}, bots), undefined)
  // Without the section, the persona leads; without a tool list, every tool stays.
  const bare = shapeAssembly({ sections: [{ name: 'guide', text: 'g' }], tools: [{ name: 'bash' }] }, bots[2]!)
  assert.equal(bare.sections[0]!.name, 'deployment:persona-prefix')
  assert.deepEqual(bare.tools, [{ name: 'bash' }])
})

test('group chat lines: what the user and the Lead said, and relayed replies; digests skip the reader', () => {
  const events = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi all' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `→ @coder\n\n${relayText('reviewer', 'LGTM')}\n\n${relayText('coder', 'done')}` }] } } },
  ]
  assert.deepEqual(groupLines(events), [
    { from: 'user', text: 'hi all' },
    { from: 'lead', text: 'hello' },
    { from: 'reviewer', text: 'LGTM' },
    { from: 'coder', text: 'done' },
  ])
  assert.equal(digest(groupLines(events), 'coder'), 'user: hi all\n\nlead: hello\n\nreviewer: LGTM')
  assert.equal(digest(groupLines(events), 'coder', 1), 'reviewer: LGTM')
  assert.equal(digest([{ from: 'user', text: 'x'.repeat(50) }], 'coder', Infinity, 20), `user: ${'x'.repeat(13)}…`)
})

/** A Lead whose session log and pre-step listener the test drives. */
function fakeLead(events: unknown[]): Agent & { preStep?: Parameters<Agent['ctx']['on']>[1] } {
  const agent = {
    id: 'lead-session',
    preStep: undefined as Parameters<Agent['ctx']['on']>[1] | undefined,
    session: { snapshotEvents: () => events },
    ctx: {
      on(_event: 'agent/pre-step', listener: Parameters<Agent['ctx']['on']>[1]) {
        agent.preStep = listener
        return () => { agent.preStep = undefined }
      },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    },
  }
  return agent
}

test('group chat: @bot joins with what it missed, the host stays quiet, replies are relayed', async () => {
  const events: unknown[] = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'we need a login page' }], source: { kind: 'user' } } },
  ]
  const lead = fakeLead(events)
  const roster: Member[] = [
    { id: 'lead-session', name: 'lead', role: 'lead', status: 'running' },
    { id: 'r1', name: 'reviewer', role: 'teammate', status: 'failed' },
    { id: 'r2', name: 'reviewer-2', role: 'teammate', status: 'inactive' },
  ]
  const sent: Array<{ target: string; text: string }> = []
  const spawned: Array<{ name: string; description: string; prompt: Array<{ text: string }> }> = []
  const teams: Teams = {
    tryMembership: (agent) => ({ role: agent === lead ? 'lead' : 'teammate' }),
    listMembers: () => roster,
    async sendMessage(_agent, request) { sent.push({ target: request.target, text: request.content[0]!.text }) },
    async spawnTeammate(_agent, request) {
      spawned.push(request)
      roster.push({ id: 'c1', name: request.name, role: 'teammate', status: 'provisioning' })
    },
  }
  const team = createTeam({
    agents: { list: () => [lead], get: (id) => (id === lead.id ? lead : undefined) },
    teams,
    subagents: { async startContinuable() { return undefined } },
    onAgent: () => () => {},
    profiles: () => bots,
    note: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: TEAM_NOTE }),
    log: () => {},
  })
  const signal = new AbortController().signal
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const reply = (from: string, id: string, text: string) => ({
    role: 'user',
    content: [{ type: 'text', text: `Team message ${id} from ${from}:` }, { type: 'text', text }],
    source: { kind: 'team-message', senderName: from, messageId: id },
  })
  const step = async (messages: ReturnType<typeof user>[], n = 1) => lead.preStep!({ messages, step: n, signal }, async () => ({ kind: 'enter', messages }))

  // The composer offers the members and the bots that are not in yet.
  assert.deepEqual(team.roster('lead-session').bots.map((bot) => bot.id), ['reviewer', 'coder', 'plain'])
  assert.deepEqual(team.roster('nobody'), { addressable: true, members: [], bots: team.roster('lead-session').bots })

  // @coder is not in the team: it joins, with the request and what was said before.
  const first = user('@coder 先做个草稿')
  const decision = await step([first])
  assert.deepEqual(decision, { kind: 'enter', messages: [first] })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0]!.name, 'coder')
  assert.match(spawned[0]!.prompt[0]!.text, /You are teammate "coder"/)
  assert.match(spawned[0]!.prompt[1]!.text, /user: we need a login page[\s\S]*先做个草稿/)
  // …and the host's turn makes no model call: it says where the message went, once.
  assert.equal(team.takeQuiet('lead-session'), '→ @coder')
  assert.equal(team.takeQuiet('lead-session'), undefined)

  // @reviewer reaches the bot's live member, reviewer-2.
  await step([user('@reviewer 帮忙看看')])
  assert.deepEqual(sent.map((m) => m.target), ['reviewer-2'])
  assert.equal(team.takeQuiet('lead-session'), '→ @reviewer-2')

  // A member's reply to the user is relayed verbatim; its message keeps only a stub.
  const answer = reply('coder', 'm1', '草稿好了')
  const relayed = await step([answer]) as unknown as { messages: Array<{ content: Array<{ text: string }> }> }
  assert.equal(team.takeQuiet('lead-session'), '**@coder**\n\n草稿好了')
  assert.match(relayed.messages[0]!.content[0]!.text, /coder replied to the user/)
  // Since DSH 0.2.1 a member's message is an agent-message relay that names the sender's session.
  const relay = { id: 'm9', role: 'user', content: [{ type: 'text', text: 'Team message from coder:' }, { type: 'text', text: '新版' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'c1' } }
  const relayedNew = await step([relay as unknown as ReturnType<typeof user>]) as unknown as { messages: Array<{ content: Array<{ text: string }> }> }
  assert.equal(team.takeQuiet('lead-session'), '**@coder**\n\n新版')
  assert.match(relayedNew.messages[0]!.content[0]!.text, /coder replied to the user/)

  // The runtime then says coder's turn is over: nothing for the host to do, so no step at all.
  const settled = (summary: string) => ({ role: 'user', content: [{ type: 'text', text: summary }], source: { kind: 'subagent-settled', senderSessionId: 'c1', summary } })
  assert.deepEqual(await step([settled('Background subagent c1 finished and will do no further work unless you send it more.')]), { kind: 'enter', messages: [] })
  assert.equal(team.takeQuiet('lead-session'), undefined)
  // Alongside a reply it is dropped and the reply relayed; a failure still wakes the host.
  const both = await step([reply('coder', 'm0', 'ok'), settled('Background subagent c1 finished and will do no further work unless you send it more.')]) as unknown as { messages: unknown[] }
  assert.equal(both.messages.length, 1)
  assert.equal(team.takeQuiet('lead-session'), '**@coder**\n\nok')
  const failed = settled('Background subagent c1 failed before it finished.')
  assert.deepEqual(await step([failed]), { kind: 'enter', messages: [failed] })
  assert.equal(team.takeQuiet('lead-session'), undefined)

  // The relay is in the log now: the next delivery to reviewer-2 catches it up on it.
  events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '**@coder**\n\n草稿好了' }] } } })
  await step([user('@reviewer-2 再看一遍')])
  assert.match(sent[1]!.text, /<group-chat>[\s\S]*coder: 草稿好了[\s\S]*<\/group-chat>/)
  assert.doesNotMatch(sent[1]!.text, /login page/)
  team.takeQuiet('lead-session')

  // Talking to the host again: it answers, and the members' later replies wake it as usual.
  assert.deepEqual(await step([user('总结一下')]), { kind: 'enter', messages: [user('总结一下')] })
  assert.equal(team.takeQuiet('lead-session'), undefined)
  await step([reply('coder', 'm2', 'more')])
  assert.equal(team.takeQuiet('lead-session'), undefined)

  // A message that arrives mid-turn is delivered, and the busy host is told so.
  const busy = await step([user('@coder 顺便加测试')], 2) as unknown as { messages: Array<{ source?: unknown }> }
  assert.deepEqual(busy.messages.at(-1)!.source, TEAM_NOTE)
  assert.equal(team.takeQuiet('lead-session'), undefined)
  team.dispose()
})

test('group chat: failed delivery does not advance the catch-up cursor', async () => {
  const events = [{ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'IMPORTANT_HISTORY' }], source: { kind: 'user' } } }]
  const lead = fakeLead(events)
  const sent: string[] = []
  const team = createTeam({
    agents: { list: () => [lead], get: () => lead },
    teams: {
      tryMembership: () => ({ role: 'lead' }),
      listMembers: () => [{ id: 'r', name: 'reviewer', role: 'teammate', status: 'inactive' }],
      async sendMessage(_agent, request) {
        sent.push(request.content[0]!.text)
        if (sent.length === 1) throw new Error('temporary failure')
      },
      async spawnTeammate() { throw new Error('unexpected invitation') },
    },
    subagents: { async startContinuable() { return undefined } },
    onAgent: () => () => {}, profiles: () => bots,
    note: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: TEAM_NOTE }), log: () => {},
  })
  const message = { role: 'user', content: [{ type: 'text', text: '@reviewer retry' }], source: { kind: 'user' } }
  const step = () => lead.preStep!({ messages: [message], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
  try {
    await step()
    await step()
    await step()
    assert.match(sent[0]!, /IMPORTANT_HISTORY/)
    assert.match(sent[1]!, /IMPORTANT_HISTORY/)
    assert.doesNotMatch(sent[2]!, /IMPORTANT_HISTORY/)
  } finally { team.dispose() }
})

test('group chat: the quiet reply is a plain, finished text reply', async () => {
  const chunks = await collect(quietReply('→ @coder'))
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks[2]!.block, { type: 'text', text: '→ @coder' })
})

test('composer @: members, then bots to invite; nothing where @ routes nothing', () => {
  const rows = mentionRows({
    addressable: true,
    members: [
      { id: 'a', name: 'reviewer-2', role: 'teammate', status: 'running', description: 'reads diffs' },
      { id: 'b', name: 'old', role: 'teammate', status: 'failed' },
    ],
    bots: [{ id: 'reviewer', description: 'reads diffs' }, { id: 'coder' }],
  })
  assert.deepEqual(rows.map((row) => [row.name, row.section]), [['reviewer-2', '群成员'], ['coder', '邀请入群']])
  assert.deepEqual(mentionRows({ addressable: false, members: [], bots: [{ id: 'coder' }] }), [])
})
