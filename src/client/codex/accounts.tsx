/**
 * Codex account store for the usage popover's account switch. Accounts belong to
 * dsh-codex-subscription: this only calls its public RPC methods
 * (`codex-subscription/status`, `codex-subscription/account/select` on the
 * `/api` channel) and never touches its credential vault. The plugin's own
 * client uses a `/codex-subscription` channel, but that is a client-side
 * wrapper that forwards to these methods; DSH has no such channel.
 * Without that plugin the RPC fails and the control renders nothing.
 */

/** Method prefix the Codex plugin registers on the DSH `/api` channel. */
export const CODEX_METHOD_PREFIX = 'codex-subscription/'

export interface CodexAccount { id: string; label?: string; email?: string; active?: boolean }
interface CodexStatus { authenticated?: boolean; accounts?: CodexAccount[] }
export interface CodexAccountApi { call(endpoint: 'status' | 'account/select', payload: Record<string, unknown>): Promise<unknown> }
interface Snapshot { accounts: CodexAccount[]; available: boolean; loading: boolean; busy: boolean; error?: string }

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

function accountsOf(value: unknown): CodexAccount[] {
  const status = value as CodexStatus | undefined
  if (status?.authenticated !== true || !Array.isArray(status.accounts)) return []
  return status.accounts.filter((account): account is CodexAccount => typeof account?.id === 'string')
}

export class CodexAccountStore {
  private snapshot: Snapshot = { accounts: [], available: false, loading: false, busy: false }
  private listeners = new Set<() => void>()
  private generation = 0
  constructor(private readonly api: CodexAccountApi, private readonly changed?: () => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): Snapshot => this.snapshot
  private set(next: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }
  load = async (): Promise<void> => {
    if (this.snapshot.busy) return
    const token = ++this.generation
    this.set({ loading: true })
    try {
      const accounts = accountsOf(await this.api.call('status', {}))
      if (token === this.generation) this.set({ accounts, available: true, error: undefined })
    } catch {
      // No Codex plugin (or it is not ready): hide the switch instead of showing an error.
      if (token === this.generation) this.set({ accounts: [], available: false })
    } finally {
      if (token === this.generation) this.set({ loading: false })
    }
  }
  select = async (id: string): Promise<void> => {
    if (this.snapshot.busy) return
    const token = ++this.generation
    this.set({ busy: true, error: undefined })
    try {
      const accounts = accountsOf(await this.api.call('account/select', { id }))
      if (token !== this.generation) return
      this.set({ accounts })
      this.changed?.()
    } catch (error) {
      if (token === this.generation) this.set({ error: message(error) })
    } finally {
      if (token === this.generation) this.set({ busy: false })
    }
  }
}
