/**
 * The offer to install or switch on dsh-codex-subscription, where Codex is missing: the usage
 * card's Codex row, the Codex models under 模型选择 and the 功能模块 card. One line says what is
 * missing and what it brings, one button does it through DSH's plugin manager; a plugin that
 * runs only after a restart says so.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { CODEX_PLUGIN } from '../../modules.ts'
import type { ModulesStore } from '../modules.ts'
import { t } from '../i18n.ts'

const CSS = `
.ah-codex-setup {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--ah-info) 30%, var(--ah-line)); border-inline-start: 3px solid var(--ah-info);
  border-radius: var(--ah-radius); background: color-mix(in srgb, var(--ah-info) 7%, transparent);
  font-size: 12px; line-height: 18px;
}
.ah-codex-setup[data-tone="bad"] { border-color: color-mix(in srgb, var(--ah-danger) 30%, var(--ah-line)); border-inline-start-color: var(--ah-danger); background: color-mix(in srgb, var(--ah-danger) 7%, transparent); }
.ah-codex-setup-icon { flex: none; align-self: flex-start; margin-top: 1px; fill: none; stroke: var(--ah-info-ink); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ah-codex-setup[data-tone="bad"] .ah-codex-setup-icon { stroke: var(--ah-danger-ink); }
.ah-codex-setup-text { flex: 1 1 200px; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.ah-codex-setup-text strong { display: block; font-weight: 600; }
.ah-codex-setup-text span { color: var(--ah-fg2); }
.ah-codex-setup-text code { font-family: var(--ah-mono, ui-monospace, monospace); font-size: 11px; }
.ah-codex-setup > .ah-btn { flex: none; margin-inline-start: auto; }
@media (pointer: coarse) { .ah-codex-setup > .ah-btn { min-height: 44px; } }
`

export function injectCodexSetupStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.codex-setup'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}

/** Shown while the Codex module is on and its plugin is missing or off (or a restart is due); nothing otherwise. */
export function CodexSetup(props: { store: ModulesStore; changed?: () => void }): ReactNode {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const plugin = snapshot.status?.codex
  if (snapshot.status?.modules.codex !== true) return null
  if (snapshot.codexRestart === true) {
    return (
      <div className="ah-codex-setup" role="status">
        <Icon />
        <p className="ah-codex-setup-text"><strong>{t('codexSetup.restart')}</strong></p>
      </div>
    )
  }
  if (plugin !== 'missing' && plugin !== 'off') return null
  const action = plugin === 'missing' ? 'install' : 'enable'
  const busy = snapshot.codexBusy
  return (
    <div className="ah-codex-setup" role="status" data-tone={snapshot.codexError === undefined ? undefined : 'bad'}>
      <Icon />
      <p className="ah-codex-setup-text">
        <strong>{named(t(plugin === 'missing' ? 'err.plugin-missing' : 'err.plugin-off'))}</strong>
        <span>{snapshot.codexError === undefined ? t(plugin === 'missing' ? 'codexSetup.missing' : 'codexSetup.off') : t('codexSetup.failed', { error: snapshot.codexError })}</span>
      </p>
      <button type="button" className="ah-btn" data-variant="primary" disabled={busy} aria-busy={busy || undefined}
        onClick={() => void props.store.setUpCodex(action, props.changed)}>
        {t(busy ? (action === 'install' ? 'codexSetup.installing' : 'codexSetup.enabling') : action === 'install' ? 'codexSetup.install' : 'codexSetup.enable')}
      </button>
    </div>
  )
}

/** The plugin's name in a sentence, set as code. */
function named(text: string): ReactNode {
  const [before, after] = text.split(CODEX_PLUGIN)
  return after === undefined ? text : <>{before}<code>{CODEX_PLUGIN}</code>{after}</>
}

function Icon(): ReactNode {
  return (
    <svg className="ah-codex-setup-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
    </svg>
  )
}
