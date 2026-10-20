/**
 * Workspace search, a sidebar tab like VS Code's search view: one box with
 * match case / whole word / regular expression toggles, include and exclude
 * globs behind a toggle, results grouped by file. A result opens its file at
 * the match, in the pane the code tabs sit in, so the list stays in view.
 * "Find references" lands here too, as a whole-word, case-sensitive search
 * for the identifier.
 *
 * Typing searches after a short pause; a new search cancels the one in
 * flight. The host caps the matches; the list renders only the rows in view.
 * A tab's query and results outlive its body, so switching tabs keeps them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { SearchFile, SearchMatch, SearchResult } from '../../files/types.ts'
import { useCoarse, VirtualList } from '../git/kit.tsx'
import { injectGitStyle } from '../git/style.ts'
import { t } from './i18n.ts'
import { baseName, fileAddress, type FilesCall } from './shared.ts'
import { injectEditorStyle } from './style.ts'
import type { TabInfo } from './index.tsx'

export const SEARCH_KIND = 'agent-hub.search'

export interface SearchParams {
  query: string
  word?: boolean
  caseSensitive?: boolean
  regex?: boolean
  /** A references lookup: the header names the identifier. */
  references?: boolean
}

interface Saved {
  query: string
  word: boolean
  caseSensitive: boolean
  regex: boolean
  include: string
  exclude: string
  filters: boolean
  references: boolean
  result?: SearchResult
  error?: string
  collapsed: string[]
  scrollTop: number
}

const EMPTY: Saved = { query: '', word: false, caseSensitive: false, regex: false, include: '', exclude: '', filters: false, references: false, collapsed: [], scrollTop: 0 }
const saved = new Map<string, Saved>()
const answered = new Map<string, number>()

type Row = { kind: 'file'; file: SearchFile; collapsed: boolean } | { kind: 'match'; file: SearchFile; match: SearchMatch }

interface SearchPageProps {
  sessionId: string
  useTabInfo: () => TabInfo
  useSessions: <T>(select: (sessions: { byId: Record<string, { cwd?: string } | undefined> }) => T) => T
  call: FilesCall
  codePane: Map<string, string>
}

export function SearchPage(props: SearchPageProps): ReactNode {
  const { tab, panel } = props.useTabInfo()
  const cwd = props.useSessions((sessions) => sessions.byId[props.sessionId]?.cwd)
  const coarse = useCoarse()
  useEffect(injectGitStyle, [])
  useEffect(injectEditorStyle, [])
  const [state, setState] = useState<Saved>(() => saved.get(tab.id) ?? EMPTY)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const flight = useRef<AbortController>()
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const update = useCallback((patch: Partial<Saved>) => setState((current) => ({ ...current, ...patch })), [])
  useEffect(() => { saved.set(tab.id, state) }, [tab.id, state])
  useEffect(() => {
    const forget = (): void => { saved.delete(tab.id); answered.delete(tab.id) }
    tab.signal.addEventListener('abort', forget, { once: true })
    return () => tab.signal.removeEventListener('abort', forget)
  }, [tab.signal, tab.id])

  const run = useCallback((next: Saved) => {
    clearTimeout(timer.current)
    flight.current?.abort()
    if (cwd === undefined || next.query === '') {
      setBusy(false)
      setState((current) => ({ ...current, result: undefined, error: undefined }))
      return
    }
    const controller = new AbortController()
    flight.current = controller
    setBusy(true)
    void props.call<SearchResult>({
      op: 'search', cwd, query: next.query, regex: next.regex, caseSensitive: next.caseSensitive, word: next.word,
      ...(next.include.trim() === '' ? {} : { include: next.include }),
      ...(next.exclude.trim() === '' ? {} : { exclude: next.exclude }),
    }, controller.signal).then((reply) => {
      if (controller.signal.aborted) return
      setBusy(false)
      if (reply.ok) setState((current) => ({ ...current, result: reply.value, error: undefined, collapsed: [], scrollTop: 0 }))
      else setState((current) => ({ ...current, result: undefined, error: reply.error.code === 'denied' ? t('search.denied') : reply.error.message }))
      if (list.current !== null) list.current.scrollTop = 0
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setBusy(false)
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }))
    })
  }, [cwd, props.call])

  /** Search after a pause in typing; at once for a toggle or Enter. */
  const change = (patch: Partial<Saved>, now = false): void => {
    const next = { ...state, ...patch }
    setState(next)
    clearTimeout(timer.current)
    if (now) run(next)
    else timer.current = setTimeout(() => run(next), 300)
  }
  useEffect(() => () => { clearTimeout(timer.current); flight.current?.abort() }, [])

  // Opened with a query (Find references, the search shortcut on a selection).
  useEffect(() => {
    const params = tab.navigation.params as Partial<SearchParams> | undefined
    if (answered.get(tab.id) === tab.navigation.revision) return
    answered.set(tab.id, tab.navigation.revision)
    if (typeof params?.query !== 'string' || params.query === '') {
      if (!coarse) input.current?.focus()
      return
    }
    const next: Saved = {
      ...state,
      query: params.query,
      word: params.word === true,
      caseSensitive: params.caseSensitive === true,
      regex: params.regex === true,
      references: params.references === true,
    }
    setState(next)
    run(next)
  }, [tab.navigation.revision])

  useEffect(() => {
    if (tab.visible !== false && !coarse && state.query === '') input.current?.focus()
  }, [tab.visible])

  const rows = useMemo<Row[]>(() => {
    const collapsed = new Set(state.collapsed)
    const out: Row[] = []
    for (const file of state.result?.files ?? []) {
      const closed = collapsed.has(file.path)
      out.push({ kind: 'file', file, collapsed: closed })
      if (!closed) for (const match of file.matches) out.push({ kind: 'match', file, match })
    }
    return out
  }, [state.result, state.collapsed])

  const open = (file: SearchFile, match: SearchMatch): void => {
    const own = panel?.id
    const pane = props.codePane.get(props.sessionId)
    const range = match.ranges[0]
    const length = range === undefined ? 0 : range[1] - range[0]
    tab.actions.openResource?.(fileAddress(props.sessionId, cwd, file.path), {
      ...(pane !== undefined && pane !== own ? { paneId: pane } : { preferNewPane: true }),
      params: { line: match.line, column: match.column, length },
    })
  }
  const toggle = (path: string): void => {
    const collapsed = new Set(state.collapsed)
    if (collapsed.has(path)) collapsed.delete(path)
    else collapsed.add(path)
    update({ collapsed: [...collapsed] })
  }
  const allCollapsed = state.result !== undefined && state.result.files.length > 0 && state.collapsed.length === state.result.files.length

  const rowHeight = coarse ? 34 : 24
  const render = (index: number, style: CSSProperties): ReactNode => {
    const row = rows[index]!
    if (row.kind === 'file') {
      const dir = row.file.path.includes('/') ? row.file.path.slice(0, row.file.path.lastIndexOf('/')) : ''
      return (
        <button key={`f:${row.file.path}`} type="button" className="cs-file" style={style} aria-expanded={!row.collapsed} title={row.file.path} onClick={() => toggle(row.file.path)}>
          <svg className="cs-chevron" data-open={row.collapsed ? undefined : ''} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
          <span className="cs-file-name">{baseName(row.file.path)}</span>
          <span className="cs-file-dir">{dir}</span>
          <span className="cs-count">{row.file.matches.length}</span>
        </button>
      )
    }
    return (
      <button key={`m:${row.file.path}:${row.match.line}:${row.match.column}`} type="button" className="cs-match" style={style} title={`${row.file.path}:${row.match.line}`} onClick={() => open(row.file, row.match)}>
        <span className="cs-line">{row.match.line}</span>
        <span className="cs-preview">{highlight(row.match)}</span>
      </button>
    )
  }

  const count = state.result?.count ?? 0
  const files = state.result?.files.length ?? 0
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      run(state)
    } else if (event.key === 'Escape' && state.query !== '') {
      event.preventDefault()
      event.stopPropagation()
      change({ query: '', references: false }, true)
    }
  }

  return (
    <div className="cs-root" data-coarse={coarse ? '' : undefined}>
      <div className="cs-form">
        {state.references && (
          <div className="cs-refs">
            <span>{t('search.refs', { word: state.query })}</span>
            <button type="button" className="ce-link" onClick={() => update({ references: false })}>{t('search.clear')}</button>
          </div>
        )}
        <div className="cs-row">
          <div className="cs-box">
            <input ref={input} className="cs-input" type="search" value={state.query} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')}
              spellCheck={false} autoCapitalize="off" autoCorrect="off" enterKeyHint="search"
              onChange={(event) => change({ query: event.target.value, references: false })} onKeyDown={onKeyDown} />
            <Toggle label={t('search.case')} on={state.caseSensitive} onClick={() => change({ caseSensitive: !state.caseSensitive }, true)}>Aa</Toggle>
            <Toggle label={t('search.word')} on={state.word} onClick={() => change({ word: !state.word }, true)}><u>ab</u></Toggle>
            <Toggle label={t('search.regex')} on={state.regex} onClick={() => change({ regex: !state.regex }, true)}>.*</Toggle>
          </div>
          <button type="button" className="ah-icon-btn" aria-label={t('search.filters')} title={t('search.filters')} aria-pressed={state.filters} onClick={() => update({ filters: !state.filters })}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><circle cx="3.5" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="12.5" cy="8" r=".6" fill="currentColor" /></svg>
          </button>
        </div>
        {state.filters && (
          <div className="cs-filters">
            <label className="cs-filter"><span>{t('search.include')}</span>
              <input className="cs-input" value={state.include} placeholder={t('search.globHint')} spellCheck={false} onChange={(event) => change({ include: event.target.value })} onKeyDown={onKeyDown} /></label>
            <label className="cs-filter"><span>{t('search.exclude')}</span>
              <input className="cs-input" value={state.exclude} placeholder={t('search.globHint')} spellCheck={false} onChange={(event) => change({ exclude: event.target.value })} onKeyDown={onKeyDown} /></label>
          </div>
        )}
        <div className="cs-summary" aria-live="polite">
          <span className="cs-summary-text">
            {busy ? t('search.searching')
              : state.error !== undefined ? <span className="cs-error">{state.error}</span>
              : state.result === undefined ? ''
              : count === 0 ? t('search.none')
              : state.result.truncated ? t('search.truncated', { count })
              : t('search.summary', { count, files })}
          </span>
          {files > 0 && (
            <button type="button" className="ce-link" onClick={() => update({ collapsed: allCollapsed ? [] : state.result!.files.map((file) => file.path) })}>
              {t(allCollapsed ? 'search.expand' : 'search.collapse')}
            </button>
          )}
        </div>
        {busy && <div className="cs-progress" aria-hidden="true" />}
      </div>
      {state.result === undefined && state.error === undefined && !busy && state.query === ''
        ? <p className="cs-empty">{t('search.empty')}</p>
        : <VirtualList listRef={list} className="cs-list" count={rows.length} rowHeight={rowHeight} render={render} role="tree" label={t('searchTitle')} />}
    </div>
  )
}

function Toggle(props: { label: string; on: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button type="button" className="cs-toggle" title={props.label} aria-label={props.label} aria-pressed={props.on} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

function highlight(match: SearchMatch): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  match.ranges.forEach(([from, to], index) => {
    if (from > at) parts.push(match.preview.slice(at, from))
    if (to > from) parts.push(<mark key={index}>{match.preview.slice(from, to)}</mark>)
    at = Math.max(at, to)
  })
  if (at < match.preview.length) parts.push(match.preview.slice(at))
  return parts
}
