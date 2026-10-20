/**
 * Connectors: remote MCP servers (Linear, Notion, Sentry, …) the hub connects
 * once for every model. Shared by the host and the browser: the RPC contract,
 * the presets the settings page offers, and how a branch names a ticket.
 */

export const CONNECTORS_METHOD = 'agent-hub/connectors'

/** One configured connector (`connectors.servers` in the profile). Its id is also the MCP server name: tools are `mcp__<id>__<tool>`. */
export interface ConnectorEntry {
  id: string
  url: string
  /**
   * The local repositories (main working tree paths) this account is for; absent or empty, it
   * serves every repository. Linked, its tools reach only model sessions working in one of them
   * (or a worktree of one; see scope.ts), and ticket lookups made there use it.
   */
  repos?: readonly string[]
  /**
   * The OAuth client ID of an app registered with the server by hand, for a server that registers
   * no clients on the fly (Slack). A public client: PKCE, no secret, redirect {@link APP_REDIRECT}.
   */
  clientId?: string
}

/** A credential key segment and an MCP server name at once. */
export const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,31}$/

export interface Preset {
  id: string
  name: string
  url: string
  /** Where to create a token by hand, offered next to "use a token instead". */
  tokenUrl?: string
  /** Other endpoints of the same service: another region, or options in the query. */
  matches?(url: URL): boolean
  /** For a server without client registration: the scopes to ask for, and where to create an app for them, ready-filled. */
  app?: { scopes: readonly string[]; createUrl: string }
}

/**
 * Where a sign-in with a hand-registered app returns: one fixed loopback address, so it can be
 * entered in the app once. `localhost`, not an IP: Slack takes it as a desktop (PKCE) redirect.
 */
export const APP_REDIRECT_PORT = 53134
export const APP_REDIRECT = `http://localhost:${APP_REDIRECT_PORT}/callback`

/** What Slack's MCP server reads and writes: user scopes, the server holds no bot token. */
const SLACK_SCOPES = [
  'search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im', 'search:read.files', 'search:read.users',
  'channels:history', 'groups:history', 'mpim:history', 'im:history',
  'chat:write', 'canvases:read', 'canvases:write', 'users:read', 'users:read.email',
]

/**
 * An internal Slack app for the hub, as a manifest Slack opens on its "create app" page: MCP on,
 * PKCE (no client secret), the loopback redirect. Slack's authorize page wants a bot user to exist.
 */
const SLACK_MANIFEST = {
  display_information: { name: 'DSH Agent Hub', description: 'Slack for every DSH model, through Slack\'s MCP server' },
  features: { bot_user: { display_name: 'DSH Agent Hub', always_online: false } },
  oauth_config: { redirect_urls: [APP_REDIRECT], pkce_enabled: true, scopes: { bot: ['users:read'], user: SLACK_SCOPES } },
  settings: { is_mcp_enabled: true, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
}

/** Remote MCP servers one click away. Anything else is added by URL. */
export const PRESETS: readonly Preset[] = [
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', tokenUrl: 'https://linear.app/settings/account/security' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', tokenUrl: 'https://github.com/settings/personal-access-tokens' },
  // No dynamic client registration: sign in through a Slack app of the user's own (Cursor ships its own client ID).
  {
    id: 'slack', name: 'Slack', url: 'https://mcp.slack.com/mcp', tokenUrl: 'https://api.slack.com/apps',
    app: { scopes: SLACK_SCOPES, createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST))}` },
  },
  {
    id: 'datadog', name: 'Datadog', url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    tokenUrl: 'https://app.datadoghq.com/personal-settings/access-tokens',
    matches: (url) => datadogSite(url) !== undefined,
  },
  // Temporal's knowledge base (docs, forum, Slack answers); Temporal hosts no server for workflows.
  { id: 'temporal', name: 'Temporal', url: 'https://temporal.mcp.kapa.ai' },
]

const key = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase()

export function presetOf(url: string): Preset | undefined {
  const exact = PRESETS.find((preset) => key(preset.url) === key(url))
  if (exact !== undefined) return exact
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  return PRESETS.find((preset) => preset.matches?.(parsed) === true)
}

/** Where to create a token for this endpoint: its preset's page, on the endpoint's own region. */
export function tokenUrlOf(url: string): string | undefined {
  const preset = presetOf(url)
  if (preset?.id !== 'datadog') return preset?.tokenUrl
  const site = datadogSite(new URL(url.trim())) ?? DATADOG_SITES[0]
  return `https://${site.app}/personal-settings/access-tokens`
}

/** Datadog's sites: each has its own MCP host and its own app host. */
export const DATADOG_SITES = [
  { id: 'us1', mcp: 'mcp.datadoghq.com', app: 'app.datadoghq.com' },
  { id: 'us3', mcp: 'mcp.us3.datadoghq.com', app: 'us3.datadoghq.com' },
  { id: 'us5', mcp: 'mcp.us5.datadoghq.com', app: 'us5.datadoghq.com' },
  { id: 'eu1', mcp: 'mcp.datadoghq.eu', app: 'app.datadoghq.eu' },
  { id: 'ap1', mcp: 'mcp.ap1.datadoghq.com', app: 'ap1.datadoghq.com' },
  { id: 'ap2', mcp: 'mcp.ap2.datadoghq.com', app: 'ap2.datadoghq.com' },
] as const

const DATADOG_PATH = '/api/unstable/mcp-server/mcp'

/**
 * Datadog's toolsets (`?toolsets=`); without the parameter the server loads `core` alone.
 * `preview` ones are left out of `toolsets=all`, so they are always named one by one.
 */
export const DATADOG_TOOLSETS: readonly { id: string; preview?: true }[] = [
  { id: 'core' }, { id: 'alerting' }, { id: 'apm', preview: true }, { id: 'assistant' }, { id: 'audit-trail' },
  { id: 'cases' }, { id: 'cloud-resources' }, { id: 'code-exec' }, { id: 'cost' }, { id: 'dashboards' },
  { id: 'data-observability' }, { id: 'dbm' }, { id: 'ddsql' }, { id: 'error-tracking' }, { id: 'experiments' },
  { id: 'feature-flags' }, { id: 'forms' }, { id: 'governance', preview: true }, { id: 'investigator', preview: true },
  { id: 'kubernetes' }, { id: 'live-debugger', preview: true }, { id: 'metrics-governance' }, { id: 'rum' },
]

export interface DatadogOptions {
  site: (typeof DATADOG_SITES)[number]['id']
  toolsets: readonly string[]
}

function datadogSite(url: URL): (typeof DATADOG_SITES)[number] | undefined {
  if (url.protocol !== 'https:' || url.pathname.replace(/\/+$/, '') !== DATADOG_PATH) return undefined
  return DATADOG_SITES.find((site) => site.mcp === url.hostname.toLowerCase())
}

/** A Datadog endpoint's site and toolsets; undefined for any other URL. */
export function datadogOptions(url: string): DatadogOptions | undefined {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  const site = datadogSite(parsed)
  if (site === undefined) return undefined
  const listed = (parsed.searchParams.get('toolsets') ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  return { site: site.id, toolsets: listed.length === 0 ? ['core'] : listed }
}

/** The endpoint with these options; other query parameters (`subdomain`, `omit_tools`) are kept. */
export function datadogUrl(url: string, options: DatadogOptions): string {
  const parsed = new URL(url.trim())
  parsed.hostname = DATADOG_SITES.find((site) => site.id === options.site)!.mcp
  parsed.pathname = DATADOG_PATH
  const toolsets = [...new Set(options.toolsets)]
  if (toolsets.length === 0 || (toolsets.length === 1 && toolsets[0] === 'core')) parsed.searchParams.delete('toolsets')
  else parsed.searchParams.set('toolsets', toolsets.join(','))
  // Keep the commas readable: they are what Datadog's own docs show.
  return parsed.href.replace(/%2C/gi, ',')
}

/** What the settings page calls a connector: its preset's name, else the server's host. */
export function connectorName(entry: ConnectorEntry): string {
  const preset = presetOf(entry.url)
  if (preset !== undefined) return preset.name
  try {
    return new URL(entry.url).hostname.replace(/^(mcp|api|www)\./, '')
  } catch {
    return entry.id
  }
}

/** An id for a new connector: the preset's, else the host's first meaningful label, unique among `taken`. */
export function connectorId(url: string, taken: readonly string[]): string {
  let base = presetOf(url)?.id
  if (base === undefined) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      // Fall through to the generic name.
    }
    base = host.split('.')
      .filter((part) => !['mcp', 'api', 'www', 'app'].includes(part))
      .map((part) => part.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 28).replace(/-+$/, ''))
      .find((candidate) => candidate !== '') ?? 'mcp'
  }
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
}

/** A remote MCP endpoint: https, or http on this machine. */
export function validServerUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

/** Where a connector stands, as the settings page shows it. Each phase has one next step. */
export type ConnectorPhase =
  /** No credential: connect. */
  | { phase: 'disconnected' }
  /** The browser is signing in; the page can reopen the authorization page. */
  | { phase: 'authorizing'; authorizeUrl: string }
  /** The server takes no browser sign-in: ask for a token. */
  | { phase: 'token' }
  /** It takes one but registers no clients: ask for the client ID of an app made for it (or a token). */
  | { phase: 'client' }
  | { phase: 'connecting' }
  | { phase: 'connected'; tools: number; via: 'oauth' | 'token' | 'none' }
  /** The server refused the credential: sign in again. */
  | { phase: 'expired' }
  /** `rejected`: the server refused the token typed in. */
  | { phase: 'error'; message: string; reason?: 'rejected' }

export interface ConnectorStatus {
  id: string
  url: string
  state: ConnectorPhase
}

export type ConnectorRequest =
  | { op: 'status' }
  | { op: 'connect'; id: string; url: string }
  | { op: 'token'; id: string; url: string; token: string }
  | { op: 'cancel'; id: string }
  | { op: 'disconnect'; id: string }
  /** `cwd`: the folder asking, so the account linked to its repository answers. */
  | { op: 'issues'; query?: string; cwd?: string }
  | { op: 'issue'; identifier: string; cwd?: string }
  | { op: 'linked'; branches: string[]; cwd?: string }

/** A ticket as the worktree picker shows it. */
export interface Issue {
  identifier: string
  title: string
  url?: string
  /** Linear's suggested branch for it. */
  branch?: string
  state?: string
  /** started, unstarted, completed, … — drives the status dot. */
  stateType?: string
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority?: number
  assignee?: string
  /** Whether anyone is assigned; absent when the server did not say (then it is left alone). */
  assigned?: boolean
  project?: string
  /** The team's id: its workflow states are what the issue can move to. */
  team?: string
  /** ISO time of the last change. */
  updatedAt?: string
}

/** One workflow state of a Linear team. */
export interface IssueState {
  id: string
  name: string
  /** backlog, unstarted, started, completed, canceled, triage, duplicate. */
  type: string
}

/** `linked`: which of the given branches carry a ticket the tracker knows, by branch. */
export type LinkedIssues = Record<string, Issue>

/**
 * The ticket a branch names: Linear's own convention (`vi/eng-123-fix-login`,
 * `ENG-123`), restricted to the workspace's team keys so `feat/login-2` is not
 * mistaken for one. The identifier comes back upper-case.
 */
export function issueInBranch(branch: string, teamKeys: readonly string[]): string | undefined {
  if (teamKeys.length === 0) return undefined
  const keys = teamKeys.map((team) => team.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean).join('|')
  const match = new RegExp(`(?:^|[/_.-])(${keys})-(\\d+)(?=$|[/_.-])`, 'i').exec(branch)
  return match === null ? undefined : `${match[1]!.toUpperCase()}-${match[2]}`
}

/** Whether a connector's URL is Linear's MCP server, whatever id it was given. */
export function isLinear(url: string): boolean {
  try {
    return new URL(url).hostname === 'mcp.linear.app'
  } catch {
    return false
  }
}

/** Whether a connector's URL is Sentry's MCP server. */
export function isSentry(url: string): boolean {
  try {
    return new URL(url).hostname === 'mcp.sentry.dev'
  } catch {
    return false
  }
}

/** Whether a connector's URL is Slack's MCP server. */
export function isSlack(url: string): boolean {
  try {
    return new URL(url).hostname === 'mcp.slack.com'
  } catch {
    return false
  }
}

/** Linear's default branch shape, for an issue whose suggested branch did not come back: `eng-123-fix-the-login`. */
export function issueBranch(issue: Pick<Issue, 'identifier' | 'title'>): string {
  const slug = issue.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
  return slug === '' ? issue.identifier.toLowerCase() : `${issue.identifier.toLowerCase()}-${slug}`
}

/** A pull (or merge) request linked to a ticket. */
export interface PullRequest {
  url: string
  /** `owner/repo#123`, or the link's own text. */
  label: string
  /** The attachment's title: the pull request's own title. */
  title?: string
  /** Number, when the URL says it. */
  number?: number
}

/** One entry in a ticket's activity, oldest first. */
export type Activity =
  | { kind: 'created'; at: string; actor?: string }
  | { kind: 'state'; at: string; state: string; stateType: string }
  | { kind: 'comment'; at: string; actor?: string; body: string; reply: boolean }

/** What a ticket's detail shows beyond its card: description, linked pull requests, activity. */
export interface IssueDetail {
  identifier: string
  description?: string
  project?: string
  milestone?: string
  labels: string[]
  pullRequests: PullRequest[]
  activity: Activity[]
}

/** Linear's rich-text mentions (`<issue …>ENG-1</issue>`) and Markdown links as their text, for plain display. */
export function plainMentions(body: string): string {
  return body
    .replace(/<([a-z][\w-]*)\b[^>]*>([^<]*)<\/\1>/g, '$2')
    .replace(/\[([^\]\n]+)\]\(<?https?:\/\/[^\s)>]+>?\)/g, '$1')
}
