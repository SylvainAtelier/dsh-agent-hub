/**
 * What the code editor's two halves share: the startup bundle (tab types,
 * titles, the composer bridge, search) and the editor chunk (CodeMirror),
 * which loads on the first code tab. Only plain data crosses: addresses, the
 * files RPC, which buffers have unsaved changes, and each session's composer.
 */

import { FILES_METHOD, type FilesReply, type FilesRequest } from '../../files/types.ts'
import { rpcReply, type Rpc } from '../rpc.ts'

export type FilesCall = <T>(request: FilesRequest, signal?: AbortSignal) => Promise<FilesReply<T>>

export type { Rpc }

export function filesCall(rpc: () => Rpc): FilesCall {
  return <T>(request: FilesRequest, signal?: AbortSignal) =>
    rpcReply<FilesReply<T>>(rpc(), FILES_METHOD, request, 'file request failed', (message) => ({ ok: false, error: { code: 'failed', message } }), signal)
}

const SCHEME = 'dsh-resource://file/session/'

/** `dsh-resource://file/session/<id>/<path>` → its session and path (relative to the session folder, or absolute). */
export function parseAddress(address: string): { sessionId: string; path: string } | undefined {
  if (!address.startsWith(SCHEME)) return undefined
  const rest = address.slice(SCHEME.length).replace(/[?#].*$/, '')
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const decode = (segment: string): string => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  }
  const path = rest.slice(slash + 1).split('/').map(decode).join('/')
  return path === '' ? undefined : { sessionId: decode(rest.slice(0, slash)), path }
}

/** The address DSH's file links and Files tree open: workspace-relative inside `cwd`, absolute outside. */
export function fileAddress(sessionId: string, cwd: string | undefined, path: string): string {
  const encode = (segment: string): string => encodeURIComponent(segment).replace(/%3A/gi, ':')
  const normalized = path.replace(/\\/g, '/')
  const root = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized
  return `${SCHEME}${encode(sessionId)}/${rel.split('/').map(encode).join('/')}`
}

export function baseName(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1) || clean
}

/** Documents DSH previews by default (rendered Markdown, HTML); the editor opens them on request. */
export const PREVIEW_FIRST = new Set(['md', 'markdown', 'mdx', 'html', 'htm', 'svg'])

/** Text files the editor opens by default (everything else keeps DSH's own previews). */
const TEXT_EXTENSIONS = new Set(`
ts mts cts tsx js mjs cjs jsx py pyi pyw css scss sass less vue svelte astro json jsonc json5 webmanifest
rs go java c h cc cpp cxx hpp hh hxx ino php sql xml xsd xsl plist csproj vbproj props targets xaml resx yaml yml
sh bash zsh fish ksh toml ps1 psm1 psd1 lua rb rake gemspec swift kt kts cs csx scala sc dart m mm diff patch
properties ini cfg conf env editorconfig gitconfig npmrc proto cmake groovy gradle r pl pm txt text log lock
gitignore gitattributes dockerignore prettierignore prettierrc eslintrc babelrc nvmrc bat cmd vb fs fsx ex exs erl
hs elm clj cljs edn tf hcl nix zig v sv vhd graphql gql hbs handlebars ejs pug tex bib rst adoc org
`.trim().split(/\s+/))

const TEXT_NAMES = new Set(['dockerfile', 'containerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'license', 'readme', 'codeowners', 'jenkinsfile', 'vagrantfile', 'brewfile'])

/**
 * The files a code tab opens by default, as the sidebar's address globs (case-insensitive, any
 * depth). Everything else — Markdown, HTML, images, PDFs, spreadsheets — keeps DSH's previews,
 * from which the 编辑 button still opens it here.
 */
export const CODE_PATTERNS: readonly string[] = [
  ...[...TEXT_EXTENSIONS].map((ext) => `*.${ext}`),
  ...TEXT_NAMES,
  'dockerfile.*', '.env.*',
]

/** Whether a code tab opens this path by default (what CODE_PATTERNS match). */
export function opensAsCode(path: string): boolean {
  const name = baseName(path).toLowerCase()
  if (TEXT_NAMES.has(name) || name.startsWith('dockerfile.') || name.startsWith('.env.')) return true
  const ext = extensionOf(name) || (name.startsWith('.') ? name.slice(1) : '')
  return TEXT_EXTENSIONS.has(ext)
}

/** Files the editor can open on request (the preview's 编辑 button): text, not binary containers. */
export function editable(path: string): boolean {
  return opensAsCode(path) || PREVIEW_FIRST.has(extensionOf(path)) || ['csv', 'tsv', 'svg'].includes(extensionOf(path))
}

export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** A small observable set, shared by the tab titles (the unsaved dot) and the close guard. */
class Flags {
  private readonly set = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  has = (key: string): boolean => this.set.has(key)
  toggle(key: string, on: boolean): void {
    if (this.set.has(key) === on) return
    if (on) this.set.add(key)
    else this.set.delete(key)
    this.version++
    for (const listener of this.listeners) listener()
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  snapshot = (): number => this.version
}

/** The composer's insertion face (ui-conversation's `inputActions`). */
export interface InputActions {
  captureInsertion(): unknown
  insertText(text: string, span: unknown): boolean
}

/** A tab's question before it may close with unsaved changes. */
export interface CloseRequest {
  tabId: string
  sessionId: string
}

export const editorShared = {
  /** Tab ids (sidebar occurrences) whose buffer has unsaved changes. */
  dirtyTabs: new Flags(),
  /** Tabs the person agreed to close without saving. */
  discard: new Set<string>(),
  /** Each mounted session's composer, registered from the input dock. */
  composers: new Map<string, InputActions>(),
  /** Close attempts on a dirty tab, answered by its editor's bar. */
  closeRequests: new Set<(request: CloseRequest) => void>(),
  /** The focused editor's selection, for the workspace search shortcut. */
  selection: undefined as (() => string) | undefined,
  /**
   * A new terminal of the git pane, started in `dir` (absolute) and shown; resolves false when it
   * started in the Session folder instead. Undefined without DSH's terminals. Set by the git module.
   */
  openTerminal: undefined as ((sessionId: string, dir: string) => Promise<boolean> | undefined) | undefined,
}

/** Insert into this session only; never submit, replace another session's draft, or create one. */
export function insertIntoSession(sessionId: string, text: string): boolean {
  const composer = editorShared.composers.get(sessionId)
  return composer !== undefined && composer.insertText(text, composer.captureInsertion())
}

/** The keyboard's context-menu request: the Menu key, or Shift+F10. */
export function isMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
}

/** Fence arbitrary selected text without allowing embedded backticks to close the block. */
export function textBlock(text: string, language = 'text'): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`
}

/** The clipboard, with the old copy command where the async API is missing (plain-http remote pages). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fall back below.
  }
  const selection = window.getSelection()
  const ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
  const focused = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(area)
  area.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy refused')
  } finally {
    area.remove()
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    if (selection !== null && ranges.every((range) => range.startContainer.isConnected && range.endContainer.isConnected)) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
