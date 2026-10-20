/**
 * Settings sync: this profile's settings and plugin selection, kept in a git
 * repository and shared through any git remote (GitHub, Gitee, a self-hosted
 * server, a path on a NAS). Every machine holds the full history; the remote
 * only relays it. Authentication is the machine's own git setup (SSH keys,
 * credential helpers); nothing here stores a credential, and sign-ins never
 * leave DSH's credential store.
 *
 * The repository holds the shared form of the profile (portable.ts), never the
 * live files. A sync fetches the remote and merges, setting by setting, what
 * this machine and the remote each changed since they last agreed (merge.ts):
 * what only one side changed is taken without asking; only a setting both
 * sides changed differently waits for the person's choice. The result is
 * applied here and pushed as a version whose parents keep both histories, so
 * nothing is lost and the push stays a fast-forward. At startup (when enabled)
 * the remote's changes are pulled the same way, pushing nothing; a conflict
 * there is only announced.
 *
 * Two commits anchor the repository to this machine: HEAD, the last version
 * agreed on here, and `dsh.applied`, the version this machine's profile was
 * last made equal to. The merge's base is where `dsh.applied` and the remote
 * meet; edits made here since are recorded on top of it, so they stay in the
 * history and can be gone back to.
 *
 * Applying brings DSH itself along, not only its files: the profile patch and
 * the bundle selection are written, plugins the shared list adds are installed
 * and those it moved to another version are upgraded (on a hot-reloading host,
 * at the next restart: plugins/pending.ts), DSH is asked to take the new
 * profile in (`activate`), and the profile is read back so whatever did not
 * take effect is reported rather than lost.
 *
 * Collections travel with them (collection.ts: the clipboard window's pinned
 * texts, the reader's feeds and favorites), merged the same way: a record is
 * there or not, identified by its content, so a text pinned on two machines
 * stays one pin. Their base is not where the commits met but the version the
 * records here last matched (`dsh.<key>`): records this machine never received
 * are not mistaken for ones it removed.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { runGit, type RunOptions, type Runner } from '../git/service.ts'
import type { PendingOps } from '../plugins/pending.ts'
import { anchorOf, parseCollection, serializeCollection, type Collection, type CollectionStore } from './collection.ts'
import { catalog, compareSettings } from './compare.ts'
import { mergeSettings, type Choice } from './merge.ts'
import {
  ATTRIBUTES, ATTRIBUTES_FILE, LOCAL_SETTINGS, PATCH_FILE, PLUGINS_FILE, canonicalSpec, localPatch, parsePlugins, planPlugins, portablePatch, portablePlugins, serializePlugins, sharedPatch,
  type LocalPlugins, type Machine, type Manifest,
} from './portable.ts'
import type { SyncCatalog, SyncChangeGroup, SyncConflict, SyncLog, SyncOutcome, SyncProgress, SyncRequest, SyncStatus, SyncVersion } from './types.ts'

export interface SyncSettings {
  remote?: string
  branch: string
  /** At startup, fetch and take the remote's changes when nothing conflicts. */
  fetchOnStart: boolean
  /** What each machine keeps for itself: whole entries (`terminal-controller`) and settings as entry id then path (`ui-theme.config.preference`). */
  localSettings?: readonly string[]
  /** Entry ids an earlier version stored once per system; each machine now keeps them for itself. */
  platformEntries?: readonly string[]
}

/** What this machine keeps for itself, the entries an earlier version stored per system included. */
export const machineBound = (settings: SyncSettings): string[] =>
  [...new Set([...(settings.localSettings ?? LOCAL_SETTINGS), ...(settings.platformEntries ?? [])])]

/** Where the running profile lives (DSH's `profileContext`). */
export interface ProfileLocation {
  dir: string
  patchPath: string
}

/** A collection that travels with the settings, and where this machine keeps its records. */
export interface SyncedCollection {
  collection: Collection
  store: CollectionStore
}

/** The slice of DSH's plugin manager sync uses. */
export interface PluginManager {
  listBundles(): Promise<Array<{ name: string; installed: boolean; enabled: boolean; readOnlyReason?: string; error?: unknown }>>
  installBundle(spec: string, options?: { enabled?: boolean; requestId?: string }): Promise<{ application?: string; error?: { code?: string; diagnostic?: string }; pendingBuilds?: string[] }>
}

/** The plugin manager's `plugin-manager/install-log` and `install-state` events, keyed by the install's `requestId`. */
export type InstallEvents = (listener: (kind: 'log' | 'state', event: unknown) => void) => () => void

export interface SyncOptions {
  /** The sync repository. */
  dir: string
  profile: () => ProfileLocation | undefined
  settings: () => SyncSettings
  plugins: () => PluginManager | undefined
  /** The pinned clipboard texts, the reader's feeds and favorites. */
  collections?: readonly SyncedCollection[]
  /** Whether DSH applies profile file changes without a restart. */
  hotReload: () => boolean
  machine: Machine & { name: string }
  /** Streams a running install's pnpm output and stage; without it the page shows the stages sync knows. */
  installEvents?: InstallEvents
  /** Serializes writes with DSH's own profile writers (the plugin manager, the settings service). */
  lock?: <T>(file: string, operation: () => Promise<T>) => Promise<T>
  /** Where upgrades a hot-reloading host refuses wait for the next restart. */
  pending?: PendingOps
  /**
   * Make the running DSH take in the profile just written; `packages` when plugins were installed
   * or the bundle selection changed. Answers whether a restart is still needed.
   */
  activate?: (packages: boolean) => Promise<{ restart: boolean }>
  git?: Runner
  log?: (message: string) => void
}

type Files = Record<string, string>
type Busy = NonNullable<SyncStatus['busy']>

const NETWORK: RunOptions = { timeoutMs: 120_000 }
const SHARED = [ATTRIBUTES_FILE, PATCH_FILE, PLUGINS_FILE] as const
const CONFLICT_MARK = /^(<{7}|={7}|>{7})( |$)/m
const lf = (text: string): string => text.replace(/\r\n?/g, '\n')
/** pnpm output lines kept for the page. */
const PROGRESS_LINES = 40
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const count = (groups: readonly SyncChangeGroup[]): number => groups.reduce((sum, group) => sum + group.changes.length, 0)

class SyncError extends Error {}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** A stored file that may be applied: no conflict markers, and readable. */
export function checkFile(file: string, text: string): void {
  if (CONFLICT_MARK.test(text)) throw new SyncError(`${file}: conflict markers remain`)
  if (file === PATCH_FILE) {
    const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    if (document.errors[0] !== undefined) throw new SyncError(`${file}: ${document.errors[0].message}`)
    if (!Array.isArray(document.toJS())) throw new SyncError(`${file}: must be a YAML list`)
  } else if (file.endsWith('.json')) {
    try {
      JSON.parse(text)
    } catch (error) {
      throw new SyncError(`${file}: ${(error as Error).message}`)
    }
  }
}

/** What applying the merged settings did here. */
type Applied = Pick<SyncOutcome, 'applied' | 'unapplied' | 'restart' | 'scheduled'>

/** What a sync knows between operations; outlives a reload of this plugin (see `shared`). */
interface State {
  queue: Promise<unknown>
  error?: string
  fetchedAt?: string
  progress?: SyncProgress
  busy: Busy | null
  conflicts?: SyncStatus['conflicts']
  last?: SyncOutcome
  /** The counts as last read, answered while an operation runs. */
  view: Pick<SyncStatus, 'incoming' | 'outgoing' | 'conflicting' | 'remoteEmpty' | 'head'>
}

const STATE = Symbol.for('dsh-agent-hub.sync.state')

/**
 * The state of the sync repository at `dir`, kept for the life of the process. Applying a sync
 * that changes this plugin's own settings makes DSH reload the plugin while the sync still runs:
 * the next instance answers from the same state, so the page keeps following the run, then
 * shows its outcome and can undo it.
 */
function shared(dir: string): { state: State; resumed: boolean } {
  const registry = ((globalThis as Record<symbol, unknown>)[STATE] ??= new Map<string, State>()) as Map<string, State>
  const state = registry.get(dir)
  if (state !== undefined) return { state, resumed: true }
  const fresh: State = { queue: Promise.resolve(), busy: null, view: { incoming: 0, outgoing: 0, remoteEmpty: false } }
  registry.set(dir, fresh)
  return { state: fresh, resumed: false }
}

export class ConfigSync {
  private readonly options: SyncOptions
  private readonly run: Runner
  private readonly state: State
  /** An earlier instance in this process used the repository: this one comes from a reload, not a start. */
  readonly resumed: boolean

  constructor(options: SyncOptions) {
    this.options = options
    this.run = options.git ?? runGit
    const { state, resumed } = shared(options.dir)
    this.state = state
    this.resumed = resumed
  }

  /** The startup pull: the remote's changes are taken when nothing conflicts; nothing is pushed. */
  start(): Promise<void> {
    if (!this.options.settings().fetchOnStart || !this.configured()) return Promise.resolve()
    this.background('pull', () => this.synchronize({}, { push: false, auto: true }))
    return this.idle()
  }

  /** Settles once nothing runs. */
  async idle(): Promise<void> {
    for (;;) {
      const queue = this.state.queue
      await queue
      if (queue === this.state.queue) return
    }
  }

  async handle(request: SyncRequest): Promise<SyncStatus | SyncLog | SyncCatalog> {
    if (request.op === 'log') return this.serial(() => this.log())
    if (request.op === 'catalog') return this.serial(() => this.catalog())
    if (request.op === 'discard') this.state.conflicts = undefined
    if (request.op === 'sync' && this.state.busy === null) {
      if (!this.configured()) this.state.error = 'set a remote first'
      else this.background('sync', () => this.synchronize(request, { push: true }))
    }
    if (request.op === 'restore' && this.state.busy === null) {
      const commit = request.commit
      this.background('restore', () => this.restore(commit))
    }
    if (request.op === 'overwrite' && this.state.busy === null) {
      if (!this.configured()) this.state.error = 'set a remote first'
      else if (request.source === 'local') this.background('overwriteRemote', () => this.overwriteRemote(request.message))
      else this.background('overwriteLocal', () => this.overwriteLocal())
    }
    return this.status()
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.state.queue.then(work, work)
    this.state.queue = next.catch(() => {})
    return next
  }

  /** Long work (fetch, pnpm) runs beside the request: the page reads the status meanwhile. */
  private background(kind: Busy, work: () => Promise<void>): void {
    this.state.busy = kind
    this.state.error = undefined
    void this.serial(async () => {
      try {
        await work()
        await this.measure()
      } catch (error) {
        this.state.error = (error as Error).message
        this.options.log?.(`${kind} failed: ${this.state.error}`)
      } finally {
        this.state.busy = null
      }
    })
  }

  // ── Operations ──────────────────────────────────────────────────────────

  /**
   * Merge this machine's settings with the remote's and apply the result here; with `push`, the
   * result becomes the remote's next version. A conflict without a choice stops before anything
   * changes and waits in `conflicts`. Choices count only against the remote version they were
   * made for, so a remote that moved meanwhile asks again.
   */
  private async synchronize(request: { remote?: string | null; choices?: Record<string, Choice>; message?: string }, how: { push: boolean; auto?: boolean }): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.ensureRepo()
      await this.fetch()
      const remote = await this.remoteHead()
      const current = request.remote === undefined || (request.remote ?? null) === (remote ?? null)
      const sides = await this.sides(remote)
      const merged = this.merge(sides.base, sides.local, sides.remote, current ? request.choices ?? {} : {})
      if (merged.files === undefined) {
        this.state.conflicts = { remote: remote ?? null, items: merged.conflicts.map(({ choice: _choice, ...item }) => item as SyncConflict) }
        return
      }
      this.state.conflicts = undefined
      const files = merged.files
      const taken = this.compare(sides.local, files)
      if (!how.push) {
        if (remote === undefined || taken.length === 0) return
        const undo = await this.recordLocal() ?? await this.applied() ?? await this.head()
        const applied = await this.applyFiles(files, sides.local)
        const head = await this.head()
        if (head === undefined || await this.ancestor(head, remote)) await this.setHead(remote)
        await this.setApplied(remote)
        this.state.last = { kind: 'pull', at: new Date().toISOString(), ...(how.auto ? { auto: true } : {}), pushed: 0, ...(undo === undefined ? {} : { undo }), ...applied }
        return
      }
      const head = await this.head()
      const before = await this.recordLocal()
      const undo = before ?? await this.applied() ?? head
      const given = sides.remote === undefined ? [] : this.compare(sides.remote, files)
      let commit: string
      if (remote !== undefined && given.length === 0) {
        // The remote's settings as they are; this machine's earlier ones still join the history.
        const extra = await this.unmerged([head, before], remote)
        commit = extra.length === 0 ? remote : await this.commitTree(`${remote}^{tree}`, [remote, ...extra], `${this.options.machine.name}: take the remote's settings`)
      } else {
        const base = remote ?? head
        const parents = [...(base === undefined ? [] : [base]), ...await this.unmerged([head, before], base)]
        commit = await this.commitFiles(base, files, request.message?.trim() || `${this.options.machine.name}: sync settings`, parents)
      }
      await this.setHead(commit)
      const applied = await this.applyFiles(files, sides.local)
      await this.setApplied(commit)
      if (commit !== remote && await this.push() === 'rejected') continue
      this.state.last = { kind: 'sync', at: new Date().toISOString(), pushed: given.length === 0 && remote !== undefined ? 0 : sides.remote === undefined ? count(this.compare({}, files)) : count(given), ...(undo === undefined ? {} : { undo }), ...applied }
      return
    }
    throw new SyncError('the remote kept changing; sync again')
  }

  /**
   * This machine's settings as a version over the one last applied here, when they changed since;
   * before the first sync, as a version of their own, so they can still be restored.
   */
  private async recordLocal(): Promise<string | undefined> {
    const applied = await this.applied() ?? await this.head()
    if (applied === undefined) return this.commitFiles(undefined, await this.liveFiles(undefined), `${this.options.machine.name}: settings before the first sync`)
    const files = await this.liveFiles(applied)
    return await this.same(applied, files) ? undefined : this.commitFiles(applied, files, `${this.options.machine.name}: settings changed`)
  }

  /**
   * The remote's next version holds exactly this machine's settings; what only the remote had is
   * dropped from it, nothing asked. The version follows the remote's, so the push is a fast-forward
   * and the remote's earlier versions stay in the history, to be restored.
   */
  private async overwriteRemote(message?: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.ensureRepo()
      await this.fetch()
      const remote = await this.remoteHead()
      const head = await this.head()
      const before = await this.recordLocal()
      const files = await this.liveFiles(remote ?? await this.applied() ?? head)
      const replaced = remote === undefined ? this.compare({}, files) : this.compare(await this.stored(remote), files)
      const base = remote ?? head
      const parents = [...(base === undefined ? [] : [base]), ...await this.unmerged([head, before], base)]
      // Already the same: the remote's version stays, this machine's earlier ones still join the history.
      const commit = remote !== undefined && replaced.length === 0
        ? parents.length === 1 ? remote : await this.commitTree(`${remote}^{tree}`, parents, `${this.options.machine.name}: take the remote's settings`)
        : await this.commitFiles(base, files, message?.trim() || `${this.options.machine.name}: overwrite the remote's settings`, parents)
      await this.setHead(commit)
      await this.setApplied(commit)
      this.state.conflicts = undefined
      if (commit !== remote && await this.push() === 'rejected') continue
      this.state.last = { kind: 'overwriteRemote', at: new Date().toISOString(), pushed: count(replaced), applied: [], unapplied: [], restart: false, scheduled: [] }
      return
    }
    throw new SyncError('the remote kept changing; try again')
  }

  /**
   * This machine takes the remote's settings as they are; its own changes are dropped, nothing
   * asked, but stay in the history (`undo`). Nothing is pushed: the next sync shares the history.
   */
  private async overwriteLocal(): Promise<void> {
    await this.ensureRepo()
    await this.fetch()
    const remote = await this.remoteHead()
    if (remote === undefined) throw new SyncError('the remote has no settings yet')
    const head = await this.head()
    const before = await this.recordLocal()
    const undo = before ?? await this.applied() ?? head
    const local = await this.liveFiles(remote)
    const extra = await this.unmerged([head, before], remote)
    const commit = extra.length === 0 ? remote : await this.commitTree(`${remote}^{tree}`, [remote, ...extra], `${this.options.machine.name}: overwrite with the remote's settings`)
    await this.setHead(commit)
    const applied = await this.applyFiles(await this.stored(remote), local)
    await this.setApplied(commit)
    this.state.conflicts = undefined
    this.state.last = { kind: 'overwriteLocal', at: new Date().toISOString(), pushed: 0, ...(undo === undefined ? {} : { undo }), ...applied }
  }

  /** The commits not already contained in `tip`. */
  private async unmerged(commits: ReadonlyArray<string | undefined>, tip: string | undefined): Promise<string[]> {
    const out: string[] = []
    for (const commit of commits) {
      if (commit === undefined || commit === tip || out.includes(commit)) continue
      if (tip !== undefined && await this.ancestor(commit, tip)) continue
      out.push(commit)
    }
    return out
  }

  private async ancestor(commit: string, tip: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', commit, tip], this.options.dir, { read: true })).code === 0
  }

  /** A new version with an earlier one's files, applied here; this machine's unrecorded changes stay in the history. */
  private async restore(target: string): Promise<void> {
    await this.ensureRepo()
    const head = await this.head()
    if (head === undefined) throw new SyncError('nothing to restore yet')
    const commit = (await this.git(['rev-parse', '--verify', '-q', `${target}^{commit}`])).trim()
    const files: Files = {}
    for (const file of [...SHARED, ...this.specs().map((collection) => collection.file)]) {
      const text = await this.show(commit, file)
      if (text !== undefined) files[file] = text
    }
    const subject = (await this.git(['log', '-1', '--format=%s', commit])).trim()
    const before = await this.recordLocal()
    const undo = before ?? await this.applied() ?? head
    const parents = [head, ...await this.unmerged([before], head)]
    const version = await this.commitFiles(head, files, `${this.options.machine.name}: restore ${commit.slice(0, 7)} (${subject})`, parents)
    await this.setHead(version)
    const live = await this.liveFiles(version)
    const applied = await this.applyFiles(await this.stored(version), live)
    await this.setApplied(version)
    this.state.last = { kind: 'restore', at: new Date().toISOString(), pushed: 0, undo, ...applied }
  }

  /** One plugin manager install, recorded in `progress` from start to outcome for the page to follow. */
  private async runInstall(manager: PluginManager, target: Pick<SyncProgress, 'op' | 'name' | 'spec'>, options: { enabled?: boolean }): Promise<void> {
    const requestId = randomUUID()
    const progress: SyncProgress = { ...target, stage: 'installing', lines: [], startedAt: new Date().toISOString() }
    this.state.progress = progress
    const off = this.options.installEvents?.((kind, event) => {
      const data = (event ?? {}) as Record<string, unknown>
      if (data.requestId !== requestId || progress.finishedAt !== undefined) return
      if (kind === 'log') {
        const text = [data.line, data.text, data.chunk, data.data, data.output, data.message].find((value) => typeof value === 'string')
        if (typeof text !== 'string') return
        const lines = lf(text.replace(ANSI, '')).split('\n').map((line) => line.trimEnd()).filter(Boolean)
        progress.lines = [...progress.lines, ...lines].slice(-PROGRESS_LINES)
        return
      }
      const state = [data.phase, data.state, data.status, data.stage].find((value) => typeof value === 'string')
      if (state === 'applying') progress.stage = 'applying'
      const attempt = data.attempt as { registry?: unknown } | undefined
      const registry = attempt?.registry ?? data.registry
      if (typeof registry === 'string') progress.registry = registry
    })
    const finish = (stage: 'done' | 'failed', result: string): void => {
      progress.stage = stage
      progress.result = result
      progress.finishedAt = new Date().toISOString()
    }
    try {
      const result = await manager.installBundle(`${target.name}@${target.spec}`, { ...options, requestId })
      if (result.application === 'failed' || result.application === 'cancelled') {
        const builds = result.pendingBuilds?.length ? ` (build scripts awaiting approval: ${result.pendingBuilds.join(', ')}; approve them on the Plugins page)` : ''
        const message = `${target.op === 'install' ? 'installing' : `upgrading ${target.name} to`} ${target.spec} failed: ${result.error?.diagnostic ?? result.error?.code ?? result.application}${builds}`
        finish('failed', message)
        throw new SyncError(message)
      }
      finish('done', (await this.manifest()).dependencies?.[target.name] ?? target.spec)
    } catch (error) {
      if (progress.finishedAt === undefined) finish('failed', (error as Error).message)
      throw error
    } finally {
      off?.()
    }
  }

  private async log(): Promise<SyncLog> {
    await this.ensureRepo()
    if (await this.head() === undefined) return { versions: [] }
    const text = await this.git(['log', '-n', '50', '--format=%H%x1f%aI%x1f%an%x1f%s'])
    const versions: SyncVersion[] = text.split('\n').filter(Boolean).map((line) => {
      const [commit = '', date = '', author = '', subject = ''] = line.split('\x1f')
      return { commit, date, author, subject }
    })
    return { versions }
  }

  // ── Applying ────────────────────────────────────────────────────────────

  /**
   * Bring this machine to `files` (shared form): the profile patch and the bundle selection, the
   * plugins the shared list adds or moved to another version, then DSH's running profile; finally
   * read back what did not take effect. `before` is this machine's settings beforehand.
   */
  private async applyFiles(files: Files, before: Files): Promise<Applied> {
    const applied = this.compare(before, files)
    if (applied.length === 0) return { applied, unapplied: [], restart: false, scheduled: [] }
    let { patchChanged, bundlesChanged } = await this.writeProfile(files)
    await this.applyCollections(files, before)
    const manager = this.options.plugins()
    const doc = parsePlugins(files[PLUGINS_FILE])
    const scheduled: string[] = []
    let installed = false
    if (doc !== undefined && manager !== undefined) {
      const plan = planPlugins(doc, await this.localPlugins(await this.manifest(), manager))
      for (const item of plan.install) {
        try {
          await this.runInstall(manager, { op: 'install', name: item.name, spec: item.spec }, { enabled: doc.bundles.includes(item.name) })
          installed = true
        } catch (error) {
          this.options.log?.(`install ${item.name}: ${(error as Error).message}`)
        }
      }
      for (const item of plan.upgrade) {
        // A hot-reloading host refuses to replace an installed plugin: it waits for the restart.
        if (this.options.hotReload() && this.options.pending !== undefined) {
          this.options.pending.add([{ name: item.name, spec: item.spec, from: item.from }])
          scheduled.push(item.name)
          continue
        }
        try {
          await this.runInstall(manager, { op: 'upgrade', name: item.name, spec: item.spec }, {})
          installed = true
        } catch (error) {
          this.options.log?.(`upgrade ${item.name}: ${(error as Error).message}`)
        }
      }
      // Installing appends the bundle; put it where the shared order has it.
      if (installed) bundlesChanged = (await this.writeProfile(files)).bundlesChanged || bundlesChanged
    }
    let restart = scheduled.length > 0
    if (patchChanged || bundlesChanged || installed) {
      try {
        const activation = await this.options.activate?.(bundlesChanged || installed) ?? { restart: !this.options.hotReload() }
        restart ||= activation.restart
      } catch (error) {
        restart = true
        this.options.log?.(`activate: ${(error as Error).message}`)
      }
    }
    const unapplied = this.compare(await this.liveFiles(undefined, files), files)
    return { applied, unapplied, restart, scheduled }
  }

  /** The records `files` hold become this machine's, for each collection whose keeper can tell what they are now. */
  private async applyCollections(files: Files, before: Files): Promise<void> {
    for (const { collection, store } of this.shared()) {
      const wanted = parseCollection(collection, files[collection.file])
      if (wanted === undefined || before[collection.file] === undefined || before[collection.file] === files[collection.file]) continue
      if (await store.set(wanted) !== true) this.options.log?.(`${collection.key}: their keeper did not take them`)
    }
  }

  /** Write the profile patch and the bundle selection `files` hold, as this machine has them. */
  private async writeProfile(files: Files): Promise<{ patchChanged: boolean; bundlesChanged: boolean }> {
    const profile = this.profile()
    const patch = files[PATCH_FILE]
    const plugins = parsePlugins(files[PLUGINS_FILE])
    if (patch !== undefined) checkFile(PATCH_FILE, patch)
    const manager = this.options.plugins()
    const manifestFile = join(profile.dir, 'package.json')
    const lock = this.options.lock ?? ((_file, operation) => operation())
    let patchChanged = false
    let bundlesChanged = false
    await lock(manifestFile, async () => {
      if (patch !== undefined) {
        const current = await readText(profile.patchPath) ?? '[]\n'
        const next = localPatch(patch, this.options.machine, current, machineBound(this.options.settings()))
        if (next !== lf(current)) {
          await atomicWrite(profile.patchPath, next)
          patchChanged = true
        }
      }
      if (plugins !== undefined && manager !== undefined) {
        const manifest = await this.manifest()
        const plan = planPlugins(plugins, await this.localPlugins(manifest, manager))
        const current = manifest.dsh?.profile?.bundles ?? []
        if (JSON.stringify(current) !== JSON.stringify(plan.bundles)) {
          const dsh = (manifest.dsh ?? {}) as NonNullable<Manifest['dsh']>
          manifest.dsh = { ...dsh, profile: { ...dsh.profile, bundles: plan.bundles } }
          await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
          bundlesChanged = true
        }
      }
    })
    return { patchChanged, bundlesChanged }
  }

  private async push(): Promise<'pushed' | 'rejected'> {
    const branch = this.options.settings().branch
    const result = await this.run(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], this.options.dir, NETWORK)
    if (result.code === 0) {
      await this.git(['update-ref', this.remoteRef(), 'HEAD'])
      return 'pushed'
    }
    const detail = result.stderr.trim() || result.stdout.trim()
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(detail)) return 'rejected'
    throw new SyncError(detail || 'push failed')
  }

  private async fetch(): Promise<void> {
    if (!this.configured()) return
    const branch = this.options.settings().branch
    const result = await this.run(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:${this.remoteRef()}`], this.options.dir, NETWORK)
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      // An empty remote, or one without this branch yet: the first push creates it.
      if (!/couldn't find remote ref|could not find remote ref/i.test(detail)) throw new SyncError(detail || 'fetch failed')
      if (await this.remoteHead() !== undefined) await this.git(['update-ref', '-d', this.remoteRef()])
    }
    this.state.fetchedAt = new Date().toISOString()
  }

  // ── Repository ──────────────────────────────────────────────────────────

  private configured(): boolean {
    return (this.options.settings().remote ?? '').trim() !== ''
  }

  private remoteRef(): string {
    return `refs/remotes/origin/${this.options.settings().branch}`
  }

  private async ensureRepo(): Promise<void> {
    const { dir, machine } = this.options
    await mkdir(dir, { recursive: true })
    if (!existsSync(join(dir, '.git'))) await this.git(['init', '-q'])
    // Versions name the machine that made them, unless git already names the user.
    if ((await this.run(['config', 'user.name'], dir, { read: true })).stdout.trim() === '') await this.git(['config', 'user.name', machine.name])
    if ((await this.run(['config', 'user.email'], dir, { read: true })).stdout.trim() === '') {
      await this.git(['config', 'user.email', `${machine.name.replace(/[^\w.-]+/g, '-') || 'dsh'}@dsh-agent-hub.local`])
    }
    const url = (this.options.settings().remote ?? '').trim()
    const current = await this.run(['remote', 'get-url', 'origin'], dir, { read: true })
    if (url === '') {
      if (current.code === 0) await this.git(['remote', 'remove', 'origin'])
    } else if (current.code !== 0) {
      await this.git(['remote', 'add', 'origin', url])
    } else if (current.stdout.trim() !== url) {
      await this.git(['remote', 'set-url', 'origin', url])
    }
  }

  private async git(args: readonly string[], options?: RunOptions): Promise<string> {
    const result = await this.run(args, this.options.dir, options)
    if (result.code !== 0) throw new SyncError(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`)
    return result.stdout
  }

  private async rev(ref: string): Promise<string | undefined> {
    if (!existsSync(join(this.options.dir, '.git'))) return undefined
    const result = await this.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], this.options.dir, { read: true })
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  private head(): Promise<string | undefined> {
    return this.rev('HEAD')
  }

  private remoteHead(): Promise<string | undefined> {
    return this.rev(this.remoteRef())
  }

  private async anchor(key: string): Promise<string | undefined> {
    if (!existsSync(join(this.options.dir, '.git'))) return undefined
    const result = await this.run(['config', '--get', key], this.options.dir, { read: true })
    const commit = result.stdout.trim()
    return result.code === 0 && commit !== '' ? commit : undefined
  }

  private applied(): Promise<string | undefined> {
    return this.anchor('dsh.applied')
  }

  private async setApplied(commit: string): Promise<void> {
    await this.git(['config', 'dsh.applied', commit])
    // When a collection's records here are this version's, they are the base the next sync tells their changes apart from.
    for (const { collection, store } of this.shared()) {
      const live = await store.get()
      if (live !== undefined && serializeCollection(collection, live) === serializeCollection(collection, parseCollection(collection, await this.show(commit, collection.file)) ?? [])) {
        await this.git(['config', anchorOf(collection), commit])
      }
    }
  }

  /** The collections this machine shares: the ones it does not keep for itself. */
  private shared(): readonly SyncedCollection[] {
    const bound = machineBound(this.options.settings())
    return (this.options.collections ?? []).filter(({ collection }) => !bound.includes(collection.setting))
  }

  private specs(): Collection[] {
    return this.shared().map(({ collection }) => collection)
  }

  private compare(local: Readonly<Record<string, string | undefined>>, remote: Readonly<Record<string, string | undefined>>): SyncChangeGroup[] {
    return compareSettings(local, remote, this.specs())
  }

  private merge(...[base, local, remote, choices]: Parameters<typeof mergeSettings>): ReturnType<typeof mergeSettings> {
    return mergeSettings(base, local, remote, choices, this.specs())
  }

  /** Also clears a merge an earlier version of sync left in progress. */
  private async setHead(commit: string): Promise<void> {
    await this.git(['update-ref', 'HEAD', commit])
    await this.git(['reset', '-q', '--hard', 'HEAD'])
  }

  private async show(commit: string, file: string): Promise<string | undefined> {
    const result = await this.run(['show', `${commit}:${file}`], this.options.dir, { read: true })
    return result.code === 0 ? result.stdout : undefined
  }

  private async same(commit: string, files: Files): Promise<boolean> {
    for (const [file, text] of Object.entries(files)) {
      if (await this.show(commit, file) !== text) return false
    }
    return true
  }

  /**
   * A commit of `files` over `parent`'s tree, made without touching the work tree. `parents`
   * replaces the parent list (a merge); unchanged files over a single parent make no commit.
   */
  private async commitFiles(parent: string | undefined, files: Files, message: string, parents = parent === undefined ? [] : [parent]): Promise<string> {
    const entries = new Map<string, string>()
    if (parent !== undefined) {
      for (const line of (await this.git(['ls-tree', parent], { read: true })).split('\n').filter(Boolean)) {
        entries.set(line.slice(line.indexOf('\t') + 1), line)
      }
    }
    for (const [file, text] of Object.entries(files)) {
      const blob = (await this.git(['hash-object', '-w', '--stdin'], { input: text })).trim()
      entries.set(file, `100644 blob ${blob}\t${file}`)
    }
    const tree = (await this.git(['mktree'], { input: `${[...entries.values()].join('\n')}\n` })).trim()
    if (parents.length === 1 && tree === (await this.git(['rev-parse', `${parents[0]}^{tree}`], { read: true })).trim()) return parents[0]!
    return this.commitTree(tree, parents, message)
  }

  private async commitTree(tree: string, parents: readonly string[], message: string): Promise<string> {
    return (await this.git(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message])).trim()
  }

  /** A version's files in the shared form, without what this machine now keeps for itself. */
  private async stored(commit: string): Promise<Files> {
    const files: Files = {}
    for (const file of SHARED) {
      const text = await this.show(commit, file)
      if (text !== undefined) files[file] = file === PATCH_FILE ? sharedPatch(text, machineBound(this.options.settings())) : text
    }
    // A version from before a collection was shared holds none of its records.
    for (const collection of this.specs()) files[collection.file] = await this.show(commit, collection.file) ?? serializeCollection(collection, [])
    return files
  }

  /** The three sides of a merge: where this machine and the remote last met, this machine, the remote. */
  private async sides(remote: string | undefined): Promise<{ base?: Files; local: Files; remote?: Files }> {
    const anchor = await this.applied() ?? await this.head()
    let base = anchor
    if (anchor !== undefined && remote !== undefined) {
      const result = await this.run(['merge-base', anchor, remote], this.options.dir, { read: true })
      base = result.code === 0 ? result.stdout.trim() : undefined
    }
    // A collection's base is the version its records last matched here, not where the commits met.
    let baseFiles: Files | undefined = base === undefined ? undefined : await this.stored(base)
    for (const collection of this.specs()) {
      if (baseFiles !== undefined) delete baseFiles[collection.file]
      const at = await this.anchor(anchorOf(collection))
      if (at !== undefined) (baseFiles ??= {})[collection.file] = await this.show(at, collection.file) ?? serializeCollection(collection, [])
    }
    return {
      ...(baseFiles === undefined ? {} : { base: baseFiles }),
      local: await this.liveFiles(remote ?? anchor),
      ...(remote === undefined ? {} : { remote: await this.stored(remote) }),
    }
  }

  // ── This machine ────────────────────────────────────────────────────────

  private profile(): ProfileLocation {
    const profile = this.options.profile()
    if (profile === undefined) throw new SyncError('this DSH does not say where its profile is')
    return profile
  }

  private async manifest(): Promise<Manifest> {
    const text = await readText(join(this.profile().dir, 'package.json'))
    return text === undefined ? {} : JSON.parse(text) as Manifest
  }

  /**
   * This machine's settings in the shared form; `base` lends the specs of plugins linked here.
   * An upgrade waiting for the restart counts as done: it is what this machine is going to have.
   */
  private async liveFiles(base: string | undefined, lent?: Files): Promise<Files> {
    const profile = this.profile()
    const stored = lent !== undefined ? parsePlugins(lent[PLUGINS_FILE]) : base === undefined ? undefined : parsePlugins(await this.show(base, PLUGINS_FILE))
    const patch = await readText(profile.patchPath) ?? '[]\n'
    const plugins = portablePlugins(await this.manifest(), stored)
    for (const op of this.options.pending?.list() ?? []) {
      if (plugins.dependencies[op.name] !== undefined) plugins.dependencies[op.name] = canonicalSpec(op.spec)
    }
    const files: Files = {
      [ATTRIBUTES_FILE]: ATTRIBUTES,
      [PATCH_FILE]: portablePatch(patch, this.options.machine, machineBound(this.options.settings())),
      [PLUGINS_FILE]: serializePlugins(plugins),
    }
    for (const { collection, store } of this.shared()) {
      const live = await store.get()
      if (live !== undefined) files[collection.file] = serializeCollection(collection, live)
    }
    return files
  }

  private async localPlugins(manifest: Manifest, manager: PluginManager | undefined): Promise<LocalPlugins> {
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const dependencies = manifest.dependencies ?? {}
    if (manager === undefined) return { bundles, dependencies, available: [...bundles, ...Object.keys(dependencies)], required: bundles }
    const rows = await manager.listBundles()
    return {
      bundles,
      dependencies,
      available: rows.filter((row) => row.error === undefined).map((row) => row.name),
      required: rows.filter((row) => row.readOnlyReason === 'management-required').map((row) => row.name),
    }
  }

  /** This machine's patch (home paths as `~/…`) and the remote's last fetched one, nothing left out. */
  private async catalog(): Promise<SyncCatalog> {
    const profile = this.options.profile()
    const patch = profile === undefined ? undefined : await readText(profile.patchPath)
    const version = existsSync(join(this.options.dir, '.git')) ? await this.remoteHead() ?? await this.head() : undefined
    const remote = version === undefined ? undefined : await this.show(version, PATCH_FILE)
    return { entries: catalog(patch === undefined ? undefined : portablePatch(patch, this.options.machine, []), remote) }
  }

  /** How many settings each side would give the other, as of the last fetch; conflicts apart. */
  private async measure(): Promise<void> {
    if (this.options.profile() === undefined) return
    const head = await this.head()
    const remote = await this.remoteHead()
    if (remote === undefined) {
      this.state.view = { incoming: 0, outgoing: 0, remoteEmpty: this.configured() && this.state.fetchedAt !== undefined, ...(head === undefined ? {} : { head }) }
      return
    }
    const sides = await this.sides(remote)
    const first = this.merge(sides.base, sides.local, sides.remote)
    const pick = (side: Choice): Files | undefined => {
      if (first.files !== undefined) return first.files
      return this.merge(sides.base, sides.local, sides.remote, Object.fromEntries(first.conflicts.map((item) => [item.key, side]))).files
    }
    const keepLocal = pick('local')
    const keepRemote = pick('remote')
    this.state.view = {
      incoming: keepLocal === undefined ? 0 : count(this.compare(sides.local, keepLocal)),
      outgoing: keepRemote === undefined ? 0 : count(this.compare(sides.remote!, keepRemote)),
      conflicting: first.conflicts.length,
      remoteEmpty: false,
      ...(head === undefined ? {} : { head }),
    }
  }

  private async status(): Promise<SyncStatus> {
    const settings = this.options.settings()
    const available = this.options.profile() !== undefined
    if (available && this.state.busy === null) {
      try {
        await this.serial(() => this.measure())
      } catch (error) {
        this.state.error ??= (error as Error).message
      }
    }
    return {
      configured: this.configured(),
      available,
      remote: (settings.remote ?? '').trim(),
      branch: settings.branch,
      busy: this.state.busy,
      ...this.state.view,
      pluginsReadOnly: this.options.plugins() === undefined,
      ...(this.state.fetchedAt === undefined ? {} : { fetchedAt: this.state.fetchedAt }),
      ...(this.state.conflicts === undefined ? {} : { conflicts: this.state.conflicts }),
      ...(this.state.last === undefined ? {} : { last: this.state.last }),
      ...(this.state.error === undefined ? {} : { error: this.state.error }),
      ...(this.state.progress === undefined ? {} : { progress: { ...this.state.progress, lines: [...this.state.progress.lines] } }),
    }
  }
}
