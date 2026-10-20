/**
 * New files and folders in DSH's Files tree, as VS Code makes them: a draft row with a name field
 * appears in the folder (folders at the top of its level, files after the folders), Enter or a
 * click away creates the entry, Escape or an empty name drops it. The name is checked as it is
 * typed (the host checks again), and a failed create keeps the field with what was typed. Once
 * the tree lists the new row, the draft gives way to it in the same frame, and the row is
 * scrolled to, flashed and focused; nothing opens until the row is clicked.
 *
 * The tree is DSH's (React) and has no seat for a row of ours, so the draft is an `<li>` put into
 * the level's `<ul>` and rendered there through a portal. React leaves nodes it did not make in
 * place; when the level itself goes (the folder collapsed, the tab closed), the draft goes too.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Placed } from '../../files/types.ts'
import { t } from './i18n.ts'
import type { FilesCall } from './shared.ts'

/** Where a new entry was asked for: a tree row, or the tree's blank space (`root`). */
export interface DraftTarget {
  kind: 'file' | 'directory' | 'other' | 'root'
  /** Absolute, as the tree spells it. */
  path: string
  /** The session folder. */
  root: string
  /** The row's `<li>`, or any element inside the tree for the root. */
  element: HTMLElement
}

interface Draft {
  id: number
  kind: 'file' | 'directory'
  root: string
  /** The folder it goes in, as the tree spells it. */
  folder: string
  tree: HTMLElement
  /** The level's `<ul>` and our `<li>` in it. */
  list: HTMLElement
  container: HTMLLIElement
  rowClass: string
  /** Focused again when the draft is dropped. */
  back: HTMLElement | null
  call: FilesCall
}

let draft: Draft | undefined
let seq = 0
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function drop(id: number): void {
  if (draft?.id !== id) return
  const { container } = draft
  draft = undefined
  emit()
  container.remove()
}

/** Drops the open draft, if any (the tree's menu is going away). */
export function dropDraft(): void {
  if (draft !== undefined) drop(draft.id)
}

/** Whether an element is part of a draft row (its own events are not the tree's). */
export const inDraft = (element: Element | null): boolean => element?.closest('[data-ah-files-draft]') != null

/** One file name, as the host checks it too. */
export const validName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && name.length <= 255 && !/[/\\\0]/.test(name)

/** A typed name, `/`-separated folders allowed, as the host splits it. */
const nameParts = (value: string): string[] => value.split('/').map((part) => part.trim()).filter((part) => part !== '')

const slash = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
const parentOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || path

/** Resolves with what `find` returns once the subtree under `node` has it; undefined after `ms`. */
function waitFor<T>(node: Node, find: () => T | undefined, ms: number): Promise<T | undefined> {
  const now = find()
  if (now !== undefined) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (value: T | undefined): void => {
      observer.disconnect()
      clearTimeout(timer)
      resolve(value)
    }
    const observer = new MutationObserver(() => {
      const value = find()
      if (value !== undefined) done(value)
    })
    const timer = setTimeout(() => done(find()), ms)
    observer.observe(node, { childList: true, subtree: true })
  })
}

/** The rows of one level, its own children only. */
const rowsOf = (list: Element): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(':scope > li[data-files-entry][data-files-path]')]
const rowAt = (list: Element, path: string): HTMLElement | undefined => rowsOf(list).find((row) => row.dataset.filesPath === path)

/** A directory row's listed level, opening the folder first; undefined if it never lists. */
async function openLevel(row: HTMLElement): Promise<HTMLElement | undefined> {
  row.querySelector<HTMLButtonElement>(':scope > button[aria-expanded="false"]')?.click()
  return waitFor(row, () => {
    const list = row.querySelector<HTMLElement>(':scope > ul')
    return list !== null && list.querySelector(':scope > [data-files-row="loading"]') === null ? list : undefined
  }, 4000)
}

/** Starts a draft for a new entry beside or in `target`; the previous draft, if any, gives way. */
export async function startDraft(target: DraftTarget, kind: 'file' | 'directory', call: FilesCall): Promise<void> {
  const id = ++seq
  const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  const tree = target.element.closest<HTMLElement>('[data-files-root]')
  if (tree === null) return
  let list: HTMLElement | null | undefined
  let folder: string
  if (target.kind === 'root') {
    list = tree.querySelector<HTMLElement>('[data-files-body] > ul')
    folder = target.path
  } else if (target.kind === 'directory') {
    list = await openLevel(target.element)
    folder = target.path
  } else {
    list = target.element.parentElement
    folder = parentOf(target.path)
  }
  // Superseded while the folder opened, or the tree went away.
  if (id !== seq || list == null || !list.isConnected) return
  dropDraft()
  const container = document.createElement('li')
  container.dataset.ahFilesDraft = kind
  container.className = rowsOf(list)[0]?.className ?? ''
  const rows = rowsOf(list)
  const before = kind === 'directory' ? list.firstElementChild : rows.find((row) => row.dataset.filesEntry !== 'directory') ?? null
  list.insertBefore(container, before)
  const rowClass = tree.querySelector('[data-files-entry] > button')?.className ?? ''
  draft = { id, kind, root: target.root, folder, tree, list, container, rowClass, back, call }
  emit()
}

/** The row scrolled to, flashed, and focused when asked. */
function land(row: HTMLElement, focus: boolean): void {
  const button = row.querySelector<HTMLElement>(':scope > button')
  if (focus) button?.focus({ preventScroll: true })
  row.scrollIntoView({ block: 'nearest' })
  delete row.dataset.ahFilesNew
  void row.offsetWidth
  row.dataset.ahFilesNew = ''
  setTimeout(() => { delete row.dataset.ahFilesNew }, 1600)
}

/** The new entry's row once listed; the tree's reload when its watch is slow to report it. */
async function listed(current: Draft, path: string): Promise<HTMLElement | undefined> {
  const quick = await waitFor(current.list, () => rowAt(current.list, path), 800)
  if (quick !== undefined) return quick
  current.tree.querySelector<HTMLButtonElement>('[data-files-reload]')?.click()
  return waitFor(current.tree, () => [...current.tree.querySelectorAll<HTMLElement>('li[data-files-entry][data-files-path]')].find((row) => row.dataset.filesPath === path), 4000)
}

const FILE_ICON = (
  <svg className="ce-draft-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 2h4.8l3.2 3.2V13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" /><path d="M9 2v3.5h3.5" />
  </svg>
)
const FOLDER_ICON = (
  <svg className="ce-draft-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
  </svg>
)

function DraftRow(props: { draft: Draft }): ReactNode {
  const { draft: current } = props
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  /** `saving` and `done` ignore further commits (a blur while the request runs). */
  const phase = useRef<'edit' | 'saving' | 'done'>('edit')
  const errorId = useId()
  const label = t(current.kind === 'file' ? 'tree.fileName' : 'tree.folderName')

  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true })
    current.container.scrollIntoView({ block: 'nearest' })
  }, [current])

  // The level went away under it (folder collapsed, tab closed): nothing to keep.
  useEffect(() => {
    const timer = setInterval(() => { if (!current.container.isConnected) drop(current.id) }, 500)
    return () => clearInterval(timer)
  }, [current])

  /** Why the name cannot be used, checked against the rows on screen; undefined while empty. */
  const problem = (text: string): string | undefined => {
    const parts = nameParts(text)
    if (parts.length === 0) return undefined
    if (!parts.every(validName)) return t('tree.badName')
    const taken = rowAt(current.list, `${slash(current.folder)}/${parts[0]}`)
    if (taken !== undefined && (parts.length === 1 || taken.dataset.filesEntry !== 'directory')) return t('tree.taken', { name: parts[0]! })
    return undefined
  }

  const cancel = (refocus: boolean): void => {
    drop(current.id)
    if (refocus && current.back?.isConnected === true) current.back.focus({ preventScroll: true })
  }

  const commit = async (blurred: boolean): Promise<void> => {
    if (phase.current !== 'edit') return
    const parts = nameParts(value)
    if (parts.length === 0) return cancel(!blurred)
    const issue = problem(value)
    if (issue !== undefined) {
      // Clicked away from a name that cannot be used: dropped, as in VS Code.
      if (blurred) return cancel(false)
      return setError(issue)
    }
    phase.current = 'saving'
    setBusy(true)
    const reply = await current.call<Placed>({ op: 'create', cwd: current.root, into: current.folder, name: parts.join('/'), kind: current.kind })
    if (draft?.id !== current.id) return
    if (!reply.ok) {
      phase.current = 'edit'
      setBusy(false)
      setError(reply.error.code === 'conflict' ? t('tree.taken', { name: parts.length === 1 ? parts[0]! : parts.join('/') }) : t('tree.failed', { message: reply.error.message }))
      if (!blurred) input.current?.focus({ preventScroll: true })
      return
    }
    phase.current = 'done'
    // Keep the draft (now read-only) until the real row takes its place, so nothing blinks.
    let row = await listed(current, `${slash(current.folder)}/${parts[0]}`)
    // A deeper entry: open each folder on the way to it.
    for (const part of parts.slice(1)) {
      if (row === undefined || draft?.id !== current.id) break
      const level = await openLevel(row)
      row = level === undefined ? undefined : await waitFor(level, () => rowAt(level, `${slash(row!.dataset.filesPath!)}/${part}`), 2000)
    }
    if (draft?.id !== current.id) return
    // Focus follows only when it is still ours (a click elsewhere moved on).
    const ours = !blurred || document.activeElement === null || document.activeElement === document.body || current.container.contains(document.activeElement)
    drop(current.id)
    if (row !== undefined) land(row, ours)
  }

  return (
    <>
      <div className={`${current.rowClass} ce-draft-row`} data-busy={busy ? '' : undefined}
        // A press on the row (not the field) keeps the field focused.
        onMouseDown={(event) => { if (event.target !== input.current) event.preventDefault() }}>
        {current.kind === 'file' ? FILE_ICON : FOLDER_ICON}
        <input ref={input} className="ce-draft-input" type="text" value={value} readOnly={busy}
          aria-label={label} placeholder={label} aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : errorId}
          spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" enterKeyHint="done"
          onChange={(event) => {
            const next = event.currentTarget.value
            setValue(next)
            setError(problem(next))
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              void commit(false)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              if (phase.current === 'edit') cancel(true)
            }
          }}
          onBlur={() => {
            // The window lost focus (another app): the draft waits for it to come back.
            if (!document.hasFocus()) return
            void commit(true)
          }} />
      </div>
      <div id={errorId} className="ce-draft-error" role="status" hidden={error === undefined}>{error}</div>
    </>
  )
}

/** The open draft, rendered into its row in the tree. */
export function DraftLayer(): ReactNode {
  const current = useSyncExternalStore(subscribe, () => draft)
  if (current === undefined) return null
  return createPortal(<DraftRow key={current.id} draft={current} />, current.container)
}
