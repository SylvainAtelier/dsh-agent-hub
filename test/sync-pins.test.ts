import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSync, type PluginManager, type SyncOptions, type SyncSettings } from '../src/sync/index.ts'
import { serializeCollection, type CollectionStore } from '../src/sync/collection.ts'
import { compareSettings as compareAll } from '../src/sync/compare.ts'
import { mergeSettings as mergeAll } from '../src/sync/merge.ts'
import { LOCAL_SETTINGS, PINS, PINS_FILE, PINS_SETTING } from '../src/sync/portable.ts'
import type { SyncStatus } from '../src/sync/types.ts'

type Pin = { text: string; at: number }

const pinned = (...items: Array<[string, number]>): string => serializeCollection(PINS, items.map(([text, at]) => ({ text, at })))
const mergeSettings = (...[base, local, remote, choices]: Parameters<typeof mergeAll>): ReturnType<typeof mergeAll> => mergeAll(base, local, remote, choices, [PINS])
const compareSettings = (local: Parameters<typeof compareAll>[0], remote: Parameters<typeof compareAll>[1]): ReturnType<typeof compareAll> => compareAll(local, remote, [PINS])
const texts = (file: string | undefined): string[] => (JSON.parse(file ?? '{"pins":[]}') as { pins: Array<{ text: string }> }).pins.map((pin) => pin.text)

test('sync pins merge: a text pinned on both machines is one pin with the earlier time; pins never conflict', () => {
  const local = { [PINS_FILE]: pinned(['x', 5], ['mine', 7]) }
  const remote = { [PINS_FILE]: pinned(['x', 3], ['theirs', 9]) }
  // Without a base nothing can be told removed: both sides' pins are kept.
  const result = mergeSettings(undefined, local, remote)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(JSON.parse(result.files![PINS_FILE]!).pins.map((pin: { text: string; at: number }) => [pin.text, pin.at]), [['x', 3], ['mine', 7], ['theirs', 9]])
})

test('sync pins merge: unpinning on one side is taken by the other; pinning on the other side survives', () => {
  const base = { [PINS_FILE]: pinned(['a', 1], ['b', 2], ['c', 3]) }
  const local = { [PINS_FILE]: pinned(['b', 2], ['c', 3], ['new-local', 8]) }
  const remote = { [PINS_FILE]: pinned(['a', 1], ['b', 2], ['new-remote', 9]) }
  const result = mergeSettings(base, local, remote)
  assert.deepEqual(result.conflicts, [])
  // a: removed here, untouched there. c: removed there, untouched here.
  assert.deepEqual(texts(result.files![PINS_FILE]), ['b', 'new-local', 'new-remote'])
})

test('sync pins merge: a side that does not know its pins leaves them as the other has them', () => {
  const remote = { [PINS_FILE]: pinned(['a', 1]) }
  assert.deepEqual(texts(mergeSettings(undefined, {}, remote).files![PINS_FILE]), ['a'])
  assert.equal(mergeSettings(undefined, {}, {}).files![PINS_FILE], undefined)
})

test('sync pins: the stored file is the same for the same set, and the page lists what differs', () => {
  assert.equal(pinned(['b', 2], ['a', 1], ['b', 5]), pinned(['a', 1], ['b', 2]))
  assert.deepEqual(compareSettings({ [PINS_FILE]: pinned(['a', 1], ['x\nsecond line', 2]) }, { [PINS_FILE]: pinned(['a', 1], ['y', 3]) }), [
    { kind: 'collection', id: PINS_FILE, changes: [{ path: ['y'], remote: 'on' }, { path: ['x'], local: 'on' }] },
  ])
  // A side that does not tell its pins differs from nothing.
  assert.deepEqual(compareSettings({}, { [PINS_FILE]: pinned(['a', 1]) }), [])
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** The clipboard helper as sync sees it: the pinned texts it holds, or none known while it does not run. */
function pinStore(items?: Pin[]): CollectionStore & { items: Pin[] | undefined } {
  const store = {
    items,
    async get() { return store.items?.map((item) => ({ ...item })) },
    async set(next: Array<{ text?: unknown; at: number }>) {
      // The helper stores a text once, whatever the list says.
      store.items = [...new Map(next.map((item) => [item.text as string, { text: item.text as string, at: item.at }])).values()]
      return true
    },
  }
  return store
}

interface Machine {
  sync: ConfigSync
  patch: string
  settings: SyncSettings
}

async function machine(root: string, name: string, remote: string, pins: CollectionStore): Promise<Machine> {
  const home = join(root, name, 'home')
  const profile = join(home, '.dsh', 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  const patch = join(profile, 'cordis.patch.yml')
  const manifest = join(profile, 'package.json')
  await writeFile(manifest, `${JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`)
  const settings: SyncSettings = { remote, branch: 'main', fetchOnStart: true }
  const plugins: PluginManager = {
    async listBundles() {
      const data = JSON.parse(await readFile(manifest, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      return [{ name: '@deepseek-ai/dsh-base', installed: true, enabled: data.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), readOnlyReason: 'management-required' }]
    },
    async installBundle() {
      return { application: 'applied' }
    },
  }
  const options: SyncOptions = {
    dir: join(root, name, 'sync'),
    profile: () => ({ dir: profile, patchPath: patch }),
    settings: () => settings,
    plugins: () => plugins,
    hotReload: () => true,
    machine: { home, platform: process.platform, name },
    collections: [{ collection: PINS, store: pins }],
  }
  return { sync: new ConfigSync(options), patch, settings }
}

const status = async (m: Machine): Promise<SyncStatus> => await m.sync.handle({ op: 'status' }) as SyncStatus

async function sync(m: Machine): Promise<SyncStatus> {
  await m.sync.handle({ op: 'sync' })
  await m.sync.idle()
  return status(m)
}

test('sync pins: pinned clipboard texts travel between machines, unpinning too, and a text is never pinned twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const storeA = pinStore([{ text: 'shared', at: 2 }, { text: 'only-a', at: 1 }])
    const storeB = pinStore([{ text: 'shared', at: 5 }, { text: 'only-b', at: 6 }])
    const a = await machine(root, 'a', remote, storeA)
    const b = await machine(root, 'b', remote, storeB)
    const stored = (): string[] => texts(git(remote, 'show', 'main:pins.json')).sort()
    const held = (store: { items: Pin[] | undefined }): string[] => (store.items ?? []).map((item) => item.text).sort()

    let s = await sync(a)
    assert.equal(s.error, undefined)
    assert.deepEqual(stored(), ['only-a', 'shared'])

    // B pinned the same text and another: B ends with the three, "shared" once, at the earlier time.
    s = await sync(b)
    assert.equal(s.error, undefined)
    assert.equal(s.conflicts, undefined)
    assert.deepEqual(held(storeB), ['only-a', 'only-b', 'shared'])
    assert.equal(storeB.items!.find((item) => item.text === 'shared')!.at, 2)
    assert.deepEqual(stored(), ['only-a', 'only-b', 'shared'])
    assert.ok(s.last?.applied.some((group) => group.kind === 'collection' && group.id === PINS_FILE))

    await sync(a)
    assert.deepEqual(held(storeA), ['only-a', 'only-b', 'shared'])

    // A unpins one: B loses it at its next sync, and keeps what it pinned meanwhile.
    storeA.items = storeA.items!.filter((item) => item.text !== 'only-a')
    storeB.items!.push({ text: 'late-b', at: 9 })
    await sync(a)
    s = await sync(b)
    assert.equal(s.error, undefined)
    assert.deepEqual(held(storeB), ['late-b', 'only-b', 'shared'])
    assert.deepEqual(stored(), ['late-b', 'only-b', 'shared'])
    s = await status(b)
    assert.deepEqual([s.incoming, s.outgoing], [0, 0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync pins: a machine whose clipboard window is off keeps the remote pins, and does not remove them when it turns on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const a = await machine(root, 'a', remote, pinStore([{ text: 'keep-me', at: 1 }]))
    const off = pinStore(undefined)
    const c = await machine(root, 'c', remote, off)
    await writeFile(c.patch, '- id: ui-theme\n  config:\n    preference: dark\n')
    await sync(a)
    // The helper does not run: the pins stay as the remote has them, nothing is applied, nothing fails.
    let s = await sync(c)
    assert.equal(s.error, undefined)
    assert.deepEqual(texts(git(remote, 'show', 'main:pins.json')), ['keep-me'])
    assert.equal(off.items, undefined)
    // Turned on with an empty history: the remote's pins arrive; the empty list is not a removal.
    off.items = []
    s = await sync(c)
    assert.equal(s.error, undefined)
    assert.deepEqual(off.items.map((item) => item.text), ['keep-me'])
    assert.deepEqual(texts(git(remote, 'show', 'main:pins.json')), ['keep-me'])
    // Listed as kept on this machine: pins neither travel nor are touched.
    c.settings.localSettings = [...LOCAL_SETTINGS, PINS_SETTING]
    off.items = [{ text: 'private', at: 4 }]
    s = await sync(c)
    assert.equal(s.error, undefined)
    assert.deepEqual(texts(git(remote, 'show', 'main:pins.json')), ['keep-me'])
    assert.deepEqual(off.items.map((item) => item.text), ['private'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
