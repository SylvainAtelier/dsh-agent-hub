/**
 * 设置 → Agent Hub groups fold to one line each: the group's name and a
 * summary of where it stands, so the whole page reads at a glance and opens
 * only where something is to be changed. Which groups are open is remembered
 * per browser; a group that needs attention (a sign-in expired, a value is
 * invalid) opens by itself.
 */

import { DEFAULT_UI_SCALE, FONTS, regionsOf, type FontId } from '../../appearance.ts'
import { connectorName, type ConnectorEntry, type ConnectorPhase } from '../../connectors/types.ts'
import type { DeviceStatus } from '../../device/types.ts'
import type { PaletteStatus } from '../../palette/types.ts'
import { NO_MODELS } from '../../visibility.ts'
import { FIELDS, GROUP_OF, fieldId, groupOf, type FieldState, type Section } from './form.ts'
import { t } from './i18n.ts'

const OPEN_KEY = 'dsh-agent-hub.config.open.v1'
/** A one-shot request (another surface asked for a group): opened on the page's next mount. */
const REVEAL_KEY = 'dsh-agent-hub.config.reveal'
export const REVEAL_EVENT = 'dsh-agent-hub:config-reveal'

export function readOpen(): Set<Section> {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((item): item is Section => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeOpen(open: ReadonlySet<Section>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]))
  } catch {
    // Not remembered: the page opens folded next time.
  }
}

/** Ask the settings page to open (and scroll to) one group, now if it is mounted, else when it next mounts. */
export function revealSection(requested: Section): void {
  const section = GROUP_OF[requested] ?? requested
  try {
    sessionStorage.setItem(REVEAL_KEY, section)
  } catch {
    // The live event below still reaches a mounted page.
  }
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: section }))
}

export function takeReveal(): Section | undefined {
  try {
    const value = sessionStorage.getItem(REVEAL_KEY)
    sessionStorage.removeItem(REVEAL_KEY)
    return (value ?? undefined) as Section | undefined
  } catch {
    return undefined
  }
}

export interface Summary {
  text: string
  /** Something here wants a look: the group opens by itself and its header says so. */
  attention: boolean
}

type Fields = Record<string, FieldState>

const value = (fields: Fields, id: string): unknown => fields[id]?.value
const list = (fields: Fields, id: string): unknown[] => (Array.isArray(value(fields, id)) ? value(fields, id) as unknown[] : [])
/** A field shown in this group holds a value that cannot be saved. */
const invalid = (fields: Fields, group: Section): boolean =>
  FIELDS.some((spec) => groupOf(spec) === group && fields[fieldId(spec)]?.invalid === true)

const PHASE_KEY: Record<ConnectorPhase['phase'], Parameters<typeof t>[0]> = {
  connected: 'sum.conn.connected',
  connecting: 'sum.conn.connecting',
  authorizing: 'sum.conn.connecting',
  disconnected: 'sum.conn.disconnected',
  token: 'sum.conn.disconnected',
  client: 'sum.conn.disconnected',
  expired: 'sum.conn.expired',
  error: 'sum.conn.error',
}

/** One line per group, from the values the form holds now (and, for sync, the repository's state). */
/** An enabled model list in a few words: empty is every model, {@link NO_MODELS} alone is none. */
function modelCount(ids: unknown[]): string {
  const models = ids.filter((id) => id !== NO_MODELS).length
  if (models > 0) return t('sum.claude.models', { n: models })
  return ids.length === 0 ? t('sum.claude.allModels') : t('sum.claude.noModels')
}

export function summarize(section: Section, fields: Fields, connectorState: (id: string) => ConnectorPhase | undefined, device?: DeviceStatus, palette?: PaletteStatus): Summary {
  switch (section) {
    case 'automation': return { text: t('automation.summary'), attention: false }
    case 'prompt': {
      const text = value(fields, 'prompt.instructions')
      const lines = typeof text === 'string' ? text.split('\n').map((line) => line.trim()).filter(Boolean) : []
      const first = lines[0]?.replace(/^#+\s*|^[-*]\s+/, '') ?? ''
      const blocked = list(fields, 'prompt.blockedScans').length + list(fields, 'prompt.blockedCommands').length
      const parts = [
        lines.length === 0 ? t('sum.prompt.none') : t('sum.prompt', { n: lines.length, first: first.length > 40 ? `${first.slice(0, 40)}…` : first }),
        ...(blocked === 0 ? [] : [t('sum.prompt.blocked', { n: blocked })]),
        ...(value(fields, 'discussion.enabled') === false ? [t('sum.prompt.discussionOff')] : []),
      ]
      return { text: parts.join(' · '), attention: invalid(fields, section) }
    }
    case 'connectors': {
      const entries = list(fields, 'connectors.servers') as ConnectorEntry[]
      if (entries.length === 0) return { text: t('sum.conn.none'), attention: false }
      const states = entries.map((entry) => connectorState(entry.id))
      const attention = states.some((state) => state?.phase === 'expired' || state?.phase === 'error')
      const text = entries.map((entry, i) => `${connectorName(entry)} ${t(PHASE_KEY[states[i]?.phase ?? 'connecting'])}`).join(' · ')
      return { text, attention }
    }
    case 'team': {
      const ids = (list(fields, 'team.agents') as Array<{ id?: unknown }>).map((agent) => String(agent?.id ?? '')).filter(Boolean)
      return { text: ids.length === 0 ? t('sum.team.none') : t('sum.team', { n: ids.length, names: ids.join(', ') }), attention: invalid(fields, section) }
    }
    case 'claude': {
      const on = (id: string): string => t(value(fields, id) === true ? 'on' : 'off')
      const parts = [
        `${t('sum.claude.rc')} ${on('claude.remoteControl')}`,
        ...(value(fields, 'claude.fullAccess') === true ? [t('sum.claude.full')] : []),
        t('sum.claude.idle', { n: String(value(fields, 'claude.idleHours') ?? '') }),
        ...(typeof value(fields, 'claude.helperModel') === 'string' && value(fields, 'claude.helperModel') !== ''
          ? [t('sum.claude.helper', { model: String(value(fields, 'claude.helperModel')) })]
          : []),
      ]
      return { text: parts.join(' · '), attention: invalid(fields, section) }
    }
    case 'qoder': {
      const workspaces = list(fields, 'qoder.workspaces').length
      return {
        text: [
          workspaces === 0 ? t('sum.qoder.none') : t('sum.qoder.workspaces', { n: workspaces }),
          ...(workspaces > 0 && value(fields, 'qoder.autoStart') === false ? [t('sum.qoder.manual')] : []),
          ...(workspaces > 0 ? [value(fields, 'qoder.idleMinutes') === 0 ? t('sum.qoder.keep') : t('sum.qoder.idle', { n: String(value(fields, 'qoder.idleMinutes') ?? '') })] : []),
        ].join(' · '),
        attention: invalid(fields, section),
      }
    }
    case 'hermes': {
      const ids = list(fields, 'hermes.models')
      const personas = ids.filter((id) => id !== NO_MODELS).length
      const text = personas > 0 ? t('sum.hermes.some', { n: personas }) : ids.length === 0 ? t('sum.hermes.all') : t('sum.hermes.none')
      return { text, attention: invalid(fields, section) }
    }
    case 'models': {
      const hidden = list(fields, 'models.hiddenProviders').length
      const effort = value(fields, 'models.effort')
      const apart = list(fields, 'models.efforts').length
      // Agents whose model list is limited (an empty list offers every model).
      const limited = ['claude', 'codex', 'cursor', 'qoder'].filter((agent) => list(fields, `${agent}.models`).length > 0).length
      const parts = [
        hidden === 0 ? t('sum.models.all') : t('sum.models.hidden', { n: hidden }),
        ...(typeof effort === 'string' && effort !== '' ? [t('sum.models.effort', { effort })] : []),
        ...(apart === 0 ? [] : [t('sum.models.efforts', { n: apart })]),
        ...(limited === 0 ? [] : [t('sum.models.agents', { n: limited })]),
      ]
      return { text: parts.join(' · '), attention: invalid(fields, section) }
    }
    case 'appearance': {
      const font = (id: string): string => {
        const selected = value(fields, id)
        const key: FontId = (FONTS as readonly unknown[]).includes(selected) ? selected as FontId : 'default'
        return t(`font.${key}`)
      }
      const scale = value(fields, 'appearance.uiScale')
      const tuned = Object.values(regionsOf(value(fields, 'appearance.regions'))).filter((offset) => offset !== 0).length
      return { text: [
        t('sum.appearance', { ui: font('appearance.uiFont'), code: font('appearance.codeFont'), scale: String(typeof scale === 'number' ? scale : DEFAULT_UI_SCALE) }),
        ...(tuned === 0 ? [] : [t('sum.appearance.regions', { n: tuned })]),
      ].join(' · '), attention: false }
    }
    case 'remote':
      return { text: [
        t('sum.remote', { port: String(value(fields, 'remote.httpsPort') ?? 443) }),
        ...(value(fields, 'remote.http') === false ? [] : [t('sum.remote.http')]),
        ...(value(fields, 'remote.phoneSettings') === true ? [t('sum.remote.phone')] : []),
      ].join(' · '), attention: invalid(fields, section) }
    case 'device': {
      if (device === undefined) return { text: '', attention: false }
      const phase = device.pairing?.phase
      if (phase === 'waiting' || phase === 'compare') return { text: t('sum.device.pairing'), attention: false }
      // Problems the person must fix on this computer open the group; a device switched off does not.
      const problems = [
        ...(device.link.state === 'error' ? [t('sum.device.portError', { port: String(value(fields, 'device.port') ?? '') })] : []),
        ...(device.typer.permission === false ? [t('sum.device.noPermission')] : []),
      ]
      if (device.devices.length === 0) return { text: [t('sum.device.none'), ...problems].join(' · '), attention: problems.length > 0 }
      const online = device.devices.filter((entry) => entry.online)
      const parts = online.length === 0
        ? [t('sum.device.offline', { n: device.devices.length })]
        : online.map((entry) => (entry.bat === undefined ? t('sum.device.online', { name: entry.name }) : t('sum.device.onlineBattery', { name: entry.name, bat: entry.bat })))
      return { text: [...parts, ...problems].join(' · '), attention: problems.length > 0 || invalid(fields, section) }
    }
    case 'palette': {
      if (value(fields, 'modules.palette') !== true) return { text: t('sum.palette.off'), attention: false }
      // Configured is not in force: a shortcut another program holds is what the person has to act on.
      const failed = palette?.hotkey?.ok === false
      return { text: failed ? t('sum.palette.failed') : t('sum.palette.on', { accel: String(value(fields, 'palette.hotkey') ?? '') }), attention: failed || invalid(fields, section) }
    }
    case 'review': {
      const repos = list(fields, 'review.repos').length
      if (repos === 0) return { text: t('sum.review.off'), attention: false }
      // Legacy auto/at values are migration input, never the live task's status.
      return { text: t('sum.review.native', { n: repos, bot: String(value(fields, 'review.bot') ?? '') }), attention: invalid(fields, section) }
    }
    case 'board': {
      const url = String(value(fields, 'alerts.url') ?? '').trim()
      let project = url
      try { const parsed = new URL(url); project = parsed.searchParams.get('project') ?? parsed.hostname }
      catch { /* the field row shows the invalid value */ }
      const bot = value(fields, 'board.ticketBot')
      return {
        text: [
          `${t('section.alerts')} ${url === '' ? t('sum.alerts.off') : t('sum.alerts', { project, bot: String(value(fields, 'alerts.bot') ?? '') })}`,
          typeof bot === 'string' && bot !== '' ? t('sum.board', { bot }) : t('sum.board.none'),
        ].join(' · '),
        attention: invalid(fields, section),
      }
    }
    case 'git': {
      const model = value(fields, 'git.model')
      const extra = typeof value(fields, 'git.instructions') === 'string' && String(value(fields, 'git.instructions')).trim() !== ''
      const name = typeof model === 'string' && model !== '' ? model : t('route.default')
      const identities = list(fields, 'git.identities').length
      return {
        text: [
          t(value(fields, 'git.strict') === false ? 'sum.git.loose' : 'sum.git.strict'),
          t('sum.git.identities', { n: identities }),
          t('sum.git', { model: name }),
          ...(extra ? [t('sum.git.extra')] : []),
        ].join(' · '),
        attention: invalid(fields, section),
      }
    }
    default: return { text: '', attention: invalid(fields, section) }
  }
}
