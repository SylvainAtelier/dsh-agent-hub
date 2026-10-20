/** The board's small marks, shared by its cards, the detail and the new-ticket panel. */

import type { ReactNode } from 'react'
import { t, type BoardKey } from './i18n.ts'

export function LinearMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="ab-mark">
      <path fill="currentColor" d="M1.2 9.6 6.4 14.8A7 7 0 0 1 1.2 9.6Zm-.2-2.1 7.5 7.5a7 7 0 0 0 1.9-.5L1.5 5.6a7 7 0 0 0-.5 1.9Zm1.2-3 9.3 9.3a7 7 0 0 0 1.3-1L3.2 3.2a7 7 0 0 0-1 1.3Zm2-2.1A7 7 0 1 1 13.6 11.8L4.2 2.4Z" />
    </svg>
  )
}

/** Linear's priority icons: three dashes for none, "!" for urgent, else bars. */
export function PriorityMark(props: { priority: number }): ReactNode {
  const { priority } = props
  const label = t(`priority.${priority}` as BoardKey)
  if (priority === 1) return <span className="ab-prio" data-urgent="" title={label} aria-label={label}>!</span>
  if (priority === 0) {
    return (
      <svg className="ab-prio" viewBox="0 0 12 12" width="12" height="12" role="img" aria-label={label}>
        <title>{label}</title>
        {[0, 1, 2].map((i) => <rect key={i} x={1 + i * 4} y="5.25" width="2.5" height="1.5" rx=".6" fill="currentColor" opacity=".55" />)}
      </svg>
    )
  }
  const bars = 4 - priority
  return (
    <svg className="ab-prio" viewBox="0 0 12 12" width="12" height="12" role="img" aria-label={label}>
      <title>{label}</title>
      {[0, 1, 2].map((i) => <rect key={i} x={1 + i * 4} y={8 - i * 3} width="2.5" height={3 + i * 3} rx=".6" fill="currentColor" opacity={i < bars ? 0.9 : 0.22} />)}
    </svg>
  )
}

export function ProjectIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 1.5 10.5 4v4L6 10.5 1.5 8V4z" /><path d="M1.5 4 6 6.5 10.5 4M6 6.5v4" />
    </svg>
  )
}

const SENTRY_PATH = 'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z'

/** Sentry's mark, for a chip naming one of its issues. */
export function SentryMark(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true" className="ab-mark">
      <path fill="currentColor" d={SENTRY_PATH} />
    </svg>
  )
}

export function PullIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="3" cy="2.5" r="1.3" /><circle cx="3" cy="9.5" r="1.3" /><circle cx="9" cy="9.5" r="1.3" /><path d="M3 3.8v4.4M9 8.2V5a1.5 1.5 0 0 0-1.5-1.5H5.5M6.8 2.2 5.5 3.5l1.3 1.3" />
    </svg>
  )
}

/**
 * What ties cards across the board's columns: each card's `data-link` lists these, space-separated,
 * and cards sharing one are linked (a pull request, its Linear ticket, the Sentry issues it fixes).
 */
export const pairLink = (kind: 'linear' | 'sentry', id: string): string => `${kind}:${id.toUpperCase()}`

/** What a zone of the board is about, by the service it reads: Sentry, GitHub, Linear, or the local tasks. */
export type ZoneKind = 'alerts' | 'review' | 'linear' | 'local'

export function ZoneMark(props: { zone: ZoneKind }): ReactNode {
  const { zone } = props
  if (zone === 'linear') {
    return (
      <svg className="ab-zone-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M1.2 9.6 6.4 14.8A7 7 0 0 1 1.2 9.6Zm-.2-2.1 7.5 7.5a7 7 0 0 0 1.9-.5L1.5 5.6a7 7 0 0 0-.5 1.9Zm1.2-3 9.3 9.3a7 7 0 0 0 1.3-1L3.2 3.2a7 7 0 0 0-1 1.3Zm2-2.1A7 7 0 1 1 13.6 11.8L4.2 2.4Z" />
      </svg>
    )
  }
  if (zone === 'review') {
    return (
      <svg className="ab-zone-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
      </svg>
    )
  }
  if (zone === 'alerts') {
    return (
      <svg className="ab-zone-mark" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d={SENTRY_PATH} />
      </svg>
    )
  }
  return (
    <svg className="ab-zone-mark" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5" /><path d="m5.25 8.25 1.9 1.9 3.6-4" />
    </svg>
  )
}
