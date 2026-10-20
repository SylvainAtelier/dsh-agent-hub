/**
 * 设置 → 同步与更新: the profile as a whole rather than this plugin's own options. Settings sync
 * (where the repository is, what each machine keeps for itself, the sync itself) and the plugin
 * upgrades share the page because both change every plugin of the profile and both can leave
 * work for the next restart: the one banner on top says so and offers the restart.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { FIELDS, fieldId, type ConfigFormModel } from './form.ts'
import { t } from './i18n.ts'
import type { ModelDirectory } from './models.ts'
import { Field, Group, shownNow } from './ui.tsx'
import { SyncExcludeField } from './exclude.tsx'
import { SyncPanel } from './sync.tsx'
import type { SyncStore } from '../sync/api.ts'
import { PluginUpdatesPanel } from '../plugins/Panel.tsx'
import type { PluginUpdatesStore } from '../plugins/api.ts'
import { openRestartDialog, type RestartCall } from '../restart/index.tsx'
import type { RestartStatus } from '../../restart/types.ts'

export function UpdatesSection(props: {
  form: ConfigFormModel
  models: ModelDirectory
  sync: SyncStore
  plugins: PluginUpdatesStore
  locale: string
  restart: RestartCall
}): ReactNode {
  const { form } = props
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot)
  useEffect(() => () => { void form.leave() }, [form])
  useEffect(() => { void form.refresh() }, [form])
  const phone = state.phone === 'open' || state.phone === 'locked'
  const locked = !state.writable
  const status = state.saving ? 'saving' : state.outcome ?? (state.dirty ? 'dirty' : undefined)
  // The sync reads the remote and branch on the host: once a new one is saved, read its status again.
  const remote = state.fields['sync.remote']
  const branch = state.fields['sync.branch']
  const target = state.saving || remote?.dirty || branch?.dirty ? undefined : `${String(remote?.value ?? '')}\n${String(branch?.value ?? '')}`
  useEffect(() => { if (target !== undefined) void props.sync.load() }, [target, props.sync])

  let sync: ReactNode
  if (phone) sync = <div className="ac-row" data-wide=""><p className="ac-notice">{t('updates.phone')}</p></div>
  else if (!state.available) sync = state.loading ? null : <div className="ac-row" data-wide=""><p className="ac-notice" role="status">{t('unavailable')}</p></div>
  else {
    sync = (
      <>
        {FIELDS.filter((spec) => spec.section === 'sync' && spec.hidden !== true && shownNow(spec, state.fields)).map((spec) => {
          const id = fieldId(spec)
          const field = state.fields[id]!
          if (spec.kind === 'syncExclude') return <SyncExcludeField key={id} id={id} field={field} fields={state.fields} disabled={locked} form={form} store={props.sync} />
          return <Field key={id} spec={spec} fields={state.fields} disabled={locked} form={form} models={props.models} />
        })}
        <SyncPanel store={props.sync} disabled={locked} />
      </>
    )
  }

  return (
    <div className="ac-page" onBlur={() => void form.flush()}>
      <div className="ac-head">
        <p className="ac-lead">{t('updates.lead')}</p>
        <span className="ac-status" role="status" data-tone={status}>
          {status === 'saving' ? t('saving') : status === 'saved' ? t('saved') : status === 'failed' ? t('failed') : status === 'dirty' ? t('unsaved') : ''}
        </span>
        {state.outcome === 'failed' && !state.saving && (
          <>
            <button type="button" className="ah-btn" onClick={() => form.discard()}>{t('discard')}</button>
            <button type="button" className="ah-btn" data-variant="primary" onClick={() => void form.save()}>{t('retry')}</button>
          </>
        )}
      </div>
      <RestartBanner sync={props.sync} plugins={props.plugins} restart={props.restart} />
      <Group section="sync">{sync}</Group>
      <div className="ac-group ac-updates-plugins">
        <PluginUpdatesPanel store={props.plugins} locale={props.locale} />
      </div>
    </div>
  )
}

/**
 * Whatever waits for a restart, from either half of the page: a synced change the running DSH
 * could not take in, an installed upgrade, upgrades queued for the restart helper.
 */
function RestartBanner(props: { sync: SyncStore; plugins: PluginUpdatesStore; restart: RestartCall }): ReactNode {
  const sync = useSyncExternalStore(props.sync.subscribe, props.sync.getSnapshot).status
  const plugins = useSyncExternalStore(props.plugins.subscribe, props.plugins.getSnapshot).status
  const pending = plugins?.pending ?? []
  const needed = sync?.last?.restart === true || plugins?.restartRequired === true || pending.length > 0
  const [supported, setSupported] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (!needed || supported !== undefined) return
    let live = true
    props.restart({ op: 'status' }).then((status) => { if (live) setSupported((status as RestartStatus).supported) }, () => { if (live) setSupported(false) })
    return () => { live = false }
  }, [needed])
  if (!needed) return null
  return (
    <div className="ac-notice ac-restart-banner" role="status">
      <div className="ac-restart-text">
        <p><strong>{t('updates.restart')}</strong></p>
        {pending.length > 0 && <p>{t('updates.restartScheduled', { list: pending.map((op) => `${op.name}@${op.spec}`).join(', ') })}</p>}
      </div>
      {supported === true
        ? <button type="button" className="ah-btn" data-variant="primary" aria-haspopup="dialog" onClick={() => openRestartDialog(props.restart)}>{t('updates.restartNow')}</button>
        : supported === false && <span className="ac-muted">{t('updates.restartManual')}</span>}
    </div>
  )
}
