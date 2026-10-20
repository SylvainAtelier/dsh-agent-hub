/**
 * The code editor in DSH's right sidebar, beside the session: every text file
 * a session opens (the Files tree, a file link in the chat, a tool's line
 * reference, a search result) opens in a code tab, with syntax highlighting,
 * editing, saving, formatting, definitions, references and the change markers
 * against HEAD. Markdown and HTML keep DSH's rendered preview first; its header
 * gets an 编辑 button, and the editor a 预览 one.
 *
 * The sidebar already is the editor's workbench: tabs, two panes, floating,
 * fullscreen, the session alongside, phones (fullscreen below 768px), layouts
 * kept per session. This module only registers two tab types — code files and
 * workspace search — and the small pieces around them. CodeMirror (the editor
 * itself) loads as its own chunk on the first code tab.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { Menu, useCoarse } from '../git/kit.tsx'
import { injectGitStyle } from '../git/style.ts'
import { EDITOR_NS, en, t, zh } from './i18n.ts'
import { baseName, CODE_PATTERNS, editable, editorShared, insertIntoSession, fileAddress, filesCall, parseAddress, type FilesCall, type InputActions, type Rpc } from './shared.ts'
import { injectEditorStyle } from './style.ts'
import { SearchPage, SEARCH_KIND, type SearchParams } from './Search.tsx'
import { TreeActions, TreeMenuOverlay, watchTreeMenu, type TreeMenuDeps } from './tree.tsx'
import type { CodeEditorProps, EditorHost, Place } from './chunk/Editor.tsx'

export const CODE_KIND = 'agent-hub.code'
export const CODE_TAB_ID = 'dsh-agent-hub.code'
export const SEARCH_TAB_ID = 'dsh-agent-hub.search'
/** DSH's document preview, the other way to show a file. */
const PREVIEW_KIND = 'text'

/** The host module loader's package-local chunk import (see scripts/build.mjs). */
declare const require: { async?: (spec: string) => Promise<unknown> }

let chunk: Promise<ComponentType<CodeEditorProps>> | undefined
function loadEditor(): Promise<ComponentType<CodeEditorProps>> {
  chunk ??= (async () => {
    if (typeof require.async !== 'function') throw new Error('chunk loading unavailable')
    const loaded = await require.async('./client.editor.js') as { CodeEditor: ComponentType<CodeEditorProps> }
    return loaded.CodeEditor
  })().catch((error: unknown) => {
    chunk = undefined
    throw error
  })
  return chunk
}

export interface TabInfo {
  sidebar?: { expanded: boolean; fullscreen: boolean }
  panel?: { id: string }
  tab: {
    id: string
    contentId: string
    title: string
    visible?: boolean
    signal: AbortSignal
    navigation: { revision: number; params?: Record<string, unknown> }
    actions: {
      openResource?(address: string, options?: { params?: object; replaceTab?: boolean; paneId?: string; preferNewPane?: boolean }): void
      openTab?(kind: string, options?: { params?: object; paneId?: string; preferNewPane?: boolean }): void
      close?(): void
    }
  }
}

export interface SidebarRight {
  openResource(address: string, options?: { kind?: string; replaceTab?: string; params?: object; paneId?: string; preferNewPane?: boolean }): void
  openTab(kind: string, options?: { params?: object; paneId?: string; preferNewPane?: boolean; replaceTab?: string }): void
  focusedTarget(element?: Element | null): { tabId?: string; paneId: string } | undefined
  commandTarget(element: Element | null): unknown
  openTabFromTarget(kind: string, target: unknown): void
  registerCloseHandler(kind: string, handler: (sessionId: string, tab: { id: string; kind: string }) => void): () => void
  focus(tabId: string): void
  toggleExpanded(): void
}

type UseSessions = <T>(select: (sessions: { byId: Record<string, { cwd?: string } | undefined> }) => T) => T
type UseResource = (address: string) => { status: string; value?: { absolutePath?: string; version?: string } }

interface CodeTabProps {
  sessionId: string
  useTabInfo: () => TabInfo
  useSessions: UseSessions
  useResource: UseResource
  call: FilesCall
  sidebar: SidebarRight
}

/** Where code tabs of each session last sat, so search results open beside the search, not over it. */
const codePane = new Map<string, string>()

function placeOf(params: Record<string, unknown> | undefined): Place | undefined {
  const line = params?.line
  if (typeof line !== 'number' || !Number.isFinite(line)) return undefined
  return {
    line,
    ...(typeof params?.column === 'number' ? { column: params.column } : {}),
    ...(typeof params?.length === 'number' ? { length: params.length } : {}),
  }
}

function CodeTab(props: CodeTabProps): ReactNode {
  const { tab, sidebar: frame, panel } = props.useTabInfo()
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  const resource = props.useResource(tab.contentId)
  const coarse = useCoarse()
  useEffect(injectGitStyle, [])
  useEffect(injectEditorStyle, [])
  useEffect(() => { if (panel?.id !== undefined) codePane.set(props.sessionId, panel.id) }, [panel?.id, props.sessionId])
  const [Editor, setEditor] = useState<ComponentType<CodeEditorProps> | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    loadEditor().then((component) => { if (alive) setEditor(() => component) }, (error: unknown) => {
      if (alive) setFailure(error instanceof Error ? error.message : String(error))
    })
    return () => { alive = false }
  }, [attempt])
  const address = parseAddress(tab.contentId)
  const navigation = useMemo(() => {
    const place = placeOf(tab.navigation.params)
    return { revision: tab.navigation.revision, ...(place === undefined ? {} : { place }) }
  }, [tab.navigation.revision, tab.navigation.params])
  const host = useMemo<EditorHost>(() => ({
    call: props.call,
    shared: editorShared,
    openFile: (path, place) => {
      tab.actions.openResource?.(fileAddress(props.sessionId, cwd, path), place === undefined ? {} : { params: place })
    },
    openPreview: () => props.sidebar.openResource(tab.contentId, { kind: PREVIEW_KIND, replaceTab: tab.id }),
    openReferences: (word) => openSearch(tab, { query: word, word: true, caseSensitive: true, regex: false, references: true }),
    openSearch: (query) => openSearch(tab, { query }),
    insert: (text) => insertIntoSession(props.sessionId, text),
    backToSession: () => props.sidebar.toggleExpanded(),
    close: () => tab.actions.close?.(),
    Menu,
  }), [props.call, props.sessionId, cwd, tab.id, tab.contentId, tab.actions, props.sidebar])
  if (cwd === undefined || address === undefined) return <div className="ce-root"><div className="ce-state">{t('noWorkspace')}</div></div>
  return (
    <div className="ce-root">
      {Editor !== undefined
        ? <Editor tabId={tab.id} cwd={cwd} path={address.path} visible={tab.visible !== false} version={resource.value?.version}
            signal={tab.signal} navigation={navigation} coarse={coarse} covering={frame?.fullscreen === true} host={host} />
        : failure !== undefined
          ? <div className="ce-state" role="alert"><p>{t('chunkFailed', { message: failure })}</p><button type="button" className="ah-btn ah-btn-sm" onClick={() => { setFailure(undefined); setAttempt((n) => n + 1) }}>{t('retry')}</button></div>
          : <div className="ce-state"><span className="ce-spinner" aria-hidden="true" />{t('loading')}</div>}
    </div>
  )
}

function openSearch(tab: TabInfo['tab'], params: SearchParams): void {
  tab.actions.openTab?.(SEARCH_KIND, { params, preferNewPane: true })
}

const SHEET = '<path d="M9 2.5H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.5z" /><path d="M9 2.5v3h3" /><path d="m6.6 8.4-1.3 1.3 1.3 1.3M9.4 8.4l1.3 1.3-1.3 1.3" />'

function CodeIcon(): ReactNode {
  return <svg className="ce-title-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: SHEET }} />
}

function CodeTitle(props: { useTabInfo: () => TabInfo }): ReactNode {
  const { tab } = props.useTabInfo()
  const dirty = useSyncExternalStore(editorShared.dirtyTabs.subscribe, () => editorShared.dirtyTabs.has(tab.id))
  return <><CodeIcon />{tab.title}{dirty && <span className="ce-title-dot" aria-label={t('unsaved')} />}</>
}

function SearchIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" />
    </svg>
  )
}

function SearchTitle(props: { useTabInfo: () => TabInfo }): ReactNode {
  const { tab } = props.useTabInfo()
  return <><SearchIcon />{tab.title}</>
}

function SearchArtwork({ size = 26 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="22" height="22" rx="6" fill="#4d6bfe" opacity=".14" />
      <circle cx="11.5" cy="11.5" r="5" stroke="#4d6bfe" strokeWidth="1.8" />
      <path d="m15.3 15.3 4.2 4.2" stroke="#4d6bfe" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** The 编辑 button in DSH's document preview header: the same file in a code tab, in place. */
function EditButton(props: { absolutePath?: string; sessionId: string; useSessions: UseSessions; sidebar: SidebarRight }): ReactNode {
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  useEffect(injectEditorStyle, [])
  if (props.absolutePath === undefined || !editable(props.absolutePath)) return null
  const path = props.absolutePath
  const open = (element: Element): void => {
    const target = props.sidebar.focusedTarget(element)
    props.sidebar.openResource(fileAddress(props.sessionId, cwd, path), { kind: CODE_KIND, ...(target?.tabId === undefined ? {} : { replaceTab: target.tabId }) })
  }
  return (
    <button type="button" className="ce-preview-edit" title={t('edit')} aria-label={t('edit')} onClick={(event) => open(event.currentTarget)}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.5 2.8 13.2 5.5 6 12.7l-3.2.5.5-3.2z" /><path d="m9.3 4 2.7 2.7" />
      </svg>
      <span>{t('edit')}</span>
    </button>
  )
}

/** Keeps each mounted session's composer reachable for Ctrl/⌘+L. Renders nothing. */
function ComposerBridge(props: { sessionId: string; inputActions?: InputActions }): ReactNode {
  const actions = props.inputActions
  useEffect(() => {
    if (actions === undefined) return
    editorShared.composers.set(props.sessionId, actions)
    return () => { if (editorShared.composers.get(props.sessionId) === actions) editorShared.composers.delete(props.sessionId) }
  }, [props.sessionId, actions])
  return null
}

interface Shortcuts {
  register(entry: object): () => void
}

/** DSH's Session Remote, as far as the Files tree's reveal uses it (ui-open-in-app's carrier). */
interface RemoteFace {
  session: {
    canOpenWorkspacePath(): Promise<{ ok: boolean; value?: boolean }>
    openWorkspacePath(request: { path: string; action: 'reveal' }): Promise<{ ok: boolean }>
  }
}

export interface EditorClientContext {
  get(name: 'connection'): { rpc: Rpc }
  effect(body: () => () => void, label?: string): void
  inject(deps: string[], body: (ctx: EditorClientContext & {
    sidebarRight: SidebarRight
    sidebarRightTabs: { register(definition: object): () => void }
    shortcuts?: Shortcuts
    remote: RemoteFace
  }) => void): void
  locale: { register(ns: string, dictionaries: object): () => void }
  slots: {
    inject(name: string, body: () => () => void): void
    register<P>(entry: object, component: (props: P) => unknown): () => void
  }
}

export function applyEditor(ctx: EditorClientContext): void {
  const call = filesCall(() => ctx.get('connection').rpc)
  const guard = (label: string, body: () => () => void): (() => () => void) => () => {
    try {
      return body()
    } catch (error) {
      console.warn(`[dsh-agent-hub] editor ${label}:`, error)
      return () => {}
    }
  }

  ctx.effect(guard('dictionaries', () => ctx.locale.register(EDITOR_NS, { zh, en })), 'dsh-agent-hub: editor dictionaries')

  // Ctrl/⌘+L reaches the composer of the session the sidebar belongs to.
  ctx.slots.inject('conversation.input.dock', guard('composer bridge', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-agent-hub.editor-composer',
    order: 2000,
  }, ComposerBridge)))

  // Reveal in the file manager, as DSH's document preview does: offered once the host says it has a desktop.
  let reveal: ((path: string) => Promise<boolean>) | undefined
  ctx.inject(['remote', 'remote.session'], (scope) => scope.effect(guard('reveal', () => {
    const { session } = scope.remote
    let live = true
    session.canOpenWorkspacePath().then((answer) => {
      if (live && answer.ok && answer.value === true) reveal = async (path) => (await session.openWorkspacePath({ path, action: 'reveal' })).ok
    }, () => {})
    return () => {
      live = false
      reveal = undefined
    }
  }), 'dsh-agent-hub: files tree reveal'))

  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    const sidebar = scope.sidebarRight

    // DSH's Files tree: a right-click menu and the usual keys on its rows.
    const tree: TreeMenuDeps = { call, sidebar, reveal: () => reveal }
    scope.effect(guard('files tree menu', () => watchTreeMenu(tree)), 'dsh-agent-hub: files tree menu')
    scope.slots.inject('shell.overlay', guard('files tree overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'dsh-agent-hub.files-tree-menu',
      locale: EDITOR_NS,
      inject: () => ({ deps: tree }),
    }, TreeMenuOverlay)))
    // New file / folder, beside the tree's reload button.
    scope.slots.inject('sidebar.right.tab.files.actions', guard('files tree actions', () => scope.slots.register({
      name: 'sidebar.right.tab.files.actions',
      id: 'dsh-agent-hub.files-tree-actions',
      // First, right after the reload button (open-in-app keeps the default order).
      order: -10,
      locale: EDITOR_NS,
      inject: () => ({ deps: tree }),
    }, TreeActions)))

    scope.effect(guard('code type', () => scope.sidebarRightTabs.register({
      id: CODE_TAB_ID,
      kind: CODE_KIND,
      // Text files open here by default; the rest keeps DSH's previews (and their 编辑 button opens them here).
      patterns: CODE_PATTERNS,
      priority: 'extension',
      // Also asked when a kind is named, so only the address shape is checked: session files.
      canOpen: (address: string) => parseAddress(address) !== undefined,
      title: (address: string) => baseName(parseAddress(address)?.path ?? address),
    })), 'dsh-agent-hub: code tab type')

    scope.slots.inject('sidebar.right.pane.tab', guard('code body', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: CODE_TAB_ID,
      locale: EDITOR_NS,
      inject: () => ({ call, sidebar }),
    }, CodeTab)))
    scope.slots.inject('sidebar.right.pane.tab.title', guard('code title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: CODE_TAB_ID,
    }, CodeTitle)))

    // Unsaved changes: the close is held, and the tab's own bar asks what to do.
    scope.effect(guard('close guard', () => sidebar.registerCloseHandler(CODE_KIND, (sessionId, tab) => {
      if (!editorShared.dirtyTabs.has(tab.id) || editorShared.discard.has(tab.id)) return
      try {
        sidebar.focus(tab.id)
      } catch {
        // Another session's tab: its bar asks when it is shown.
      }
      for (const listener of editorShared.closeRequests) listener({ tabId: tab.id, sessionId })
      throw new Error('unsaved changes')
    })), 'dsh-agent-hub: code close guard')

    scope.slots.inject('sidebar.right.tab.document.actions', guard('preview edit', () => scope.slots.register({
      name: 'sidebar.right.tab.document.actions',
      id: 'dsh-agent-hub.edit',
      inject: () => ({ sidebar }),
    }, EditButton)))

    scope.effect(guard('search type', () => scope.sidebarRightTabs.register({
      id: SEARCH_TAB_ID,
      kind: SEARCH_KIND,
      title: () => t('searchTitle'),
      guide: [{
        id: 'search',
        commandId: 'agent-hub.search',
        order: 12,
        title: () => t('searchTitle'),
        description: () => t('searchGuide'),
        icon: SearchArtwork,
      }],
    })), 'dsh-agent-hub: search tab type')
    scope.slots.inject('sidebar.right.pane.tab', guard('search body', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: SEARCH_TAB_ID,
      locale: EDITOR_NS,
      inject: () => ({ call, codePane }),
    }, SearchPage)))
    scope.slots.inject('sidebar.right.pane.tab.title', guard('search title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: SEARCH_TAB_ID,
    }, SearchTitle)))

    // Ctrl/⌘+Shift+F as in VS Code on the desktop app; in a browser DSH's own 分叉会话 holds it, so Ctrl/⌘+Alt+F.
    // Opens the search tab, seeded with the editor's selection.
    scope.inject(['shortcuts'], (inner) => inner.effect(guard('search shortcut', () => inner.shortcuts!.register({
      id: 'agent-hub.search',
      label: () => t('searchTitle'),
      aliases: ['search', 'find in files', 'grep', '搜索'],
      defaults: Object.fromEntries(['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows'].map((platform) => [
        platform, { code: 'KeyF', modifiers: platform.startsWith('web') ? ['primary', 'alt'] : ['primary', 'shift'] },
      ])),
      regions: ['page', 'editable'],
      modals: [],
      resolve: ({ target }: { target: Element | null }) => {
        const where = sidebar.commandTarget(target)
        if (where === undefined) return { status: 'blocked', reason: t('noWorkspace') }
        const inEditor = target?.closest('.ce-cm') != null
        const query = inEditor ? editorShared.selection?.() ?? '' : ''
        return {
          status: 'handled',
          run: () => {
            if (query === '' || query.includes('\n')) sidebar.openTabFromTarget(SEARCH_KIND, where)
            else sidebar.openTab(SEARCH_KIND, { params: { query } satisfies SearchParams, preferNewPane: true })
          },
        }
      },
    })), 'dsh-agent-hub: search shortcut'))
  })
}

