/** A model picker over DSH's registered catalog, shared by the commit-message model and the team profiles. */

import { useSyncExternalStore, type ReactNode } from 'react'
import { t } from './i18n.ts'
import type { ModelDirectory } from './models.ts'

const routeKey = (provider: string, model: string): string => JSON.stringify([provider, model])

/**
 * A model from DSH's registered catalog, grouped by provider, or the default.
 * A saved route the catalog no longer lists (signed out, plugin removed) stays
 * selectable and is marked, so opening the page never silently changes it.
 */
export function RoutePicker(props: {
  id: string
  disabled: boolean
  models: ModelDirectory
  provider: string | undefined
  model: string | undefined
  /** What "no route" means here; the commit-message default otherwise. */
  defaultLabel?: string
  /** Provider routes not offered here. */
  exclude?: readonly string[]
  onPick(route: { provider: string; model: string } | undefined): void
}): ReactNode {
  const { models, provider, model } = props
  const directory = useSyncExternalStore(models.subscribe, models.getSnapshot)
  const groups = (directory.groups ?? []).filter((group) => !props.exclude?.includes(group.provider))
  const current = provider && model ? routeKey(provider, model) : ''
  const listed = current === '' || groups.some((group) => group.provider === provider && group.models.some((entry) => entry.id === model))
  const pick = (value: string): void => {
    if (value === '') return props.onPick(undefined)
    const [nextProvider, nextModel] = JSON.parse(value) as [string, string]
    props.onPick({ provider: nextProvider, model: nextModel })
  }
  return (
    <div className="ac-route">
      <select id={props.id} className="ac-input ac-select" disabled={props.disabled} value={current} onChange={(event) => pick(event.target.value)}>
        <option value="">{props.defaultLabel ?? t('route.default')}</option>
        {!listed && (
          <option value={current}>
            {directory.groups === null ? `${provider} / ${model}` : t('route.unlisted', { route: `${provider} / ${model}` })}
          </option>
        )}
        {groups.map((group) => (
          <optgroup key={group.provider} label={group.failed ? t('route.groupFailed', { name: group.name }) : group.name}>
            {group.models.map((entry) => (
              <option key={entry.id} value={routeKey(group.provider, entry.id)}>
                {entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {directory.loading && <span className="ac-muted ac-route-status" role="status">{t('route.loading')}</span>}
      {!directory.loading && directory.error !== null && (
        <span className="ac-route-status" role="status">
          {t('route.failed')}{' '}
          <button type="button" className="ac-link" onClick={() => void models.load()}>{t('route.retry')}</button>
        </span>
      )}
      {!directory.loading && directory.error === null && directory.groups !== null && directory.groups.length === 0 && (
        <span className="ac-muted ac-route-status" role="status">{t('route.empty')}</span>
      )}
    </div>
  )
}
