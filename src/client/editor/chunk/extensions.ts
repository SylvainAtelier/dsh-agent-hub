/**
 * CodeMirror pieces of the editor beyond the stock ones: the change markers
 * beside the line numbers (this text against HEAD, as VS Code draws them),
 * Ctrl/⌘-hover definition links, the brief flash on a line jumped to, and the
 * theme, which reads DSH's own color tokens so both themes need no JS.
 */

import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { diff } from '@codemirror/merge'

// ── Change markers ─────────────────────────────────────────────────────────────

type ChangeKind = 'added' | 'modified' | 'deleted'

class ChangeMarker extends GutterMarker {
  readonly kind: ChangeKind
  constructor(kind: ChangeKind) {
    super()
    this.kind = kind
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind
  }
  override toDOM(): Node {
    const element = document.createElement('div')
    element.className = `ce-change ce-change-${this.kind}`
    return element
  }
}

const MARKERS: Record<ChangeKind, ChangeMarker> = {
  added: new ChangeMarker('added'),
  modified: new ChangeMarker('modified'),
  deleted: new ChangeMarker('deleted'),
}

/** Code units standing for whole lines (no surrogates): a line diff is a string diff over them. */
const UNITS = 0xffff - 0x100 - 0x800

function unit(id: number): string {
  const code = 0x100 + id
  return String.fromCharCode(code < 0xd800 ? code : code + 0x800)
}

/** Each distinct line as one character, so the character diff is a line diff. */
function lineString(text: Text, ids: Map<string, number>): string | undefined {
  let out = ''
  for (let n = 1; n <= text.lines; n++) {
    const line = text.line(n).text
    let id = ids.get(line)
    if (id === undefined) {
      if (ids.size >= UNITS) return undefined
      id = ids.size
      ids.set(line, id)
    }
    out += unit(id)
  }
  return out
}

/** Line markers for `doc` against `base`: added and modified lines, and a wedge where lines were deleted. */
export function changeMarkers(base: Text, doc: Text): RangeSet<GutterMarker> {
  const ids = new Map<string, number>()
  const a = lineString(base, ids)
  const b = lineString(doc, ids)
  const builder = new RangeSetBuilder<GutterMarker>()
  if (a === undefined || b === undefined) return builder.finish()
  let at = -1
  const mark = (line: number, kind: ChangeKind): void => {
    const from = doc.line(Math.max(1, Math.min(doc.lines, line))).from
    if (from <= at) return
    at = from
    builder.add(from, from, MARKERS[kind])
  }
  // Positions are line indexes (0-based) here.
  for (const change of diff(a, b, { scanLimit: 4000, timeout: 120 })) {
    if (change.fromB === change.toB) mark(change.fromB + 1, 'deleted')
    else for (let line = change.fromB; line < change.toB; line++) mark(line + 1, change.fromA === change.toA ? 'added' : 'modified')
  }
  return builder.finish()
}

export const setChanges = StateEffect.define<RangeSet<GutterMarker>>()

const changesField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setChanges)) return effect.value
    return tr.docChanged ? value.map(tr.changes) : value
  },
})

export const changeGutter: Extension = [
  changesField,
  gutter({
    class: 'ce-changes-gutter',
    markers: (view) => view.state.field(changesField),
    initialSpacer: () => MARKERS.added,
  }),
]

// ── Definition links (Ctrl/⌘ + hover) ─────────────────────────────────────────

const setLink = StateEffect.define<{ from: number; to: number } | null>()
const linkMark = Decoration.mark({ class: 'ce-def-link' })

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLink)) return effect.value === null ? Decoration.none : Decoration.set([linkMark.range(effect.value.from, effect.value.to)])
    }
    return tr.docChanged ? Decoration.none : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const mod = (event: MouseEvent | KeyboardEvent): boolean => (/Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey)

/** The identifier at a document position. */
export function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | undefined {
  const range = state.wordAt(pos)
  if (range === null) return undefined
  const text = state.sliceDoc(range.from, range.to)
  return /^[\p{L}\p{N}_$][\p{L}\p{N}_$-]*$/u.test(text) ? { from: range.from, to: range.to, text } : undefined
}

/** Ctrl/⌘-click (and hover) on an identifier; Alt-click keeps adding cursors as in VS Code. */
export function definitionLinks(go: (view: EditorView, pos: number) => void): Extension {
  let last: { x: number; y: number } | undefined
  const show = (view: EditorView, on: boolean): void => {
    const pos = on && last !== undefined ? view.posAtCoords(last) : null
    const word = pos === null ? undefined : wordAt(view.state, pos)
    const current = view.state.field(linkField).iter()
    const same = word !== undefined && current.value !== null && current.from === word.from && current.to === word.to
    if (same || (word === undefined && current.value === null)) return
    view.dispatch({ effects: setLink.of(word === undefined ? null : { from: word.from, to: word.to }) })
  }
  return [
    linkField,
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    EditorView.domEventHandlers({
      mousemove(event, view) {
        last = { x: event.clientX, y: event.clientY }
        show(view, mod(event))
      },
      mouseleave(_event, view) {
        last = undefined
        show(view, false)
      },
      keydown(event, view) {
        if (event.key === 'Control' || event.key === 'Meta') show(view, true)
      },
      keyup(_event, view) {
        show(view, false)
      },
      mousedown(event, view) {
        if (!mod(event) || event.button !== 0 || event.altKey || event.shiftKey) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null || wordAt(view.state, pos) === undefined) return false
        event.preventDefault()
        view.dispatch({ selection: { anchor: pos }, effects: setLink.of(null) })
        go(view, pos)
        return true
      },
    }),
  ]
}

// ── Flash a line jumped to ─────────────────────────────────────────────────────

export const flashLine = StateEffect.define<number | null>()
const flashMark = Decoration.line({ class: 'ce-flash' })

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(flashLine)) return effect.value === null ? Decoration.none : Decoration.set([flashMark.range(effect.value)])
    }
    return value.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const flash: Extension = [
  flashField,
  ViewPlugin.fromClass(class {
    private timer: ReturnType<typeof setTimeout> | undefined
    readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
    }
    update(update: ViewUpdate): void {
      if (!update.transactions.some((tr) => tr.effects.some((effect) => effect.is(flashLine) && effect.value !== null))) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.view.dispatch({ effects: flashLine.of(null) }), 1200)
    }
    destroy(): void {
      clearTimeout(this.timer)
    }
  }),
]

// ── Theme ──────────────────────────────────────────────────────────────────────

export function theme(coarse: boolean): Extension {
  return EditorView.theme({
    '&': { height: '100%', fontSize: coarse ? '13.5px' : '12.5px', backgroundColor: 'transparent', color: 'var(--ah-fg)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--ah-mono)', lineHeight: '1.6', overscrollBehavior: 'contain' },
    '.cm-content': { padding: '6px 0 40vh', caretColor: 'var(--ce-caret)' },
    '.cm-line': { padding: '0 14px 0 6px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ce-caret)', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--ce-selection) !important',
    },
    '.cm-activeLine': { backgroundColor: 'var(--ce-active-line)' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--ah-fg3)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: coarse ? '0 2px 0 6px' : '0 4px 0 12px', minWidth: coarse ? '24px' : '32px', fontVariantNumeric: 'tabular-nums' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ah-fg)' },
    '.cm-foldGutter .cm-gutterElement': { width: '14px', color: 'var(--ah-fg3)', opacity: '0', transition: 'opacity 120ms ease' },
    '.cm-gutters:hover .cm-foldGutter .cm-gutterElement': { opacity: '1' },
    '.cm-foldPlaceholder': { background: 'var(--ah-hover)', border: 'none', color: 'var(--ah-fg2)', padding: '0 6px', borderRadius: '4px' },
    '.cm-matchingBracket': { backgroundColor: 'var(--ce-bracket)', outline: '1px solid var(--ce-bracket-line)' },
    '.cm-nonmatchingBracket': { color: 'var(--ah-del)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--ce-match-soft)' },
    '.cm-searchMatch': { backgroundColor: 'var(--ce-match)', outline: '1px solid var(--ce-match-line)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ce-match-strong)' },
    '.cm-tooltip': { border: '.5px solid var(--ah-line)', backgroundColor: 'var(--ah-popup)', borderRadius: '8px', boxShadow: 'var(--ah-shadow)', overflow: 'hidden' },
    '.cm-panels': { backgroundColor: 'var(--ah-bg)', color: 'var(--ah-fg)' },
    '.cm-panels.cm-panels-top': { borderBottom: '.5px solid var(--ah-line)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '.5px solid var(--ah-line)' },
  })
}
