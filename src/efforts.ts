/**
 * The reasoning effort a model starts at. DSH's model selectors put a picked
 * model at its `reasoning.defaultEffort` (and a call that names no effort runs
 * at it), so rewriting that default in each adapter's exact model metadata is
 * what makes one setting apply to every model on every switch. Providers name
 * their levels differently (DeepSeek: off/low/high/max; Claude: low…max), so
 * the shared level falls back along one ladder to the nearest level a model has.
 * Shared by the host and the browser, so it imports nothing host-only.
 */

/** Effort levels from least to most thinking; ids outside it only ever match exactly. */
export const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface EffortRule {
  provider: string
  model: string
  effort: string
}

export interface EffortSettings {
  /** The level every model starts at; blank keeps each model's own default. */
  effort: string
  /** Per-model levels that win over `effort`. */
  rules: readonly EffortRule[]
}

/** `wanted` itself, else the nearest lower level the model has, else the nearest higher one. */
export function nearestEffort(wanted: string, supported: readonly string[]): string | undefined {
  if (wanted === '') return undefined
  if (supported.includes(wanted)) return wanted
  const rank = (id: string): number => (EFFORT_LADDER as readonly string[]).indexOf(id)
  const target = rank(wanted)
  if (target < 0) return undefined
  const ranked = supported.filter((id) => rank(id) >= 0).sort((a, b) => rank(a) - rank(b))
  return ranked.filter((id) => rank(id) < target).at(-1) ?? ranked.find((id) => rank(id) > target)
}

/** The level a model starts at under these settings; undefined keeps its own default. */
export function chooseEffort(settings: EffortSettings, provider: string, model: string, supported: readonly string[]): string | undefined {
  const rule = settings.rules.find((entry) => entry.provider === provider && entry.model === model)
  if (rule !== undefined && supported.includes(rule.effort)) return rule.effort
  return nearestEffort(settings.effort, supported)
}

interface Reasoning {
  efforts: ReadonlyArray<{ id: string }>
  defaultEffort?: string
}

/** An adapter's exact model metadata with its default effort replaced; untouched when nothing changes. */
export function withDefaultEffort<T extends object>(info: T, settings: EffortSettings, provider: string, model: string): T {
  const reasoning = (info as { reasoning?: Reasoning }).reasoning
  if (reasoning === undefined || !Array.isArray(reasoning.efforts)) return info
  const effort = chooseEffort(settings, provider, model, reasoning.efforts.map((entry) => entry.id))
  if (effort === undefined || effort === reasoning.defaultEffort) return info
  return { ...info, reasoning: { ...reasoning, defaultEffort: effort } }
}
