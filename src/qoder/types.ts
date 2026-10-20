/**
 * Qoder remote control (the glasses, the phone app, qoder.cn/agents): the
 * shapes both halves share. Each configured workspace runs one
 * `qoderclicn remote-control` daemon while DSH runs; tasks sent from the
 * glasses run on this machine, in the workspace itself unless one asks for a worktree.
 */

export const QODER_METHOD = 'agent-hub/qoder'

export type QoderRequest =
  /** The state now if it changed after `since` (or the host restarted), else once it changes or a few seconds pass. */
  | { op: 'status'; boot?: string; since?: number }
  | { op: 'start'; path: string }
  | { op: 'stop'; path: string }
  /** Reclaim the answered tasks' workers now instead of after the idle wait. */
  | { op: 'reap'; path: string }

/**
 * Where a workspace's daemon stands.
 * `starting`: launched, not yet connected. `online`: reachable from the glasses.
 * `retrying`: it exited or lost its connection and starts again by itself.
 * `stopped`: stopped here, until started again (or DSH starts next).
 */
export type DaemonPhase = 'stopped' | 'starting' | 'online' | 'retrying'

/**
 * A task as the daemon reports it. `starting`: dispatched, its worker not up
 * yet. `running`: working. `idle`: answered, its worker kept for follow-ups.
 * `dormant`: answered, its worker reclaimed (or archived in the app: the two
 * look alike from here); a follow-up starts one again, restoring the
 * conversation from the server. `failed`: stopped with an error. `closed`:
 * gone while it ran.
 */
export type TaskPhase = 'starting' | 'running' | 'idle' | 'dormant' | 'failed' | 'closed'

/** A running process: its pid and, while the panel is shown, what it costs. */
export interface ProcView {
  pid: number
  /** Resident memory in bytes. */
  rss?: number
  /** CPU over the last few seconds, in percent of one core. */
  cpu?: number
  startedAt?: number
}

export interface TaskView {
  id: string
  /** The task as the agent received it (the glasses tidy up what was said). */
  prompt?: string
  phase: TaskPhase
  /** The tool call in progress or last made: `Edit: README.md`. */
  tool?: string
  /** The answer's opening, once answered. */
  summary?: string
  error?: string
  /** Its worker process, while it has one. */
  worker?: ProcView
  /** Messages its worker restored from the server when it started. */
  restored?: number
  /** Where the task is followed on the web; the app shows the same. */
  url: string
  startedAt: number
  updatedAt: number
}

export interface WorkspaceView {
  path: string
  /** The name the glasses and the app show for this machine's environment. */
  name: string
  phase: DaemonPhase
  /** Why it is not online, when something went wrong. */
  error?: string
  /** The Qoder environment id, once connected: opening a new task on the web needs it. */
  env?: string
  /** The daemon's own process, while it runs. */
  daemon?: ProcView
  /** Answered tasks' workers are reclaimed after this many idle minutes; 0 keeps them. */
  idleMinutes: number
  /** When they will be, if nothing runs until then. */
  reapAt?: number
  /** Not reclaimed for now: a `dsh` command (a hand-off, the glasses' inbox) waits on a worker here. */
  held?: boolean
  /** No reclaims this run: its workers file could not be changed. */
  unreapable?: boolean
  /** Reclaims this DSH run: workers, the memory they held, the last one. */
  reaped: { workers: number; bytes: number; at?: number }
  tasks: TaskView[]
}

/** A read of the daemons: `boot` names this host run and `epoch` counts its changes, for the next long poll. */
export interface QoderUpdate {
  boot: string
  epoch: number
  status: QoderStatus
}

export interface QoderStatus {
  /** Whether Qoder CLI CN is installed on this machine. */
  installed: boolean
  workspaces: WorkspaceView[]
}

const WEB = 'https://qoder.cn/agents'

export const sessionUrl = (id: string): string => `${WEB}/session/${id}`
export const newTaskUrl = (env: string): string => `${WEB}/session/new?envId=${encodeURIComponent(env)}`
