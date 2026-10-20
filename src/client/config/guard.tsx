/**
 * Blocked commands (guard.ts), two rows of 全局指令:
 * - `prompt.blockedScans`: tick the built-in find scans, each shown as the commands it stops.
 * - `prompt.blockedCommands`: the user's own commands, added one at a time as typed in a shell.
 */

import { useRef, useState, type ReactNode } from 'react'
import { commandPattern, SCAN_RULES, type ScanRule } from '../../guard.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'
import { Check } from './visibility.tsx'

export interface Props {
  id: string
  field: FieldState
  disabled: boolean
  form: ConfigFormModel
}

/** The commands each built-in rule refuses, as typed in a shell. */
const COMMANDS: Record<ScanRule, string> = {
  root: 'find /',
  mount: 'find /c · find /d/',
  drive: 'find C:/ · find C:\\',
  proc: 'find /proc · find /proc/registry',
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/** A row's label, default/override badge and hint. */
export function Head(props: Props & { labelFor?: string }): ReactNode {
  const { id, field, disabled, form } = props
  const label = t(id as ConfigKey)
  return (
    <div className="ac-row-text">
      <div className="ac-row-head">
        {props.labelFor === undefined
          ? <span className="ac-label" id={`ac-field-${id}`}>{label}</span>
          : <label className="ac-label" id={`ac-field-${id}`} htmlFor={props.labelFor}>{label}</label>}
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
  )
}

/** `prompt.blockedScans`: one checkbox per built-in rule. */
export function BlockedScansField(props: Props): ReactNode {
  const enabled = new Set(strings(props.field.value))
  // Stored in rule order, so ticking back to the default set reads as the default.
  const toggle = (rule: ScanRule, on: boolean): void => props.form.edit(props.id, SCAN_RULES.filter((entry) => (entry === rule ? on : enabled.has(entry))))
  return (
    <div className="ac-row" data-wide="">
      <Head {...props} />
      <div className="ac-control">
        <div className="ac-checks" data-mono="" role="group" aria-labelledby={`ac-field-${props.id}`}>
          {SCAN_RULES.map((rule) => (
            <Check key={rule} checked={enabled.has(rule)} disabled={props.disabled}
              label={COMMANDS[rule]} detail={t(`guard.${rule}` as ConfigKey)}
              onChange={(on) => toggle(rule, on)} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * `prompt.blockedCommands`: the list, each entry removable, above one input
 * that adds an entry on Enter or 添加. An entry holding more than one command,
 * or one already listed, is explained under the input instead of added.
 */
export function BlockedCommandsField(props: Props): ReactNode {
  return <StringListField {...props} placeholder={t('prompt.blockedCommands.placeholder')}
    problem={(text) => (commandPattern(text) === undefined ? t('guard.multiple') : undefined)} />
}

/** A list of strings, each removable, above one input that adds an entry; `problem` refuses one. */
export function StringListField(props: Props & { placeholder: string; problem?(text: string): string | undefined }): ReactNode {
  const { id, disabled, form } = props
  const entries = strings(props.field.value)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const inputId = `ac-input-${id}`
  const text = draft.trim()
  const problem = text === '' ? undefined
    : props.problem?.(text) ?? (entries.includes(text) ? t('guard.duplicate') : undefined)
  const add = (): void => {
    if (text === '' || problem !== undefined) return
    form.edit(id, [...entries, text])
    setDraft('')
  }
  const remove = (entry: string): void => {
    form.edit(id, entries.filter((other) => other !== entry))
    input.current?.focus()
  }
  return (
    <div className="ac-row" data-wide="">
      <Head {...props} labelFor={inputId} />
      <div className="ac-control ac-rules">
        {entries.length > 0 && (
          <ul className="ac-rule-list" aria-labelledby={`ac-field-${id}`}>
            {entries.map((entry) => (
              <li key={entry} className="ac-rule">
                <code className="ac-rule-text">{entry}</code>
                <button type="button" className="ac-rule-remove" disabled={disabled}
                  aria-label={t('guard.remove', { command: entry })} title={t('guard.remove', { command: entry })}
                  onClick={() => remove(entry)}>×</button>
              </li>
            ))}
          </ul>
        )}
        {/* Not a <form>: the host's settings page may already sit in one. */}
        <div className="ac-rule-form">
          <input ref={input} id={inputId} className="ac-input" type="text" disabled={disabled} value={draft}
            placeholder={props.placeholder} enterKeyHint="done"
            spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
            aria-invalid={problem !== undefined || undefined} aria-describedby={problem === undefined ? undefined : `${inputId}-problem`}
            onChange={(event) => setDraft(event.target.value)}
            // Enter that confirms an IME candidate is not a submit.
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add() } }} />
          <button type="button" className="ah-btn" disabled={disabled || text === '' || problem !== undefined} onClick={add}>{t('guard.add')}</button>
          {problem !== undefined && <p className="ac-hint ac-rule-problem" id={`${inputId}-problem`} data-invalid="" role="alert">{problem}</p>}
        </div>
      </div>
    </div>
  )
}
