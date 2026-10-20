/**
 * 设置 → Agent Hub: every option of the plugin on one page, grouped by
 * module. Edits save themselves: picks at once, typing once it pauses or the
 * field loses focus.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CATEGORIES, FIELDS, SECTIONS, fieldId, groupOf, type ConfigFormModel, type FieldSpec, type FieldState, type FormState, type Section } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'
import type { ModelDirectory } from './models.ts'
import { PHONE_HIDDEN, phoneWritable } from '../../remote/settings.ts'
import { AgentsEditor } from './agents.tsx'
import { ConnectorsEditor } from './connectors.tsx'
import type { ConnectorsStore } from '../connectors/api.ts'
import type { ReposStore } from '../repos/api.ts'
import { RoutePicker } from './route.tsx'
import { AgentModelsField, HiddenProvidersField } from './visibility.tsx'
import { EffortField, EffortsField } from './efforts.tsx'
import { ShortcutRows, type Shortcuts } from './shortcuts.tsx'
import { BlockedCommandsField, BlockedScansField } from './guard.tsx'
import { IdentitiesField } from './identities.tsx'
import { Accounts, type AccountStore } from '../claude/accounts.tsx'
import { readOpen, REVEAL_EVENT, summarize, takeReveal, writeOpen, type Summary } from './sections.ts'
import { useTransfer } from './transfer.tsx'
import { BotField, ReviewReposField, ReviewScheduleField } from './review.tsx'
import type { ReviewScheduleStore } from '../review/schedule.ts'
import { AutomationPanel } from './automation.tsx'
import type { AutomationStore } from '../automation/api.ts'
import { FONTS } from '../../appearance.ts'
import { InterfaceScaleField } from './scale.tsx'
import { DevicePanel } from './device.tsx'
import { HotkeyField } from './palette.tsx'
import type { PaletteStore } from '../palette/api.ts'
import type { CardputerStore } from '../device/api.ts'
import type { ModulesStore } from '../modules.ts'
import { CodexSetup } from '../codex/setup.tsx'
import { ModulesCard } from './modules.tsx'

export function ConfigSection(props: {
  form: ConfigFormModel
  models: ModelDirectory
  /** Every model, Claude Agent included: the team profiles' picker. */
  allModels: ModelDirectory
  /** Whether this profile runs Agent Teams; undefined while unknown. */
  teams: () => Promise<boolean>
  connectors: ConnectorsStore
  accounts: AccountStore
  repos?: ReposStore
  automation?: AutomationStore
  reviewSchedule?: ReviewScheduleStore
  openReviewTask?: (sessionId: string, id: string) => boolean
  /** The Cardputer group's device status and operations. */
  device?: CardputerStore
  /** The clipboard window's status: whether its hotkey is in force. */
  palette?: PaletteStore
  /** Which optional modules are on, and the Codex plugin's state. */
  modules?: ModulesStore
  /** DSH's shortcuts service: the composer shortcuts under 模型选择; absent on hosts without one. */
  shortcuts?: Shortcuts
}): ReactNode {
  const { form, models } = props
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot)
  // Folded groups summarize their connectors' states too, so read them while the page is shown.
  useSyncExternalStore(props.connectors.subscribe, props.connectors.getSnapshot)
  useEffect(() => { void props.connectors.load() }, [props.connectors])
  const noSync = useCallback(() => () => {}, [])
  // The Cardputer group's device status is where its devices stand, read while the page is open.
  const deviceStatus = useSyncExternalStore(props.device?.subscribe ?? noSync, () => props.device?.getSnapshot().status)
  useEffect(() => props.device?.watch(), [props.device])
  const paletteStatus = useSyncExternalStore(props.palette?.subscribe ?? noSync, () => props.palette?.getSnapshot().status)
  useEffect(() => props.palette?.watch(), [props.palette])
  // On a phone some groups are left out (remote/settings.ts).
  const phone = state.phone === 'open'
  // Script tasks never travel through the phone settings bridge; they have their own RPC, gated by the same switch on the host.
  // A module switched off takes its group along (功能模块, above the groups).
  const sections = (phone ? SECTIONS.filter((section) => section === 'automation' || !PHONE_HIDDEN.includes(section)) : SECTIONS)
    .filter((section) => (section !== 'device' && section !== 'palette') || state.fields[`modules.${section}`]?.value === true)
  const codexPlugin = useSyncExternalStore(props.modules?.subscribe ?? noSync, () => props.modules?.getSnapshot().status?.codex)
  const [open, setOpen] = useState(readOpen)
  const update = useCallback((next: Set<Section>) => {
    setOpen(next)
    writeOpen(next)
  }, [])
  const toggle = (section: Section, value: boolean): void => {
    const next = new Set(open)
    if (value) next.add(section)
    else next.delete(section)
    update(next)
  }
  const page = useRef<HTMLDivElement>(null)
  const lead = useRef<HTMLParagraphElement>(null)
  const head = useRef<HTMLDivElement>(null)
  // Folding everything from far down the page would leave nothing in view: go back to the top.
  // The toolbar is stuck (the page scrolled) once it sits further below the lead than the page's gap.
  const setAll = (value: boolean): void => {
    update(value ? new Set(sections) : new Set())
    if (value || page.current === null || lead.current === null || head.current === null) return
    const gap = parseFloat(getComputedStyle(page.current).rowGap) || 0
    if (head.current.getBoundingClientRect().top - lead.current.getBoundingClientRect().bottom > gap + 1) {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      requestAnimationFrame(() => page.current?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' }))
    }
  }
  // Another surface asked for a group ("新建 Bot…" in the composer): open it and bring it into view.
  useEffect(() => {
    const reveal = (section: Section | undefined): void => {
      if (section === undefined) return
      if (!SECTIONS.includes(section)) return
      setOpen((current) => {
        const next = new Set(current).add(section)
        writeOpen(next)
        return next
      })
      requestAnimationFrame(() => document.getElementById(`ac-group-${section}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    }
    reveal(takeReveal())
    const onReveal = (event: Event): void => {
      takeReveal()
      reveal((event as CustomEvent<Section>).detail)
    }
    window.addEventListener(REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_EVENT, onReveal)
  }, [])
  // A group that starts needing attention (a sign-in expired, a value turned invalid) opens by itself, once.
  const flagged = useRef(new Set<Section>())
  const attention = state.available
    ? sections.filter((section) => summarize(section, state.fields, (id) => props.connectors.state(id), deviceStatus, paletteStatus).attention)
    : []
  const attentionKey = attention.join(',')
  useEffect(() => {
    const fresh = attention.filter((section) => !flagged.current.has(section))
    flagged.current = new Set(attention)
    if (fresh.length > 0) setOpen((current) => new Set([...current, ...fresh]))
  }, [attentionKey])
  // Leaving the page saves what is pending, then drops what could not be saved (invalid or refused).
  useEffect(() => () => { void form.leave() }, [form])
  // A phone's values were read at startup: catch up with edits made on the computer since.
  useEffect(() => { void form.refresh() }, [form])
  // The catalog changes with sign-ins and plugins, so read it on every visit.
  useEffect(() => { void models.load() }, [models])
  useEffect(() => { void props.allModels.load() }, [props.allModels])
  const transfer = useTransfer({ form, writable: state.writable, ...(props.repos === undefined ? {} : { repos: props.repos }) })

  if (!state.available) {
    return (
      <div className="ac-page">
        <p className="ac-lead">{t('lead')}</p>
        {!state.loading && <p className="ac-notice" role="status">{t(state.phone === 'locked' ? 'remoteOnly' : 'unavailable')}</p>}
        <Group section="claude"><div className="ac-row" data-wide=""><Accounts store={props.accounts} /></div></Group>
      </div>
    )
  }
  // Controls stay enabled while a save is in flight, so typing never loses focus.
  const locked = !state.writable
  const status = state.saving ? 'saving' : state.outcome ?? (state.dirty ? 'dirty' : undefined)
  const summaries = Object.fromEntries(sections.map((section) => [section, summarize(section, state.fields, (id) => props.connectors.state(id), deviceStatus, paletteStatus)])) as Record<Section, Summary>
  // While any group is open the button folds them all; with every group folded it opens them.
  const anyOpen = sections.some((section) => open.has(section))
  const foldLabel = t(anyOpen ? 'collapseAll' : 'expandAll')
  return (
    <div className="ac-page" ref={page} onBlur={() => void form.flush()}>
      <p className="ac-lead" ref={lead}>{t('lead')}</p>
      {/* Only the toolbar stays on top, so it takes one slim row however narrow the page. */}
      <div className="ac-head" ref={head}>
        <span className="ac-status" role="status" data-tone={status}>
          {status === 'saving' ? t('saving') : status === 'saved' ? t('saved') : status === 'failed' ? t('failed') : status === 'dirty' ? t('unsaved') : ''}
        </span>
        {state.outcome === 'failed' && !state.saving && (
          <>
            <button type="button" className="ah-btn" onClick={() => form.discard()}>{t('discard')}</button>
            <button type="button" className="ah-btn" data-variant="primary" onClick={() => void form.save()}>{t('retry')}</button>
          </>
        )}
        {/* Export and import cover the groups a phone does not see. */}
        {!phone && transfer.controls}
        <button type="button" className="ac-fold-all" aria-label={foldLabel} title={foldLabel} onClick={() => setAll(!anyOpen)}>
          <FoldIcon open={anyOpen} />
          <span className="ac-fold-label">{foldLabel}</span>
        </button>
      </div>
      {!phone && transfer.panel}
      {!state.writable && <p className="ac-notice" role="status">{t('readOnly')}</p>}
      {phone && state.writable && <p className="ac-notice" role="status">{t('phoneLimited')}</p>}
      <ModulesCard fields={state.fields} form={form} disabled={locked} phone={phone} store={props.modules}
        onEnabled={(name) => {
          if (name !== 'device' && name !== 'palette') return
          toggle(name, true)
          requestAnimationFrame(() => document.getElementById(`ac-group-${name}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
        }} />
      {CATEGORIES.map((category) => {
        const shownHere = category.groups.filter((section) => sections.includes(section))
        if (shownHere.length === 0) return null
        return (
          <div key={category.id} className="ac-category" role="group" aria-labelledby={`ac-cat-${category.id}`}>
            <h2 className="ac-category-title" id={`ac-cat-${category.id}`}>{t(`cat.${category.id}` as ConfigKey)}</h2>
            {shownHere.map((section) => (
              <Group key={section} section={section} summary={summaries[section]}
                open={open.has(section)} onToggle={() => toggle(section, !open.has(section))}>
                {section === 'claude' && <div className="ac-row" data-wide=""><Accounts store={props.accounts} /></div>}
                {section === 'device' && props.device !== undefined && <DevicePanel store={props.device} disabled={locked} />}
                {section === 'automation' && <AutomationPanel store={props.automation} models={props.allModels} disabled={locked} openTask={props.openReviewTask} />}
                 {section === 'review' && <ReviewScheduleField store={props.reviewSchedule} disabled={locked} openTask={props.openReviewTask} />}
                {FIELDS.filter((spec) => groupOf(spec) === section && spec.hidden !== true && shownNow(spec, state.fields) && moduleOn(spec, state.fields)).map((spec) => {
                  const id = fieldId(spec)
                  const field = state.fields[id]!
                  const disabled = locked || (phone && !phoneWritable(id))
                  if (spec.kind === 'connectors') return <ConnectorsEditor key={id} id={id} field={field} disabled={disabled} form={form} store={props.connectors} {...(props.repos === undefined ? {} : { repos: props.repos })} />
                  if (spec.kind === 'agents') return <AgentsEditor key={id} id={id} field={field} disabled={disabled} form={form} models={props.allModels} teams={props.teams} />
                  if (spec.kind === 'agentModels') {
                    // Codex models without their plugin: the offer to install or enable it, in place of the empty list.
                    const setup = spec.section === 'codex' && props.modules !== undefined && (codexPlugin === 'missing' || codexPlugin === 'off') ? <CodexSetup store={props.modules} /> : undefined
                    return <AgentModelsField key={id} id={id} field={field} disabled={disabled} form={form} models={props.allModels} setup={setup} />
                  }
                  if (spec.kind === 'providers') return <HiddenProvidersField key={id} id={id} field={field} disabled={disabled} form={form} models={props.allModels} />
                  if (spec.kind === 'effort') return <EffortField key={id} id={id} field={field} disabled={disabled} form={form} models={props.allModels} />
                  if (spec.kind === 'efforts') return <EffortsField key={id} id={id} field={field} disabled={disabled} form={form} models={props.allModels} shared={state.fields['models.effort']?.value} />
                  if (spec.kind === 'blockedScans') return <BlockedScansField key={id} id={id} field={field} disabled={disabled} form={form} />
                  if (spec.kind === 'identities') return <IdentitiesField key={id} id={id} field={field} disabled={disabled} form={form} />
                  if (spec.kind === 'blockedCommands') return <BlockedCommandsField key={id} id={id} field={field} disabled={disabled} form={form} />
                  if (spec.kind === 'reviewRepos') return <ReviewReposField key={id} id={id} field={field} disabled={disabled} form={form} {...(props.repos === undefined ? {} : { repos: props.repos })} />
                  if (spec.kind === 'hotkey') return <HotkeyField key={id} id={id} field={field} disabled={disabled} form={form} {...(props.palette === undefined ? {} : { store: props.palette })} />
                  if (spec.kind === 'uiScale') return <InterfaceScaleField key={id} fields={state.fields} disabled={disabled} form={form} />
                  if (spec.kind === 'bot') return <BotField key={id} id={id} field={field} disabled={disabled} form={form} bots={botIds(state.fields['team.agents']?.value)} optional={spec.optional} />
                  return <Field key={id} spec={spec} fields={state.fields} disabled={disabled} form={form} models={models} />
                })}
                {section === 'models' && props.shortcuts !== undefined && <ShortcutRows shortcuts={props.shortcuts} />}
              </Group>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * One module's settings. Folded, it is a single row: the name and where things stand; the
 * whole row toggles it. Unfolded, the note explains the module above its rows.
 */
export function Group(props: { section: Section; summary?: Summary; open?: boolean; onToggle?: () => void; children: ReactNode }): ReactNode {
  const { section, summary, onToggle } = props
  const title = `section.${section}` as ConfigKey
  const open = props.open ?? true
  const bodyId = `ac-body-${section}`
  return (
    <section className="ac-group" id={`ac-group-${section}`} aria-labelledby={`ac-${section}`}
      data-open={open ? '' : undefined} data-attention={summary?.attention ? '' : undefined}>
      {onToggle === undefined
        ? (
          <header className="ac-group-head">
            <h3 id={`ac-${section}`}>{t(title)}</h3>
            <p>{t(`${title}.note` as ConfigKey)}</p>
          </header>
        )
        : (
          <h3 className="ac-group-title">
            <button type="button" id={`ac-${section}`} className="ac-group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
              <span className="ac-group-chevron" aria-hidden="true">›</span>
              <span className="ac-group-name">{t(title)}</span>
              {summary?.attention && <span className="ac-group-flag">{t('attention')}</span>}
              {!open && summary !== undefined && <span className="ac-group-summary">{summary.text}</span>}
            </button>
          </h3>
        )}
      {open && (
        <div id={bodyId}>
          {onToggle !== undefined && <p className="ac-group-note">{t(`${title}.note` as ConfigKey)}</p>}
          <div className="ac-rows">{props.children}</div>
        </div>
      )}
    </section>
  )
}

/** The fold-all button's glyph: chevrons closing up while groups are open, opening out once all are folded. */
function FoldIcon(props: { open: boolean }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.open ? <><path d="m7 20 5-5 5 5" /><path d="m7 4 5 5 5-5" /></> : <><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></>}
    </svg>
  )
}

/** A `choice` value's label: `<id>.<value>`, blank being `<id>.default`. */
const choiceLabel = (id: string, value: unknown): string => t(`${id}.${typeof value === 'string' && value !== '' ? value : 'default'}` as ConfigKey)

/** Whether a field with a condition shows now (the URL of a speech service only once that service is picked). */
export const shownNow = (spec: FieldSpec, fields: FormState['fields']): boolean =>
  spec.shownWhen === undefined || fields[spec.shownWhen.field]?.value === spec.shownWhen.value

/** A field of a module that is off is left out (the Codex models while Codex is off). */
const moduleOn = (spec: FieldSpec, fields: FormState['fields']): boolean =>
  spec.section !== 'codex' || fields['modules.codex']?.value === true

/** The ids of the bots being edited on this page. */
const botIds = (value: unknown): string[] => (Array.isArray(value) ? value.map((bot) => (bot as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && id !== '') : [])

function shown(spec: FieldSpec, value: unknown): string {
  if (spec.kind === 'switch') return value === true ? t('on') : t('off')
  if (spec.kind === 'route') return value === undefined || value === '' ? t('route.default') : String(value)
  if (spec.kind === 'font') return t(`font.${String(value ?? 'default')}` as ConfigKey)
  if (spec.kind === 'choice') return choiceLabel(fieldId(spec), value)
  return value === undefined || value === '' ? t('empty') : String(value)
}

export function Field(props: { spec: FieldSpec; fields: FormState['fields']; disabled: boolean; form: ConfigFormModel; models: ModelDirectory }): ReactNode {
  const { spec, fields, disabled, form } = props
  const id = fieldId(spec)
  const state: FieldState = fields[id]!
  const label = t(id as ConfigKey)
  const hint = t(`${id}.hint` as ConfigKey)
  const inputId = `ac-field-${id}`
  const wide = spec.kind === 'text' || spec.kind === 'textarea' || spec.kind === 'route'
  const provider = spec.provider === undefined ? undefined : fields[spec.provider]
  const overridden = state.overridden || provider?.overridden === true

  const badge = (
    <span className="ac-badges">
      {overridden
        ? <>
            <span className="ac-tag">{t('overridden')}</span>
            <button type="button" className="ac-link" disabled={disabled} onClick={() => form.reset(id)}
              title={t('defaultValue', { value: shown(spec, state.fallback) })}>{t('reset')}</button>
          </>
        : <span className="ac-muted">{t('default')}</span>}
    </span>
  )

  let control: ReactNode
  if (spec.kind === 'route') {
    control = (
      <RoutePicker id={inputId} disabled={disabled} models={props.models}
        provider={typeof provider?.value === 'string' ? provider.value : undefined}
        model={typeof state.value === 'string' ? state.value : undefined}
        {...(id === 'discussion.model' ? { exclude: ['claude-agent', 'cursor-agent', 'agent-hub-bot'] } : {})}
        onPick={(route) => form.editRoute(id, route)}
        {...(id === 'discussion.model' ? { defaultLabel: t('discussion.model.default') } : id === 'claude.helperModel' ? { defaultLabel: t('claude.helperModel.default') } : id === 'review.helperModel' ? { defaultLabel: t('review.helperModel.default') } : {})} />
    )
  } else if (spec.kind === 'switch') {
    const checked = state.value === true
    control = (
      <button type="button" role="switch" id={inputId} className="ac-switch" aria-checked={checked} aria-label={label}
        disabled={disabled} onClick={() => form.edit(id, !checked)}>
        <span className="ac-thumb" />
      </button>
    )
  } else if (spec.kind === 'font') {
    control = (
      <select id={inputId} className="ac-input ac-select" disabled={disabled} value={typeof state.value === 'string' ? state.value : 'default'}
        onChange={(event) => form.edit(id, event.target.value)}>
        {FONTS.map((font) => <option key={font} value={font}>{t(`font.${font}`)}</option>)}
      </select>
    )
  } else if (spec.kind === 'choice') {
    control = (
      <select id={inputId} className="ac-input ac-select" disabled={disabled} value={typeof state.value === 'string' ? state.value : ''}
        onChange={(event) => form.edit(id, event.target.value)}>
        {(spec.options ?? []).map((option) => <option key={option} value={option}>{choiceLabel(id, option)}</option>)}
      </select>
    )
  } else if (spec.kind === 'textarea') {
    control = (
      <textarea id={inputId} className="ac-input" rows={spec.rows ?? 3} disabled={disabled} value={state.text ?? (typeof state.value === 'string' ? state.value : '')}
        data-markdown={spec.markdown ? '' : undefined} spellCheck={spec.markdown ? false : undefined}
        placeholder={t(`${id}.placeholder` as ConfigKey)} onChange={(event) => form.edit(id, event.target.value)} />
    )
  } else {
    const numeric = spec.kind === 'integer' || spec.kind === 'number'
    const text = state.text ?? (state.value === undefined ? '' : String(state.value))
    control = (
      <input id={inputId} className="ac-input" data-numeric={numeric ? '' : undefined} type="text" disabled={disabled}
        inputMode={spec.kind === 'integer' ? 'numeric' : spec.kind === 'number' ? 'decimal' : undefined}
        aria-invalid={state.invalid || undefined} value={text}
        placeholder={numeric ? String(state.fallback ?? '') : ''}
        onChange={(event) => form.edit(id, event.target.value)} />
    )
  }

  return (
    <div className="ac-row" data-wide={wide ? '' : undefined}>
      <div className="ac-row-text">
        <div className="ac-row-head">
          <label id={`${inputId}-label`} htmlFor={inputId} className="ac-label">{label}</label>
          {badge}
        </div>
        <p className="ac-hint" data-invalid={state.invalid ? '' : undefined}>
          {state.invalid
            ? t(spec.kind === 'integer' ? 'invalidInteger' : 'invalidNumber', { min: spec.min ?? '', max: spec.max ?? '' })
            : hint}
        </p>
      </div>
      <div className="ac-control">{control}</div>
    </div>
  )
}
