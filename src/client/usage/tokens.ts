/**
 * Token totals for display: the host's day rows folded into one period, by
 * provider route and model, plus the remembered choices of both surfaces.
 */

import type { TokenCounts, TokenUsage } from '../../usage/types.ts'

export type Period = 'today' | '7d' | '30d' | 'all'
export const PERIODS: readonly Period[] = ['today', '7d', '30d', 'all']
const SPAN: Record<Exclude<Period, 'all'>, number> = { today: 1, '7d': 7, '30d': 30 }

export interface Tally extends TokenCounts {
  total: number
}
export interface ModelTally extends Tally {
  model: string
}
export interface ProviderTally extends Tally {
  provider: string
  name: string
  models: ModelTally[]
}
export interface Summary extends Tally {
  providers: ProviderTally[]
}

const zero = (): Tally => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

function addTo(tally: Tally, counts: TokenCounts): void {
  tally.input += counts.input
  tally.output += counts.output
  tally.cacheRead += counts.cacheRead
  tally.cacheWrite += counts.cacheWrite
  tally.total += counts.input + counts.output + counts.cacheRead + counts.cacheWrite
}

/** The first day a period covers, counting `today` (the host's day) in; nothing for `all`. */
export function firstDay(today: string, period: Period): string | undefined {
  if (period === 'all') return undefined
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  const start = new Date(Date.UTC(year, month - 1, day - (SPAN[period] - 1)))
  return start.toISOString().slice(0, 10)
}

/** One period's totals, providers and their models largest first. */
export function summarize(usage: TokenUsage, period: Period): Summary {
  const from = firstDay(usage.today, period)
  const summary: Summary = { ...zero(), providers: [] }
  const providers = new Map<string, ProviderTally & { byModel: Map<string, ModelTally> }>()
  for (const row of usage.rows) {
    if (from !== undefined && row.day < from) continue
    let provider = providers.get(row.provider)
    if (provider === undefined) {
      provider = { ...zero(), provider: row.provider, name: usage.providers[row.provider] ?? row.provider, models: [], byModel: new Map() }
      providers.set(row.provider, provider)
    }
    let model = provider.byModel.get(row.model)
    if (model === undefined) {
      model = { ...zero(), model: row.model }
      provider.byModel.set(row.model, model)
    }
    addTo(model, row)
    addTo(provider, row)
    addTo(summary, row)
  }
  const byTotal = (a: Tally, b: Tally): number => b.total - a.total
  summary.providers = [...providers.values()]
    .filter((provider) => provider.total > 0)
    .map(({ byModel, ...provider }) => ({ ...provider, models: [...byModel.values()].filter((model) => model.total > 0).sort(byTotal) }))
    .sort(byTotal)
  return summary
}

/** Share of the prompt side served from cache; undefined when nothing was sent. */
export function hitRate(counts: TokenCounts): number | undefined {
  const prompt = counts.input + counts.cacheRead + counts.cacheWrite
  return prompt === 0 ? undefined : counts.cacheRead / prompt
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 })
const EXACT = new Intl.NumberFormat('en')

/** `217M`, `41.9K`: token counts read in K/M/B in every locale. */
export const compact = (value: number): string => COMPACT.format(value)
export const exact = (value: number): string => EXACT.format(value)

/** Percent of `whole`, rounded; `<1` for a sliver that would otherwise read as nothing. */
export function percent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0'
  const value = (part / whole) * 100
  return value < 1 ? '<1' : String(Math.round(value))
}

/** The brand dot of a DSH provider route, where the quota cards have one. */
export function hueOf(provider: string): 'claude' | 'codex' | 'minimax' | 'cursor' | 'qoder' | undefined {
  if (/cursor/i.test(provider)) return 'cursor'
  if (/qoder/i.test(provider)) return 'qoder'
  if (/claude|anthropic/i.test(provider)) return 'claude'
  if (/minimax/i.test(provider)) return 'minimax'
  if (/codex|openai/i.test(provider)) return 'codex'
  return undefined
}

/** A value kept in localStorage and shared by every surface that reads it. */
export interface Remembered<T> {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

export function remembered<T>(key: string, fallback: T, parse: (raw: string) => T | undefined): Remembered<T> {
  const listeners = new Set<() => void>()
  let value: T | undefined
  return {
    get() {
      if (value === undefined) {
        let raw: string | null = null
        try {
          raw = localStorage.getItem(key)
        } catch {
          // Storage may be off; the fallback stands.
        }
        value = (raw === null ? undefined : parse(raw)) ?? fallback
      }
      return value
    },
    set(next) {
      value = next
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Remembered for this page only.
      }
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** The period both surfaces show; today until the reader picks another. */
export const periodChoice = remembered<Period>('dsh-agent-hub.tokens.period', 'today', (raw) => {
  const value = json(raw)
  return PERIODS.includes(value as Period) ? value as Period : undefined
})

/** Providers the popover shows expanded. */
export const expandedChoice = remembered<readonly string[]>('dsh-agent-hub.tokens.expanded', [], (raw) => {
  const value = json(raw)
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
})
