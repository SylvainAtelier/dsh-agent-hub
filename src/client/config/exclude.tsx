/**
 * `sync.localSettings`, 不参与同步: what each machine keeps for itself, a whole
 * profile entry (`terminal-controller`) or a setting inside one
 * (`agent-hub.config.review.auto`). What is listed shows as chips, each
 * removable; the entries and settings to tick come from this machine's profile
 * and the remote's last fetched settings (the sync `catalog`), so nothing is
 * typed. Ticking an entry covers everything in it: its settings show ticked
 * and greyed. The entries an earlier version synced once per system
 * (`sync.platformEntries`) count as listed and move here on the next change.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { SyncCatalogEntry, SyncSetting } from '../../sync/types.ts'
import type { SyncStore } from '../sync/api.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { Head } from './guard.tsx'
import { t } from './i18n.ts'

export const EXCLUDE_ID = 'sync.localSettings'
const LEGACY_ID = 'sync.platformEntries'

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/** `key` is listed, or inside a listed entry or setting. */
export const covered = (list: readonly string[], key: string): boolean => list.some((entry) => key === entry || key.startsWith(`${entry}.`))

/** Each key once, none inside another listed one. */
const normalize = (list: readonly string[]): string[] =>
  [...new Set(list.map((entry) => entry.trim()).filter(Boolean))].filter((entry, _index, all) => !all.some((other) => entry.startsWith(`${other}.`)))

export interface Exclusions {
  list: readonly string[]
  set(next: readonly string[]): void
}

/** The list as it applies (the legacy per-system entries included) and its one way to change. */
export function exclusionsOf(fields: Record<string, FieldState>, form: ConfigFormModel): Exclusions {
  const legacy = strings(fields[LEGACY_ID]?.value)
  return {
    list: normalize([...strings(fields[EXCLUDE_ID]?.value), ...legacy]),
    set(next) {
      form.edit(EXCLUDE_ID, normalize(next))
      if (legacy.length > 0) form.reset(LEGACY_ID)
    },
  }
}

/** List `key`, dropping what it now covers; or unlist exactly it. */
export const toggled = (list: readonly string[], key: string, on: boolean): string[] =>
  on ? [...list.filter((entry) => !entry.startsWith(`${key}.`)), key] : list.filter((entry) => entry !== key)

/** A key in the list as the page shows it: the entry, then the setting without `config`. */
export function keyLabel(key: string): { id: string; path: string } {
  const [id = '', ...path] = key.split('.')
  return { id, path: (path[0] === 'config' ? path.slice(1) : path).join('.') }
}

interface Node {
  key: string
  label: string
  value?: string
  name?: string
  only?: 'remote'
  children: Node[]
}

function settingNode(id: string, setting: SyncSetting): Node {
  return {
    key: [id, ...setting.path].join('.'),
    label: setting.path.at(-1) ?? id,
    ...(setting.value === undefined ? {} : { value: setting.value }),
    children: (setting.settings ?? []).map((child) => settingNode(id, child)),
  }
}

const entryNode = (entry: SyncCatalogEntry): Node => ({
  key: entry.id,
  label: entry.id,
  ...(entry.name === undefined ? {} : { name: entry.name }),
  ...(entry.only === undefined ? {} : { only: entry.only }),
  children: entry.settings.map((setting) => settingNode(entry.id, setting)),
})

/** The catalog knows `key`: a node of its own, or inside a setting offered whole. */
function known(nodes: readonly Node[], key: string): boolean {
  return nodes.some((node) => node.key === key || (key.startsWith(`${node.key}.`) && (node.children.length === 0 || known(node.children, key))))
}

const matches = (node: Node, query: string): boolean =>
  node.key.toLowerCase().includes(query) || (node.name ?? '').toLowerCase().includes(query) || node.children.some((child) => matches(child, query))

function Chevron(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function SyncExcludeField(props: { id: string; field: FieldState; fields: Record<string, FieldState>; disabled: boolean; form: ConfigFormModel; store?: SyncStore }): ReactNode {
  const { disabled, store } = props
  const exclusions = exclusionsOf(props.fields, props.form)
  const { list } = exclusions
  const legacy = strings(props.fields[LEGACY_ID]?.value)
  const [picking, setPicking] = useState(false)
  const [catalog, setCatalog] = useState<Node[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const pickerId = useId()
  const searchId = useId()

  // Read when the picker opens, so settings changed since show up.
  useEffect(() => {
    if (!picking || store === undefined) return
    let live = true
    setFailure(null)
    store.catalog().then((result) => {
      if (!live) return
      const nodes = result.entries.map(entryNode)
      setCatalog(nodes)
      // What is listed inside an entry shows without a click.
      const expanded = new Set<string>()
      const walk = (level: readonly Node[]): void => {
        for (const node of level) {
          if (list.some((entry) => entry.startsWith(`${node.key}.`))) expanded.add(node.key)
          walk(node.children)
        }
      }
      walk(nodes)
      setOpen(expanded)
    }, (error: unknown) => { if (live) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list at opening decides what unfolds
  }, [picking, store])

  const set = (key: string, on: boolean): void => exclusions.set(toggled(list, key, on))
  const unfold = (key: string): void => setOpen((before) => {
    const next = new Set(before)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => (catalog ?? []).filter((node) => needle === '' || matches(node, needle)), [catalog, needle])

  const renderNode = (node: Node): ReactNode => {
    if (needle !== '' && !matches(node, needle)) return null
    const implied = list.some((entry) => node.key.startsWith(`${entry}.`))
    const checked = covered(list, node.key)
    const mixed = !checked && list.some((entry) => entry.startsWith(`${node.key}.`))
    const foldable = node.children.length > 0
    const expanded = foldable && (open.has(node.key) || (needle !== '' && node.children.some((child) => matches(child, needle))))
    const inputId = `${pickerId}-${node.key}`
    const childrenId = `${inputId}-children`
    return (
      <li key={node.key}>
        <div className="ac-exclude-node" data-implied={implied ? '' : undefined}>
          {foldable
            ? (
              <button type="button" className="ac-exclude-twist" aria-expanded={expanded} aria-controls={childrenId}
                aria-label={t(expanded ? 'sync.exclude.fold' : 'sync.exclude.unfold', { name: node.label })} onClick={() => unfold(node.key)}>
                <Chevron />
              </button>
            )
            : <span aria-hidden="true" />}
          <input type="checkbox" id={inputId} checked={checked} disabled={disabled || implied}
            ref={(element) => { if (element !== null) element.indeterminate = mixed }}
            onChange={(event) => set(node.key, event.target.checked)} />
          <label htmlFor={inputId} className="ac-exclude-name">
            <code>{node.label}</code>
            {node.name !== undefined && <span className="ac-exclude-package">{node.name}</span>}
            {node.only === 'remote' && <span className="ac-tag">{t('sync.diff.onlyRemote')}</span>}
          </label>
          {node.value !== undefined ? <code className="ac-exclude-value" title={node.value}>{node.value}</code> : <span />}
        </div>
        {expanded && <ul id={childrenId}>{node.children.map(renderNode)}</ul>}
      </li>
    )
  }

  return (
    <div className="ac-row ac-exclude" data-wide="">
      <Head id={props.id} field={props.field} disabled={disabled} form={props.form} />
      <div className="ac-control ac-exclude-control">
        {legacy.length > 0 && <p className="ac-notice">{t('sync.exclude.legacy', { list: legacy.join('、') })}</p>}
        {list.length === 0
          ? <p className="ac-muted ac-exclude-none">{t('sync.exclude.none')}</p>
          : (
            <ul className="ac-exclude-chips" aria-labelledby={`ac-field-${props.id}`}>
              {list.map((key) => {
                const { id, path } = keyLabel(key)
                const stale = catalog !== null && !known(catalog, key)
                return (
                  <li key={key} className="ac-exclude-chip" data-stale={stale ? '' : undefined} title={stale ? t('sync.exclude.stale') : key}>
                    <code>{id}</code>
                    {path !== '' && <code className="ac-exclude-chip-path">{path}</code>}
                    {stale && <span className="ac-muted">{t('sync.exclude.staleTag')}</span>}
                    <button type="button" className="ac-rule-remove" disabled={disabled}
                      aria-label={t('sync.exclude.remove', { key })} title={t('sync.exclude.remove', { key })}
                      onClick={() => exclusions.set(list.filter((entry) => entry !== key))}>×</button>
                  </li>
                )
              })}
            </ul>
          )}
        {store !== undefined && (
          <button type="button" className="ah-btn ac-exclude-toggle" aria-expanded={picking} aria-controls={picking ? pickerId : undefined}
            onClick={() => setPicking(!picking)}>
            {t(picking ? 'sync.exclude.close' : 'sync.exclude.open')}
          </button>
        )}
        {picking && (
          <div className="ac-exclude-picker" id={pickerId}>
            <div className="ac-exclude-search">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input id={searchId} className="ac-input" type="search" value={query} placeholder={t('sync.exclude.search')} aria-label={t('sync.exclude.search')}
                spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
              <span className="ac-muted ac-exclude-count" aria-live="polite">{t('sync.exclude.count', { n: list.length })}</span>
            </div>
            {failure !== null
              ? <p className="ac-notice" data-tone="bad" role="alert">{t('sync.error', { message: failure })}</p>
              : catalog === null
                ? <p className="ac-muted ac-exclude-empty">{t('sync.loading')}</p>
                : shown.length === 0
                  ? <p className="ac-muted ac-exclude-empty">{t(needle === '' ? 'sync.exclude.emptyCatalog' : 'sync.exclude.noMatch', { query: query.trim() })}</p>
                  : <ul className="ac-exclude-tree" aria-labelledby={`ac-field-${props.id}`}>{shown.map(renderNode)}</ul>}
          </div>
        )}
      </div>
    </div>
  )
}
