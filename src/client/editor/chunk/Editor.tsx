/**
 * The code tab's body: CodeMirror 6 on one buffer, with a slim path header,
 * notice bars (conflict, deleted, restored, close with unsaved changes), a
 * status line, and on touch screens an action bar for the selection.
 *
 * Keys follow VS Code: Ctrl/⌘+S saves, Shift+Alt+F formats, F12 / Ctrl+click
 * goes to a definition, Shift+F12 lists references, Ctrl/⌘+L adds the
 * selection to the session (`@path L12-30`), Ctrl/⌘+F / H / G find, replace
 * and go to a line, Alt+click adds a cursor.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Compartment, EditorState, Prec, RangeSet, type Extension, type Text, type Transaction } from '@codemirror/state'
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting,
} from '@codemirror/language'
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { unifiedMergeView } from '@codemirror/merge'
import { tagHighlighter, tags } from '@lezer/highlight'
import type { FilesError, Formatted, Location } from '../../../files/types.ts'
import { baseName, copyText as writeClipboard, extensionOf, isMenuKey, PREVIEW_FIRST, type FilesCall, type editorShared } from '../shared.ts'
import { keyHint, SEARCH_KEY, t, type EditorKey } from '../i18n.ts'
import type { Menu as MenuComponent, MenuAnchor, MenuEntry } from '../../git/kit.tsx'
import { Buffers, Replayed, type Buffer, type BufferState, type OpenResult } from './buffers.ts'
import { changeGutter, changeMarkers, definitionLinks, flash, flashLine, setChanges, theme, wordAt } from './extensions.ts'
import { languageOf, PLAIN } from './languages.ts'

export interface Place {
  line: number
  column?: number
  length?: number
}

export interface EditorHost {
  call: FilesCall
  shared: typeof editorShared
  /** Open a file (relative to the session folder, or absolute) in the sidebar, at a place. */
  openFile(path: string, place?: Place): void
  /** Replace this tab with DSH's preview of the same file. */
  openPreview(): void
  openReferences(word: string): void
  openSearch(query: string): void
  /** Insert into the session's composer; false when there is none. */
  insert(text: string): boolean
  /** Show the session again (the sidebar covers it on phones). */
  backToSession?: () => void
  /** Close this tab (after the person chose what to do with unsaved changes). */
  close(): void
  Menu: typeof MenuComponent
}

export interface CodeEditorProps {
  tabId: string
  cwd: string
  /** As the address names it: relative to `cwd`, or absolute. */
  path: string
  visible: boolean
  /** DSH's file version for this address; a change means the file changed on disk. */
  version: string | undefined
  /** Fires when the tab is closed for good. */
  signal: AbortSignal
  navigation: { revision: number; place?: Place }
  coarse: boolean
  /** The sidebar covers the session (phones, fullscreen). */
  covering: boolean
  host: EditorHost
}

let buffers: Buffers | undefined
const released = new Set<string>()
/** The navigation revision each tab answered last, so a remount does not jump again. */
const answered = new Map<string, number>()

const WRAP_KEY = 'dsh-agent-hub.editor.wrap'
const LARGE = 2 << 20

function readWrap(coarse: boolean): boolean {
  try {
    const value = localStorage.getItem(WRAP_KEY)
    return value === null ? coarse : value === '1'
  } catch {
    return coarse
  }
}

const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.self], class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.character, tags.docString], class: 'tok-string' },
  { tag: [tags.regexp, tags.escape], class: 'tok-string2' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null, tags.unit], class: 'tok-number' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'tok-comment' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], class: 'tok-type' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], class: 'tok-function' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName), tags.definition(tags.typeName)], class: 'tok-def' },
  { tag: tags.propertyName, class: 'tok-property' },
  { tag: [tags.tagName], class: 'tok-tag' },
  { tag: [tags.attributeName], class: 'tok-attr' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], class: 'tok-meta' },
  { tag: [tags.heading], class: 'tok-heading' },
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.emphasis, class: 'tok-em' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.inserted, class: 'tok-inserted' },
  { tag: tags.deleted, class: 'tok-deleted' },
  { tag: tags.invalid, class: 'tok-invalid' },
  { tag: [tags.labelName, tags.special(tags.variableName)], class: 'tok-special' },
])

const ZH_PHRASES: Record<string, string> = {
  Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部', 'match case': '区分大小写',
  regexp: '正则', 'by word': '全字', replace: '替换', 'replace all': '全部替换', close: '关闭', 'current match': '当前匹配',
  'replaced $ matches': '已替换 $ 处', 'replaced match on line $': '已替换第 $ 行的匹配', 'on line': '在行', 'Go to line': '转到行',
  go: '跳转', 'folded code': '折叠的代码', unfold: '展开', Accept: '保留', Reject: '用磁盘版本', 'Revert this chunk': '还原这一处',
  '$ unchanged lines': '$ 行未改动', 'Control character': '控制字符', to: '到',
}

/** Tabs or the indent width most lines use. */
function detectIndent(doc: Text): { unit: string; size: number } {
  let tabs = 0
  let spaced = 0
  const widths = new Map<number, number>()
  let previous = 0
  const limit = Math.min(doc.lines, 3000)
  for (let n = 1; n <= limit; n++) {
    const text = doc.line(n).text
    if (text.trim() === '') continue
    if (text.startsWith('\t')) {
      tabs++
      continue
    }
    const width = text.length - text.trimStart().length
    const delta = Math.abs(width - previous)
    previous = width
    if (delta >= 2 && delta <= 8) {
      spaced++
      widths.set(delta, (widths.get(delta) ?? 0) + 1)
    }
  }
  if (tabs > spaced) return { unit: '\t', size: 4 }
  let best = 2
  let count = 0
  for (const [width, seen] of widths) if (seen > count || (seen === count && width < best)) [best, count] = [width, seen]
  return spaced === 0 ? { unit: '  ', size: 2 } : { unit: ' '.repeat(best), size: best }
}

/** Syntax highlighting costs more than it gives on very large or minified files. */
function heavy(doc: Text): boolean {
  if (doc.length > LARGE) return true
  const limit = Math.min(doc.lines, 5000)
  for (let n = 1; n <= limit; n++) if (doc.line(n).length > 10_000) return true
  return false
}

interface Toast {
  id: number
  text: string
  kind?: 'error'
  action?: { label: string; run: () => void }
}

/** The editor body for one tab. */
export function CodeEditor(props: CodeEditorProps): ReactNode {
  const { host, tabId } = props
  buffers ??= new Buffers((tabs, dirty) => { for (const tab of tabs) host.shared.dirtyTabs.toggle(tab, dirty) })
  const store = buffers
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<OpenResult | undefined>(() => {
    const held = store.current(tabId)
    return held === undefined ? undefined : { ok: true, buffer: held }
  })
  useEffect(() => {
    let alive = true
    void store.open(host.call, tabId, props.cwd, props.path).then((next) => { if (alive) setResult(next) })
    return () => { alive = false }
  }, [store, tabId, props.cwd, props.path, attempt])
  // The tab itself closed: let the buffer go (with its unsaved text if the person said so).
  useEffect(() => {
    if (released.has(tabId)) return
    const release = (): void => {
      released.add(tabId)
      answered.delete(tabId)
      store.release(tabId, host.shared.discard.delete(tabId))
    }
    if (props.signal.aborted) release()
    else props.signal.addEventListener('abort', release, { once: true })
  }, [props.signal])
  if (result === undefined) return <div className="ce-state"><span className="ce-spinner" aria-hidden="true" />{t('loading')}</div>
  if (!result.ok) return <OpenFailure error={result.error} path={props.path} host={host} retry={() => setAttempt((n) => n + 1)} />
  return <EditorBody {...props} buffer={result.buffer} />
}

const FAILURE_TEXT: Partial<Record<FilesError['code'], EditorKey>> = {
  'too-large': 'tooLarge', binary: 'binary', 'not-utf8': 'notUtf8', denied: 'denied', 'not-found': 'notFound',
}

function OpenFailure(props: { error: FilesError; path: string; host: EditorHost; retry: () => void }): ReactNode {
  const key = FAILURE_TEXT[props.error.code]
  const previewable = props.error.code !== 'not-found'
  return (
    <div className="ce-state" role="alert">
      <p>{key === undefined ? t('readFailed', { message: props.error.message }) : t(key)}</p>
      <div className="ce-state-actions">
        {previewable && <button type="button" className="ah-btn ah-btn-sm" onClick={props.host.openPreview}>{t('openPreview')}</button>}
        {(key === undefined || props.error.code === 'not-found') && <button type="button" className="ah-btn ah-btn-sm" onClick={props.retry}>{t('retry')}</button>}
      </div>
    </div>
  )
}

interface Cursor {
  line: number
  col: number
  chars: number
  lines: number
  /** Ranges with text selected. */
  selected: boolean
}

function cursorOf(state: EditorState): Cursor {
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  let chars = 0
  let lines = 0
  for (const range of state.selection.ranges) {
    if (range.empty) continue
    chars += range.to - range.from
    lines += state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1
  }
  return { line: line.number, col: main.head - line.from + 1, chars, lines, selected: chars > 0 }
}

function useBuffer(buffer: Buffer): BufferState {
  return useSyncExternalStore(buffer.subscribe, buffer.getSnapshot)
}

function EditorBody(props: CodeEditorProps & { buffer: Buffer }): ReactNode {
  const { buffer, host, tabId, coarse } = props
  const state = useBuffer(buffer)
  const parent = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [cursor, setCursor] = useState<Cursor>({ line: 1, col: 1, chars: 0, lines: 0, selected: false })
  const [wrap, setWrap] = useState(() => readWrap(coarse))
  const [comparing, setComparing] = useState(false)
  const [closeAsk, setCloseAsk] = useState(false)
  const [toast, setToast] = useState<Toast | undefined>()
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[]; onSelect: (id: string) => void; label: string } | undefined>()
  const compartments = useMemo(() => ({ wrap: new Compartment(), merge: new Compartment(), language: new Compartment() }), [])
  const name = baseName(buffer.file.path)
  const ext = extensionOf(name)
  const language = useMemo(() => (heavy(buffer.doc) ? PLAIN : languageOf(name)), [buffer, name])
  const plainLarge = language === PLAIN && heavy(buffer.doc)
  const indent = useMemo(() => detectIndent(buffer.doc), [buffer])

  const say = useCallback((text: string, extra: Omit<Toast, 'id' | 'text'> = {}) => setToast({ id: Date.now() + Math.random(), text, ...extra }), [])
  useEffect(() => {
    if (toast === undefined) return
    const timer = setTimeout(() => setToast((current) => (current?.id === toast.id ? undefined : current)), toast.action === undefined ? 2400 : 5000)
    return () => clearTimeout(timer)
  }, [toast])

  // ── Commands ────────────────────────────────────────────────────────────────
  const actions = useRef({
    save: async (): Promise<boolean> => false,
    format: async (): Promise<void> => {},
    add: (_selection?: EditorState): void => {},
    menu: (_view: EditorView, _anchor: MenuAnchor): void => {},
    definition: async (_pos?: number): Promise<void> => {},
    references: (_pos?: number): void => {},
  })

  actions.current.save = async () => {
    const conflict = buffer.snapshot.conflict
    if (conflict !== undefined && conflict.hash !== null) {
      say(t('conflict'), { kind: 'error' })
      return false
    }
    if (!buffer.snapshot.dirty && conflict === undefined) return true
    try {
      const ok = await buffer.save(conflict?.hash === null)
      if (ok) say(t('saved'))
      return ok
    } catch (error) {
      say(t('saveFailed', { message: error instanceof Error ? error.message : String(error) }), { kind: 'error' })
      return false
    }
  }

  actions.current.format = async () => {
    const view = viewRef.current
    if (view === null) return
    const before = view.state.doc
    const reply = await host.call<Formatted>({ op: 'format', cwd: props.cwd, path: buffer.file.absolutePath, text: before.toString() })
    if (viewRef.current !== view) return
    if (!reply.ok) {
      say(reply.error.code === 'unavailable' ? t('formatUnavailable') : reply.error.message, { kind: 'error' })
      return
    }
    if (view.state.doc !== before) {
      say(t('formatChanged'), { kind: 'error' })
      return
    }
    const changed = buffer.replace(reply.value.text, { history: true, userEvent: 'input.format', via: tabId })
    say(t(changed ? 'formatted' : 'formatClean', { name: reply.value.formatter }))
  }

  actions.current.add = (captured) => {
    const view = viewRef.current
    if (view === null) return
    const { doc, selection } = captured ?? view.state
    const path = buffer.file.path
    const mention = /[\s"]/.test(path) ? `@"${path}"` : `@${path}`
    const spans = selection.ranges.filter((range) => !range.empty).map((range) => {
      const first = doc.lineAt(range.from).number
      let last = doc.lineAt(range.to).number
      // A selection ending at the start of a line does not include that line.
      if (last > first && doc.lineAt(range.to).from === range.to) last--
      return first === last ? `L${first}` : `L${first}-${last}`
    })
    const inserted = host.insert(` ${mention}${spans.length > 0 ? ` ${spans.join(', ')}` : ''} `)
    if (!inserted) return say(t('addedNoComposer'), { kind: 'error' })
    const back = props.covering && host.backToSession !== undefined ? { action: { label: t('backToSession'), run: host.backToSession } } : {}
    say(t(buffer.snapshot.dirty ? 'addedDirty' : 'added'), back)
  }

  actions.current.menu = (view, anchor) => {
    const captured = view.state
    const text = captured.selection.ranges.filter((range) => !range.empty).map((range) => captured.sliceDoc(range.from, range.to)).join('\n')
    setMenu({
      label: t('selectionMenu'), anchor,
      entries: [
        { id: 'copy', label: t('copy'), disabled: text === '' },
        { id: 'add', label: t('addToSession'), hint: keyHint('Mod-L') },
      ],
      onSelect: (id) => {
        setMenu(undefined)
        if (id === 'add') actions.current.add(captured)
        else if (text !== '') void writeClipboard(text).then(() => say(t('copied')), () => say(t('copyFailed'), { kind: 'error' }))
        view.focus()
      },
    })
  }

  useEffect(() => { setMenu(undefined) }, [props.visible, buffer])

  const samePath = (path: string): boolean => path === buffer.file.path || path.toLowerCase() === buffer.file.absolutePath.replace(/\\/g, '/').toLowerCase()

  const jump = useCallback((view: EditorView, place: Place) => {
    const doc = view.state.doc
    const line = doc.line(Math.max(1, Math.min(doc.lines, place.line)))
    const from = Math.min(line.to, line.from + Math.max(0, (place.column ?? 1) - 1))
    const to = Math.min(line.to, from + (place.length ?? 0))
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: [EditorView.scrollIntoView(from, { y: 'center' }), flashLine.of(line.from)],
    })
    if (!coarse) view.focus()
  }, [coarse])

  const open = (location: Location, length: number): void => {
    const view = viewRef.current
    const place = { line: location.line, column: location.column, length }
    if (view !== null && samePath(location.path)) jump(view, place)
    else host.openFile(location.path, place)
  }

  actions.current.references = (pos) => {
    const view = viewRef.current
    if (view === null) return
    const word = wordAt(view.state, pos ?? view.state.selection.main.head)
    if (word === undefined) return say(t('noWord'))
    host.openReferences(word.text)
  }

  actions.current.definition = async (pos) => {
    const view = viewRef.current
    if (view === null) return
    const at = pos ?? view.state.selection.main.head
    const word = wordAt(view.state, at)
    if (word === undefined) return say(t('noWord'))
    const reply = await host.call<Location[]>({ op: 'definition', cwd: props.cwd, path: buffer.file.absolutePath, word: word.text })
    if (viewRef.current !== view) return
    if (!reply.ok) return say(reply.error.message, { kind: 'error' })
    const here = view.state.doc.lineAt(at).number
    const found = reply.value.filter((location) => !(samePath(location.path) && location.line === here))
    // On the declaration itself: what uses it is the useful answer (as VS Code does).
    if (found.length === 0 && reply.value.length > 0) return host.openReferences(word.text)
    if (found.length === 0) {
      return say(t('noDefinition', { word: word.text }), { action: { label: t('references'), run: () => host.openReferences(word.text) } })
    }
    if (found.length === 1) return open(found[0]!, word.text.length)
    const coords = view.coordsAtPos(at)
    setMenu({
      label: t('definitionsOf', { word: word.text }),
      anchor: { x: coords?.left ?? 0, y: (coords?.bottom ?? 0) + 4 },
      entries: [
        { heading: t('definitionsOf', { word: word.text }) },
        ...found.map((location, index) => ({ id: String(index), label: location.preview.slice(0, 90), hint: `${baseName(location.path)}:${location.line}` })),
      ],
      onSelect: (id) => {
        setMenu(undefined)
        const location = found[Number(id)]
        if (location !== undefined) open(location, word.text.length)
      },
    })
  }

  // ── The view ────────────────────────────────────────────────────────────────
  const extensions = useCallback((): Extension[] => [
    lineNumbers(),
    changeGutter,
    foldGutter({ openText: '⌄', closedText: '›' }),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor({ key: 'Alt' }),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(highlighter),
    indentUnit.of(indent.unit),
    EditorState.tabSize.of(indent.size),
    compartments.language.of(language.load()),
    compartments.wrap.of(wrap ? EditorView.lineWrapping : []),
    compartments.merge.of([]),
    definitionLinks((_view, pos) => void actions.current.definition(pos)),
    flash,
    theme(coarse),
    document.documentElement.lang.toLowerCase().startsWith('en') ? [] : EditorState.phrases.of(ZH_PHRASES),
    EditorView.contentAttributes.of({ 'aria-label': name, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
    Prec.highest(keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { void actions.current.save(); return true } },
      { key: 'Shift-Alt-f', preventDefault: true, run: () => { void actions.current.format(); return true } },
      { key: 'Mod-l', preventDefault: true, run: () => { actions.current.add(); return true } },
      { key: 'F12', preventDefault: true, run: () => { void actions.current.definition(); return true } },
      { key: 'Shift-F12', preventDefault: true, run: () => { actions.current.references(); return true } },
      { key: 'Mod-g', preventDefault: true, run: gotoLine },
    ])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        if (tr.docChanged && tr.annotation(Replayed) !== true) buffer.edited(tabId, tr as Transaction)
      }
      if (update.docChanged) scheduleMarkers()
      if (update.selectionSet || update.docChanged) scheduleCursor()
    }),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        // Preserve the existing selection on a secondary click, even outside its highlight.
        if (event.button === 2 && view.state.selection.ranges.some((range) => !range.empty)) event.preventDefault()
        return false
      },
      contextmenu: (event, view) => {
        event.preventDefault()
        actions.current.menu(view, { x: event.clientX, y: event.clientY })
        return true
      },
      keydown: (event, view) => {
        if (!isMenuKey(event)) return false
        event.preventDefault()
        const rect = view.coordsAtPos(view.state.selection.main.head) ?? view.dom.getBoundingClientRect()
        actions.current.menu(view, { x: rect.left, y: rect.bottom })
        return true
      },
      focus: (_event, view) => {
        host.shared.selection = () => {
          const main = view.state.selection.main
          return main.empty ? (wordAt(view.state, main.head)?.text ?? '') : view.state.sliceDoc(main.from, main.to)
        }
        return false
      },
    }),
  ], [buffer, language, indent])

  const markerTimer = useRef<ReturnType<typeof setTimeout>>()
  const cursorFrame = useRef(0)
  const scheduleMarkers = (): void => {
    clearTimeout(markerTimer.current)
    markerTimer.current = setTimeout(() => {
      const view = viewRef.current
      const base = buffer.snapshot.base
      if (view === null) return
      if (base === null || view.state.doc.length > LARGE) view.dispatch({ effects: setChanges.of(RangeSet.empty) })
      else view.dispatch({ effects: setChanges.of(changeMarkers(base, view.state.doc)) })
    }, 250)
  }
  const scheduleCursor = (): void => {
    cancelAnimationFrame(cursorFrame.current)
    cursorFrame.current = requestAnimationFrame(() => {
      const view = viewRef.current
      if (view !== null) setCursor(cursorOf(view.state))
    })
  }

  useLayoutEffect(() => {
    const element = parent.current
    if (element === null) return
    const { state: initial, scroll } = buffer.unpark(tabId, (doc) => EditorState.create({ doc, extensions: extensions() }))
    const view = new EditorView({ state: initial, parent: element })
    viewRef.current = view
    buffer.views.set(tabId, view)
    view.dispatch({ effects: [compartments.wrap.reconfigure(readWrap(coarse) ? EditorView.lineWrapping : [])] })
    if (scroll !== undefined) requestAnimationFrame(() => { view.scrollDOM.scrollTop = scroll.top; view.scrollDOM.scrollLeft = scroll.left })
    setCursor(cursorOf(view.state))
    scheduleMarkers()
    return () => {
      clearTimeout(markerTimer.current)
      cancelAnimationFrame(cursorFrame.current)
      buffer.park(tabId, view)
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [buffer, extensions])

  // Change markers follow HEAD (a commit moves it); re-read it when the page comes back.
  useEffect(() => { scheduleMarkers() }, [state.base])
  useEffect(() => {
    const again = (): void => { if (document.visibilityState === 'visible') void buffer.refreshBase() }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [buffer])

  // The file changed on disk.
  const seenVersion = useRef(props.version)
  useEffect(() => {
    if (props.version === undefined || props.version === seenVersion.current) return
    seenVersion.current = props.version
    void buffer.checkDisk()
  }, [props.version, buffer])

  // Navigation: a link, a search result or a definition opened this tab at a place.
  useEffect(() => {
    const view = viewRef.current
    const { revision, place } = props.navigation
    if (view === null || place === undefined || answered.get(tabId) === revision) return
    answered.set(tabId, revision)
    jump(view, place)
  }, [props.navigation.revision, buffer])

  useEffect(() => {
    const view = viewRef.current
    if (view !== null) view.dispatch({ effects: compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap])

  // Compare with the disk version while in conflict: a unified diff inside the editor.
  const conflictText = state.conflict?.text
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const on = comparing && conflictText !== undefined
    view.dispatch({ effects: compartments.merge.reconfigure(on ? unifiedMergeView({ original: conflictText, mergeControls: true, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true }) : []) })
  }, [comparing, conflictText])
  useEffect(() => { if (state.conflict === undefined) setComparing(false) }, [state.conflict])

  // A close of this tab with unsaved changes asks here.
  useEffect(() => {
    const listener = (request: { tabId: string }): void => { if (request.tabId === tabId) setCloseAsk(true) }
    host.shared.closeRequests.add(listener)
    return () => { host.shared.closeRequests.delete(listener) }
  }, [tabId])
  useEffect(() => { if (!state.dirty) setCloseAsk(false) }, [state.dirty])


  const run = (command: (view: EditorView) => boolean): void => {
    const view = viewRef.current
    if (view === null) return
    view.focus()
    command(view)
  }
  const copyText = (text: string): void => {
    void writeClipboard(text).then(() => say(t('copied')), () => say(t('copyFailed'), { kind: 'error' }))
  }

  const moreEntries = (): MenuEntry[] => [
    { id: 'add', label: t('addToSession'), hint: keyHint('Mod-L') },
    { id: 'definition', label: t('definition'), hint: 'F12' },
    { id: 'references', label: t('references'), hint: keyHint('Shift-F12') },
    { separator: true },
    { id: 'find', label: t('find'), hint: keyHint('Mod-F') },
    { id: 'gotoLine', label: t('gotoLine'), hint: keyHint('Mod-G') },
    { id: 'searchWorkspace', label: t('searchWorkspace'), hint: keyHint(SEARCH_KEY()) },
    { separator: true },
    { id: 'format', label: t('format'), hint: keyHint('Shift-Alt-F') },
    { id: 'wrap', label: t('wrap'), checked: wrap },
    { id: 'copyPath', label: t('copyPath') },
    { id: 'preview', label: t('openPreview') },
  ]
  const onMore = (id: string): void => {
    setMenu(undefined)
    const view = viewRef.current
    if (id === 'add') actions.current.add()
    else if (id === 'definition') void actions.current.definition()
    else if (id === 'references') actions.current.references()
    else if (id === 'find') run(openSearchPanel)
    else if (id === 'gotoLine') run(gotoLine)
    else if (id === 'searchWorkspace') host.openSearch(view === null ? '' : (host.shared.selection?.() ?? ''))
    else if (id === 'format') void actions.current.format()
    else if (id === 'wrap') {
      const next = !wrap
      setWrap(next)
      try { localStorage.setItem(WRAP_KEY, next ? '1' : '0') } catch { /* preference only */ }
    } else if (id === 'copyPath') copyText(buffer.file.absolutePath)
    else if (id === 'preview') host.openPreview()
  }

  const dir = buffer.file.path.includes('/') ? buffer.file.path.slice(0, buffer.file.path.lastIndexOf('/') + 1) : ''
  const Menu = host.Menu as ComponentType<Parameters<typeof MenuComponent>[0]>
  const canPreview = PREVIEW_FIRST.has(ext)

  return (
    <div className="ce-editor" data-coarse={coarse ? '' : undefined}>
      <div className="ce-head">
        <div className="ce-path" title={buffer.file.absolutePath}>
          <span className="ce-dir"><bdi>{dir}</bdi></span><span className="ce-name">{name}</span>
          {state.dirty && <span className="ce-dot" role="img" aria-label={t('unsaved')} />}
        </div>
        <div className="ce-actions">
          {canPreview && <IconButton label={t('preview')} onClick={host.openPreview}><IconEye /></IconButton>}
          <IconButton label={`${t('addToSession')} (${keyHint('Mod-L')})`} onClick={() => actions.current.add()} wide><IconChat /></IconButton>
          <IconButton label={`${t('format')} (${keyHint('Shift-Alt-F')})`} onClick={() => void actions.current.format()} wide><IconFormat /></IconButton>
          <IconButton label={`${t('save')} (${keyHint('Mod-S')})`} onClick={() => void actions.current.save()} disabled={!state.dirty && state.conflict === undefined} busy={state.saving}><IconSave /></IconButton>
          <IconButton label={t('more')} onClick={(event) => setMenu({ label: t('more'), anchor: { x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), align: 'end' }, entries: moreEntries(), onSelect: onMore })}><IconMore /></IconButton>
        </div>
      </div>
      {closeAsk && state.dirty && (
        <Bar kind="warn" text={t('closeDirty', { name })}>
          <button type="button" className="ah-btn ah-btn-sm" data-variant="primary" onClick={() => { void actions.current.save().then((ok) => { if (ok) host.close() }) }}>{t('saveClose')}</button>
          <button type="button" className="ah-btn ah-btn-sm" onClick={() => { host.shared.discard.add(tabId); host.close() }}>{t('discardClose')}</button>
          <button type="button" className="ah-btn ah-btn-sm" data-variant="quiet" onClick={() => setCloseAsk(false)}>{t('cancel')}</button>
        </Bar>
      )}
      {state.conflict !== undefined && state.conflict.hash === null && (
        <Bar kind="warn" text={t('deleted')}>
          <button type="button" className="ah-btn ah-btn-sm" onClick={() => void actions.current.save()}>{t('recreate')}</button>
        </Bar>
      )}
      {state.conflict !== undefined && state.conflict.hash !== null && (
        <Bar kind="error" text={t('conflict')}>
          {state.conflict.text !== undefined && <button type="button" className="ah-btn ah-btn-sm" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>{t(comparing ? 'compareOff' : 'compare')}</button>}
          {state.conflict.text !== undefined && <button type="button" className="ah-btn ah-btn-sm" onClick={() => buffer.takeDisk(tabId)}>{t('takeDisk')}</button>}
          <button type="button" className="ah-btn ah-btn-sm" onClick={() => { void buffer.save(true).then((ok) => { if (ok) say(t('saved')) }, (error: Error) => say(t('saveFailed', { message: error.message }), { kind: 'error' })) }}>{t('overwrite')}</button>
        </Bar>
      )}
      {state.restored && state.conflict === undefined && (
        <Bar kind="info" text={t('restored')}>
          <button type="button" className="ah-btn ah-btn-sm" onClick={() => buffer.discardRestored(tabId)}>{t('discardRestored')}</button>
        </Bar>
      )}
      <div ref={parent} className="ce-cm" />
      {coarse && cursor.selected && (
        <div className="ce-touchbar" role="toolbar">
          <button type="button" onClick={() => void actions.current.definition()}>{t('definition')}</button>
          <button type="button" onClick={() => actions.current.references()}>{t('references')}</button>
          <button type="button" onClick={() => actions.current.add()}>{t('addToSession')}</button>
          <button type="button" onClick={() => { const view = viewRef.current; if (view !== null) copyText(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)) }}>{t('copy')}</button>
        </div>
      )}
      {!coarse && (
        <div className="ce-status">
          <span>{t('line', { line: cursor.line, col: cursor.col })}</span>
          {cursor.selected && <span>{cursor.lines > 1 ? t('selectedLines', { n: cursor.lines }) : t('selected', { n: cursor.chars })}</span>}
          <span className="ce-grow" />
          {plainLarge && <span className="ce-muted">{t('plainLarge')}</span>}
          <span className="ce-wide">{indent.unit === '\t' ? t('tabs') : t('spaces', { n: indent.size })}</span>
          <span className="ce-wide">{buffer.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
          <span className="ce-wide">{buffer.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
          <span>{language.name}</span>
        </div>
      )}
      {toast !== undefined && (
        <div className="ce-toast" data-kind={toast.kind} role="status" aria-live="polite">
          <span className="ce-toast-text">{toast.text}</span>
          {toast.action !== undefined && <button type="button" className="ce-link" onClick={() => { setToast(undefined); toast.action!.run() }}>{toast.action.label}</button>}
        </div>
      )}
      {menu !== undefined && <Menu anchor={menu.anchor} entries={menu.entries} label={menu.label} onSelect={menu.onSelect} onClose={() => { setMenu(undefined); viewRef.current?.focus() }} />}
    </div>
  )
}

function Bar(props: { kind: 'info' | 'warn' | 'error'; text: string; children?: ReactNode }): ReactNode {
  return (
    <div className="ce-bar" data-kind={props.kind} role={props.kind === 'error' ? 'alert' : 'status'}>
      <span className="ce-bar-text">{props.text}</span>
      <span className="ce-bar-actions">{props.children}</span>
    </div>
  )
}

function IconButton(props: { label: string; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; children: ReactNode; disabled?: boolean; busy?: boolean; wide?: boolean }): ReactNode {
  return (
    <button type="button" className="ah-icon-btn" title={props.label} aria-label={props.label} disabled={props.disabled}
      data-busy={props.busy ? '' : undefined} data-wide={props.wide ? '' : undefined} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

const svg = (children: ReactNode): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconSave = (): ReactNode => svg(<><path d="M3 3.5a1 1 0 0 1 1-1h6.6L13 4.9V12.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M5.5 2.5v3h4v-3M5 13.5V9.5h6v4" /></>)
const IconFormat = (): ReactNode => svg(<path d="M2.5 4h11M2.5 8h7M2.5 12h9" />)
const IconChat = (): ReactNode => svg(<><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z" /><path d="M8 5v3.5M6.25 6.75h3.5" /></>)
const IconEye = (): ReactNode => svg(<><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>)
const IconMore = (): ReactNode => svg(<><circle cx="3.5" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="12.5" cy="8" r=".6" fill="currentColor" /></>)
