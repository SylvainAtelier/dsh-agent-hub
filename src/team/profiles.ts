/**
 * Bots: named agent profiles. A bot is nothing but the knobs DSH already has —
 * a model route, a persona and a tool filter — under a name, and the name is
 * its handle everywhere: `@reviewer` in a composer, the teammate `reviewer`
 * (or `reviewer-2`) in a team, the model `Bots › reviewer` in a model
 * selector. All three run the bot the same way: on the bot route
 * (team/route.ts), which applies its persona and tools and calls its model.
 */

import { BOT_ROUTE } from './types.ts'

/** Lower-kebab-case, the shape DSH requires of teammate names. */
export const PROFILE_ID = /^[a-z][a-z0-9-]{0,31}$/

export interface AgentProfile {
  id: string
  /** What the bot is for, in a line; shown next to its name and read by the Team Lead when choosing teammates. */
  description?: string
  /** Model route; both empty uses the default model new agents get. */
  provider?: string
  model?: string
  /** Thinking level the bot starts at (off … max); the nearest level its model has. Blank: the model's own (Settings → Models). */
  effort?: string
  /** Who the bot is: replaces the deployment persona at the top of its system prompt. */
  persona?: string
  /** Only these tools (DSH tool names); empty keeps every tool. */
  tools?: readonly string[]
}

/** The bot a teammate name refers to: the longest id it equals or extends with `-…`. */
export function profileFor(name: string, profiles: readonly AgentProfile[]): AgentProfile | undefined {
  let best: AgentProfile | undefined
  for (const profile of profiles) {
    if ((name === profile.id || name.startsWith(`${profile.id}-`)) && profile.id.length > (best?.id.length ?? 0)) best = profile
  }
  return best
}

/** The fields of a continuable subagent start request a bot fills in. */
export interface StartRequest {
  prompt: readonly unknown[]
  agentOptions?: { provider?: string; model?: string }
  [key: string]: unknown
}

/** A teammate that is a bot runs on the bot route, so it gets the bot's persona, tools and model, and follows later edits. */
export function applyProfile(request: StartRequest, profile: AgentProfile): StartRequest {
  return { ...request, agentOptions: { ...request.agentOptions, provider: BOT_ROUTE, model: profile.id } }
}

/** What the bot is told about itself, at the top of its system prompt (or appended to Claude Code's). */
export function personaText(profile: AgentProfile): string {
  const description = profile.description?.trim()
  const intro = `You are "${profile.id}"${description ? `: ${description}` : ''}.`
  const persona = profile.persona?.trim()
  return persona ? `${intro}\n\n${persona}` : intro
}

/** One line per bot for the Team Lead's system prompt. */
export function rosterText(profiles: readonly AgentProfile[]): string {
  const lines = profiles.map((profile) => {
    const model = profile.provider && profile.model ? ` [${profile.provider}/${profile.model}]` : ''
    return `- ${profile.id}${model}: ${profile.description?.trim() || 'no description'}`
  })
  return [
    'Bots configured for teammates:',
    ...lines,
    'To make a teammate one of these bots, name it after the bot id (e.g. `reviewer`, or `reviewer-2` for a second one) and create it fresh: it then runs with that bot\'s model, persona and tools. Other names get no bot. When the user writes @<bot id>, the bot joins the team by itself.',
  ].join('\n')
}

/** Only well-formed, uniquely named bots take effect. */
export function validProfiles(value: unknown): AgentProfile[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: AgentProfile[] = []
  for (const item of value as AgentProfile[]) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || !PROFILE_ID.test(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}
