/** Settings sync: the RPC shared by the host (sync/index.ts) and the settings page. */

export const SYNC_METHOD = 'agent-hub/sync'

export type SyncRequest =
  | { op: 'status' }
  /**
   * Fetch, merge this machine's settings with the remote's, apply the result here and push it.
   * Answers at once; the status follows the run. `choices` decide the conflicts the last run
   * reported, valid only against the remote version they were made for (`remote`).
   */
  | { op: 'sync'; remote?: string | null; choices?: Record<string, 'local' | 'remote'>; message?: string }
  /** Forget the conflicts waiting for a decision. */
  | { op: 'discard' }
  | { op: 'log' }
  /** Every entry and setting this machine or the remote has, to pick the machine-bound ones from. */
  | { op: 'catalog' }
  /** A new version with the files of an earlier one, applied here; the next sync pushes it. */
  | { op: 'restore'; commit: string }
  /**
   * Make one side equal to the other, nothing merged. `local`: the remote's next version holds this
   * machine's settings (pushed as a fast-forward, so its earlier versions stay restorable). `remote`:
   * this machine takes the remote's settings as they are; nothing is pushed, and it can be undone.
   */
  | { op: 'overwrite'; source: 'local' | 'remote'; message?: string }

/** An install or upgrade a sync runs, while it runs and after. */
export interface SyncProgress {
  op: 'install' | 'upgrade'
  name: string
  spec: string
  /** `installing` (pnpm runs), `applying` (the bundle is loaded), then `done` or `failed`. */
  stage: 'installing' | 'applying' | 'done' | 'failed'
  /** The registry pnpm is asking, when the plugin manager says. */
  registry?: string
  /** The latest lines of pnpm's output. */
  lines: string[]
  startedAt: string
  finishedAt?: string
  /** The spec this machine has afterwards (done), or the failure (failed). */
  result?: string
}

/** One setting that differs; a side without the setting has no value. */
export interface SyncChange {
  /** Keys from the entry down (`config`, `review`, `at`); a bundle's name; empty for the bundles' order. */
  path: string[]
  local?: string
  remote?: string
}

export interface SyncChangeGroup {
  /** A profile entry (cordis.patch.yml), the enabled plugins, the plugins' package specs, or a collection (its file: the pinned clipboard texts, the reader's feeds or favorites). */
  kind: 'entry' | 'bundles' | 'dependencies' | 'collection'
  id: string
  /** The whole entry exists on one side only. */
  only?: 'local' | 'remote'
  changes: SyncChange[]
}

/** A setting both machines changed since they last agreed, to different values. */
export interface SyncConflict {
  /** Names the setting in `choices`. */
  key: string
  kind: SyncChangeGroup['kind']
  /** The profile entry; `plugins.json` for the plugin selection. */
  id: string
  /** Keys from the entry down; `[id]` names an item of a list of objects; empty for the plugins' order. */
  path: string[]
  /** Absent: that side removed it. */
  local?: string
  remote?: string
  /** The key 不参与同步 lists it under, when it can be listed. */
  setting?: string
  /** The side chosen, sent back with the next sync. */
  choice?: 'local' | 'remote'
}

/** What the last sync, pull, restore or overwrite did here. */
export interface SyncOutcome {
  /** `overwriteRemote`: this machine's settings replaced the remote's; `overwriteLocal`: the reverse. */
  kind: 'sync' | 'pull' | 'restore' | 'overwriteRemote' | 'overwriteLocal'
  at: string
  /** Started by DSH at startup rather than by the person. */
  auto?: boolean
  /** What changed on this machine (`local` before, `remote` the new value). */
  applied: SyncChangeGroup[]
  /** Settings of this machine the remote took. */
  pushed: number
  /** The version holding this machine's settings before, to go back to. */
  undo?: string
  /** What did not take effect here (an install failed, a plugin is missing). */
  unapplied: SyncChangeGroup[]
  /** Part of it takes effect only once DSH restarts. */
  restart: boolean
  /** Plugin upgrades waiting for the restart. */
  scheduled: string[]
}

export interface SyncStatus {
  /** A remote is set (设置 → 同步与更新). */
  configured: boolean
  /** The host gives the profile's location; without it nothing can be read or written. */
  available: boolean
  remote: string
  branch: string
  /** The repository has a version. */
  head?: string
  fetchedAt?: string
  /** A sync, pull, restore or overwrite is running; the page follows it by reading the status. */
  busy: SyncOutcome['kind'] | null
  /** As of the last fetch: remote settings to take here, and settings of this machine to push. */
  incoming: number
  outgoing: number
  /** As of the last fetch: settings both machines changed differently, counted in neither of the above. */
  conflicting?: number
  /** The remote has no settings yet: the next sync pushes the first version. */
  remoteEmpty: boolean
  /** Settings both machines changed: the next sync needs a choice for each. */
  conflicts?: { remote: string | null; items: SyncConflict[] }
  last?: SyncOutcome
  /** The plugin manager is missing: plugins are reported, not switched. */
  pluginsReadOnly: boolean
  /** The last operation's failure. */
  error?: string
  /** The install a running sync is doing, or the last one. */
  progress?: SyncProgress
}

export interface SyncVersion {
  commit: string
  date: string
  author: string
  subject: string
}

export interface SyncLog {
  versions: SyncVersion[]
}

/** A setting inside a profile entry, by its path from the entry (`config`, `review`, `auto`). */
export interface SyncSetting {
  path: string[]
  /** A setting with no settings under it on offer: its value, shortened. */
  value?: string
  settings?: SyncSetting[]
}

export interface SyncCatalogEntry {
  /** The profile entry id (cordis.patch.yml). */
  id: string
  /** The plugin's package, when the entry names one. */
  name?: string
  /** The entry exists only in the remote's settings. */
  only?: 'remote'
  settings: SyncSetting[]
}

export interface SyncCatalog {
  entries: SyncCatalogEntry[]
}
