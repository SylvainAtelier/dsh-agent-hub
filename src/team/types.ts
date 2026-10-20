/** Team module wire types, shared by the host and the browser. */

export const TEAM_METHOD = 'agent-hub/team'

/** The model route whose models are the bots (team/route.ts): picking one in a model selector chats with that bot. */
export const BOT_ROUTE = 'agent-hub-bot'

/** Replay state is owned by the underlying model, not the bot's display route. */
export interface BotReplay {
  via: { provider: string; model: string }
  state: unknown
}

export function botReplay(value: unknown): BotReplay | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Partial<BotReplay>
  return raw.via !== null && typeof raw.via === 'object' && typeof raw.via.provider === 'string'
    && typeof raw.via.model === 'string' ? raw as BotReplay : undefined
}

/** The team tools (`@deepseek-ai/dsh-experimental-tool-agent-team`). */
export const TEAM_TOOLS: readonly string[] = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
]

export type TeamRequest =
  /** Whether this profile runs DSH's Agent Teams runtime. */
  | { op: 'status' }
  /** Who `@` can address in a session: its team (empty for a session with none, or not live) and the bots. */
  | { op: 'members'; sessionId: string }

/** One roster row as `ctx.agentTeams.listMembers` reports it. */
export interface Member {
  id: string
  name: string
  role: 'lead' | 'teammate'
  status: string
  description?: string
  context?: string
  model?: string
}

/** The answer to `members`. A bot with no live member in the team is invited when `@` names it. */
export interface Roster {
  /** Whether `@` routes anything here: a team Lead (or a session not loaded yet) where Agent Teams runs. */
  addressable: boolean
  members: Member[]
  bots: Array<{ id: string; description?: string }>
}
