/**
 * 接力 (Relay): what external agents did elsewhere, and taking it over. The
 * threads are read from the agents' own stores: Qoder CLI CN's session files
 * (tasks from the glasses, the app, qoder.cn and the terminal) and each Hermes
 * persona's state.db (Telegram, the terminal, cron jobs). Taking one over
 * opens a DSH session on that agent's route which continues it: in place
 * where the agent can load it (Qoder), else as a new conversation that
 * carries its history (Hermes' non-ACP sessions).
 */

import type { QoderStatus, TaskView } from '../qoder/types.ts'

export const RELAY_METHOD = 'agent-hub/relay'

export type RelayAgent = 'qoder' | 'hermes'

/**
 * Where a thread came from. `glasses`: Qoder remote control (the glasses, the
 * app, qoder.cn/agents). `cloud`: a Qoder cloud session sent from here.
 */
export type Origin = 'glasses' | 'cloud' | 'cli' | 'tui' | 'telegram' | 'cron' | 'api' | 'other'

/** `ended`: closed by its agent (a Hermes chat reset, a cron run done, an archived task). `cloud`: runs in Qoder's cloud, followed on the web. */
export type ThreadPhase = 'running' | 'idle' | 'failed' | 'ended' | 'cloud'

/** How a takeover continues a thread: the agent loads it (`load`), or a new conversation starts from its history (`context`). */
export type Takeover = 'load' | 'context'

export interface ThreadView {
  /** `qoder:<session>` or `hermes:<persona>:<session>`. */
  key: string
  agent: RelayAgent
  id: string
  /** The Hermes persona it belongs to. */
  persona?: string
  origin: Origin
  /** The agent's own name for the source, when `origin` is `other`. */
  source?: string
  title: string
  /** One line under the title: the tool at work, the answer's opening, the failure. */
  detail?: string
  cwd?: string
  branch?: string
  model?: string
  phase: ThreadPhase
  startedAt: number
  updatedAt: number
  /** Prompts sent in it so far. */
  prompts?: number
  /** Where it is followed on the web (Qoder). */
  url?: string
  takeover: Takeover
  /** The DSH session it was taken over into. */
  session?: string
  /** The remote-control task, while a workspace's daemon follows it: its worker, the tool in progress. */
  task?: TaskView
  /** A shell line that continues it in a terminal. */
  command: string
}

export interface Turn {
  role: 'user' | 'assistant' | 'tool'
  text: string
  at?: number
}

export interface ThreadDetail {
  thread: ThreadView
  turns: Turn[]
  /** Earlier turns were left out. */
  truncated: boolean
}

export interface RelayStatus {
  qoder: QoderStatus
  hermes: { installed: boolean }
  /** Newest first. */
  threads: ThreadView[]
}

/** A read: `boot` names this host run and `epoch` counts its changes, for the next long poll. */
export interface RelayUpdate {
  boot: string
  epoch: number
  status: RelayStatus
}

export type RelayRequest =
  /** The state now if it changed after `since` (or the host restarted), else once it changes or a few seconds pass. `watch`: the panel is shown (sample the processes). */
  | { op: 'status'; boot?: string; since?: number; watch?: boolean }
  | { op: 'thread'; key: string }
  /** Continue a thread in DSH (the session it was taken over into, or a new one), sending `text` when given. */
  | { op: 'takeover'; key: string; text?: string }
  /** Continue it in a terminal window of this machine. */
  | { op: 'terminal'; key: string }
  /** A new Qoder cloud session for `task`, from a workspace. */
  | { op: 'cloud'; path: string; task: string }
  | { op: 'start' | 'stop' | 'reap'; path: string }

export interface TakeoverResult {
  session: string
}
