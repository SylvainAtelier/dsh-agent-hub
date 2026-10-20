/**
 * What differs between this machine's settings and the remote's, setting by
 * setting, for the settings page to show before either side is chosen. Both
 * sides are compared in the shared form (portable.ts): home paths as `~/…`,
 * machine-bound entries and settings left out, so only what choosing a side
 * would really change is listed. The catalog is the other view of the same
 * files: every entry and setting either side has, for the page to pick the
 * machine-bound ones from.
 */

import { parseDocument } from 'yaml'
import { contentOf, parseCollection, type Collection } from './collection.ts'
import { parsePlugins, PATCH_FILE, PLUGINS_FILE, canonicalSpec } from './portable.ts'
import type { SyncCatalogEntry, SyncChange, SyncChangeGroup, SyncSetting } from './types.ts'

type Files = Readonly<Record<string, string | undefined>>
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A leaf value as the page shows it; strings as they are, unless that would hide them. */
function display(value: Json): string {
  if (typeof value === 'string') return value === '' || value.trim() !== value ? JSON.stringify(value) : value
  return JSON.stringify(value)
}

/** Every leaf under `value`, keyed by its path; lists are one leaf (their order is their meaning). */
function flatten(value: Json, path: string[], out: Map<string, { path: string[]; value: string }>): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flatten(child, [...path, key], out)
    return
  }
  out.set(JSON.stringify(path), { path, value: display(value) })
}

interface Entry {
  id: string
  leaves: Map<string, { path: string[]; value: string }>
}

/** The patch's entries as data; none when it is not a readable list. */
function patchRows(text: string | undefined): Json[] {
  if (text === undefined) return []
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => `!!js ${value}` }] })
  const list = document.errors.length === 0 ? document.toJS() as unknown : undefined
  return Array.isArray(list) ? list as Json[] : []
}

const idOf = (row: Json, index: number): string => (isRecord(row) && typeof row.id === 'string' ? row.id : `#${index + 1}`)

function entries(text: string | undefined): Entry[] {
  return patchRows(text).map((row, index): Entry => {
    const leaves = new Map<string, { path: string[]; value: string }>()
    if (isRecord(row)) {
      for (const [key, value] of Object.entries(row)) {
        if (key !== 'id') flatten(value, [key], leaves)
      }
    } else {
      flatten(row, [], leaves)
    }
    return { id: idOf(row, index), leaves }
  })
}

function compareEntries(local: Entry | undefined, remote: Entry | undefined): SyncChange[] {
  const keys = [...new Set([...(local?.leaves.keys() ?? []), ...(remote?.leaves.keys() ?? [])])]
  const changes: SyncChange[] = []
  for (const key of keys) {
    const here = local?.leaves.get(key)
    const there = remote?.leaves.get(key)
    if (here?.value === there?.value) continue
    changes.push({
      path: (here ?? there)!.path,
      ...(here === undefined ? {} : { local: here.value }),
      ...(there === undefined ? {} : { remote: there.value }),
    })
  }
  return changes
}

function patchGroups(localText: string | undefined, remoteText: string | undefined): SyncChangeGroup[] {
  const local = new Map(entries(localText).map((entry) => [entry.id, entry]))
  const remote = new Map(entries(remoteText).map((entry) => [entry.id, entry]))
  const groups: SyncChangeGroup[] = []
  // The remote's order first, then entries only this machine has: the order the shared file keeps.
  for (const key of new Set([...remote.keys(), ...local.keys()])) {
    const here = local.get(key)
    const there = remote.get(key)
    const changes = compareEntries(here, there)
    if (changes.length === 0) continue
    groups.push({
      kind: 'entry',
      id: key,
      ...(here === undefined ? { only: 'remote' as const } : there === undefined ? { only: 'local' as const } : {}),
      changes,
    })
  }
  return groups
}

function pluginGroups(localText: string | undefined, remoteText: string | undefined): SyncChangeGroup[] {
  const local = parsePlugins(localText) ?? { bundles: [], dependencies: {} }
  const remote = parsePlugins(remoteText) ?? { bundles: [], dependencies: {} }
  const groups: SyncChangeGroup[] = []
  const bundles: SyncChange[] = []
  for (const name of new Set([...remote.bundles, ...local.bundles])) {
    const here = local.bundles.includes(name)
    const there = remote.bundles.includes(name)
    if (here !== there) bundles.push({ path: [name], ...(here ? { local: 'on' } : {}), ...(there ? { remote: 'on' } : {}) })
  }
  // Same plugins, another order: later bundles override earlier ones, so order is a setting too.
  const shared = (list: readonly string[], other: readonly string[]): string[] => list.filter((name) => other.includes(name))
  const hereOrder = shared(local.bundles, remote.bundles)
  const thereOrder = shared(remote.bundles, local.bundles)
  if (hereOrder.join('\n') !== thereOrder.join('\n')) bundles.push({ path: [], local: hereOrder.join(' → '), remote: thereOrder.join(' → ') })
  if (bundles.length > 0) groups.push({ kind: 'bundles', id: PLUGINS_FILE, changes: bundles })
  const dependencies: SyncChange[] = []
  for (const name of new Set([...Object.keys(remote.dependencies), ...Object.keys(local.dependencies)])) {
    const here = local.dependencies[name]
    const there = remote.dependencies[name]
    if ((here === undefined ? undefined : canonicalSpec(here)) !== (there === undefined ? undefined : canonicalSpec(there))) dependencies.push({ path: [name], ...(here === undefined ? {} : { local: here }), ...(there === undefined ? {} : { remote: there }) })
  }
  if (dependencies.length > 0) groups.push({ kind: 'dependencies', id: PLUGINS_FILE, changes: dependencies })
  return groups
}

/** A record as the page names it: its first line, cut; told apart by its hash only when two read alike. */
const PREVIEW = 60

/**
 * Records one side has and the other lacks (`on` on the side that has it), and records both
 * have with different contents (their contents). A side that is not known (the clipboard window
 * is off there) has no opinion, so nothing differs.
 */
function collectionGroups(collection: Collection, localText: string | undefined, remoteText: string | undefined): SyncChangeGroup[] {
  const local = parseCollection(collection, localText)
  const remote = parseCollection(collection, remoteText)
  if (local === undefined || remote === undefined) return []
  const here = new Map(local.map((item) => [item.id, item]))
  const there = new Map(remote.map((item) => [item.id, item]))
  const differing = [...remote.filter((item) => here.get(item.id) === undefined), ...local.filter((item) => {
    const other = there.get(item.id)
    return other === undefined || contentOf(other) !== contentOf(item)
  })]
  const names = differing.map((item) => collection.name(item).trim().split(/\r?\n/)[0]!.trim().slice(0, PREVIEW))
  const changes: SyncChange[] = differing.map((item, index) => {
    const mine = here.get(item.id)
    const theirs = there.get(item.id)
    const both = mine !== undefined && theirs !== undefined
    return {
      path: [names.filter((name) => name === names[index]).length > 1 ? `${names[index]} #${item.id.slice(0, 6)}` : names[index]!],
      ...(mine === undefined ? {} : { local: both ? contentOf(mine) : 'on' }),
      ...(theirs === undefined ? {} : { remote: both ? contentOf(theirs) : 'on' }),
    }
  })
  return changes.length === 0 ? [] : [{ kind: 'collection', id: collection.file, changes }]
}

/** The settings that differ, grouped by profile entry, then the plugin selection, then each collection. */
export function compareSettings(local: Files, remote: Files, collections: readonly Collection[] = []): SyncChangeGroup[] {
  return [
    ...patchGroups(local[PATCH_FILE], remote[PATCH_FILE]),
    ...pluginGroups(local[PLUGINS_FILE], remote[PLUGINS_FILE]),
    ...collections.flatMap((collection) => collectionGroups(collection, local[collection.file], remote[collection.file])),
  ]
}

/** Settings are offered down to a key inside a key of `config`; deeper ones go with their parent. */
const CATALOG_DEPTH = 3
/** A value the catalog shows is cut to this many characters. */
const CATALOG_VALUE = 120

/**
 * The settings of one entry the page can pick: its own keys (`disabled`), then each key of `config`
 * and the keys inside those. A key holding a dot is not offered: the stored list splits on dots.
 */
function catalogSettings(value: Json, path: string[]): SyncSetting[] {
  if (!isRecord(value)) return []
  const settings: SyncSetting[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('.') || (path.length === 0 && (key === 'id' || key === 'name' || key === 'platform'))) continue
    if (path.length === 0 && key === 'config') {
      settings.push(...catalogSettings(child, ['config']))
      continue
    }
    const at = [...path, key]
    const inner = at.length < CATALOG_DEPTH ? catalogSettings(child, at) : []
    settings.push(inner.length > 0 ? { path: at, settings: inner } : { path: at, value: display(child).slice(0, CATALOG_VALUE) })
  }
  return settings
}

/** `extra`'s settings `into` lacks, added after its own, at every level. */
function mergeSettings(into: SyncSetting[], extra: readonly SyncSetting[]): void {
  for (const setting of extra) {
    const same = into.find((other) => other.path.join('.') === setting.path.join('.'))
    if (same === undefined) into.push(setting)
    else if (same.settings !== undefined && setting.settings !== undefined) mergeSettings(same.settings, setting.settings)
  }
}

/**
 * Every entry and setting this machine's patch or the remote's has, this machine's order first.
 * Both are read as they are, machine-bound ones included, so a listed one can be unlisted; the
 * copies earlier versions kept per system are not entries.
 */
export function catalog(localText: string | undefined, remoteText: string | undefined): SyncCatalogEntry[] {
  const found = new Map<string, SyncCatalogEntry>()
  const add = (text: string | undefined, side: 'local' | 'remote'): void => {
    patchRows(text).forEach((row, index) => {
      if (!isRecord(row) || row.platform !== undefined) return
      const id = idOf(row, index)
      if (id.includes('.')) return
      const settings = catalogSettings(row, [])
      const entry = found.get(id)
      if (entry !== undefined) return mergeSettings(entry.settings, settings)
      found.set(id, { id, ...(typeof row.name === 'string' ? { name: row.name } : {}), ...(side === 'remote' ? { only: 'remote' as const } : {}), settings })
    })
  }
  add(localText, 'local')
  add(remoteText, 'remote')
  return [...found.values()]
}
