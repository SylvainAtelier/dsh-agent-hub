/**
 * 设置 → Agent Hub → 连接器: remote MCP servers signed in to once for every
 * model. A connector exists while it is in the list; adding one starts its
 * sign-in at once, removing one signs out. Each card shows where it stands and
 * offers the one next step; a token is the fallback a card can open in place,
 * and a server that registers no clients (Slack) asks for an app's client ID.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  APP_REDIRECT, connectorId, connectorName, DATADOG_SITES, DATADOG_TOOLSETS, datadogOptions, datadogUrl, isSlack, presetOf, PRESETS, tokenUrlOf, validServerUrl,
  type ConnectorEntry, type ConnectorPhase, type DatadogOptions,
} from '../../connectors/types.ts'
import { samePath } from '../../repos/types.ts'
import type { ConnectorsStore } from '../connectors/api.ts'
import type { ReposStore } from '../repos/api.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { t, type ConfigKey } from './i18n.ts'

/** Server names the hub uses itself. */
const RESERVED = ['dsh']

/** Which form a card has open in place. */
type Form = 'token' | 'client'

/** What to paste, for services whose token is not an obvious one. */
const TOKEN_HINTS: Partial<Record<string, ConfigKey>> = { slack: 'conn.token.hint.slack', datadog: 'conn.token.hint.datadog' }

const hue = (id: string): number => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 11)

/** Open the sign-in page; a blocked pop-up leaves the card's "open again" link. */
function openPage(url: string): void {
  const page = window.open(url, '_blank')
  if (page !== null) page.opener = null
}

function stateText(state: ConnectorPhase | undefined): string {
  switch (state?.phase) {
    case undefined: case 'connecting': return t('conn.connecting')
    case 'disconnected': return t('conn.disconnected')
    case 'authorizing': return t('conn.authorizing')
    case 'token': return t('conn.needsToken')
    case 'client': return t('conn.needsClient')
    case 'connected': return t(state.via === 'token' ? 'conn.connectedToken' : 'conn.connected', { n: state.tools })
    case 'expired': return t('conn.expired')
    case 'error': return state.reason === 'rejected' ? t('conn.rejected') : t('conn.error', { message: state.message })
  }
}

const tone = (state: ConnectorPhase | undefined): string =>
  state?.phase === 'connected' ? 'ok' : state?.phase === 'error' || state?.phase === 'expired' ? 'bad' : state?.phase === 'disconnected' ? 'off' : 'busy'

export function ConnectorsEditor(props: { id: string; field: FieldState; disabled: boolean; form: ConfigFormModel; store: ConnectorsStore; repos?: ReposStore }): ReactNode {
  const { form, store, disabled } = props
  const list = (Array.isArray(props.field.value) ? props.field.value : []) as ConnectorEntry[]
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [custom, setCustom] = useState<string | null>(null)
  const [open, setOpen] = useState<{ id: string; form: Form } | null>(null)

  useEffect(() => {
    void store.load()
    const wake = (): void => { if (document.visibilityState === 'visible') void store.load() }
    window.addEventListener('focus', wake)
    return () => window.removeEventListener('focus', wake)
  }, [store])

  const connect = async (entry: ConnectorEntry): Promise<void> => {
    setOpen(null)
    const state = await store.run(entry.id, { op: 'connect', id: entry.id, url: entry.url })
    if (state?.phase === 'authorizing') openPage(state.authorizeUrl)
    if (state?.phase === 'token' || state?.phase === 'client') setOpen({ id: entry.id, form: state.phase })
  }
  const add = (url: string): void => {
    const entry = { id: connectorId(url.trim(), [...list.map((item) => item.id), ...RESERVED]), url: url.trim() }
    form.edit(props.id, [...list, entry])
    setCustom(null)
    // Authentication belongs to a saved endpoint, never an unsaved draft.
    void form.save().then(() => {
      if (form.getSnapshot().outcome === 'saved') return connect(entry)
    })
  }
  const link = (entry: ConnectorEntry, repos: readonly string[]): void => {
    form.edit(props.id, list.map((item) => {
      if (item.id !== entry.id) return item
      const { repos: _old, ...rest } = item
      return repos.length === 0 ? rest : { ...rest, repos: [...repos] }
    }))
  }
  // The client ID is the connector's own setting: saved first, then the sign-in reads it.
  const useClient = (entry: ConnectorEntry, clientId: string): void => {
    const next = { ...entry, clientId: clientId.trim() }
    form.edit(props.id, list.map((item) => (item.id === entry.id ? next : item)))
    setOpen(null)
    void form.save().then(() => {
      if (form.getSnapshot().outcome === 'saved') return connect(next)
    })
  }
  // A new endpoint is a new sign-in: the card asks to connect again once it is saved.
  const retarget = (entry: ConnectorEntry, url: string): void => {
    form.edit(props.id, list.map((item) => (item.id === entry.id ? { ...item, url } : item)))
  }
  const remove = (entry: ConnectorEntry): void => {
    void store.run(entry.id, { op: 'disconnect', id: entry.id }).then((state) => {
      if (state?.phase === 'error') return
      const current = form.getSnapshot().fields[props.id]?.value as ConnectorEntry[] | undefined
      form.edit(props.id, (current ?? list).filter((item) => item.id !== entry.id))
    })
  }

  const offered = PRESETS.filter((preset) => !list.some((entry) => presetOf(entry.url)?.id === preset.id))
  return (
    <div className="ac-conns">
      {list.map((entry) => (
        <Card key={entry.id} entry={entry} state={store.state(entry.id)} disabled={disabled} open={open?.id === entry.id ? open.form : null}
          onConnect={() => void connect(entry)}
          onCancel={() => void store.run(entry.id, { op: 'cancel', id: entry.id })}
          onOpen={(form) => setOpen(form === null ? null : { id: entry.id, form })}
          onSubmitToken={async (token) => {
            const state = await store.run(entry.id, { op: 'token', id: entry.id, url: entry.url, token })
            if (state?.phase !== 'error') setOpen(null)
          }}
          onSubmitClient={(clientId) => useClient(entry, clientId)}
          onRemove={() => remove(entry)}>
          {props.repos !== undefined && (
            <RepoLinks store={props.repos} value={entry.repos ?? []} disabled={disabled} hint={isSlack(entry.url) ? 'conn.repos.hint.slack' : 'conn.repos.hint'}
              onChange={(repos) => link(entry, repos)} />
          )}
          {datadogOptions(entry.url) !== undefined && (
            <DatadogFields value={datadogOptions(entry.url)!} disabled={disabled} onChange={(options) => retarget(entry, datadogUrl(entry.url, options))} />
          )}
        </Card>
      ))}
      {custom === null
        ? (
            <div className="ac-chips">
              {offered.map((preset) => (
                <button key={preset.id} type="button" className="ac-chip" disabled={disabled} onClick={() => add(preset.url)}>
                  ＋ {preset.name}
                </button>
              ))}
              <button type="button" className="ac-chip" disabled={disabled} onClick={() => setCustom('')}>＋ {t('conn.custom')}</button>
            </div>
          )
        : (
            <form className="ac-conn-form" onSubmit={(event) => {
              event.preventDefault()
              if (validServerUrl(custom)) add(custom)
            }}>
              <input className="ac-input" type="url" inputMode="url" autoFocus spellCheck={false} autoComplete="off" value={custom}
                placeholder="https://mcp.example.com/mcp" aria-label={t('conn.url')}
                aria-invalid={custom.trim() !== '' && !validServerUrl(custom) ? true : undefined}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') setCustom(null) }} />
              <button type="submit" className="ah-btn" data-variant="primary" disabled={disabled || !validServerUrl(custom)}>{t('conn.add')}</button>
              <button type="button" className="ah-btn" onClick={() => setCustom(null)}>{t('conn.cancel')}</button>
              <p className="ac-hint ac-conn-form-hint">{t('conn.url.hint')}</p>
            </form>
          )}
    </div>
  )
}

function Card(props: {
  entry: ConnectorEntry
  state: ConnectorPhase | undefined
  disabled: boolean
  open: Form | null
  onConnect(): void
  onCancel(): void
  onOpen(form: Form | null): void
  onSubmitToken(token: string): Promise<void>
  onSubmitClient(clientId: string): void
  onRemove(): void
  children?: ReactNode
}): ReactNode {
  const { entry, state, disabled } = props
  const name = connectorName(entry)
  const preset = presetOf(entry.url)
  const tokenHint = preset === undefined ? undefined : TOKEN_HINTS[preset.id]
  const phase = state?.phase ?? 'connecting'
  const retry = phase === 'disconnected' ? t('conn.connect') : phase === 'expired' ? t('conn.reconnect') : t('conn.retry')
  // The phase opens its own form; a link opens the other one in place.
  const form = props.open ?? (phase === 'token' || phase === 'client' ? phase : null)
  const app = preset?.app !== undefined || entry.clientId !== undefined
  return (
    <div className="ac-agent ac-conn" data-tone={tone(state)}>
      <div className="ac-conn-head">
        <span className="ac-avatar" aria-hidden="true" style={{ background: `hsl(${hue(entry.id)} 45% 48%)` }}>{name.slice(0, 1).toUpperCase()}</span>
        <div className="ac-agent-text">
          <span className="ac-conn-name">{name}<span className="ac-chip-id">{entry.id}</span></span>
          <span className="ac-conn-state" role="status" title={state?.phase === 'error' ? state.message : entry.url}>
            <span className="ac-dot" aria-hidden="true" />{stateText(state)}
          </span>
        </div>
        <div className="ac-conn-actions">
          {phase === 'authorizing' && state?.phase === 'authorizing' && (
            <>
              <a className="ac-link" href={state.authorizeUrl} target="_blank" rel="noopener noreferrer">{t('conn.reopen')}</a>
              <button type="button" className="ah-btn" onClick={props.onCancel}>{t('conn.cancel')}</button>
            </>
          )}
          {(phase === 'disconnected' || phase === 'expired' || phase === 'error' || phase === 'client') && form !== 'token' && (
            <button type="button" className="ac-link" disabled={disabled} onClick={() => props.onOpen('token')}>{t('conn.useToken')}</button>
          )}
          {(phase === 'disconnected' || phase === 'expired' || phase === 'error') && form === null && (
            <>
              {app && <button type="button" className="ac-link" disabled={disabled} onClick={() => props.onOpen('client')}>{t('conn.client.change')}</button>}
              {/* With a form open, its own button is the one next step. */}
              <button type="button" className="ah-btn" data-variant="primary" disabled={disabled} onClick={props.onConnect}>{retry}</button>
            </>
          )}
          {phase !== 'connecting' && phase !== 'authorizing' && (
            <button type="button" className="ah-btn ac-conn-remove" disabled={disabled} onClick={props.onRemove}>
              {phase === 'connected' ? t('conn.disconnect') : t('conn.remove')}
            </button>
          )}
        </div>
      </div>
      {form === 'token' && (
        <TokenForm disabled={disabled} tokenUrl={tokenUrlOf(entry.url)} hint={tokenHint === undefined ? undefined : t(tokenHint)} onSubmit={props.onSubmitToken}
          onCancel={phase === 'token' ? undefined : () => props.onOpen(null)} />
      )}
      {form === 'client' && (
        <ClientForm disabled={disabled} value={entry.clientId ?? ''} createUrl={preset?.app?.createUrl}
          hint={preset?.id === 'slack' ? t('conn.client.hint.slack') : undefined} onSubmit={props.onSubmitClient}
          onCancel={phase === 'client' ? undefined : () => props.onOpen(null)} />
      )}
      {props.children}
    </div>
  )
}

/**
 * Which local repositories a Linear account (or Slack workspace announcing new tickets) is for:
 * only sessions working in them see its tools. Folded it reads as one line ("For every repository"
 * or the linked names); open, a checklist of the repositories DSH knows, plus any linked one that
 * is not registered right now, so it can still be unticked.
 */
function RepoLinks(props: { store: ReposStore; value: readonly string[]; disabled: boolean; hint: ConfigKey; onChange(repos: readonly string[]): void }): ReactNode {
  const { store, value } = props
  const { repos, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (open) void store.load() }, [store, open])
  useEffect(() => { void store.load() }, [store])
  const known = repos ?? []
  const name = (path: string): string => known.find((group) => samePath(group.key, path))?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const stale = value.filter((path) => !known.some((group) => samePath(group.key, path)))
  const options = [...known.map((group) => ({ key: group.key, name: group.name, detail: group.key })), ...stale.map((path) => ({ key: path, name: name(path), detail: path }))]
  const checked = (key: string): boolean => value.some((path) => samePath(path, key))
  const toggle = (key: string): void => props.onChange(checked(key) ? value.filter((path) => !samePath(path, key)) : [...value, key])
  const summary = value.length === 0 ? t('conn.repos.all') : value.map(name).join(', ')
  return (
    <div className="ac-conn-repos" data-open={open ? '' : undefined}>
      <button type="button" className="ac-conn-repos-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ac-conn-repos-label">{t('conn.repos')}</span>
        <span className="ac-conn-repos-value">{summary}</span>
        <span className="ac-agent-chevron" aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="ac-conn-repos-body">
          <p className="ac-hint">{t(props.hint)}</p>
          {repos === undefined && error === null
            ? <p className="ac-hint">{t('conn.repos.loading')}</p>
            : options.length === 0
              ? <p className="ac-hint">{error ?? t('conn.repos.empty')}</p>
              : (
                <div className="ac-checks">
                  {options.map((option) => (
                    <label key={option.key} className="ac-check" data-disabled={props.disabled ? '' : undefined} title={option.detail}>
                      <input type="checkbox" checked={checked(option.key)} disabled={props.disabled} onChange={() => toggle(option.key)} />
                      <span className="ac-check-label">{option.name}</span>
                      <span className="ac-check-detail">{option.detail}</span>
                    </label>
                  ))}
                </div>
              )}
        </div>
      )}
    </div>
  )
}

/**
 * A Datadog account's site and toolsets, both carried in its endpoint. Folded it reads as one
 * line ("US1 · core, apm"); open, the site picker and the toolset checklist.
 */
function DatadogFields(props: { value: DatadogOptions; disabled: boolean; onChange(options: DatadogOptions): void }): ReactNode {
  const { value } = props
  const [open, setOpen] = useState(false)
  const checked = (id: string): boolean => value.toolsets.includes(id)
  const toggle = (id: string): void => props.onChange({ ...value, toolsets: checked(id) ? value.toolsets.filter((name) => name !== id) : [...value.toolsets, id] })
  const summary = `${value.site.toUpperCase()} · ${value.toolsets.join(', ')}`
  return (
    <div className="ac-conn-repos" data-open={open ? '' : undefined}>
      <button type="button" className="ac-conn-repos-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ac-conn-repos-label">{t('conn.datadog')}</span>
        <span className="ac-conn-repos-value">{summary}</span>
        <span className="ac-agent-chevron" aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="ac-conn-repos-body">
          <p className="ac-hint">{t('conn.datadog.hint')}</p>
          <label className="ac-conn-site">
            <span className="ac-conn-repos-label">{t('conn.datadog.site')}</span>
            <select className="ac-input ac-select" disabled={props.disabled} value={value.site}
              onChange={(event) => props.onChange({ ...value, site: event.target.value as DatadogOptions['site'] })}>
              {DATADOG_SITES.map((site) => <option key={site.id} value={site.id}>{site.id.toUpperCase()} · {site.app}</option>)}
            </select>
          </label>
          <div className="ac-checks">
            {DATADOG_TOOLSETS.map((toolset) => (
              <label key={toolset.id} className="ac-check" data-disabled={props.disabled ? '' : undefined}>
                <input type="checkbox" checked={checked(toolset.id)} disabled={props.disabled} onChange={() => toggle(toolset.id)} />
                <span className="ac-check-label">{toolset.id}</span>
                {toolset.preview === true && <span className="ac-check-detail">{t('conn.datadog.preview')}</span>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TokenForm(props: { disabled: boolean; tokenUrl: string | undefined; hint?: string; onSubmit(token: string): Promise<void>; onCancel?: () => void }): ReactNode {
  const [token, setToken] = useState('')
  const [sending, setSending] = useState(false)
  return (
    <form className="ac-conn-form" onSubmit={(event) => {
      event.preventDefault()
      if (token.trim() === '' || sending) return
      setSending(true)
      void props.onSubmit(token).finally(() => setSending(false))
    }}>
      <input className="ac-input" type="password" autoFocus autoComplete="off" spellCheck={false} value={token}
        placeholder={t('conn.token.placeholder')} aria-label={t('conn.token')}
        onChange={(event) => setToken(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') props.onCancel?.() }} />
      <button type="submit" className="ah-btn" data-variant="primary" disabled={props.disabled || sending || token.trim() === ''}>
        {sending ? t('conn.checking') : t('conn.connect')}
      </button>
      {props.onCancel !== undefined && <button type="button" className="ah-btn" onClick={props.onCancel}>{t('conn.cancel')}</button>}
      <p className="ac-hint ac-conn-form-hint">
        {props.hint !== undefined && <>{props.hint}{' '}</>}
        {t('conn.token.hint')}
        {props.tokenUrl !== undefined && <>{' '}<a className="ac-link" href={props.tokenUrl} target="_blank" rel="noopener noreferrer">{t('conn.token.create')}</a></>}
      </p>
    </form>
  )
}

/** The client ID of an app registered with the server by hand; where the preset can, a link creates that app ready-filled. */
function ClientForm(props: { disabled: boolean; value: string; createUrl: string | undefined; hint?: string; onSubmit(clientId: string): void; onCancel?: () => void }): ReactNode {
  const [clientId, setClientId] = useState(props.value)
  return (
    <form className="ac-conn-form" onSubmit={(event) => {
      event.preventDefault()
      if (clientId.trim() !== '') props.onSubmit(clientId)
    }}>
      <input className="ac-input" type="text" autoFocus autoComplete="off" spellCheck={false} value={clientId}
        placeholder={t('conn.client.placeholder')} aria-label={t('conn.client')}
        onChange={(event) => setClientId(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') props.onCancel?.() }} />
      <button type="submit" className="ah-btn" data-variant="primary" disabled={props.disabled || clientId.trim() === ''}>{t('conn.connect')}</button>
      {props.onCancel !== undefined && <button type="button" className="ah-btn" onClick={props.onCancel}>{t('conn.cancel')}</button>}
      <p className="ac-hint ac-conn-form-hint">
        {props.hint ?? t('conn.client.hint', { redirect: APP_REDIRECT })}
        {props.createUrl !== undefined && <>{' '}<a className="ac-link" href={props.createUrl} target="_blank" rel="noopener noreferrer">{t('conn.client.create')}</a></>}
      </p>
    </form>
  )
}
