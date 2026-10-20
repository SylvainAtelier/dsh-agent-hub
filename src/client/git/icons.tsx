/** 16px line glyphs in currentColor, 1.4px stroke — the weight of the host's own outline icons. */

import type { ReactNode } from 'react'

type P = { size?: number; className?: string }

const svg = (children: ReactNode, { size = 16, className }: P = {}): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{children}</svg>
)

export const IconBranch = (p: P): ReactNode => svg(<><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" /><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" /></>, p)
export const IconBot = (p: P): ReactNode => svg(<><rect x="3" y="5.5" width="10" height="7" rx="2" /><path d="M8 5.5V3M6 8.5v.5M10 8.5v.5" /><circle cx="8" cy="2.5" r=".6" fill="currentColor" /></>, p)
export const IconRefresh = (p: P): ReactNode => svg(<><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></>, p)
export const IconMore = (p: P): ReactNode => svg(<><circle cx="3.5" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="12.5" cy="8" r=".6" fill="currentColor" /></>, p)
export const IconPlus = (p: P): ReactNode => svg(<path d="M8 3.5v9M3.5 8h9" />, p)
export const IconMinus = (p: P): ReactNode => svg(<path d="M3.5 8h9" />, p)
export const IconUndo = (p: P): ReactNode => svg(<><path d="M5.5 6.5H10a3 3 0 0 1 0 6H7" /><path d="M7.5 4 5 6.5 7.5 9" /></>, p)
export const IconCheck = (p: P): ReactNode => svg(<path d="m3.5 8.5 3 3 6-7" />, p)
export const IconChevron = (p: P): ReactNode => svg(<path d="m6 4 4 4-4 4" />, p)
export const IconChevronDown = (p: P): ReactNode => svg(<path d="m4 6 4 4 4-4" />, p)
export const IconBack = (p: P): ReactNode => svg(<path d="M10 3.5 5.5 8l4.5 4.5" />, p)
export const IconClose = (p: P): ReactNode => svg(<path d="m4 4 8 8M12 4l-8 8" />, p)
export const IconUp = (p: P): ReactNode => svg(<path d="M8 13V3.5M4 7l4-4 4 4" />, p)
export const IconDown = (p: P): ReactNode => svg(<path d="M8 3v9.5M4 9l4 4 4-4" />, p)
export const IconSync = (p: P): ReactNode => svg(<><path d="M3 6.5A5 5 0 0 1 12.2 5" /><path d="M12.5 2.5V5.2H9.8" /><path d="M13 9.5A5 5 0 0 1 3.8 11" /><path d="M3.5 13.5v-2.7h2.7" /></>, p)
export const IconCloudDown = (p: P): ReactNode => svg(<><path d="M5 12H4.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7 1A2.5 2.5 0 0 1 11.5 12H11" /><path d="M8 8.5v5M6 11.5l2 2 2-2" /></>, p)
export const IconCloudUp = (p: P): ReactNode => svg(<><path d="M5 12H4.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7 1A2.5 2.5 0 0 1 11.5 12H11" /><path d="M8 13.5V8.5M6 10.5l2-2 2 2" /></>, p)
export const IconLocate = (p: P): ReactNode => svg(<><circle cx="8" cy="8" r="4.5" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" /></>, p)
export const IconSearch = (p: P): ReactNode => svg(<><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></>, p)
export const IconFile = (p: P): ReactNode => svg(<><path d="M9 2.5H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V5.5z" /><path d="M9 2.5v3h3" /></>, p)
export const IconOpen = (p: P): ReactNode => svg(<><path d="M9 3h4v4M13 3 7.5 8.5" /><path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" /></>, p)
export const IconTag = (p: P): ReactNode => svg(<><path d="M2.5 8.2V3.5a1 1 0 0 1 1-1h4.7l5.3 5.3-5.7 5.7z" /><circle cx="5.5" cy="5.5" r=".8" fill="currentColor" /></>, p)
export const IconCloud = (p: P): ReactNode => svg(<path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.7 1 2.5 2.5 0 0 1-.4 5z" />, p)
export const IconStash = (p: P): ReactNode => svg(<><path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" /><path d="M2.5 9.5 4 4h8l1.5 5.5V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /></>, p)
export const IconSplit = (p: P): ReactNode => svg(<><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M8 3v10" /></>, p)
export const IconInline = (p: P): ReactNode => svg(<><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6.5h6M5 9.5h6" /></>, p)
export const IconWrap = (p: P): ReactNode => svg(<path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12H5" />, p)
export const IconExpand = (p: P): ReactNode => svg(<><path d="M8 2.5v4M6 4.5l2-2 2 2M8 13.5v-4M6 11.5l2 2 2-2" /><path d="M3 8h10" /></>, p)
export const IconWarn = (p: P): ReactNode => svg(<><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3" /><circle cx="8" cy="11.2" r=".5" fill="currentColor" /></>, p)
export const IconUser = (p: P): ReactNode => svg(<><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></>, p)
export const IconFilter = (p: P): ReactNode => svg(<path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5V8.5z" />, p)
export const IconCopy = (p: P): ReactNode => svg(<><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2" /><path d="M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5" /></>, p)
export const IconStar = (p: P & { filled?: boolean }): ReactNode => svg(<path d="m8 2.3 1.75 3.55 3.9.57-2.82 2.75.66 3.88L8 11.22l-3.49 1.83.66-3.88-2.82-2.75 3.9-.57z" fill={p.filled ? 'currentColor' : 'none'} />, p)
export const IconSparkle = (p: P): ReactNode => svg(<><path d="M7 2.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z" /><path d="M12 10v3M10.5 11.5h3" /></>, p)

/** Guide card artwork: the branch glyph at card scale. */
export function GitArtwork({ size = 26, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" aria-hidden="true" className={className}>
      <circle cx="7.5" cy="6" r="2.4" />
      <circle cx="7.5" cy="20" r="2.4" />
      <circle cx="18.5" cy="8.5" r="2.4" />
      <path d="M7.5 8.4v9.2M18.5 10.9c0 4.6-11 3-11 6.7" />
    </svg>
  )
}

export const IconFolder = (p: P): ReactNode => svg(<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />, p)
export const IconTree = (p: P): ReactNode => svg(<><path d="M3 3.5h4M5 3.5V12h2.5M5 7.5h2.5" /><rect x="8.5" y="6" width="5" height="3" rx=".8" /><rect x="8.5" y="10.5" width="5" height="3" rx=".8" /></>, p)
export const IconList = (p: P): ReactNode => svg(<path d="M3 4h10M3 8h10M3 12h10" />, p)
export const IconTerminal = (p: P): ReactNode => svg(<><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="m4.8 6.3 2 1.7-2 1.7M8.5 10.2h2.7" /></>, p)
export const IconMaximize = (p: P): ReactNode => svg(<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />, p)
export const IconMinimize = (p: P): ReactNode => svg(<path d="M13 7H9V3M3 9h4v4M9 7l4.5-4.5M7 9l-4.5 4.5" />, p)
export const IconForce = (p: P): ReactNode => svg(<><path d="M8 13V5M4.5 8.5 8 5l3.5 3.5" /><path d="M4 2.5h8" /></>, p)
/** Two checkouts of one repository: stacked folders. */
export const IconWorktree = (p: P): ReactNode => svg(<><path d="M4.5 5V4a1 1 0 0 1 1-1h2.2l1.2 1.2h3.6a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1h-.5" /><path d="M2.5 7a1 1 0 0 1 1-1h2.2l1.2 1.2h3.6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" /></>, p)
