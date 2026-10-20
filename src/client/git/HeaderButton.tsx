/**
 * Quick access in the session header's top-right utilities, beside the
 * right-sidebar toggle: workspace files, search, and source control (a branch
 * glyph with a change-count badge). Click opens that tab in the right sidebar,
 * or collapses the sidebar when that tab is already in front. The badge polls
 * at the slow pace only; the pane itself takes over the fast pace while it is open.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { keyHint, SEARCH_KEY } from '../editor/i18n.ts'
import { SEARCH_KIND } from '../editor/Search.tsx'
import { t } from './i18n.ts'
import { IconBranch, IconFolder, IconSearch } from './icons.tsx'
import { FILES_KIND } from './row-files.ts'
import type { RepoState, RepoStore } from './store.ts'

export interface SidebarControl {
  commandTarget(element: Element | null): unknown
  openTabFromTarget(kind: string, target: unknown): void
  isExpanded?(): boolean
  active?(): { kind?: string } | undefined
  toggleExpanded?(): void
  toggleFullscreen?(target: unknown): void
  openTabs?: { subscribe(listener: () => void): () => void; getSnapshot(): unknown }
}

export interface HeaderButtonProps {
  sessionId: string
  useSessions: <T>(select: (sessions: { byId: Record<string, { cwd?: string } | undefined> }) => T) => T
  repos: (cwd: string) => RepoStore
  sidebar: SidebarControl
  kind: string
  shortcut?: string
}

const NONE = (): (() => void) => () => {}
/** Touch-first screens (phones, tablets, in either orientation) and narrow touch screens (the mobile layer's devices). */
const MOBILE = '(pointer: coarse) and (hover: none), (pointer: coarse) and (max-width: 820px)'

/** Phones and tablets, where the sidebar would cover the conversation. The desktop app and desktop browsers never match. */
function onMobile(): boolean {
  if (typeof navigator !== 'undefined') {
    const hints = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData
    if (hints?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true
  }
  return typeof matchMedia !== 'undefined' && matchMedia(MOBILE).matches
}
/** New sessions whose Git tab was already opened once, so closing it sticks. */
const autoOpened = new Set<string>()
const EMPTY: RepoState = { toasts: [] }

const CSS = `
.gh-btn {
  position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: none;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, currentColor); transition: background-color 120ms ease, color 120ms ease;
}
.gh-btn:hover, .gh-btn[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent)); color: var(--dsw-alias-label-primary, currentColor); }
.gh-btn:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.gh-btn svg { width: 15px; height: 15px; }
.gh-badge {
  position: absolute; top: 1px; right: 0; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px;
  background: var(--ah-accent); color: var(--ah-bg); font-size: 10px; font-weight: 700; line-height: 14px; text-align: center;
  font-variant-numeric: tabular-nums; pointer-events: none; box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-base, Canvas);
}
.gh-corner { display: inline-flex; align-items: center; gap: 8px; margin-right: 4px; }
@media (pointer: coarse) { .gh-btn { width: 36px; height: 36px; } }
`

let styled = 0
let styleTag: HTMLStyleElement | undefined
function useHeaderStyle(): void {
  useEffect(() => {
    if (styled++ === 0) {
      styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-agent-hub'
      styleTag.dataset.pluginCss = 'dsh-agent-hub/git-header'
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }
    return () => {
      if (--styled === 0) {
        styleTag?.remove()
        styleTag = undefined
      }
    }
  }, [])
}

interface TabButtonProps {
  sidebar: SidebarControl
  kind: string
  label: string
  shortcut?: string | undefined
  /** Marks the Git button, which the blank-session corner looks for. */
  git?: boolean
  children: ReactNode
}

/**
 * Expanding, collapsing or bringing an open tab to the front leaves `openTabs` as it is, and the
 * sidebar has no expansion feed, so every button redraws on the next frame after any of them is clicked.
 */
const pulse = {
  count: 0,
  listeners: new Set<() => void>(),
  subscribe(listener: () => void): () => void {
    pulse.listeners.add(listener)
    return () => { pulse.listeners.delete(listener) }
  },
  bump(): void {
    requestAnimationFrame(() => {
      pulse.count++
      for (const listener of pulse.listeners) listener()
    })
  },
}

/** One header button: opens `kind` in the right sidebar, or collapses the sidebar when that tab is in front. */
function TabButton(props: TabButtonProps): ReactNode {
  useHeaderStyle()
  // Re-render when sidebar tabs open or close, so the pressed state follows.
  const tabs = props.sidebar.openTabs
  useSyncExternalStore(tabs?.subscribe ?? NONE, () => tabs?.getSnapshot())
  useSyncExternalStore(pulse.subscribe, () => pulse.count)
  const showing = (props.sidebar.isExpanded?.() ?? false) && props.sidebar.active?.()?.kind === props.kind
  return (
    <button type="button" className="gh-btn" aria-label={props.label} aria-pressed={showing}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label} data-agent-hub-git={props.git ? '' : undefined}
      onClick={(event) => {
        pulse.bump()
        if (showing && props.sidebar.toggleExpanded !== undefined) {
          props.sidebar.toggleExpanded()
          return
        }
        const target = props.sidebar.commandTarget(event.currentTarget)
        if (target !== undefined) props.sidebar.openTabFromTarget(props.kind, target)
      }}>
      {props.children}
    </button>
  )
}

export type QuickButtonProps = Pick<HeaderButtonProps, 'sessionId' | 'useSessions' | 'sidebar'>

/** DSH's workspace file tree; the hint is ui-sidebar-files' Ctrl/⌘+P (Ctrl/⌘+Alt+P in a browser). */
export function FilesHeaderButton(props: QuickButtonProps): ReactNode {
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  if (cwd === undefined) return null
  const desktop = typeof window !== 'undefined' && '__DSH_HOST_PATHS__' in window
  return (
    <TabButton sidebar={props.sidebar} kind={FILES_KIND} label={t('headerFiles')} shortcut={keyHint(desktop ? 'Mod-P' : 'Mod-Alt-P')}>
      <IconFolder size={15} />
    </TabButton>
  )
}

/** The editor module's workspace search. */
export function SearchHeaderButton(props: QuickButtonProps): ReactNode {
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  if (cwd === undefined) return null
  return (
    <TabButton sidebar={props.sidebar} kind={SEARCH_KIND} label={t('headerSearch')} shortcut={keyHint(SEARCH_KEY())}>
      <IconSearch size={15} />
    </TabButton>
  )
}

export function GitHeaderButton(props: HeaderButtonProps): ReactNode {
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  const repo = useMemo(() => (cwd === undefined ? undefined : props.repos(cwd)), [cwd, props.repos])
  useEffect(() => repo?.retain('slow'), [repo])
  const status = useSyncExternalStore(repo?.subscribe ?? NONE, () => (repo?.getSnapshot() ?? EMPTY).status)
  if (cwd === undefined) return null

  const count = status === undefined ? 0 : status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length
  const label = [t('headerButton'), count > 0 ? t('headerChanges', { n: count }) : '', status?.branch ?? ''].filter(Boolean).join(' · ')
  return (
    <TabButton sidebar={props.sidebar} kind={props.kind} label={label} shortcut={props.shortcut} git>
      <IconBranch size={15} />
      {count > 0 && <span className="gh-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
    </TabButton>
  )
}

/**
 * The same buttons before a session's first turn. A blank session shows no
 * header chrome (the utilities slot above is not rendered), only the header
 * corner holding the sidebar's expand button, so the buttons are portalled into
 * that corner, ahead of the expand button.
 *
 * It mounts through the input dock, a session slot every DSH version renders
 * above the composer (0.2 dropped the new-session page's mode-actions slot),
 * and renders nothing there but a hidden marker. The dock stays mounted once
 * the conversation starts, so the corner seat is withdrawn whenever the
 * header shows its own Git button.
 */
export function GitBlankButton(props: HeaderButtonProps): ReactNode {
  const anchor = useRef<HTMLSpanElement>(null)
  const [seat, setSeat] = useState<HTMLElement | null>(null)
  const place = useRef<() => void>(() => {})
  const { sessionId } = props
  // Whether the session was still blank (no header Git button of its own) when the dock first placed the corner.
  const blank = useRef<boolean | undefined>(undefined)
  const cwd = props.useSessions((sessions) => sessions.byId[sessionId]?.cwd)
  const repo = useMemo(() => (cwd === undefined ? undefined : props.repos(cwd)), [cwd, props.repos])
  const isRepo = useSyncExternalStore(repo?.subscribe ?? NONE, () => (repo?.getSnapshot() ?? EMPTY).status !== undefined)
  useEffect(() => {
    const host = document.createElement('span')
    host.className = 'gh-corner'
    host.dataset.agentHubGitCorner = ''
    let observer: MutationObserver | undefined
    let watched: Element | undefined
    place.current = () => {
      // The header of the conversation this dock belongs to: the nearest corner up the tree.
      let root = anchor.current?.parentElement ?? null
      let corner: Element | null = null
      while (root !== null && corner === null) {
        corner = root.querySelector('[data-conversation-header-corner]')
        if (corner === null) root = root.parentElement
      }
      const header = corner?.parentElement?.parentElement ?? undefined
      if (corner === null || header === undefined) {
        host.remove()
        return
      }
      // Watch only the header: the transcript below it changes constantly while a turn streams.
      if (watched !== header) {
        observer?.disconnect()
        observer = new MutationObserver(() => place.current())
        observer.observe(header, { childList: true, subtree: true })
        watched = header
      }
      const ownButton = [...header.querySelectorAll('[data-agent-hub-git]')].some((button) => !host.contains(button))
      blank.current ??= !ownButton
      if (ownButton) {
        host.remove()
      } else if (host.parentElement !== corner) {
        corner.prepend(host)
      }
    }
    blank.current = undefined
    place.current()
    setSeat(host)
    return () => {
      place.current = () => {}
      observer?.disconnect()
      host.remove()
      setSeat(null)
    }
  }, [sessionId])
  // The header may have been rebuilt since; re-seat on every render of the dock.
  useEffect(() => place.current())
  // A new session in a git repository opens with Source Control in the right sidebar, on the desktop only.
  useEffect(() => {
    if (!isRepo || blank.current !== true || autoOpened.has(sessionId)) return
    if (onMobile()) return
    autoOpened.add(sessionId)
    const { sidebar, kind } = props
    if ((sidebar.isExpanded?.() ?? false) && sidebar.active?.()?.kind === kind) return
    const target = sidebar.commandTarget(anchor.current)
    if (target === undefined) return
    pulse.bump()
    sidebar.openTabFromTarget(kind, target)
  }, [isRepo, sessionId, props.sidebar, props.kind])
  return (
    <>
      <span ref={anchor} hidden data-agent-hub-git-anchor="" />
      {seat !== null && createPortal(<><FilesHeaderButton {...props} /><SearchHeaderButton {...props} /><GitHeaderButton {...props} /></>, seat)}
    </>
  )
}
