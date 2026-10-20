/**
 * Which optional modules are on (设置 → Agent Hub → 功能模块), for every browser: the reader's
 * and the relay's panels come and go with them, and the Codex plugin's state drives the offer
 * to install or enable it. The last answer is remembered, so a reload shows the same panels
 * before the host answers again; the settings page passes on its edits at once, and another
 * browser catches up when its window gets the focus back.
 */

import { MODULES_METHOD, type CodexPlugin, type CodexSetup, type ModuleName, type ModulesStatus } from '../modules.ts'
import { rpcValue, type Rpc } from './rpc.ts'

const KEY = 'dsh-agent-hub.modules.v1'

export interface ModulesSnapshot {
  status: ModulesStatus | undefined
  /** An install or enable of the Codex plugin running, and how the last one ended. */
  codexBusy: boolean
  codexError?: string
  codexRestart?: boolean
}

function remembered(): ModulesStatus | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ModulesStatus | null
    return value !== null && typeof value.modules === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

export class ModulesStore {
  private snapshot: ModulesSnapshot = { status: remembered(), codexBusy: false }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly rpc: Rpc) {}

  getSnapshot = (): ModulesSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  on(name: ModuleName): boolean {
    return this.snapshot.status?.modules[name] === true
  }

  codex(): CodexPlugin | undefined {
    return this.snapshot.status?.codex
  }

  private set(next: Partial<ModulesSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    if (next.status !== undefined) {
      try { localStorage.setItem(KEY, JSON.stringify(next.status)) } catch { /* private mode */ }
    }
    for (const listener of this.listeners) listener()
  }

  refresh = async (): Promise<void> => {
    try {
      this.set({ status: await rpcValue<ModulesStatus>(this.rpc, MODULES_METHOD, { op: 'status' }, 'agent-hub modules RPC failed') })
    } catch {
      // An older host without the method: keep what is known.
    }
  }

  /** The settings page saved new switches: follow them without asking the host. */
  apply(modules: unknown): void {
    const current = this.snapshot.status
    if (current === undefined || modules === null || typeof modules !== 'object') return
    const next = { ...current.modules, ...(modules as Partial<ModulesStatus['modules']>) }
    if (Object.entries(next).every(([name, on]) => current.modules[name as ModuleName] === on)) return
    this.set({ status: { ...current, modules: next } })
  }

  /** Install or switch on dsh-codex-subscription; `changed` reads the usage again afterwards. */
  setUpCodex = async (action: 'install' | 'enable', changed?: () => void): Promise<void> => {
    if (this.snapshot.codexBusy) return
    this.set({ codexBusy: true, codexError: undefined })
    try {
      const result = await rpcValue<CodexSetup>(this.rpc, MODULES_METHOD, { op: 'codex', action }, 'agent-hub modules RPC failed')
      const status = this.snapshot.status
      this.set({ codexRestart: result.restart === true, ...(status === undefined ? {} : { status: { ...status, codex: result.codex } }) })
      changed?.()
    } catch (error) {
      this.set({ codexError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.set({ codexBusy: false })
    }
  }

  /** Keep what `start` sets up while a module is on, undoing it when it goes off. Returns the stop. */
  follow(name: ModuleName, start: () => () => void): () => void {
    let stop: (() => void) | undefined
    const sync = (): void => {
      if (this.on(name) && stop === undefined) stop = start()
      else if (!this.on(name) && stop !== undefined) {
        stop()
        stop = undefined
      }
    }
    sync()
    const off = this.subscribe(sync)
    return () => {
      off()
      stop?.()
      stop = undefined
    }
  }

  /** Read again whenever the window gets the focus back. Returns the stop. */
  watch(): () => void {
    void this.refresh()
    const onFocus = (): void => { void this.refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }
}
