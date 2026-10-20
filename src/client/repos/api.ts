/**
 * The browser's view of which workspaces belong to which repository: one
 * store shared by the connectors settings (link an account to repositories)
 * the board (filter by repository) and the sidebar tree view (nest worktrees).
 */

import { REPOS_METHOD, type RepoGroup, type ReposRequest } from '../../repos/types.ts'

import { rpcValue, type Rpc } from '../rpc.ts'

export type ReposCall = (payload: ReposRequest) => Promise<unknown>

export function reposCall(rpc: Rpc): ReposCall {
  return (payload) => rpcValue(rpc, REPOS_METHOD, payload, 'agent-hub repos RPC failed')
}

export interface ReposSnapshot {
  /** Undefined until the first read. */
  repos: readonly RepoGroup[] | undefined
  error: string | null
}

export class ReposStore {
  private snapshot: ReposSnapshot = { repos: undefined, error: null }
  private readonly listeners = new Set<() => void>()
  private loading: Promise<void> | undefined
  private readonly call: ReposCall

  constructor(call: ReposCall) {
    this.call = call
  }

  getSnapshot = (): ReposSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read the groups; concurrent callers share one request. */
  load(): Promise<void> {
    this.loading ??= this.call({ op: 'list' }).then(
      (value) => this.publish({ repos: value as RepoGroup[], error: null }),
      (error: unknown) => this.publish({ ...this.snapshot, error: (error as Error).message }),
    ).finally(() => { this.loading = undefined })
    return this.loading
  }

  /** Register every working tree of every registered repository, then read the groups again; how many were new. */
  async adopt(): Promise<number> {
    const added = await this.call({ op: 'adopt' }) as number
    await this.load()
    return added
  }

  private publish(next: ReposSnapshot): void {
    const same = JSON.stringify(next) === JSON.stringify(this.snapshot)
    if (same) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
