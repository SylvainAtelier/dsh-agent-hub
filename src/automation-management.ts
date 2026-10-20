/** Explicit local authorization for reusable script definitions; no schedule or runner of its own. */
import { validateScriptTask } from './automation/runner.ts'
import type { AutomationReply, ScriptTask } from './automation/types.ts'
import type { SettingsService } from './remote/settings.ts'

export interface AutomationManagementHost {
  service: {
    handle(payload: Record<string, unknown>): Promise<AutomationReply>
    withDefinitionMutation<T>(id: string, work: () => Promise<T>): Promise<T>
  }
  definitions(): readonly ScriptTask[]
  save(definitions: ScriptTask[], expected: readonly ScriptTask[]): Promise<void>
  validateRoute(definition: ScriptTask): Promise<unknown>
  preset(): ScriptTask
  /** Whether `preset` can work on this machine; the page offers it only then. */
  presetAvailable(): boolean
}

const loopback = (hostname: string): boolean => {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a request reached DSH from this machine. DSH's HTTP bridge rebuilds every
 * request on a fixed `http://dsh.internal` base, so the authority lives only in the
 * Host header (already fenced by DSH to loopback or configured names). The desktop
 * shell forwards to 127.0.0.1; the tailnet proxy rewrites Host but adds the remote marker.
 */
export function isLocalRequest(request: Request): boolean {
  if (request.headers.has('x-dsh-agent-hub-remote')) return false
  const host = request.headers.get('host')
  try { return loopback(new URL(host ? `http://${host}` : request.url).hostname.toLowerCase()) } catch { return false }
}

/** Local always; a remote (tailnet phone) page only while the computer-only `remote.phoneSettings` switch is on. */
export function requireAutomationLocal(request: Request, allowRemote = false): void {
  if (!allowRemote && !isLocalRequest(request)) throw new Error('Script tasks can only be managed on the computer running DSH, or from a phone once "Allow changing settings from a phone" is on')
}

function sameDefinition(value: unknown, current: ScriptTask): boolean {
  try { return JSON.stringify(validateScriptTask(value)) === JSON.stringify(validateScriptTask(current)) } catch { return false }
}

/** Fence the entire array after route validation, then let the host CAS guard the actual write. */
export async function saveAutomationDefinitions(settings: SettingsService | undefined, definitions: ScriptTask[], expected: readonly ScriptTask[]): Promise<void> {
  const entry = settings?.describe({ redactSecrets: true }).find((item) => item.ns === 'agent-hub')
  if (!settings?.writable || !entry) throw new Error('Script task settings are read-only')
  const current = (entry.value as { automation?: { tasks?: unknown } } | undefined)?.automation?.tasks ?? []
  const normalized = (value: unknown): string => {
    if (!Array.isArray(value)) throw new Error('Invalid script task settings')
    return JSON.stringify(value.map(validateScriptTask))
  }
  if (normalized(current) !== normalized(expected)) throw new Error('Script task settings changed. Refresh before saving again.')
  await settings.mutate('agent-hub', [{ op: 'set', path: ['automation', 'tasks'], value: definitions }], entry.revision)
}

/** Mutations are explicit, revision-fenced against the definition the editor actually saw. */
export function automationManagement(host: AutomationManagementHost): (payload: Record<string, unknown>) => Promise<AutomationReply> {
  return async (payload) => {
    const available = (reply: AutomationReply): AutomationReply => ({ ...reply, presetAvailable: host.presetAvailable() })
    if (payload.action === 'preset') return { ...available(await host.service.handle({ action: 'list' })), preset: host.preset() }
    if (payload.action !== 'upsert' && payload.action !== 'remove') return available(await host.service.handle(payload))
    const definition = payload.action === 'upsert' ? validateScriptTask(payload.definition) : undefined
    const id = definition?.id ?? payload.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(id)) throw new Error('Invalid automation id')
    await host.service.withDefinitionMutation(id, async () => {
      const definitions = [...host.definitions()]
      const current = definitions.find((item) => item.id === id)
      if (current ? !sameDefinition(payload.expected, current) : payload.expected !== null) throw new Error('The script definition changed. Refresh before saving again.')
      if (definition) {
        await host.validateRoute(definition)
        const next = current ? definitions.map((item) => item.id === id ? definition : item) : [...definitions, definition]
        if (next.length > 100) throw new Error('At most 100 script tasks may be configured')
        await host.save(next, definitions)
      } else {
        if (!current) throw new Error('The script task no longer exists')
        await host.save(definitions.filter((item) => item.id !== id), definitions)
      }
    })
    return available(await host.service.handle({ action: 'list' }))
  }
}
