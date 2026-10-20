/**
 * 设置 → Agent Hub's 功能模块 card, above the groups: one tile per optional module, the whole
 * tile its switch. A module bound to this computer says so; Codex names the plugin it stands
 * on and, while that is missing or off, offers to install or enable it right below.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { MODULES, CODEX_PLUGIN, type ModuleName } from '../../modules.ts'
import type { ModulesStore } from '../modules.ts'
import { CodexSetup } from '../codex/setup.tsx'
import type { ConfigFormModel, FormState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'

/** Bound to this computer: never synced, and not offered on a phone. */
const LOCAL: readonly ModuleName[] = ['palette', 'device']

export function ModulesCard(props: {
  fields: FormState['fields']
  form: ConfigFormModel
  disabled: boolean
  phone: boolean
  store?: ModulesStore
  /** A module with a settings group was switched on: show that group. */
  onEnabled(name: ModuleName): void
}): ReactNode {
  const noSync = (): (() => void) => () => {}
  const codex = useSyncExternalStore(props.store?.subscribe ?? noSync, () => props.store?.getSnapshot().status?.codex)
  const shown = MODULES.filter((name) => !(props.phone && LOCAL.includes(name)))
  return (
    <section className="ac-modules" aria-labelledby="ac-modules-title">
      <header className="ac-modules-head">
        <h2 id="ac-modules-title">{t('modules.title')}</h2>
        <p>{t('modules.note')}</p>
      </header>
      <div className="ac-modules-grid">
        {shown.map((name) => {
          const id = `modules.${name}`
          const on = props.fields[id]?.value === true
          const hintId = `ac-module-${name}-hint`
          return (
            <button key={name} type="button" role="switch" className="ac-module" aria-checked={on} aria-describedby={hintId}
              disabled={props.disabled} onClick={() => {
                props.form.edit(id, !on)
                if (!on) props.onEnabled(name)
              }}>
              <span className="ac-module-top">
                <ModuleIcon name={name} />
                <span className="ac-module-name">{t(id as ConfigKey)}</span>
                {LOCAL.includes(name) && <span className="ac-module-tag" title={t('modules.local.hint')}>{t('modules.local')}</span>}
                <span className="ac-switch ac-module-switch" aria-hidden="true"><span className="ac-thumb" /></span>
              </span>
              <span className="ac-module-hint" id={hintId}>
                {t(`${id}.hint` as ConfigKey)}
                {name === 'codex' && (
                  <span className="ac-module-needs">
                    {t('modules.needs', { name: CODEX_PLUGIN })}
                    {codex !== undefined && <span className="ac-module-plugin" data-state={codex}>{t(`modules.plugin.${codex}` as ConfigKey)}</span>}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {props.store !== undefined && <CodexSetup store={props.store} />}
    </section>
  )
}

/** Line glyphs in the page's own stroke style: a book, two crossing arrows, a clipboard, a handheld, a terminal. */
function ModuleIcon(props: { name: ModuleName }): ReactNode {
  const paths: Record<ModuleName, ReactNode> = {
    reader: <><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H10a2 2 0 0 1 2 2v14a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 1 3 17Z" /><path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H14a2 2 0 0 0-2 2v14a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 0 21 17Z" /></>,
    relay: <><path d="M4 8h13" /><path d="m14 4 4 4-4 4" /><path d="M20 16H7" /><path d="m10 12-4 4 4 4" /></>,
    palette: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4.5V3h6v1.5" /><path d="M9 10h6" /><path d="M9 14h4" /></>,
    device: <><rect x="4" y="5" width="16" height="14" rx="2" /><rect x="7" y="8" width="10" height="5" rx="1" /><path d="M8 16h.01M12 16h.01M16 16h.01" /></>,
    codex: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 10 3 2-3 2" /><path d="M13 15h4" /></>,
  }
  return (
    <svg className="ac-module-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">{paths[props.name]}</svg>
  )
}
