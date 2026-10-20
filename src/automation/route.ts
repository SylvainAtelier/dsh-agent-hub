import { BOT_ROUTE } from '../team/types.ts'
import type { ScriptTask } from './types.ts'

export interface AutomationRoute { provider: string; model: string }
export interface AutomationBot { id: string; provider?: string; model?: string; tools?: readonly string[] }
// Actual provider ids exported by the external agent adapters. Do not import adapters here: they load SDKs.
const EXTERNAL = new Set(['claude-agent', 'cursor-agent', 'qoder-agent', 'hermes-agent'])

/** Validate the selected route and the bot's underlying route without changing global helper selection. */
export function resolveAutomationRoute(def: Pick<ScriptTask, 'provider' | 'model'>, bots: readonly AutomationBot[], defaultRoute?: AutomationRoute): AutomationRoute {
  const route = { provider: def.provider.trim(), model: def.model.trim() }
  if (!route.provider || !route.model) throw new Error('Automation requires an explicit provider and model')
  if (EXTERNAL.has(route.provider)) throw new Error('External agent routes cannot run automation')
  if (route.provider === BOT_ROUTE) {
    const bot = bots.find((item) => item.id === route.model)
    if (!bot) throw new Error('Automation bot does not exist')
    if (!bot.tools?.includes('automation_run')) throw new Error('Automation bot must explicitly allow automation_run')
    if (!!bot.provider?.trim() !== !!bot.model?.trim()) throw new Error('Automation bot route is incomplete')
    const underlying = bot.provider?.trim() && bot.model?.trim() ? { provider: bot.provider.trim(), model: bot.model.trim() } : defaultRoute
    if (!underlying?.provider || !underlying.model || underlying.provider === BOT_ROUTE || EXTERNAL.has(underlying.provider)) throw new Error('Automation bot requires an available native model route')
  }
  return route
}
