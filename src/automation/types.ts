export const AUTOMATION_METHOD = 'agent-hub/automation'
export const AUTOMATION_TOOL = 'automation_run'

export type ScriptTask = {
  id: string
  title: string
  command: string
  args: readonly string[]
  cwd: string
  provider: string
  model: string
  timeoutMs: number
}
export type AutomationSettings = { tasks: readonly ScriptTask[] }
export type RunResult = { status: 'ok' | 'error' | 'unknown'; summary: string; code?: number }
export type TaskRun = {
  status: 'delivered' | 'running' | 'succeeded' | 'failed' | 'unknown'
  summary?: string
  startedAt?: string
  finishedAt?: string
  occurrence?: string
  code?: number
  kind?: 'scheduled' | 'manual'
  /** When the native scheduler delivered the reminder; set while the run is only `delivered`. */
  deliveredAt?: string
}
export type TaskStatus = {
  id: string
  title: string
  enabled: boolean
  taskId?: string
  sessionId?: string
  nextRun?: string
  time?: string
  timeZone?: string
  error?: string
  run?: TaskRun
  /** The latest user-initiated "run now"; independent of the scheduled receipts. */
  manual?: TaskRun
  /** Finished runs of both kinds, newest first and bounded. */
  history?: TaskRun[]
}
export type AutomationReply = {
  tasks: TaskStatus[]
  definitions: ScriptTask[]
  preset?: ScriptTask
  /** The Qoder CN template can work on this machine (its desktop app's profile is here): offer it. */
  presetAvailable?: boolean
}
