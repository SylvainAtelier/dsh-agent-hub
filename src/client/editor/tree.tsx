/**
 * A right-click menu and the usual keys on DSH's Files tree (ui-sidebar-files): new file or
 * folder, add to the session, cut / copy / paste, copy the path, reveal in the file manager, open
 * a folder in a terminal, rename, delete. The tree is DSH's and offers no seat for it, so this
 * listens on the page and reads the rows' own attributes: each `<li>` carries `data-files-entry`
 * (its type) and `data-files-path` (absolute), the tree `data-files-root` (the session folder).
 * The tree watches its open folders, so what changes on disk shows there by itself.
 *
 * New entries are named in place (draft.tsx): from the menu, from a double-click on the tree's
 * blank space (a file at the top), and from the new file / folder buttons beside DSH's reload
 * button (its `sidebar.right.tab.files.actions` slot), which make it in the folder of the row
 * that had the focus, else at the top.
 *
 * Files change through the editor's files RPC (behind the workspace gate); the clipboard is this
 * page's own, so copying a path never empties it. Deleting is permanent, after a confirmation.
 */

import { useEffect, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { FilesError, Placed } from '../../files/types.ts'
import { Dialog, Menu, type DialogSpec, type MenuAnchor, type MenuEntry } from '../git/kit.tsx'
import { injectGitStyle } from '../git/style.ts'
import { isMac, keyHint, t, type EditorKey } from './i18n.ts'
import { baseName, copyText, editorShared, insertIntoSession, type FilesCall } from './shared.ts'
import { injectEditorStyle } from './style.ts'
import { DraftLayer, dropDraft, inDraft, startDraft, validName, type DraftTarget } from './draft.tsx'

interface Entry {
  /** `root`: the tree's blank space, standing for the session folder. */
  kind: 'file' | 'directory' | 'other' | 'root'
  /** Absolute, `/`-joined below the root as the tree builds it. */
  path: string
  root: string
  sessionId: string
  /** The row's `<li>` (the tree's body for the root). */
  element: HTMLElement
}

export interface TreeMenuDeps {
  call: FilesCall
  sidebar: { commandTarget(element: Element | null): unknown }
  /** DSH's reveal in the file manager; undefined when the host has no desktop to show it on. */
  reveal(): ((path: string) => Promise<boolean>) | undefined
}

interface State {
  menu?: { anchor: MenuAnchor; entries: MenuEntry[]; entry: Entry }
  dialog?: DialogSpec
  notice?: { id: number; text: string; error: boolean }
  clip?: { path: string; cut: boolean }
}

let state: State = {}
const listeners = new Set<() => void>()
const set = (next: Partial<State>): void => {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The row an open dialog is about, focused again when it closes. */
let dialogEntry: Entry | undefined
let noticeId = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined
function say(text: string, error = false): void {
  clearTimeout(noticeTimer)
  set({ notice: { id: ++noticeId, text, error } })
  noticeTimer = setTimeout(() => set({ notice: undefined }), error ? 6000 : 2200)
}

const slash = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
const parentOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || path
/** Path relative to the session folder, `/`-separated; `''` for the folder itself. */
const relativeOf = (entry: Entry): string => {
  const path = slash(entry.path)
  const root = slash(entry.root)
  if (path.toLowerCase() === root.toLowerCase()) return ''
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path
}
const windowsPath = (path: string): boolean => /^[a-z]:/i.test(path) || path.startsWith('\\\\')
const mention = (path: string): string => (/[\s"]/.test(path) ? `@"${path}"` : `@${path}`)

/** The tree entry an element sits in: a row, else the tree's blank space; nothing outside the tree's body. */
function entryOf(element: Element | null, deps: TreeMenuDeps): Entry | undefined {
  const body = element?.closest<HTMLElement>('[data-files-body]')
  const root = body?.closest<HTMLElement>('[data-files-root]')?.dataset.filesRoot
  if (element == null || body == null || root === undefined) return undefined
  const sessionId = (deps.sidebar.commandTarget(body) as { sessionId?: string } | undefined)?.sessionId
  if (sessionId === undefined) return undefined
  const row = element.closest<HTMLElement>('[data-files-entry][data-files-path]')
  if (row === null || !body.contains(row)) return { kind: 'root', path: root, root, sessionId, element: body }
  const kind = row.dataset.filesEntry
  return { kind: kind === 'file' || kind === 'directory' ? kind : 'other', path: row.dataset.filesPath!, root, sessionId, element: row }
}

const revealLabel = (root: string): EditorKey => (windowsPath(root) ? 'tree.revealWindows' : isMac() ? 'tree.revealMac' : 'tree.reveal')

/** What can be done to an entry, in menu order; the keys run the same ids. */
function entriesFor(entry: Entry, deps: TreeMenuDeps): MenuEntry[] {
  const item = (id: string, key: EditorKey, extra: Partial<Extract<MenuEntry, { id: string }>> = {}): MenuEntry => ({ id, label: t(key), ...extra })
  const sep: MenuEntry = { separator: true }
  const real = entry.kind === 'file' || entry.kind === 'directory'
  const folder = entry.kind === 'directory' || entry.kind === 'root'
  const groups: MenuEntry[][] = [
    [item('newFile', 'tree.newFile'), item('newFolder', 'tree.newFolder')],
    real ? [item('chat', 'tree.chat')] : [],
    [
      ...(real ? [item('cut', 'tree.cut', { hint: keyHint('Mod-X') }), item('copy', 'tree.copy', { hint: keyHint('Mod-C') })] : []),
      ...(state.clip !== undefined && entry.kind !== 'other' ? [item('paste', 'tree.paste', { hint: keyHint('Mod-V') })] : []),
    ],
    [item('absolute', 'tree.absolute'), ...(entry.kind === 'root' ? [] : [item('relative', 'tree.relative')])],
    [
      ...(deps.reveal() !== undefined ? [item('reveal', revealLabel(entry.root))] : []),
      ...(folder && editorShared.openTerminal !== undefined ? [item('terminal', 'tree.terminal')] : []),
    ],
    entry.kind === 'root' ? [] : [
      item('rename', 'tree.rename', { hint: 'F2' }),
      item('delete', 'tree.delete', { danger: true, hint: isMac() ? '⌘⌫' : 'Delete' }),
    ],
  ]
  return groups.filter((group) => group.length > 0).flatMap((group, i) => (i === 0 ? group : [sep, ...group]))
}

const failure = (error: FilesError): string => t('tree.failed', { message: error.message })

async function run(id: string, entry: Entry, deps: TreeMenuDeps): Promise<void> {
  const name = baseName(entry.path)
  const rel = relativeOf(entry)
  switch (id) {
    case 'newFile':
    case 'newFolder':
      return startDraft(entry, id === 'newFile' ? 'file' : 'directory', deps.call)
    case 'chat': {
      const added = insertIntoSession(entry.sessionId, ` ${mention(rel || entry.path)} `)
      return say(t(added ? 'added' : 'addedNoComposer'), !added)
    }
    case 'cut':
    case 'copy':
      return set({ clip: { path: entry.path, cut: id === 'cut' } })
    case 'paste': {
      const clip = state.clip
      if (clip === undefined) return
      const into = entry.kind === 'file' ? parentOf(entry.path) : entry.path
      const reply = await deps.call<Placed>({ op: 'paste', cwd: entry.root, path: clip.path, into, cut: clip.cut })
      if (!reply.ok) return say(failure(reply.error), true)
      if (clip.cut && state.clip === clip) set({ clip: undefined })
      return say(t('tree.pasted', { name: baseName(reply.value.absolutePath) }))
    }
    case 'absolute':
    case 'relative':
      return copyText(id === 'absolute' ? entry.path : rel).then(() => say(t('copied')), (error: unknown) => say(String(error), true))
    case 'reveal': {
      const reveal = deps.reveal()
      if (reveal === undefined || !await reveal(entry.path).catch(() => false)) say(t('tree.revealFailed'), true)
      return
    }
    case 'terminal': {
      const opened = editorShared.openTerminal?.(entry.sessionId, entry.path)
      if (opened === undefined) return say(t('tree.noTerminal'), true)
      if (!await opened) say(t('tree.terminalAtRoot'), true)
      return
    }
    case 'rename':
      dialogEntry = entry
      return set({
        dialog: {
          title: t('tree.renameTitle', { name }),
          fields: [{ id: 'name', kind: 'text', label: t('tree.newName'), value: name, validate: (value) => validName(value.trim()) }],
          onConfirm: async (values) => {
            const next = String(values.name).trim()
            if (next === name) return
            const reply = await deps.call<Placed>({ op: 'rename', cwd: entry.root, path: entry.path, name: next })
            if (!reply.ok) return say(failure(reply.error), true)
            if (state.clip?.path === entry.path) set({ clip: { ...state.clip, path: reply.value.absolutePath } })
            say(t('tree.renameDone', { name: next }))
          },
        },
      })
    case 'delete':
      dialogEntry = entry
      return set({
        dialog: {
          title: t('tree.deleteTitle', { name }),
          body: t(entry.kind === 'directory' ? 'tree.deleteFolder' : 'tree.deleteFile'),
          danger: true,
          confirm: t('tree.deleteConfirm'),
          onConfirm: async () => {
            const reply = await deps.call({ op: 'delete', cwd: entry.root, path: entry.path })
            if (!reply.ok) return say(failure(reply.error), true)
            if (state.clip !== undefined && (state.clip.path === entry.path || state.clip.path.startsWith(`${entry.path}/`))) set({ clip: undefined })
            say(t('tree.deleted', { name }))
          },
        },
      })
  }
}


/** The key's action on a focused row, if it is one of the tree's. */
function keyAction(event: KeyboardEvent): string | undefined {
  const mod = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  if (mod && !event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase()
    if (key === 'c' || key === 'x' || key === 'v') return { c: 'copy', x: 'cut', v: 'paste' }[key]
    if (key === 'backspace' && isMac()) return 'delete'
  }
  if (bare && event.key === 'F2') return 'rename'
  if (bare && event.key === 'Delete') return 'delete'
  return undefined
}

/** Starts listening on the page; returns the stop. */
export function watchTreeMenu(deps: TreeMenuDeps): () => void {
  const open = (entry: Entry, anchor: MenuAnchor): void => {
    const entries = entriesFor(entry, deps)
    if (entries.length > 0) set({ menu: { anchor, entries, entry } })
  }
  const onContextMenu = (event: MouseEvent): void => {
    if (inDraft(event.target as Element | null)) return
    const entry = entryOf(event.target as Element | null, deps)
    if (entry === undefined) return
    event.preventDefault()
    open(entry, { x: event.clientX, y: event.clientY })
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return
    const target = event.target as Element | null
    if (!(target instanceof HTMLElement) || !target.matches('[data-files-entry] > button, [data-files-entry] > span')) return
    const entry = entryOf(target, deps)
    if (entry === undefined) return
    // The context-menu key, Shift+F10: the menu under the row.
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const rect = target.getBoundingClientRect()
      return open(entry, { x: rect.left + 24, y: rect.bottom, rect: new DOMRect(rect.left + 24, rect.top, 0, rect.height) })
    }
    const id = keyAction(event)
    if (id === undefined || !entriesFor(entry, deps).some((item) => 'id' in item && item.id === id)) return
    if (id === 'copy' && (window.getSelection()?.toString() ?? '') !== '') return
    event.preventDefault()
    event.stopPropagation()
    void run(id, entry, deps)
  }
  // A double-click on the blank space: a new file at the top. The second press would select text.
  const blank = (event: MouseEvent): Entry | undefined => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined
    if (inDraft(event.target as Element | null)) return undefined
    const entry = entryOf(event.target as Element | null, deps)
    return entry?.kind === 'root' ? entry : undefined
  }
  const onMouseDown = (event: MouseEvent): void => {
    if (event.detail > 1 && blank(event) !== undefined) event.preventDefault()
  }
  const onDoubleClick = (event: MouseEvent): void => {
    const entry = blank(event)
    if (entry === undefined || event.defaultPrevented) return
    event.preventDefault()
    void startDraft(entry, 'file', deps.call)
  }
  document.addEventListener('contextmenu', onContextMenu)
  document.addEventListener('mousedown', onMouseDown)
  document.addEventListener('dblclick', onDoubleClick)
  // Ahead of the page's own shortcuts: on a focused row these keys are the tree's.
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('contextmenu', onContextMenu)
    document.removeEventListener('mousedown', onMouseDown)
    document.removeEventListener('dblclick', onDoubleClick)
    document.removeEventListener('keydown', onKeyDown, true)
    set({ menu: undefined, dialog: undefined })
    dropDraft()
  }
}

/** Menu items that open a dialog, which takes the focus. */
const DIALOGS = new Set(['rename', 'delete', 'newFile', 'newFolder'])

/** Back to the row the menu or dialog was for, when nothing else took the focus. */
function refocus(entry: Entry | undefined): void {
  requestAnimationFrame(() => {
    if (entry === undefined || !entry.element.isConnected) return
    if (document.activeElement !== null && document.activeElement !== document.body) return
    const button = entry.element instanceof HTMLButtonElement ? entry.element : entry.element.querySelector<HTMLElement>(':scope > button')
    button?.focus({ preventScroll: true })
  })
}

/** The menu, dialogs and notices, over the whole window; also dims what is cut. */
export function TreeMenuOverlay(props: { deps: TreeMenuDeps }): ReactNode {
  const current = useSyncExternalStore(subscribe, () => state)
  useEffect(injectGitStyle, [])
  useEffect(injectEditorStyle, [])
  const target = current.menu?.entry.element
  useEffect(() => {
    if (target === undefined) return
    target.dataset.ahFilesTarget = ''
    return () => { delete target.dataset.ahFilesTarget }
  }, [target])
  const cut = current.clip?.cut === true ? current.clip.path.replace(/["\\]/g, '\\$&') : undefined
  return (
    <>
      <DraftLayer />
      {cut !== undefined && <style>{`[data-files-path="${cut}"] > * { opacity: .5; }`}</style>}
      {current.menu !== undefined && (
        <Menu anchor={current.menu.anchor} entries={current.menu.entries} label={t('tree.menu')}
          onClose={() => {
            const entry = current.menu?.entry
            set({ menu: undefined })
            refocus(entry)
          }}
          onSelect={(id) => {
            const entry = current.menu!.entry
            set({ menu: undefined })
            if (!DIALOGS.has(id)) refocus(entry)
            void run(id, entry, props.deps)
          }} />
      )}
      {current.dialog !== undefined && (
        <Dialog spec={current.dialog} onClose={() => {
          set({ dialog: undefined })
          refocus(dialogEntry)
        }} />
      )}
      {current.notice !== undefined && (
        <div className="gt-notices" aria-live="polite">
          <div key={current.notice.id} className="gp-toast" data-kind={current.notice.error ? 'error' : 'ok'}>
            <div className="gp-toast-row"><span className="gp-toast-text" title={current.notice.text}>{current.notice.text}</span></div>
          </div>
        </div>
      )}
    </>
  )
}

const FILE_PLUS = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8.5 14H4.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h4.8L12.5 5.2V8" /><path d="M9 2v3.5h3.5" /><path d="M12 10.5v4M10 12.5h4" />
  </svg>
)
const FOLDER_PLUS = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 13H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V8" /><path d="M12 9.5v4M10 11.5h4" />
  </svg>
)

/**
 * New file / new folder beside DSH's reload button: in the folder of the row that had the focus
 * when the button was pressed (a folder itself, else the one holding it), else at the top.
 */
export function TreeActions(props: { deps: TreeMenuDeps }): ReactNode {
  useEffect(injectGitStyle, [])
  useEffect(injectEditorStyle, [])
  const focused = useRef<Element | null>(null)
  const target = (button: HTMLButtonElement): DraftTarget | undefined => {
    const tree = button.closest('[data-files-root]')
    const row = focused.current?.closest('[data-files-entry]')
    const inTree = row != null && tree?.querySelector('[data-files-body]')?.contains(row) === true
    return entryOf(inTree ? focused.current : tree?.querySelector('[data-files-body]') ?? null, props.deps)
  }
  const press = (kind: 'file' | 'directory') => ({
    onPointerDown: () => { focused.current = document.activeElement },
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      const entry = target(event.currentTarget)
      focused.current = null
      if (entry !== undefined) void startDraft(entry, kind, props.deps.call)
    },
  })
  return (
    <>
      <button type="button" className="ce-files-tool" title={t('tree.newFileTip')} aria-label={t('tree.newFileTitle')} {...press('file')}>{FILE_PLUS}</button>
      <button type="button" className="ce-files-tool" title={t('tree.newFolderTip')} aria-label={t('tree.newFolderTitle')} {...press('directory')}>{FOLDER_PLUS}</button>
    </>
  )
}
