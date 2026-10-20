/**
 * Open files, one buffer per file however many tabs show it (VS Code's
 * TextModel). A buffer outlives its tabs' bodies: switching tabs, collapsing
 * the sidebar or switching sessions keeps the text, the undo history and the
 * scroll position; closing the last tab showing the file lets it go.
 *
 * Each tab keeps its own EditorState (selection, history). An edit in one is
 * replayed into the others, outside their undo history, as CodeMirror's
 * split views do. Text from elsewhere — the disk, a formatter — goes in as a
 * minimal diff, so the caret, folds and scroll stay where they were.
 *
 * The disk is the agents' too. A clean buffer follows the file as it changes
 * (the person watches an agent's edits land); a buffer with unsaved changes
 * keeps them and reports a conflict instead. A save names the content hash it
 * started from, and the host refuses it when the file moved on meanwhile.
 * Unsaved text is also kept in localStorage, so a reload or a crash does not
 * lose it.
 */

import { ChangeSet, EditorState, Text, Transaction, Annotation, type ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { diff } from '@codemirror/merge'
import type { BaseText, Eol, FileText, FilesError, Written } from '../../../files/types.ts'
import type { FilesCall } from '../shared.ts'

/** Marks a transaction replayed from another tab of the same buffer. */
export const Replayed = Annotation.define<boolean>()

export interface Conflict {
  /** What is on disk now; absent when it was deleted or could not be sent. */
  text?: string
  /** Its hash; `null`: the file is gone. */
  hash: string | null
}

export interface BufferState {
  dirty: boolean
  saving: boolean
  conflict?: Conflict
  /** Unsaved text came back from the last session. */
  restored: boolean
  /** HEAD's text for the change markers; `null` when there are none to draw. */
  base: Text | null
  revision: number
}

const BACKUP_KEY = 'dsh-agent-hub.editor.drafts.v1'
const BACKUP_MAX = 1 << 20
const BACKUP_TOTAL = 4 << 20

interface Backup {
  text: string
  /** The disk hash the unsaved text was made against. */
  base: string
  at: number
}

function readBackups(): Record<string, Backup> {
  try {
    const parsed = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '{}') as Record<string, Backup>
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeBackup(key: string, backup: Backup | undefined): void {
  try {
    const all = readBackups()
    if (backup === undefined) delete all[key]
    else all[key] = backup
    // Oldest first out when over budget.
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at)
    let total = 0
    const kept: Record<string, Backup> = {}
    for (const [name, value] of entries) {
      total += value.text.length
      if (total <= BACKUP_TOTAL) kept[name] = value
    }
    if (Object.keys(kept).length === 0) localStorage.removeItem(BACKUP_KEY)
    else localStorage.setItem(BACKUP_KEY, JSON.stringify(kept))
  } catch {
    // Private mode or a full quota: no backup, the buffer itself is unaffected.
  }
}

/** One file's identity on the host: Windows paths compare without case. */
export function fileKey(absolutePath: string): string {
  const normal = absolutePath.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(normal) ? normal.toLowerCase() : normal
}

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

/** The minimal change turning `doc` into `text`. */
export function changesTo(doc: Text, text: string): ChangeSet {
  const target = normalize(text)
  const source = doc.toString()
  if (source === target) return ChangeSet.empty(doc.length)
  const specs: ChangeSpec[] = diff(source, target, { scanLimit: 5000, timeout: 300 })
    .map((change) => ({ from: change.fromA, to: change.toA, insert: target.slice(change.fromB, change.toB) }))
  return ChangeSet.of(specs, doc.length)
}

export class Buffer {
  readonly key: string
  file: Omit<FileText, 'text'>
  /** The text as last read from or written to disk. */
  saved: Text
  doc: Text
  eol: Eol
  bom: boolean
  /** Tabs showing this buffer, and the views of those on screen. */
  readonly tabs = new Set<string>()
  readonly views = new Map<string, EditorView>()
  /** States of tabs whose body is not mounted. */
  readonly parked = new Map<string, { state: EditorState; scroll: { top: number; left: number } }>()
  private state: BufferState
  private readonly listeners = new Set<() => void>()
  private readonly call: FilesCall
  private readonly cwd: string
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined
  private backupTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<boolean> | undefined
  private checking: Promise<void> | undefined
  private checkAgain = false
  private baseAt = 0
  /** Notified with every tab's dirty flag. */
  onDirty: (tabs: Iterable<string>, dirty: boolean) => void = () => {}

  constructor(call: FilesCall, cwd: string, file: FileText) {
    this.call = call
    this.cwd = cwd
    this.key = fileKey(file.absolutePath)
    const { text, ...meta } = file
    this.file = meta
    this.eol = file.eol
    this.bom = file.bom
    this.saved = Text.of(normalize(text).split('\n'))
    this.doc = this.saved
    this.state = { dirty: false, saving: false, restored: false, base: null, revision: 0 }
    const backup = readBackups()[this.key]
    if (backup !== undefined && normalize(backup.text) !== normalize(text)) {
      this.doc = Text.of(normalize(backup.text).split('\n'))
      this.state = { ...this.state, dirty: true, restored: true }
      // Made against an older file: the disk has moved on since.
      if (backup.base !== file.hash) this.state.conflict = { text, hash: file.hash }
    }
    void this.refreshBase()
  }

  get snapshot(): BufferState {
    return this.state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): BufferState => this.state

  private set(patch: Partial<BufferState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    for (const listener of this.listeners) listener()
  }

  private setDirty(dirty: boolean): void {
    if (dirty !== this.state.dirty) {
      this.set({ dirty, ...(dirty ? {} : { restored: false }) })
      this.onDirty(this.tabs, dirty)
    }
    this.scheduleBackup()
  }

  /** The doc moved (any tab, any cause): settle the dirty flag cheaply first, exactly soon after. */
  private docChanged(): void {
    clearTimeout(this.dirtyTimer)
    if (this.doc === this.saved) this.setDirty(false)
    else if (this.doc.length !== this.saved.length) this.setDirty(true)
    else this.dirtyTimer = setTimeout(() => this.setDirty(!this.doc.eq(this.saved)), 80)
  }

  private scheduleBackup(): void {
    clearTimeout(this.backupTimer)
    this.backupTimer = setTimeout(() => {
      if (!this.state.dirty || this.doc.length > BACKUP_MAX) writeBackup(this.key, undefined)
      else writeBackup(this.key, { text: this.doc.toString(), base: this.file.hash, at: Date.now() })
    }, 800)
  }

  /** A tab's own edit: replay it into the buffer's other tabs. */
  edited(fromTab: string, tr: Transaction): void {
    this.doc = tr.state.doc
    const replay = { changes: tr.changes, annotations: [Replayed.of(true), Transaction.addToHistory.of(false)] }
    for (const [tab, view] of this.views) if (tab !== fromTab) view.dispatch(replay)
    for (const [tab, parked] of this.parked) if (tab !== fromTab) parked.state = parked.state.update(replay).state
    this.docChanged()
  }

  /**
   * Put `text` in, as a minimal change: through `via`'s view (undoable when `history`), else into
   * every state. `saved`: the text is what is on disk now, so the buffer ends up clean.
   */
  replace(text: string, options: { history: boolean; userEvent: string; via?: string | undefined; saved?: boolean }): boolean {
    const changes = changesTo(this.doc, text)
    if (options.saved) this.saved = changes.empty ? this.doc : changes.apply(this.doc)
    if (!changes.empty) {
      const view = (options.via === undefined ? undefined : this.views.get(options.via)) ?? this.views.values().next().value
      if (view !== undefined) {
        view.dispatch({ changes, annotations: [Transaction.addToHistory.of(options.history), Transaction.userEvent.of(options.userEvent)] })
      } else {
        for (const parked of this.parked.values()) {
          parked.state = parked.state.update({ changes, annotations: [Transaction.addToHistory.of(false)] }).state
        }
        this.doc = changes.apply(this.doc)
      }
    }
    if (options.saved) this.saved = this.doc
    this.docChanged()
    return !changes.empty
  }

  park(tab: string, view: EditorView): void {
    if (this.views.get(tab) !== view) return
    this.views.delete(tab)
    this.parked.set(tab, { state: view.state, scroll: { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft } })
  }

  /** The state a tab's body mounts with: its own parked one, or a fresh one on the current text. */
  unpark(tab: string, create: (doc: Text) => EditorState): { state: EditorState; scroll?: { top: number; left: number } } {
    const parked = this.parked.get(tab)
    this.parked.delete(tab)
    if (parked === undefined) return { state: create(this.doc) }
    // Parked states follow every edit, so this is a check, not a merge.
    if (parked.state.doc.length === this.doc.length && parked.state.doc.eq(this.doc)) return parked
    return { state: parked.state.update({ changes: changesTo(parked.state.doc, this.doc.toString()), annotations: [Transaction.addToHistory.of(false)] }).state, scroll: parked.scroll }
  }

  /** Write the buffer. `force`: over whatever is on disk now (the person chose their version). */
  save(force = false): Promise<boolean> {
    if (this.saving !== undefined) return this.saving.then(() => (this.state.dirty ? this.save(force) : true))
    const doc = this.doc
    const base = force && this.state.conflict !== undefined ? this.state.conflict.hash : this.file.hash
    this.set({ saving: true })
    this.saving = (async () => {
      const reply = await this.call<Written>({ op: 'write', cwd: this.cwd, path: this.file.absolutePath, text: doc.toString(), base, eol: this.eol, bom: this.bom })
      if (reply.ok) {
        this.file = { ...this.file, hash: reply.value.hash, size: reply.value.size }
        this.saved = doc
        this.set({ conflict: undefined, restored: false })
        this.docChanged()
        return true
      }
      if (reply.error.code === 'conflict') {
        const current = reply.error.current
        if (current !== undefined) this.set({ conflict: { text: current.text, hash: current.hash } })
        else if (reply.error.deleted) this.set({ conflict: { hash: null } })
        return false
      }
      throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
    })().finally(() => {
      this.saving = undefined
      this.set({ saving: false })
      if (this.checkAgain) {
        this.checkAgain = false
        void this.checkDisk()
      }
    })
    return this.saving
  }

  /** The file changed on disk (DSH's watcher said so): follow it, or report the conflict. */
  checkDisk(): Promise<void> {
    if (this.saving !== undefined || this.checking !== undefined) {
      this.checkAgain = true
      return this.checking ?? Promise.resolve()
    }
    this.checking = (async () => {
      const reply = await this.call<FileText>({ op: 'read', cwd: this.cwd, path: this.file.absolutePath })
      if (!reply.ok) {
        if (reply.error.code === 'not-found') this.set({ conflict: { hash: null } })
        return
      }
      const disk = reply.value
      if (disk.hash === this.file.hash && this.state.conflict === undefined) return
      const { text, ...meta } = disk
      if (!this.state.dirty || normalize(text) === this.doc.toString()) {
        this.file = meta
        this.eol = disk.eol
        this.bom = disk.bom
        this.replace(text, { history: false, userEvent: 'reload', saved: true })
        this.set({ conflict: undefined })
        void this.refreshBase(true)
        return
      }
      this.set({ conflict: { text, hash: disk.hash } })
    })().catch(() => {}).finally(() => {
      this.checking = undefined
      if (this.checkAgain) {
        this.checkAgain = false
        void this.checkDisk()
      }
    })
    return this.checking
  }

  /** Drop the unsaved changes for what is on disk (undoable from the tab that asked). */
  takeDisk(via?: string): void {
    const conflict = this.state.conflict
    if (conflict?.text === undefined || conflict.hash === null) return
    this.file = { ...this.file, hash: conflict.hash }
    this.replace(conflict.text, { history: true, userEvent: 'reload', via, saved: true })
    this.set({ conflict: undefined, restored: false })
  }

  /** Forget restored text: back to the file on disk. */
  discardRestored(via?: string): void {
    void this.call<FileText>({ op: 'read', cwd: this.cwd, path: this.file.absolutePath }).then((reply) => {
      if (!reply.ok) return
      const { text, ...meta } = reply.value
      this.file = meta
      this.replace(text, { history: true, userEvent: 'reload', via, saved: true })
      this.set({ conflict: undefined, restored: false })
    })
  }

  /** HEAD's text, re-read at most every few seconds (or now when `force`). */
  async refreshBase(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.baseAt < 4000) return
    this.baseAt = now
    const reply = await this.call<BaseText>({ op: 'base', cwd: this.cwd, path: this.file.absolutePath }).catch(() => undefined)
    if (reply === undefined || !reply.ok) return
    const text = reply.value.text
    const base = text === undefined ? null : Text.of(normalize(text).split('\n'))
    if (base === null && this.state.base === null) return
    if (base !== null && this.state.base !== null && base.eq(this.state.base)) return
    this.set({ base })
  }

  /** The last tab let go: drop the buffer, and its backup when nothing is unsaved. */
  dispose(): void {
    clearTimeout(this.dirtyTimer)
    clearTimeout(this.backupTimer)
    if (!this.state.dirty) writeBackup(this.key, undefined)
    this.listeners.clear()
  }

  /** Let unsaved changes go for good (the tab closed without saving). */
  discard(): void {
    clearTimeout(this.backupTimer)
    writeBackup(this.key, undefined)
  }
}

export type OpenResult = { ok: true; buffer: Buffer } | { ok: false; error: FilesError }

/** Every open buffer, by file; each tab holds one. */
export class Buffers {
  private readonly byKey = new Map<string, Buffer>()
  private readonly byTab = new Map<string, Buffer>()
  private readonly opening = new Map<string, Promise<OpenResult>>()

  private readonly onDirty: (tabs: Iterable<string>, dirty: boolean) => void

  constructor(onDirty: (tabs: Iterable<string>, dirty: boolean) => void) {
    this.onDirty = onDirty
  }

  current(tab: string): Buffer | undefined {
    return this.byTab.get(tab)
  }

  /** The buffer for a tab's file, read once and shared with every other tab on the same file. */
  open(call: FilesCall, tab: string, cwd: string, path: string): Promise<OpenResult> {
    const held = this.byTab.get(tab)
    if (held !== undefined) return Promise.resolve({ ok: true, buffer: held })
    const pending = this.opening.get(tab)
    if (pending !== undefined) return pending
    const promise = (async (): Promise<OpenResult> => {
      const reply = await call<FileText>({ op: 'read', cwd, path })
      if (!reply.ok) return { ok: false, error: reply.error }
      const key = fileKey(reply.value.absolutePath)
      let buffer = this.byKey.get(key)
      if (buffer === undefined) {
        buffer = new Buffer(call, cwd, reply.value)
        buffer.onDirty = this.onDirty
        this.byKey.set(key, buffer)
      } else void buffer.checkDisk()
      buffer.tabs.add(tab)
      this.byTab.set(tab, buffer)
      if (buffer.snapshot.dirty) this.onDirty([tab], true)
      return { ok: true, buffer }
    })().catch((error: unknown): OpenResult => ({ ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } }))
      .finally(() => this.opening.delete(tab))
    this.opening.set(tab, promise)
    return promise
  }

  /** The tab closed: its buffer goes with its last tab. `discard`: unsaved changes too. */
  release(tab: string, discard = false): void {
    const buffer = this.byTab.get(tab)
    if (buffer === undefined) return
    this.byTab.delete(tab)
    buffer.tabs.delete(tab)
    buffer.parked.delete(tab)
    this.onDirty([tab], false)
    if (buffer.tabs.size > 0) return
    if (discard) buffer.discard()
    buffer.dispose()
    this.byKey.delete(buffer.key)
  }
}
