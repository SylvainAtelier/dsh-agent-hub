/**
 * Account switch for the usage popover: one line per provider, its accounts
 * as chips, the active one marked. A provider with fewer than two accounts
 * has nothing to switch to and is left out; with none left the section hides.
 * Adding, checking and removing accounts stay in settings.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { t } from '../i18n.ts'
import type { AccountStore } from '../claude/accounts.tsx'
import type { CodexAccountStore } from '../codex/accounts.tsx'
import { codexAccountLabels } from '../codex/labels.ts'
import type { ProviderId } from '../../usage/types.ts'

interface Chip { id: string; label: string; title?: string; active: boolean }

function Row(props: {
  provider: ProviderId
  chips: Chip[]
  busy: boolean
  error?: string
  onSelect: (id: string) => void
}): ReactNode {
  const { provider, chips, busy, error, onSelect } = props
  const [pending, setPending] = useState<string | undefined>(undefined)
  // The store flips busy synchronously on select, so busy ending means the switch settled.
  useEffect(() => { if (!busy) setPending(undefined) }, [busy])
  const name = t(`provider.${provider}`)
  return (
    <div className="uh-sw-row" aria-busy={busy}>
      <span className="uh-sw-provider"><span className="uh-dot" data-p={provider} />{name}</span>
      <div className="uh-sw-chips" role="group" aria-label={name}>
        {chips.map((chip) => (
          <button key={chip.id} type="button" className="uh-sw-chip" title={chip.title}
            aria-pressed={chip.active} data-pending={pending === chip.id ? '' : undefined}
            disabled={busy && !chip.active}
            onClick={() => { if (chip.active || busy) return; setPending(chip.id); onSelect(chip.id) }}>
            <span className="uh-sw-label">{chip.label}</span>
          </button>
        ))}
      </div>
      {error !== undefined && <p className="uh-sw-error" role="alert">{error}</p>}
    </div>
  )
}

export function AccountSwitch(props: { claude: AccountStore; codex: CodexAccountStore }): ReactNode {
  const { claude, codex } = props
  const claudeState = useSyncExternalStore(claude.subscribe, claude.getSnapshot)
  const codexState = useSyncExternalStore(codex.subscribe, codex.getSnapshot)
  useEffect(() => { void claude.load() }, [claude])
  useEffect(() => { void codex.load() }, [codex])

  const claudeChips: Chip[] = (claudeState.state?.accounts ?? []).map((account) => ({
    id: account.id,
    label: account.id === 'default' && !account.renamed ? t('switch.default') : account.name,
    ...(account.account === undefined ? {} : { title: account.account }),
    active: claudeState.state?.active === account.id,
  }))
  const codexLabels = codexAccountLabels(codexState.accounts)
  const codexChips: Chip[] = codexState.available ? codexState.accounts.map((account) => {
    const label = codexLabels.get(account.id) ?? account.id
    const title = account.email ?? account.label
    return { id: account.id, label, ...(title !== undefined ? { title } : {}), active: account.active === true }
  }) : []
  const showClaude = claudeChips.length > 1
  const showCodex = codexChips.length > 1
  if (!showClaude && !showCodex) return null

  return (
    <section className="uh-sw" aria-label={t('switch.title')}>
      <div className="uh-sw-head">
        <span>{t('switch.title')}</span>
        <span className="uh-muted">{t('switch.next')}</span>
      </div>
      {showClaude && <Row provider="claude" chips={claudeChips} busy={claudeState.busy} error={claudeState.error}
        onSelect={(id) => void claude.action('select', id)} />}
      {showCodex && <Row provider="codex" chips={codexChips} busy={codexState.busy} error={codexState.error}
        onSelect={(id) => void codex.select(id)} />}
    </section>
  )
}
