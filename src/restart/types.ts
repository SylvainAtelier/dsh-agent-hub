export const RESTART_METHOD = 'agent-hub/restart'

export interface RestartStatus {
  supported: boolean
  /** Sessions in or queued for a turn, and background jobs: what a restart interrupts. */
  running: number
  /** Changes with every Host start; the browser reloads once it sees a new one. */
  boot: string
  /** Plugins the restart upgrades between quitting and opening again (plugins/pending.ts). */
  upgrades?: Array<{ name: string; spec: string; from?: string }>
}
