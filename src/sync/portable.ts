/**
 * The shared form of a profile's settings, as the sync repository stores it,
 * and its way back onto one machine. Two files carry everything:
 *
 * - `cordis.patch.yml`: the profile patch itself (every plugin's config and
 *   every entry's `disabled`), comments and `!!js` expressions kept. A string
 *   naming a path under the home folder is written `~/…` with forward slashes,
 *   so `/Users/vi/pro/app` and `C:\Users\vi\pro\app` are the same value; text
 *   is LF. What only makes sense on one machine (the terminal's shell,
 *   `C:\Program Files\PowerShell\7\pwsh.exe`; this machine's light or dark)
 *   is left out, a whole entry or one setting in it: each machine keeps its own.
 * - `plugins.json`: the bundles the profile selects, in order (later bundles
 *   override earlier ones), and the package specs that install them. A spec
 *   that only means something on its own machine (`link:`, `file:`, a path)
 *   is not shared: the machine keeps it, and the shared file keeps whatever
 *   another machine installs that plugin from.
 *
 * - Collections (collection.ts), a JSON file each: the clipboard window's pinned
 *   texts (`pins.json`) and the reader's feeds and favorites, records keyed by
 *   their own content, so the same text pinned on two machines is one.
 *
 * Sign-ins, build-script approvals, version exemptions and the lockfile stay
 * per machine.
 */

import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { isMap, isSeq, parseDocument, visit, type Document } from 'yaml'
import { timeOf, type Collection, type CollectionRecord } from './collection.ts'

export const PATCH_FILE = 'cordis.patch.yml'
export const PLUGINS_FILE = 'plugins.json'
export const PINS_FILE = 'pins.json'
/** The setting that keeps this machine's pinned clipboard texts out of the sync. */
export const PINS_SETTING = 'agent-hub.config.palette.pins'
export const ATTRIBUTES_FILE = '.gitattributes'
/**
 * What belongs to one machine, never stored and never overwritten by a sync: a whole entry by its id,
 * or a setting inside one as entry id then path. By default, the terminal's shell (a program's path),
 * whether the board's reviews sync by themselves, whether a phone may change settings, the
 * Cardputer's port, and whether the clipboard window and the Cardputer are on.
 */
export const LOCAL_SETTINGS = ['terminal-controller', 'agent-hub.config.review.auto', 'agent-hub.config.remote.phoneSettings', 'agent-hub.config.device.port', 'agent-hub.config.automation', 'agent-hub.config.modules.palette', 'agent-hub.config.modules.device', 'agent-hub.config.palette.hotkey', 'agent-hub.config.palette.ignore', 'agent-hub.config.palette.langKey']
/** The key earlier versions marked an entry stored once per system with. */
const PLATFORM_KEY = 'platform'
/** Git writes the shared files with LF on every system. */
export const ATTRIBUTES = '* text eol=lf\n'

export interface PluginsDoc {
  bundles: string[]
  dependencies: Record<string, string>
}

export interface Pin extends CollectionRecord {
  text: string
}

/** The pinned text's identity in the repository: its content, nothing else. */
export const pinId = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** The clipboard window's pinned texts. */
export const PINS: Collection<Pin> = {
  file: PINS_FILE,
  key: 'pins',
  setting: PINS_SETTING,
  parse(raw) {
    const text = (raw as { text?: unknown } | null)?.text
    return typeof text === 'string' ? { id: pinId(text), text, at: timeOf((raw as { at?: unknown }).at) } : undefined
  },
  name: (pin) => pin.text,
}

/** The parts of a profile's package.json sync reads and writes. */
export interface Manifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
}

export interface Machine {
  home: string
  platform: NodeJS.Platform
}

const lf = (text: string): string => text.replace(/\r\n?/g, '\n')

/** A spec naming something on this machine only. */
export const localSpec = (spec: string): boolean =>
  /^(link|file|portal|workspace):/.test(spec) || posix.isAbsolute(spec) || win32.isAbsolute(spec) || /^\.\.?([\\/]|$)/.test(spec)

/**
 * A registry spec as the sync repository stores and compares it: a plain version written with
 * a prefix (`^2.6.8`, `~2.6.8`, `=2.6.8`, `v2.6.8`) is that version, since the prefix only says
 * how one machine happened to install it; any other spec (`>=2`, `latest`, git, tarball) as it is.
 */
export function canonicalSpec(spec: string): string {
  const version = spec.trim().replace(/^[=^~]\s*/, '').replace(/^v/, '')
  return /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(version) ? version : spec
}

function homePrefix(value: string, machine: Machine): string | undefined {
  const windows = machine.platform === 'win32'
  const home = machine.home.replace(/[\\/]+$/, '')
  if (home === '') return undefined
  // Windows paths compare case-insensitively, either separator.
  const fold = (text: string): string => (windows ? text.toLowerCase().replace(/\\/g, '/') : text)
  const key = fold(home)
  const candidate = fold(value)
  if (candidate === key) return ''
  return candidate.startsWith(`${key}/`) ? value.slice(home.length + 1) : undefined
}

/** A path under the home folder as `~/…`; any other value unchanged. */
export function portableValue(value: string, machine: Machine): string {
  if (value.includes('\n')) return value
  const rest = homePrefix(value, machine)
  if (rest === undefined) return value
  return rest === '' ? '~' : `~/${rest.replace(/\\/g, '/').replace(/\/+$/, '')}`
}

/** `~` and `~/…` as this machine's home folder; any other value unchanged. */
export function localValue(value: string, machine: Machine): string {
  if (value !== '~' && !value.startsWith('~/')) return value
  const path = machine.platform === 'win32' ? win32 : posix
  const parts = value.slice(2).split('/').filter(Boolean)
  return parts.length === 0 ? machine.home : path.join(machine.home, ...parts)
}

function parsePatch(text: string, map: (value: string) => string): Document {
  const document = parseDocument(lf(text), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors[0] !== undefined) throw new Error(`${PATCH_FILE}: ${document.errors[0].message}`)
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && node.tag === undefined) node.value = map(node.value)
    },
  })
  return document
}

type Row = { get(key: string): unknown; has(key: string): boolean; delete(key: string): boolean; items: unknown[]; clone(): Row }

/** The patch's entries, when it is the list a profile patch is. */
function rows(document: Document): Row[] | undefined {
  return isSeq(document.contents) ? document.contents.items as Row[] : undefined
}

/** Written by earlier versions for an entry stored once per system; such copies are no longer read. */
const platformOf = (row: Row): unknown => (isMap(row) ? row.get(PLATFORM_KEY) : undefined)
const idOf = (row: Row): unknown => (isMap(row) ? row.get('id') : undefined)

/**
 * `terminal-controller` (a whole entry) and `ui-theme.config.preference` (a setting inside one) as
 * the entry id and the path inside it, the whole entry's path empty; blank parts name nothing.
 */
function settingPaths(local: readonly string[]): Array<{ id: string; path: readonly string[] }> {
  return local.map((setting) => setting.trim().split('.'))
    .filter((parts) => parts.every((part) => part !== ''))
    .map(([id, ...path]) => ({ id: id!, path }))
}

type Node = { deleteIn(path: readonly string[]): boolean; getIn(path: readonly string[]): unknown; hasIn(path: readonly string[]): boolean; setIn(path: readonly string[], value: unknown): void }

/** Drop the machine-bound entries and settings, and old per-system copies (the stored form); an emptied parent map goes too. */
function stripLocal(list: Row[], local: readonly string[]): void {
  const paths = settingPaths(local)
  const whole = new Set(paths.filter(({ path }) => path.length === 0).map(({ id }) => id))
  list.splice(0, list.length, ...list.filter((row) => platformOf(row) === undefined && !whole.has(idOf(row) as string)))
  for (const { id, path } of paths) {
    if (path.length === 0) continue
    for (const row of list) {
      if (!isMap(row) || idOf(row) !== id) continue
      const node = row as unknown as Node
      if (!node.hasIn(path) || !node.deleteIn(path)) continue
      for (let depth = path.length - 1; depth > 1; depth--) {
        const parent = node.getIn(path.slice(0, depth)) as { items?: unknown[] } | undefined
        if (parent?.items?.length !== 0) break
        node.deleteIn(path.slice(0, depth))
      }
    }
  }
}

/**
 * A stored patch without the machine-bound entries and settings in `local`, which a file written
 * before they were listed may still carry; the text as it is when it is not a patch.
 */
export function sharedPatch(text: string, local: readonly string[] = LOCAL_SETTINGS): string {
  try {
    const document = parsePatch(text, (value) => value)
    const list = rows(document)
    if (list === undefined) return text
    stripLocal(list, local)
    return lf(String(document))
  } catch {
    return text
  }
}

/** This machine's profile patch as the sync repository stores it: the entries and settings in `local` left out. */
export function portablePatch(text: string, machine: Machine, local: readonly string[] = LOCAL_SETTINGS): string {
  const document = parsePatch(text.trim() === '' ? '[]\n' : text, (value) => portableValue(value, machine))
  const list = rows(document)
  if (list !== undefined) stripLocal(list, local)
  return lf(String(document))
}

/**
 * The stored patch as this machine's profile patch. The stored file never carries the entries
 * and settings in `local`: `current` (this machine's patch) lends its own back, each whole entry
 * after the entry it follows here.
 */
export function localPatch(text: string, machine: Machine, current?: string, local: readonly string[] = LOCAL_SETTINGS): string {
  const document = parsePatch(text, (value) => localValue(value, machine))
  const list = rows(document)
  if (list === undefined) return lf(String(document))
  stripLocal(list, local)
  const own = current === undefined ? [] : (rows(parsePatch(current, (value) => value)) ?? [])
  const paths = settingPaths(local)
  const whole = new Set(paths.filter(({ path }) => path.length === 0).map(({ id }) => id))
  own.forEach((row, index) => {
    if (!whole.has(idOf(row) as string)) return
    const before = own.slice(0, index).map(idOf).reverse().find((id) => list.some((entry) => idOf(entry) === id))
    const at = before === undefined ? 0 : list.findLastIndex((entry) => idOf(entry) === before) + 1
    list.splice(at, 0, row.clone())
  })
  for (const { id, path } of paths) {
    if (path.length === 0 || whole.has(id)) continue
    const mine = own.find((row) => isMap(row) && idOf(row) === id) as unknown as Node | undefined
    const row = list.find((entry) => isMap(entry) && idOf(entry) === id) as unknown as Node | undefined
    if (mine?.hasIn(path) && row !== undefined) row.setIn(path, mine.getIn(path))
  }
  return lf(String(document))
}

/**
 * This machine's plugin selection as the sync repository stores it. A local-only spec
 * keeps the spec the stored file already has for that package, if any; every other spec is
 * stored canonical (`^2.6.8` as `2.6.8`).
 */
export function portablePlugins(manifest: Manifest, stored?: PluginsDoc): PluginsDoc {
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const shared = localSpec(spec) ? stored?.dependencies[name] : canonicalSpec(spec)
    if (shared !== undefined) dependencies[name] = shared
  }
  return { bundles: [...(manifest.dsh?.profile?.bundles ?? [])], dependencies }
}

export function serializePlugins(doc: PluginsDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export function parsePlugins(text: string | undefined): PluginsDoc | undefined {
  if (text === undefined) return undefined
  try {
    const data = JSON.parse(text) as Partial<PluginsDoc>
    const bundles = Array.isArray(data.bundles) ? data.bundles.filter((name): name is string => typeof name === 'string') : []
    const dependencies = Object.fromEntries(Object.entries(data.dependencies ?? {}).filter(([, spec]) => typeof spec === 'string'))
    return { bundles, dependencies }
  } catch {
    return undefined
  }
}

/** What this machine has, as the plugin manager reports it. */
export interface LocalPlugins {
  bundles: readonly string[]
  dependencies: Readonly<Record<string, string>>
  /** Bundles that load here: installed in the profile or shipped with DSH. */
  available: readonly string[]
  /** Bundles the plugin manager itself needs: never turned off. */
  required: readonly string[]
}

export interface PluginPlan {
  /** The profile's next `dsh.profile.bundles`. */
  bundles: string[]
  enable: string[]
  disable: string[]
  /** Wanted by the shared file, not installed here; installed on request. */
  install: Array<{ name: string; spec: string }>
  /** Wanted, not installed here, and with no spec another machine can install it from. */
  missing: string[]
  /** Installed here under another registry spec than the shared file's (compared canonical); upgraded on request. */
  upgrade: Array<{ name: string; from: string; spec: string }>
  /** Installed here, gone from the shared file: only reported, never removed. */
  remove: string[]
}

/** Bring the selection here in line with the shared one: on and off, and order, follow it. */
export function planPlugins(doc: PluginsDoc, local: LocalPlugins): PluginPlan {
  const available = new Set(local.available)
  const wanted = doc.bundles.filter((name) => available.has(name))
  const kept = local.bundles.filter((name) => local.required.includes(name) && !wanted.includes(name))
  const bundles = [...new Set([...wanted, ...kept])]
  const install: PluginPlan['install'] = []
  const missing: string[] = []
  for (const name of new Set([...doc.bundles, ...Object.keys(doc.dependencies)])) {
    if (available.has(name) || Object.hasOwn(local.dependencies, name)) continue
    const spec = doc.dependencies[name]
    if (spec === undefined) missing.push(name)
    else install.push({ name, spec })
  }
  return {
    bundles,
    enable: bundles.filter((name) => !local.bundles.includes(name)),
    disable: local.bundles.filter((name) => !bundles.includes(name)),
    install,
    missing,
    upgrade: Object.entries(local.dependencies)
      .filter(([name, spec]) => !localSpec(spec) && doc.dependencies[name] !== undefined && !localSpec(doc.dependencies[name]) && canonicalSpec(doc.dependencies[name]) !== canonicalSpec(spec))
      .map(([name, from]) => ({ name, from, spec: doc.dependencies[name]! })),
    remove: Object.entries(local.dependencies)
      .filter(([name, spec]) => !localSpec(spec) && !Object.hasOwn(doc.dependencies, name) && !doc.bundles.includes(name))
      .map(([name]) => name),
  }
}
