/**
 * `git.identities`: the commit identities the Git pane binds a repository to,
 * synced with the profile. Each is listed with its email and signing key and
 * can be removed; one form below adds another. Binding itself happens in the
 * pane, where the repository is; this list only keeps what to bind with.
 */

import { useRef, useState, type ReactNode } from 'react'
import { identityOf, sameEmail, validEmail, validKey, validName, type Identity } from '../../git/identity.ts'
import { Head, type Props } from './guard.tsx'
import { t } from './i18n.ts'

const presetsOf = (value: unknown): Identity[] =>
  (Array.isArray(value) ? value : []).map(identityOf).filter((identity): identity is Identity => identity !== undefined)

const EMPTY = { name: '', email: '', key: '' }

export function IdentitiesField(props: Props): ReactNode {
  const { id, disabled, form } = props
  const entries = presetsOf(props.field.value)
  const [draft, setDraft] = useState(EMPTY)
  const first = useRef<HTMLInputElement>(null)
  const inputId = `ac-input-${id}`
  const touched = draft.name !== '' || draft.email !== '' || draft.key !== ''
  // The first field with a problem, and what it is.
  const [bad, problem]: [keyof typeof EMPTY | undefined, string | undefined] = !touched ? [undefined, undefined]
    : draft.name.trim() !== '' && !validName(draft.name) ? ['name', t('git.identities.badName')]
      : draft.email.trim() !== '' && !validEmail(draft.email) ? ['email', t('git.identities.badEmail')]
        : !validKey(draft.key) ? ['key', t('git.identities.badKey')]
          : entries.some((entry) => sameEmail(entry.email, draft.email)) ? ['email', t('git.identities.duplicate')]
            : [undefined, undefined]
  const ready = problem === undefined && validName(draft.name) && validEmail(draft.email)
  const add = (): void => {
    if (!ready) return
    const key = draft.key.trim()
    form.edit(id, [...entries, { name: draft.name.trim(), email: draft.email.trim(), ...(key === '' ? {} : { signingKey: key }) }])
    setDraft(EMPTY)
    first.current?.focus()
  }
  const remove = (email: string): void => {
    form.edit(id, entries.filter((entry) => !sameEmail(entry.email, email)))
    first.current?.focus()
  }
  const input = (field: keyof typeof EMPTY, label: string, placeholder: string): ReactNode => (
    <label className="ac-ident-input">
      <span className="ac-ident-label">{label}</span>
      <input ref={field === 'name' ? first : undefined} id={field === 'name' ? inputId : undefined} className="ac-input" type={field === 'email' ? 'email' : 'text'}
        disabled={disabled} value={draft[field]} placeholder={placeholder} enterKeyHint={field === 'key' ? 'done' : 'next'}
        spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
        aria-invalid={bad === field || undefined} aria-describedby={bad === field ? `${inputId}-problem` : undefined}
        onChange={(event) => { const value = event.target.value; setDraft((old) => ({ ...old, [field]: value })) }}
        // Enter that confirms an IME candidate is not a submit.
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add() } }} />
    </label>
  )
  return (
    <div className="ac-row" data-wide="">
      <Head {...props} labelFor={inputId} />
      <div className="ac-control ac-rules">
        {entries.length > 0 && (
          <ul className="ac-rule-list" aria-labelledby={`ac-field-${id}`}>
            {entries.map((entry) => (
              <li key={entry.email.toLowerCase()} className="ac-rule ac-ident">
                <span className="ac-ident-avatar" aria-hidden="true">{entry.name.slice(0, 1).toUpperCase()}</span>
                <span className="ac-ident-text">
                  <span className="ac-ident-name">{entry.name}</span>
                  <span className="ac-ident-email">{entry.email}{entry.signingKey === undefined ? '' : ` · ${t('git.identities.signed', { key: entry.signingKey })}`}</span>
                </span>
                <button type="button" className="ac-rule-remove" disabled={disabled}
                  aria-label={t('git.identities.remove', { name: entry.name })} title={t('git.identities.remove', { name: entry.name })}
                  onClick={() => remove(entry.email)}>×</button>
              </li>
            ))}
          </ul>
        )}
        {/* Not a <form>: the host's settings page may already sit in one. */}
        <div className="ac-ident-form">
          {input('name', t('git.identities.name'), 'Ada Lovelace')}
          {input('email', t('git.identities.email'), 'ada@example.com')}
          {input('key', t('git.identities.key'), t('git.identities.keyPlaceholder'))}
          <button type="button" className="ah-btn" disabled={disabled || !ready} onClick={add}>{t('guard.add')}</button>
          {problem !== undefined && <p className="ac-hint ac-rule-problem" id={`${inputId}-problem`} data-invalid="" role="alert">{problem}</p>}
        </div>
      </div>
    </div>
  )
}
