/**
 * Mounts the git pane as a right-sidebar tab type (`git`), next to Files and
 * Terminal: a guide card on the empty sidebar, a shortcut (Ctrl/⌘+Shift+G, as
 * in VS Code), and the tab body itself, scoped to the session's workspace.
 * Every seat is optional: a shell without the right sidebar simply has no tab.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { GIT_METHOD, type GitRequest, type GitReply } from '../../git/types.ts'
import { en, GIT_NS, t, zh } from './i18n.ts'
import { GitArtwork, IconBranch } from './icons.tsx'
import { GitPane } from './Pane.tsx'
import { DiffStage } from './Stage.tsx'
import { stage } from './stage.ts'
import { CONSOLE_METHOD, type ConsoleCall } from './Console.tsx'

import { FilesHeaderButton, GitHeaderButton, GitBlankButton, SearchHeaderButton, type SidebarControl } from './HeaderButton.tsx'
import { addRowFiles, type RowFilesDeps } from './row-files.ts'
import { createRepos, type RepoStore } from './store.ts'
import { GitTerminals, addTerminalMarkStyle, type WebTerminals } from './terminal-host.ts'
import type { TerminalTally, WorkspaceTerminals } from '../repos/sidebar.ts'
import { TerminalNotices } from './Terminals.tsx'
import { injectGitStyle } from './style.ts'
import type { ConnectorsStore } from '../connectors/api.ts'
import type { StartIssue } from './context.ts'
import { editorShared, insertIntoSession } from '../editor/shared.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

/** ui-conversation keeps each session's composer draft here (dsh-client-store persistence), read when its composer mounts. */
const DRAFT_KEY = 'dsh.conversation.'

/** Prefill a new session's composer, so the person reads the prompt before sending it. Degrades to nothing. */
export function seedDraft(sessionId: string, draft: string): void {
  try {
    const key = DRAFT_KEY + sessionId
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ draft, view: null, viewRequest: null }))
  } catch {
    // Private mode or a full quota: the session simply opens empty.
  }
}

export const GIT_KIND = 'git'
export const GIT_TAB_ID = 'dsh-agent-hub.git'

interface TabInfo {
  sidebar?: { expanded: boolean; fullscreen: boolean }
  tab: {
    id: string
    title: string
    /** On screen (selected and the sidebar expanded). */
    visible?: boolean
    signal: AbortSignal
    actions: {
      openResource?(address: string): void
      bindCommands?(commands: { refresh?: () => void }): () => void
    }
  }
}

interface TerminalsSource {
  subscribe(listener: () => void): () => void
  get(): GitTerminals | undefined
}

interface BodyProps {
  sessionId: string
  sidebar: SidebarRight
  useTabInfo: () => TabInfo
  useSessions: <T>(select: (sessions: { byId: Record<string, { cwd?: string } | undefined> }) => T) => T
  repos: (cwd: string) => RepoStore
  consoleCall: ConsoleCall
  /** DSH's terminal service, once the host provides it. */
  terminals: TerminalsSource
  /** Open DSH's own terminal tab (a real PTY) in this session's folder. */
  openTerminal: (element: Element) => void
  /** Start a session in a workspace (a worktree's), its composer prefilled with `draft`; absent without the workspace sidebar. */
  openWorkspace?: (workspaceId: string, draft?: string) => void
  /** Linear tickets for the worktree picker and the worktree rows. */
  tickets: ConnectorsStore
  startIssue?: StartIssue
}

/** `dsh-resource://file/session/<id>/<path>`, the address the document preview opens. */
function fileAddress(sessionId: string, cwd: string | undefined, path: string): string {
  const encode = (segment: string): string => encodeURIComponent(segment).replace(/%3A/gi, ':')
  const normalized = path.replace(/\\/g, '/')
  const root = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized
  return `dsh-resource://file/session/${encode(sessionId)}/${rel.split('/').map(encode).join('/')}`
}

function GitBody(props: BodyProps): ReactNode {
  const { tab, sidebar } = props.useTabInfo()
  const insert = useCallback((text: string) => insertIntoSession(props.sessionId, text), [props.sessionId])
  const backToSession = useCallback(() => { if (sidebar?.fullscreen && sidebar.expanded) props.sidebar.toggleExpanded?.() }, [sidebar?.fullscreen, sidebar?.expanded, props.sidebar])
  useEffect(() => () => { if (stage.get()?.insert === insert) stage.close() }, [insert])
  useEffect(() => { if (tab.visible === false && stage.get()?.insert === insert) stage.close() }, [tab.visible, insert])
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  const repo = useMemo(() => (cwd === undefined ? undefined : props.repos(cwd)), [cwd, props.repos])
  useEffect(injectGitStyle, [])
  const openResource = tab.actions.openResource
  const openFile = useCallback((path: string) => openResource?.(fileAddress(props.sessionId, cwd, path)), [openResource, props.sessionId, cwd])
  const bindCommands = tab.actions.bindCommands
  const bindRefresh = useCallback((refresh: () => void) => bindCommands?.({ refresh }), [bindCommands])
  const host = useSyncExternalStore(props.terminals.subscribe, props.terminals.get)
  const terminals = useMemo(() => (host === undefined ? undefined : { host, sessionId: props.sessionId }), [host, props.sessionId])
  if (repo === undefined) {
    return <div className="gp-root"><div className="gp-state"><p>{t('noWorkspace')}</p></div></div>
  }
  return <GitPane key={repo.cwd} repo={repo} insert={insert} backToSession={backToSession} {...(openResource === undefined ? {} : { openFile })} bindRefresh={bindRefresh}
    consoleCall={props.consoleCall} {...(terminals === undefined ? {} : { terminals })} visible={tab.visible !== false} openTerminal={props.openTerminal}
    {...(props.openWorkspace === undefined ? {} : { openWorkspace: props.openWorkspace })} tickets={props.tickets}
    {...(props.startIssue === undefined ? {} : { startIssue: props.startIssue })} />
}

function GitTitle(props: { useTabInfo: () => TabInfo }): ReactNode {
  const { tab } = props.useTabInfo()
  return <><IconBranch size={16} />{tab.title}</>
}

type SidebarRight = SidebarControl

interface Shortcuts {
  register(entry: object): () => void
}

/** ui-workspace's navigation service. */
interface UiWorkspace {
  /** `beforeOpen` gets the new session's id before it is shown. */
  openWorkspace(id: string, beforeOpen?: (sessionId: string) => void): unknown
  openSession?(sessionId: string): void
}

/** The session list, as far as the terminal notices read it. */
interface SessionsService {
  list?: { getSnapshot(): { byId: Record<string, { title?: string; cwd?: string; updatedAt?: number; retainedBy?: { mainView?: number } } | undefined> } }
}

/** The registered workspaces, as far as the sidebar's Files buttons read them. */
interface WorkspacesService {
  list?: { getSnapshot(): ReturnType<RowFilesDeps['workspaces']> }
}

/** How long "View" waits for the session's header (and its Git button) to come up. */
const REVEAL_MS = 3000

export interface GitClientContext {
  get(name: 'connection'): { rpc: { call(channel: string, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> } }
  get(name: 'uiWorkspace'): UiWorkspace | undefined
  get(name: 'sessions'): SessionsService | undefined
  get(name: 'workspaces'): WorkspacesService | undefined
  effect(body: () => () => void, label?: string): void
  inject(deps: string[], body: (ctx: GitClientContext & {
    sidebarRight: SidebarRight
    sidebarRightTabs: { register(definition: object): () => void }
    shortcuts?: Shortcuts
    webTerminals: WebTerminals
  }) => void): void
  locale: { register(ns: string, dictionaries: object): () => void }
  on?(event: string, listener: () => void): () => void
  slots: {
    inject(name: string, body: () => () => void): void
    register<P>(entry: object, component: (props: P) => unknown): () => void
  }
}

/**
 * Wires the Git pane in; returns its terminals' marks for the left sidebar's workspace rows
 * (see repos/sidebar.ts), each workspace counting the terminals of its sessions' worktrees.
 */
export function applyGit(ctx: GitClientContext, tickets: ConnectorsStore, startIssue?: StartIssue): WorkspaceTerminals {
  const rpc = (): Rpc => ctx.get('connection').rpc
  const repos = createRepos((cwd, request: GitRequest) => rpcValue<GitReply<unknown>>(rpc(), GIT_METHOD, { ...request, cwd }, 'agent-hub git RPC failed'))

  const consoleCall: ConsoleCall = async (payload) => {
    const reply = await rpcValue<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>(rpc(), CONSOLE_METHOD, payload, 'agent-hub console RPC failed')
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.value
  }

  // DSH's terminal service (the sidebar Terminal's PTYs), when the host has one.
  let terminalHost: GitTerminals | undefined
  const terminalListeners = new Set<() => void>()
  const terminals: TerminalsSource = {
    subscribe(listener) {
      terminalListeners.add(listener)
      return () => { terminalListeners.delete(listener) }
    },
    get: () => terminalHost,
  }
  const setTerminalHost = (next: GitTerminals | undefined): void => {
    terminalHost = next
    for (const listener of terminalListeners) listener()
  }
  // A session's title, folder and whether it is on screen, as the session list has them.
  const sessionInfo = (sessionId: string): { title?: string; cwd?: string; retainedBy?: { mainView?: number } } | undefined => {
    try {
      return ctx.get('sessions')?.list?.getSnapshot().byId[sessionId]
    } catch {
      return undefined
    }
  }
  const sessionIds = (): string[] => {
    try {
      return Object.keys(ctx.get('sessions')?.list?.getSnapshot().byId ?? {})
    } catch {
      return []
    }
  }
  const describeMarks = (marks: TerminalTally): string => (marks.busy > 0 ? t('termBusy', { n: marks.busy }) : t('termDone'))
  ctx.inject(['webTerminals'], (scope) => {
    scope.effect(() => {
      try {
        const probe = async (sessionId: string, ids: string[]): Promise<Record<string, string>> =>
          await consoleCall({ op: 'activity', sessionId, ids }) as Record<string, string>
        // The sessions of one worktree share their terminals.
        const host = new GitTerminals(scope.webTerminals, probe, (sessionId) => sessionInfo(sessionId)?.cwd, sessionIds)
        const unstyle = addTerminalMarkStyle()
        setTerminalHost(host)
        return () => {
          setTerminalHost(undefined)
          unstyle()
          host.dispose()
        }
      } catch (error) {
        console.warn('[dsh-agent-hub] git terminals:', error)
        return () => {}
      }
    }, 'dsh-agent-hub: git terminals')
  })

  ctx.effect(() => {
    try {
      return ctx.locale.register(GIT_NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-agent-hub: git dictionaries')

  // The diff stage: file diffs open over the middle (agent) column, not inside the pane.
  ctx.slots.inject('shell.overlay', () => {
    try {
      return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-agent-hub.git-stage', locale: GIT_NS }, DiffStage)
    } catch (error) {
      console.warn('[dsh-agent-hub] git diff stage:', error)
      return () => {}
    }
  })

  // Terminal commands that finished off screen: a notice over the whole window.
  const openTerminalOf = (sessionId: string, key: string): void => {
    terminalHost?.reveal(sessionId, key)
    try {
      ctx.get('uiWorkspace')?.openSession?.(sessionId)
    } catch (error) {
      console.warn('[dsh-agent-hub] open session:', error)
      return
    }
    // Then the Git pane in front: its header button opens it, unless the session's sidebar
    // already shows it. Waits for the session to be the one on screen and its header drawn.
    const until = Date.now() + REVEAL_MS
    const press = (): void => {
      const current = (sessionInfo(sessionId)?.retainedBy?.mainView ?? 0) > 0
      const button = current ? document.querySelector<HTMLElement>('[data-agent-hub-git]') : null
      if (button !== null) {
        if (button.getAttribute('aria-pressed') === 'false') button.click()
        return
      }
      if (Date.now() < until) requestAnimationFrame(press)
    }
    requestAnimationFrame(press)
  }
  // The Files tree's 在终端中打开: a new terminal of the pane, started in the folder by the host
  // (DSH starts every terminal in the Session folder; see ConsoleService's start-in).
  ctx.effect(() => {
    editorShared.openTerminal = (sessionId, dir) => {
      const host = terminalHost
      if (host === undefined) return undefined
      // Asked first, so the folder is in place before the terminal exists.
      return consoleCall({ op: 'start-in', sessionId, dir }).then((placed) => placed === true, () => false).then((placed) => {
        openTerminalOf(sessionId, host.open(sessionId).key)
        return placed
      })
    }
    return () => { editorShared.openTerminal = undefined }
  }, 'dsh-agent-hub: files tree terminals')
  ctx.slots.inject('shell.overlay', () => {
    try {
      return ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-agent-hub.git-terminal-notices',
        locale: GIT_NS,
        inject: () => ({ terminals, sessionTitle: (id: string) => sessionInfo(id)?.title, open: openTerminalOf }),
      }, TerminalNotices)
    } catch (error) {
      console.warn('[dsh-agent-hub] terminal notices:', error)
      return () => {}
    }
  })

  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    const guard = (body: () => () => void): (() => () => void) => () => {
      try {
        return body()
      } catch (error) {
        console.warn('[dsh-agent-hub] git sidebar:', error)
        return () => {}
      }
    }
    const openTerminal = (element: Element): void => {
      const target = scope.sidebarRight.commandTarget(element)
      if (target !== undefined) scope.sidebarRight.openTabFromTarget('terminal', target)
    }
    scope.effect(guard(() => scope.sidebarRightTabs.register({
      id: GIT_TAB_ID,
      kind: GIT_KIND,
      title: () => t('title'),
      guide: [{
        id: 'git',
        commandId: 'agent-hub.git',
        order: 15,
        title: () => t('guideTitle'),
        description: () => t('guideDescription'),
        icon: GitArtwork,
      }],
    })), 'dsh-agent-hub: git tab type')

    scope.slots.inject('sidebar.right.pane.tab', guard(() => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: GIT_TAB_ID,
      locale: GIT_NS,
      inject: () => {
        const workspaces = ctx.get('uiWorkspace')
        return {
          repos, consoleCall, terminals, openTerminal, tickets, sidebar: scope.sidebarRight,
          ...(startIssue === undefined ? {} : { startIssue }),
          ...(typeof workspaces?.openWorkspace === 'function'
            ? { openWorkspace: (id: string, draft?: string) => { void workspaces.openWorkspace(id, draft === undefined ? undefined : (sessionId) => seedDraft(sessionId, draft)) } }
            : {}),
        }
      },
    }, GitBody)))

    // Quick access in the session header's top-right utilities, next to the sidebar toggle.
    const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⇧G' : 'Ctrl+Shift+G'
    scope.slots.inject('conversation.session.header.utilities', guard(() => scope.slots.register({
      name: 'conversation.session.header.utilities',
      id: GIT_TAB_ID,
      order: -5,
      locale: GIT_NS,
      inject: () => ({ repos, sidebar: scope.sidebarRight, kind: GIT_KIND, shortcut }),
    }, GitHeaderButton)))
    // Workspace files and search, left of the Git button.
    scope.slots.inject('conversation.session.header.utilities', guard(() => scope.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'dsh-agent-hub.files-button',
      order: -7,
      locale: GIT_NS,
      inject: () => ({ sidebar: scope.sidebarRight }),
    }, FilesHeaderButton)))
    scope.slots.inject('conversation.session.header.utilities', guard(() => scope.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'dsh-agent-hub.search-button',
      order: -6,
      locale: GIT_NS,
      inject: () => ({ sidebar: scope.sidebarRight }),
    }, SearchHeaderButton)))
    // The same Files button on every workspace row of the left sidebar.
    scope.effect(guard(() => addRowFiles({
      sidebar: scope.sidebarRight,
      workspaces: () => ctx.get('workspaces')?.list?.getSnapshot(),
      sessions: () => ctx.get('sessions')?.list?.getSnapshot(),
      openSession: (sessionId) => { ctx.get('uiWorkspace')?.openSession?.(sessionId) },
      openWorkspace: (workspaceId) => {
        Promise.resolve(ctx.get('uiWorkspace')?.openWorkspace(workspaceId)).catch((error: unknown) => console.warn('[dsh-agent-hub] open workspace:', error))
      },
    })), 'dsh-agent-hub: sidebar files buttons')

    // A session shows no header utilities until its first turn; the button joins the header corner then.
    scope.slots.inject('conversation.input.dock', guard(() => scope.slots.register({
      name: 'conversation.input.dock',
      id: GIT_TAB_ID,
      order: 1000,
      locale: GIT_NS,
      inject: () => ({ repos, sidebar: scope.sidebarRight, kind: GIT_KIND, shortcut }),
    }, GitBlankButton)))

    scope.slots.inject('sidebar.right.pane.tab.title', guard(() => scope.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: GIT_TAB_ID,
      locale: GIT_NS,
    }, GitTitle)))

    scope.inject(['shortcuts'], (inner) => inner.effect(guard(() => inner.shortcuts!.register({
      id: 'agent-hub.git',
      label: () => t('title'),
      aliases: ['git', 'source control', 'scm', 'commit', 'diff'],
      defaults: Object.fromEntries(['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows'].map((platform) => [
        platform, { code: 'KeyG', modifiers: ['primary', 'shift'] },
      ])),
      regions: ['page', 'editable', 'terminal'],
      modals: [],
      resolve: ({ target }: { target: Element | null }) => {
        const where = scope.sidebarRight.commandTarget(target)
        if (where === undefined) return { status: 'blocked', reason: t('noWorkspace') }
        return { status: 'handled', run: () => scope.sidebarRight.openTabFromTarget(GIT_KIND, where) }
      },
    })), 'dsh-agent-hub: git shortcut'))
  })
  // Told only when the marks change, across hosts: the sidebar's pass over the list is not free.
  return {
    subscribe(listener) {
      let seen = terminalHost?.marks()
      const changed = (): void => {
        const next = terminalHost?.marks()
        if (next === seen) return
        seen = next
        listener()
      }
      let off = terminalHost?.subscribe(changed)
      const offHost = terminals.subscribe(() => {
        off?.()
        off = terminalHost?.subscribe(changed)
        changed()
      })
      return () => {
        off?.()
        offHost()
      }
    },
    marks: (workspace) => terminalHost?.marksIn(workspace.sessionIds, [workspace.path]) ?? { busy: 0, done: 0 },
    describe: describeMarks,
  }
}
