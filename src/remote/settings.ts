/**
 * 设置 → Agent Hub on a phone. DSH serves its configuration forms only to a
 * page opened on the machine itself (a loopback address), so a phone's page
 * gets none. With `remote.phoneSettings` on, which only the computer can
 * switch, this method reads and writes the plugin's own entry instead, through
 * the same settings service and revision fence the desktop form uses.
 *
 * What the phone may touch is decided here, on the host: sections whose values
 * may carry credentials or govern phone access itself never reach it, and the
 * settings that loosen what models may do stay read-only there.
 */

export const PHONE_SETTINGS_METHOD = 'agent-hub/phone-settings'

/** The plugin's profile entry id: its namespace in DSH's settings service. */
const NAMESPACE = 'agent-hub'

/** Never sent to a phone: a git remote or an MCP endpoint may embed a token, and `remote` holds this very switch. */
export const PHONE_HIDDEN: readonly string[] = ['remote', 'sync', 'connectors', 'automation', 'palette']

/** Shown on a phone but changed on the computer only (`section.key`). */
export const PHONE_READONLY: readonly string[] = ['modules.palette', 'modules.device', 'claude.fullAccess', 'prompt.blockedScans', 'prompt.blockedCommands', 'qoder.workspaces']

/** Keys a path step may never be, whatever the settings service would make of them. */
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])

export type Doc = Record<string, Record<string, unknown>>

export type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

export type PhoneSettingsRequest = { op: 'read' } | { op: 'mutate'; ops: SettingsOp[]; revision: number }

/** The entry as a phone sees it, or `enabled: false` while the computer keeps it closed. */
export type PhoneSettingsView =
  | { enabled: false }
  | { enabled: true; writable: boolean; revision: number; value: Doc; base: Doc; user: Doc }

export interface PhoneSettingsReply {
  view: PhoneSettingsView
  /** For a mutation: whether it was stored. False when the switch is off or another writer came first. */
  landed?: boolean
}

/** The slice of DSH's settings service (`ctx.settings`) used here. */
export interface SettingsService {
  readonly writable: boolean
  describe(options: { redactSecrets: boolean }): Array<{ ns: string; value?: unknown; base?: unknown; user?: unknown; revision: number }>
  mutate(ns: string, ops: SettingsOp[], expectedRevision?: number): Promise<unknown>
}

export interface PhoneSettingsOptions {
  /** `remote.phoneSettings`, read on every request so turning it off closes the next one. */
  enabled: () => boolean
  settings: () => SettingsService | undefined
}

/** A field id (`section.key`) a phone may change. */
export const phoneWritable = (id: string): boolean => !PHONE_HIDDEN.includes(id.split('.', 1)[0]!) && !PHONE_READONLY.includes(id)

const visible = (doc: unknown): Doc => {
  if (typeof doc !== 'object' || doc === null) return {}
  return Object.fromEntries(Object.entries(doc).filter(([section]) => !PHONE_HIDDEN.includes(section))) as Doc
}

/** One field-level edit inside a section the entry has, of a field a phone may change. */
function allowed(op: unknown, sections: Doc): op is SettingsOp {
  if (typeof op !== 'object' || op === null) return false
  const { op: kind, path } = op as { op?: unknown; path?: unknown }
  if (kind !== 'set' && kind !== 'unset') return false
  if (kind === 'set' && !Object.hasOwn(op, 'value')) return false
  if (!Array.isArray(path) || path.length < 2 || !path.every((step) => typeof step === 'string' && step !== '' && !UNSAFE.has(step))) return false
  return Object.hasOwn(sections, path[0]) && phoneWritable(`${path[0]}.${path[1]}`)
}

const conflict = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'

export function createPhoneSettings(options: PhoneSettingsOptions): (request: PhoneSettingsRequest) => Promise<PhoneSettingsReply> {
  const view = (): PhoneSettingsView => {
    const settings = options.enabled() ? options.settings() : undefined
    const entry = settings?.describe({ redactSecrets: true }).find((candidate) => candidate.ns === NAMESPACE)
    if (settings === undefined || entry === undefined) return { enabled: false }
    return { enabled: true, writable: settings.writable, revision: entry.revision, value: visible(entry.value), base: visible(entry.base), user: visible(entry.user) }
  }
  return async (request) => {
    if (request?.op !== 'mutate') return { view: view() }
    const before = view()
    if (!before.enabled || !before.writable) return { view: before, landed: false }
    const ops = Array.isArray(request.ops) ? request.ops : []
    if (ops.length === 0 || !ops.every((op) => allowed(op, before.value))) throw new Error('this setting can only be changed on the computer running DSH')
    // Always fenced: a phone writes over what it last read, never blindly.
    if (typeof request.revision !== 'number') throw new Error('a phone write needs the revision it read')
    try {
      await options.settings()!.mutate(NAMESPACE, ops, request.revision)
    } catch (error) {
      // Another writer came first: answer with what is stored now, so the form shows it.
      if (conflict(error)) return { view: view(), landed: false }
      throw error
    }
    return { view: view(), landed: true }
  }
}
