/**
 * The model directory the settings page offers for commit messages: every
 * provider registered with DSH's llm service and the models it advertises,
 * the same catalog DSH's own model selector shows. Shared by the host RPC and
 * the browser, so it imports nothing host-only.
 */

import type { Billing } from './cursor/billing.ts'

export const MODELS_METHOD = 'agent-hub/models'

export interface ModelGroup {
  provider: string
  /** Display name of the provider route. */
  name: string
  /** `description`: a line on what a model is, beside it in the settings (a Hermes persona's). */
  models: Array<{ id: string; name: string; reasoning?: ModelReasoning; billing?: Billing; description?: string }>
  /** The provider's catalog could not be read; it is listed without models. */
  failed?: boolean
}

/** A model's reasoning levels and the one it defaults to on its own (before the effort settings). */
export interface ModelReasoning {
  efforts: Array<{ id: string; name: string }>
  defaultEffort?: string
}

/** The slice of dsh-llm's service the directory reads. `resolveModel` (the adapter's own metadata) adds reasoning levels. */
export interface ModelCatalog {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string; billing?: Billing; description?: string }>>
  resolveModel?(provider: string, model: string): Promise<object>
}

/**
 * Every registered provider's models, in registration order; `exclude` drops routes that cannot serve the request.
 * `reasoning` also reads each model's reasoning levels (one metadata lookup per model).
 */
export async function listModelGroups(llm: ModelCatalog, exclude: readonly string[] = [], reasoning = false): Promise<ModelGroup[]> {
  const providers = llm.listProviders().filter((provider) => !exclude.includes(provider.id))
  return Promise.all(providers.map(async (provider): Promise<ModelGroup> => {
    try {
      const models = await llm.listModels(provider.id)
      return {
        provider: provider.id,
        name: provider.name,
        models: await Promise.all(models.map(async (model) => {
          const levels = reasoning ? await reasoningOf(llm, provider.id, model.id) : undefined
          return {
            id: model.id,
            name: model.name,
            ...(levels === undefined ? {} : { reasoning: levels }),
            ...(model.billing === undefined ? {} : { billing: model.billing }),
            ...(typeof model.description === 'string' ? { description: model.description } : {}),
          }
        })),
      }
    } catch {
      return { provider: provider.id, name: provider.name, models: [], failed: true }
    }
  }))
}

async function reasoningOf(llm: ModelCatalog, provider: string, model: string): Promise<ModelReasoning | undefined> {
  if (llm.resolveModel === undefined) return undefined
  try {
    const reasoning = (await llm.resolveModel(provider, model) as { reasoning?: { efforts?: unknown; defaultEffort?: unknown } }).reasoning
    if (reasoning === undefined || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return undefined
    const efforts = (reasoning.efforts as Array<{ id?: unknown; name?: unknown }>)
      .filter((effort) => typeof effort.id === 'string')
      .map((effort) => ({ id: String(effort.id), name: typeof effort.name === 'string' ? effort.name : String(effort.id) }))
    return { efforts, ...(typeof reasoning.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}) }
  } catch {
    // A model whose metadata cannot be read is still listed, without levels.
    return undefined
  }
}
