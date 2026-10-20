/**
 * A zone of the board: the columns one service fills (Sentry's alerts, GitHub's pull requests, the
 * tickets), under one head. The head's first row names the zone and holds what acts on all of it;
 * its second row holds the zone's filters. Both rows are as high in every zone, so the filters line
 * up across the board; a line under the name spans the zone's columns, showing what they apply to.
 * Narrow (one column at a time) the zones dissolve and each column carries its zone's filters.
 */

import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { samePath } from '../../repos/types.ts'
import { ZoneMark, type ZoneKind } from './marks.tsx'

export function Zone(props: { zone: ZoneKind; folded?: boolean; style?: CSSProperties; head?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="ab-zone" data-zone={props.zone} data-folded={props.folded ? '' : undefined} style={props.style}>
      {props.head}
      <div className="ab-zone-cols">{props.children}</div>
    </div>
  )
}

export function ZoneHead(props: { zone: ZoneKind; title: string; count?: number | undefined; actions?: ReactNode; tools?: ReactNode }): ReactNode {
  return (
    <header className="ab-zone-head">
      <div className="ab-zone-title">
        <ZoneMark zone={props.zone} />
        <h3>{props.title}</h3>
        {props.count !== undefined && <span className="ab-count">{props.count}</span>}
        <span className="ab-grow" />
        {props.actions}
      </div>
      <div className="ab-zone-tools">{props.tools}</div>
    </header>
  )
}

/** A zone's cards while its first list is read: as wide as the real ones, so nothing moves when they come. */
export function ZoneSkeleton(props: { label: string }): ReactNode {
  return (
    <div className="ab-skeleton" role="status" aria-label={props.label}>
      {[0, 1, 2].map((index) => <div key={index} className="ab-skeleton-card" />)}
    </div>
  )
}

/**
 * The repositories a zone is bound to: `null` when it is off, `[]` for every one. Until its service
 * first answers, the binding last seen (kept in this browser), so the zone holds its place from the
 * first frame instead of pushing in when the answer comes.
 */
export function useBinding(key: string, known: readonly string[] | null | undefined): readonly string[] | null {
  const stored = useMemo(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null
    } catch { return null }
  }, [key])
  const text = known === undefined ? undefined : JSON.stringify(known)
  useEffect(() => {
    if (text === undefined) return
    try { localStorage.setItem(key, text) } catch { /* not remembered */ }
  }, [key, text])
  return known === undefined ? stored : known
}

/** Whether a zone bound to `repos` shows for the repository filter (empty: all). */
export const boundTo = (repos: readonly string[] | null, repo: string): boolean =>
  repos !== null && (repo === '' || repos.length === 0 || repos.some((item) => samePath(item, repo)))
