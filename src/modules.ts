/**
 * Optional modules, switched on and off on 设置 → Agent Hub's 功能模块 card
 * (`modules` in cordis.patch.yml). Off, a module stops its background work and
 * its panels, pages and settings group leave the page; the switch applies at
 * once, without a restart. The clipboard window and the Cardputer belong to one
 * machine (sync/portable.ts keeps them local); the rest travel with the settings.
 *
 * Codex is a module of its own because everything of it here (usage, account
 * switch, model filter) stands on another plugin, dsh-codex-subscription: while
 * it is missing or off, the usage card and the model settings offer to install
 * or enable it, through DSH's plugin manager.
 */

/** The browser's method for the switches and the Codex plugin's state. */
export const MODULES_METHOD = 'agent-hub/modules'

export const MODULES = ['reader', 'relay', 'palette', 'device', 'codex'] as const
export type ModuleName = typeof MODULES[number]
export type ModulesSettings = Record<ModuleName, boolean>

/** The plugin Codex usage, accounts and models come from. */
export const CODEX_PLUGIN = 'dsh-codex-subscription'
/** Whether that plugin is installed and on. */
export type CodexPlugin = 'missing' | 'off' | 'on'

export interface ModulesStatus {
  modules: ModulesSettings
  codex: CodexPlugin
}

export type ModulesRequest = { op?: 'status' } | { op: 'codex'; action: 'install' | 'enable' }

export interface CodexSetup {
  codex: CodexPlugin
  /** The plugin runs only after DSH restarts. */
  restart?: boolean
}

/** The parts of DSH's plugin manager used here. */
export interface BundleManager {
  listBundles(): Promise<Array<{ name: string; installed: boolean; enabled: boolean }>>
  installBundle(spec: string, options: { enabled: boolean; requestId: string; saveExact: boolean }): Promise<Outcome>
  setBundleEnabled(name: string, enabled: boolean): Promise<Outcome>
}

interface Outcome {
  application?: string
  error?: { code?: string; diagnostic?: string }
}

/** Where dsh-codex-subscription stands; a manager that cannot tell leaves things as they were ('on'): no prompt. */
export async function codexPlugin(manager: Pick<BundleManager, 'listBundles'> | undefined): Promise<CodexPlugin> {
  const bundles = await manager?.listBundles().catch(() => undefined)
  if (bundles === undefined) return 'on'
  const bundle = bundles.find((entry) => entry.name === CODEX_PLUGIN)
  return bundle?.installed !== true ? 'missing' : bundle.enabled ? 'on' : 'off'
}

/** Install (from the registry) or switch on dsh-codex-subscription. */
export async function setUpCodex(manager: BundleManager | undefined, action: 'install' | 'enable'): Promise<CodexSetup> {
  if (manager === undefined) throw new Error('DSH\'s plugin manager is unavailable')
  const outcome = action === 'install'
    ? await manager.installBundle(CODEX_PLUGIN, { enabled: true, requestId: crypto.randomUUID(), saveExact: true })
    : await manager.setBundleEnabled(CODEX_PLUGIN, true)
  if (outcome.application === 'failed' || outcome.application === 'cancelled' || outcome.error !== undefined) {
    throw new Error(outcome.error?.diagnostic ?? outcome.error?.code ?? outcome.application ?? `${action} failed`)
  }
  return { codex: await codexPlugin(manager), ...(outcome.application === 'restart-required' ? { restart: true } : {}) }
}
