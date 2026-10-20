/**
 * Requests Claude Agent does not answer itself. Claude Agent runs a Claude
 * Code session per conversation and only answers its turns; DSH also sends a
 * session's model background work: compacting the conversation, titling the
 * session. Those go to another model instead: the one set in 设置 → Agent
 * Hub → Claude Agent, else the default model new agents get, else the first
 * model of any other provider. Claude Agent and the bots are never picked:
 * a bot may itself run on Claude Agent.
 */

import { listModelGroups, type ModelCatalog } from '../models.ts'

export interface Route {
  provider: string
  model: string
}

export interface HelperSettings {
  /** Explicit route for background requests; both or neither. */
  helperProvider?: string
  helperModel?: string
}

/**
 * Where a background request of a Claude Agent session goes. `exclude` lists the routes that
 * cannot take it (Claude Agent, the bots); undefined when DSH has no other model at all.
 */
export async function helperRoute(
  settings: HelperSettings,
  defaultRoute: () => Route | undefined,
  catalog: () => ModelCatalog | undefined,
  exclude: readonly string[],
): Promise<Route | undefined> {
  const usable = (route: Route | undefined): route is Route =>
    route !== undefined && route.provider !== '' && route.model !== '' && !exclude.includes(route.provider)
  const configured = { provider: settings.helperProvider?.trim() ?? '', model: settings.helperModel?.trim() ?? '' }
  if (usable(configured)) return configured
  const fallback = defaultRoute()
  if (usable(fallback)) return fallback
  const llm = catalog()
  if (llm === undefined) return undefined
  for (const group of await listModelGroups(llm, exclude)) {
    const model = group.models[0]
    if (model !== undefined) return { provider: group.provider, model: model.id }
  }
  return undefined
}

/**
 * The same request for another model: everything DSH sent (messages, tools, purpose, session,
 * signal) but the route, minus what only Claude Agent reads (a bot's persona) or what is
 * specific to the original model (its reasoning effort).
 */
export function helperRequest<T extends { provider: string; model: string }>(options: T, route: Route): Omit<T, 'persona' | 'reasoningEffort'> {
  const { persona: _persona, reasoningEffort: _effort, ...rest } = options as T & { persona?: unknown; reasoningEffort?: unknown }
  return { ...rest, provider: route.provider, model: route.model }
}
