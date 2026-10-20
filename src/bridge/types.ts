/**
 * The glasses bridge: the `dsh` command Qoder's remote-control workers (the
 * glasses, the Qoder app) run to reach DSH, and the composer's bell that sends
 * a session's outcome back to the glasses.
 *
 * Measured against Qoder CLI CN 1.1.73: a worker's shell is Git Bash with the
 * daemon's environment, and a background command (`run_in_background`, or a
 * persistent `Monitor`) that ends or prints wakes the worker for a new turn,
 * which the glasses announce. So a hand-off runs `dsh ask` in the background
 * and its answer comes back in the same conversation. Everything else DSH
 * tells the glasses is a message posted into their latest session (post.ts),
 * whose worker answers it.
 */

export const GLASSES_METHOD = 'agent-hub/glasses'

export type GlassesRequest =
  /** The state now if it changed after `since` (or the host restarted), else once it changes or a few seconds pass. */
  | { op: 'status'; boot?: string; since?: number }
  /** Tell the glasses when this session's turn ends (once), or stop. */
  | { op: 'arm'; sessionId: string; on: boolean }

export interface GlassesStatus {
  /** A glasses session can take a message now (one in a running workspace has answered before). */
  reachable: boolean
  /** None reachable, yet a workspace is online: the web page that opens a glasses session there (the first one comes from the glasses or this page). */
  opener?: string
  /** A message is going in now. */
  sending: boolean
  /** Notifications held until one can. */
  queued: number
  /** Sessions whose turn end is told to the glasses. */
  armed: string[]
}

export interface GlassesUpdate {
  boot: string
  epoch: number
  status: GlassesStatus
}

/** What a hand-off or a session stands at, as the `dsh` command reports it. */
export type SessionPhase = 'running' | 'approval' | 'done' | 'failed' | 'stopped' | 'idle'

export interface SessionReport {
  session: string
  title: string
  cwd: string
  phase: SessionPhase
  /** `provider / model` the session runs on, when known. */
  model?: string
  /** The tool waiting for approval, or in progress. */
  tool?: string
  /** The last answer (or its opening, in a list). */
  text?: string
  updatedAt: number
}
