/**
 * dsh-agent-hub browser half. Usage module: the 订阅用量 settings section plus the sidebar
 * glance card, both rendering the host's overview through one shared feed. Remote module:
 * the phone-access entry under it, and the mobile layer for DSH opened on a phone.
 * Appearance: the configured interface and code fonts, applied on every page (see font/index.ts).
 */

import { applyDiscussions, type DiscussionContext } from './discussion/index.tsx'
import { createFeed } from './usage/feed.ts'
import { rpcReply, rpcValue, type Rpc } from './rpc.ts'
import { en, NS, t, zh } from './i18n.ts'
import { injectStyle } from './usage/style.ts'
import { FootCard, Section } from './usage/ui.tsx'
import { OVERVIEW_METHOD, type UsageOverview } from '../usage/types.ts'
import { injectRemoteStyle } from './remote/style.ts'
import { RemoteEntry, viaTailnet, type RemoteApi } from './remote/ui.tsx'
import { REMOTE_METHOD, type RemoteResult } from '../remote/types.ts'
import { applyGit, type GitClientContext } from './git/index.tsx'
import { applyEditor, type EditorClientContext } from './editor/index.tsx'
import { AUTH_METHOD, watchClaudeAuth } from './claude/auth.tsx'
import { ACCOUNTS_METHOD, AccountStore, injectAccountStyle, type AccountCheck, type AccountsState } from './claude/accounts.tsx'
import { CODEX_METHOD_PREFIX, CodexAccountStore } from './codex/accounts.tsx'
import { applyTeamMentions, type MentionContext } from './team/mentions.ts'
import { ConfigFormModel, ENTRY_ID, type ConfigScope } from './config/form.ts'
import { PhoneScope } from './config/phone.ts'
import { revealSection } from './config/sections.ts'
import { t as configT } from './config/i18n.ts'
import { injectConfigStyle } from './config/style.ts'
import { ConfigSection } from './config/ui.tsx'
import { UpdatesSection } from './config/updates.tsx'
import { registerModelShortcuts, type ModelDirectories, type Shortcuts as ShortcutsService } from './config/shortcuts.tsx'
import { ModelDirectory } from './config/models.ts'
import { MODELS_METHOD, type ModelGroup } from '../models.ts'
import { TEAM_METHOD } from '../team/types.ts'
import { connectorCall, ConnectorsStore } from './connectors/api.ts'
import { reposCall, ReposStore } from './repos/api.ts'
import { nestWorktrees, preferTreeView, type ActivitySource, type ViewActions } from './repos/sidebar.ts'
import { addRefresh } from './repos/refresh.ts'
import { foldTop } from './repos/top.ts'
import { foldAll } from './repos/fold.ts'
import { revealSessions } from './repos/reveal.ts'
import { noticeWorktreeDelete } from './repos/delete.ts'
import { createActivity } from './repos/activity.ts'
import { ActivityProbe } from './repos/Probe.tsx'
import { boardCall, BoardStore } from './board/api.ts'
import { attachTicketDefaults } from './board/defaults.ts'
import { BOARD_PANEL_ID, BoardPage, BoardPanelIcon, type BoardFace } from './board/Board.tsx'
import { readerCall, ReaderStore } from './reader/api.ts'
import { READER_PANEL_ID, ReaderPage, ReaderPanelIcon, type ReaderFace } from './reader/Reader.tsx'
import { t as readerT } from './reader/i18n.ts'
import { injectReaderStyle } from './reader/style.ts'
import { canvasCall, CanvasStore } from './canvas/api.ts'
import { CANVAS_PANEL_ID, CanvasPage, CanvasPanelIcon, type CanvasFace } from './canvas/Canvas.tsx'
import { t as canvasT } from './canvas/i18n.ts'
import { injectCanvasStyle } from './canvas/style.ts'
import { relayCall, RelayStore } from './relay/api.ts'
import { RELAY_PANEL_ID, relayPanelIcon } from './relay/icons.tsx'
import { t as relayT } from './relay/i18n.ts'
import { RelayNotices } from './relay/Notices.tsx'
import { RelayPage, type RelayFace } from './relay/Relay.tsx'
import { injectRelayStyle } from './relay/style.ts'
import { t as boardT } from './board/i18n.ts'
import { injectBoardStyle } from './board/style.ts'
import { seedDraft } from './git/index.tsx'
import { attachPresets } from './git/presets.ts'
import { mountThemeToggle, type ThemeService } from './theme/toggle.ts'
import { mountRestart, type RestartCall } from './restart/index.tsx'
import { mountLocaleSwitch, type LocaleService } from './locale/switch.ts'
import { RESTART_METHOD } from '../restart/types.ts'
import { injectBaseStyle } from './theme/base.ts'
import { syncCall, SyncStore } from './sync/api.ts'
import { CardputerStore } from './device/api.ts'
import { followTheme, PaletteStore } from './palette/api.ts'
import { SyncNotice } from './sync/Notice.tsx'
import { reviewCall, ReviewStore } from './review/api.ts'
import { ReviewScheduleStore } from './review/schedule.ts'
import { AutomationStore } from './automation/api.ts'
import { applyReview, createNav, type ReviewClientContext } from './review/index.tsx'
import { alertsCall, AlertsStore } from './alerts/api.ts'
import type { SidebarRight } from './editor/index.tsx'
import { mountFonts, type Fonts } from './font/index.ts'
import { APPEARANCE_METHOD } from '../appearance.ts'
import { ModulesStore } from './modules.ts'
import { injectCodexSetupStyle } from './codex/setup.tsx'
import { applySchedule } from './schedule/index.tsx'
import { applyGlasses } from './glasses/index.tsx'
import { PluginUpdatesStore } from './plugins/api.ts'
import { injectPluginUpdatesStyle } from './plugins/style.ts'

function terminalAction(ctx: GitClientContext): () => void {
  let openTerminal: (() => void) | undefined
  ctx.inject(['sidebarRight'], (scope) => {
    openTerminal = () => {
      const target = scope.sidebarRight.commandTarget(null)
      if (target !== undefined) scope.sidebarRight.openTabFromTarget('terminal', target)
    }
    scope.effect(() => () => { openTerminal = undefined }, 'dsh-agent-hub: claude sign-in terminal')
  })
  return () => openTerminal?.()
}

function watchAuth(ctx: GitClientContext, openTerminal: () => void): void {
  ctx.effect(() => watchClaudeAuth({
    call: (payload) => rpcValue(ctx.get('connection').rpc, AUTH_METHOD, payload, 'agent-hub sign-in RPC failed'),
    openTerminal,
  }), 'dsh-agent-hub: claude sign-in prompt')
}

export const inject = ['slots', 'locale', 'connection']

/** The slices of the client context this plugin touches. */
interface ClientContext {
  get(name: 'connection'): { rpc: { call(channel: string, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }; readonly isLoopback?: boolean }
  get(name: 'shortcuts'): Shortcuts | undefined
  /** ui-workspace's navigation; `beforeOpen` gets the new session's id before it is shown. */
  get(name: 'uiWorkspace'): { openWorkspace?(id: string, beforeOpen?: (sessionId: string) => void): unknown; openSession?(target: string): unknown; view?: ViewActions } | undefined
  get(name: 'sidebarRight'): (SidebarRight & { mounted?: { getSnapshot(): unknown } }) | undefined
  get(name: 'workspaces'): { list?: { getSnapshot(): ReturnType<ActivitySource['workspaces']>; subscribe?(listener: () => void): () => void }; insertBefore?(id: string, before?: string): Promise<unknown> } | undefined
  effect(body: () => () => void, label?: string): void
  locale: { register(ns: string, dictionaries: object): () => void; bind(ns: string): (key: string) => string } & Partial<LocaleService>
  slots: {
    inject(name: string, body: () => () => void): void
    register<P>(entry: object, component: (props: P) => unknown): () => void
  }
  inject(deps: string[], body: (scope: ClientContext & { configForms: ConfigForms }) => void): void
}

/** ui-settings' shared configuration forms, one per Host plugin entry. */
interface ConfigForms {
  get(entryId: string): ConfigScope
}

/** Below dsh-usage's 使用统计 (151). */
const SECTION_ORDER = 152
/** Right under 订阅用量. */
const CONFIG_ORDER = 153
/** Ahead of the other sidebar foot actions; the glance takes a full row of its own. */
const FOOT_ORDER = 0
/** Right under the glance. */
const REMOTE_ORDER = 1
/** Among the shell's panel rows: right under 自动化任务 (10). */
const BOARD_ORDER = 15
/** Right under the board. */
const READER_ORDER = 15.5
/** Right under the reader. */
const CANVAS_ORDER = 16
/** Right under the canvases. */
const RELAY_ORDER = 17

function sidebar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
}

/** The host's command registry, reached through its shortcuts service; absent on hosts without one. */
interface Shortcuts {
  registry?: { invoke(id: string, context: { region: 'page'; modal: string | null; target: Element | null }): void }
}

/**
 * Open the settings panel on the section labelled `label`. The shell exposes no service for
 * it, so run its `settings.open` command (the sidebar trigger may be an
 * account menu rather than a Settings button), falling back to a dialog
 * trigger in the sidebar, then pick the nav row with this section's label.
 * Every step degrades silently.
 */
function openSection(shortcuts: Shortcuts | undefined, label = t('title')): void {
  // The settings modal specifically: other dialogs (our own popover among them) also carry role="dialog".
  const settingsPanel = (): Element | null => document.querySelector('[role="dialog"][data-shortcut-modal="settings"]')
  const pick = (panel: Element): void => {
    for (const row of panel.querySelectorAll<HTMLButtonElement>('nav button')) {
      if (row.textContent?.includes(label)) return row.click()
    }
  }
  const open = settingsPanel()
  if (open !== null) return pick(open)
  let invoked = false
  try {
    const registry = shortcuts?.registry
    if (registry !== undefined) {
      registry.invoke('settings.open', { region: 'page', modal: null, target: null })
      invoked = true
    }
  } catch {
    // Fall through to the sidebar trigger.
  }
  if (!invoked) sidebar()?.querySelector<HTMLButtonElement>('[class*="settingsArea"] button[aria-haspopup="dialog"]')?.click()
  let tries = 0
  const attempt = (): void => {
    const panel = settingsPanel()
    if (panel !== null) pick(panel)
    else if (++tries <= 20) setTimeout(attempt, 50)
  }
  setTimeout(attempt, 0)
}

export function apply(ctx: ClientContext): void {
  // Read per call: the connection service may be replaced while the plugin stays mounted.
  const rpc: Rpc = { call: (...args) => ctx.get('connection').rpc.call(...args) }
  // The optional modules switched on under 设置 → Agent Hub → 功能模块: their panels follow them.
  const modules = new ModulesStore(rpc)
  ctx.effect(() => modules.watch(), 'dsh-agent-hub: modules')
  ctx.effect(injectCodexSetupStyle, 'dsh-agent-hub: codex setup style')
  // Fonts first, so the cached choice applies before anything renders.
  let fonts: Fonts | undefined
  ctx.effect(() => {
    const mounted = mountFonts(() => rpcValue(rpc, APPEARANCE_METHOD, {}, 'agent-hub appearance RPC failed'))
    fonts = mounted
    return () => {
      mounted.dispose()
      fonts = undefined
    }
  }, 'dsh-agent-hub: fonts')
  ctx.effect(injectBaseStyle, 'dsh-agent-hub: base style')
  ctx.effect(injectStyle, 'dsh-agent-hub: usage style')
  applySchedule(ctx as unknown as Parameters<typeof applySchedule>[0], rpc)
  applyGlasses(ctx as unknown as Parameters<typeof applyGlasses>[0], rpc)
  // Connectors: one status store for the settings page and the Git pane's tickets.
  const connectors = new ConnectorsStore(connectorCall(rpc))
  ctx.effect(() => () => connectors.dispose(), 'dsh-agent-hub: connectors')
  // Repositories: the connectors settings and the board read the same groups. (The left sidebar
  // needs nothing: worktrees live inside their repository, so DSH's 按工作区树 view nests them.)
  const repos = new ReposStore(reposCall(rpc))
  // 按工作区树 is the left sidebar's default view, until another is picked.
  preferTreeView(ctx.get('uiWorkspace')?.view)
  // 按工作区树: every worktree of a registered repository nests under it, wherever its folder is.
  // Each workspace row's session count and activity; the probe hands over the session hooks.
  const activity = createActivity()
  ctx.slots.inject('shell.overlay', () => {
    try {
      return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-agent-hub.sidebar-activity', inject: () => ({ activity }) }, ActivityProbe)
    } catch {
      return () => {}
    }
  })
  // Beside the workspace search: register every worktree of the registered repositories.
  ctx.effect(() => addRefresh(repos), 'dsh-agent-hub: sidebar worktree refresh')
  // Right beside the workspace search: fold or unfold every workspace at once.
  ctx.effect(foldAll, 'dsh-agent-hub: sidebar fold all')
  // Above the workspaces: 新会话 and the panel list fold into one row of icons (by default on a phone).
  ctx.effect(foldTop, 'dsh-agent-hub: sidebar top fold')
  ctx.effect(injectAccountStyle, 'dsh-agent-hub: account style')
  const openTerminal = terminalAction(ctx as unknown as GitClientContext)
  let refreshUsage = (): void => {}
  const accounts = new AccountStore({
    openTerminal,
    call: (payload) => rpcValue<AccountsState | AccountCheck>(rpc, ACCOUNTS_METHOD, payload, 'agent-hub Claude accounts RPC failed'),
  }, () => refreshUsage())
  // The board: its store is shared with the Git pane, whose ticket picker starts work the same way.
  const board = new BoardStore(boardCall(rpc), repos)
  ctx.effect(() => () => board.dispose(), 'dsh-agent-hub: board')
  const alerts = new AlertsStore(alertsCall(rpc))
  ctx.effect(() => () => alerts.dispose(), 'dsh-agent-hub: alerts')
  // Git module: the 源代码管理 tab in the right sidebar.
  const terminals = applyGit(ctx as unknown as GitClientContext, connectors, (issue, cwd, base) => board.startIssue(issue, cwd, base))
  // 按工作区树 nesting, each workspace row's sessions and terminals at a glance, and worktrees moved among their own.
  const sidebarActivity = {
    store: activity,
    workspaces: () => ctx.get('workspaces')?.list?.getSnapshot(),
    onWorkspaces: (listener: () => void) => ctx.get('workspaces')?.list?.subscribe?.(listener),
    terminals,
  }
  const moveWorkspace = async (id: string, before: string | undefined): Promise<void> => { await ctx.get('workspaces')?.insertBefore?.(id, before) }
  ctx.effect(() => nestWorktrees(repos, sidebarActivity, moveWorkspace), 'dsh-agent-hub: sidebar repositories')
  // Going to a session unfolds its workspace in the sidebar, scrolls to it, and lights it up.
  ctx.effect(() => revealSessions(repos, sidebarActivity), 'dsh-agent-hub: sidebar reveal session')
  // Deleting a worktree's workspace deletes its folder too: the dialog says so.
  ctx.effect(() => noticeWorktreeDelete(repos), 'dsh-agent-hub: sidebar delete worktree notice')
  // Code editor: code tabs and workspace search in the right sidebar, beside the session.
  applyEditor(ctx as unknown as EditorClientContext)
  const discussions = applyDiscussions(ctx as unknown as DiscussionContext, () => {
    revealSection('discussion')
    openSection(ctx.get('shortcuts'), configT('title'))
  })
  // Review: the 待我审 lane on the board, and each review sheet beside its session.
  const review = new ReviewStore(reviewCall(rpc))
  ctx.effect(() => () => review.dispose(), 'dsh-agent-hub: review')
  const reviewNav = createNav(() => ctx.get('uiWorkspace'), () => ctx.get('sidebarRight'), (sessionId) => {
    try {
      return (ctx as unknown as GitClientContext).get('sessions')?.list?.getSnapshot().byId[sessionId]?.cwd
    } catch {
      return undefined
    }
  })
  applyReview(ctx as unknown as ReviewClientContext, review, reviewNav)
  // Claude Agent: a re-sign-in prompt whenever a turn fails because the CLI is signed out.
  watchAuth(ctx as unknown as GitClientContext, openTerminal)
  // Team module: @ in a session's composer suggests its members and the bots to invite;
  // its last row opens 设置 → Agent Hub, where bots are made.
  applyTeamMentions(ctx as unknown as MentionContext, () => {
    revealSection('team')
    openSection(ctx.get('shortcuts'))
  })
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-agent-hub: dictionaries')

  const feed = createFeed((force, invalidate) => rpcValue<UsageOverview>(rpc, OVERVIEW_METHOD, { force, ...(invalidate === undefined ? {} : { invalidate }) }, 'agent-hub usage RPC failed'))
  refreshUsage = feed.refresh
  // Codex accounts live in dsh-codex-subscription; call its RPC methods on /api.
  const codexAccounts = new CodexAccountStore({
    async call(endpoint, payload) {
      // Codex switched off under 功能模块: no account switch either.
      if (!modules.on('codex')) throw new Error('Codex is off')
      return rpcValue(rpc, `${CODEX_METHOD_PREFIX}${endpoint}`, payload, 'Codex accounts RPC failed')
    },
  }, () => feed.reload('codex'))

  ctx.slots.inject('sidebar.footer.action', () => {
    try {
      return ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-agent-hub.usage',
        order: FOOT_ORDER,
        label: () => ctx.locale.bind(NS)('title'),
        locale: NS,
        inject: () => ({ feed, accounts, codexAccounts, modules, onOpen: () => openSection(ctx.get('shortcuts')) }),
      }, FootCard)
    } catch {
      return () => {}
    }
  })

  // The board: a panel row in the left sidebar and its page in the middle column.
  ctx.effect(injectBoardStyle, 'dsh-agent-hub: board style')
  const boardFace = (): BoardFace => {
    const workspaces = ctx.get('uiWorkspace')
    return {
      store: board,
      alerts: { store: alerts, nav: reviewNav },
      review: { store: review, nav: reviewNav },
      ...(typeof workspaces?.openWorkspace === 'function'
        ? { openWorkspace: (id: string, draft?: string) => { void workspaces.openWorkspace!(id, draft === undefined ? undefined : (sessionId) => seedDraft(sessionId, draft)) } }
        : {}),
      openSettings: () => {
        revealSection('connectors')
        openSection(ctx.get('shortcuts'))
      },
    }
  }
  ctx.slots.inject('sidebar.panellist', () => {
    try {
      return ctx.slots.register({ name: 'sidebar.panellist', id: BOARD_PANEL_ID, order: BOARD_ORDER, label: () => boardT('panel') }, BoardPanelIcon)
    } catch {
      return () => {}
    }
  })
  ctx.slots.inject('main', () => {
    try {
      return ctx.slots.register({ name: 'main', key: BOARD_PANEL_ID, inject: boardFace }, BoardPage)
    } catch {
      return () => {}
    }
  })

  // The reader: feeds and GitHub stars read on the host, articles in a reading view of their own;
  // selected text opens the shared selection discussion, kept with the article.
  ctx.effect(injectReaderStyle, 'dsh-agent-hub: reader style')
  const reader = new ReaderStore(readerCall(rpc))
  const openReaderSession = (sessionId: string, draft: string): void => {
    seedDraft(sessionId, draft)
    ctx.get('uiWorkspace')?.openSession?.(sessionId)
  }
  const readerFace = (): ReaderFace => ({ store: reader, hub: discussions, openSession: openReaderSession })
  ctx.slots.inject('sidebar.panellist', () => {
    try {
      return modules.follow('reader', () => ctx.slots.register({ name: 'sidebar.panellist', id: READER_PANEL_ID, order: READER_ORDER, label: () => readerT('panel') }, ReaderPanelIcon))
    } catch {
      return () => {}
    }
  })
  ctx.slots.inject('main', () => {
    try {
      return modules.follow('reader', () => ctx.slots.register({ name: 'main', key: READER_PANEL_ID, inject: readerFace }, ReaderPage))
    } catch {
      return () => {}
    }
  })

  // Canvases: the HTML pages models write to ~/.dsh/canvases, browsed in a panel of their own.
  ctx.effect(injectCanvasStyle, 'dsh-agent-hub: canvas style')
  const canvases = new CanvasStore(canvasCall(rpc))
  const canvasFace = (): CanvasFace => ({ store: canvases, openSession: (sessionId) => { ctx.get('uiWorkspace')?.openSession?.(sessionId) } })
  ctx.slots.inject('sidebar.panellist', () => {
    try {
      return ctx.slots.register({ name: 'sidebar.panellist', id: CANVAS_PANEL_ID, order: CANVAS_ORDER, label: () => canvasT('panel') }, CanvasPanelIcon)
    } catch {
      return () => {}
    }
  })
  ctx.slots.inject('main', () => {
    try {
      return ctx.slots.register({ name: 'main', key: CANVAS_PANEL_ID, inject: canvasFace }, CanvasPage)
    } catch {
      return () => {}
    }
  })

  // 接力: what Qoder and the Hermes personas did elsewhere (the glasses' tasks among them), taking it over into DSH.
  ctx.effect(injectRelayStyle, 'dsh-agent-hub: relay style')
  const relay = new RelayStore(relayCall(rpc))
  const relayFace = (): RelayFace => ({
    store: relay,
    openSettings: () => {
      revealSection('qoder')
      openSection(ctx.get('shortcuts'))
    },
    openSession: (sessionId) => { ctx.get('uiWorkspace')?.openSession?.(sessionId) },
    // The desktop shell serves the page from dsh-app://app; the host's own loopback flag covers it.
    local: ctx.get('connection').isLoopback ?? ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname),
  })
  ctx.slots.inject('sidebar.panellist', () => {
    try {
      return modules.follow('relay', () => ctx.slots.register({ name: 'sidebar.panellist', id: RELAY_PANEL_ID, order: RELAY_ORDER, label: () => relayT('panel') }, relayPanelIcon(relay)))
    } catch {
      return () => {}
    }
  })
  ctx.slots.inject('main', () => {
    try {
      return modules.follow('relay', () => ctx.slots.register({ name: 'main', key: RELAY_PANEL_ID, inject: relayFace }, RelayPage))
    } catch {
      return () => {}
    }
  })
  // Outside work that finished while DSH is open: a notice, whose View opens the panel on it.
  ctx.slots.inject('shell.overlay', () => {
    try {
      return modules.follow('relay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-agent-hub.relay-notices',
        inject: () => ({
          store: relay,
          view: (key: string) => {
            relay.select(key)
            // The shell has no service to open a panel: press its sidebar row.
            document.querySelector(`[data-dsh-panel-entry="${RELAY_PANEL_ID}"]`)?.closest<HTMLElement>('button, a, [role="button"], [role="link"]')?.click()
          },
        }),
      }, RelayNotices))
    } catch {
      return () => {}
    }
  })

  // Composer shortcuts (model menu, thinking level), in DSH's own shortcuts service; keys are set under 模型选择.
  ctx.inject(['shortcuts', 'modelDirectories'], (scope) => {
    const services = scope as unknown as { shortcuts: ShortcutsService; modelDirectories: ModelDirectories }
    scope.effect(() => registerModelShortcuts(services.shortcuts, services.modelDirectories), 'dsh-agent-hub: composer shortcuts')
  })

  // Light/dark switch right of the sidebar's account button. Optional: needs ui-theme's service.
  ctx.inject(['theme'], (scope) => {
    const themed = scope as unknown as { theme: ThemeService; on(event: 'theme/change', listener: () => void): () => void }
    scope.effect(() => mountThemeToggle({
      theme: themed.theme,
      onChange: (listener) => themed.on('theme/change', listener),
      label: (key) => ctx.locale.bind(NS)(key),
    }), 'dsh-agent-hub: theme toggle')
    // The clipboard window runs on the host's machine: only a client there sets its colours.
    if (!viaTailnet()) scope.effect(() => followTheme(rpc, themed.theme, (listener) => themed.on('theme/change', listener)), 'dsh-agent-hub: clipboard window theme')
  })

  // Restart DSH (Desktop only), after the light/dark switch: applies plugin changes that need a fresh host.
  const restart: RestartCall = (payload) => rpcValue(rpc, RESTART_METHOD, payload, 'agent-hub restart RPC failed')
  ctx.effect(() => mountRestart(restart), 'dsh-agent-hub: restart')

  // Interface language, last in that row: the host locale service's own preference.
  ctx.effect(() => {
    const locale = ctx.locale
    if (typeof locale.getLocale !== 'function' || typeof locale.setLocale !== 'function' || typeof locale.subscribe !== 'function') return () => {}
    return mountLocaleSwitch(locale as LocaleService)
  }, 'dsh-agent-hub: locale switch')

  ctx.effect(injectRemoteStyle, 'dsh-agent-hub: remote style')
  // On the phone itself there is nothing to set up.
  if (!viaTailnet()) {
    const remote: RemoteApi = {
      run: (action) => rpcValue<RemoteResult>(rpc, REMOTE_METHOD, { action }, 'agent-hub remote RPC failed'),
    }
    ctx.slots.inject('sidebar.footer.action', () => {
      try {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-agent-hub.remote',
          order: REMOTE_ORDER,
          label: () => ctx.locale.bind(NS)('remote.entry'),
          locale: NS,
          inject: () => ({ api: remote }),
        }, RemoteEntry)
      } catch {
        return () => {}
      }
    })
  }

  ctx.slots.inject('settings.section', () => {
    try {
      return ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-agent-hub.usage',
        order: SECTION_ORDER,
        label: () => ctx.locale.bind(NS)('title'),
        locale: NS,
        inject: () => ({ feed, modules }),
      }, Section)
    } catch {
      return () => {}
    }
  })

  // Plugin upgrades, on 设置 → 同步与更新 beside settings sync (registered with the form below).
  const pluginUpdates = new PluginUpdatesStore(rpc)
  ctx.effect(injectPluginUpdatesStyle, 'dsh-agent-hub: plugin updates style')
  ctx.effect(() => () => pluginUpdates.dispose(), 'dsh-agent-hub: plugin updates store')

  // 设置 → Agent Hub: every option of the plugin on one page. Optional, so the rest of the
  // plugin still mounts on a client without ui-settings' configuration forms.
  ctx.inject(['configForms'], (scope) => {
    scope.effect(injectConfigStyle, 'dsh-agent-hub: config style')
    // DSH serves its form only to a page opened on its own machine (it starts out unavailable
    // anywhere else); a phone reads and writes through the plugin instead, once the computer allows it.
    const native = scope.configForms.get(ENTRY_ID)
    let configScope: ConfigScope = native
    if (native.getSnapshot().status === 'unavailable') {
      const phone = new PhoneScope(rpc)
      void phone.refresh()
      scope.effect(() => phone.watch(), 'dsh-agent-hub: phone settings')
      configScope = phone
    }
    const form = new ConfigFormModel(configScope)
    // The Git pane keeps an identity it binds a repository to as a preset (git.identities).
    scope.effect(() => attachPresets(configScope), 'dsh-agent-hub: identity presets')
    // The board remembers how each repository's tickets are filed (board.*), so it syncs.
    scope.effect(() => attachTicketDefaults(configScope), 'dsh-agent-hub: ticket defaults')
    // A font picked on the settings page applies at once, without waiting for the next read.
    scope.effect(() => configScope.subscribe(() => {
      const snapshot = configScope.getSnapshot()
      if (snapshot.status === 'ready') fonts?.set(snapshot.value?.appearance)
      if (snapshot.status === 'ready') modules.apply(snapshot.value?.modules)
    }), 'dsh-agent-hub: fonts from settings')
    const sync = new SyncStore(syncCall(rpc))
    const device = new CardputerStore(rpc)
    const palette = new PaletteStore(rpc)
    const automation = new AutomationStore(rpc)
    scope.effect(() => () => automation.dispose(), 'dsh-agent-hub: script automation status')
    const reviewSchedule = new ReviewScheduleStore(rpc)
    scope.effect(() => () => reviewSchedule.dispose(), 'dsh-agent-hub: review automation status')
    // Public task-detail navigation, matching the native schedule header entry.
    const openReviewTask = (sessionId: string, id: string): boolean => {
      const sidebar = ctx.get('sidebarRight')
      if (sidebar === undefined) return false
      sidebar.openTab('scheduleTask', { params: { sessionId, id } })
      return true
    }
    scope.effect(() => () => form.dispose(), 'dsh-agent-hub: config form')
    const directory = (all: boolean): ModelDirectory => new ModelDirectory(() => rpcValue<ModelGroup[]>(rpc, MODELS_METHOD, { all }, 'agent-hub models RPC failed'))
    const models = directory(false)
    const allModels = directory(true)
    const teams = async (): Promise<boolean> =>
      (await rpcReply<{ available: boolean }>(rpc, TEAM_METHOD, { op: 'status' }, '', () => ({ available: false }))).available
    scope.slots.inject('settings.section', () => {
      try {
        return scope.slots.register({
          name: 'settings.section',
          id: 'dsh-agent-hub.config',
          order: CONFIG_ORDER,
          label: () => configT('title'),
          locale: NS,
          inject: () => ({ form, models, allModels, teams, connectors, accounts, repos, device, palette, modules, automation, reviewSchedule, openReviewTask, shortcuts: ctx.get('shortcuts') as ShortcutsService | undefined }),
        }, ConfigSection)
      } catch {
        return () => {}
      }
    })
    // 设置 → 同步与更新: the whole profile's settings sync and plugin upgrades, apart from this plugin's own options.
    scope.slots.inject('settings.section', () => {
      try {
        return scope.slots.register({
          name: 'settings.section',
          id: 'dsh-agent-hub.updates',
          order: CONFIG_ORDER + 1,
          label: () => configT('updates.title'),
          locale: NS,
          inject: () => ({ form, models, sync, plugins: pluginUpdates, restart, locale: ctx.locale.getLocale?.().active ?? (document.documentElement.lang || 'zh') }),
        }, UpdatesSection)
      } catch {
        return () => {}
      }
    })
    // Settings sync and the restart's upgrades: what happened by itself at startup is announced.
    scope.slots.inject('shell.overlay', () => {
      try {
        return scope.slots.register({
          name: 'shell.overlay',
          id: 'dsh-agent-hub.sync-notice',
          inject: () => ({
            store: sync,
            plugins: pluginUpdates,
            onOpen: () => openSection(ctx.get('shortcuts'), configT('updates.title')),
          }),
        }, SyncNotice)
      } catch {
        return () => {}
      }
    })
  })
}
