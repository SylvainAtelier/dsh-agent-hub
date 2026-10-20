/** Phone access over Tailscale: the shapes both halves share. */

export const REMOTE_METHOD = 'agent-hub/remote'

export type RemoteAction = 'status' | 'enable' | 'disable'

/** Where phone access stands, each state naming the one thing to do next. */
export type RemoteView =
  /** The Tailscale client is not installed. */
  | { state: 'missing' }
  /** Tailscale is installed but stopped or signed out. */
  | { state: 'offline' }
  /** The tailnet does not issue HTTPS certificates yet (a one-time switch in its admin console). */
  | { state: 'no-https' }
  /** Ready to turn on. */
  | { state: 'off'; url: string; login: string }
  /** Serving: `url` opens DSH on any device signed in as `login`. */
  | { state: 'on'; url: string; login: string }

export interface RemoteResult {
  view: RemoteView
  /** Why the requested action did not happen. */
  error?: string
}
