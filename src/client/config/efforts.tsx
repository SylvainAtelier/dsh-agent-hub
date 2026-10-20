/**
 * The thinking level a model starts at when it is picked in DSH's model
 * selectors: one shared level for every model (`models.effort`) and single
 * models set apart (`models.efforts`). Each model's own levels come from the
 * full catalog; the bots are left out, they take their model's level unless
 * they set their own (Bots).
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { chooseEffort, EFFORT_LADDER, type EffortRule } from '../../efforts.ts'
import { BOT_ROUTE } from '../../team/types.ts'
import { t } from './i18n.ts'
import { Row, type Props } from './visibility.tsx'

const rulesOf = (value: unknown): EffortRule[] => (Array.isArray(value)
  ? value.filter((rule): rule is EffortRule => typeof rule?.provider === 'string' && typeof rule.model === 'string' && typeof rule.effort === 'string')
  : [])

/** `models.effort`: the level every model starts at; blank keeps each model's own default. */
export function EffortField(props: Props): ReactNode {
  const directory = useSyncExternalStore(props.models.subscribe, props.models.getSnapshot)
  const current = typeof props.field.value === 'string' ? props.field.value : ''
  // Levels a provider names outside the ladder only ever match exactly, but can still be chosen.
  const seen = (directory.groups ?? []).flatMap((group) => group.models.flatMap((model) => model.reasoning?.efforts.map((effort) => effort.id) ?? []))
  const levels = [...new Set<string>([...EFFORT_LADDER, ...seen, ...(current === '' ? [] : [current])])]
  return (
    <Row {...props}>
      <select className="ac-input ac-select" aria-labelledby={`ac-field-${props.id}`} disabled={props.disabled} value={current}
        onChange={(event) => props.form.edit(props.id, event.target.value)}>
        <option value="">{t('models.effort.own')}</option>
        {levels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
    </Row>
  )
}

/** `models.efforts`: per model, a level over the shared one; "shared setting" drops the model's rule. */
export function EffortsField(props: Props & { shared: unknown }): ReactNode {
  const directory = useSyncExternalStore(props.models.subscribe, props.models.getSnapshot)
  const rules = rulesOf(props.field.value)
  const shared = { effort: typeof props.shared === 'string' ? props.shared : '', rules: [] }
  const listed = (directory.groups ?? []).filter((group) => group.provider !== BOT_ROUTE).flatMap((group) => group.models
    .filter((model) => model.reasoning !== undefined)
    .map((model) => ({ provider: group.provider, providerName: group.name, id: model.id, name: model.name, reasoning: model.reasoning!, missing: false })))
  // Saved rules for models no longer listed stay visible so they can be dropped.
  const rows = [
    ...listed,
    ...rules.filter((rule) => !listed.some((row) => row.provider === rule.provider && row.id === rule.model)).map((rule) => ({
      provider: rule.provider, providerName: rule.provider, id: rule.model, name: rule.model,
      reasoning: { efforts: [{ id: rule.effort, name: rule.effort }], defaultEffort: undefined }, missing: true,
    })),
  ]
  const pick = (provider: string, model: string, effort: string): void => {
    const rest = rules.filter((rule) => rule.provider !== provider || rule.model !== model)
    props.form.edit(props.id, effort === '' ? rest : [...rest, { provider, model, effort }])
  }
  return (
    <Row {...props}>
      {rows.length === 0
        ? <span className="ac-muted ac-route-status">{t('models.efforts.none')}</span>
        : (
          <div className="ac-efforts" role="group" aria-labelledby={`ac-field-${props.id}`}>
            {rows.map((row) => {
              const ids = row.reasoning.efforts.map((effort) => effort.id)
              const follows = row.missing ? undefined : chooseEffort(shared, row.provider, row.id, ids) ?? row.reasoning.defaultEffort
              const followName = row.reasoning.efforts.find((effort) => effort.id === follows)?.name ?? follows ?? '—'
              const rule = rules.find((entry) => entry.provider === row.provider && entry.model === row.id)
              return (
                <label key={`${row.provider}/${row.id}`} className="ac-effort">
                  <span className="ac-effort-name">
                    <span className="ac-check-label">{row.name}</span>
                    <span className="ac-check-detail">{row.missing ? `${row.provider} · ${t('models.efforts.missing')}` : row.providerName}</span>
                  </span>
                  <select className="ac-input ac-select" disabled={props.disabled} value={rule?.effort ?? ''}
                    onChange={(event) => pick(row.provider, row.id, event.target.value)}>
                    <option value="">{t(shared.effort === '' ? 'models.efforts.own' : 'models.efforts.follow', { effort: followName })}</option>
                    {row.reasoning.efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                  </select>
                </label>
              )
            })}
          </div>
        )}
    </Row>
  )
}
