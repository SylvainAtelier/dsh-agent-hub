/**
 * `@` in a session's composer: the team's members first, then the bots not in
 * it yet (picking one invites it: the host has it join when the message is
 * sent, team/index.ts), and a last row that opens 设置 → Agent Hub to make a
 * new bot. Sessions that route no @mentions (a teammate's) suggest nothing.
 */

import { ALL } from '../../team/mentions.ts'
import { profileFor } from '../../team/profiles.ts'
import { TEAM_METHOD, type Roster } from '../../team/types.ts'
import { t, type Key } from '../i18n.ts'
import { rpcValue } from '../rpc.ts'

interface Candidate {
  name: string
  description?: string
  /** A row's `section` titles its group; without one the menu shows the source's raw name. */
  section?: string
}

/** The slice of ui-input-trigger's source contract this source implements. */
interface Source {
  trigger: '@'
  name: string
  order: number
  candidates(session: { sessionId: string }, request: { query: string; signal: AbortSignal }): Promise<Candidate[]>
  onPick(pick: { candidate: { name: string } }): { text: string }
}

export interface MentionContext {
  get(name: 'connection'): { rpc: { call(channel: string, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> } }
  inject(deps: string[], body: (scope: MentionContext & { inputTriggers: { registerSource(source: Source): () => void } }) => void): void
  effect(body: () => () => void, label?: string): void
}

/** Rosters change only as members join; a few seconds of reuse keeps typing from re-asking per key. */
const FRESH_MS = 4000
/** The create row's name: not a valid bot id, so it never collides with one. */
const CREATE = '＋'

const STATUS: Record<string, Key> = { running: 'mention.running', inactive: 'mention.inactive', provisioning: 'mention.provisioning' }
const EMPTY: Roster = { addressable: false, members: [], bots: [] }

/** The rows `@` offers for a roster, before filtering by what was typed. */
export function mentionRows(roster: Roster): Candidate[] {
  if (!roster.addressable) return []
  const members = roster.members.filter((member) => member.role === 'teammate' && member.status !== 'failed')
  const joined = (id: string): boolean => members.some((member) => profileFor(member.name, [{ id }]) !== undefined)
  const rows: Candidate[] = members.map((member) => ({
    name: member.name,
    description: [member.description, STATUS[member.status] === undefined ? undefined : t(STATUS[member.status]!)].filter(Boolean).join(' · '),
    section: t('mention.section'),
  }))
  if (members.length > 1) rows.push({ name: ALL[0], description: t('mention.all'), section: t('mention.section') })
  for (const bot of roster.bots) {
    if (!joined(bot.id)) rows.push({ name: bot.id, description: bot.description ?? '', section: t('mention.invite') })
  }
  return rows
}

export function applyTeamMentions(ctx: MentionContext, openBots: () => void): void {
  const cache = new Map<string, { at: number; roster: Promise<Roster> }>()
  const rosterOf = (sessionId: string): Promise<Roster> => {
    const hit = cache.get(sessionId)
    if (hit !== undefined && Date.now() - hit.at < FRESH_MS) return hit.roster
    const roster = rpcValue<Roster>(ctx.get('connection').rpc, TEAM_METHOD, { op: 'members', sessionId }, 'team RPC failed')
      .then((value) => (Array.isArray(value?.members) ? value : EMPTY), () => EMPTY)
    cache.set(sessionId, { at: Date.now(), roster })
    return roster
  }

  const source: Source = {
    trigger: '@',
    name: 'agent-hub.team',
    order: 0,
    async candidates(session, { query, signal }) {
      const roster = await rosterOf(session.sessionId)
      if (signal.aborted || !roster.addressable) return []
      const q = query.trim().toLowerCase()
      const rows = mentionRows(roster).filter((row) => row.name.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
      // Making a bot is offered when nothing typed matches one, so it never stands between you and a name.
      if (q === '' || rows.length === 0) rows.push({ name: CREATE, description: t('mention.create'), section: t('mention.invite') })
      return rows
    },
    onPick({ candidate }) {
      if (candidate.name !== CREATE) return { text: `@${candidate.name} ` }
      openBots()
      return { text: '' }
    },
  }

  ctx.inject(['inputTriggers'], (scope) => scope.effect(() => {
    try {
      const unregister = scope.inputTriggers.registerSource(source)
      return () => {
        unregister()
        cache.clear()
      }
    } catch (error) {
      console.warn('[dsh-agent-hub] team mentions:', error)
      return () => {}
    }
  }, 'dsh-agent-hub: team mentions'))
}
