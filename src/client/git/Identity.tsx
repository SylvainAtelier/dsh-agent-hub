/**
 * Who the commit box commits as: one line between the message and the commit
 * button, and the picker it opens. The identity lives in git's own config
 * (identity.ts); this only shows where it comes from and binds the repository
 * to a preset or a new identity. A repository that is not bound on purpose
 * asks before its first commit from here, and the commit the host makes is
 * refused unless git still uses the identity shown.
 */

import type { ReactNode, RefObject } from 'react'
import { bound, sameEmail, validEmail, validKey, validName, type EffectiveIdentity, type Identity } from '../../git/identity.ts'
import type { GitStatus } from '../../git/types.ts'
import type { PaneApi } from './context.ts'
import { t, type GitKey } from './i18n.ts'
import { IconChevronDown, IconPlus, IconUndo } from './icons.tsx'
import type { MenuAnchor, MenuEntry } from './kit.tsx'
import { canRemember, remember } from './presets.ts'
import type { RepoStore } from './store.ts'

type State = 'bound' | 'inherited' | 'none' | 'env'

const stateOf = (identity: EffectiveIdentity | undefined): State =>
  identity === undefined ? 'none' : identity.source === 'env' ? 'env' : bound(identity) ? 'bound' : 'inherited'

const SOURCE: Record<EffectiveIdentity['source'], GitKey> = {
  local: 'ident.src.local', include: 'ident.src.include', global: 'ident.src.global', system: 'ident.src.system', env: 'ident.src.env',
}

/** The original author an amend would keep, when it is someone else. */
export interface AmendAuthor {
  name: string
  email: string
  reset: boolean
  toggle(): void
}

export function IdentityRow(props: { status: GitStatus; narrow: boolean; anchor: RefObject<HTMLButtonElement>; onOpen(): void; amend?: AmendAuthor }): ReactNode {
  const { identity } = props.status
  const state = stateOf(identity)
  const tag = identity === undefined || state === 'bound' ? undefined : t(SOURCE[identity.source])
  const label = identity === undefined ? t('ident.none') : t('ident.aria', { name: identity.name, email: identity.email, source: t(SOURCE[identity.source]) })
  const { amend } = props
  return (
    <div className="gp-ident-wrap">
      <button ref={props.anchor} type="button" className="gp-ident" data-state={state} data-narrow={props.narrow ? '' : undefined}
        aria-haspopup="menu" aria-label={label} title={identity === undefined ? undefined : `${identity.name} <${identity.email}>`} onClick={props.onOpen}>
        <span className="gp-avatar gp-ident-avatar" aria-hidden="true">{identity === undefined ? '?' : identity.name.trim().slice(0, 1).toUpperCase()}</span>
        {identity === undefined
          ? <span className="gp-ident-name">{t('ident.none')}</span>
          : (
            <>
              <span className="gp-ident-name">{identity.name}</span>
              <span className="gp-ident-email">{identity.email}</span>
            </>
          )}
        {tag !== undefined && <span className="gp-ident-tag">{tag}</span>}
        <IconChevronDown size={12} className="gp-ident-chevron" />
      </button>
      {amend !== undefined && (
        <div className="gp-ident-note" role="status">
          <span>{amend.reset ? t('ident.reset') : t('ident.keep', { name: amend.name })}</span>
          <button type="button" className="gp-link gp-ident-link" onClick={amend.toggle}>{amend.reset ? t('ident.keepOriginal') : t('ident.useMine')}</button>
        </div>
      )}
    </div>
  )
}

export const anchorOf = (element: HTMLElement | null): MenuAnchor => {
  const rect = element?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)
  return { x: rect.left, y: rect.bottom, rect }
}

/** Bind the repository; a new identity (or the old global one) becomes a preset when asked to. */
async function bind(repo: RepoStore, identity: Identity, keep: boolean): Promise<boolean> {
  const reply = await repo.run({ op: 'identity-set', identity }, { done: 'ident.done', doneParams: { name: identity.name } })
  if (reply.ok && keep) {
    const saved = await remember(identity).catch(() => false)
    if (!saved) repo.toast('error', t('ident.notSaved'))
  }
  return reply.ok
}

function newIdentity(pane: PaneApi, repo: RepoStore, then?: (email: string) => void): void {
  const keep = canRemember()
  pane.dialog({
    title: t('ident.newTitle'),
    fields: [
      { id: 'name', label: t('ident.name'), kind: 'text', validate: validName, error: t('ident.badName') },
      { id: 'email', label: t('ident.email'), kind: 'text', placeholder: 'name@example.com', validate: validEmail, error: t('ident.badEmail') },
      { id: 'key', label: t('ident.key'), kind: 'text', validate: validKey, error: t('ident.badKey') },
      ...(keep ? [{ id: 'keep', label: t('ident.remember'), kind: 'check' as const, value: true }] : []),
    ],
    confirm: then === undefined ? t('ident.bind') : t('ident.bindCommit'),
    onConfirm: async (values) => {
      const key = String(values.key ?? '').trim()
      const identity: Identity = { name: String(values.name).trim(), email: String(values.email).trim(), ...(key === '' ? {} : { signingKey: key }) }
      if (await bind(repo, identity, values.keep === true)) then?.(identity.email)
    },
  })
}

/**
 * The picker. `then` (a commit waiting on the identity) runs once the repository is bound,
 * with the email it was bound to; `confirm` says why the picker opened.
 */
export async function openIdentityPicker(pane: PaneApi, repo: RepoStore, status: GitStatus, anchor: MenuAnchor, then?: (email: string) => void): Promise<void> {
  const reply = await repo.request({ op: 'identities' })
  if (!reply.ok) {
    repo.toast('error', reply.error.message)
    return
  }
  const { presets, stashed, usual } = reply.value
  const current = status.identity
  const env = current?.source === 'env'
  // Presets first, then the old global identity, then a binding made elsewhere (a terminal).
  const choices: Array<{ identity: Identity; preset: boolean; note?: GitKey }> = presets.map((identity) => ({ identity, preset: true }))
  if (stashed !== undefined) choices.push({ identity: stashed, preset: false, note: 'ident.stashed' })
  if (current !== undefined && bound(current) && !env && !choices.some((choice) => sameEmail(choice.identity.email, current.email))) {
    choices.push({ identity: { name: current.name, email: current.email }, preset: false })
  }
  const entries: MenuEntry[] = [{ heading: env ? t('ident.envHeading') : then !== undefined ? t('ident.confirm') : t('ident.heading') }]
  choices.forEach((choice, index) => {
    const hints = [choice.identity.email]
    if (choice.note !== undefined) hints.push(t(choice.note))
    else if (sameEmail(usual, choice.identity.email)) hints.push(t('ident.usual'))
    entries.push({
      id: `pick:${index}`, label: choice.identity.name, hint: hints.join(' · '), disabled: env,
      ...(current !== undefined && bound(current) && !env ? { checked: sameEmail(current.email, choice.identity.email) } : {}),
    })
  })
  if (!env) {
    entries.push({ separator: true }, { id: 'new', label: t('ident.new'), icon: <IconPlus size={14} /> })
    if (current?.source === 'local') entries.push({ id: 'unset', label: t('ident.unset'), icon: <IconUndo size={14} /> })
  }
  pane.menu({
    anchor,
    entries,
    label: t('ident.label'),
    className: 'gp-ident-menu',
    onSelect: (id) => {
      if (id === 'new') return newIdentity(pane, repo, then)
      if (id === 'unset') {
        void repo.run({ op: 'identity-set' }, { done: 'ident.cleared' })
        return
      }
      const choice = choices[Number(id.slice(5))]
      if (choice === undefined) return
      void bind(repo, choice.identity, !choice.preset).then((ok) => { if (ok) then?.(choice.identity.email) })
    },
  })
}
