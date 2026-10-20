/** Durations, sizes and the one-line names 接力 shows. */

import type { ProcView } from '../../qoder/types.ts'
import type { ThreadView } from '../../relay/types.ts'
import { t, type RelayKey } from './i18n.ts'

/** `3 分钟`, `45 s`: a duration, coarse. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t('seconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('hours', { n: hours })
  return t('days', { n: Math.round(hours / 24) })
}

/** `3 分钟前`, `just now`: how long ago, coarse. */
export function ago(time: number, now = Date.now()): string {
  return now - time < 45_000 ? t('now') : t('ago', { time: span(now - time) })
}

/** `275 MB`, `1.2 GB`. */
export function bytes(value: number): string {
  const mb = value / (1 << 20)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** `0.4%`, `12%`: of one core. */
export function percent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

/** `pid 15468 · 275 MB · CPU 0.4% · 运行 32 分钟`, what is known of it. */
export function procLine(proc: ProcView, now: number): string {
  return [
    t('pid', { pid: proc.pid }),
    ...(proc.rss === undefined ? [] : [bytes(proc.rss)]),
    ...(proc.cpu === undefined ? [] : [`CPU ${percent(proc.cpu)}`]),
    ...(proc.startedAt === undefined ? [] : [t('up', { time: span(now - proc.startedAt) })]),
  ].join(' · ')
}

/** A path's last part: `C:\pro\hub` → `hub`. */
export function folder(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path
}

export const originLabel = (thread: Pick<ThreadView, 'origin' | 'source'>): string =>
  thread.origin === 'other' && thread.source !== undefined ? thread.source : t(`origin.${thread.origin}` as RelayKey)

/** Who holds it: `Qoder · hub`, `Hermes · mia`. */
export function who(thread: ThreadView): string {
  if (thread.agent === 'hermes') return `Hermes · ${thread.persona}`
  return thread.cwd === undefined ? 'Qoder' : `Qoder · ${folder(thread.cwd)}`
}

export type Group = 'today' | 'yesterday' | 'week' | 'older'

export function groupOf(time: number, now = new Date()): Group {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (time >= midnight) return 'today'
  if (time >= midnight - 86_400_000) return 'yesterday'
  if (time >= midnight - 6 * 86_400_000) return 'week'
  return 'older'
}
