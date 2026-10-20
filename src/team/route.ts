/**
 * The bot route (`agent-hub-bot`). Each bot is one of its models, so picking
 * `Bots › reviewer` in a model selector is how you chat with a bot, DSH keeps
 * that choice per session, and a teammate that is a bot runs on it too.
 *
 * A call to a bot is a call to the bot's own model (or the default model),
 * made through that model's adapter with the bot applied:
 *
 * - Persona and tools, for DSH models: the bot's persona takes the deployment
 *   persona's place in the system prompt and its tool list narrows the tool
 *   schemas (`shapeAssembly`, on DSH's `system-prompt/assemble` waterfall).
 * - Persona, for Claude Agent: Claude Code never reads DSH's system prompt,
 *   so the persona travels with the request and is appended to Claude Code's.
 *
 * Replay state (Claude Code's session id, a model's reasoning) is kept per
 * underlying route: the bot's reply records which route produced it, and a
 * later call hands it back only to that route.
 */

import { LlmAdapter, LlmError, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { nearestEffort } from '../efforts.ts'
import { personaText, type AgentProfile } from './profiles.ts'
import { BOT_ROUTE, TEAM_TOOLS, botReplay, type BotReplay } from './types.ts'

/** Routes that run turns in an external agent (claude/adapter.ts, cursor/adapter.ts): they take the persona as a request field. */
const PERSONA_ROUTES: readonly string[] = ['claude-agent', 'cursor-agent']
/** The section the bot's persona replaces (`@deepseek-ai/dsh-system-prompt`'s PERSONA_PREFIX_SECTION). */
export const PERSONA_SECTION = 'deployment:persona-prefix'

export interface Route {
  provider: string
  model: string
}

/** Exact model metadata as dsh-llm's adapters return it. */
interface ModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  [key: string]: unknown
}

interface Chunk {
  type: string
  replayState?: unknown
  [key: string]: unknown
}

interface Message {
  role: string
  source?: { provider?: string; model?: string; replayState?: unknown; [key: string]: unknown }
  [key: string]: unknown
}

export interface Request {
  provider: string
  model: string
  messages: readonly Message[]
  signal?: AbortSignal
  [key: string]: unknown
}

/** The slice of an LlmAdapter the bot route calls. */
interface Inner {
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo>
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: ModelInfo; stream(options: Request): AsyncIterable<Chunk> }>
}

export interface BotHost {
  profiles(): AgentProfile[]
  /** The adapter serving a route (dsh-llm's `registration(provider).adapter`); throws when none does. */
  adapter(provider: string): Inner
  /** The model new agents get: a bot without a model of its own runs on it. */
  defaultRoute(): Route | undefined
}

/** A bot reply's replay state, shared with the token ledger. */
type Wrapped = BotReplay

interface Target {
  bot: AgentProfile
  route: Route
  adapter: Inner
}

export class BotAdapter extends LlmAdapter {
  private host: BotHost

  constructor(host: BotHost) {
    super()
    this.host = host
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Bots' }
  }

  override async listModels(provider: string) {
    return this.host.profiles().map((bot) => ({ provider, id: bot.id, name: bot.id, ...describe(bot) }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const target = this.target(model)
    return relabel(await target.adapter.resolveModel(target.route.provider, target.route.model, signal), provider, target.bot)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const target = this.target(model)
    const call = await target.adapter.prepareCall(target.route.provider, target.route.model, signal)
    const info = relabel(call.model, provider, target.bot)
    // A call that names no effort runs at the bot's, which the model's own default does not know about.
    const effort = target.bot.effort ? (info.reasoning as Reasoning | undefined)?.defaultEffort : undefined
    return {
      model: info,
      stream: (options: Request) => relay(innerRequest(options, target.route, personaText(target.bot), effort), target.route, (inner) => call.stream(inner)),
    }
  }

  async *stream(options: Request): AsyncGenerator<Chunk> {
    const call = await this.prepareCall(options.provider, options.model, options.signal)
    yield* call.stream(options)
  }

  private target(id: string): Target {
    const bot = this.host.profiles().find((profile) => profile.id === id)
    if (bot === undefined) throw new LlmError(`There is no bot named "${id}"`, 'MODEL_NOT_FOUND')
    const route = bot.provider && bot.model ? { provider: bot.provider, model: bot.model } : this.host.defaultRoute()
    if (route === undefined || route.provider === BOT_ROUTE) throw new LlmError(`Bot "${id}" has no model: pick one in Settings → Agent Hub → Bots`, 'MODEL_NOT_FOUND')
    let adapter: Inner
    try {
      adapter = this.host.adapter(route.provider)
    } catch (cause) {
      throw new LlmError(`Bot "${id}" runs on ${route.provider}/${route.model}, which is not available`, 'NO_ADAPTER', { cause })
    }
    return { bot, route, adapter }
  }
}

function describe(bot: AgentProfile): { description?: string } {
  const description = bot.description?.trim()
  return description ? { description } : {}
}

interface Reasoning {
  efforts: ReadonlyArray<{ id: string }>
  defaultEffort?: string
}

/**
 * The underlying model's metadata (context window, efforts, modalities) under
 * the bot's name, starting at the bot's effort when it sets one the model can
 * meet: model selectors put a picked model at its default effort.
 */
function relabel(info: ModelInfo, provider: string, bot: AgentProfile): ModelInfo {
  const { description: _ignored, ...rest } = info
  const reasoning = info.reasoning as Reasoning | undefined
  const effort = bot.effort && reasoning !== undefined && Array.isArray(reasoning.efforts)
    ? nearestEffort(bot.effort, reasoning.efforts.map((entry) => entry.id))
    : undefined
  return { ...rest, ...(effort === undefined ? {} : { reasoning: { ...reasoning, defaultEffort: effort } }), provider, id: bot.id, name: bot.id, ...describe(bot) }
}

/** Tag the reply's replay state with the route that produced it. */
async function* relay(inner: Request, route: Route, dispatch: (inner: Request) => AsyncIterable<Chunk>): AsyncGenerator<Chunk> {
  for await (const chunk of dispatch(inner)) {
    yield chunk.type === 'finish' ? { ...chunk, replayState: { via: route, state: chunk.replayState } satisfies Wrapped } : chunk
  }
}

/**
 * The request as the bot's model takes it: its own route, the bot's earlier
 * replies carrying their replay state only when that model produced them, and
 * for Claude Agent and Cursor the persona, and the bot's effort when the call
 * names none. Those answer only conversation turns, which they recognize by
 * the agent loop's mark on the exact request object.
 */
export function innerRequest(options: Request, route: Route, persona: string, effort?: string): Request {
  const messages = options.messages.map((message) => unwrap(message, route))
  const inner: Request = {
    ...options,
    provider: route.provider,
    model: route.model,
    messages,
    ...(PERSONA_ROUTES.includes(route.provider) ? { persona } : {}),
    ...(effort !== undefined && options.reasoningEffort === undefined ? { reasoningEffort: effort } : {}),
  }
  if (isAgentLoopRequest(options)) markAgentLoopRequest(inner)
  return inner
}

function unwrap(message: Message, route: Route): Message {
  if (message.role !== 'assistant' || message.source?.provider !== BOT_ROUTE) return message
  const { replayState, ...source } = message.source
  const wrapped = botReplay(replayState)
  if (wrapped?.via?.provider !== route.provider || wrapped.via.model === undefined) return { ...message, source }
  return { ...message, source: { ...source, provider: wrapped.via.provider, model: wrapped.via.model, replayState: wrapped.state } }
}

/** A system prompt assembly (`@deepseek-ai/dsh-system-prompt`), as far as the bot route touches it. */
export interface Assembly {
  sections: ReadonlyArray<{ name: string; text: string; interpolate?: boolean }>
  tools: ReadonlyArray<{ name: string }>
  variables?: Record<string, unknown>
  [key: string]: unknown
}

/** The bot an assembly is for: the agent's selected model when it is a bot. */
export function assemblyBot(assembly: Assembly, context: { agent?: { options?: { provider?: string; model?: string } } }, profiles: readonly AgentProfile[]): AgentProfile | undefined {
  const variables = assembly.variables ?? {}
  const selected = typeof variables.provider === 'string' && typeof variables.model === 'string'
  const provider = selected ? variables.provider : context.agent?.options?.provider
  const model = selected ? variables.model : context.agent?.options?.model
  return provider === BOT_ROUTE ? profiles.find((profile) => profile.id === model) : undefined
}

/**
 * The bot's persona in the deployment persona's place, and only its tools.
 * The team tools stay: a bot in a group answers through send_message.
 */
export function shapeAssembly<T extends Assembly>(assembly: T, bot: AgentProfile): T {
  const persona = { name: PERSONA_SECTION, text: personaText(bot), interpolate: false }
  const at = assembly.sections.findIndex((section) => section.name === PERSONA_SECTION)
  const sections = at < 0 ? [persona, ...assembly.sections] : assembly.sections.map((section, index) => (index === at ? persona : section))
  const allow = new Set((bot.tools ?? []).map((name) => name.trim()).filter(Boolean))
  const tools = allow.size === 0 ? assembly.tools : assembly.tools.filter((tool) => allow.has(tool.name) || TEAM_TOOLS.includes(tool.name))
  return { ...assembly, sections, tools }
}
