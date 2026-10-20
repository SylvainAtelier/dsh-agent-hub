/**
 * The plugin's configuration, one section per module. Every section is
 * `.volatile()`: the 设置 → Agent Hub page edits it through DSH's settings
 * service, which persists to the profile's cordis.patch.yml, and the Loader
 * commits the new values into the running plugin without remounting it. Code
 * therefore keeps the section reference and calls `get()` on each use.
 */

import z from '@deepseek-ai/schemastery'
import type { DiscussionSettings } from './discussion/types.ts'
import type { AdapterSettings } from './claude/adapter.ts'
import type { MessageSettings } from './git/message.ts'
import type { IdentitySettings } from './git/identity.ts'
import type { AgentProfile } from './team/profiles.ts'
import type { ConnectorEntry } from './connectors/types.ts'
import type { PromptSettings } from './prompt.ts'
import type { EffortRule } from './efforts.ts'
import { SCAN_RULES } from './guard.ts'
import type { SyncSettings } from './sync/index.ts'
import { LOCAL_SETTINGS } from './sync/portable.ts'
import type { ReviewSettings } from './review/index.ts'
import { DEFAULT_STYLE } from './review/prompt.ts'
import type { BoardSettings } from './board/types.ts'
import type { AlertsSettings } from './alerts/types.ts'
import { DEFAULT_UI_SCALE, FONTS, MAX_REGION_OFFSET, MAX_UI_SCALE, MIN_UI_SCALE, type AppearanceSettings, type ScaleRegion } from './appearance.ts'
import type { DeviceSettings } from './device/index.ts'
import type { AutomationSettings } from './automation/types.ts'
import type { PaletteSettings } from './palette/types.ts'
import type { ModulesSettings } from './modules.ts'

/** A Loader reference to a `.volatile()` section: `get()` always returns the latest accepted value. */
export interface Live<T> {
  get(): T
}

export interface RemoteSettings {
  httpsPort: number
  http: boolean
  /** Whether a phone's page may read and change these settings (remote/settings.ts). */
  phoneSettings: boolean
}

export interface TeamSettings {
  agents: readonly AgentProfile[]
}

export interface ModelsSettings {
  hiddenProviders: readonly string[]
  effort?: string
  efforts: readonly EffortRule[]
}

export interface CodexSettings {
  /** Codex models DSH's selectors offer; empty offers all. Routing stays unchanged. */
  models: readonly string[]
}

export interface CursorSettings {
  /** Cursor models DSH's selectors offer; empty offers all. Applied by visibility.ts. */
  models: readonly string[]
}

export interface QoderSettings {
  /** Qoder models DSH's selectors offer; empty offers all. Applied by visibility.ts. */
  models: readonly string[]
  /** Repositories (main working tree paths) the glasses can send tasks to: one remote-control daemon each. */
  workspaces: readonly string[]
  /** Minutes every task of a workspace sits answered before their workers are reclaimed; 0 keeps them. */
  idleMinutes: number
  /** Start the daemons with DSH. */
  autoStart: boolean
}

export interface HermesSettings {
  /** Hermes personas DSH's selectors offer; empty offers all. Applied by visibility.ts. */
  models: readonly string[]
}

export interface ConnectorsSettings {
  servers: readonly ConnectorEntry[]
}

export interface Config {
  modules: Live<ModulesSettings>
  discussion: Live<DiscussionSettings>
  prompt: Live<PromptSettings>
  connectors: Live<ConnectorsSettings>
  claude: Live<AdapterSettings>
  codex: Live<CodexSettings>
  cursor: Live<CursorSettings>
  qoder: Live<QoderSettings>
  hermes: Live<HermesSettings>
  remote: Live<RemoteSettings>
  device: Live<DeviceSettings>
  /** `enabled` is the clipboard window's module switch, `modules.palette`. */
  palette: Live<Omit<PaletteSettings, 'enabled'>>
  git: Live<MessageSettings & IdentitySettings>
  team: Live<TeamSettings>
  models: Live<ModelsSettings>
  sync: Live<SyncSettings>
  review: Live<ReviewSettings>
  alerts: Live<AlertsSettings>
  board: Live<BoardSettings>
  appearance: Live<AppearanceSettings>
  automation: Live<AutomationSettings>
}

/** One region's interface size, in percentage points on top of the whole. */
const regionOffset = z.number().min(-MAX_REGION_OFFSET).max(MAX_REGION_OFFSET).default(0)

export const Config: z<Config> = z.object({
  modules: z.object({
    reader: z.boolean().default(false)
      .description('Reader: RSS feeds and GitHub stars in a panel of their own, read every 30 minutes.'),
    relay: z.boolean().default(false)
      .description('Relay: what Qoder and the Hermes personas did elsewhere, and taking it over into a DSH session.'),
    palette: z.boolean().default(false)
      .description('Clipboard window on this machine: the clipboard history and the clipboard and translation window behind a global hotkey. Needs the native helper and, on Windows, the WebView2 runtime; macOS asks for Accessibility permission once to type into other programs.'),
    device: z.boolean().default(false)
      .description('Cardputer on this machine: a handheld that follows every session, answers approvals and dictates.'),
    codex: z.boolean().default(true)
      .description('Codex: its usage, account switch and model filter, which need the dsh-codex-subscription plugin.'),
  }).default({}).volatile(),
  automation: z.object({
    tasks: z.array(z.object({
      id: z.string().required(),
      title: z.string().required(),
      command: z.string().required(),
      args: z.array(z.string()).default([]),
      cwd: z.string().required(),
      provider: z.string().required(),
      model: z.string().required(),
      timeoutMs: z.natural().min(1000).max(3600000).default(60000),
    })).default([]).description('Trusted local script tasks. Explicitly saved and enabled on this machine; the native task manager owns timing. Programs run with the DSH user permissions, not in a script sandbox. Never put credentials in arguments.'),
  }).default({}).volatile(),
  discussion: z.object({
    enabled: z.boolean().default(true).description('Offer a temporary, tool-free discussion for selected conversation text.'),
    provider: z.string().description('Selection discussion provider; blank uses the background helper route. Conversation-only agents and bots are not supported.'),
    model: z.string().description('Selection discussion model; changing it affects new discussions only.'),
  }).default({}).volatile(),
  prompt: z.object({
    instructions: z.string().role('textarea')
      .description('Global instructions in Markdown, given to every conversation with every model (Claude Agent and bots included) at the end of its system prompt.'),
    canvas: z.boolean().default(true)
      .description('Teach every model to deliver standalone charts, tables and dashboards as self-contained interactive HTML files in ~/.dsh/canvases, linked in its reply and browsed together in the 画布 panel.'),
    archify: z.boolean().default(true)
      .description('With canvases on, have the models draw architecture, workflow, sequence, data-flow, state, ERD, class, tree, timeline and waterfall diagrams with the Archify skill (github.com/tt-a1i/archify) when they have it installed, delivered as canvases. Slower and costlier than a hand-written canvas, and needs Node and a local Chrome or Edge.'),
    blockedScans: z.array(z.union(SCAN_RULES)).default([...SCAN_RULES])
      .description('Whole-filesystem find scans refused before they run, for every model: root = find /, mount = find /c, drive = find C:/, proc = find /proc.'),
    blockedCommands: z.array(z.string()).default([])
      .description('More shell commands refused for every model, one per entry as typed (e.g. git push --force): a command running the same program with these words in this order is refused; * matches within a word.'),
  }).default({}).volatile(),
  connectors: z.object({
    servers: z.array(z.object({
      id: z.string().required()
        .description('Lower-kebab-case id; also the MCP server name, so its tools are mcp__<id>__<tool> for every model.'),
      url: z.string().required().description('The remote MCP server\'s Streamable HTTP endpoint, e.g. https://mcp.linear.app/mcp.'),
      repos: z.array(z.string())
        .description('Local repositories (main working tree paths) this account is for: only model sessions working in one of them (or a worktree of one) see its tools, and ticket lookups there use it. Empty: every repository.'),
      clientId: z.string()
        .description('OAuth client ID of an app registered with the server by hand, for servers without dynamic client registration (Slack): a public client with PKCE whose redirect URL is http://localhost:53134/callback.'),
    })).default([])
      .description('Remote MCP servers connected for every model, Claude Agent included. Sign-ins and tokens live in DSH\'s credential store, not here.'),
  }).default({}).volatile(),
  claude: z.object({
    remoteControl: z.boolean().default(true)
      .description('Open each Claude Agent session to Remote Control, so it can be followed and continued from claude.ai or the Claude app; turns sent from there also appear in the DSH session.'),
    fullAccess: z.boolean().default(false)
      .description('Start new Claude Agent sessions with full permissions, without tool approvals. Turning this off also revokes existing full-access processes at their next safe DSH turn; running turns are not interrupted.'),
    keepOnline: z.natural().default(3)
      .description('With Remote Control on, how many of the most recently active Claude Agent sessions stay online instead of closing when idle. Each one is a running Claude Code process.'),
    idleHours: z.number().min(0.25).max(168).default(2)
      .description('Hours a Claude Agent session may sit idle before its Claude Code process is closed; the next turn resumes it from the transcript.'),
    models: z.array(z.string()).default([])
      .description('Claude Code models offered in DSH\'s model selectors (ids such as opus, sonnet); empty offers all of them, (none) offers none.'),
    helperProvider: z.string()
      .description('Provider route that answers what a Claude Agent or Cursor session cannot: DSH compacting the conversation, titling the session. Leave provider and model blank for the default model new agents get (or, when that is Claude Agent, Cursor or a bot, the first other model).'),
    helperModel: z.string()
      .description('Model id on that provider; a small, fast model is plenty.'),
  }).default({}).volatile(),
  codex: z.object({
    models: z.array(z.string()).default([])
      .description('Codex subscription models offered in DSH\'s model selectors; empty offers all of them, (none) offers none. Hidden models remain available to background routes and existing sessions.'),
  }).default({}).volatile(),
  cursor: z.object({
    models: z.array(z.string()).default([])
      .description('Cursor models offered in DSH\'s model selectors (ids such as composer-2.5, claude-opus-5-5); empty offers all of them, (none) offers none.'),
  }).default({}).volatile(),
  qoder: z.object({
    models: z.array(z.string()).default([])
      .description('Qoder models offered in DSH\'s model selectors (ids such as qmodel_38max, auto); empty offers all of them, (none) offers none.'),
    workspaces: z.array(z.string()).default([])
      .description('Local repositories (main working tree paths) the Qwen glasses, the Qoder app and qoder.cn/agents can send tasks to while DSH runs: one qoderclicn remote-control daemon each. Tasks run in the repository itself; a git worktree (under .worktrees/qoder, beside DSH\'s other worktrees) is made only when a task asks for one.'),
    idleMinutes: z.natural().max(1440).default(10)
      .description('Minutes every task of a workspace may sit answered before their worker processes (some 250 MB each) are reclaimed; a follow-up starts one again, restoring the conversation, in a few seconds. 0 keeps them until archived in the app.'),
    autoStart: z.boolean().default(true)
      .description('Start the workspaces\' daemons when DSH starts. Off: start them by hand from the Relay panel (its glasses workspaces).'),
  }).default({}).volatile(),
  hermes: z.object({
    models: z.array(z.string()).default([])
      .description('Hermes personas offered in DSH\'s model selectors (profile names such as minima, or default for the root home); empty offers all of them, personas created later included, (none) offers none.'),
  }).default({}).volatile(),
  remote: z.object({
    httpsPort: z.natural().min(1).max(65535).default(443)
      .description('HTTPS port phone access uses on this machine\'s Tailscale name; 443 gives a URL without a port.'),
    http: z.boolean().default(true)
      .description('Also answer http:// on port 80 of the Tailscale name, sending the browser on to the HTTPS URL. Nothing sent over plain HTTP reaches DSH.'),
    phoneSettings: z.boolean().default(false)
      .description('Let DSH opened on a phone read and change these settings. Connectors, phone access and settings sync (which may hold credentials) are never shown there, and Claude full access and the blocked commands stay read-only. Only this computer can turn it on.'),
  }).default({}).volatile(),
  device: z.object({
    port: z.natural().min(1).max(65535).default(7655)
      .description('Port the Cardputer reaches this computer on, on every local network interface. Open only while a device is paired or a pairing is in progress.'),
    approve: z.boolean().default(true)
      .description('Let the device approve tool calls with a 0.8 s press of Enter. Deleting folders, force-pushing, writes outside the workspace and the like can only be refused there; off, the device only refuses.'),
    stt: z.union(['minimax', 'openai']).default('minimax')
      .description('Speech recognition for the device\'s voice: MiniMax (asr-1.0, with the MiniMax key DSH already has) or an OpenAI-compatible /audio/transcriptions service.'),
    sttUrl: z.string()
      .description('Base URL of the OpenAI-compatible service, e.g. https://api.openai.com/v1 or a local server such as http://127.0.0.1:8000/v1.'),
    sttModel: z.string()
      .description('Model id on that service; blank is whisper-1.'),
    language: z.union(['', 'zh', 'en']).default('')
      .description('Spoken language; blank detects it, Chinese and English mixed.'),
    hints: z.boolean().default(true)
      .description('Put spoken file names back together from the session\'s workspace, e.g. "view 点 ts" → view.ts.'),
    typing: z.union(['auto', 'unicode', 'paste']).default('auto')
      .description('How dictation reaches the front app: unicode types each character, paste pastes and then restores the clipboard; auto types, and pastes on macOS while a Chinese input method is on.'),
  }).default({}).volatile(),
  palette: z.object({
    hotkey: z.string().default('Ctrl+Alt+V')
      .description('Global hotkey that opens and closes the window, e.g. Ctrl+Alt+V. It must include a modifier; a combination another program already uses is refused and the previous one stays in force.'),
    keep: z.natural().min(50).max(5000).default(500)
      .description('Clipboard entries kept besides the pinned ones; older ones are deleted.'),
    ignore: z.string().default('')
      .description('Programs whose copies are never kept, comma separated, as named in the task list (keepass, 1password).'),
    bot: z.string().default('')
      .description('The bot that translates, until another is picked in the window: its model answers and its persona leads. Blank: the helper model, with no persona.'),
    langKey: z.natural().min(1).max(6).default(3)
      .description('In the window, Alt (⌥ on macOS) with this digit switches to the next language, and the next three digits pick English, Chinese and French. While the window is open it takes these keys ahead of other programs, and gives them back when it closes.'),
  }).default({}).volatile(),
  git: z.object({
    provider: z.string()
      .description('Provider route the git pane drafts commit messages with (e.g. deepseek-official). Leave provider and model blank to use the default model new agents get.'),
    model: z.string()
      .description('Model id on that provider (e.g. deepseek-v4-flash). A small, fast model is plenty.'),
    instructions: z.string().role('textarea')
      .description('Extra instructions for the commit message, e.g. "Use Conventional Commits, write the subject in Chinese".'),
    identities: z.array(z.object({
      name: z.string().required().description('user.name'),
      email: z.string().required().description('user.email; one preset per email.'),
      signingKey: z.string().description('user.signingkey, when commits made as this identity are signed.'),
    })).default([])
      .description('Commit identities the Git pane binds a repository to: written to that repository\'s own .git/config, so terminals and agents commit as it too.'),
    strict: z.boolean().default(true)
      .description('Refuse to commit in a repository without an identity of its own, everywhere (terminals and agents too): sets the global user.useConfigOnly and sets the global identity aside (kept under agent-hub.* in ~/.gitconfig, restored when turned off).'),
  }).default({}).volatile(),
  team: z.object({
    agents: z.array(z.object({
      id: z.string().required()
        .description('Lower-kebab-case profile id. A teammate named after it (reviewer, reviewer-2) gets this profile.'),
      description: z.string().description('What this agent is for; the Team Lead reads it when choosing teammates.'),
      provider: z.string().description('Model provider route; leave provider and model blank to inherit the Lead\'s model.'),
      model: z.string().description('Model id on that provider.'),
      effort: z.string().description('Reasoning effort (off, minimal, low, medium, high, xhigh, max) the agent starts at; a model without that level gets the nearest one it has. Blank: the model\'s own, as set under models.'),
      persona: z.string().role('textarea').description('Who the agent is; replaces the default persona at the top of its system prompt.'),
      tools: z.array(z.string()).description('Only these DSH tools; empty keeps every tool.'),
    })).default([]).description('Agent profiles for Agent Teams teammates.'),
  }).default({}).volatile(),
  models: z.object({
    hiddenProviders: z.array(z.string()).default([])
      .description('Provider routes (e.g. deepseek-official) whose models DSH\'s model selectors no longer offer. The routes keep working for DSH\'s own background calls.'),
    effort: z.string()
      .description('Reasoning effort (off, minimal, low, medium, high, xhigh, max) every model starts at when it is picked in a model selector. A model without that level gets the nearest lower level it has, else the nearest higher one. Blank: each model\'s own default.'),
    efforts: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      effort: z.string().required().description('One of the levels the model offers.'),
    })).default([])
      .description('Per-model reasoning effort, overriding the one above.'),
  }).default({}).volatile(),
  sync: z.object({
    remote: z.string()
      .description('Git remote holding this profile\'s settings and plugin selection, shared by every machine (any URL git understands: git@github.com:me/dsh-settings.git, a self-hosted server, a local or network path). Uses this machine\'s own git sign-in. Blank: sync is off.'),
    branch: z.string().default('main')
      .description('Branch on that remote.'),
    fetchOnStart: z.boolean().default(true)
      .description('Fetch the remote when DSH starts and announce newer settings; nothing is applied until you sync.'),
    localSettings: z.array(z.string()).default([...LOCAL_SETTINGS])
      .description('Settings each machine keeps for itself, never shared and never overwritten by a sync: the entry id, then the path inside it (e.g. ui-theme.config.preference, this machine\'s light or dark). Default: agent-hub.config.review.auto, whether the board\'s reviews sync by themselves, agent-hub.config.remote.phoneSettings, whether a phone may change settings, and agent-hub.config.device.port, the port the Cardputer reaches this machine on.'),
    platformEntries: z.array(z.string()).default([]).hidden()
      .description('Deprecated: entry ids an earlier version synced once per system. Each machine now keeps them for itself, as if listed above; the settings page moves them there.'),
  }).default({}).volatile(),
  review: z.object({
    repos: z.array(z.string()).default([])
      .description('Local repositories (main working tree paths) whose pull requests waiting for my review are analysed. Empty: no reviews.'),
    auto: z.boolean().default(true).hidden()
      .description('Legacy migration input only. Automatic review sync is owned by the host automation task; its enabled state is not configured here.'),
    at: z.string().default('09:00').hidden()
      .description('Legacy migration input only (HH:MM). Edit the schedule and time zone only in the host automation task manager.'),
    bot: z.string().default('reviewer')
      .description('The bot that reviews: its model runs the analysis, its persona says how to review.'),
    commentBot: z.string()
      .description('The bot a comment written by hand on a pull request\'s diff is processed by (translated, polished), only when asked. Blank: not processed. The board remembers the last one picked.'),
    helperProvider: z.string()
      .description('Provider route for the review automation coordinator and summary, questions about a finding, comment rewriting and diff explanations. PR analysis still uses the review bot. Leave provider and model blank for the Claude Agent background model.'),
    helperModel: z.string()
      .description('Model id on that provider.'),
    style: z.string().role('textarea').default(DEFAULT_STYLE)
      .description('How the posted comments are written.'),
    rules: z.string().role('textarea')
      .description('Extra rules for every review, added to the analysis.'),
    explain: z.string().role('textarea')
      .description('How the helper model explains a change in a pull request\'s diff (its parts, their order, what each says). The pull request, the diff, the file around it and where its names are used always come with it. Blank: purpose, effect, how it takes effect.'),
    explainBot: z.string()
      .description('The bot that explains a change in a pull request\'s diff and answers the follow-up questions: its persona leads the explanation prompt, its model answers (the helper model when it only answers conversations). Blank: the helper model.'),
    maxPerRun: z.natural().min(1).max(50).default(10)
      .description('At most this many pull requests are analysed per sync.'),
    keepMerged: z.natural().max(30).default(5)
      .description('Days a reviewed pull request stays at the end of the board once it is merged or closed. 0: it leaves at once.'),
  }).default({}).volatile(),
  alerts: z.object({
    url: z.string().default('')
      .description('Sentry issues URL, e.g. https://<org>.sentry.io/issues/?project=<id>. Its organization and project are used and the region is looked up from the organization; the board always shows unresolved prod issues for 7 or 14 days. Blank hides the alerts lane.'),
    repo: z.string().default('')
      .description('Local repository main working tree where Sentry issues are analysed and fixed.'),
    bot: z.string().default('reviewer')
      .description('Default bot for Sentry analysis. The board remembers the most recently selected bot on this device.'),
  }).default({}).volatile(),
  board: z.object({
    ticketBot: z.string()
      .description('The bot a new ticket\'s title and description are processed by (translated, structured, polished) on the board, only when asked. Blank: not processed. Picking another bot there sets this.'),
    tickets: z.array(z.object({
      repo: z.string().required().description('The repository (main working tree path).'),
      linear: z.boolean().description('New tickets go to Linear, not the local list.'),
      team: z.string().description('Linear team id.'),
      project: z.string().description('Linear project id.'),
      channel: z.string().description('Slack channel id announcing new Linear tickets.'),
      channelName: z.string().description('Its name, as shown.'),
      notify: z.boolean().description('Announce them; false keeps the channel without posting.'),
    })).default([])
      .description('How each repository\'s tickets were last filed on the board, remembered as you create them.'),
  }).default({}).volatile(),
  appearance: z.object({
    uiFont: z.union(FONTS).default('default')
      .description('Font of DSH\'s interface on every device, the phone included; characters it lacks (Chinese, for one) fall back to the default font.'),
    codeFont: z.union(FONTS).default('default')
      .description('Font of code: code blocks, the code editor, diffs and the Git terminal; characters it lacks fall back to the default code font.'),
    uiScale: z.natural().min(MIN_UI_SCALE).max(MAX_UI_SCALE).default(DEFAULT_UI_SCALE)
      .description('Interface text size in percent of DSH\'s own: sidebar, menus, buttons, settings. Each place keeps its own size relative to the others. Conversation text follows DSH\'s general font size setting instead.'),
    regions: z.object({
      sidebar: regionOffset,
      main: regionOffset,
      panel: regionOffset,
      settings: regionOffset,
      popup: regionOffset,
    } satisfies Record<ScaleRegion, unknown>)
      .default({})
      .description('Per-region adjustment in percentage points on top of the interface size: sidebar, main column, right panel, settings window, popups.'),
  }).default({}).volatile(),
})
