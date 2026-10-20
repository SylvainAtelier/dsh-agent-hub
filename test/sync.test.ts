import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSync, machineBound, type PluginManager, type SyncOptions, type SyncSettings } from '../src/sync/index.ts'
import { PendingOps } from '../src/plugins/pending.ts'
import { catalog, compareSettings } from '../src/sync/compare.ts'
import { LOCAL_SETTINGS, localPatch, localValue, planPlugins, portablePatch, portablePlugins, portableValue, canonicalSpec, sharedPatch } from '../src/sync/portable.ts'
import type { SyncCatalog, SyncLog, SyncStatus } from '../src/sync/types.ts'

const mac = { home: '/Users/vi', platform: 'darwin' as const }
const windows = { home: 'C:\\Users\\vi', platform: 'win32' as const }

test('sync portable: home paths travel between macOS and Windows', () => {
  assert.equal(portableValue('/Users/vi/pro/app', mac), '~/pro/app')
  assert.equal(portableValue('C:\\Users\\VI\\pro\\app\\', windows), '~/pro/app')
  assert.equal(portableValue('/Users/vibe/app', mac), '/Users/vibe/app')
  assert.equal(portableValue('https://mcp.linear.app/mcp', mac), 'https://mcp.linear.app/mcp')
  assert.equal(localValue('~/pro/app', windows), 'C:\\Users\\vi\\pro\\app')
  assert.equal(localValue('~/pro/app', mac), '/Users/vi/pro/app')
  assert.equal(localValue('~', mac), '/Users/vi')
})

test('sync portable: the patch keeps comments and !!js, rewrites only whole home paths, and uses LF', () => {
  const text = '# mine\r\n- id: agent-hub\r\n  config:\r\n    connectors:\r\n      servers:\r\n        - id: linear\r\n          repos: [C:\\Users\\vi\\pro\\acme]\r\n    prompt:\r\n      instructions: "see C:\\\\Users\\\\vi\\\\notes"\r\n- id: x\r\n  config:\r\n    when: !!js process.platform\r\n'
  const shared = portablePatch(text, windows)
  assert.ok(!shared.includes('\r'))
  assert.match(shared, /# mine/)
  assert.match(shared, /~\/pro\/acme/)
  assert.match(shared, /!!js process\.platform/)
  assert.match(shared, /see C:\\\\Users/)
  const local = localPatch(shared, mac)
  assert.match(local, /\/Users\/vi\/pro\/acme/)
  assert.equal(portablePatch(local, mac), shared)
})

test('sync portable: plugin specs local to a machine are not shared, and the selection follows the shared one', () => {
  const doc = portablePlugins({
    dependencies: { 'dsh-context': '^0.67.0', 'dsh-agent-hub': 'link:/Users/vi/pro/dsh-agent-hub' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-agent-hub', 'dsh-context'] } },
  }, { bundles: [], dependencies: { 'dsh-agent-hub': '^0.1.0' } })
  assert.deepEqual(doc.dependencies, { 'dsh-agent-hub': '^0.1.0', 'dsh-context': '0.67.0' })

  const plan = planPlugins({ bundles: ['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-new', 'dsh-dev'], dependencies: { 'dsh-context': '^0.67.0', 'dsh-new': '^1.0.0' } }, {
    bundles: ['@deepseek-ai/dsh-base', 'dsh-old', 'dsh-manager'],
    dependencies: { 'dsh-context': '^0.60.0', 'dsh-old': '^2.0.0' },
    available: ['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-old', 'dsh-manager'],
    required: ['dsh-manager'],
  })
  assert.deepEqual(plan.bundles, ['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-manager'])
  assert.deepEqual(plan.enable, ['dsh-context'])
  assert.deepEqual(plan.disable, ['dsh-old'])
  assert.deepEqual(plan.install, [{ name: 'dsh-new', spec: '^1.0.0' }])
  assert.deepEqual(plan.upgrade, [{ name: 'dsh-context', from: '^0.60.0', spec: '^0.67.0' }])
  assert.deepEqual(plan.missing, ['dsh-dev'])
  assert.deepEqual(plan.remove, ['dsh-old'])
})

test('sync portable: the shared list keeps the version, not how a machine wrote it', () => {
  assert.equal(canonicalSpec('^2.6.8'), '2.6.8')
  assert.equal(canonicalSpec('~2.6.8'), '2.6.8')
  assert.equal(canonicalSpec('= v2.6.8-beta.1'), '2.6.8-beta.1')
  assert.equal(canonicalSpec('>=2.6.8'), '>=2.6.8')
  assert.equal(canonicalSpec('latest'), 'latest')

  const stored = { bundles: [], dependencies: { 'dsh-codex-subscription': '2.6.8' } }
  const local = { dependencies: { 'dsh-codex-subscription': '^2.6.8' } }
  assert.deepEqual(portablePlugins(local, stored).dependencies, { 'dsh-codex-subscription': '2.6.8' })
  assert.deepEqual(portablePlugins({ dependencies: { 'dsh-codex-subscription': '^2.6.9' } }, stored).dependencies, { 'dsh-codex-subscription': '2.6.9' })
  // A list written before specs were stored canonical still matches.
  for (const doc of [stored, { bundles: [], dependencies: { 'dsh-codex-subscription': '~2.6.8' } }]) {
    const plan = planPlugins(doc, { bundles: [], dependencies: local.dependencies, available: ['dsh-codex-subscription'], required: [] })
    assert.deepEqual(plan.upgrade, [])
    const plugins = (value: object): Record<string, string> => ({ 'plugins.json': JSON.stringify(value) })
    assert.deepEqual(compareSettings(plugins({ bundles: [], ...local }), plugins(doc)), [])
  }
})

const PWSH = '- id: ui-theme\n  config:\n    preference: dark\n# PowerShell 7 as the default shell\n- id: terminal-controller\n  config:\n    shell:\n      path: C:\\Program Files\\PowerShell\\7\\pwsh.exe\n'
const ZSH = '- id: agent-hub\n  disabled: false\n- id: terminal-controller\n  config:\n    shell:\n      path: /bin/zsh\n- id: ui-theme\n  config:\n    preference: dark\n'

test('sync portable: a machine-bound entry is never stored, compared or overwritten', () => {
  // terminal-controller is machine-bound by default: its shell is a path to a program.
  const stored = portablePatch(PWSH, windows)
  assert.doesNotMatch(stored, /terminal-controller|pwsh|PowerShell 7/)
  assert.match(stored, /preference: dark/)
  // The Mac keeps its own shell where it was, under the shared settings.
  const onMac = localPatch(stored.replace('dark', 'light'), mac, ZSH)
  assert.match(onMac, /\/bin\/zsh/)
  assert.match(onMac, /preference: light/)
  assert.doesNotMatch(onMac, /pwsh/)
  assert.ok(onMac.indexOf('id: terminal-controller') < onMac.indexOf('id: ui-theme'), 'kept in this machine\'s place')
  // A machine without one gets none.
  assert.doesNotMatch(localPatch(stored, mac, '[]\n'), /terminal-controller/)
  // Neither side's copy is compared.
  assert.deepEqual(compareSettings({ 'cordis.patch.yml': portablePatch(ZSH, mac) }, { 'cordis.patch.yml': sharedPatch(portablePatch(PWSH, windows, [])) }), [
    { kind: 'entry', id: 'agent-hub', only: 'local', changes: [{ path: ['disabled'], local: 'false' }] },
  ])
  // Listing a whole entry covers the settings listed inside it.
  assert.doesNotMatch(portablePatch(PWSH, windows, ['ui-theme', 'ui-theme.config.preference']), /ui-theme/)
})

test('sync portable: listed machine-only settings are never stored, compared or overwritten', () => {
  const local = [...LOCAL_SETTINGS, 'ui-theme.config.preference']
  const here = '- id: ui-theme\n  config:\n    preference: dark\n    fontSize: 14\n- id: agent-hub\n  config:\n    review:\n      auto: false\n      at: "08:00"\n'
  const shared = portablePatch(here, mac, local)
  assert.doesNotMatch(shared, /preference|auto/)
  assert.match(shared, /fontSize: 14/)
  assert.match(shared, /at: "08:00"/)
  // Only the default list: the theme travels, the review switch does not.
  assert.match(portablePatch(here, mac), /preference: dark/)
  assert.doesNotMatch(portablePatch(here, mac), /auto/)
  // A version written before the setting was listed still carries one: it neither shows nor lands.
  const older = '- id: ui-theme\n  config:\n    preference: light\n    fontSize: 16\n'
  assert.doesNotMatch(sharedPatch(older, local), /preference/)
  assert.deepEqual(compareSettings({ 'cordis.patch.yml': portablePatch(here, mac, local) }, { 'cordis.patch.yml': sharedPatch(older, local) })
    .flatMap((group) => group.changes.map((change) => change.path.join('.'))), ['config.fontSize', 'config.review.at'])
  const applied = localPatch(older, mac, here, local)
  assert.match(applied, /preference: dark/)
  assert.match(applied, /fontSize: 16/)
  assert.doesNotMatch(localPatch(older, mac, '[]\n', local), /preference/)
})

test('sync portable: the copies an earlier version stored per system are dropped', () => {
  const old = '- id: ui-theme\n  config:\n    preference: light\n- id: ui-theme\n  platform: win32\n  config:\n    preference: dark\n- id: terminal-controller\n  platform: win32\n  config:\n    shell: pwsh\n'
  const shared = sharedPatch(old, [])
  assert.equal((shared.match(/id: ui-theme/g) ?? []).length, 1)
  assert.doesNotMatch(shared, /platform:|pwsh/)
  const onWindows = localPatch(old, windows, '[]\n', [])
  assert.match(onWindows, /preference: light/)
  assert.doesNotMatch(onWindows, /platform:|dark|terminal-controller/)
  // The entries an earlier version scoped per system are machine-bound now.
  assert.deepEqual(machineBound({ branch: 'main', fetchOnStart: true, localSettings: ['ui-theme.config.preference'], platformEntries: ['terminal-controller', 'ui-theme'] }),
    ['ui-theme.config.preference', 'terminal-controller', 'ui-theme'])
  assert.deepEqual(machineBound({ branch: 'main', fetchOnStart: true }), LOCAL_SETTINGS)
})

test('sync catalog: every entry and setting either side has, to pick the machine-bound ones from', () => {
  const here = '- id: agent-hub\n  disabled: false\n  config:\n    review:\n      auto: true\n      repos: [a, b]\n    remote:\n      deep: { a: { b: 1 } }\n- id: web-ui-market\n  disabled: true\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: dark\n    "dotted.key": 1\n'
  const there = '- id: ui-theme\n  config:\n    accent: blue\n- id: ui-theme\n  platform: win32\n  config:\n    old: true\n- id: web-ui-dock\n  config:\n    position: left\n'
  assert.deepEqual(catalog(here, there), [
    { id: 'agent-hub', settings: [
      { path: ['disabled'], value: 'false' },
      { path: ['config', 'review'], settings: [{ path: ['config', 'review', 'auto'], value: 'true' }, { path: ['config', 'review', 'repos'], value: '["a","b"]' }] },
      { path: ['config', 'remote'], settings: [{ path: ['config', 'remote', 'deep'], value: '{"a":{"b":1}}' }] },
    ] },
    { id: 'web-ui-market', settings: [{ path: ['disabled'], value: 'true' }] },
    { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', settings: [{ path: ['config', 'preference'], value: 'dark' }, { path: ['config', 'accent'], value: 'blue' }] },
    { id: 'web-ui-dock', only: 'remote', settings: [{ path: ['config', 'position'], value: 'left' }] },
  ])
  assert.deepEqual(catalog(undefined, 'not: a list'), [])
})

test('sync compare: differences are listed setting by setting, entries and plugins apart', () => {
  const local = {
    'cordis.patch.yml': '- id: ui-theme\n  config:\n    preference: light\n    font: { size: 13 }\n- id: here-only\n  disabled: true\n- id: x\n  config:\n    when: !!js process.platform\n    list: [a, b]\n',
    'plugins.json': JSON.stringify({ bundles: ['base', 'b', 'a', 'mine'], dependencies: { a: '^1.0.0', mine: '^2.0.0' } }),
  }
  const remote = {
    'cordis.patch.yml': '- id: ui-theme\n  config:\n    preference: dark\n    font: { size: 13 }\n- id: x\n  config:\n    when: !!js process.platform\n    list: [b, a]\n- id: web-ui-dock\n  config:\n    shell: pwsh\n',
    'plugins.json': JSON.stringify({ bundles: ['base', 'a', 'b'], dependencies: { a: '^1.1.0' } }),
  }
  const groups = compareSettings(local, remote)
  assert.deepEqual(groups, [
    { kind: 'entry', id: 'ui-theme', changes: [{ path: ['config', 'preference'], local: 'light', remote: 'dark' }] },
    { kind: 'entry', id: 'x', changes: [{ path: ['config', 'list'], local: '["a","b"]', remote: '["b","a"]' }] },
    { kind: 'entry', id: 'web-ui-dock', only: 'remote', changes: [{ path: ['config', 'shell'], remote: 'pwsh' }] },
    { kind: 'entry', id: 'here-only', only: 'local', changes: [{ path: ['disabled'], local: 'true' }] },
    { kind: 'bundles', id: 'plugins.json', changes: [{ path: ['mine'], local: 'on' }, { path: [], local: 'base → b → a', remote: 'base → a → b' }] },
    { kind: 'dependencies', id: 'plugins.json', changes: [{ path: ['a'], local: '^1.0.0', remote: '^1.1.0' }, { path: ['mine'], local: '^2.0.0' }] },
  ])
  assert.deepEqual(compareSettings(local, local), [])
})


const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

interface Machine {
  sync: ConfigSync
  patch: string
  manifest: string
  settings: SyncSettings
}

async function machine(root: string, name: string, remote: string, bundles: string[], platform: NodeJS.Platform = process.platform, extra: Partial<SyncOptions> = {}): Promise<Machine> {
  const home = join(root, name, 'home')
  const profile = join(home, '.dsh', 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  const patch = join(profile, 'cordis.patch.yml')
  const manifest = join(profile, 'package.json')
  await writeFile(manifest, `${JSON.stringify({ name: 'p', dependencies: { 'dsh-context': '^0.67.0' }, dsh: { profile: { bundles } } }, null, 2)}\n`)
  const settings: SyncSettings = { remote, branch: 'main', fetchOnStart: true }
  const plugins: PluginManager = {
    async listBundles() {
      const data = JSON.parse(await readFile(manifest, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
      return ['@deepseek-ai/dsh-base', 'dsh-context'].map((item) => ({ name: item, installed: item === 'dsh-context', enabled: data.dsh.profile.bundles.includes(item), ...(item === '@deepseek-ai/dsh-base' ? { readOnlyReason: 'management-required' } : {}) }))
    },
    async installBundle() {
      return { application: 'applied' }
    },
  }
  const sync = new ConfigSync({
    dir: join(root, name, 'sync'),
    profile: () => ({ dir: profile, patchPath: patch }),
    settings: () => settings,
    plugins: () => plugins,
    hotReload: () => true,
    machine: { home, platform, name },
    ...extra,
  })
  return { sync, patch, manifest, settings }
}

const status = async (m: Machine): Promise<SyncStatus> => await m.sync.handle({ op: 'status' }) as SyncStatus

/** Run a sync to its end. */
async function sync(m: Machine, extra: { remote?: string | null; choices?: Record<string, 'local' | 'remote'>; message?: string } = {}): Promise<SyncStatus> {
  await m.sync.handle({ op: 'sync', ...extra })
  await m.sync.idle()
  return status(m)
}

const edit = async (file: string, from: string, to: string): Promise<void> => writeFile(file, (await readFile(file, 'utf8')).replace(from, to))

test('sync: settings changed on one machine flow to the other; only a setting both changed asks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const a = await machine(root, 'a', remote, ['@deepseek-ai/dsh-base', 'dsh-context'])
    const b = await machine(root, 'b', remote, ['@deepseek-ai/dsh-base'])
    const homeA = join(root, 'a', 'home')
    await writeFile(a.patch, `- id: agent-hub\n  config:\n    connectors:\n      servers:\n        - id: linear\n          url: https://mcp.linear.app/mcp\n          repos: [${join(homeA, 'pro', 'app')}]\n- id: ui-theme\n  config:\n    preference: dark\n`)

    // An empty remote: A's settings become the first version.
    let s = await sync(a)
    assert.equal(s.error, undefined)
    assert.equal(s.last?.kind, 'sync')
    assert.ok((s.last?.pushed ?? 0) > 0)
    assert.match(git(remote, 'show', 'main:cordis.patch.yml'), /repos:\n\s+- ~\/pro\/app|repos: \[ ~\/pro\/app \]/)

    // B never synced: the one setting both have differently asks; what B lacks is simply taken.
    await writeFile(b.patch, '- id: ui-theme\n  config:\n    preference: light\n')
    s = await sync(b)
    assert.equal(s.error, undefined)
    assert.deepEqual(s.conflicts?.items.map((item) => [item.id, item.path.join('.'), item.local, item.remote]), [['ui-theme', 'config.preference', 'light', 'dark']])
    assert.match(await readFile(b.patch, 'utf8'), /light/, 'nothing changes before the choice')
    const key = s.conflicts!.items[0]!.key
    s = await sync(b, { remote: s.conflicts!.remote, choices: { [key]: 'remote' } })
    assert.equal(s.error, undefined)
    assert.equal(s.conflicts, undefined)
    const patchB = await readFile(b.patch, 'utf8')
    assert.match(patchB, /dark/)
    assert.ok(patchB.includes(join(root, 'b', 'home', 'pro', 'app')), 'the repository path lands under the home of B')
    assert.deepEqual(JSON.parse(await readFile(b.manifest, 'utf8')).dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-context'])
    assert.ok(s.last?.applied.some((group) => group.id === 'agent-hub'))
    assert.match(git(join(root, 'b', 'sync'), 'log', '-p', '--all'), /light/, 'the settings B had stay in the history')
    assert.deepEqual([s.incoming, s.outgoing], [0, 0])

    // Each changes something else: both are kept, nobody is asked.
    await edit(a.patch, 'preference: dark', 'preference: solarized')
    await writeFile(b.patch, `${patchB}- id: extra\n  config:\n    y: 1\n`)
    s = await sync(a)
    assert.equal(s.error, undefined)
    // Counted as of the last fetch: B has not seen the push of A yet.
    s = await status(b)
    assert.deepEqual([s.incoming, s.outgoing], [0, 1])
    s = await sync(b, { message: 'b adds extra' })
    assert.equal(s.conflicts, undefined)
    assert.match(await readFile(b.patch, 'utf8'), /solarized/)
    assert.match(git(remote, 'show', 'main:cordis.patch.yml'), /id: extra/)
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main').trim(), 'b adds extra')

    // Both change the same setting: the second to sync chooses, the first then takes it silently.
    await edit(a.patch, 'preference: solarized', 'preference: contrast')
    assert.equal((await sync(a)).error, undefined)
    await edit(b.patch, 'preference: solarized', 'preference: mono')
    s = await sync(b)
    const conflict = s.conflicts!.items[0]!
    assert.deepEqual([conflict.local, conflict.remote], ['mono', 'contrast'])
    s = await sync(b, { remote: s.conflicts!.remote, choices: { [conflict.key]: 'local' } })
    assert.match(git(remote, 'show', 'main:cordis.patch.yml'), /mono/)
    s = await sync(a)
    assert.equal(s.conflicts, undefined)
    assert.match(await readFile(a.patch, 'utf8'), /preference: mono/)
    assert.match(await readFile(a.patch, 'utf8'), /id: extra/)

    // Choices made against an older remote version ask again.
    await edit(a.patch, 'preference: mono', 'preference: a1')
    await edit(b.patch, 'preference: mono', 'preference: b1')
    await sync(a)
    s = await sync(b)
    const stale = s.conflicts!
    await edit(a.patch, 'preference: a1', 'preference: a2')
    await sync(a)
    s = await sync(b, { remote: stale.remote, choices: { [stale.items[0]!.key]: 'local' } })
    assert.equal(s.conflicts?.items[0]?.remote, 'a2')
    assert.match(await readFile(b.patch, 'utf8'), /preference: b1/)
    s = await b.sync.handle({ op: 'discard' }) as SyncStatus
    assert.equal(s.conflicts, undefined)

    // Going back: restoring a version applies it here; the next sync pushes it.
    const log = await b.sync.handle({ op: 'log' }) as SyncLog
    const first = log.versions.at(-1)!
    await b.sync.handle({ op: 'restore', commit: first.commit })
    await b.sync.idle()
    s = await status(b)
    assert.equal(s.error, undefined)
    assert.equal(s.last?.kind, 'restore')
    assert.ok(s.last?.undo !== undefined)
    assert.ok(s.outgoing > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync: at startup the changes of the remote are taken when nothing conflicts, and only announced when something does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const a = await machine(root, 'a', remote, ['@deepseek-ai/dsh-base'])
    const b = await machine(root, 'b', remote, ['@deepseek-ai/dsh-base'])
    await writeFile(a.patch, '- id: ui-theme\n  config:\n    preference: dark\n')
    await sync(a)
    await writeFile(b.patch, '- id: other\n  config:\n    z: 1\n')
    assert.equal((await sync(b)).conflicts, undefined)

    await edit(a.patch, 'preference: dark', 'preference: light')
    await sync(a)
    await writeFile(b.patch, `${await readFile(b.patch, 'utf8')}- id: mine\n  config:\n    q: 1\n`)
    await b.sync.start()
    let s = await status(b)
    assert.equal(s.last?.kind, 'pull')
    assert.equal(s.last?.auto, true)
    assert.equal(s.last?.pushed, 0)
    assert.match(await readFile(b.patch, 'utf8'), /preference: light/)
    assert.match(await readFile(b.patch, 'utf8'), /id: mine/)
    assert.doesNotMatch(git(remote, 'show', 'main:cordis.patch.yml'), /id: mine/, 'nothing is pushed at startup')
    assert.deepEqual([s.incoming, s.outgoing], [0, 1])

    await edit(a.patch, 'preference: light', 'preference: sepia')
    await sync(a)
    await edit(b.patch, 'preference: light', 'preference: night')
    await b.sync.start()
    s = await status(b)
    assert.equal(s.conflicts?.items.length, 1)
    assert.match(await readFile(b.patch, 'utf8'), /preference: night/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync: a reload of the plugin while a sync applies keeps following it, and keeps its outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const a = await machine(root, 'a', remote, ['@deepseek-ai/dsh-base'])
    await writeFile(a.patch, '- id: ui-theme\n  config:\n    preference: dark\n')
    await sync(a)
    // DSH reloads the plugin when the applied settings are its own: a new instance on the same repository.
    let reloaded: Machine | undefined
    let during: SyncStatus | undefined
    const activate = async (): Promise<{ restart: boolean }> => {
      reloaded = await machine(root, 'b', remote, ['@deepseek-ai/dsh-base'], process.platform, { dir: join(root, 'b', 'sync') })
      during = await reloaded.sync.handle({ op: 'status' }) as SyncStatus
      return { restart: false }
    }
    const b = await machine(root, 'b', remote, ['@deepseek-ai/dsh-base'], process.platform, { activate })
    assert.equal(b.sync.resumed, false)
    const s = await sync(b)
    assert.equal(s.last?.kind, 'sync')
    assert.equal(reloaded?.sync.resumed, true)
    assert.equal(during?.busy, 'sync', 'the new instance reports the run of the old one')
    const after = await reloaded!.sync.handle({ op: 'status' }) as SyncStatus
    assert.equal(after.busy, null)
    assert.equal(after.last?.at, s.last?.at)
    assert.ok(after.last!.applied.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync: a Windows machine and a Mac keep their own terminal shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const pc = await machine(root, 'pc', remote, ['@deepseek-ai/dsh-base'], 'win32')
    const mbp = await machine(root, 'mbp', remote, ['@deepseek-ai/dsh-base'], 'darwin')
    await writeFile(pc.patch, PWSH)
    await sync(pc)
    assert.doesNotMatch(git(remote, 'show', 'main:cordis.patch.yml'), /terminal-controller/)
    await writeFile(mbp.patch, ZSH.replace('- id: agent-hub\n  disabled: false\n', ''))
    // The shell is each machine's own: nothing differs.
    let s = await sync(mbp)
    assert.equal(s.conflicts, undefined)
    // The PC changes its theme; the Mac takes it and keeps zsh.
    await writeFile(pc.patch, PWSH.replace('preference: dark', 'preference: light'))
    await sync(pc)
    s = await sync(mbp)
    assert.equal(s.error, undefined)
    assert.deepEqual(s.last?.applied.map((group) => group.id), ['ui-theme'])
    const patch = await readFile(mbp.patch, 'utf8')
    assert.match(patch, /\/bin\/zsh/, 'the shell of the Mac survives applying')
    assert.match(patch, /preference: light/)
    assert.doesNotMatch(patch, /pwsh/)
    assert.doesNotMatch(git(remote, 'show', 'main:cordis.patch.yml'), /zsh|pwsh/)
    // The settings page reads what there is to pick from.
    const { entries } = await mbp.sync.handle({ op: 'catalog' }) as SyncCatalog
    assert.deepEqual(entries.map((entry) => [entry.id, entry.only]), [['terminal-controller', undefined], ['ui-theme', undefined]])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync: a plugin version from the remote is installed now, or at the restart on a hot-reloading host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const a = await machine(root, 'a', remote, ['@deepseek-ai/dsh-base', 'dsh-context'])
    assert.equal((await sync(a)).error, undefined)

    const older = async (name: string, hotReload: boolean, installed: string[]): Promise<{ m: Machine; pending: PendingOps }> => {
      const pending = new PendingOps(join(root, name, 'state'))
      let manifestFile = ''
      const write = (spec: string): Promise<void> => writeFile(manifestFile, `${JSON.stringify({ name: 'p', dependencies: { 'dsh-context': spec }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } } }, null, 2)}\n`)
      const m = await machine(root, name, remote, ['@deepseek-ai/dsh-base', 'dsh-context'], process.platform, {
        hotReload: () => hotReload,
        pending,
        activate: async (packages) => ({ restart: packages || !hotReload }),
        plugins: () => ({
          async listBundles() {
            return ['@deepseek-ai/dsh-base', 'dsh-context'].map((item) => ({ name: item, installed: true, enabled: true }))
          },
          async installBundle(spec) {
            installed.push(spec)
            await write('0.67.0')
            return { application: 'restart-required' }
          },
        }),
      })
      manifestFile = m.manifest
      await write('^0.60.0')
      return { m, pending }
    }

    // Hot reload: the upgrade waits for the restart, and counts as done meanwhile.
    const hot: string[] = []
    const b = await older('b', true, hot)
    let s = await sync(b.m)
    // Never synced before: the two versions are a choice.
    assert.deepEqual(s.conflicts?.items.map((item) => [item.kind, item.path.join(), item.local, item.remote]), [['dependencies', 'dsh-context', '0.60.0', '0.67.0']])
    s = await sync(b.m, { remote: s.conflicts!.remote, choices: { [s.conflicts!.items[0]!.key]: 'remote' } })
    assert.equal(s.error, undefined)
    assert.deepEqual(hot, [])
    assert.deepEqual(b.pending.list(), [{ name: 'dsh-context', spec: '0.67.0', from: '^0.60.0' }])
    assert.deepEqual(s.last?.scheduled, ['dsh-context'])
    assert.equal(s.last?.restart, true)
    assert.deepEqual(s.last?.unapplied, [])
    assert.deepEqual([s.incoming, s.outgoing], [0, 0])
    assert.doesNotMatch(git(remote, 'show', 'main:plugins.json'), /0\.60\.0/, 'the older version is never pushed back')

    // No hot reload: the installer of DSH upgrades it now; it takes effect at the restart.
    const cold: string[] = []
    const c = await older('c', false, cold)
    s = await sync(c.m)
    s = await sync(c.m, { remote: s.conflicts!.remote, choices: { [s.conflicts!.items[0]!.key]: 'remote' } })
    assert.equal(s.error, undefined)
    assert.deepEqual(cold, ['dsh-context@0.67.0'])
    assert.deepEqual(c.pending.list(), [])
    assert.equal(s.progress?.stage, 'done')
    assert.equal(s.last?.restart, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sync: either side can overwrite the other outright; nothing is merged, nothing asked, the history kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  try {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    const a = await machine(root, 'a', remote, ['@deepseek-ai/dsh-base'])
    const b = await machine(root, 'b', remote, ['@deepseek-ai/dsh-base'])
    const overwrite = async (m: Machine, source: 'local' | 'remote', message?: string): Promise<SyncStatus> => {
      await m.sync.handle({ op: 'overwrite', source, ...(message === undefined ? {} : { message }) })
      await m.sync.idle()
      return status(m)
    }

    // An empty remote has nothing to take.
    let s = await overwrite(b, 'remote')
    assert.match(s.error ?? '', /no settings yet/)

    await writeFile(a.patch, '- id: ui-theme\n  config:\n    preference: dark\n- id: only-a\n  config:\n    x: 1\n')
    await sync(a)
    // B differs in a setting both have and has an entry of its own: a sync would ask; overwriting does not.
    await writeFile(b.patch, '- id: ui-theme\n  config:\n    preference: light\n- id: only-b\n  config:\n    y: 2\n')
    s = await overwrite(b, 'local', 'b wins')
    assert.equal(s.error, undefined)
    assert.equal(s.conflicts, undefined)
    assert.equal(s.last?.kind, 'overwriteRemote')
    assert.ok((s.last?.pushed ?? 0) > 0)
    const shared = git(remote, 'show', 'main:cordis.patch.yml')
    assert.match(shared, /preference: light/)
    assert.match(shared, /id: only-b/)
    assert.doesNotMatch(shared, /only-a/, 'what only the remote had is dropped')
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main').trim(), 'b wins')
    assert.match(git(remote, 'log', '-p', 'main'), /only-a/, 'the remote\'s earlier versions stay in the history')
    assert.deepEqual([s.incoming, s.outgoing], [0, 0])

    // A changed meanwhile; taking the remote as it is replaces those changes, and undo brings them back.
    await edit(a.patch, 'preference: dark', 'preference: solarized')
    s = await overwrite(a, 'remote')
    assert.equal(s.error, undefined)
    assert.equal(s.last?.kind, 'overwriteLocal')
    assert.equal(s.last?.pushed, 0)
    const patchA = await readFile(a.patch, 'utf8')
    assert.match(patchA, /preference: light/)
    assert.match(patchA, /id: only-b/)
    assert.doesNotMatch(patchA, /only-a|solarized/)
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main').trim(), 'b wins', 'nothing is pushed')
    assert.deepEqual([s.incoming, s.outgoing], [0, 0])
    await a.sync.handle({ op: 'restore', commit: s.last!.undo! })
    await a.sync.idle()
    assert.match(await readFile(a.patch, 'utf8'), /preference: solarized/)

    // A sync afterwards has nothing to ask.
    s = await sync(b)
    assert.equal(s.error, undefined)
    assert.equal(s.conflicts, undefined)

    // Overwriting a remote that already matches leaves its version as it is.
    const tip = git(remote, 'rev-parse', 'main').trim()
    s = await overwrite(b, 'local')
    assert.equal(s.error, undefined)
    assert.equal(s.last?.pushed, 0)
    assert.equal(git(remote, 'rev-parse', 'main').trim(), tip)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
