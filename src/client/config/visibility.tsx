/**
 * Which models DSH's model selectors offer: the agent and Codex models
 * to enable (`<section>.models`; empty = all) and the providers to hide
 * (`models.hiddenProviders`). Both list the full catalog, hidden entries
 * included, and stage their value with the rest of the page. Cursor's models
 * split by how they are paid for: those the plan includes, then on-demand.
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { NO_MODELS } from '../../visibility.ts'
import { cursorBilling, type Billing } from '../../cursor/billing.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'
import type { ModelDirectory } from './models.ts'

/** The route whose models each `<section>.models` field ticks. */
const ROUTES: Record<string, string> = { claude: 'claude-agent', codex: 'openai-codex', cursor: 'cursor-agent', qoder: 'qoder-agent', hermes: 'hermes-agent' }
/** Sections whose rows say what each entry is by its description (a Hermes persona's profile), not its id. */
const DESCRIBED: ReadonlySet<string> = new Set(['hermes'])

export interface Props {
  id: string
  field: FieldState
  disabled: boolean
  form: ConfigFormModel
  models: ModelDirectory
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

export function Row(props: Props & { children: ReactNode }): ReactNode {
  const { id, field, disabled, form } = props
  const directory = useSyncExternalStore(props.models.subscribe, props.models.getSnapshot)
  return (
    <div className="ac-row" data-wide="">
      <div className="ac-row-text">
        <div className="ac-row-head">
          <span className="ac-label" id={`ac-field-${id}`}>{t(id as ConfigKey)}</span>
          <span className="ac-badges">
            {field.overridden
              ? <>
                  <span className="ac-tag">{t('overridden')}</span>
                  <button type="button" className="ac-link" disabled={disabled} onClick={() => form.reset(id)}>{t('reset')}</button>
                </>
              : <span className="ac-muted">{t('default')}</span>}
          </span>
        </div>
        <p className="ac-hint">{t(`${id}.hint` as ConfigKey)}</p>
      </div>
      <div className="ac-control">
        {directory.groups === null
          ? <span className="ac-muted ac-route-status" role="status">{directory.error === null ? t('route.loading') : t('route.failed')}</span>
          : props.children}
      </div>
    </div>
  )
}

/** `detail` is one line, cut short with an ellipsis; its whole text is the row's tooltip. */
export function Check(props: { checked: boolean; disabled: boolean; label: string; detail?: string; onChange(next: boolean): void }): ReactNode {
  return (
    <label className="ac-check" data-disabled={props.disabled ? '' : undefined} title={props.detail}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="ac-check-label">{props.label}</span>
      {props.detail !== undefined && <span className="ac-check-detail">{props.detail}</span>}
    </label>
  )
}

interface ModelRow {
  id: string
  name: string
  description?: string
  billing?: Billing
  missing?: true
}

const BILLINGS: readonly Billing[] = ['included', 'on-demand']
const billingKey = (billing: Billing): 'models.billing.included' | 'models.billing.onDemand' =>
  billing === 'included' ? 'models.billing.included' : 'models.billing.onDemand'

/** A billing section's tick-all box: mixed when only some of its models are ticked. */
function SectionCheck(props: { billing: Billing; rows: ModelRow[]; enabled: Set<string>; disabled: boolean; onChange(next: boolean): void }): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  const ticked = props.rows.filter((row) => props.enabled.has(row.id)).length
  const all = ticked === props.rows.length
  const mixed = ticked > 0 && !all
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = mixed
  }, [mixed])
  const key = billingKey(props.billing)
  return (
    <div className="ac-billing-head">
      <label className="ac-check ac-billing-title" data-disabled={props.disabled ? '' : undefined}>
        <input ref={ref} type="checkbox" checked={all} disabled={props.disabled} aria-checked={mixed ? 'mixed' : all}
          onChange={() => props.onChange(!all)} />
        <span className="ac-billing-name">{t(key)}</span>
        <span className="ac-billing-count">{ticked} / {props.rows.length}</span>
      </label>
      <span className="ac-billing-hint">{t(`${key}.hint`)}</span>
    </div>
  )
}

/** `<section>.models`: tick the models the selectors offer. Everything ticked stores the default (all, new ones too). */
export function AgentModelsField(props: Props & { setup?: ReactNode }): ReactNode {
  const directory = useSyncExternalStore(props.models.subscribe, props.models.getSnapshot)
  const section = props.id.split('.')[0] ?? ''
  const catalog = directory.groups?.find((group) => group.provider === ROUTES[section])?.models ?? []
  const stored = strings(props.field.value).filter((id) => id !== NO_MODELS)
  const none = stored.length === 0 && strings(props.field.value).includes(NO_MODELS)
  const all = catalog.map((model) => model.id)
  const enabled = new Set(none ? [] : stored.length === 0 ? all : stored)
  // Saved ids the agent no longer lists stay visible so they can be unticked.
  const billed = catalog.some((model) => model.billing !== undefined)
  const rows: ModelRow[] = [
    ...catalog,
    ...stored.filter((id) => !all.includes(id)).map((id): ModelRow => ({ id, name: id, missing: true, ...(billed ? { billing: cursorBilling(id) } : {}) })),
  ]
  const save = (next: string[]): void => {
    props.form.edit(props.id, next.length === 0 ? [NO_MODELS] : all.every((entry) => next.includes(entry)) && next.length === all.length ? [] : next)
  }
  const set = (ids: readonly string[], on: boolean): void => {
    save(rows.map((row) => row.id).filter((entry) => (ids.includes(entry) ? on : enabled.has(entry))))
  }
  const listed = rows.filter((row) => row.missing === undefined)
  const checks = (list: ModelRow[], name: { 'aria-label': string } | { 'aria-labelledby': string }): ReactNode => (
    <div className="ac-checks" role="group" {...name}>
      {list.map((row) => (
        <Check key={row.id} checked={enabled.has(row.id)} disabled={props.disabled}
          label={row.name}
          detail={row.missing !== undefined ? t(`${section}.models.missing` as ConfigKey) : (DESCRIBED.has(section) ? row.description : undefined) ?? (row.name === row.id ? undefined : row.id)}
          onChange={(on) => set([row.id], on)} />
      ))}
    </div>
  )
  const sections = BILLINGS.map((billing) => ({ billing, rows: rows.filter((row) => (row.billing ?? 'on-demand') === billing) }))
    .filter((entry) => entry.rows.length > 0)
  return (
    <Row {...props}>
      {rows.length === 0
        ? props.setup ?? <span className="ac-muted ac-route-status">{t(`${section}.models.empty` as ConfigKey)}</span>
        : (
          <>
            <div className="ac-bulk">
              <span className="ac-muted">{t('models.ticked', { n: listed.filter((row) => enabled.has(row.id)).length, total: listed.length })}</span>
              <button type="button" className="ac-link" disabled={props.disabled || listed.every((row) => enabled.has(row.id))} onClick={() => save(all)}>{t('models.all')}</button>
              <button type="button" className="ac-link" disabled={props.disabled || none} onClick={() => save([])}>{t('models.none')}</button>
            </div>
            {none && <p className="ac-hint ac-warn">{t(`${section}.models.none` as ConfigKey)}</p>}
            {!billed
              ? checks(rows, { 'aria-labelledby': `ac-field-${props.id}` })
              : (
                <div className="ac-billing" role="group" aria-labelledby={`ac-field-${props.id}`}>
                  {sections.map((entry) => (
                    <section key={entry.billing} className="ac-billing-section" data-billing={entry.billing}>
                      <SectionCheck billing={entry.billing} rows={entry.rows} enabled={enabled} disabled={props.disabled}
                        onChange={(on) => set(entry.rows.map((row) => row.id), on)} />
                      {checks(entry.rows, { 'aria-label': t(billingKey(entry.billing)) })}
                    </section>
                  ))}
                </div>
              )}
          </>
        )}
    </Row>
  )
}

/** `models.hiddenProviders`: untick a provider to take its models out of DSH's selectors. */
export function HiddenProvidersField(props: Props): ReactNode {
  const directory = useSyncExternalStore(props.models.subscribe, props.models.getSnapshot)
  const hidden = strings(props.field.value)
  const groups = directory.groups ?? []
  const rows = [
    ...groups.map((group) => ({ id: group.provider, name: group.name, count: group.models.length })),
    ...hidden.filter((id) => !groups.some((group) => group.provider === id)).map((id) => ({ id, name: id, count: undefined })),
  ]
  const toggle = (id: string, shown: boolean): void => {
    props.form.edit(props.id, shown ? hidden.filter((entry) => entry !== id) : [...hidden, id])
  }
  return (
    <Row {...props}>
      <div className="ac-checks" role="group" aria-labelledby={`ac-field-${props.id}`}>
        {rows.map((row) => (
          <Check key={row.id} checked={!hidden.includes(row.id)} disabled={props.disabled}
            label={row.name}
            detail={row.count === undefined ? t('models.hiddenProviders.missing', { id: row.id }) : t('models.hiddenProviders.detail', { id: row.id, n: row.count })}
            onChange={(shown) => toggle(row.id, shown)} />
        ))}
      </div>
    </Row>
  )
}
