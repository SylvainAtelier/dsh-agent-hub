/**
 * New Linear tickets announced in Slack, through the Slack connector's own MCP
 * tools with the signed-in user's credential: the channels to pick from, and
 * the message, laid out the way Linear's Slack app shows an issue it created.
 * Slack's MCP answers in text, so channels are read off its lines.
 */

import type { McpSession } from './mcp.ts'
import type { Named } from '../board/types.ts'

const CHANNELS_TTL_MS = 60_000
/** Slack takes at most 5000 characters per text element; the fields and title need some. */
const MAX_DESCRIPTION = 3_000
/** `#name (C0123ABC)`: a channel in a `slack_search_channels` answer. */
const CHANNEL_LINE = /#([^\s()]+) \(([CG][A-Z0-9]{6,})\)([^\n]*)/g

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined)

/** The channels in a `slack_search_channels` answer (text, or JSON with the text under `results`); archived ones left out. */
export function channelsIn(value: unknown): Named[] {
  const body = typeof value === 'string' ? value : typeof record(value)?.results === 'string' ? String(record(value)!.results) : ''
  const out: Named[] = []
  for (const [, name, id, rest] of body.matchAll(CHANNEL_LINE)) {
    if (/\bArchived\b/.test(rest!) && !/Not Archived/.test(rest!)) continue
    if (!out.some((channel) => channel.id === id)) out.push({ id: id!, name: name! })
  }
  return out
}

export interface IssueNotice {
  identifier: string
  title: string
  url?: string
  description?: string
  team?: string
  state?: string
  priority?: string
  assignee?: string
  labels?: readonly string[]
  project?: string
}

/**
 * A created issue as Linear's Slack app posts it: the identifier and title linking to it, the
 * description, a line per field that is set, the team last.
 */
export function issueNotice(issue: IssueNotice): string {
  const head = `${issue.identifier} ${issue.title}`
  const description = (issue.description ?? '').trim()
  const fields: Array<[string, string | undefined]> = [
    ['State', issue.state],
    ['Priority', issue.priority],
    ['Assignee', issue.assignee],
    ['Labels', issue.labels !== undefined && issue.labels.length > 0 ? issue.labels.join(', ') : undefined],
    ['Project', issue.project],
  ]
  return [
    issue.url === undefined ? `**${head}**` : `**[${head}](${issue.url})**`,
    ...(description === '' ? [] : [description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION).trimEnd()}…` : description]),
    ...fields.flatMap(([name, value]) => (value === undefined || value === '' ? [] : [`**${name}**  ${value}`])),
    ...(issue.team === undefined ? [] : [issue.team]),
  ].join('\n')
}

export class SlackNotices {
  private readonly session: () => McpSession
  private channelCache = new Map<string, { at: number; channels: Promise<Named[]> }>()

  constructor(session: () => McpSession) {
    this.session = session
  }

  /** Public and private channels whose name matches `query`, cached briefly. */
  channels(query: string): Promise<Named[]> {
    const words = query.trim().replace(/^#/, '').split(/\s+/).filter(Boolean)
    if (words.length === 0) return Promise.resolve([])
    const key = words.join(' ').toLowerCase()
    const hit = this.channelCache.get(key)
    if (hit !== undefined && Date.now() - hit.at < CHANNELS_TTL_MS) return hit.channels
    const channels = this.session().tool('slack_search_channels', {
      keywords: words, natural_language_query: '', channel_types: 'public_channel,private_channel', limit: 20, response_format: 'concise',
    }).then(channelsIn)
    this.channelCache.set(key, { at: Date.now(), channels })
    channels.catch(() => { if (this.channelCache.get(key)?.channels === channels) this.channelCache.delete(key) })
    return channels
  }

  async post(channel: string, message: string): Promise<void> {
    await this.session().tool('slack_send_message', { channel_id: channel, message, unfurl_app_links: false })
  }
}
