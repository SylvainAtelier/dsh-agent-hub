/**
 * dsh-agent-hub host half. The hub integrates several agents; each module
 * mounts here. Usage module: reads Claude, Codex and MiniMax subscription
 * quotas on demand and serves them as one overview over DSH's authenticated
 * /api RPC bridge. No background timers — the browser asks, each source
 * answers from a short TTL cache, and a failed read falls back to the
 * account's last good snapshot (persisted, so it survives restarts).
 * A Claude Agent turn marks the Claude quota as moved, so it is re-read soon
 * after rather than on the slow idle schedule. The same overview carries token
 * totals folded from DSH's session logs (see usage/tokens.ts); a session's log
 * is folded once more just before DSH deletes it, so its tokens stay counted.
 * Claude module: registers the `claude-agent` model route, which hands
 * conversation turns to long-lived Claude Code sessions (see claude/adapter.ts).
 * Cursor module: registers the `cursor-agent` route, which hands turns to the
 * Cursor CLI's agent over ACP and closes each with its usage (see cursor/adapter.ts).
 * Its local commands and skills (`.cursor/commands`, `.cursor/skills`) join
 * DSH's `/` menu as skills (see cursor/commands.ts).
 * Qoder module: registers the `qoder-agent` route, which hands turns to Qoder
 * CLI CN's agent over ACP (the shared ACP route, acp/route.ts), and runs a
 * remote-control daemon per configured workspace, so the Qwen glasses and the
 * Qoder app can send tasks to this machine (see qoder/daemon.ts).
 * Hermes module: registers the `hermes-agent` route, one model per Hermes
 * persona, each turn run by `hermes-acp` in that persona's home, on its own
 * model, memory and skills (the shared ACP route; see hermes/route.ts).
 * 接力 (relay) module: what Qoder and the Hermes personas did elsewhere (the
 * glasses' tasks, terminal sessions, Telegram chats, cron runs), read from
 * their own stores, and taking a thread over into a DSH session on that
 * agent's route (see relay/index.ts).
 * Remote module: serves DSH to this machine's own Tailscale account, so a
 * phone can follow and continue any session (see remote/index.ts).
 * Device module: a paired M5Stack Cardputer follows every session over the
 * local network, answers approvals for every model, sends a session text or
 * voice, and dictates into this computer's front app (see device/index.ts).
 * Team module: bots — a model route whose models are the configured bots
 * (see team/route.ts) — and, where the profile mounts DSH's Agent Teams
 * runtime, group chats: @bot invites a bot into a session's team, and the
 * Lead stays quiet while the user talks to members (see team/index.ts).
 * Connectors module: remote MCP servers (Linear, Notion, …) signed in to once
 * and served to every model, Claude Agent included (see connectors/index.ts).
 * Global instructions: one Markdown text added to every conversation's system
 * prompt, Claude Agent's included (see prompt.ts).
 * Blocked commands: whole-filesystem find scans refused for every model before
 * they run (see guard.ts).
 * Files module: the code editor's reads, guarded writes, search, definitions
 * and formatting, inside registered workspaces only (see files/service.ts).
 * Settings sync: the profile's settings and plugin selection shared through a
 * git remote, versioned, with conflicts resolved by hand (see sync/index.ts).
 * Review module: pull requests waiting for my review, each analysed in a
 * read-only session of its own into a review sheet, posted after I confirm
 * (see review/index.ts).
 * Appearance: the interface and code fonts every browser of this DSH applies,
 * a phone's included (see appearance.ts).
 * Restart: DSH Desktop quits and opens again, applying plugin changes that need
 * a fresh process (see restart/index.ts).
 */

import { discussionEvents, mountDiscussions } from './discussion/index.ts'
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { checkClaudeSignIn, forgetClaudeAccount, forgetClaudeUsage, readClaude } from './usage/sources/claude.ts'
import { AUTH_METHOD, AuthNotices, isAuthText } from './claude/auth.ts'
import { ACCOUNTS_METHOD, ClaudeAccounts } from './claude/accounts.ts'
import { readCodex, type CredentialRecords } from './usage/sources/codex.ts'
import { minimaxKey, readMinimax } from './usage/sources/minimax.ts'
import { readCursor } from './usage/sources/cursor.ts'
import { qoderReader } from './usage/sources/qoder.ts'
import { createHub } from './usage/hub.ts'
import { createTokenLedger, metered } from './usage/tokens.ts'
import { OVERVIEW_METHOD } from './usage/types.ts'
import { ClaudeAgentAdapter, PROVIDER, type AdapterHost } from './claude/adapter.ts'
import { CURSOR_PROVIDER, CursorAgentAdapter, type CursorHost } from './cursor/adapter.ts'
import { CursorSkills, type SkillRegistry } from './cursor/commands.ts'
import { AcpRoute } from './acp/route.ts'
import { QODER_PROVIDER, qoderProfile } from './qoder/route.ts'
import { findHermes, HERMES_PROVIDER, hermesProfile, hermesRoot, listPersonas } from './hermes/route.ts'
import { RemoteWorkspaces } from './qoder/daemon.ts'
import { probeQoder } from './qoder/probe.ts'
import { prepareWorkspace } from './qoder/worktree.ts'
import { Bridge } from './bridge/service.ts'
import { isDirectory, startBridgeServer } from './bridge/server.ts'
import { BRIDGE_FILE, installCli, withPath } from './bridge/cli.ts'
import { GLASSES_METHOD, type GlassesRequest } from './bridge/types.ts'
import { findPty, glassesTargets, installPost, post as postToGlasses } from './bridge/post.ts'
import { newTaskUrl } from './qoder/types.ts'
import { QoderSessions } from './relay/qoder.ts'
import { findQoder } from './qoder/cli.ts'
import { Relay } from './relay/index.ts'
import { RELAY_METHOD, type RelayRequest } from './relay/types.ts'
import { createRemote } from './remote/index.ts'
import { REMOTE_METHOD, type RemoteAction } from './remote/types.ts'
import { createPhoneSettings, PHONE_SETTINGS_METHOD, type PhoneSettingsRequest, type SettingsService } from './remote/settings.ts'
import { GitService, runGit, workspaceGate, type Workspaces } from './git/service.ts'
import { GIT_METHOD } from './git/types.ts'
import { CONSOLE_METHOD, ConsoleService } from './git/console.ts'
import { FilesService } from './files/service.ts'
import { FILES_METHOD } from './files/types.ts'
import { ownPrettier } from './files/format.ts'
import { createSuggest, resolveRoute, type Llm, type Route } from './git/message.ts'
import type { Config } from './config.ts'
import { listModelGroups, MODELS_METHOD, type ModelCatalog } from './models.ts'
import { createVisibility, type LlmRegistry, type Visibility } from './visibility.ts'
import { createTeam, quietReply, TEAM_METHOD, type Agent, type Subagents, type Team, type Teams } from './team/index.ts'
import { personaText, validProfiles } from './team/profiles.ts'
import { TEAM_NOTE } from './team/mentions.ts'
import { assemblyBot, BotAdapter, shapeAssembly, type Assembly, type BotHost } from './team/route.ts'
import { BOT_ROUTE } from './team/types.ts'
import { createUserMessage, isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import { helperRequest, helperRoute, type HelperSettings } from './claude/helper.ts'
import type { ToolRegistry } from './claude/bridge.ts'
import { Connectors, type CredentialStore, type Mounted } from './connectors/index.ts'
import { ConnectorScope, connectorOfTool, withoutHidden } from './connectors/scope.ts'
import { CONNECTORS_METHOD, type ConnectorRequest } from './connectors/types.ts'
import { RepoIndex, type RepoWorkspaces } from './repos/index.ts'
import { REPOS_METHOD, type ReposRequest } from './repos/types.ts'
import { BoardService } from './board/index.ts'
import { LocalTasks } from './board/store.ts'
import { BOARD_METHOD } from './board/types.ts'
import { Canvases } from './canvas/index.ts'
import { ReaderService } from './reader/index.ts'
import { FAVORITES, FEEDS } from './reader/records.ts'
import { READER_METHOD } from './reader/types.ts'
import { CANVAS_METHOD, type CanvasRequest } from './canvas/types.ts'
import type { WorktreeList, WorktreeOpened } from './git/types.ts'
import { appendedPrompt, instructionsText, withInstructions, withSection } from './prompt.ts'
import { blockedReason } from './guard.ts'
import { ConfigSync, type PluginManager, type ProfileLocation } from './sync/index.ts'
import type { CollectionStore } from './sync/collection.ts'
import { PINS, type Pin } from './sync/portable.ts'
import { SYNC_METHOD, type SyncRequest } from './sync/types.ts'
import { PluginUpdates } from './plugins/index.ts'
import { PendingOps } from './plugins/pending.ts'
import { PLUGIN_UPDATES_METHOD, type UpdateManager, type UpdateProfile } from './plugins/types.ts'
import { ReviewService, type Route as ReviewRoute, type SessionHost } from './review/index.ts'
import { REVIEW_METHOD } from './review/types.ts'
import { dailyTitle, ReviewSchedule, REVIEW_SCHEDULE_METHOD, type ReviewScheduleHost, type ReviewSyncTools, type ReviewToolScope } from './review/schedule.ts'
import { APPEARANCE_METHOD } from './appearance.ts'
import { hostLocale, localized, setLocaleSource } from './locale.ts'
import { codexPlugin, MODULES_METHOD, setUpCodex, type BundleManager, type ModuleName, type ModulesRequest } from './modules.ts'
import { createRestart, type TaskSources } from './restart/index.ts'
import { RESTART_METHOD } from './restart/types.ts'
import { REVIEW_SECTION } from './review/prompt.ts'
import { reviewCommandReason, reviewTrusts, reviewWriteReason, trackedFolders, writtenPath } from './review/guard.ts'
import { AlertsService } from './alerts/index.ts'
import { ALERTS_METHOD, type AlertsRequest } from './alerts/types.ts'
import { parseSentryIssuesUrl } from './connectors/sentry.ts'
import { createScheduledSend, type NativeSchedule } from './schedule/index.ts'
import { createDevice, DEVICE_METHOD, Typer, typerPath, type Device } from './device/index.ts'
import { Palette, PALETTE_METHOD } from './palette/index.ts'
import type { ApprovalRequest, Outcome } from './device/control.ts'
import type { SessionEvent, SessionRef } from './device/view.ts'
import type { DeviceRequest } from './device/types.ts'
import { SCHEDULE_METHOD } from './schedule/types.ts'
import { AutomationService, type AutomationNativeHost } from './automation/service.ts'
import { AUTOMATION_METHOD, type ScriptTask } from './automation/types.ts'
import { resolveAutomationRoute } from './automation/route.ts'
import { runScriptTask } from './automation/runner.ts'
import { createRunLog } from './automation/log.ts'
import { automationManagement, isLocalRequest, requireAutomationLocal, saveAutomationDefinitions } from './automation-management.ts'
import { automationNode, qoderCnInstalled } from './automation-preset.ts'

/** Routes that answer conversation turns only (an external agent runs each turn): never a helper, commit-message or default route. */
const TURNS_ONLY: readonly string[] = [PROVIDER, CURSOR_PROVIDER, QODER_PROVIDER, HERMES_PROVIDER]

export const name = 'dsh-agent-hub'
export const inject = ['credentials']

export { Config } from './config.ts'

/** The slices of the host context this plugin touches. */
interface HostContext {
  /** This plugin's fiber; the settings policy is registered against it. */
  fiber: unknown
  /** Cordis's built-in logger: a property of every context, not a service `get` can read. */
  logger: { warn(message: string): void }
  get(name: string): unknown
  effect(body: () => () => void, label?: string): void
  inject(deps: string[], body: (ctx: HostContext & Services) => void): void
  /** `loader/volatile-update` carries the paths of the volatile sections that changed, e.g. `[['remote']]`. */
  on(event: 'loader/volatile-update', listener: (paths: string[][]) => void): () => void
  on(event: 'agent/created' | 'agent/disposed', listener: (event: { agent: Agent }) => void): () => void
  on(event: 'llm/adapters-updated', listener: () => void): () => void
  /** The plugin manager's install stream, under the `requestId` the caller gave `installBundle`. */
  on(event: 'plugin-manager/install-log' | 'plugin-manager/install-state', listener: (event: unknown) => void): () => void
  /** A durable storage write; the workspace registry's records are table `workspaces` of domain `workspace`. */
  on(event: 'domain/changed', listener: (change: { domain: string; table: string; key: string; operation: 'put' | 'deleted'; value?: { path?: string; createdAt?: string; updatedAt?: string } }) => void): () => void
  /** Mount a child plugin under this scope (a connector's mcp-client instance). */
  plugin(plugin: unknown, config: unknown): Mounted
  on(event: 'system-prompt/assemble', listener: (assembly: Assembly, context: AssemblyContext, next: () => Promise<Assembly>) => Promise<Assembly>, options: { prepend: boolean }): () => void
  on(event: 'llm/stream', listener: (options: { sessionId?: unknown }, next: () => AsyncIterable<object>) => AsyncIterable<object>, options: { global: boolean; prepend: boolean }): () => void
  /** A session's agent started or finished a turn. */
  on(event: 'agent/status', listener: (event: { agent: { id: string }; status: string }) => void): () => void
  /** DSH's approval answerers, outermost first; `next` asks the rest (the browser's dialog). */
  on(event: 'approval/request', listener: (request: ApprovalRequest, next: () => Promise<Outcome>) => Promise<Outcome>, options: { global: boolean; prepend: boolean }): () => void
  /** Every event appended to a session's log. */
  on(event: 'session/event', listener: (session: SessionRef, event: SessionEvent) => void, options: { global: boolean }): () => void
}

/** DSH's session controller (`ctx.sessionController`), as far as reviews open and drive sessions. */
interface SessionController {
  create(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string }>
  resolveAgent(sessionId: string): Promise<{ agent: unknown } | { error: unknown }>
  selectModel(request: { sessionId: string; provider: string; model: string }): Promise<unknown>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(request: { sessionId: string; content: Array<{ type: 'text'; text: string }>; requestId: string }, signal: AbortSignal): Promise<unknown>
  /** Stop the session's turn in flight; what is queued for it stays. */
  cancel(request: { sessionId: string }): unknown
  /** Its Agent controller: picking a session's model there leaves the default model new agents get alone. */
  agents?: { selectForNextRequest?(agent: unknown, selection: ReviewRoute): void }
}

type AssemblyContext = Parameters<typeof assemblyBot>[1]

interface Services {
  connection: Connection
  webServer: { port: number }
  llm: {
    registerAdapter(providers: string[], adapter: ClaudeAgentAdapter | CursorAgentAdapter | AcpRoute | BotAdapter): (() => void) & { replace?(providers: string[]): void }
    registration(provider: string): { adapter: unknown }
  }
  settings: { configure(policy: { auto: boolean }, fiber: unknown): () => void }
  agents: { list(): Agent[]; get(id: string): Agent | undefined }
  agentTeams: Teams
  subagents: Subagents
  skills: SkillRegistry
  tools: ToolRegistry & {
    /** A synchronous check before every tool execution; a returned string refuses it. Returns the disposer. */
    guard(check: (exec: { name: string; arguments?: Record<string, unknown>; agent?: { id: string; session?: { header?: { cwd?: string } } } }) => string | undefined): () => void
  }
}

interface Connection {
  /** DSH's launch-token URL for a base URL; opening it mints a browser session. */
  authenticatedUrl?(baseUrl: string): string
  fetch: {
    register(route: {
      path: string
      methods: string[]
      requestBody: 'buffered'
      fetch(request: Request): Promise<Response>
    }): () => void
  }
}

/** Pass a stream through unchanged, showing each chunk to `look` on the way. */
async function* tapped(source: AsyncIterable<object>, look: (chunk: object) => void): AsyncIterable<object> {
  for await (const chunk of source) {
    look(chunk)
    yield chunk
  }
}

function dshHome(): string {
  const raw = process.env.DSH_HOME?.trim()
  return raw ? raw.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), '.dsh')
}

let ripgrepBinary: Promise<string | undefined> | undefined
/** `@vscode/ripgrep`'s binary for this platform; undefined where its platform package is missing. */
function ripgrepPath(): Promise<string | undefined> {
  ripgrepBinary ??= import('@vscode/ripgrep').then((module: { rgPath: string }) => module.rgPath, () => undefined)
  return ripgrepBinary
}

type Handle = (payload: Record<string, unknown>, signal: AbortSignal, request: Request) => Promise<unknown>

/** One `agent-hub/*` method on DSH's authenticated /api bridge. A thrown error's message reaches the browser; `failure` stands in for one without. */
function rpc(connection: Connection, method: string, handle: Handle, failure: string): () => void {
  return connection.fetch.register({
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('invalid JSON', { status: 400 })
      }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success || envelope.data.method !== method) return new Response('invalid RPC envelope', { status: 400 })
      const payload = (envelope.data.payload ?? {}) as Record<string, unknown>
      let result
      try {
        result = { ok: true, value: await handle(payload, request.signal, request) }
      } catch (error) {
        result = { ok: false, error: { code: 'internal', message: error instanceof Error && error.message !== '' ? error.message : failure, details: { issues: [] } } }
      }
      return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result })
    },
  })
}

export function apply(ctx: HostContext, config: Config): void {
  // Server-side text (notices, titles, default prompts, errors) in DSH's UI language.
  ctx.effect(() => setLocaleSource(hostLocale(ctx)), 'dsh-agent-hub: UI language')
  // Ship our own settings page (设置 → Agent Hub) rather than a generated form.
  ctx.inject(['settings'], (scope) => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'dsh-agent-hub: settings page'))
  // The Loader notifies only this fiber, not the inject scopes below; fan out by section.
  const sectionChanged = new Set<(section: string) => void>()
  ctx.on('loader/volatile-update', (paths) => {
    for (const section of new Set(paths.map((path) => path[0]))) {
      if (section !== undefined) for (const listener of sectionChanged) listener(section)
    }
  })
  /** Run `listener` on each change of one config section; returns the disposer. */
  const onSection = (name: string, listener: () => void): () => void => {
    const onChange = (section: string): void => { if (section === name) listener() }
    sectionChanged.add(onChange)
    return () => { sectionChanged.delete(onChange) }
  }
  /** Run `start` while a module is switched on (设置 → Agent Hub → 功能模块); its disposer runs once it is off. */
  const whileOn = (name: ModuleName, start: () => () => void): () => void => {
    let stop: (() => void) | undefined
    const follow = (): void => {
      const on = config.modules.get()[name]
      if (on && stop === undefined) stop = start()
      else if (!on && stop !== undefined) {
        stop()
        stop = undefined
      }
    }
    follow()
    const off = onSection('modules', follow)
    return () => {
      off()
      stop?.()
      stop = undefined
    }
  }
  /** A request to a module that is off: the page that asked is about to drop it. */
  const moduleOff = (name: ModuleName): void => {
    if (!config.modules.get()[name]) throw new Error(`The ${name} module is off: turn it on in Settings → Agent Hub → Modules`)
  }

  // Host services, read on use: each may come and go while the plugin stays mounted.
  const warn = (tag: string) => (message: string): void => {
    if (message !== '') ctx.logger.warn(`[${tag}] ${message}`)
  }
  const defaultRoute = (): Route | undefined => (ctx.get('agentDefaultModel') as { currentSelection(): Route } | undefined)?.currentSelection()
  let visibility: Visibility | undefined
  /** Every registered model, hidden providers included. */
  const catalog = (): ModelCatalog | undefined => visibility?.unfiltered ?? ctx.get('llm') as ModelCatalog | undefined
  /** DSH's llm service with its calls counted in the token ledger: they reach no session log under the model that answers. */
  const meteredLlm = (): Llm | undefined => {
    const service = ctx.get('llm') as Llm | undefined
    return service === undefined ? undefined : {
      stream: (options) => {
        const { provider, model } = options as Route
        return metered(service.stream(options), (usage) => void tokens.record(provider, model, usage))
      },
    }
  }
  /** The model that answers what Claude Agent, Cursor and the bots cannot, for these settings. */
  const helperFor = (settings: HelperSettings): Promise<Route | undefined> => helperRoute(settings, defaultRoute, catalog, [...TURNS_ONLY, BOT_ROUTE])
  ctx.inject(['connection'], (scope) => scope.effect(() => mountDiscussions(
    ctx as unknown as Parameters<typeof mountDiscussions>[0], scope.connection, {
      dir: join(dshHome(), 'dsh-agent-hub', 'discussions'),
      settings: () => config.discussion.get(),
      route: async () => {
        const own = config.discussion.get()
        if (own.provider?.trim() || own.model?.trim()) {
          if (!own.provider?.trim() || !own.model?.trim()) throw new Error('Choose both a discussion provider and model')
          return { provider: own.provider.trim(), model: own.model.trim() }
        }
        return helperFor(config.claude.get())
      },
      llm: meteredLlm,
      events: discussionEvents(ctx),
      instructions: () => config.prompt.get().instructions ?? '',
      log: warn('discussion'),
      // Discussions kept with a reader article, and answered by a bot in its persona.
      document: (owner) => reader.document(owner),
      bots: () => bots().map(({ id, description }) => ({ id, ...(description?.trim() ? { description: description.trim() } : {}) })),
      bot: async (id) => {
        const bot = bots().find((profile) => profile.id === id)
        const route = bot === undefined ? undefined : await botRoute(bot)
        return bot === undefined || route === undefined ? undefined : { route, persona: personaText(bot) }
      },
    },
  ), 'dsh-agent-hub: selection discussions'))

  const credentials = ctx.get('credentials') as CredentialRecords
  const claudeAccounts = new ClaudeAccounts(join(dshHome(), 'dsh-agent-hub', 'claude-accounts.json'))
  /** The live Claude Agent route, so removing a worktree can close the Claude Code processes working in it. */
  let claudeAdapter: ClaudeAgentAdapter | undefined
  /** The live Cursor route, likewise. */
  let cursorAdapter: CursorAgentAdapter | undefined
  /** The live Qoder route, likewise. */
  let qoderRoute: AcpRoute | undefined
  /** The live Hermes route, likewise. */
  let hermesRoute: AcpRoute | undefined
  /** The live git service: the board and reviews start worktrees through it. */
  let gitService: GitService | undefined
  // Repositories: registered workspaces grouped by the git repository they are in.
  const repoIndex = new RepoIndex(() => ctx.get('workspaceRegistry') as RepoWorkspaces | undefined)
  // Connectors linked to repositories serve only the sessions working in one of them (connectors/scope.ts).
  const connectorScope = new ConnectorScope(() => config.connectors.get().servers, repoIndex)
  // Bots: agent profiles (设置 → Agent Hub → Bots), read live.
  const bots = (): ReturnType<typeof validProfiles> => validProfiles(config.team.get().agents)

  // Connectors module: each connected server is an instance of DSH's own mcp-client, mounted
  // here with the stored sign-in, so its tools are in the registry for every model.
  let connectors: Connectors | undefined
  ctx.inject(['tools'], (scope) => scope.effect(() => {
    let client: unknown
    const log = warn('connectors')
    const current = new Connectors({
      entries: () => config.connectors.get().servers,
      credentials: credentials as unknown as CredentialStore,
      key: (id) => credentialKey('dsh-agent-hub', `connector-${id}`),
      mount: (options) => (client === undefined ? undefined : scope.plugin(client, options)),
      toolCount: (id) => {
        try {
          return scope.tools.schemas().filter((schema) => schema.name.startsWith(`mcp__${id}__`)).length
        } catch {
          return 0
        }
      },
      log,
      repoOf: (dir) => repoIndex.repoOf(dir),
    })
    connectors = current
    const off = onSection('connectors', () => void current.sync())
    // Resolved by the host like every @deepseek-ai package; a host without it keeps the rest of the plugin.
    import('@deepseek-ai/dsh-mcp-client').then((module) => { client = module }, (error: unknown) => {
      log(`DSH's MCP client is unavailable: ${(error as Error).message}`)
    }).then(() => current.sync()).catch((error: unknown) => {
      log(`initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      off()
      if (connectors === current) connectors = undefined
      current.dispose()
    }
  }, 'dsh-agent-hub: connectors'))

  const bundles = (): BundleManager | undefined => ctx.get('pluginManager') as BundleManager | undefined
  const hub = createHub({
    claude: (force) => readClaude(Date.now, claudeAccounts, force),
    // Off, Codex leaves the usage card; without its plugin, the card offers to install or enable it.
    codex: async () => {
      if (!config.modules.get().codex) return []
      const plugin = await codexPlugin(bundles())
      if (plugin !== 'on') return [{ id: 'codex', provider: 'codex', windows: [], fetchedAt: 0, error: { code: plugin === 'missing' ? 'plugin-missing' : 'plugin-off' } }]
      return readCodex(credentials, credentialKey('codex-subscription', 'accounts'))
    },
    minimax: () => readMinimax(credentials, { credentialKey, credentialRef }),
    cursor: () => readCursor(),
    qoder: qoderReader(),
  }, join(dshHome(), 'dsh-agent-hub', 'usage.json'), { log: warn('usage') })
  ctx.effect(() => onSection('modules', () => hub.invalidate('codex')), 'dsh-agent-hub: codex usage switch')
  const tokens = createTokenLedger({
    root: join(dshHome(), 'sessions'),
    file: join(dshHome(), 'dsh-agent-hub', 'tokens.json'),
    names: () => Object.fromEntries((catalog()?.listProviders() ?? []).map((provider) => [provider.id, provider.name])),
  })
  // Warm the caches so the first open waits on neither the Claude CLI's cold start nor the first log scan.
  hub.overview().catch(() => {})
  tokens.read().catch(() => {})

  // Every deletion (one session, or a whole workspace's) goes through the persistence service:
  // fold the log once more first, so the ledger keeps its tokens.
  ctx.inject(['sessionPersistence'], (scope) => scope.effect(() => {
    type Delete = (this: unknown, id: string, ...rest: unknown[]) => Promise<unknown>
    const persistence = scope.get('sessionPersistence') as { delete?: Delete } | undefined
    const original = persistence?.delete
    if (persistence === undefined || typeof original !== 'function') return () => {}
    const own = Object.prototype.hasOwnProperty.call(persistence, 'delete')
    const wrapped: Delete = async function (id, ...rest) {
      await tokens.capture(id)
      return original.call(this, id, ...rest)
    }
    persistence.delete = wrapped
    return () => {
      if (persistence.delete !== wrapped) return
      if (own) persistence.delete = original
      else delete persistence.delete
    }
  }, 'dsh-agent-hub: token ledger on session deletion'))

  // The account registry stores names and CLI directories only, never OAuth material.
  const accounts: Handle = async (payload) => {
    await claudeAccounts.ready
    const id = typeof payload.id === 'string' ? payload.id : claudeAccounts.selected
    if (payload.op === 'list') return claudeAccounts.list()
    let result: unknown
    if (payload.op === 'add') result = await claudeAccounts.add(typeof payload.name === 'string' ? payload.name : '')
    else if (payload.op === 'select') result = await claudeAccounts.select(id)
    else if (payload.op === 'rename') result = await claudeAccounts.rename(id, typeof payload.name === 'string' ? payload.name : '')
    else if (payload.op === 'remove') {
      result = await claudeAccounts.remove(id)
      forgetClaudeAccount(id)
    } else if (payload.op === 'check') {
      if (!claudeAccounts.has(id)) throw new Error('Unknown Claude account')
      const check = await checkClaudeSignIn(isAuthText, id, claudeAccounts.dir(id))
      await claudeAccounts.record(id, check.account)
      forgetClaudeAccount(id)
      result = check
    } else throw new Error('Unknown Claude account operation')
    hub.invalidate('claude')
    return result
  }

  // Claude sign-in failures: the browser long-polls this and opens a re-sign-in prompt.
  const authNotices = new AuthNotices()
  ctx.effect(() => () => authNotices.dispose(), 'dsh-agent-hub: claude sign-in notices')
  const auth: Handle = async (payload) => {
    if (payload.op !== 'account' && payload.op !== 'check') return authNotices.wait(payload.boot, payload.since)
    await claudeAccounts.ready
    if (payload.op === 'account') return claudeAccounts.list().accounts.find((item) => item.id === payload.id)
    const id = typeof payload.id === 'string' && claudeAccounts.has(payload.id) ? payload.id : claudeAccounts.selected
    return checkClaudeSignIn(isAuthText, id, claudeAccounts.dir(id))
  }

  // Remote module: phone access over Tailscale.
  ctx.inject(['connection', 'webServer'], (scope) => scope.effect(() => {
    const log = warn('remote')
    const start = () => createRemote({
      file: join(dshHome(), 'dsh-agent-hub', 'remote.json'),
      httpsPort: config.remote.get().httpsPort,
      http: config.remote.get().http,
      upstream: () => scope.webServer.port,
      signIn: (base) => scope.connection.authenticatedUrl?.(base),
      log,
    })
    let remote = start()
    let changes: Promise<void> = Promise.resolve()
    let generation = 0
    let stopped = false
    let needsRestart = false
    const report = (error: unknown): void => log(error instanceof Error ? error.message : String(error))
    // Hand ownership to the replacement only after the old instance has drained and removed its rule.
    const replace = (): Promise<void> => {
      const current = generation
      changes = changes.then(async () => {
        if (stopped || !needsRestart) return
        await remote.dispose()
        if (stopped || current !== generation) return
        remote = start()
        needsRestart = false
        remote.resume()
      }).catch(report)
      return changes
    }
    // Only the port and the http hop shape the serve rules; the phone-settings switch leaves them alone.
    const rules = (): string => `${config.remote.get().httpsPort}:${config.remote.get().http}`
    let wanted = rules()
    const off = onSection('remote', () => {
      const next = rules()
      if (next === wanted) return
      wanted = next
      ++generation
      needsRestart = true
      void replace()
    })
    const actions = new Set<RemoteAction>(['status', 'enable', 'disable'])
    const unregister = rpc(scope.connection, REMOTE_METHOD, async (payload) => {
      const action = actions.has(payload.action as RemoteAction) ? payload.action as RemoteAction : 'status'
      await changes
      if (needsRestart && !stopped) await replace()
      return remote.run(action)
    }, 'Phone access failed')
    remote.resume()
    return () => {
      off()
      unregister()
      stopped = true
      generation++
      void changes.then(() => remote.dispose()).catch(report)
    }
  }, 'dsh-agent-hub: phone access'))

  // Git module: the sidebar's source control pane. Git only runs inside registered workspaces.
  ctx.inject(['connection'], (scope) => scope.effect(() => {
    const registry = (): readonly string[] | undefined => {
      const service = scope.get('workspaceRegistry') as { list(): Array<{ path: string }> } | undefined
      return service?.list().map((workspace) => workspace.path)
    }
    // Commit messages: the configured route, else the default agent model (unless that is
    // Claude Agent itself, which only answers conversation turns).
    const route = (): Route | undefined => resolveRoute(config.git.get(), () => {
      const selection = defaultRoute()
      return selection === undefined || TURNS_ONLY.includes(selection.provider) || selection.provider === BOT_ROUTE ? undefined : selection
    })
    const suggest = createSuggest(meteredLlm, route, () => config.git.get())
    const gate = workspaceGate(registry)
    const git = new GitService(gate, undefined, suggest, {
      workspaces: () => scope.get('workspaceRegistry') as Workspaces | undefined,
      release: (dir) => (claudeAdapter?.release(dir) ?? 0) + (cursorAdapter?.release(dir) ?? 0) + (qoderRoute?.release(dir) ?? 0) + (hermesRoute?.release(dir) ?? 0),
      identities: () => config.git.get().identities ?? [],
      strict: () => config.git.get().strict !== false,
      bots: () => bots().map(({ id, description }) => ({ id, ...(description?.trim() ? { description: description.trim() } : {}) })),
      // A rebase handed to a bot: a session on that bot in the tree, told the task at once.
      agent: async (input) => {
        const host = sessions()
        if (host === undefined) throw new Error('DSH sessions are unavailable')
        const session = await host.start({
          cwd: input.cwd,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          title: input.title,
          route: { provider: BOT_ROUTE, model: input.bot },
        })
        await host.send(session, input.text, `rebase-${session}`)
        return session
      },
    })
    gitService = git
    // Strict identity mode holds for terminals and agents too, before the pane is ever opened.
    void git.syncStrict()
    // Opening a project opens all of it: a workspace just registered brings its repository's
    // other working trees along. Only a creation writes a record whose `updatedAt` is its
    // `createdAt`; every later write (a rename, a new session) stamps a fresh `updatedAt`.
    const offAdopt = scope.on('domain/changed', (change) => {
      if (change.domain !== 'workspace' || change.table !== 'workspaces' || change.operation !== 'put') return
      const record = change.value
      if (typeof record?.path === 'string' && record.createdAt !== undefined && record.createdAt === record.updatedAt) void git.adopt(record.path)
    })
    // Deleting a worktree's workspace from the sidebar deletes its folder too; its sessions
    // stay, under Ungrouped. A deletion names only the id, so paths are remembered by id.
    const paths = new Map<string, string>()
    for (const workspace of (scope.get('workspaceRegistry') as Workspaces | undefined)?.list() ?? []) paths.set(workspace.id, workspace.path)
    const offDrop = scope.on('domain/changed', (change) => {
      if (change.domain !== 'workspace' || change.table !== 'workspaces') return
      if (change.operation === 'put') {
        if (typeof change.value?.path === 'string') paths.set(change.key, change.value.path)
        return
      }
      if (change.operation !== 'deleted') return
      const path = paths.get(change.key)
      paths.delete(change.key)
      if (path !== undefined) {
        git.dropWorktree(path).catch((error: unknown) => {
          warn('git')(`could not remove worktree ${path}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    })
    // The pane's command line, behind the same workspace gate; it also asks DSH's terminal
    // controller which of the pane's terminals are running a command.
    const shell = new ConsoleService(gate, () => scope.get('terminalController'))
    // The code editor, behind the same gate. ripgrep is the binary VS Code ships; git grep stands in without it.
    const files = new FilesService(gate, { ripgrep: ripgrepPath, prettier: ownPrettier })
    const unregister = [
      rpc(scope.connection, GIT_METHOD, (payload) => git.handle(payload), 'Git failed'),
      rpc(scope.connection, CONSOLE_METHOD, (payload) => shell.handle(payload), 'Command failed'),
      rpc(scope.connection, FILES_METHOD, (payload, signal) => files.handle(payload, signal), 'File request failed'),
    ]
    return () => {
      if (gitService === git) gitService = undefined
      offAdopt()
      offDrop()
      for (const off of unregister) off()
      shell.dispose()
      git.dispose()
    }
  }, 'dsh-agent-hub: git rpc'))
  const viaGit = async (request: Record<string, unknown>): Promise<unknown> => {
    if (gitService === undefined) throw new Error('git is unavailable')
    const reply = await gitService.handle(request)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.value
  }
  /** Worktrees for the board and reviews, through the live git service. */
  const trees = {
    list: async (cwd: string) => (await viaGit({ cwd, op: 'worktree-list' }) as WorktreeList).worktrees,
    open: async (cwd: string, path: string) => await viaGit({ cwd, op: 'worktree-open', path }) as WorktreeOpened,
    add: async (cwd: string, branch: string, base?: string) => await viaGit({ cwd, op: 'worktree-add', branch, ...(base === undefined ? {} : { base }) }) as WorktreeOpened,
  }
  // The sidebar's refresh: what the creation hook missed (a repository registered before this
  // version, or while the plugin was not running; a worktree added later from the command line).
  const adoptAll = async (): Promise<number> => {
    const git = gitService
    if (git === undefined) throw new Error('git is unavailable')
    let added = 0
    for (const group of await repoIndex.list()) added += await git.adopt(group.key)
    return added
  }

  // Settings sync: every plugin's settings and the plugin selection, through a git remote.
  const profileLocation = (): ProfileLocation | undefined => {
    const profile = ctx.get('profileContext') as Partial<ProfileLocation> | undefined
    return typeof profile?.dir === 'string' && typeof profile.patchPath === 'string' ? { dir: profile.dir, patchPath: profile.patchPath } : undefined
  }
  type FileLock = <T>(file: string, operation: () => Promise<T>, options?: { waitMs?: number }) => Promise<T>
  // DSH's own profile writers (plugin manager, settings) hold this lock; a host without the package just writes.
  const fileLock: Promise<FileLock | undefined> = import('@deepseek-ai/dsh-atomic-write')
    .then((module: { withFileLock?: FileLock }) => module.withFileLock, () => undefined)
  // Upgrades a hot-reloading host refuses wait for the next restart, which runs them (restart/index.ts).
  const pending = new PendingOps(join(dshHome(), 'dsh-agent-hub'))
  try {
    const dir = profileLocation()?.dir
    if (dir !== undefined) pending.prune((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {})
  } catch {
    // Kept as listed; the restart helper installs what is already there harmlessly.
  }
  const restartUpgrades = {
    list: () => pending.list(),
    job: async () => {
      const profile = ctx.get('profileContext') as UpdateProfile | undefined
      if (typeof profile?.dir !== 'string') return undefined
      const manager = ctx.get('pluginManager') as UpdateManager | undefined
      const registry = (await manager?.registries?.().catch(() => undefined))?.registry ?? undefined
      return pending.job(profile, registry)
    },
  }
  // Make the running DSH take in a profile sync wrote: with hot reload the whole profile, plugins
  // included; without it the profile patch through the Loader, plugins at the next restart.
  type Hmr = { runExclusive<T>(work: () => Promise<T>): Promise<T>; reconcileProfile(): Promise<{ pending: unknown[]; restartReason?: string }> }
  type Boot = { readProfilePatches?(app: string, profile: unknown): unknown; reconcileProfilePatches?(root: unknown, patches: unknown, app: string): Promise<unknown> }
  const activate = async (packages: boolean): Promise<{ restart: boolean }> => {
    const hmr = ctx.get('hmr') as Hmr | undefined
    if (hmr !== undefined) {
      const result = await hmr.runExclusive(() => hmr.reconcileProfile())
      return { restart: result.restartReason !== undefined || result.pending.length > 0 }
    }
    if (packages) return { restart: true }
    const boot = await import('@deepseek-ai/dsh-app-boot').then((module: Boot) => module, () => undefined)
    if (boot?.readProfilePatches === undefined || boot.reconcileProfilePatches === undefined) return { restart: true }
    await boot.reconcileProfilePatches((ctx as unknown as { root: unknown }).root, boot.readProfilePatches('dsh', ctx.get('profileContext')), 'dsh')
    return { restart: false }
  }
  // Upgrade registry bundles through DSH's own installer, preserving its locks and build approvals.
  const pluginUpdates = new PluginUpdates({
    pending,
    manager: () => ctx.get('pluginManager') as UpdateManager | undefined,
    profile: () => {
      const profile = ctx.get('profileContext') as UpdateProfile | undefined
      return typeof profile?.dir === 'string' ? profile : undefined
    },
    hotReload: () => ctx.get('hmr') !== undefined,
    installEvents: (listener) => {
      const offLog = ctx.on('plugin-manager/install-log', (event) => listener('log', event))
      const offState = ctx.on('plugin-manager/install-state', (event) => listener('state', event))
      return () => { offLog(); offState() }
    },
  })
  ctx.effect(() => () => pluginUpdates.dispose(), 'dsh-agent-hub: plugin updates')
  // The reader: feeds and favorites travel with the settings; entries, read marks and texts stay here.
  const reader = new ReaderService({
    dir: join(dshHome(), 'dsh-agent-hub', 'reader'),
    bots: () => bots().map(({ id, description }) => ({ id, ...(description?.trim() ? { description: description.trim() } : {}) })),
    sessions: () => sessions(),
    log: warn('reader'),
  })
  ctx.effect(() => {
    const off = whileOn('reader', () => {
      reader.start()
      return () => reader.stop()
    })
    return () => {
      off()
      reader.dispose()
    }
  }, 'dsh-agent-hub: reader')
  // The clipboard window's helper, once it exists (it is made further down): it alone knows the pinned texts.
  let clipboard: Palette | undefined
  const pins: CollectionStore = {
    async get() {
      // A sync at startup may come before the window is made; give it a moment when the window is on.
      for (let wait = 0; clipboard === undefined && config.modules.get().palette && wait < 30; wait++) await new Promise((resolve) => setTimeout(resolve, 100))
      return clipboard?.pins(3000)
    },
    set: async (items) => await clipboard?.setPins(items as Pin[]) ?? false,
  }
  const configSync = new ConfigSync({
    dir: join(dshHome(), 'dsh-agent-hub', 'sync', basename(profileLocation()?.dir ?? 'default')),
    profile: profileLocation,
    settings: () => config.sync.get(),
    plugins: () => ctx.get('pluginManager') as PluginManager | undefined,
    collections: [{ collection: PINS, store: pins }, { collection: FEEDS, store: reader.feedStore }, { collection: FAVORITES, store: reader.favoriteStore }],
    hotReload: () => ctx.get('hmr') !== undefined,
    installEvents: (listener) => {
      const offLog = ctx.on('plugin-manager/install-log', (event) => listener('log', event))
      const offState = ctx.on('plugin-manager/install-state', (event) => listener('state', event))
      return () => { offLog(); offState() }
    },
    machine: { home: homedir(), platform: process.platform, name: hostname().replace(/\.local$/i, '') },
    pending,
    activate,
    lock: async (file, operation) => {
      const lock = await fileLock
      return lock === undefined ? operation() : lock(file, operation, { waitMs: 120_000 })
    },
    log: warn('sync'),
  })
  // Once per DSH start: a reload of this plugin (a settings edit, a sync applying them) does not pull again.
  if (!configSync.resumed) void configSync.start()

  // Canvases: the folder the models write HTML pages to, and the panel that browses it; it also
  // keeps the @session snapshots too large to hand Claude Code or Cursor inline.
  const canvases = new Canvases(join(dshHome(), 'canvases'), join(dshHome(), 'dsh-agent-hub', 'references'), {
    sessions: join(dshHome(), 'sessions'),
    archived: (sessionId) => (ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined)?.archivedSessionIds?.includes(sessionId) === true,
  })
  // The board: Linear tickets and local tasks.
  const board = new BoardService({
    repos: () => repoIndex.list(),
    linear: () => connectors?.linears() ?? [],
    slack: () => connectors?.slacks() ?? [],
    bots,
    // Answered the way a comment of mine on a pull request is: the bot's model, else the review helper.
    botText: (bot, brief) => review.botText(bot, brief),
    tasks: new LocalTasks(join(dshHome(), 'dsh-agent-hub', 'board.json')),
    worktrees: trees.list,
    openWorktree: trees.open,
    addWorktree: trees.add,
  })

  // Review module: pull requests waiting for my review, analysed in read-only sessions into sheets.
  const sessions = (): SessionHost | undefined => {
    const controller = ctx.get('sessionController') as SessionController | undefined
    const registry = ctx.get('workspaceRegistry') as { archiveSession(id: string): Promise<unknown> } | undefined
    if (controller === undefined) return undefined
    return {
      async start(input) {
        const { sessionId } = await controller.create(input.workspaceId === undefined ? { cwd: input.cwd } : { workspaceId: input.workspaceId })
        if (input.route !== undefined) {
          const resolved = await controller.resolveAgent(sessionId)
          const pick = controller.agents?.selectForNextRequest
          if ('agent' in resolved && typeof pick === 'function') pick.call(controller.agents, resolved.agent, input.route)
          else {
            // Only the public path: it also saves the pick as the default, so put the default back.
            const defaults = ctx.get('agentDefaultModel') as { currentSelection(): ReviewRoute; saveSelection?(selection: ReviewRoute): Promise<unknown> } | undefined
            const before = defaults?.currentSelection()
            await controller.selectModel({ sessionId, ...input.route })
            if (before !== undefined) await defaults?.saveSelection?.(before).catch(() => {})
          }
        }
        await controller.rename({ sessionId, title: input.title }).catch(() => {})
        return sessionId
      },
      async send(sessionId, text, requestId) {
        await controller.prompt({ sessionId, content: [{ type: 'text', text }], requestId }, AbortSignal.timeout(60_000))
      },
      async cancel(sessionId) {
        await controller.cancel({ sessionId })
      },
      async archive(sessionId) {
        await registry?.archiveSession(sessionId)
      },
    }
  }
  const reviewHelper = (): Promise<ReviewRoute | undefined> => {
    const own = config.review.get()
    return helperFor(own.helperProvider?.trim() && own.helperModel?.trim() ? own : config.claude.get())
  }
  /** Where a bot answers one request outside a session. Claude Agent and Cursor answer conversations only: a bot on them lends its persona to the helper model. */
  const botRoute = (bot: { provider?: string; model?: string }): Promise<ReviewRoute | undefined> => {
    const provider = bot.provider?.trim() ?? ''
    const model = bot.model?.trim() ?? ''
    return provider !== '' && model !== '' && ![...TURNS_ONLY, BOT_ROUTE].includes(provider) ? Promise.resolve({ provider, model }) : reviewHelper()
  }
  const review = new ReviewService({
    settings: () => config.review.get(),
    repos: () => repoIndex.list(),
    sessions,
    bots,
    helper: reviewHelper,
    botRoute: botRoute,
    llm: meteredLlm,
    trees,
    log: warn('review'),
  })
  const reviewSchedule = new ReviewSchedule({
    file: join(dshHome(), 'dsh-agent-hub', 'review-schedule.json'),
    settings: () => config.review.get(),
    repositories: async () => config.review.get().repos.length > 0,
    writable: () => (ctx.get('settings') as SettingsService | undefined)?.writable === true,
    schedule: () => ctx.get('schedule') as ReviewScheduleHost | undefined,
    setAuto: async (enabled) => {
      if (config.review.get().auto === enabled) return
      const settings = ctx.get('settings') as SettingsService | undefined
      const entry = settings?.describe({ redactSecrets: true }).find((item) => item.ns === 'agent-hub')
      if (!settings?.writable || !entry) throw new Error('Review settings are not writable')
      await settings.mutate('agent-hub', [{ op: 'set', path: ['review', 'auto'], value: enabled }], entry.revision)
    },
    start: async () => {
      const host = sessions()
      const route = await reviewHelper()
      if (!host || !route) throw new Error('Choose an available helper model for daily reviews')
      return host.start({ cwd: dshHome(), title: dailyTitle(), route })
    },
    prepare: async (sessionId) => {
      const controller = ctx.get('sessionController') as SessionController | undefined
      const route = await reviewHelper()
      if (!controller || !route) throw new Error('Choose an available helper model for daily reviews')
      const resolved = await controller.resolveAgent(sessionId)
      const pick = controller.agents?.selectForNextRequest
      // The installed host exposes this Session-local path; unlike selectModel it does not change the default.
      if (!('agent' in resolved) || typeof pick !== 'function') throw new Error('Session-local helper model selection is unavailable')
      const agent = resolved.agent as { ctx?: { get(name: string): unknown } }
      const tools = agent.ctx?.get('tools') as ReviewToolScope | undefined
      if (!tools || typeof tools.presentAs !== 'function' || typeof tools.restrict !== 'function') throw new Error('Session-local tool presentation is unavailable')
      reviewSchedule.prepareTools(agent, tools)
      pick.call(controller.agents, resolved.agent, route)
    },
    rename: async (sessionId, title) => {
      const controller = ctx.get('sessionController') as SessionController | undefined
      if (!controller) throw new Error('DSH sessions are unavailable')
      return controller.rename({ sessionId, title })
    },
    run: (signal) => review.runScheduled(signal),
  })
  // Register only after the host's native scheduler and tools are ready. No plugin timer remains.
  ctx.inject(['schedule', 'tools', 'sessionController', 'settings'], (scope) => scope.effect(() => {
    const offTool = reviewSchedule.register(scope.tools as unknown as ReviewSyncTools)
    // Native schedule delivery may recreate a cold Agent: bind its local presentation before assembly.
    const offCreated = scope.on('agent/created', ({ agent }) => {
      if (!reviewSchedule.isSession(agent.id)) return
      const tools = (agent.ctx as unknown as { get(name: string): unknown }).get('tools') as ReviewToolScope
      reviewSchedule.prepareTools(agent, tools)
    })
    const offDisposed = scope.on('agent/disposed', ({ agent }) => reviewSchedule.releaseTools(agent))
    void reviewSchedule.initialize().then((status) => { if (status.error) warn('review-schedule')(status.error) })
    return () => { offCreated(); offDisposed(); offTool() }
  }, 'dsh-agent-hub: native review schedule'))
  ctx.inject(['connection'], (scope) => scope.effect(() => rpc(scope.connection, REVIEW_SCHEDULE_METHOD,
    (payload, _signal, request) => {
      if (payload.action !== 'status') {
        // Same remote-settings policy as the phone bridge; authentication remains the host's responsibility.
        if (!isLocalRequest(request) &&config.remote.get().phoneSettings !== true) throw new Error('Remote settings are disabled')
        if (!(ctx.get('settings') as SettingsService | undefined)?.writable) throw new Error('Review settings are read-only')
      }
      return reviewSchedule.handle(payload)
    }, 'Review scheduling failed'), 'dsh-agent-hub: review schedule rpc'))
  ctx.effect(() => () => reviewSchedule.dispose(), 'dsh-agent-hub: review schedule lifetime')

  // Each trusted script gets its own bound Session; native Schedule remains the only clock.
  const automationRoute = async (definition: ScriptTask): Promise<Route> => {
    const profiles = bots()
    const route = resolveAutomationRoute(definition, profiles, defaultRoute())
    const directory = catalog()
    if (!directory?.resolveModel) throw new Error('Model resolution is unavailable for script tasks')
    // Resolve both the selected Bot and its actual model; catalog metadata does not prove tool support.
    // External agent routes are rejected by resolveAutomationRoute, and non-calling turns stay delivered.
    await directory.resolveModel(route.provider, route.model)
    if (route.provider === BOT_ROUTE) {
      const bot = profiles.find((item) => item.id === route.model)!
      const inner = bot.provider && bot.model ? { provider: bot.provider, model: bot.model } : defaultRoute()
      if (!inner) throw new Error('The task Bot has no executable model')
      await directory.resolveModel(inner.provider, inner.model)
    }
    return route
  }
  const automationProfile = createHash('sha256').update(profileLocation()?.dir ?? dshHome()).digest('hex').slice(0, 20)
  const automationLog = createRunLog(join(dshHome(), 'dsh-agent-hub', 'automation', 'automation.log'))
  const automation = new AutomationService({
    file: join(dshHome(), 'dsh-agent-hub', 'automation', `${automationProfile}.json`),
    settings: () => config.automation.get(),
    schedule: () => ctx.get('schedule') as AutomationNativeHost | undefined,
    start: async (definition) => {
      const host = sessions()
      if (!host) throw new Error('DSH sessions are unavailable')
      return host.start({ cwd: definition.cwd, title: definition.title, route: await automationRoute(definition) })
    },
    prepare: async (sessionId, definition) => {
      const route = await automationRoute(definition)
      const controller = ctx.get('sessionController') as SessionController | undefined
      const resolved = await controller?.resolveAgent(sessionId)
      const pick = controller?.agents?.selectForNextRequest
      if (!resolved || !('agent' in resolved) || typeof pick !== 'function') throw new Error('Session-local task model selection is unavailable')
      const agent = resolved.agent as { ctx?: { get(name: string): unknown } }
      const tools = agent.ctx?.get('tools') as ReviewToolScope | undefined
      if (!tools || typeof tools.presentAs !== 'function' || typeof tools.restrict !== 'function') throw new Error('Session-local task tool restrictions are unavailable')
      automation.prepareTools(agent, tools)
      pick.call(controller!.agents, resolved.agent, route)
    },
    log: automationLog,
    run: (definition, signal, runId) => runScriptTask(definition, signal, runId, undefined, (info) => automationLog({ event: 'runner', id: definition.id, runId, ...info })),
    timeZone: () => 'Asia/Shanghai',
  })
  const manageAutomation = automationManagement({
    service: automation,
    definitions: () => config.automation.get().tasks,
    validateRoute: automationRoute,
    save: (definitions, expected) => saveAutomationDefinitions(ctx.get('settings') as SettingsService | undefined, definitions, expected),
    preset: () => {
      const node = automationNode({ execPath: process.execPath, electron: process.versions.electron, path: process.env.PATH ?? process.env.Path ?? '', platform: process.platform })
      return {
        id: 'qoder-cn-daily-credit', title: localized({ zh: 'Qoder 中国版每日积分检查', en: 'Qoder CN daily credit check' }),
        command: node, args: [fileURLToPath(new URL('./bin/qoder-daily-credit.mjs', import.meta.url))],
        cwd: dshHome(), provider: '', model: '', timeoutMs: 60_000,
      }
    },
    presetAvailable: () => qoderCnInstalled({ platform: process.platform, appData: process.env.APPDATA }),
  })
  ctx.inject(['schedule', 'tools', 'sessionController', 'settings'], (scope) => scope.effect(() => {
    const offTool = automation.register(scope.tools as unknown as ReviewSyncTools)
    const offCreated = scope.on('agent/created', ({ agent }) => {
      if (!automation.isSession(agent.id)) return
      const tools = (agent.ctx as unknown as { get(name: string): unknown }).get('tools') as ReviewToolScope
      automation.prepareTools(agent, tools)
    })
    const offDisposed = scope.on('agent/disposed', ({ agent }) => automation.releaseTools(agent))
    const changed = (): void => { void automation.reconfigure().catch(() => warn('automation')('Task preparation failed. Check the configured model, Bot and native task.')) }
    const offSettings = onSection('automation', changed)
    const offBots = onSection('team', changed)
    const offModels = scope.on('llm/adapters-updated', changed)
    void automation.initialize().catch(() => warn('automation')('Task initialization failed. Open script task settings to inspect the native task.'))
    return () => { offCreated(); offDisposed(); offSettings(); offBots(); offModels(); offTool() }
  }, 'dsh-agent-hub: native script tasks'))
  ctx.inject(['connection'], (scope) => scope.effect(() => rpc(scope.connection, AUTOMATION_METHOD,
    async (payload, _signal, request) => {
      // Commands/paths can run anything as this user: remote management follows the computer-only phone-settings switch.
      requireAutomationLocal(request, config.remote.get().phoneSettings === true)
      if (!['list', 'preset', 'cancel'].includes(String(payload.action)) && (ctx.get('settings') as SettingsService | undefined)?.writable !== true) throw new Error('Script task settings are read-only')
      return manageAutomation(payload)
    }, 'Script task request failed'), 'dsh-agent-hub: script task management'))
  ctx.effect(() => () => automation.dispose(), 'dsh-agent-hub: script task lifetime')
  const alerts = new AlertsService({
    settings: () => config.alerts.get(),
    sentry: () => {
      const target = parseSentryIssuesUrl(config.alerts.get().url)
      return target === undefined ? undefined : connectors?.sentry(target)
    },
    sessions,
    bots,
    trees,
    log: warn('alerts'),
  })
  ctx.effect(() => {
    const off = onSection('review', () => {
      void reviewSchedule.reconfigure()
      void review.warm()
    })
    const offReviewHelper = onSection('claude', () => { void reviewSchedule.reconfigure() })
    const offAlerts = onSection('alerts', () => { void alerts.warm() })
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      review.status(agent.id, status === 'running')
      void alerts.status(agent.id, status === 'running')
    })
    // Emitted before the turn's end (agent/status idle): the review run fails with the model's own error.
    // (Not in the event map this plugin type-checks against, though DSH's agent loop emits it.)
    const onError = ctx.on.bind(ctx) as unknown as (name: 'agent/error', listener: (payload: { agent: { id: string }; error: unknown }) => void) => () => void
    const offError = onError('agent/error', ({ agent, error }) => review.turnError(agent.id, error))
    // The workspace registry may still be loading: index the sheets again a little later.
    void review.warm()
    void alerts.warm()
    const again = setTimeout(() => void review.warm(), 15_000)
    return () => {
      clearTimeout(again)
      off()
      offReviewHelper()
      offAlerts()
      offStatus()
      offError()
      alerts.dispose()
      review.dispose()
    }
  }, 'dsh-agent-hub: review')

  // Device module: a Cardputer on the desk follows every session, answers approvals, sends
  // voice and dictates into this computer's front app (see device/index.ts).
  /** Its approvals, which the glasses answer too (`dsh approve`), while it runs. */
  let deviceApprovals: Device | undefined
  ctx.inject(['connection'], (scope) => scope.effect(() => whileOn('device', () => {
    const log = warn('device')
    const store = credentials as unknown as CredentialStore
    const sttCredential = credentialKey('dsh-agent-hub', 'device-stt')
    const device = createDevice({
      file: join(dshHome(), 'dsh-agent-hub', 'devices.json'),
      settings: () => config.device.get(),
      sessions,
      providerName: (id) => catalog()?.listProviders().find((provider) => provider.id === id)?.name,
      sttKey: async (provider) => {
        if (provider === 'minimax') return minimaxKey(credentials, { credentialKey, credentialRef })
        const record = await store.readRecord(sttCredential)
        const token = (record?.payload as { token?: unknown } | undefined)?.token
        return typeof token === 'string' && token !== '' ? { key: token } : {}
      },
      setSttKey: async (key) => {
        if (key === '') await store.deleteRecord(sttCredential)
        else await store.modifyRecord(sttCredential, () => ({ kind: 'grant', payload: { type: 'token', token: key } }))
      },
      typer: new Typer(typerPath(), log),
      log,
      // The glasses' hand-offs and bells: their approvals wait for `dsh approve` as for the device.
      follows: (sessionId) => bridge.follows(sessionId),
    })
    deviceApprovals = device
    // Sessions open before the plugin started: fold their recent history.
    const agents = ctx.get('agents') as { list(): Array<{ session?: SessionRef & { snapshotEvents?(): readonly unknown[] } }> } | undefined
    for (const agent of agents?.list() ?? []) {
      if (agent.session !== undefined) device.seed(agent.session, (agent.session.snapshotEvents?.() ?? []) as SessionEvent[])
    }
    const offApproval = ctx.on('approval/request', device.answer, { global: true, prepend: true })
    const offEvents = ctx.on('session/event', (session, event) => device.observe(session, event), { global: true })
    // THINKING: a reasoning block starting in a session's model stream.
    const offStream = ctx.on('llm/stream', (options, next) => {
      if (!device.online || options.sessionId === undefined || !isAgentLoopRequest(options)) return next()
      const sessionId = String(options.sessionId)
      return tapped(next(), (chunk) => device.stream(sessionId, chunk))
    }, { global: true, prepend: true })
    const offSection = onSection('device', () => device.reconfigure())
    const unregister = rpc(scope.connection, DEVICE_METHOD, (payload) => device.handle(payload as DeviceRequest), 'Device request failed')
    return () => {
      unregister()
      offSection()
      offStream()
      offEvents()
      offApproval()
      if (deviceApprovals === device) deviceApprovals = undefined
      void device.dispose()
    }
  }), 'dsh-agent-hub: cardputer'))

  // Clipboard history and translation window: the native helper owns the window, the hotkey and the
  // history; this keeps it running and answers its translations (see palette/index.ts).
  ctx.inject(['connection'], (scope) => scope.effect(() => {
    const base = join(dshHome(), 'dsh-agent-hub')
    const palette = new Palette({
      settings: () => ({ ...config.palette.get(), enabled: config.modules.get().palette }),
      bots,
      route: (bot) => bot === undefined ? reviewHelper() : botRoute(bot),
      llm: meteredLlm,
      binary: typerPath(),
      page: join(dirname(fileURLToPath(import.meta.url)), 'palette.html'),
      db: join(base, 'clipboard.db'),
      data: join(base, 'palette-web'),
      log: warn('palette'),
    })
    clipboard = palette
    palette.reconfigure()
    const offSection = onSection('palette', () => palette.reconfigure())
    const offModule = onSection('modules', () => palette.reconfigure())
    // A bot added or renamed is offered in the window: the helper is told again with the team's settings.
    const offTeam = onSection('team', () => palette.reconfigure())
    const unregister = rpc(scope.connection, PALETTE_METHOD, async (payload) => {
      if (payload.op === 'theme' && (payload.theme === 'light' || payload.theme === 'dark')) return palette.setTheme(payload.theme)
      return palette.status()
    }, 'Clipboard window request failed')
    return () => {
      unregister()
      offSection()
      offModule()
      offTeam()
      if (clipboard === palette) clipboard = undefined
      palette.dispose()
    }
  }, 'dsh-agent-hub: clipboard window'))

  /**
   * The shell commands a session may not run: the blocked commands, for every session; and for a
   * review session whatever is not read-only. A response or Sentry session has no guard of its own.
   */
  const blocked = (command: unknown, sessionId: string | undefined): string | undefined => {
    const global = blockedReason(command, config.prompt.get())
    if (global !== undefined) return global
    if (alerts.sessionMode(sessionId) !== undefined) return undefined
    return review.sessionRepo(sessionId) === undefined ? undefined : reviewCommandReason(command)
  }
  /** The project a read-only review session is guarded in. */
  const guardedRepo = (sessionId: string | undefined): string | undefined => review.sessionRepo(sessionId)
  /** Its folders holding tracked files: read as its session assembles a request, so they are known by its first write. */
  const trackedOf = trackedFolders(runGit)
  const primeGuard = (sessionId: string | undefined): void => {
    const repo = guardedRepo(sessionId)
    if (repo !== undefined) trackedOf(repo)
  }
  /** The tools and files a guarded review session may not mutate. */
  const refused = (tool: string, input: Record<string, unknown> | undefined, sessionId: string | undefined, cwd: string | undefined): string | undefined => {
    const repo = guardedRepo(sessionId)
    return repo === undefined ? undefined : reviewWriteReason(writtenPath(tool, input), repo, cwd ?? repo, trackedOf(repo))
  }
  /** What a guarded session runs without asking. */
  const trusted = (tool: string, input: Record<string, unknown> | undefined, sessionId: string | undefined, cwd: string | undefined): boolean => {
    if (review.responding(sessionId) || alerts.sessionMode(sessionId) !== undefined) return blockedReason(input?.command, config.prompt.get()) === undefined
    const repo = guardedRepo(sessionId)
    return repo !== undefined
      && reviewTrusts(tool, input, repo, cwd ?? repo, (command) => blockedReason(command, config.prompt.get()) ?? reviewCommandReason(command), trackedOf(repo))
  }

  /**
   * What Claude Agent and Cursor share: the session's instructions and guards, and DSH's background
   * requests (compaction, session titles), which another model answers (helper.ts) so the turn that
   * triggered them does not fail. Counted under the model that answers.
   */
  const turnHost = (name: string) => ({
    instructions: (sessionId: string) => {
      primeGuard(sessionId)
      return appendedPrompt(instructionsText(config.prompt.get(), canvases.dir), [review.section(sessionId), alerts.section(sessionId)].filter(Boolean).join('\n\n') || undefined)
    },
    blocked: (command: unknown, sessionId: string) => blocked(command, sessionId),
    trusted: (tool: string, input: Record<string, unknown>, sessionId: string, cwd?: string) => trusted(tool, input, sessionId, cwd),
    references: canvases,
    async *delegate<T extends { provider: string; model: string }>(options: T): AsyncIterable<object> {
      const route = await helperFor(config.claude.get())
      const llm = meteredLlm()
      if (route === undefined || llm === undefined) {
        throw new LlmError(`${name} only answers conversation turns, and DSH has no other model for this request: set one in ${localized({ zh: '设置', en: 'Settings' })} → Agent Hub → Claude Agent`, 'UNSUPPORTED_REQUEST')
      }
      yield* llm.stream(helperRequest(options, route))
    },
  })

  // Claude module: Claude Code sessions as a model route in DSH's model selector.
  ctx.inject(['llm'], (scope) => scope.effect(() => {
    const adapter = new ClaudeAgentAdapter({
      ...turnHost('Claude Agent'),
      accounts: claudeAccounts,
      agents: () => scope.get('agents') as ReturnType<AdapterHost['agents']>,
      tools: () => scope.get('tools') as ToolRegistry | undefined,
      connectors: async (cwd) => {
        const hidden = await connectorScope.hidden(cwd)
        return (connectors?.connected() ?? []).filter((id) => !hidden.has(id))
      },
      approval: () => scope.get('approval') as ReturnType<AdapterHost['approval']>,
      log: warn('claude-agent'),
      authFailed: (detail, account) => {
        forgetClaudeAccount(account)
        hub.touch('claude')
        authNotices.report(detail, account)
      },
      // The subscription quota just moved: the usage glance re-reads it on its next poll.
      turnFinished: (account) => { forgetClaudeUsage(account); hub.touch('claude') },
      catalogFile: join(dshHome(), 'dsh-agent-hub', 'claude-models.json'),
      // On disk: Desktop keeps no host log, and these lines explain turns that broke off.
      trace: (event, fields) => {
        try {
          appendFileSync(join(dshHome(), 'dsh-agent-hub', 'claude-trace.log'), `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`)
        } catch (error) {
          warn('claude-agent')(`trace not written: ${(error as Error).message}`)
        }
      },
      refused: (tool, input, sessionId, cwd) => refused(tool, input, sessionId, cwd),
    }, () => config.claude.get())
    const unregister = scope.llm.registerAdapter([PROVIDER], adapter)
    claudeAdapter = adapter
    return () => {
      if (claudeAdapter === adapter) claudeAdapter = undefined
      unregister()
      adapter.dispose()
    }
  }, 'dsh-agent-hub: claude agent route'))

  // Cursor module: the Cursor CLI's agent (over ACP) as a model route in DSH's model selector.
  ctx.inject(['llm'], (scope) => scope.effect(() => {
    const adapter = new CursorAgentAdapter({
      ...turnHost('Cursor'),
      agents: () => scope.get('agents') as ReturnType<CursorHost['agents']>,
      approval: () => scope.get('approval') as ReturnType<CursorHost['approval']>,
      log: warn('cursor'),
      // The plan's usage just moved: the usage glance re-reads it on its next poll.
      turnFinished: () => hub.touch('cursor'),
      catalogFile: join(dshHome(), 'dsh-agent-hub', 'cursor-models.json'),
    })
    const unregister = scope.llm.registerAdapter([CURSOR_PROVIDER], adapter)
    cursorAdapter = adapter
    return () => {
      if (cursorAdapter === adapter) cursorAdapter = undefined
      unregister()
      adapter.dispose()
    }
  }, 'dsh-agent-hub: cursor route'))

  // Qoder module: Qoder CLI CN's agent (over ACP) as a model route in DSH's model selector.
  ctx.inject(['llm'], (scope) => scope.effect(() => {
    const route = new AcpRoute(qoderProfile(), {
      ...turnHost('Qoder'),
      seed: (sessionId) => relay.seed(sessionId),
      agents: () => scope.get('agents') as ReturnType<CursorHost['agents']>,
      approval: () => scope.get('approval') as ReturnType<CursorHost['approval']>,
      log: warn('qoder'),
      catalogFile: join(dshHome(), 'dsh-agent-hub', 'qoder-models.json'),
    })
    const unregister = scope.llm.registerAdapter([QODER_PROVIDER], route)
    qoderRoute = route
    return () => {
      if (qoderRoute === route) qoderRoute = undefined
      unregister()
      route.dispose()
    }
  }, 'dsh-agent-hub: qoder route'))

  // Hermes module: each Hermes persona (over ACP) as a model in DSH's model selector.
  ctx.inject(['llm'], (scope) => scope.effect(() => {
    const route = new AcpRoute(hermesProfile(), {
      ...turnHost('Hermes'),
      seed: (sessionId) => relay.seed(sessionId),
      agents: () => scope.get('agents') as ReturnType<CursorHost['agents']>,
      approval: () => scope.get('approval') as ReturnType<CursorHost['approval']>,
      log: warn('hermes'),
    })
    const unregister = scope.llm.registerAdapter([HERMES_PROVIDER], route)
    hermesRoute = route
    return () => {
      if (hermesRoute === route) hermesRoute = undefined
      unregister()
      route.dispose()
    }
  }, 'dsh-agent-hub: hermes route'))

  // The glasses bridge: the `dsh` command Qoder's workers run (hand-offs to DSH models, the
  // glasses' inbox) and the composer's bell (see bridge/types.ts).
  const bridge = new Bridge({
    sessions,
    // The registry as the model selector shows it: hidden models are not offered to the glasses either.
    catalog: () => ctx.get('llm') as ModelCatalog | undefined,
    defaultRoute,
    bots,
    workspaces: () => (ctx.get('workspaceRegistry') as Workspaces | undefined)?.list() ?? [],
    isDirectory,
    holdsChanged: () => remoteWorkspaces.refresh(),
    approvals: () => deviceApprovals,
    // Where a notification goes (post.ts glassesTargets); none outside the desktop app.
    targets: (): Array<{ session: string; cwd: string }> => (glassesPty === undefined ? [] : glassesTargets(remoteWorkspaces.status().workspaces, recorded)),
    opener: (): string | undefined => {
      const env = remoteWorkspaces.status().workspaces.find((workspace) => workspace.phase === 'online' && workspace.env !== undefined)?.env
      return env === undefined ? undefined : newTaskUrl(env)
    },
    post: async (target, text) => {
      const cli = findQoder()
      const transcript = (await glassesSessions.files()).find((file) => file.id === target.session)?.file
      if (cli === undefined || glassesPty === undefined || transcript === undefined) return 'failed'
      const script = join(dshHome(), 'dsh-agent-hub', 'qoder-post.cjs')
      await installPost(script)
      return postToGlasses({ node: process.execPath, script, pty: glassesPty, cli }, { ...target, transcript }, text)
    },
    branch: async (cwd) => {
      const result = await runGit(['symbolic-ref', '-q', 'HEAD'], cwd, { read: true, timeoutMs: 3_000 })
      const full = result.code === 0 ? result.stdout.trim() : ''
      return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : undefined
    },
  })
  /** DSH's node-pty (a client of a glasses session needs a terminal); none outside the desktop app. */
  const glassesPty = findPty()
  const glassesSessions = new QoderSessions()
  /** The glasses' sessions in Qoder's own records, newest first: what a daemon just started does not list. */
  let recorded: Array<{ id: string; cwd: string }> = []
  /** The workspaces online when they were last read: read again only when that changes. */
  let recordedFor = ''
  const recall = (): void => {
    const online = remoteWorkspaces.status().workspaces.filter((workspace) => workspace.phase === 'online').map((workspace) => workspace.path).join('\n')
    if (online === recordedFor) return
    recordedFor = online
    void glassesSessions.list().then((sessions) => {
      recorded = sessions.flatMap((session) => (session.id.startsWith('qs_') && session.cwd !== undefined ? [{ id: session.id, cwd: session.cwd }] : []))
      bridge.retry()
    }, (error: unknown) => warn('bridge')(`Qoder sessions not read: ${(error as Error).message}`))
  }
  /** The folder holding the `dsh` launchers, once written: on the daemons' PATH. */
  let dshBin: string | undefined
  // Qoder remote control: a daemon per configured workspace while DSH runs, for the glasses and the Qoder app.
  const remoteWorkspaces = new RemoteWorkspaces({
    settings: () => config.qoder.get(),
    find: () => findQoder(),
    probe: probeQoder,
    log: warn('qoder-remote'),
    // Worktrees a task asks for go to DSH's worktree folder, through hooks run with the host's own runtime;
    // the `dsh` command and its Qoder skill are written alongside.
    prepare: async (repo) => {
      dshBin = await installCli({ node: process.execPath, dir: join(dshHome(), 'dsh-agent-hub') })
        .catch((error: unknown) => { warn('bridge')(`dsh command not installed: ${(error as Error).message}`); return dshBin })
      await prepareWorkspace(repo, { node: process.execPath, script: join(dshHome(), 'dsh-agent-hub', 'qoder-worktree.cjs') })
    },
    env: () => (dshBin === undefined ? {} : withPath(dshBin)),
    held: (path) => bridge.held(path),
  })
  ctx.effect(() => {
    const log = warn('bridge')
    const offEvents = ctx.on('session/event', (session, event) => bridge.observe(session, event), { global: true })
    const server = startBridgeServer(bridge, join(dshHome(), 'dsh-agent-hub', BRIDGE_FILE), log)
    server.catch((error: unknown) => log(`dsh bridge not started: ${(error as Error).message}`))
    return () => {
      offEvents()
      bridge.dispose()
      void server.then((started) => started.close(), () => {})
    }
  }, 'dsh-agent-hub: glasses bridge')
  ctx.effect(() => {
    remoteWorkspaces.sync()
    const off = onSection('qoder', () => remoteWorkspaces.sync())
    // A glasses session answering (or a daemon coming online, with the sessions Qoder recorded there) lets held notifications go.
    const offRetry = remoteWorkspaces.subscribe(() => {
      recall()
      bridge.retry()
    })
    return () => {
      offRetry()
      off()
      remoteWorkspaces.dispose()
    }
  }, 'dsh-agent-hub: qoder remote control')

  // 接力: what Qoder and the Hermes personas did elsewhere, and taking it over into a DSH session.
  const relay = new Relay({
    workspaces: remoteWorkspaces,
    hermesRoot: () => hermesRoot(),
    personas: () => listPersonas().map((persona) => persona.id),
    findHermes: () => findHermes(),
    findQoder: () => findQoder(),
    qoderModels: async () => (await qoderRoute?.models() ?? []).map((model) => model.id),
    sessions,
    archived: (sessionId) => (ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined)?.archivedSessionIds?.includes(sessionId) === true,
    file: join(dshHome(), 'dsh-agent-hub', 'relay.json'),
    log: warn('relay'),
  })
  ctx.effect(() => () => relay.dispose(), 'dsh-agent-hub: relay')

  // Global instructions: the last section of every DSH model's system prompt (Claude Agent gets them from its adapter).
  // A review session's own section follows them.
  ctx.inject(['llm'], (scope) => scope.effect(() => scope.on('system-prompt/assemble', async (_assembly, context, next) => {
    const sessionId = (context as { agent?: { id?: string } }).agent?.id
    // Agent creation can race the asynchronous binding read. Do not assemble unrestricted tools first.
    if (sessionId) await automation.whenReady()
    const taskSession = sessionId !== undefined && automation.isSession(sessionId)
    if (taskSession) {
      const agent = (context as { agent?: { ctx?: { get(name: string): unknown } } }).agent
      const tools = agent?.ctx?.get('tools') as ReviewToolScope | undefined
      if (!tools) throw new Error('Task tool restrictions are unavailable')
      automation.prepareTools(agent!, tools)
    }
    primeGuard(sessionId)
    const guarded = [review.section(sessionId), alerts.section(sessionId)].filter(Boolean).join('\n\n') || undefined
    const assembly = withSection(withInstructions(await next(), instructionsText(config.prompt.get(), canvases.dir)), REVIEW_SECTION, guarded)
    return taskSession ? { ...assembly, tools: assembly.tools.filter((tool) => tool.name === 'automation_run') } : assembly
  }, { prepend: true }), 'dsh-agent-hub: global instructions'))

  // Blocked commands and refused writes for DSH models, checked before their tools run (Claude Agent
  // gets a PreToolUse hook from its adapter).
  const SHELL_TOOLS = new Set(['bash', 'pwsh'])
  ctx.inject(['tools'], (scope) => scope.effect(() => scope.tools.guard((exec) => {
    const sessionId = exec.agent?.id
    const dailyRefusal = reviewSchedule.guard(exec.name, sessionId)
    if (dailyRefusal) return dailyRefusal
    const automationRefusal = automation.guard(exec.name, sessionId)
    if (automationRefusal) return automationRefusal
    if (SHELL_TOOLS.has(exec.name)) return blocked(exec.arguments?.command, sessionId)
    return refused(exec.name, exec.arguments, sessionId, exec.agent?.session?.header?.cwd)
  }), 'dsh-agent-hub: blocked commands'))

  // Cursor's commands and skills, the project's and the user's, in every session's `/` menu.
  ctx.inject(['skills'], (scope) => scope.effect(() => scope.skills.registerProvider((control) => new CursorSkills(control)), 'dsh-agent-hub: cursor commands'))

  // Connectors linked to repositories: a session working elsewhere is not told their tools (every
  // DSH model, each request), and a call to one anyway (a stale history, a teammate) is refused.
  // Claude Agent is bridged only the connectors its session may use (above); Cursor gets none.
  ctx.inject(['llm'], (scope) => scope.effect(() => scope.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const cwd = (context as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd
    return withoutHidden(assembly, await connectorScope.hidden(cwd))
  }, { prepend: true }), 'dsh-agent-hub: connector scope'))
  ctx.inject(['tools'], (scope) => scope.effect(() => scope.tools.guard((exec) => {
    const id = connectorOfTool(exec.name)
    if (id === undefined || !connectorScope.hiddenNow(exec.agent?.session?.header?.cwd).has(id)) return undefined
    return `The ${id} connector is linked to other repositories than this session's folder; its tools are not available here.`
  }), 'dsh-agent-hub: connector scope guard'))

  // Bots: one model route whose models are the bots. A bot's persona and tools shape the system
  // prompt of every agent running on it; the call itself goes to the bot's own model.
  ctx.inject(['llm'], (scope) => scope.effect(() => {
    const adapter = new BotAdapter({
      profiles: bots,
      adapter: (provider) => scope.llm.registration(provider).adapter as ReturnType<BotHost['adapter']>,
      defaultRoute,
    })
    const registration = scope.llm.registerAdapter([BOT_ROUTE], adapter)
    const offAssemble = scope.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      const bot = assemblyBot(assembly, context, bots())
      return bot === undefined ? assembly : shapeAssembly(assembly, bot)
    }, { prepend: true })
    // Model selectors list the bots anew.
    const off = onSection('team', () => registration.replace?.([BOT_ROUTE]))
    return () => {
      off()
      offAssemble()
      registration()
    }
  }, 'dsh-agent-hub: bot route'))

  // Which models DSH's selectors offer (hidden providers, enabled agent and Codex models) and the
  // reasoning effort a picked model starts at. Bots are their target model, effort included.
  ctx.inject(['llm'], (scope) => scope.effect(() => {
    const current = createVisibility(scope.llm as unknown as LlmRegistry, () => ({
      hiddenProviders: config.models.get().hiddenProviders,
      enabled: { [PROVIDER]: config.claude.get().models, 'openai-codex': config.codex.get().models, [CURSOR_PROVIDER]: config.cursor.get().models, [QODER_PROVIDER]: config.qoder.get().models, [HERMES_PROVIDER]: config.hermes.get().models },
      efforts: { effort: config.models.get().effort ?? '', rules: config.models.get().efforts },
      inherited: [BOT_ROUTE],
    }), warn('models'))
    visibility = current
    current.sync()
    const off = scope.on('llm/adapters-updated', () => current.sync())
    return () => {
      off()
      if (visibility === current) visibility = undefined
      current.dispose()
    }
  }, 'dsh-agent-hub: model visibility'))

  // Team module: only where the profile mounts DSH's Agent Teams runtime.
  let team: Team | undefined
  ctx.inject(['agents', 'agentTeams', 'subagents'], (scope) => scope.effect(() => {
    team = createTeam({
      agents: scope.agents,
      teams: scope.agentTeams,
      subagents: scope.subagents,
      onAgent: (event, listener) => scope.on(event, ({ agent }) => listener(agent)),
      profiles: bots,
      note: (text) => createUserMessage({ content: [{ type: 'text', text }], source: TEAM_NOTE }),
      log: warn('team'),
    })
    const off = onSection('team', () => team?.refresh())
    // A quiet Lead step (the user only talked to members, or a member answered the user) streams
    // its relay text instead of calling the Lead's model.
    const offStream = scope.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined || !isAgentLoopRequest(options)) return next()
      const text = team?.takeQuiet(String(options.sessionId))
      return text === undefined ? next() : quietReply(text)
    }, { global: true, prepend: true })
    return () => {
      offStream()
      off()
      team?.dispose()
      team = undefined
    }
  }, 'dsh-agent-hub: agent teams'))

  // Scheduled sends become ordinary official Schedule tasks, including cold Sessions.
  const scheduledSend = createScheduledSend({
    schedule: () => ctx.get('schedule') as NativeSchedule | undefined,
    selection: async (sessionId) => {
      const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined
      if (registry?.archivedSessionIds?.includes(sessionId)) throw new Error('Session is archived')
      const query = ctx.get('sessionQuery') as {
        observeSession(id: string): Promise<{
          header: { origin?: string }
          projections?: { values: { modelSelection?: { next?: Route | null; lastUsed?: Route | null } } }
          [Symbol.dispose](): void
        }>
      } | undefined
      if (query === undefined) throw new Error('Session query is unavailable')
      const observation = await query.observeSession(sessionId)
      try {
        if (observation.header.origin === 'subagent' || registry?.archivedSessionIds?.includes(sessionId)) throw new Error('Session is unavailable')
        const selection = observation.projections?.values.modelSelection
        return selection?.next ?? selection?.lastUsed ?? defaultRoute()
      } finally { observation[Symbol.dispose]() }
    },
    overview: async (route) => {
      // Only the selected service/account is relevant; slow unrelated accounts must not block scheduling.
      const quotas = route.provider === PROVIDER ? await readClaude(Date.now, claudeAccounts, true, true)
        : route.provider === 'openai-codex' ? await readCodex(credentials, credentialKey('codex-subscription', 'accounts'), Date.now, true)
          : route.provider === 'minimax-cn' || route.provider === 'minimax' ? await readMinimax(credentials, { credentialKey, credentialRef }, Date.now, route.provider, route.model)
            : route.provider === CURSOR_PROVIDER ? await readCursor(undefined, undefined, undefined, true) : []
      return { quotas, at: Date.now() }
    },
    profiles: bots,
    defaultRoute,
  })

  // The browser's methods on DSH's /api bridge whose handlers do not depend on the connection:
  // registered together, each with the line shown for a failure without a reason.
  const phoneSettings = createPhoneSettings({
    enabled: () => config.remote.get().phoneSettings === true,
    settings: () => ctx.get('settings') as SettingsService | undefined,
  })
  const methods: Record<string, [Handle, string]> = {
    // 设置 → Agent Hub on a phone, where DSH serves no configuration form; closed unless switched on here.
    [PHONE_SETTINGS_METHOD]: [(payload) => phoneSettings(payload as PhoneSettingsRequest), 'Phone settings request failed'],
    [CONNECTORS_METHOD]: [async (payload) => {
      const request = payload as ConnectorRequest
      if (connectors !== undefined) return connectors.handle(request)
      if (request.op === 'status' || request.op === undefined) return { connectors: [], issues: false }
      throw new Error('connectors unavailable')
    }, 'Connector request failed'],
    [OVERVIEW_METHOD]: [async (payload) => {
      // A client switched accounts in another plugin (Codex): its active flag must not wait out the cache.
      if (payload.invalidate === 'codex') hub.invalidate('codex')
      const force = payload.force === true
      const [overview, totals] = await Promise.all([hub.overview(force), tokens.read(force)])
      return { ...overview, tokens: totals }
    }, 'Usage overview failed'],
    [SCHEDULE_METHOD]: [scheduledSend, 'Scheduled send request failed'],
    // The 接力 panel: the threads, the glasses' workspaces, taking a thread over.
    [RELAY_METHOD]: [async (payload) => {
      moduleOff('relay')
      return relay.handle(payload as RelayRequest)
    }, 'Relay request failed'],
    // The composer's bell: tell the glasses when a session's turn ends.
    [GLASSES_METHOD]: [async (payload, signal) => {
      const request = payload as GlassesRequest
      if (request.op === 'arm') return bridge.arm(String(request.sessionId), request.on === true)
      return bridge.read(typeof request.boot === 'string' ? request.boot : undefined, typeof request.since === 'number' ? request.since : undefined, signal)
    }, 'Glasses notification request failed'],
    [ACCOUNTS_METHOD]: [accounts, 'Claude accounts request failed'],
    [AUTH_METHOD]: [auth, 'Claude sign-in check failed'],
    [SYNC_METHOD]: [(payload) => configSync.handle(payload as SyncRequest), 'Settings sync failed'],
    [PLUGIN_UPDATES_METHOD]: [(payload) => pluginUpdates.handle(payload), 'Plugin update request failed'],
    [REPOS_METHOD]: [(payload) => ((payload as ReposRequest).op === 'adopt' ? adoptAll() : repoIndex.handle(payload as ReposRequest)), 'Repository list failed'],
    [CANVAS_METHOD]: [(payload) => canvases.handle(payload as unknown as CanvasRequest), 'Canvas request failed'],
    [BOARD_METHOD]: [(payload) => board.handle(payload), 'Board request failed'],
    [READER_METHOD]: [async (payload) => {
      moduleOff('reader')
      return reader.handle(payload)
    }, 'Reader request failed'],
    [REVIEW_METHOD]: [(payload) => review.handle(payload), 'Review request failed'],
    [ALERTS_METHOD]: [(payload) => alerts.handle(payload as AlertsRequest), 'Sentry alerts request failed'],
    // The settings page's model pickers: DSH's registered models, minus Claude Agent, which only
    // answers conversation turns, and the bots. Read per request so sign-ins show up. `all` (the bot
    // editor and the model visibility settings) keeps both: a bot's turns are conversation turns.
    // Hidden models are listed too: the commit message may use one, and the visibility settings list them.
    // `all` also carries each model's own reasoning levels for the effort settings.
    [MODELS_METHOD]: [async (payload) => {
      const llm = catalog()
      return llm === undefined ? [] : listModelGroups(llm, payload.all === true ? [] : [...TURNS_ONLY, BOT_ROUTE], payload.all === true)
    }, 'Model list failed'],
    // Appearance: read by every browser at startup, a phone's too, where the settings form is not served.
    [APPEARANCE_METHOD]: [async () => config.appearance.get(), 'Appearance request failed'],
    // Which optional modules are on, read by every browser (a phone's too) to show their panels; and the Codex plugin.
    [MODULES_METHOD]: [async (payload) => {
      const request = payload as ModulesRequest
      if (request.op === 'codex') {
        const result = await setUpCodex(bundles(), request.action)
        hub.invalidate('codex')
        return result
      }
      return { modules: config.modules.get(), codex: await codexPlugin(bundles()) }
    }, 'Modules request failed'],
    // The sidebar's restart button: DSH Desktop only, with what the restart would interrupt.
    [RESTART_METHOD]: [createRestart({ agents: () => ctx.get('agents') as ReturnType<TaskSources['agents']>, jobs: () => ctx.get('jobs') as ReturnType<TaskSources['jobs']> }, undefined, undefined, restartUpgrades), 'Restart failed'],
    [TEAM_METHOD]: [async (payload) => {
      if (payload.op === 'members') return typeof payload.sessionId === 'string' && team !== undefined ? team.roster(payload.sessionId) : { addressable: false, members: [], bots: [] }
      return { available: team !== undefined }
    }, 'Team request failed'],
  }
  ctx.inject(['connection'], (scope) => scope.effect(() => {
    const unregister = Object.entries(methods).map(([method, [handle, failure]]) => rpc(scope.connection, method, handle, failure))
    return () => { for (const off of unregister) off() }
  }, 'dsh-agent-hub: rpc'))
}
