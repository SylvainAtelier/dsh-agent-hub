/**
 * The hub's half of Agent Teams (DSH's experimental `agentTeams` runtime, which
 * owns the roster, mailbox and task board). Every root session is a team's
 * Lead, so every session is a group chat waiting to happen:
 *
 * - Bots as teammates. DSH's team runtime starts every fresh teammate as a
 *   clone of the Lead; it does not pass start options through. The hub fills
 *   them in on the way into the subagent runtime: a teammate named after a bot
 *   runs on the bot route (team/route.ts), so model, persona and tools land in
 *   the child's durable descriptor and survive resumes.
 * - @mentions. A user message to the Lead that names members (`@reviewer`) is
 *   delivered to them through the team mailbox, with what they missed in the
 *   group since they last heard; a bot that is not in the team yet joins.
 * - A quiet host. When the user only talks to members, the Lead's turn makes no
 *   model call: it answers with where the message went (`→ @reviewer`). A
 *   member's reply to the user is relayed the same way, verbatim under the
 *   member's name, so the group reads like a chat and costs nothing extra.
 *   The Lead speaks when the user writes to it without @.
 */

import { applyProfile, profileFor, rosterText, type AgentProfile, type StartRequest } from './profiles.ts'
import { deliveredText, digest, groupLines, leadNote, mentioned, receipt, relayStub, relayText, teammateReminder } from './mentions.ts'
import type { Member, Roster } from './types.ts'

export { TEAM_METHOD } from './types.ts'

type Text = { type: 'text'; text: string }

interface Message {
  /** Every message the runtime creates has one; a member's reply is matched by it. */
  id?: string
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
  /**
   * A member's message: `agent-message` (relay form) names the sender's session; DSH before 0.2.1
   * delivered `team-message` with the sender's name. `subagent-settled` carries the child's session id and a summary line.
   */
  source?: { kind?: string; form?: string; senderName?: string; messageId?: string; senderSessionId?: string; summary?: string }
}

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: readonly unknown[]; [key: string]: unknown }

interface PreStep {
  messages: readonly Message[]
  /** 1 for the first step of a turn. */
  step?: number
  signal: AbortSignal
}

export interface Agent {
  id: string
  ctx: {
    on(event: 'agent/pre-step', listener: (event: PreStep, next: () => Promise<Decision>) => Promise<Decision>): () => void
    systemPrompt: {
      section(section: { name: string; order: number; text: string }): () => void
      getSectionOrder(key: string): number
    }
  }
  /** The session log: the group chat a member catches up on. */
  session?: { snapshotEvents?(): readonly unknown[] }
}

/** The slice of `ctx.agentTeams` the hub uses. */
export interface Teams {
  tryMembership(agent: Agent): { role: 'lead' | 'teammate' } | undefined
  listMembers(agent: Agent): Member[]
  sendMessage(agent: Agent, request: { target: string; content: Text[]; signal: AbortSignal }): Promise<unknown>
  spawnTeammate(agent: Agent, request: { name: string; description: string; prompt: Text[]; context: 'fresh'; provider: string; signal: AbortSignal }): Promise<unknown>
}

interface StartSpec {
  childId?: string
  provider: string
  request: StartRequest & { parent: Agent }
  [key: string]: unknown
}

/**
 * The slice of `ctx.subagents`: the method the team runtime creates teammates through,
 * `startActivation` since DSH 0.2.1, `startContinuable` before.
 */
export interface Subagents {
  startActivation?(spec: StartSpec): Promise<unknown>
  startContinuable?(spec: StartSpec): Promise<unknown>
}

type StartMethod = 'startActivation' | 'startContinuable'

export interface TeamHost {
  agents: { list(): Agent[]; get(id: string): Agent | undefined }
  teams: Teams
  subagents: Subagents
  /** `agent/created` / `agent/disposed` on the host context. */
  onAgent(event: 'agent/created' | 'agent/disposed', listener: (agent: Agent) => void): () => void
  profiles(): AgentProfile[]
  /** A user-role message with the `TEAM_NOTE` source (dsh-llm's `createUserMessage`); a step's batch takes only user-role messages. */
  note(text: string): unknown
  log(message: string): void
}

/** The subagent provider `spawn_teammate` starts fresh teammates with (`freshProvider` of the team tools). */
const FRESH_PROVIDER = 'spawn'
/** How much of the group a member that has not heard from it yet catches up on. */
const JOIN_LINES = 20

const ORIGINAL = Symbol.for('cordis.original')

/**
 * Route the runtime's start method through `fill`. Cordis serves the runtime behind a
 * proxy; the override goes on the instance itself, so every caller (the team
 * runtime included) sees it, and disposal restores what was there.
 */
function intercept(subagents: Subagents, fill: (spec: StartSpec) => StartSpec): () => void {
  const target = ((subagents as unknown as Record<symbol, unknown>)[ORIGINAL] ?? subagents) as Subagents
  const method: StartMethod | undefined = typeof target.startActivation === 'function' ? 'startActivation'
    : typeof target.startContinuable === 'function' ? 'startContinuable' : undefined
  if (method === undefined) return () => {}
  const own = Object.getOwnPropertyDescriptor(target, method)
  const original = target[method]!
  const wrapped = function (this: unknown, spec: StartSpec): Promise<unknown> {
    return original.call(this, fill(spec))
  }
  Object.defineProperty(target, method, { value: wrapped, configurable: true, writable: true })
  return () => {
    if (target[method] !== wrapped) return
    if (own === undefined) delete (target as unknown as Record<string, unknown>)[method]
    else Object.defineProperty(target, method, own)
  }
}

const textOf = (message: Message): string =>
  message.content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')

/** A member's message without the runtime's `Team message from name:` heading (`Team message <id> from name:` before DSH 0.2.1). */
const replyOf = (message: Message): string =>
  message.content.filter((part) => part.type === 'text' && typeof part.text === 'string' && !/^Team message (\S+ )?from /.test(part.text)).map((part) => part.text).join('\n').trim()

/**
 * The runtime's notice that a teammate's turn ended normally (`@deepseek-ai/dsh-subagent`'s
 * settlement summary). Failures and stops are not this: the Lead hears about those.
 */
const finished = (message: Message): boolean =>
  message.source?.kind === 'subagent-settled' && /finished and will do no further work/.test(message.source.summary ?? '')

/** A name no member of the team has had:`reviewer`, else `reviewer-2`, … (names are never reused). */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** A model reply made of `text` alone: what the Lead's quiet turn streams instead of calling its model. */
export async function* quietReply(text: string): AsyncGenerator<object> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Per Lead: the members the user is talking to directly, and how far into the log each one has heard. */
interface Group {
  direct: Set<string>
  heard: Map<string, number>
}

export interface Team {
  /** Who `@` can address in a session. */
  roster(sessionId: string): Roster
  /** The text the Lead's next model call answers with, if that step is quiet; taken once. */
  takeQuiet(sessionId: string): string | undefined
  /** Bots changed: Leads get the new section (on their next request). */
  refresh(): void
  dispose(): void
}

export function createTeam(host: TeamHost): Team {
  const { teams } = host

  const fill = (spec: StartSpec): StartSpec => {
    try {
      const { request } = spec
      if (spec.childId === undefined || request.agentOptions !== undefined || request.persona !== undefined) return spec
      const member = teams.listMembers(request.parent).find((row) => row.id === spec.childId)
      if (member === undefined || member.context !== 'fresh') return spec
      const profile = profileFor(member.name, host.profiles())
      if (profile === undefined) return spec
      return { ...spec, request: applyProfile(request, profile) as StartSpec['request'] }
    } catch (error) {
      host.log(`teammate bot not applied: ${(error as Error).message}`)
      return spec
    }
  }
  const restore = intercept(host.subagents, fill)

  const groups = new Map<string, Group>()
  const groupOf = (lead: Agent): Group => {
    let group = groups.get(lead.id)
    if (group === undefined) groups.set(lead.id, group = { direct: new Set(), heard: new Map() })
    return group
  }
  const quiet = new Map<string, string>()
  /** A member's name from its session id ('' when unknown). */
  const nameOf = (lead: Agent, id: string | undefined): string => {
    try {
      return teams.listMembers(lead).find((row) => row.id === id)?.name ?? ''
    } catch {
      return ''
    }
  }

  /** Per Lead: the bot section and the @mention listener. */
  const installed = new Map<Agent, Array<() => void>>()

  const install = (agent: Agent): void => {
    if (installed.has(agent) || teams.tryMembership(agent)?.role !== 'lead') return
    const disposers: Array<() => void> = []
    const profiles = host.profiles()
    if (profiles.length > 0) {
      try {
        const prompt = agent.ctx.systemPrompt
        disposers.push(prompt.section({ name: 'agent-hub:team-profiles', order: prompt.getSectionOrder('TEAM_POLICY') + 1, text: rosterText(profiles) }))
      } catch (error) {
        host.log(`bots not shown to the Lead: ${(error as Error).message}`)
      }
    }
    disposers.push(agent.ctx.on('agent/pre-step', async (event, next) => {
      quiet.delete(agent.id)
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      return converse(agent, event, decision)
    }))
    installed.set(agent, disposers)
  }

  const converse = async (lead: Agent, event: PreStep, decision: Extract<Decision, { kind: 'enter' }>): Promise<Decision> => {
    const group = groupOf(lead)
    const typed = event.messages.filter((message) => message.role === 'user' && message.source?.kind === 'user')
    const addressed = new Set<Message>()
    const delivered = new Set<string>()
    for (const message of typed) {
      const names = await address(lead, group, textOf(message), event.signal)
      if (names.length === 0) continue
      addressed.add(message)
      for (const name of names) delivered.add(name)
    }
    if (typed.length > 0) {
      // Talking only to members: their replies are for the user. Anything else, and the Lead is back in the conversation.
      if (addressed.size === typed.length) for (const name of delivered) group.direct.add(name)
      else group.direct.clear()
    }

    /** Who a member's message is from ('' for anything else). */
    const senderOf = (message: Message): string => message.source?.kind === 'team-message' ? message.source.senderName ?? ''
      : message.source?.kind === 'agent-message' && message.source.form === 'relay' ? nameOf(lead, message.source.senderSessionId) : ''
    const keyOf = (message: Message): unknown => message.source?.kind === 'team-message' ? message.source.messageId : message.id ?? message
    const replies = event.messages.filter((message) => group.direct.has(senderOf(message)))
    const settled = event.messages.filter((message) => finished(message) && group.direct.has(nameOf(lead, message.source!.senderSessionId)))
    const silent = (event.step ?? 1) === 1 && event.messages.length > 0
      && event.messages.every((message) => addressed.has(message) || replies.includes(message) || settled.includes(message))
    if (silent) {
      const parts = delivered.size > 0 ? [receipt([...delivered])] : []
      for (const reply of replies) parts.push(relayText(senderOf(reply), replyOf(reply)))
      // Only "a member the user talks to is done": nothing to say, so no step at all.
      if (parts.length === 0) return { ...decision, messages: [] }
      quiet.set(lead.id, parts.join('\n\n'))
      // The reply's text lives once, in the relay; the mailbox still sees its message recorded.
      const stubs = new Map(replies.map((reply) => [keyOf(reply), senderOf(reply)]))
      const messages = decision.messages.flatMap((message) => {
        const source = (message as Message).source
        if (source?.kind === 'subagent-settled' && settled.some((notice) => notice.source?.senderSessionId === source.senderSessionId)) return []
        const name = stubs.get(keyOf(message as Message))
        return [name === undefined ? message : { ...(message as Message), content: [{ type: 'text', text: relayStub(name) }] }]
      })
      return { ...decision, messages }
    }
    if (delivered.size === 0) return decision
    return { ...decision, messages: [...decision.messages, host.note(leadNote([...delivered]))] }
  }

  /** Deliver one user message to the members it names, inviting the bots it names that are not in the team. */
  const address = async (lead: Agent, group: Group, text: string, signal: AbortSignal): Promise<string[]> => {
    let roster: Member[]
    try {
      roster = teams.listMembers(lead)
    } catch {
      return []
    }
    const members = roster.filter((row) => row.role === 'teammate' && row.status !== 'failed').map((row) => row.name)
    const bots = host.profiles()
    const targets = new Set(mentioned(text, members))
    const invite: AgentProfile[] = []
    for (const id of mentioned(text, bots.map((bot) => bot.id).filter((id) => !members.includes(id)), [])) {
      // The bot's newest live member answers for it; without one, it joins.
      const live = members.findLast((name) => profileFor(name, bots)?.id === id)
      if (live !== undefined) targets.add(live)
      else invite.push(bots.find((bot) => bot.id === id)!)
    }
    if (targets.size === 0 && invite.length === 0) return []

    const events = (() => {
      try {
        return lead.session?.snapshotEvents?.() ?? []
      } catch {
        return []
      }
    })()
    const missed = (name: string): string => {
      const since = group.heard.get(name)
      return since === undefined ? digest(groupLines(events), name, JOIN_LINES) : digest(groupLines(events.slice(since)), name)
    }

    const delivered: string[] = []
    for (const name of targets) {
      try {
        await teams.sendMessage(lead, { target: name, content: [{ type: 'text', text: deliveredText(text, missed(name)) }], signal })
        group.heard.set(name, events.length)
        delivered.push(name)
      } catch (error) {
        host.log(`@${name} not delivered: ${(error as Error).message}`)
      }
    }
    const taken = new Set(roster.map((row) => row.name))
    for (const bot of invite) {
      const name = freeName(bot.id, taken)
      taken.add(name)
      try {
        await teams.spawnTeammate(lead, {
          name,
          description: (bot.description?.trim() || bot.id).slice(0, 200),
          prompt: [{ type: 'text', text: teammateReminder(name) }, { type: 'text', text: deliveredText(text, missed(name)) }],
          context: 'fresh',
          provider: FRESH_PROVIDER,
          signal,
        })
        group.heard.set(name, events.length)
        delivered.push(name)
      } catch (error) {
        host.log(`@${bot.id} could not join: ${(error as Error).message}`)
      }
    }
    return delivered
  }

  const uninstall = (agent: Agent): void => {
    for (const dispose of installed.get(agent)?.reverse() ?? []) dispose()
    installed.delete(agent)
    groups.delete(agent.id)
    quiet.delete(agent.id)
  }

  for (const agent of host.agents.list()) install(agent)
  const offCreated = host.onAgent('agent/created', install)
  const offDisposed = host.onAgent('agent/disposed', uninstall)

  return {
    roster(sessionId) {
      const bots = host.profiles().map((bot) => ({ id: bot.id, ...(bot.description?.trim() ? { description: bot.description.trim() } : {}) }))
      const agent = host.agents.get(sessionId)
      // A session not loaded yet is addressed once it runs; only a Lead routes @mentions.
      if (agent === undefined) return { addressable: true, members: [], bots }
      if (teams.tryMembership(agent)?.role !== 'lead') return { addressable: false, members: [], bots: [] }
      return { addressable: true, members: teams.listMembers(agent), bots }
    },
    takeQuiet(sessionId) {
      const text = quiet.get(sessionId)
      quiet.delete(sessionId)
      return text
    },
    refresh() {
      for (const agent of [...installed.keys()]) {
        for (const dispose of installed.get(agent)?.reverse() ?? []) dispose()
        installed.delete(agent)
      }
      for (const agent of host.agents.list()) install(agent)
    },
    dispose() {
      offCreated()
      offDisposed()
      for (const agent of [...installed.keys()]) uninstall(agent)
      restore()
    },
  }
}
