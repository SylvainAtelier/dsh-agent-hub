/** 接力's marks: the panel's, each origin's and each state's. One stroke family, drawn in currentColor. */

import { useSyncExternalStore, type ReactNode } from 'react'
import type { Origin, ThreadPhase } from '../../relay/types.ts'
import type { RelayStore } from './api.ts'

export const RELAY_PANEL_ID = 'dsh-agent-hub.relay'

const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

/**
 * The sidebar row's icon: a hand-over, two arrows passing. A dot in its
 * corner while a thread is at work (blue) or a failure is waiting (red); the
 * row's label says the rest.
 */
export function relayPanelIcon(store: RelayStore): (props: { size: number; active?: boolean }) => ReactNode {
  return function RelayPanelIcon(props) {
    const { attention } = useSyncExternalStore(store.subscribe, store.getSnapshot)
    return (
      <svg data-dsh-panel-entry={RELAY_PANEL_ID} viewBox="0 0 16 16" width={props.size} height={props.size} strokeWidth="1" {...stroke}>
        <path d="M2 5.5h9.5M9 3l2.5 2.5L9 8" />
        <path d="M14 10.5H4.5M7 8l-2.5 2.5L7 13" />
        {attention !== undefined && <circle cx="13.25" cy="2.75" r="2.25" stroke="none" fill={attention === 'failed' ? 'var(--ah-danger, #e5484d)' : 'var(--ah-info, #3e7cf0)'} />}
      </svg>
    )
  }
}

const ORIGIN_PATH: Record<Origin, ReactNode> = {
  glasses: <><circle cx="4.25" cy="9.25" r="2.75" /><circle cx="11.75" cy="9.25" r="2.75" /><path d="M7 9.25c.6-.5 1.4-.5 2 0M1.5 9.25l.75-4.25 1.5-.75M14.5 9.25l-.75-4.25-1.5-.75" /></>,
  cloud: <path d="M4.75 12.5h6.5a3 3 0 0 0 .35-5.98A3.75 3.75 0 0 0 4.4 7.4a2.6 2.6 0 0 0 .35 5.1z" />,
  cli: <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M4.5 6.25l2 1.75-2 1.75M8.5 10.25h3" /></>,
  tui: <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M1.75 5.5h12.5M4.5 8.25l1.75 1.5-1.75 1.5" /></>,
  telegram: <path d="M14.25 2.25L1.75 7.1l4.4 1.6 1.6 4.8 2.3-3.05 3.2 2.3 1-10.5zM6.15 8.7l6.1-4.7" />,
  cron: <><circle cx="8" cy="8" r="5.75" /><path d="M8 4.75V8l2.25 1.5" /></>,
  api: <path d="M5.5 2.5c-1.25 0-1.75.6-1.75 1.75V6.5c0 .9-.6 1.5-1.5 1.5.9 0 1.5.6 1.5 1.5v2.25c0 1.15.5 1.75 1.75 1.75M10.5 2.5c1.25 0 1.75.6 1.75 1.75V6.5c0 .9.6 1.5 1.5 1.5-.9 0-1.5.6-1.5 1.5v2.25c0 1.15-.5 1.75-1.75 1.75" />,
  other: <path d="M2.5 3.5h11V11H7.25L4.5 13.25V11h-2z" />,
}

export function OriginIcon(props: { origin: Origin; size?: number }): ReactNode {
  const size = props.size ?? 16
  return <svg viewBox="0 0 16 16" width={size} height={size} strokeWidth="1.25" {...stroke}>{ORIGIN_PATH[props.origin]}</svg>
}

/** A state's mark: shape as well as colour, so it reads without colour too. */
export function PhaseMark(props: { phase: ThreadPhase }): ReactNode {
  const common = { viewBox: '0 0 12 12', width: 12, height: 12, strokeWidth: 1.5, ...stroke }
  switch (props.phase) {
    case 'running': return <svg {...common} className="rl-spin"><path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" /></svg>
    case 'idle': return <svg {...common}><path d="M2.5 6.25l2.25 2.25 4.75-5" /></svg>
    case 'failed': return <svg {...common}><path d="M3 3l6 6M9 3l-6 6" /></svg>
    case 'cloud': return <svg {...common}><path d="M3.5 9.5h5a2.25 2.25 0 0 0 .2-4.5 2.9 2.9 0 0 0-5.5.8A1.9 1.9 0 0 0 3.5 9.5z" /></svg>
    default: return <svg {...common}><rect x="1.5" y="2" width="9" height="2.5" rx=".5" /><path d="M2.5 4.5v5h7v-5M5 6.5h2" /></svg>
  }
}

const icon = (d: string, size = 16): ReactNode => <svg viewBox="0 0 16 16" width={size} height={size} strokeWidth="1.25" {...stroke}><path d={d} /></svg>

export const IconRefresh = (): ReactNode => icon('M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3')
export const IconGear = (): ReactNode => (
  <svg viewBox="0 0 16 16" width="16" height="16" strokeWidth="1.25" {...stroke}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.06 1.06M4.66 11.34L3.6 12.4M12.4 12.4l-1.06-1.06M4.66 4.66L3.6 3.6" />
  </svg>
)
export const IconBack = (): ReactNode => icon('M10 3L5 8l5 5')
export const IconMore = (): ReactNode => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
)
export const IconSend = (): ReactNode => icon('M8 13V3.5M3.75 7.5L8 3.25l4.25 4.25')
export const IconChevron = (): ReactNode => icon('M6 4l4 4-4 4', 12)
export const IconExternal = (): ReactNode => icon('M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3.5h-9.5V4H6')
export const IconTerminal = (): ReactNode => icon('M3 4.5l3 3-3 3M7.5 11.5h5.5')
export const IconCopy = (): ReactNode => (
  <svg viewBox="0 0 16 16" width="16" height="16" strokeWidth="1.25" {...stroke}><rect x="5.5" y="5.5" width="8" height="8" rx="1.25" /><path d="M10.5 5.5V3.75c0-.7-.55-1.25-1.25-1.25h-5.5c-.7 0-1.25.55-1.25 1.25v5.5c0 .7.55 1.25 1.25 1.25H5.5" /></svg>
)
export const IconHash = (): ReactNode => icon('M6 2.5l-1.5 11M11.5 2.5l-1.5 11M2.5 6h11M2 10.5h11')
export const IconClose = (): ReactNode => icon('M4 4l8 8M12 4l-8 8', 12)
