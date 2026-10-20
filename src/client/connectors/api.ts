/**
 * The browser side of the connectors module: one RPC wrapper and one status
 * store shared by the settings page and the Git pane's ticket features. The
 * store polls only while a connector is signing in or connecting.
 */

import { CONNECTORS_METHOD, type ConnectorPhase, type ConnectorRequest, type ConnectorStatus, type Issue, type LinkedIssues } from '../../connectors/types.ts'

import { rpcValue, type Rpc } from '../rpc.ts'

export type Call = (payload: ConnectorRequest) => Promise<unknown>

export function connectorCall(rpc: Rpc): Call {
  return (payload) => rpcValue(rpc, CONNECTORS_METHOD, payload, 'agent-hub connectors RPC failed')
}

export interface ConnectorsSnapshot {
  /** Undefined until the first read. */
  connectors: readonly ConnectorStatus[] | undefined
  /** Whether a Linear connector is connected: the worktree picker offers tickets. */
  issues: boolean
  error: string | null
}

const POLL_MS = 1500
const busy = (state: ConnectorPhase): boolean => state.phase === 'authorizing' || state.phase === 'connecting'

export class ConnectorsStore {
  private snapshot: ConnectorsSnapshot = { connectors: undefined, issues: false, error: null }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  /** States an operation just returned, shown until the host lists the connector (its config may still be saving). */
  private pending = new Map<string, ConnectorPhase>()
  private disposed = false
  private reading = 0
  private readonly operations = new Map<string, number>()
  readonly call: Call

  constructor(call: Call) {
    this.call = call
  }

  getSnapshot = (): ConnectorsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The state to show for one connector. */
  state(id: string): ConnectorPhase | undefined {
    return this.snapshot.connectors?.find((entry) => entry.id === id)?.state ?? this.pending.get(id)
  }

  async load(): Promise<void> {
    if (this.disposed) return
    const current = ++this.reading
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      const value = await this.call({ op: 'status' }) as { connectors: ConnectorStatus[]; issues: boolean }
      if (this.disposed || current !== this.reading) return
      for (const entry of value.connectors) this.pending.delete(entry.id)
      this.publish({ connectors: value.connectors, issues: value.issues, error: null })
    } catch (error) {
      if (this.disposed || current !== this.reading) return
      this.publish({ ...this.snapshot, error: error instanceof Error ? error.message : String(error) })
    }
    const states = [...(this.snapshot.connectors ?? []).map((entry) => entry.state), ...this.pending.values()]
    if (states.some(busy) && this.listeners.size > 0) this.timer = setTimeout(() => void this.load(), POLL_MS)
  }

  /** Run one operation; its result shows at once, then the host's status follows. */
  async run(id: string, request: ConnectorRequest): Promise<ConnectorPhase | undefined> {
    if (this.disposed) return { phase: 'error', message: 'connectors disposed' }
    const operation = (this.operations.get(id) ?? 0) + 1
    this.operations.set(id, operation)
    this.reading++
    let state: ConnectorPhase | undefined
    try {
      const value = await this.call(request)
      if (value !== null && typeof value === 'object' && 'phase' in value) state = value as ConnectorPhase
    } catch (error) {
      state = { phase: 'error', message: (error as Error).message }
    }
    // Undefined is a successful disconnect: never let a cancelled result look like one.
    if (this.disposed || this.operations.get(id) !== operation) return { phase: 'error', message: 'operation superseded' }
    if (state !== undefined) {
      this.pending.set(id, state)
      this.publish({
        ...this.snapshot,
        connectors: this.snapshot.connectors?.map((entry) => (entry.id === id ? { ...entry, state: state! } : entry)),
      })
    }
    await this.load()
    if (this.disposed || this.operations.get(id) !== operation) return { phase: 'error', message: 'operation superseded' }
    return state
  }

  /** `cwd`: the folder asking; the Linear account linked to its repository answers. */
  issues(query: string, cwd?: string): Promise<Issue[]> {
    return this.call({ op: 'issues', query, ...(cwd === undefined ? {} : { cwd }) }) as Promise<Issue[]>
  }

  issue(identifier: string, cwd?: string): Promise<Issue | null> {
    return this.call({ op: 'issue', identifier, ...(cwd === undefined ? {} : { cwd }) }) as Promise<Issue | null>
  }

  linked(branches: string[], cwd?: string): Promise<LinkedIssues> {
    return this.call({ op: 'linked', branches, ...(cwd === undefined ? {} : { cwd }) }) as Promise<LinkedIssues>
  }

  dispose(): void {
    this.disposed = true
    this.reading++
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private publish(next: ConnectorsSnapshot): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
