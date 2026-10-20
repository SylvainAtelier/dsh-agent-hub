/**
 * 字体与字号 → 界面文字大小: one stepper for the whole interface, and a fold
 * with one stepper per region on top of it. Each click saves at once, and the
 * page's own text (the settings window is a region) shows the result live.
 * Back at DSH's sizes, a value is reset rather than stored, so the profile
 * keeps no override that only restates the default.
 */

import { useState, type ReactNode } from 'react'
import type { ConfigFormModel, FormState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'
import {
  DEFAULT_UI_SCALE, MAX_REGION_OFFSET, MAX_UI_SCALE, MIN_UI_SCALE, regionsOf, SCALE_REGIONS, UI_SCALE_STEP, type ScaleRegion,
} from '../../appearance.ts'

const SCALE_ID = 'appearance.uiScale'
const REGIONS_ID = 'appearance.regions'

export function InterfaceScaleField(props: { fields: FormState['fields']; disabled: boolean; form: ConfigFormModel }): ReactNode {
  const { fields, disabled, form } = props
  const whole = typeof fields[SCALE_ID]?.value === 'number' ? fields[SCALE_ID].value as number : DEFAULT_UI_SCALE
  const regions = regionsOf(fields[REGIONS_ID]?.value)
  const tuned = SCALE_REGIONS.filter((region) => regions[region] !== 0).length
  const changed = whole !== DEFAULT_UI_SCALE || tuned > 0 || fields[SCALE_ID]?.overridden === true || fields[REGIONS_ID]?.overridden === true
  // Opens by itself where a region is already tuned, so what applies is in view.
  const [open, setOpen] = useState(tuned > 0)

  const setWhole = (value: number): void => {
    if (value === DEFAULT_UI_SCALE) form.reset(SCALE_ID)
    else form.edit(SCALE_ID, value)
  }
  const setRegion = (region: ScaleRegion, offset: number): void => {
    const next = { ...regions, [region]: offset }
    if (SCALE_REGIONS.every((key) => next[key] === 0)) form.reset(REGIONS_ID)
    else form.edit(REGIONS_ID, next)
  }
  const resetAll = (): void => {
    form.reset(SCALE_ID)
    form.reset(REGIONS_ID)
  }

  return (
    <div className="ac-row ac-scale" data-wide="">
      <div className="ac-scale-main">
        <div className="ac-row-text">
          <div className="ac-row-head">
            <span id="ac-scale-label" className="ac-label">{t('appearance.uiScale')}</span>
            <span className="ac-badges">
              {changed
                ? <>
                    <span className="ac-tag">{t('overridden')}</span>
                    <button type="button" className="ac-link" disabled={disabled} onClick={resetAll}
                      title={t('defaultValue', { value: `${DEFAULT_UI_SCALE}%` })}>{t('appearance.uiScale.resetAll')}</button>
                  </>
                : <span className="ac-muted">{t('default')}</span>}
            </span>
          </div>
          <p className="ac-hint">{t('appearance.uiScale.hint')}</p>
        </div>
        <Stepper name={t('appearance.uiScale.whole')} labelledBy="ac-scale-label" disabled={disabled}
          value={whole} min={MIN_UI_SCALE} max={MAX_UI_SCALE} onChange={setWhole}
          shown={<><span>{whole}</span><small>%</small></>} />
      </div>
      <button type="button" className="ac-scale-toggle" aria-expanded={open} aria-controls="ac-scale-regions" onClick={() => setOpen(!open)}>
        <span className="ac-group-chevron" aria-hidden="true">›</span>
        <span>{t('appearance.regions')}</span>
        {tuned > 0 && <span className="ac-scale-count">{t('appearance.regions.tuned', { n: tuned })}</span>}
      </button>
      {open && (
        <div id="ac-scale-regions" className="ac-scale-regions">
          <p className="ac-hint">{t('appearance.regions.note')}</p>
          <ul className="ac-scale-list">
            {SCALE_REGIONS.map((region) => {
              const offset = regions[region]
              const name = t(`appearance.region.${region}` as ConfigKey)
              const nameId = `ac-scale-${region}`
              return (
                <li key={region} className="ac-scale-region" data-tuned={offset !== 0 ? '' : undefined}>
                  <div className="ac-scale-region-text">
                    <span id={nameId} className="ac-scale-region-name">
                      {name}
                      {offset !== 0 && <small>{t('appearance.region.effective', { n: whole + offset })}</small>}
                    </span>
                    <span className="ac-scale-region-hint">{t(`appearance.region.${region}.hint` as ConfigKey)}</span>
                  </div>
                  <Stepper name={name} labelledBy={nameId} disabled={disabled} compact
                    value={offset} min={-MAX_REGION_OFFSET} max={MAX_REGION_OFFSET} onChange={(next) => setRegion(region, next)}
                    shown={offset === 0
                      ? <span className="ac-stepper-follow">{t('appearance.region.follow')}</span>
                      : <><span>{offset > 0 ? `+${offset}` : `−${-offset}`}</span><small>%</small></>} />
                  <button type="button" className="ac-scale-reset" disabled={disabled || offset === 0} hidden={offset === 0}
                    aria-label={t('appearance.region.reset', { name })} title={t('appearance.region.reset', { name })}
                    onClick={() => setRegion(region, 0)}>↺</button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/** − value +, one {@link UI_SCALE_STEP} per click; the value is announced as it changes. */
function Stepper(props: {
  name: string
  labelledBy: string
  value: number
  min: number
  max: number
  shown: ReactNode
  disabled: boolean
  compact?: boolean
  onChange(value: number): void
}): ReactNode {
  const { value, min, max, disabled, onChange, name } = props
  return (
    <div className="ac-stepper" role="group" aria-labelledby={props.labelledBy} data-compact={props.compact ? '' : undefined}>
      <button type="button" className="ac-stepper-step" disabled={disabled || value <= min}
        aria-label={t('appearance.uiScale.decrease', { name })} onClick={() => onChange(Math.max(min, value - UI_SCALE_STEP))}>−</button>
      <output className="ac-stepper-value" aria-live="polite">{props.shown}</output>
      <button type="button" className="ac-stepper-step" disabled={disabled || value >= max}
        aria-label={t('appearance.uiScale.increase', { name })} onClick={() => onChange(Math.min(max, value + UI_SCALE_STEP))}>+</button>
    </div>
  )
}
