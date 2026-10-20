/**
 * Which models DSH's model selectors offer, and the reasoning effort each
 * starts at. DSH builds every selector (the composer's model slot, /model,
 * the default-model setting, subagent routes) from each provider adapter's
 * `listModels`, so narrowing that list is what hides a model: a hidden
 * provider lists nothing (its group disappears) and Claude Agent lists only
 * the models enabled in settings. Routing is untouched — DSH's own background
 * calls (session titles, compaction) and the commit-message route still reach
 * a hidden model. The effort a picked model starts at is its exact metadata's
 * `reasoning.defaultEffort` (see efforts.ts), so `resolveModel` and
 * `prepareCall` are wrapped to rewrite it. Models that carry a billing kind
 * (Cursor's) list those the plan includes first, their names tagged, since
 * the selectors group by provider only.
 *
 * The adapters belong to other plugins, so their methods are wrapped in
 * place and restored on dispose; registrations that arrive later are wrapped
 * on `llm/adapters-updated`.
 */

import { withDefaultEffort, type EffortSettings } from './efforts.ts'
import { localized } from './locale.ts'
import type { Billing } from './cursor/billing.ts'

export interface ModelEntry {
  provider: string
  id: string
  name: string
  description?: string
  billing?: Billing
}

interface Adapter {
  listModels(provider: string): Promise<ModelEntry[]>
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<object>
  prepareCall?(provider: string, model: string, signal?: AbortSignal): Promise<{ model: object }>
}

type Method = 'listModels' | 'resolveModel' | 'prepareCall'

/** The slice of dsh-llm's service this reads. `registration` is how the service resolves a route to its adapter. */
export interface LlmRegistry {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<ModelEntry[]>
  registration?(provider: string): { adapter: Adapter }
}

export interface VisibilitySettings {
  /** Provider routes whose models no selector offers. */
  hiddenProviders: readonly string[]
  /** Per provider, the only models offered; a missing or empty list offers every model. */
  enabled: Readonly<Record<string, readonly string[]>>
  /** The effort models start at; absent leaves every adapter's default. */
  efforts?: EffortSettings
  /** Routes whose models are other routes' models (the bots): they already carry their target's effort. */
  inherited?: readonly string[]
}

/**
 * An enabled list's "no model": an empty list already means every model, so none is a list holding
 * only this id, which no agent lists. Written by the settings page's 全不选.
 */
export const NO_MODELS = '(none)'

export function visibleModels<T extends { id: string }>(settings: VisibilitySettings, provider: string, models: T[]): T[] {
  if (settings.hiddenProviders.includes(provider)) return []
  const enabled = settings.enabled[provider]
  return enabled === undefined || enabled.length === 0 ? models : models.filter((model) => enabled.includes(model.id))
}

/** The selectors' order and names: models the plan includes first, tagged; the rest as listed. */
export function presentModels<T extends { name: string; billing?: Billing }>(models: T[], tag = localized({ zh: '套餐内', en: 'Included' })): T[] {
  if (!models.some((model) => model.billing === 'included')) return models
  const included = models.filter((model) => model.billing === 'included').map((model) => ({ ...model, name: `${model.name} · ${tag}` }))
  return [...included, ...models.filter((model) => model.billing !== 'included')]
}

export interface Visibility {
  /** Wrap adapters registered since the last call. */
  sync(): void
  /** The registry's catalog before filtering: the settings page lists hidden models too, at their own default effort. */
  unfiltered: {
    listProviders(): Array<{ id: string; name: string }>
    listModels(provider: string): Promise<ModelEntry[]>
    resolveModel(provider: string, model: string): Promise<object>
  }
  dispose(): void
}

type Fn = (...args: never[]) => unknown

/**
 * What a wrapper of this module held, kept on the wrapper itself under a global symbol: DSH reloads
 * the plugin in place, and a new copy must see through the old copy's wrapper (not stack on it, not
 * mistake it for the adapter's own method), even before the old copy is disposed.
 */
const WRAPPER = Symbol.for('dsh-agent-hub.visibility.wrapper')
interface Wrapped { own: unknown; original: Fn }
const wrappedBy = (value: unknown): Wrapped | undefined =>
  typeof value === 'function' ? (value as { [WRAPPER]?: Wrapped })[WRAPPER] : undefined
/** Past every wrapper of ours: what the adapter held before any of them. */
const ownBefore = (value: unknown): unknown => {
  for (let tag = wrappedBy(value); tag !== undefined; tag = wrappedBy(value)) value = tag.own
  return value
}
const originalBefore = (value: unknown): unknown => {
  for (let tag = wrappedBy(value); tag !== undefined; tag = wrappedBy(value)) value = tag.original
  return value
}

export function createVisibility(llm: LlmRegistry, settings: () => VisibilitySettings, log?: (message: string) => void): Visibility {
  /** Wrapped adapter → per method, the wrapper set and what it held. */
  const wrapped = new Map<Adapter, Map<Method, Wrapped & { wrapper: Fn }>>()
  let warned = false

  const adapterOf = (provider: string): Adapter | undefined => {
    if (typeof llm.registration !== 'function') {
      if (!warned) log?.('this DSH version does not expose adapter registrations; model visibility settings have no effect')
      warned = true
      return undefined
    }
    try {
      return llm.registration(provider).adapter
    } catch {
      return undefined
    }
  }

  const effort = <T extends object>(info: T, provider: string, model: string): T => {
    const current = settings()
    return current.efforts === undefined || current.inherited?.includes(provider) ? info : withDefaultEffort(info, current.efforts, provider, model)
  }

  const wrap = <M extends Method>(adapter: Adapter, methods: Map<Method, Wrapped & { wrapper: Fn }>, method: M, replace: (original: NonNullable<Adapter[M]>) => NonNullable<Adapter[M]>): void => {
    const original = originalBefore(adapter[method])
    if (typeof original !== 'function') return
    // Read past any `get` trap: what the adapter (a proxy's target) itself holds.
    const own = ownBefore(Object.getOwnPropertyDescriptor(adapter, method)?.value)
    const inherited: unknown = Reflect.get(Object.getPrototypeOf(adapter) ?? {}, method, adapter)
    // The method itself: the class's, else the adapter's own. A function another copy of this module
    // left behind before it carried a mark can sit in `own`; the class's never leads back here.
    const underlying = (typeof inherited === 'function' ? inherited : own) as Fn | undefined
    const replaced = replace(original as NonNullable<Adapter[M]>) as Fn
    // A proxied adapter can answer `adapter[method]` with a closure that calls its target's method
    // when called, and that is this wrapper once set: inside that call, run the method itself.
    let inside = false
    const wrapper = function (this: unknown, ...args: never[]): unknown {
      if (inside && typeof underlying === 'function') return underlying.apply(this, args)
      inside = true
      try {
        return replaced.apply(this, args)
      } finally {
        inside = false
      }
    }
    const held: Wrapped = { own, original: original as Fn }
    Object.defineProperty(wrapper, WRAPPER, { value: held })
    methods.set(method, { ...held, wrapper })
    adapter[method] = wrapper as unknown as NonNullable<Adapter[M]>
  }

  const sync = (): void => {
    for (const { id } of llm.listProviders()) {
      const adapter = adapterOf(id)
      if (adapter === undefined || wrapped.has(adapter) || typeof adapter.listModels !== 'function') continue
      const methods = new Map<Method, Wrapped & { wrapper: Fn }>()
      wrapped.set(adapter, methods)
      wrap(adapter, methods, 'listModels', (original) => async (provider) => presentModels(visibleModels(settings(), provider, await original.call(adapter, provider))))
      wrap(adapter, methods, 'resolveModel', (original) => async (provider, model, signal) => effort(await original.call(adapter, provider, model, signal), provider, model))
      wrap(adapter, methods, 'prepareCall', (original) => async (provider, model, signal) => {
        const call = await original.call(adapter, provider, model, signal)
        const info = effort(call.model, provider, model)
        return info === call.model ? call : { ...call, model: info }
      })
    }
  }

  const original = <M extends Method>(adapter: Adapter, method: M): Adapter[M] =>
    (wrapped.get(adapter)?.get(method)?.original ?? adapter[method]) as Adapter[M]

  return {
    sync,
    unfiltered: {
      listProviders: () => llm.listProviders(),
      async listModels(provider) {
        const adapter = adapterOf(provider)
        return adapter === undefined ? llm.listModels(provider) : original(adapter, 'listModels').call(adapter, provider)
      },
      async resolveModel(provider, model) {
        const adapter = adapterOf(provider)
        const resolve = adapter === undefined ? undefined : original(adapter, 'resolveModel')
        if (resolve === undefined) throw new Error(`no adapter resolves provider "${provider}"`)
        return resolve.call(adapter, provider, model)
      },
    },
    dispose() {
      for (const [adapter, methods] of wrapped) {
        for (const [method, { own, wrapper }] of methods) {
          // Replaced since (a newer copy of this module wrapped it): theirs stays.
          if (Object.getOwnPropertyDescriptor(adapter, method)?.value !== wrapper) continue
          if (own === undefined) delete (adapter as Partial<Adapter>)[method]
          else (adapter as unknown as Record<Method, unknown>)[method] = own
        }
      }
      wrapped.clear()
    },
  }
}
