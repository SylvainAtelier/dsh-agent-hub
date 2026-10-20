/**
 * The form behind 设置 → Agent Hub. It reads the plugin's profile entry
 * through DSH's shared configuration form (`configForms.get('agent-hub')`) and
 * saves edits as they happen: a pick (switch, model, reset) at once, typing
 * once it pauses or the field loses focus. Each save is one revision-fenced
 * mutation of every valid staged field; an invalid one stays on screen,
 * unsaved, until it is fixed. A field shows its effective value and whether
 * the profile overrides it; a reset unsets the override so the default below
 * it applies again.
 */

import { PROFILE_ID, type AgentProfile } from '../../team/profiles.ts'
import { CONNECTOR_ID, validServerUrl, type ConnectorEntry } from '../../connectors/types.ts'
import { MAX_UI_SCALE, MIN_UI_SCALE } from '../../appearance.ts'
import { identitiesValid } from '../../git/identity.ts'

/** The plugin's profile entry id (cordis.patch.yml); DSH's settings service addresses the Config by it. */
export const ENTRY_ID = 'agent-hub'

/** The fields of one section of the host's Config (src/config.ts). */
export type Section = 'modules' | 'discussion' | 'prompt' | 'connectors' | 'claude' | 'codex' | 'cursor' | 'qoder' | 'hermes' | 'models' | 'appearance' | 'remote' | 'device' | 'palette' | 'git' | 'team' | 'sync' | 'review' | 'alerts' | 'board' | 'automation'

/**
 * `route`: a model picked from DSH's catalog, written with its provider (the field named by `provider`).
 * `agents`: the list of agent profiles, edited and stored as one value.
 * `connectors`: the connected remote MCP servers, likewise.
 * `font`: one of the fonts on offer (appearance.ts).
 * `uiScale`: the interface text scale in percent, edited together with `scaleRegions` (per-region offsets).
 * `choice`: one of `options`.
 */
export type FieldKind = 'switch' | 'integer' | 'number' | 'text' | 'textarea' | 'route' | 'agents' | 'identities' | 'agentModels' | 'providers' | 'connectors' | 'effort' | 'efforts' | 'blockedScans' | 'blockedCommands' | 'syncExclude' | 'reviewRepos' | 'bot' | 'hotkey' | 'font' | 'uiScale' | 'scaleRegions' | 'choice'

export interface FieldSpec {
  section: Section
  key: string
  kind: FieldKind
  min?: number
  max?: number
  /** Edited through another field's control rather than a row of its own. */
  hidden?: boolean
  /** For a `route` field: the sibling field holding its provider. */
  provider?: string
  /** For a `textarea` field: its height in lines, and whether it holds Markdown (shown monospaced). */
  rows?: number
  markdown?: boolean
  /** Bound to this machine (local paths): left out of exported settings, and untouched by an import. */
  local?: boolean
  /** For a `bot` field: blank is a choice of its own (no bot), offered first. */
  optional?: boolean
  /** For a `choice` field: the values on offer, labelled `<id>.<value>` (blank: `<id>.default`). */
  options?: readonly string[]
  /** Shown only while another field (`section.key`) holds this value. */
  shownWhen?: { field: string; value: unknown }
  /** The group of the page it shows in, when not its own section's (the stored key stays the same). */
  group?: Section
}

/** Every configurable option, grouped by module in display order. */
export const FIELDS: readonly FieldSpec[] = [
  // The 功能模块 card's switches (modules.tsx), above the groups.
  { section: 'modules', key: 'reader', kind: 'switch', hidden: true },
  { section: 'modules', key: 'relay', kind: 'switch', hidden: true },
  { section: 'modules', key: 'palette', kind: 'switch', hidden: true, local: true },
  { section: 'modules', key: 'device', kind: 'switch', hidden: true, local: true },
  { section: 'modules', key: 'codex', kind: 'switch', hidden: true },
  { section: 'prompt', key: 'instructions', kind: 'textarea', rows: 10, markdown: true },
  { section: 'prompt', key: 'canvas', kind: 'switch' },
  { section: 'prompt', key: 'archify', kind: 'switch', shownWhen: { field: 'prompt.canvas', value: true } },
  { section: 'discussion', key: 'enabled', kind: 'switch', group: 'prompt' },
  { section: 'discussion', key: 'provider', kind: 'text', hidden: true, group: 'prompt' },
  { section: 'discussion', key: 'model', kind: 'route', provider: 'discussion.provider', group: 'prompt' },
  { section: 'prompt', key: 'blockedScans', kind: 'blockedScans' },
  { section: 'prompt', key: 'blockedCommands', kind: 'blockedCommands' },
  { section: 'connectors', key: 'servers', kind: 'connectors' },
  { section: 'claude', key: 'remoteControl', kind: 'switch' },
  { section: 'claude', key: 'fullAccess', kind: 'switch' },
  { section: 'claude', key: 'keepOnline', kind: 'integer', min: 0, max: 50 },
  { section: 'claude', key: 'idleHours', kind: 'number', min: 0.25, max: 168 },
  { section: 'claude', key: 'helperProvider', kind: 'text', hidden: true },
  { section: 'claude', key: 'helperModel', kind: 'route', provider: 'claude.helperProvider' },
  { section: 'qoder', key: 'workspaces', kind: 'reviewRepos', local: true },
  { section: 'qoder', key: 'idleMinutes', kind: 'integer', min: 0, max: 1440 },
  { section: 'qoder', key: 'autoStart', kind: 'switch' },
  { section: 'models', key: 'hiddenProviders', kind: 'providers' },
  { section: 'models', key: 'effort', kind: 'effort' },
  { section: 'models', key: 'efforts', kind: 'efforts' },
  { section: 'claude', key: 'models', kind: 'agentModels', group: 'models' },
  { section: 'codex', key: 'models', kind: 'agentModels', group: 'models' },
  { section: 'cursor', key: 'models', kind: 'agentModels', group: 'models' },
  { section: 'qoder', key: 'models', kind: 'agentModels', group: 'models' },
  { section: 'hermes', key: 'models', kind: 'agentModels', group: 'models' },
  { section: 'appearance', key: 'uiFont', kind: 'font' },
  { section: 'appearance', key: 'codeFont', kind: 'font' },
  { section: 'appearance', key: 'uiScale', kind: 'uiScale', min: MIN_UI_SCALE, max: MAX_UI_SCALE },
  { section: 'appearance', key: 'regions', kind: 'scaleRegions', hidden: true },
  { section: 'remote', key: 'httpsPort', kind: 'integer', min: 1, max: 65535 },
  { section: 'remote', key: 'http', kind: 'switch' },
  { section: 'remote', key: 'phoneSettings', kind: 'switch', local: true },
  { section: 'device', key: 'approve', kind: 'switch' },
  { section: 'device', key: 'stt', kind: 'choice', options: ['minimax', 'openai'] },
  { section: 'device', key: 'sttUrl', kind: 'text', shownWhen: { field: 'device.stt', value: 'openai' } },
  { section: 'device', key: 'sttModel', kind: 'text', shownWhen: { field: 'device.stt', value: 'openai' } },
  { section: 'device', key: 'language', kind: 'choice', options: ['', 'zh', 'en'] },
  { section: 'device', key: 'hints', kind: 'switch' },
  { section: 'device', key: 'typing', kind: 'choice', options: ['auto', 'unicode', 'paste'] },
  { section: 'device', key: 'port', kind: 'integer', min: 1, max: 65535, local: true },
  { section: 'palette', key: 'hotkey', kind: 'hotkey', local: true },
  { section: 'palette', key: 'keep', kind: 'integer', min: 50, max: 5000 },
  { section: 'palette', key: 'ignore', kind: 'text', local: true },
  { section: 'palette', key: 'bot', kind: 'bot', optional: true },
  { section: 'git', key: 'strict', kind: 'switch' },
  { section: 'git', key: 'identities', kind: 'identities' },
  { section: 'git', key: 'provider', kind: 'text', hidden: true },
  { section: 'git', key: 'model', kind: 'route', provider: 'git.provider' },
  { section: 'git', key: 'instructions', kind: 'textarea' },
  { section: 'team', key: 'agents', kind: 'agents' },
  { section: 'sync', key: 'remote', kind: 'text' },
  { section: 'sync', key: 'branch', kind: 'text' },
  { section: 'sync', key: 'fetchOnStart', kind: 'switch' },
  { section: 'sync', key: 'localSettings', kind: 'syncExclude' },
  { section: 'sync', key: 'platformEntries', kind: 'syncExclude', hidden: true },
  { section: 'review', key: 'repos', kind: 'reviewRepos', local: true },
  { section: 'review', key: 'auto', kind: 'switch', hidden: true },
  { section: 'review', key: 'at', kind: 'text', hidden: true },
  { section: 'review', key: 'bot', kind: 'bot' },
  { section: 'review', key: 'commentBot', kind: 'bot', optional: true },
  { section: 'review', key: 'helperProvider', kind: 'text', hidden: true },
  { section: 'review', key: 'helperModel', kind: 'route', provider: 'review.helperProvider' },
  { section: 'review', key: 'style', kind: 'textarea', rows: 5, markdown: true },
  { section: 'review', key: 'rules', kind: 'textarea', rows: 4, markdown: true },
  { section: 'review', key: 'explain', kind: 'textarea', rows: 6, markdown: true },
  { section: 'review', key: 'explainBot', kind: 'bot', optional: true },
  { section: 'review', key: 'maxPerRun', kind: 'integer', min: 1, max: 50 },
  { section: 'review', key: 'keepMerged', kind: 'integer', min: 0, max: 30 },
  { section: 'alerts', key: 'url', kind: 'text', group: 'board' },
  { section: 'alerts', key: 'repo', kind: 'text', local: true, group: 'board' },
  { section: 'alerts', key: 'bot', kind: 'bot', group: 'board' },
  { section: 'board', key: 'ticketBot', kind: 'bot', optional: true },
]

/** The group of the page a field shows in. */
export const groupOf = (spec: FieldSpec): Section => spec.group ?? spec.section

/**
 * 设置 → Agent Hub's groups, under their headings, in display order. Sync is not among them:
 * it has its page of its own, 设置 → 同步与更新, beside the plugin updates.
 */
export const CATEGORIES: ReadonlyArray<{ id: 'agents' | 'work' | 'chat' | 'access'; groups: readonly Section[] }> = [
  { id: 'agents', groups: ['claude', 'qoder', 'models', 'team'] },
  { id: 'work', groups: ['connectors', 'review', 'automation', 'board', 'git'] },
  { id: 'chat', groups: ['prompt', 'appearance'] },
  { id: 'access', groups: ['remote', 'device', 'palette'] },
]

export const SECTIONS: readonly Section[] = CATEGORIES.flatMap((category) => category.groups)

/** The group that shows a section's fields, for a request to reveal a section that has none of its own now. */
export const GROUP_OF: Partial<Record<Section, Section>> = { discussion: 'prompt', codex: 'models', cursor: 'models', hermes: 'models', alerts: 'board' }

/** Profiles a save may store: every id well-formed and used once. */
export function profilesValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const ids = (value as AgentProfile[]).map((profile) => profile?.id)
  return ids.every((id) => typeof id === 'string' && PROFILE_ID.test(id)) && new Set(ids).size === ids.length
}

/** Connectors a save may store: well-formed ids, each used once, and remote MCP URLs. */
export function connectorsValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const list = value as ConnectorEntry[]
  const ids = list.map((entry) => entry?.id)
  return list.every((entry) => typeof entry?.id === 'string' && CONNECTOR_ID.test(entry.id) && typeof entry.url === 'string' && validServerUrl(entry.url)
    && (entry.repos === undefined || (Array.isArray(entry.repos) && entry.repos.every((repo) => typeof repo === 'string' && repo !== '')))
    && (entry.clientId === undefined || typeof entry.clientId === 'string'))
    && new Set(ids).size === ids.length
}

/** Lists compare by content: an edit that ends where it started is not a change. */
const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b))

export const fieldId = (spec: FieldSpec): string => `${spec.section}.${spec.key}`

export type Doc = Partial<Record<Section, Record<string, unknown>>>

/** The slice of DSH's shared configuration form (ui-settings `ConfigForm`) this page uses. */
export interface ConfigScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    /** Effective values: the profile override over the composition over the schema defaults. */
    value?: Doc
    /** What applies without the profile override. */
    base?: Doc
    /** The profile override itself. */
    user?: Doc
    revision?: number
    writable: boolean
    /** Served to a phone (phone.ts): `locked` until the computer allows it. Absent on DSH's own form. */
    phone?: 'open' | 'locked'
  }
  subscribe(listener: () => void): () => void
  mutate(ops: Op[], expectedRevision?: number): Promise<boolean>
  /** Read again; DSH's own form keeps itself current and has none. */
  refresh?(): Promise<void>
}

export type Op = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** A staged edit: a value to store, or a reset back to the default. */
type Draft = { value: unknown } | { reset: true }

export interface FieldState {
  value: unknown
  /** The text in the control while a numeric draft is not yet a number. */
  text?: string
  /** Saving would leave a profile override. */
  overridden: boolean
  /** What a reset would fall back to. */
  fallback: unknown
  invalid: boolean
  dirty: boolean
}

export interface FormState {
  available: boolean
  loading: boolean
  /** Edited from a phone: some sections are left out there and some fields are read-only (remote/settings.ts). */
  phone: 'open' | 'locked' | undefined
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  /** The last save outcome, until the next edit. */
  outcome: 'saved' | 'failed' | null
  fields: Record<string, FieldState>
}

const read = (doc: Doc | undefined, spec: FieldSpec): unknown => doc?.[spec.section]?.[spec.key]
const has = (doc: Doc | undefined, spec: FieldSpec): boolean => {
  const section = doc?.[spec.section]
  return section !== undefined && section !== null && Object.hasOwn(section, spec.key)
}

/** Parse what was typed into a numeric field; undefined when it is not an acceptable number. */
export function parseNumber(spec: FieldSpec, text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return undefined
  if (spec.kind === 'integer' && !Number.isInteger(value)) return undefined
  if (spec.min !== undefined && value < spec.min) return undefined
  if (spec.max !== undefined && value > spec.max) return undefined
  return value
}

/** How long typing pauses before it is saved. */
export const AUTOSAVE_DELAY = 600

export class ConfigFormModel {
  private drafts = new Map<string, Draft & { text?: string }>()
  private listeners = new Set<() => void>()
  private saving = false
  private outcome: FormState['outcome'] = null
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The save in flight; saves run one after another. */
  private queue: Promise<void> = Promise.resolve()
  private snapshot: FormState
  private unsubscribe: () => void
  private scope: ConfigScope

  constructor(scope: ConfigScope) {
    this.scope = scope
    this.snapshot = this.project()
    this.unsubscribe = scope.subscribe(() => this.publish())
  }

  getSnapshot = (): FormState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Stage a value and save it: typed fields once typing pauses, picks at once.
   * Numeric fields take the raw text, so a half-typed number stays on screen.
   */
  edit(id: string, value: unknown): void {
    const spec = this.spec(id)
    if (spec.kind === 'integer' || spec.kind === 'number') {
      const text = String(value)
      const parsed = parseNumber(spec, text)
      this.stage(id, { value: parsed, text }, AUTOSAVE_DELAY)
    } else if (spec.kind === 'text' || spec.kind === 'textarea') {
      const text = String(value)
      // An emptied text field means "use the default", the same as a reset.
      this.stage(id, text.trim() === '' ? { reset: true, text } : { value: spec.kind === 'text' ? text.trim() : text, text }, AUTOSAVE_DELAY)
    } else if (spec.kind === 'effort' && value === '') {
      // "Each model's own default" is the unset value.
      this.stage(id, { reset: true }, 0)
    } else {
      // The profile list is typed into (names, personas), so it waits for a pause too.
      this.stage(id, { value }, spec.kind === 'agents' ? AUTOSAVE_DELAY : 0)
    }
  }

  /** Pick a catalog model for a `route` field, or undefined for the default; provider and model move together. */
  editRoute(id: string, route: { provider: string; model: string } | undefined): void {
    const providerId = this.spec(id).provider!
    if (route === undefined) {
      this.drafts.set(providerId, { reset: true })
      this.stage(id, { reset: true }, 0)
    } else {
      this.drafts.set(providerId, { value: route.provider })
      this.stage(id, { value: route.model }, 0)
    }
  }

  reset(id: string): void {
    const spec = this.spec(id)
    if (spec.kind === 'route') return this.editRoute(id, undefined)
    this.stage(id, { reset: true }, 0)
  }

  /** Drop every unsaved edit, invalid ones included. */
  discard(): void {
    this.cancel()
    if (this.drafts.size === 0 && this.outcome === null) return
    this.drafts.clear()
    this.outcome = null
    this.publish()
  }

  /**
   * Save what is staged now instead of waiting for typing to pause, then let
   * the controls show what is stored. A field leaving focus calls this.
   */
  async flush(): Promise<void> {
    await this.save()
    let settled = false
    for (const [id, draft] of this.drafts) {
      if (!this.pending(id, draft)) {
        this.drafts.delete(id)
        settled = true
      }
    }
    if (settled) this.publish()
  }

  /** Leaving a visit only clears the drafts it owned, never edits from a later visit. */
  async leave(): Promise<void> {
    const leaving = new Map(this.drafts)
    await this.save()
    let changed = false
    for (const [id, draft] of leaving) {
      if (this.drafts.get(id) === draft) {
        this.drafts.delete(id)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  /** Write every valid staged field that differs from what is stored, after any save in flight. */
  save(): Promise<void> {
    this.cancel()
    this.queue = this.queue.then(() => this.write())
    return this.queue
  }

  /** What the profile overrides, once every pending edit is saved: what an export writes. */
  async overrides(): Promise<Doc> {
    await this.save()
    return this.scope.getSnapshot().user ?? {}
  }

  /**
   * Replace stored values in one revision-fenced mutation (an import). Unsaved
   * edits are dropped first, so they cannot overwrite what was imported.
   */
  apply(ops: Op[]): Promise<boolean> {
    this.discard()
    let landed = false
    this.queue = this.queue.then(async () => {
      const snapshot = this.scope.getSnapshot()
      if (!snapshot.writable) return
      if (ops.length === 0) {
        landed = true
        return
      }
      this.saving = true
      this.publish()
      try {
        landed = await this.scope.mutate(ops, snapshot.revision)
      } catch {
        landed = false
      }
      this.saving = false
      this.outcome = landed ? 'saved' : 'failed'
      this.publish()
    })
    return this.queue.then(() => landed)
  }

  /** Read the stored values again where the scope does not keep itself current (a phone's). */
  refresh(): Promise<void> {
    return this.scope.refresh?.() ?? Promise.resolve()
  }

  dispose(): void {
    this.cancel()
    this.unsubscribe()
    this.listeners.clear()
  }

  /** The writes a save would make, one per valid staged field that differs from what is stored. */
  plan(): Op[] {
    const ops: Op[] = []
    for (const [id, draft] of this.drafts) {
      const op = this.op(id, draft)
      if (op !== undefined) ops.push(op)
    }
    return ops
  }

  private async write(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    if (!snapshot.writable) return
    const sent = new Map(this.drafts)
    const ops = this.plan()
    if (ops.length === 0) return
    this.saving = true
    this.publish()
    let landed = false
    try {
      landed = await this.scope.mutate(ops, snapshot.revision)
    } catch {
      landed = false
    }
    this.saving = false
    this.outcome = landed ? 'saved' : 'failed'
    if (landed) {
      for (const [id, draft] of sent) {
        // An edit made while this save was in flight stays for the next one. Typed text stays
        // as typed (a trailing space, "1." on the way to "1.5") until the field loses focus.
        if (this.drafts.get(id) === draft && draft.text === undefined && !this.pending(id, draft)) this.drafts.delete(id)
      }
    }
    this.publish()
  }

  /** Whether a draft still has something to say: a write to make, or an invalid value to show. */
  private pending(id: string, draft: Draft): boolean {
    return this.op(id, draft) !== undefined || this.invalid(this.spec(id), draft)
  }

  private op(id: string, draft: Draft): Op | undefined {
    const { user, value } = this.scope.getSnapshot()
    const spec = this.spec(id)
    const path = [spec.section, spec.key]
    if ('reset' in draft) return has(user, spec) ? { op: 'unset', path } : undefined
    if (this.invalid(spec, draft) || same(draft.value, read(value, spec))) return undefined
    return { op: 'set', path, value: draft.value }
  }

  private invalid(spec: FieldSpec, draft: Draft): boolean {
    return !('reset' in draft) && (draft.value === undefined || (spec.kind === 'agents' && !profilesValid(draft.value)) || (spec.kind === 'connectors' && !connectorsValid(draft.value))
      || (spec.kind === 'identities' && !identitiesValid(draft.value)))
  }

  private stage(id: string, draft: Draft & { text?: string }, delay: number): void {
    this.drafts.set(id, draft)
    this.outcome = null
    this.publish()
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.save()
    }, delay)
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private spec(id: string): FieldSpec {
    const spec = FIELDS.find((candidate) => fieldId(candidate) === id)
    if (spec === undefined) throw new Error(`unknown config field ${id}`)
    return spec
  }

  private project(): FormState {
    const snapshot = this.scope.getSnapshot()
    const fields: Record<string, FieldState> = {}
    for (const spec of FIELDS) {
      const id = fieldId(spec)
      const stored = read(snapshot.value, spec)
      const fallback = read(snapshot.base, spec)
      const draft = this.drafts.get(id)
      if (draft === undefined) {
        fields[id] = { value: stored, overridden: has(snapshot.user, spec), fallback, invalid: false, dirty: false }
      } else if ('reset' in draft) {
        fields[id] = { value: fallback, ...(draft.text === undefined ? {} : { text: draft.text }), overridden: false, fallback, invalid: false, dirty: true }
      } else {
        fields[id] = {
          value: draft.value,
          ...(draft.text === undefined ? {} : { text: draft.text }),
          overridden: true,
          fallback,
          invalid: this.invalid(spec, draft),
          dirty: true,
        }
      }
    }
    const values = Object.values(fields)
    return {
      available: snapshot.status === 'ready',
      loading: snapshot.status === 'loading',
      phone: snapshot.phone,
      writable: snapshot.writable,
      dirty: this.plan().length > 0 || values.some((field) => field.invalid),
      invalid: values.some((field) => field.invalid),
      saving: this.saving,
      outcome: this.outcome,
      fields,
    }
  }

  private publish(): void {
    this.snapshot = this.project()
    for (const listener of this.listeners) listener()
  }
}
