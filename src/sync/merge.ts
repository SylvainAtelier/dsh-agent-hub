/**
 * Three-way merge of the shared settings: the version this machine and the
 * remote last agreed on (the base), this machine's settings, and the remote's,
 * all in the shared form (portable.ts). Every setting is merged on its own:
 * changed on one side only, that side's value wins; changed on both sides to
 * the same value, nothing to decide; changed on both sides to different values,
 * a conflict, which only the person resolves (`choices`). So a sync that meets
 * no conflict needs no decision at all.
 *
 * The granularity is the comparison's (compare.ts): each leaf under a profile
 * entry, each plugin's on/off, the plugins' order, and each plugin's spec.
 * Lists are one value, except lists of objects that each carry a distinct
 * `id` (bots, connectors): their items merge one by one, so two machines
 * adding a bot each keep both.
 *
 * The result is written into the remote's YAML document (or this machine's
 * when the remote has none), so comments and `!!js` expressions survive; a
 * value taken from this machine is copied as its YAML node.
 */

import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node as YamlNode, YAMLMap, YAMLSeq } from 'yaml'
import { contentOf, parseCollection, serializeCollection, type Collection, type CollectionRecord } from './collection.ts'
import { ATTRIBUTES, ATTRIBUTES_FILE, PATCH_FILE, PLUGINS_FILE, canonicalSpec, parsePlugins, serializePlugins, type PluginsDoc } from './portable.ts'
import type { SyncConflict } from './types.ts'

export type Files = Readonly<Record<string, string | undefined>>
export type Choice = 'local' | 'remote'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
/** A key inside a map, or the item of an id-keyed list holding this id. */
type Seg = string | { id: string }
interface Leaf { path: Seg[]; value: string }
type Leaves = Map<string, Leaf>

const JS_TAG = 'tag:yaml.org,2002:js'
const isRecord = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value)
const lf = (text: string): string => text.replace(/\r\n?/g, '\n')
const keyOf = (path: readonly Seg[]): string => JSON.stringify(path)

/** A leaf as compared; strings as they are, unless that would hide them (compare.ts shows them the same way). */
function display(value: Json): string {
  if (typeof value === 'string') return value === '' || value.trim() !== value ? JSON.stringify(value) : value
  return JSON.stringify(value)
}

/** A list whose items are objects with distinct string ids: merged item by item. */
function keyed(value: Json[]): boolean {
  if (value.length === 0) return false
  const ids = value.map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id : undefined))
  return ids.every((id) => id !== undefined) && new Set(ids).size === ids.length
}

function flatten(value: Json, path: Seg[], out: Leaves): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) flatten(child, [...path, key], out)
    return
  }
  if (Array.isArray(value) && keyed(value)) {
    for (const item of value as Array<Record<string, Json>>) flatten(item, [...path, { id: item.id as string }], out)
    return
  }
  out.set(keyOf(path), { path, value: display(value) })
}

/** A YAML node as data, `!!js` expressions marked so they never equal a plain string. */
function plain(node: unknown, doc: Document): Json {
  if (isAlias(node)) return plain(node.resolve(doc), doc)
  if (isScalar(node)) {
    if (node.tag === JS_TAG) return `!!js ${String(node.value)}`
    return (node.value ?? null) as Json
  }
  if (isMap(node)) {
    const out: Record<string, Json> = {}
    for (const pair of node.items) out[String(isScalar(pair.key) ? pair.key.value : pair.key)] = plain(pair.value, doc)
    return out
  }
  if (isSeq(node)) return node.items.map((item) => plain(item, doc))
  return null
}

function leavesOf(node: unknown, doc: Document): Leaves {
  const out: Leaves = new Map()
  flatten(plain(node, doc), [], out)
  // An entry or item with nothing in it still exists.
  if (out.size === 0 && node !== undefined) out.set(keyOf([]), { path: [], value: '{}' })
  return out
}

// ── The profile patch ─────────────────────────────────────────────────────

interface Patch {
  doc: Document
  /** Entry id → its row. */
  rows: Map<string, YamlNode>
  order: string[]
}

function readPatch(text: string | undefined): Patch | undefined {
  if (text === undefined) return undefined
  const doc = parseDocument(lf(text), { customTags: [{ tag: JS_TAG, resolve: (value: string) => value }] })
  if (doc.errors.length > 0 || !isSeq(doc.contents)) return undefined
  const rows = new Map<string, YamlNode>()
  const order: string[] = []
  doc.contents.items.forEach((row, index) => {
    const value = isMap(row) ? row.get('id') as unknown : undefined
    const id = typeof value === 'string' ? value : `#${index + 1}`
    if (rows.has(id)) return
    rows.set(id, row as YamlNode)
    order.push(id)
  })
  return { doc, rows, order }
}

const rowLeaves = (patch: Patch | undefined, id: string): Leaves | undefined => {
  const row = patch?.rows.get(id)
  return row === undefined ? undefined : leavesOf(row, patch!.doc)
}

/** The node at `path` under `node`, an id segment naming the list item with that id. */
function nodeAt(node: unknown, path: readonly Seg[]): unknown {
  let at = node
  for (const seg of path) {
    if (typeof seg === 'string') at = isMap(at) ? at.get(seg, true) : undefined
    else at = isSeq(at) ? at.items.find((item) => isMap(item) && item.get('id') === seg.id) : undefined
    if (at === undefined) return undefined
  }
  return at
}

/** Put `value` at `path` under the row, making the maps and lists on the way. */
function setAt(doc: Document, row: YamlNode, path: readonly Seg[], value: unknown): void {
  let at: unknown = row
  path.forEach((seg, index) => {
    const last = index === path.length - 1
    const next = path[index + 1]
    const fresh = (): YamlNode => (typeof next === 'object' ? new YAMLSeq() : new YAMLMap()) as YamlNode
    if (typeof seg === 'string') {
      const map = at as YAMLMap
      if (last) return map.set(seg, value)
      let child = map.get(seg, true) as unknown
      if (typeof next === 'object' ? !isSeq(child) : !isMap(child)) {
        child = fresh()
        map.set(seg, child)
      }
      at = child
      return
    }
    const seq = at as YAMLSeq
    let item = seq.items.find((entry) => isMap(entry) && entry.get('id') === seg.id) as unknown
    if (item === undefined) {
      item = doc.createNode({ id: seg.id })
      seq.items.push(item)
    }
    if (last) {
      seq.items[seq.items.indexOf(item)] = value
      return
    }
    at = item
  })
}

function deleteAt(row: YamlNode, path: readonly Seg[]): void {
  if (path.length === 0) return
  const parent = nodeAt(row, path.slice(0, -1))
  const seg = path.at(-1)!
  if (typeof seg === 'string') {
    if (isMap(parent)) parent.delete(seg)
  } else if (isSeq(parent)) {
    parent.items = parent.items.filter((item) => !(isMap(item) && item.get('id') === seg.id))
  }
}

const copy = (node: unknown): unknown => (node !== null && typeof node === 'object' && 'clone' in node ? (node as { clone(): unknown }).clone() : node)

/**
 * Make `row` hold exactly `wanted`, taking each value it lacks from whichever side has it
 * (this machine's node first), and dropping the rest; a few passes settle emptied parents.
 */
function shape(doc: Document, row: YamlNode, wanted: Leaves, sources: Array<{ patch: Patch | undefined; id: string }>): void {
  for (let pass = 0; pass < 6; pass++) {
    const have = leavesOf(row, doc)
    let changed = false
    for (const [key, leaf] of wanted) {
      if (have.get(key)?.value === leaf.value) continue
      for (const { patch, id } of sources) {
        const from = patch?.rows.get(id)
        const node = from === undefined ? undefined : nodeAt(from, leaf.path)
        if (node === undefined || display(plain(node, patch!.doc)) !== leaf.value) continue
        setAt(doc, row, leaf.path, copy(node))
        changed = true
        break
      }
    }
    for (const [key, leaf] of leavesOf(row, doc)) {
      if (wanted.has(key) || [...wanted.values()].some((other) => under(other.path, leaf.path))) continue
      deleteAt(row, leaf.path)
      changed = true
    }
    if (!changed) return
  }
}

/** `path` lies strictly under `parent`. */
const under = (path: readonly Seg[], parent: readonly Seg[]): boolean =>
  path.length > parent.length && parent.every((seg, index) => keyOf([seg]) === keyOf([path[index]!]))

// ── Merging ───────────────────────────────────────────────────────────────

interface Decision {
  /** The leaves the merge keeps, or a conflict. */
  leaves: Leaves
  conflicts: SyncConflict[]
}

const conflictKey = (kind: SyncConflict['kind'], id: string, path: readonly Seg[]): string => `${kind}:${id}:${keyOf(path)}`
const label = (path: readonly Seg[]): string[] => path.map((seg) => (typeof seg === 'string' ? seg : `[${seg.id}]`))
const listable = (id: string, path: readonly Seg[]): string | undefined =>
  [id, ...path].every((seg) => typeof seg === 'string' && seg !== '' && !seg.includes('.')) ? [id, ...path].join('.') : undefined

/** One side's leaves, the other's, the base's: what the merge keeps, leaf by leaf. */
function decide(kind: SyncConflict['kind'], id: string, base: Leaves | undefined, local: Leaves | undefined, remote: Leaves | undefined, choices: Readonly<Record<string, Choice>>): Decision {
  const leaves: Leaves = new Map()
  const conflicts: SyncConflict[] = []
  const keys = new Set([...(remote?.keys() ?? []), ...(local?.keys() ?? []), ...(base?.keys() ?? [])])
  for (const key of keys) {
    const b = base?.get(key)
    const l = local?.get(key)
    const r = remote?.get(key)
    let take: Leaf | undefined
    if (l?.value === r?.value) take = l ?? r
    else if (l?.value === b?.value) take = r
    else if (r?.value === b?.value) take = l
    else {
      const path = (l ?? r ?? b)!.path
      const ckey = conflictKey(kind, id, path)
      const choice = choices[ckey]
      const setting = kind === 'entry' ? listable(id, path) : undefined
      conflicts.push({
        key: ckey, kind, id, path: label(path),
        ...(l === undefined ? {} : { local: l.value }), ...(r === undefined ? {} : { remote: r.value }),
        ...(setting === undefined ? {} : { setting }),
        ...(choice === undefined ? {} : { choice }),
      })
      take = choice === 'local' ? l : choice === 'remote' ? r : undefined
    }
    if (take !== undefined) leaves.set(key, take)
  }
  // A value kept under a list item or an entry keeps the item's id with it, else the item is lost.
  for (const leaf of [...leaves.values()]) {
    leaf.path.forEach((seg, index) => {
      if (typeof seg !== 'object') return
      const idKey = keyOf([...leaf.path.slice(0, index + 1), 'id'])
      if (!leaves.has(idKey)) leaves.set(idKey, { path: [...leaf.path.slice(0, index + 1), 'id'], value: display(seg.id) })
    })
  }
  if (kind === 'entry' && leaves.size > 0 && !leaves.has(keyOf(['id'])) && !id.startsWith('#')) leaves.set(keyOf(['id']), { path: ['id'], value: display(id) })
  // A value and things under it cannot both stand; what is under it is the newer shape.
  for (const [key, leaf] of leaves) {
    if ([...leaves.values()].some((other) => under(other.path, leaf.path))) leaves.delete(key)
  }
  return { leaves, conflicts }
}

const sameLeaves = (a: Leaves | undefined, b: Leaves | undefined): boolean =>
  a !== undefined && b !== undefined && a.size === b.size && [...a].every(([key, leaf]) => b.get(key)?.value === leaf.value)

function mergePatch(baseText: string | undefined, localText: string | undefined, remoteText: string | undefined, choices: Readonly<Record<string, Choice>>): { text: string | undefined; conflicts: SyncConflict[] } {
  const base = readPatch(baseText)
  const local = readPatch(localText)
  const remote = readPatch(remoteText)
  const carrier = remote ?? local
  if (carrier === undefined) return { text: localText ?? remoteText, conflicts: [] }
  const out = readPatch(String(carrier.doc))!
  const conflicts: SyncConflict[] = []
  const ids = [...new Set([...(remote?.order ?? []), ...(local?.order ?? []), ...(base?.order ?? [])])]
  const kept = new Map<string, Leaves>()
  for (const id of ids) {
    const decision = decide('entry', id, rowLeaves(base, id), rowLeaves(local, id), rowLeaves(remote, id), choices)
    conflicts.push(...decision.conflicts)
    if (decision.leaves.size > 0) kept.set(id, decision.leaves)
  }
  const seq = out.doc.contents as YAMLSeq
  for (const id of out.order) {
    if (kept.has(id)) continue
    const row = out.rows.get(id)
    seq.items = seq.items.filter((item) => item !== row)
    out.rows.delete(id)
  }
  for (const [id, leaves] of kept) {
    let row = out.rows.get(id)
    if (row === undefined) {
      // A new entry: this machine's row (else the remote's), placed after the entry it follows here.
      const from = local?.rows.get(id) ?? remote?.rows.get(id)
      row = (copy(from) as YamlNode | undefined) ?? (out.doc.createNode({ id }) as YamlNode)
      const order = local?.order ?? []
      const before = order.slice(0, Math.max(0, order.indexOf(id))).reverse().find((other) => out.rows.has(other))
      const at = before === undefined ? 0 : seq.items.indexOf(out.rows.get(before) as never) + 1
      seq.items.splice(at, 0, row)
      out.rows.set(id, row)
    }
    if (sameLeaves(leavesOf(row, out.doc), leaves)) continue
    const localRow = local?.rows.get(id)
    if (localRow !== undefined && sameLeaves(leavesOf(localRow, local!.doc), leaves)) {
      const replaced = copy(localRow) as YamlNode
      seq.items[seq.items.indexOf(row as never)] = replaced as never
      out.rows.set(id, replaced)
      continue
    }
    shape(out.doc, row, leaves, [{ patch: local, id }, { patch: remote, id }])
  }
  return { text: lf(String(out.doc)), conflicts }
}

// ── The plugin selection ──────────────────────────────────────────────────

const ORDER = 'order'
const pluginLeaves = (doc: PluginsDoc | undefined, common: ReadonlySet<string>): { bundles: Leaves; dependencies: Leaves } | undefined => {
  if (doc === undefined) return undefined
  const bundles: Leaves = new Map()
  for (const name of doc.bundles) bundles.set(keyOf([name]), { path: [name], value: 'on' })
  // Order among the plugins every side enables: a plugin added on one side never makes it a conflict.
  bundles.set(keyOf([]), { path: [], value: doc.bundles.filter((name) => common.has(name)).join(' → ') })
  const dependencies: Leaves = new Map()
  for (const [name, spec] of Object.entries(doc.dependencies)) dependencies.set(keyOf([name]), { path: [name], value: canonicalSpec(spec) })
  return { bundles, dependencies }
}

function mergePlugins(baseText: string | undefined, localText: string | undefined, remoteText: string | undefined, choices: Readonly<Record<string, Choice>>): { text: string | undefined; conflicts: SyncConflict[] } {
  const base = parsePlugins(baseText)
  const local = parsePlugins(localText)
  const remote = parsePlugins(remoteText)
  if (remote === undefined || local === undefined) return { text: remoteText ?? localText, conflicts: [] }
  const sides = [base, local, remote].filter((doc): doc is PluginsDoc => doc !== undefined)
  const common = new Set(sides[0]!.bundles.filter((name) => sides.every((doc) => doc.bundles.includes(name))))
  const [b, l, r] = [base, local, remote].map((doc) => pluginLeaves(doc, common))
  const bundles = decide('bundles', PLUGINS_FILE, b?.bundles, l?.bundles, r?.bundles, choices)
  const dependencies = decide('dependencies', PLUGINS_FILE, b?.dependencies, l?.dependencies, r?.dependencies, choices)
  // On and off per plugin; the order of whichever side's order was kept, the other side's additions after their neighbours.
  const enabled = new Set([...bundles.leaves.values()].filter((leaf) => leaf.path.length === 1).map((leaf) => leaf.path[0] as string))
  const orderLeaf = bundles.leaves.get(keyOf([]))?.value
  const localOrder = l?.bundles.get(keyOf([]))?.value
  const [first, second] = orderLeaf === localOrder && orderLeaf !== r?.bundles.get(keyOf([]))?.value ? [local, remote] : [remote, local]
  const list = first.bundles.filter((name) => enabled.has(name))
  for (const name of [...second.bundles, ...enabled]) {
    if (list.includes(name) || !enabled.has(name)) continue
    const before = second.bundles.slice(0, Math.max(0, second.bundles.indexOf(name))).reverse().find((other) => list.includes(other))
    list.splice(before === undefined ? 0 : list.indexOf(before) + 1, 0, name)
  }
  const deps: Record<string, string> = {}
  for (const leaf of [...dependencies.leaves.values()].sort((x, y) => String(x.path[0]).localeCompare(String(y.path[0])))) {
    const name = leaf.path[0] as string
    const from = [local, remote].find((doc) => doc.dependencies[name] !== undefined && canonicalSpec(doc.dependencies[name]) === leaf.value)
    deps[name] = from?.dependencies[name] ?? leaf.value
  }
  return { text: serializePlugins({ bundles: list, dependencies: deps }), conflicts: [...bundles.conflicts, ...dependencies.conflicts] }
}

// ── Collections ───────────────────────────────────────────────────────────

const recordLeaves = (records: readonly CollectionRecord[] | undefined): Leaves | undefined =>
  records === undefined ? undefined : new Map(records.map((item) => [keyOf([item.id]), { path: [item.id], value: contentOf(item) }]))

/**
 * A record is there or not, and its identity is its content: added on both sides is one record,
 * added or removed on one side only follows that side. Only a record both sides edited to
 * different contents conflicts. Its time is the earlier of the two (collection.ts).
 */
function mergeCollection(collection: Collection, baseText: string | undefined, localText: string | undefined, remoteText: string | undefined, choices: Readonly<Record<string, Choice>>): { text: string | undefined; conflicts: SyncConflict[] } {
  const local = parseCollection(collection, localText)
  const remote = parseCollection(collection, remoteText)
  // A side that does not know its records leaves them as the other has them.
  if (remote === undefined || local === undefined) return { text: remoteText ?? localText, conflicts: [] }
  const decision = decide('collection', collection.file, recordLeaves(parseCollection(collection, baseText)), recordLeaves(local), recordLeaves(remote), choices)
  const earliest = new Map<string, number>()
  for (const item of [...remote, ...local]) earliest.set(item.id, Math.min(earliest.get(item.id) ?? item.at, item.at))
  const kept = [...decision.leaves.values()].filter((leaf) => leaf.path.length === 1).map((leaf) => {
    const id = leaf.path[0] as string
    const item = [...local, ...remote].find((candidate) => candidate.id === id && contentOf(candidate) === leaf.value)!
    return { ...item, at: earliest.get(id)! }
  })
  return { text: serializeCollection(collection, kept), conflicts: decision.conflicts }
}

export interface MergeResult {
  /** Every setting both sides changed differently, each with the choice made, if any. */
  conflicts: SyncConflict[]
  /** The merged files; absent while a conflict has no choice. */
  files?: Record<string, string>
}

/**
 * Merge this machine's settings and the remote's over their base, in the shared form. Without
 * a remote version this machine's are the result; without a base every difference is a conflict.
 */
export function mergeSettings(base: Files | undefined, local: Files, remote: Files | undefined, choices: Readonly<Record<string, Choice>> = {}, collections: readonly Collection[] = []): MergeResult {
  const files = [PATCH_FILE, PLUGINS_FILE, ...collections.map((collection) => collection.file)]
  if (remote === undefined) return { conflicts: [], files: complete(local, files) }
  const patch = mergePatch(base?.[PATCH_FILE], local[PATCH_FILE], remote[PATCH_FILE], choices)
  const plugins = mergePlugins(base?.[PLUGINS_FILE], local[PLUGINS_FILE], remote[PLUGINS_FILE], choices)
  const merged = collections.map((collection) => mergeCollection(collection, base?.[collection.file], local[collection.file], remote[collection.file], choices))
  const conflicts = [...patch.conflicts, ...plugins.conflicts, ...merged.flatMap((item) => item.conflicts)]
  if (conflicts.some((conflict) => conflict.choice === undefined)) return { conflicts }
  const texts: Files = { [PATCH_FILE]: patch.text, [PLUGINS_FILE]: plugins.text, ...Object.fromEntries(collections.map((collection, index) => [collection.file, merged[index]!.text])) }
  return { conflicts, files: complete(texts, files) }
}

function complete(texts: Files, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = { [ATTRIBUTES_FILE]: ATTRIBUTES }
  for (const file of files) {
    const text = texts[file]
    if (text !== undefined) out[file] = text
  }
  return out
}
