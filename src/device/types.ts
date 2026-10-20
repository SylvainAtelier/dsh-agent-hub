/**
 * Cardputer device module: the shapes the host, the settings page and the
 * device share. The wire protocol (one WebSocket over TLS 1.2-PSK) is
 * documented in docs/device-protocol.md; these types follow it.
 */

export const DEVICE_METHOD = 'agent-hub/device'

/**
 * What one session is doing, as the device shows it. Firmware renders an
 * unknown value as RUNNING, so the host may add states without breaking it.
 */
export type AgentState = 'IDLE' | 'RUNNING' | 'THINKING' | 'TOOL' | 'SUBAGENT' | 'WAIT_APPROVAL' | 'WAIT_INPUT' | 'DONE' | 'ERROR'

export interface AgentRow {
  /** The DSH session id. */
  id: string
  /** The model route's display name (Claude, Cursor, DeepSeek, …). */
  agent: string
  /** The workspace folder's name. */
  ws: string
  state: AgentState
  /** The tool running now, in TOOL and SUBAGENT. */
  tool?: string
  /** The session title, or its current to-do. */
  task: string
  /** Epoch seconds the current state began. */
  since: number
  model?: string
}

/** An approval waiting on the user. `risk`: answerable on the device only by denying. */
export interface Ask {
  id: string
  sid: string
  tool: string
  text: string
  cwd: string
  risk: boolean
}

/** Host → device frames. */
export type HostFrame =
  | { t: 'view'; rev: number; focus?: string; agents: AgentRow[]; ask?: Ask; approve: boolean }
  | { t: 'heard'; id: string; text: string; target: 'agent' | 'type'; sid?: string; app?: string }
  | { t: 'ack'; id: string; ok: boolean; error?: string }
  // Pairing (the `pair` PSK identity only).
  | { t: 'pair-commit'; pk: string; c: string; host: string; hostId: string }
  | { t: 'pair-reveal'; n: string }
  | { t: 'paired'; id: string }
  | { t: 'pair-fail'; reason: string }

export type CommandOp = 'send' | 'select' | 'stop' | 'resume' | 'approve' | 'deny' | 'type'

/** Device → host frames. Binary frames carry the open voice's 16 kHz 16-bit mono PCM. */
export type DeviceFrame =
  | { t: 'hello'; fw?: string; bat?: number; rssi?: number }
  | { t: 'cmd'; id: string; op: CommandOp; sid?: string; ask?: string; text?: string }
  | { t: 'voice'; id: string; target: 'agent' | 'type'; sid?: string }
  | { t: 'voice-end'; id: string }
  | { t: 'pair'; name: string; pk: string }
  | { t: 'pair-nonce'; n: string }
  | { t: 'pair-ok' }

/** The settings page's view of the module. */
export interface DeviceStatus {
  /** This computer's name, as the device lists it. */
  host: string
  devices: Array<{
    id: string
    name: string
    online: boolean
    /** Epoch ms of the last connection; undefined before the first. */
    seen?: number
    fw?: string
    bat?: number
    rssi?: number
  }>
  pairing: Pairing | null
  /** Where devices reach this machine; `error` when the port could not be opened. */
  link: { state: 'off' } | { state: 'listening'; port: number; addresses: string[] } | { state: 'error'; error: string }
  /** Speech recognition: whether a key is there for the chosen service. */
  stt: { provider: SttProvider; ready: boolean }
  /** Dictation into this computer's front app (dsh-type). `permission` is macOS's Accessibility grant. */
  typer: { available: boolean; permission?: boolean }
}

export type Pairing =
  /** Waiting for a device to pick this computer. */
  | { phase: 'waiting'; until: number }
  /** Both sides show `code`; `confirmed` says which side has said they match. */
  | { phase: 'compare'; until: number; code: string; name: string; confirmed: { host: boolean; device: boolean } }
  | { phase: 'done'; name: string }
  | { phase: 'failed'; reason: string }

export type SttProvider = 'minimax' | 'openai'

export type DeviceRequest =
  | { op: 'status' }
  | { op: 'pair' }
  | { op: 'pair-confirm' }
  | { op: 'pair-cancel' }
  | { op: 'rename'; id: string; name: string }
  | { op: 'remove'; id: string }
  /** The OpenAI-compatible service's API key, kept in DSH's credential store; blank removes it. */
  | { op: 'stt-key'; key: string }
  /** Open macOS's Accessibility settings for DSH. */
  | { op: 'open-perm' }
