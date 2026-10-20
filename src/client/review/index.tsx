/**
 * The review sheet beside its session: a sidebar tab type for `.reviews/pr-<n>.md`, so the sheet
 * link in the session (and the Files tree) opens the form rather than the Markdown preview; its
 * 源文件 button opens the file in the code editor. The board's 打开会话 goes to the session and
 * opens the sheet there, in a tab the sidebar keeps per session (floating, split or fullscreen).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SHEET_PATH } from '../../review/types.ts'
import { CODE_KIND, type SidebarRight, type TabInfo } from '../editor/index.tsx'
import { fileAddress, parseAddress } from '../editor/shared.ts'
import type { ReviewStore } from './api.ts'
import { t } from './i18n.ts'
import { DiffPane, showFinding, useView, ViewSwitch, type Reveal } from './Diff.tsx'
import { ReviewSheet, useSheet, type SheetActions } from './Sheet.tsx'
import { injectReviewStyle } from './style.ts'

export const REVIEW_KIND = 'agent-hub.review'
export const REVIEW_TAB_ID = 'dsh-agent-hub.review'

type UseSessions = <T>(select: (sessions: { byId: Record<string, { cwd?: string } | undefined> }) => T) => T

const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)
const join = (root: string, path: string): string => `${root.replace(/[\\/]+$/, '')}/${path}`
const parent = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

/** The repository of a sheet: the folder above `.reviews`. */
export const repoOf = (path: string): string => parent(parent(path))

/**
 * Go to a session and open a sheet beside it, once the session is on screen. The address is
 * relative to the session's own folder, as the tab resolves it: a response session works in a
 * worktree, not in the repository the sheet is kept in.
 */
export interface ReviewNav {
  openReview(sessionId: string, path: string): void
  openSource(sessionId: string | undefined, path: string, line?: number): void
  openSession(sessionId: string): void
}

interface UiWorkspace {
  openSession?(target: string): unknown
}

export function createNav(
  ui: () => UiWorkspace | undefined,
  sidebar: () => (SidebarRight & { mounted?: { getSnapshot(): unknown } }) | undefined,
  cwdOf: (sessionId: string) => string | undefined,
): ReviewNav {
  /** Open in the session once it is on screen (the sidebar refuses any other). */
  const whenMounted = (sessionId: string, open: (side: SidebarRight) => void): void => {
    let tries = 0
    const attempt = (): void => {
      const side = sidebar()
      if (side !== undefined && (side.mounted === undefined || side.mounted.getSnapshot() === sessionId)) {
        try {
          open(side)
          return
        } catch {
          // Its store is not minted yet.
        }
      }
      if (++tries < 60) setTimeout(attempt, 50)
    }
    attempt()
  }
  return {
    openSession(sessionId) { ui()?.openSession?.(sessionId) },
    openReview(sessionId, path) {
      ui()?.openSession?.(sessionId)
      whenMounted(sessionId, (side) => side.openResource(fileAddress(sessionId, cwdOf(sessionId), path), { kind: REVIEW_KIND }))
    },
    openSource(sessionId, path, line) {
      if (sessionId === undefined) return
      ui()?.openSession?.(sessionId)
      whenMounted(sessionId, (side) => side.openResource(fileAddress(sessionId, cwdOf(sessionId), path), { kind: CODE_KIND, ...(line === undefined ? {} : { params: { line } }) }))
    },
  }
}

function ReviewIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" /><path d="M10 2.5V5h2.5" /><path d="m5.8 9.2 1.4 1.4 3-3" />
    </svg>
  )
}

function ReviewTitle(props: { useTabInfo: () => TabInfo }): ReactNode {
  const { tab } = props.useTabInfo()
  return <><ReviewIcon />{tab.title}</>
}

function ReviewTab(props: { sessionId: string; useTabInfo: () => TabInfo; useSessions: UseSessions; store: ReviewStore; sidebar: SidebarRight; nav: ReviewNav }): ReactNode {
  const { tab } = props.useTabInfo()
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  useEffect(injectReviewStyle, [])
  const address = parseAddress(tab.contentId)
  if (address === undefined || (cwd === undefined && !isAbsolutePath(address.path))) return <div className="rv-tab"><p className="rv-muted">{t('loading')}</p></div>
  const path = isAbsolutePath(address.path) ? address.path : join(cwd!, address.path)
  return <ReviewTabBody {...props} path={path} contentId={tab.contentId} tabId={tab.id} />
}

/** The sheet beside its session, and the pull request's changes a switch away. */
function ReviewTabBody(props: { sessionId: string; path: string; contentId: string; tabId: string; store: ReviewStore; sidebar: SidebarRight; nav: ReviewNav }): ReactNode {
  const { store, path } = props
  const repo = repoOf(path)
  const reply = useSheet(store, path)
  const item = reply?.item
  const [view, setView] = useView()
  const [reveal, setReveal] = useState<Reveal | undefined>()
  const root = useRef<HTMLDivElement>(null)
  const diff = view === 'diff' && item !== undefined
  const actions: SheetActions = {
    openSession: (sessionId, sheet) => {
      if (sessionId !== props.sessionId) props.nav.openReview(sessionId, sheet)
    },
    openSource: () => props.sidebar.openResource(props.contentId, { kind: CODE_KIND, replaceTab: props.tabId }),
    ...(item === undefined ? {} : {
      showLine: (file: string, line?: number, start?: number, thread?: string) => {
        setView('diff')
        setReveal({ path: file, ...(line === undefined ? {} : { line }), ...(start === undefined ? {} : { start }), ...(thread === undefined ? {} : { thread }), nonce: Date.now() })
      },
    }),
  }
  return (
    <div ref={root} className="rv-tab" data-flush={diff ? '' : undefined}>
      {item !== undefined && <div className="rv-tab-bar"><ViewSwitch view={view} onChange={setView} /></div>}
      {diff
        ? (
          <DiffPane store={store} item={item} findings={reply?.sheet?.findings ?? []} {...(reveal === undefined ? {} : { reveal })}
            onFinding={(id) => {
              setView('sheet')
              showFinding(root.current, id)
            }} />
        )
        : <ReviewSheet store={store} path={path} repo={repo} actions={actions} />}
    </div>
  )
}

export interface ReviewClientContext {
  effect(body: () => () => void, label?: string): void
  inject(deps: string[], body: (ctx: ReviewClientContext & {
    sidebarRight: SidebarRight
    sidebarRightTabs: { register(definition: object): () => void }
  }) => void): void
  slots: {
    inject(name: string, body: () => () => void): void
    register<P>(entry: object, component: (props: P) => unknown): () => void
  }
}

export function applyReview(ctx: ReviewClientContext, store: ReviewStore, nav: ReviewNav): void {
  ctx.effect(injectReviewStyle, 'dsh-agent-hub: review style')
  const guard = (label: string, body: () => () => void): (() => () => void) => () => {
    try {
      return body()
    } catch (error) {
      console.warn(`[dsh-agent-hub] review ${label}:`, error)
      return () => {}
    }
  }
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    const sidebar = scope.sidebarRight
    scope.effect(guard('sheet type', () => scope.sidebarRightTabs.register({
      id: REVIEW_TAB_ID,
      kind: REVIEW_KIND,
      patterns: ['pr-*.md'],
      priority: 'extension',
      canOpen: (address: string) => {
        const parsed = parseAddress(address)
        return parsed !== undefined && SHEET_PATH.test(parsed.path)
      },
      title: (address: string) => {
        const number = SHEET_PATH.exec(parseAddress(address)?.path ?? '')?.[2]
        return number === undefined ? t('lane') : t('tabTitle', { n: number })
      },
    })), 'dsh-agent-hub: review sheet tab type')
    scope.slots.inject('sidebar.right.pane.tab', guard('sheet body', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: REVIEW_TAB_ID,
      inject: () => ({ store, sidebar, nav }),
    }, ReviewTab)))
    scope.slots.inject('sidebar.right.pane.tab.title', guard('sheet title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: REVIEW_TAB_ID,
    }, ReviewTitle)))
  })
}
