/**
 * 设置 → Agent Hub → Bots. Each bot is a row that opens in place to edit; the
 * list is staged as one value and saved with the rest of the page. An empty
 * list offers common roles to start from. What is set most often comes first;
 * the tool list waits under 高级.
 */

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { EFFORT_LADDER } from '../../efforts.ts'
import { PROFILE_ID, type AgentProfile } from '../../team/profiles.ts'
import { BOT_ROUTE } from '../../team/types.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'
import type { ModelDirectory } from './models.ts'
import { RoutePicker } from './route.tsx'

const TEMPLATES = ['reviewer', 'coder', 'tester', 'researcher'] as const

/** What a save stores: no empty fields, so the profile's YAML stays as short as what was set. */
function tidy(profile: AgentProfile): AgentProfile {
  const out: AgentProfile = { id: profile.id }
  if (profile.description) out.description = profile.description
  if (profile.provider && profile.model) {
    out.provider = profile.provider
    out.model = profile.model
  }
  if (profile.effort) out.effort = profile.effort
  if (profile.persona) out.persona = profile.persona
  if (profile.tools !== undefined && profile.tools.length > 0) out.tools = profile.tools
  return out
}

function freeId(base: string, list: readonly AgentProfile[]): string {
  const taken = new Set(list.map((profile) => profile.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`
}

/** A stable hue per name, so a bot is recognizable across the list. */
const hue = (id: string): number => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)

/** A bot never runs on another bot. */
const NOT_BOTS = [BOT_ROUTE] as const

export function AgentsEditor(props: {
  id: string
  field: FieldState
  disabled: boolean
  form: ConfigFormModel
  models: ModelDirectory
  teams: () => Promise<boolean>
}): ReactNode {
  const { form, disabled } = props
  const list = (Array.isArray(props.field.value) ? props.field.value : []) as AgentProfile[]
  const [open, setOpen] = useState<number | null>(null)
  const [available, setAvailable] = useState<boolean | undefined>()
  useEffect(() => {
    let live = true
    props.teams().then((value) => { if (live) setAvailable(value) }, () => {})
    return () => { live = false }
  }, [props.teams])

  const commit = (next: AgentProfile[]): void => form.edit(props.id, next.map(tidy))
  const update = (index: number, patch: Partial<AgentProfile>): void => commit(list.map((profile, i) => (i === index ? { ...profile, ...patch } : profile)))
  const add = (template?: typeof TEMPLATES[number]): void => {
    const profile: AgentProfile = template === undefined
      ? { id: freeId('agent', list) }
      : {
          id: freeId(template, list),
          description: t(`team.template.${template}` as ConfigKey),
          persona: t(`team.template.${template}.persona` as ConfigKey),
        }
    commit([...list, profile])
    setOpen(list.length)
  }
  const remove = (index: number): void => {
    commit(list.filter((_, i) => i !== index))
    setOpen(null)
  }

  return (
    <div className="ac-agents">
      {available === false && <p className="ac-notice" role="status">{t('team.unavailable')}</p>}
      {list.length === 0 && (
        <div className="ac-agents-empty">
          <span>{t('team.empty')}</span>
          <div className="ac-chips">
            {TEMPLATES.map((template) => (
              <button key={template} type="button" className="ac-chip" disabled={disabled} onClick={() => add(template)}>
                {t(`team.template.${template}` as ConfigKey)}<span className="ac-chip-id">{template}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {list.map((profile, index) => (
        <AgentCard key={index} profile={profile} list={list} open={open === index} disabled={disabled} models={props.models}
          onToggle={() => setOpen(open === index ? null : index)} onChange={(patch) => update(index, patch)} onRemove={() => remove(index)} />
      ))}
      <button type="button" className="ah-btn ac-agents-add" disabled={disabled} onClick={() => add()}>＋ {t('team.add')}</button>
    </div>
  )
}

function AgentCard(props: {
  profile: AgentProfile
  list: readonly AgentProfile[]
  open: boolean
  disabled: boolean
  models: ModelDirectory
  onToggle(): void
  onChange(patch: Partial<AgentProfile>): void
  onRemove(): void
}): ReactNode {
  const { profile, disabled } = props
  const uid = useId()
  const badId = !PROFILE_ID.test(profile.id)
  const taken = !badId && props.list.filter((other) => other.id === profile.id).length > 1
  const invalid = badId || taken
  const directory = useSyncExternalStore(props.models.subscribe, props.models.getSnapshot)
  // "Claude Agent · Opus" reads better than a bare model id such as "default".
  const picked = profile.provider && profile.model
    ? directory.groups?.find((entry) => entry.provider === profile.provider)?.models.find((entry) => entry.id === profile.model)
    : undefined
  const route = (() => {
    if (!profile.provider || !profile.model) return undefined
    const group = directory.groups?.find((entry) => entry.provider === profile.provider)
    return `${group?.name ?? profile.provider} · ${picked?.name ?? profile.model}`
  })()
  // The picked model's own levels; the default model (or one not listed) offers the shared ladder.
  const efforts = picked?.reasoning?.efforts ?? EFFORT_LADDER.map((id) => ({ id, name: id }))
  const levels = profile.effort && !efforts.some((effort) => effort.id === profile.effort)
    ? [...efforts, { id: profile.effort, name: profile.effort }]
    : efforts
  return (
    <div className="ac-agent" data-open={props.open ? '' : undefined} data-invalid={invalid ? '' : undefined}>
      <button type="button" className="ac-agent-head" aria-expanded={props.open} aria-controls={`${uid}-body`} onClick={props.onToggle}>
        <span className="ac-avatar" aria-hidden="true" style={{ background: `hsl(${hue(profile.id)} 52% 48%)` }}>
          {(profile.id[0] ?? '?').toUpperCase()}
        </span>
        <span className="ac-agent-text">
          <span className="ac-agent-name">{profile.id || t('team.untitled')}</span>
          {profile.description && <span className="ac-agent-desc">{profile.description}</span>}
        </span>
        <span className="ac-agent-model" title={route === undefined ? undefined : `${profile.provider}/${profile.model}`}>
          {route ?? t('team.inherit')}{profile.effort ? ` · ${profile.effort}` : ''}
        </span>
        <span className="ac-agent-chevron" aria-hidden="true">›</span>
      </button>
      {props.open && (
        <div className="ac-agent-body" id={`${uid}-body`}>
          <label className="ac-agent-field">
            <span className="ac-label">{t('team.id')}</span>
            <input className="ac-input" value={profile.id} disabled={disabled} spellCheck={false} autoComplete="off"
              aria-invalid={invalid || undefined} onChange={(event) => props.onChange({ id: event.target.value.trim().toLowerCase() })} />
            <span className="ac-hint" data-invalid={invalid ? '' : undefined}>
              {badId ? t('team.id.invalid') : taken ? t('team.id.taken') : t('team.id.hint', { id: profile.id })}
            </span>
          </label>
          <div className="ac-agent-field">
            <label className="ac-label" htmlFor={`${uid}-model`}>{t('team.model')}</label>
            <RoutePicker id={`${uid}-model`} disabled={disabled} models={props.models} provider={profile.provider} model={profile.model}
              defaultLabel={t('team.model.default')} exclude={NOT_BOTS}
              onPick={(next) => props.onChange(next === undefined ? { provider: '', model: '' } : next)} />
            <span className="ac-hint">{t('team.model.hint')}</span>
          </div>
          <label className="ac-agent-field">
            <span className="ac-label">{t('team.effort')}</span>
            <select className="ac-input ac-select" value={profile.effort ?? ''} disabled={disabled}
              onChange={(event) => props.onChange({ effort: event.target.value })}>
              <option value="">{t('team.effort.own')}</option>
              {levels.map((effort) => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
            </select>
            <span className="ac-hint">{t('team.effort.hint')}</span>
          </label>
          <label className="ac-agent-field ac-agent-wide">
            <span className="ac-label">{t('team.description')}</span>
            <input className="ac-input" value={profile.description ?? ''} disabled={disabled} placeholder={t('team.description.placeholder')}
              onChange={(event) => props.onChange({ description: event.target.value })} />
          </label>
          <label className="ac-agent-field ac-agent-wide">
            <span className="ac-label">{t('team.persona')}</span>
            <textarea className="ac-input" rows={3} value={profile.persona ?? ''} disabled={disabled} placeholder={t('team.persona.placeholder')}
              onChange={(event) => props.onChange({ persona: event.target.value })} />
          </label>
          <details className="ac-agent-more ac-agent-wide" open={(profile.tools ?? []).length > 0 || undefined}>
            <summary>{t('team.advanced')}</summary>
            <ToolsField tools={profile.tools ?? []} disabled={disabled} onChange={(tools) => props.onChange({ tools })} />
          </details>
          <div className="ac-agent-foot">
            <button type="button" className="ac-link ac-danger" disabled={disabled} onClick={props.onRemove}>{t('team.remove')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Comma-separated names; the text is kept as typed so a trailing comma survives until the next name. */
function ToolsField(props: { tools: readonly string[]; disabled: boolean; onChange(tools: string[]): void }): ReactNode {
  const joined = props.tools.join(', ')
  const [text, setText] = useState(joined)
  const parse = (value: string): string[] => value.split(/[,，\s]+/).map((name) => name.trim()).filter(Boolean)
  // Follow outside changes (discard, another card's save) when they differ from what the text means.
  useEffect(() => {
    if (parse(text).join(', ') !== joined) setText(joined)
  }, [joined])
  return (
    <label className="ac-agent-field ac-agent-wide">
      <span className="ac-label">{t('team.tools')}</span>
      <input className="ac-input" value={text} disabled={props.disabled} spellCheck={false} autoComplete="off" placeholder={t('team.tools.placeholder')}
        onChange={(event) => {
          setText(event.target.value)
          props.onChange(parse(event.target.value))
        }} />
      <span className="ac-hint">{t('team.tools.hint')}</span>
    </label>
  )
}
