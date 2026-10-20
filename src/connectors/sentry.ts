/** Sentry issue reads through its MCP server. Output is intentionally parsed leniently. */

import type { McpSession } from './mcp.ts'
import { compareIssues, type AlertOrder, type AlertPeriod, type AlertSort, type SentryIssue, type SentryIssueDetail, type SentryLocation } from '../alerts/types.ts'

const LIST_TTL_MS = 5 * 60_000
const DETAIL_TTL_MS = 60_000
const LIMIT = 100
const MAX_DETAIL_CHARS = 60_000
/** The only hosts Sentry's MCP server accepts as `regionUrl`. An organization's own subdomain is a web host, not a region. */
const REGION_HOSTS = new Set(['sentry.io', 'us.sentry.io', 'de.sentry.io'])
/** Subdomains of sentry.io that are not organizations. */
const NOT_ORGANIZATIONS = new Set(['us', 'de', 'www'])
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|kts|scala|swift|m|mm|c|cc|cpp|h|hpp|cs|php|rs|dart|ex|exs|erl|vue|svelte|lua|clj)$/i
const MINUTE = 60_000
const UNIT_MS = { minute: MINUTE, hour: 60 * MINUTE, day: 24 * 60 * MINUTE } as const

type Tool = { name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }
type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d[\d,]*$/.test(value.trim()) ? Number(value.replaceAll(',', '')) : undefined

export interface SentryTarget {
  organization: string
  project?: string
  environment: 'prod'
  period: AlertPeriod
}

/**
 * Parse an issues page: `https://<org>.sentry.io/issues/?project=…` or `https://sentry.io/organizations/<org>/issues/`.
 * The region is never taken from the URL; it is looked up from the organization. The lane always pins environment to prod.
 */
export function parseSentryIssuesUrl(value: string): SentryTarget | undefined {
  try {
    const url = new URL(value.trim())
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || (host !== 'sentry.io' && !host.endsWith('.sentry.io'))) return undefined
    const fromPath = /^\/organizations\/([^/]+)/.exec(url.pathname)?.[1]
    const label = host === 'sentry.io' ? undefined : host.slice(0, -'.sentry.io'.length).split('.')[0]
    const organization = fromPath !== undefined ? decodeURIComponent(fromPath) : label !== undefined && !NOT_ORGANIZATIONS.has(label) ? label : ''
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(organization)) return undefined
    // `project=-1` is "all projects".
    const project = url.searchParams.getAll('project').map((item) => item.trim()).find((item) => /^[a-z0-9][a-z0-9_.-]*$/i.test(item))
    const period = url.searchParams.get('statsPeriod') === '7d' ? '7d' : '14d'
    return { organization, ...(project === undefined ? {} : { project }), environment: 'prod', period }
  } catch {
    return undefined
  }
}

/** A `regionUrl` the MCP server accepts, or undefined. */
export function regionUrlOf(value: unknown): string | undefined {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && REGION_HOSTS.has(url.host.toLowerCase()) ? `https://${url.host.toLowerCase()}` : undefined
  } catch {
    return undefined
  }
}

/** The organization's region from `find_organizations`: structured content, else its text. */
export function parseOrganizationRegion(value: unknown, organization: string): string | undefined {
  const list = record(value)?.organizations
  if (Array.isArray(list)) {
    const match = list.map(record).find((item) => text(item?.slug)?.toLowerCase() === organization.toLowerCase())
    return regionUrlOf(match?.regionUrl)
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const at = raw.toLowerCase().indexOf(organization.toLowerCase())
  if (at < 0) return undefined
  const found = /region\s*url\W+(https:\/\/[^\s"'`)\]]+)/i.exec(raw.slice(at))
  return found ? regionUrlOf(found[1]) : undefined
}

/**
 * A Sentry time as ISO, and how coarse it is. The issue list shows "3 hours ago" (or a date beyond 30 days);
 * the result is the latest instant that text allows, so `iso - slackMs` is the earliest.
 */
export function seenAt(value: string | undefined, now = Date.now()): { iso: string; slackMs: number } | undefined {
  if (!value || /^n\/?a$/i.test(value)) return undefined
  const relative = /^(\d+)\s+(minute|hour|day)s?\s+ago$/i.exec(value.trim())
  if (relative) {
    const unit = UNIT_MS[relative[2]!.toLowerCase() as keyof typeof UNIT_MS]
    return { iso: new Date(now - Number(relative[1]) * unit).toISOString(), slackMs: unit }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const time = Date.parse(`${value.trim()}T23:59:59Z`)
    return Number.isNaN(time) ? undefined : { iso: new Date(time).toISOString(), slackMs: UNIT_MS.day }
  }
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : { iso: new Date(time).toISOString(), slackMs: 0 }
}

function field(markdown: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `**Name**: value` and `**Name:** value`.
    const match = new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}${escaped}(?:\\*{0,2}\\s*:|\\s*:\\*{0,2})\\s*(.+?)\\s*$`, 'im').exec(markdown)
    if (match?.[1]) return match[1].replace(/^`|`$/g, '').trim()
  }
  return undefined
}

function locationOf(value: string | undefined): SentryLocation | undefined {
  if (!value) return undefined
  const clean = value.replace(/^`|`$/g, '').trim()
  const match = /(?:^|\s|\()((?:[A-Za-z]:)?[^\s():]+\.[A-Za-z0-9]+)(?::(\d+))?(?:\s+in\s+([^()]+))?/.exec(clean)
  // A dotted module name ("app.views in index") is not a file.
  if (!match?.[1] || !SOURCE_EXTENSIONS.test(match[1])) return undefined
  return { path: match[1].replaceAll('\\', '/'), ...(match[2] ? { line: Number(match[2]) } : {}), ...(match[3]?.trim() ? { function: match[3].trim() } : {}) }
}

function seen(value: string | undefined, now: number): { iso?: string; slackMs?: number } {
  const at = seenAt(value, now)
  return at === undefined ? {} : { iso: at.iso, slackMs: at.slackMs }
}

function issueFromObject(value: unknown, now: number): SentryIssue | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const id = text(raw.shortId) ?? text(raw.issueId) ?? text(raw.id) ?? text(raw.identifier)
  const title = text(raw.title) ?? text(raw.message)
  if (!id || !title) return undefined
  const metadata = record(raw.metadata)
  const culprit = text(raw.culprit) ?? text(metadata?.function) ?? text(metadata?.filename)
  const url = text(raw.permalink) ?? text(raw.url) ?? text(raw.webUrl)
  const firstSeen = seen(text(raw.firstSeen) ?? text(raw.first_seen), now).iso
  const last = seen(text(raw.lastSeen) ?? text(raw.last_seen), now)
  const events = number(raw.count) ?? number(raw.events) ?? number(raw.eventCount)
  const users = number(raw.userCount) ?? number(raw.users)
  const location = locationOf(text(raw.location) ?? text(metadata?.filename) ?? culprit)
  return { id: id.toUpperCase(), title, ...(text(raw.subtitle) ? { subtitle: text(raw.subtitle)! } : {}), ...(url ? { url } : {}), ...(text(raw.project) ? { project: text(raw.project)! } : {}), ...(culprit ? { culprit } : {}), ...(firstSeen ? { firstSeen } : {}), ...(last.iso ? { lastSeen: last.iso, lastSeenSlackMs: last.slackMs! } : {}), ...(events !== undefined ? { events } : {}), ...(users !== undefined ? { users } : {}), ...(location ? { location } : {}) }
}

/**
 * Parse `search_issues`: structured issues, or its numbered Markdown —
 * `## 1. [ID](url)`, then `**Title**`, then `- **Events**: 12`-style fields. Raw blocks are kept as evidence.
 */
export function parseSentryIssues(value: unknown, now = Date.now()): SentryIssue[] {
  const asRecord = record(value)
  const arrays = [asRecord?.issues, asRecord?.results, asRecord?.data, value].find(Array.isArray)
  if (Array.isArray(arrays)) return arrays.map((item) => issueFromObject(item, now)).filter((item): item is SentryIssue => item !== undefined)
  const markdown = typeof value === 'string' ? value : text(asRecord?.content) ?? text(asRecord?.markdown) ?? ''
  if (!markdown) return []
  const headings = [...markdown.matchAll(/^#{2,4}\s+(?:\d+[.)]\s*)?(?:\[([^\]]+)\]\(([^)]+)\)|([^\n]+))\s*$/gm)]
  const out: SentryIssue[] = []
  for (let index = 0; index < headings.length; index++) {
    const match = headings[index]!
    const block = markdown.slice(match.index!, headings[index + 1]?.index ?? markdown.length).trim()
    const heading = (match[1] ?? match[3] ?? '').trim()
    const explicit = /^([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\b(?:\s*[-–—:]\s*)?(.*)$/.exec(heading)
    const id = (field(block, 'Issue', 'ID', 'Short ID') ?? explicit?.[1])?.replace(/[`*]/g, '').toUpperCase()
    // The title is a bold line of its own under the heading.
    const bold = /^\*\*([^*\n][^\n]*?)\*\*\s*$/m.exec(block)?.[1]?.trim()
    const title = field(block, 'Title', 'Description') || bold || explicit?.[2]?.trim()
    if (!id || !title) continue
    const culprit = field(block, 'Culprit')
    const events = number(field(block, 'Events', 'Count', 'Occurrences'))
    const users = number(field(block, 'Users', 'Users Impacted'))
    const firstSeen = seen(field(block, 'First Seen', 'Age'), now).iso
    const last = seen(field(block, 'Last Seen'), now)
    const project = field(block, 'Project')
    const subtitle = field(block, 'Subtitle', 'Exception')
    const location = locationOf(field(block, 'Location', 'Source') ?? culprit)
    out.push({ id, title, ...(match[2] ? { url: match[2] } : {}), ...(subtitle ? { subtitle } : {}), ...(project ? { project } : {}), ...(culprit ? { culprit } : {}), ...(firstSeen ? { firstSeen } : {}), ...(last.iso ? { lastSeen: last.iso, lastSeenSlackMs: last.slackMs! } : {}), ...(events !== undefined ? { events } : {}), ...(users !== undefined ? { users } : {}), ...(location ? { location } : {}), raw: block })
  }
  return out
}

/** Detail evidence from `get_sentry_resource`: its exact times replace the list's approximate ones. */
export function parseSentryDetail(issue: SentryIssue, value: unknown): SentryIssueDetail {
  const raw = record(value)
  const markdown = (typeof value === 'string' ? value : text(raw?.content) ?? text(raw?.markdown) ?? JSON.stringify(value, null, 2)).slice(0, MAX_DETAIL_CHARS)
  const exception = field(markdown, 'Exception', 'Error', 'Value')
  const traceId = field(markdown, 'Trace ID', 'Trace')
  const source = locationOf(field(markdown, 'Location', 'Source', 'Culprit'))
  const firstSeen = seenAt(field(markdown, 'First Seen'))
  const lastSeen = seenAt(field(markdown, 'Last Seen'))
  return {
    ...issue,
    ...(source ? { location: source } : {}),
    ...(firstSeen?.slackMs === 0 ? { firstSeen: firstSeen.iso } : {}),
    ...(lastSeen?.slackMs === 0 ? { lastSeen: lastSeen.iso, lastSeenSlackMs: 0 } : {}),
    markdown,
    ...(exception ? { exception } : {}),
    ...(traceId ? { traceId } : {}),
  }
}

function toolName(tools: readonly Tool[], suffix: string): string | undefined {
  return tools.find((tool) => tool.name === suffix || tool.name.endsWith(`__${suffix}`))?.name
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/** Only the arguments a tool declares (all of them when it declares none); never an undefined one. */
function argsFor(tool: Tool | undefined, values: Record<string, unknown>): Record<string, unknown> {
  const props = tool?.inputSchema?.properties
  const known = props && Object.keys(props).length > 0 ? props : undefined
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== undefined && (known === undefined || key in known)))
}

type Listed = { issues: SentryIssue[]; truncated: boolean }

export class SentryIssues {
  private toolsPromise?: Promise<Tool[]>
  private regionPromise?: Promise<string | undefined>
  private readonly lists = new Map<string, { at: number; promise: Promise<Listed> }>()
  private readonly details = new Map<string, { at: number; promise: Promise<SentryIssueDetail> }>()
  private mutation: Promise<unknown> = Promise.resolve()
  private readonly session: () => McpSession
  readonly target: SentryTarget
  constructor(session: () => McpSession, target: SentryTarget) { this.session = session; this.target = target }

  /** The server's tools, read once; a failed read is retried next time. */
  private tools(): Promise<Tool[]> {
    const promise = this.toolsPromise ??= this.session().tools()
    promise.catch(() => { if (this.toolsPromise === promise) this.toolsPromise = undefined })
    return promise
  }

  /** The organization's region (`https://us.sentry.io`, …), looked up once; undefined lets the server route it. */
  private region(): Promise<string | undefined> {
    const promise = this.regionPromise ??= (async () => {
      const tools = await this.tools()
      const name = toolName(tools, 'find_organizations')
      if (!name) return undefined
      const tool = tools.find((item) => item.name === name)
      return parseOrganizationRegion(await this.session().tool(name, argsFor(tool, { query: this.target.organization })), this.target.organization)
    })()
    // Not cached when the lookup failed: an unknown region is retried, an absent one is not.
    return promise.catch(() => { if (this.regionPromise === promise) this.regionPromise = undefined; return undefined })
  }

  /** Call a tool by suffix; a rejected `regionUrl` is dropped once and the call retried without it. */
  private async call(suffix: string, values: Record<string, unknown>): Promise<unknown> {
    const tools = await this.tools()
    const name = toolName(tools, suffix)
    if (!name) throw new Error(`Sentry MCP does not provide ${suffix}`)
    const tool = tools.find((item) => item.name === name)
    const args = argsFor(tool, values)
    try {
      return await this.session().tool(name, args)
    } catch (error) {
      if (args.regionUrl === undefined || !/regionUrl/i.test(error instanceof Error ? error.message : String(error))) throw error
      this.regionPromise = Promise.resolve(undefined)
      const { regionUrl: _dropped, ...rest } = args
      return this.session().tool(name, rest)
    }
  }

  private async has(suffix: string): Promise<boolean> { return toolName(await this.tools(), suffix) !== undefined }

  async list(period: AlertPeriod, sort: AlertSort, order: AlertOrder, force = false): Promise<Listed> {
    const key = `${period}:${sort}:${order}`
    const hit = this.lists.get(key)
    if (!force && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.promise
    const promise = (async () => {
      const serverSort = sort === 'lastSeen' ? 'date' : sort === 'age' ? 'new' : 'freq'
      // Sentry search syntax; the window is the `period` argument, never part of the query.
      const query = `is:unresolved environment:${this.target.environment}`
      const regionUrl = await this.region()
      const value = await this.call('search_issues', {
        organizationSlug: this.target.organization, projectSlugOrId: this.target.project,
        query, naturalLanguageQuery: query, sort: serverSort, period, statsPeriod: period,
        limit: LIMIT, regionUrl, includeExplanation: false,
      })
      const issues = parseSentryIssues(value)
      // The server owns sorting. Reverse only when the response is known complete.
      if (order === 'asc' && issues.length < LIMIT) issues.sort((a, b) => compareIssues(a, b, sort))
      return { issues, truncated: issues.length >= LIMIT }
    })()
    this.lists.set(key, { at: Date.now(), promise })
    promise.catch(() => { if (this.lists.get(key)?.promise === promise) this.lists.delete(key) })
    return promise
  }

  /** An issue already listed under any period or sort, without another request. */
  async cached(id: string): Promise<SentryIssue | undefined> {
    const wanted = id.toUpperCase()
    for (const hit of [...this.lists.values()]) {
      const found = (await hit.promise.catch(() => undefined))?.issues.find((issue) => issue.id === wanted)
      if (found) return found
    }
    return undefined
  }

  async detail(issue: SentryIssue, force = false): Promise<SentryIssueDetail> {
    const hit = this.details.get(issue.id)
    if (!force && hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.promise
    const promise = (async () => {
      if (!await this.has('get_sentry_resource')) return parseSentryDetail(issue, issue.raw ?? '')
      const value = await this.call('get_sentry_resource', issue.url
        ? { url: issue.url, organizationSlug: this.target.organization }
        : { resourceType: 'issue', resourceId: issue.id, organizationSlug: this.target.organization })
        .catch((error: unknown) => {
          // Evidence is best effort: the list's own block stands in for it.
          if (!issue.raw) throw error
          return issue.raw
        })
      return parseSentryDetail(issue, `## Issue resource\n\n${printable(value)}`.slice(0, MAX_DETAIL_CHARS))
    })()
    this.details.set(issue.id, { at: Date.now(), promise })
    promise.catch(() => { if (this.details.get(issue.id)?.promise === promise) this.details.delete(issue.id) })
    return promise
  }

  async resolve(id: string, resolved: boolean): Promise<void> {
    const action = this.mutation.catch(() => {}).then(async () => this.call('update_issue', {
      organizationSlug: this.target.organization, issueId: id.toUpperCase(),
      status: resolved ? 'resolved' : 'unresolved', regionUrl: await this.region(),
    }))
    this.mutation = action
    await action
    this.lists.clear()
    this.details.delete(id.toUpperCase())
  }
}
