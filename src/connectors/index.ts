/**
 * Connectors: remote MCP servers connected once for every model. Each
 * connected server runs as an instance of DSH's own mcp-client plugin, mounted
 * here, so its tools land in DSH's tool registry as `mcp__<id>__<tool>` for
 * every DSH model (DeepSeek, Codex, MiniMax, …) and, through the Claude
 * bridge, for Claude Agent. What mcp-client lacks is sign-in: this module
 * finds out how a server wants to be signed in to (oauth.ts), keeps the
 * credential in DSH's credential store, never in the profile, and hands the
 * client a Bearer header, remounting it when the token is refreshed.
 */

import { McpHttpError, McpSession } from './mcp.ts'
import { discover, refreshGrant, signIn, type Grant, type SignIn } from './oauth.ts'
import { LinearTickets } from './linear.ts'
import { SlackNotices } from './slack.ts'
import { SentryIssues, type SentryTarget } from './sentry.ts'
import { CONNECTOR_ID, isLinear, isSentry, isSlack, presetOf, type ConnectorEntry, type ConnectorPhase, type ConnectorRequest, type ConnectorStatus } from './types.ts'
import { pathKey } from '../git/service.ts'

/** Refresh this long before the access token expires. */
const REFRESH_AHEAD_MS = 2 * 60_000

type StoredRecord = ({ kind: 'api-key'; key: string } | {
  kind: 'grant'
  payload: (Grant | { type: 'none' } | { type: 'token'; token: string }) & { endpoint?: string }
}) & { endpoint?: string }

// URL preserves path/query case: credentials must not leak to another resource.
const endpoint = (url: string): string => new URL(url).href
interface Operation { id: string; url: string; generation: number }

/** The slice of DSH's credential service this module uses. */
export interface CredentialStore {
  readRecord(key: unknown): Promise<{ kind: string; key?: string; payload?: unknown } | undefined>
  modifyRecord(key: unknown, mutate: (current: unknown) => StoredRecord | undefined): Promise<unknown>
  deleteRecord(key: unknown): Promise<void>
}

/** A mounted mcp-client instance (a Cordis fiber). */
export interface Mounted {
  dispose(): unknown
  await(): Promise<unknown>
}

export interface ConnectorsHost {
  /** The configured connectors, read on use. */
  entries(): readonly ConnectorEntry[]
  credentials: CredentialStore
  /** The credential key a connector's sign-in is kept under. */
  key(id: string): unknown
  /** Mount one mcp-client instance; undefined where this DSH has no mcp-client. */
  mount(config: object): Mounted | undefined
  /** How many tools a server has in DSH's registry now. */
  toolCount(id: string): number
  log(message: string): void
  /** The repository (main working tree) a folder is in: picks the Linear account linked to it. */
  repoOf?(dir: string): Promise<string | undefined>
}

/** A connected Linear account and the repositories it is linked to (none: every repository). */
export interface LinearAccount {
  id: string
  repos: readonly string[]
  tickets: LinearTickets
}

/** A connected Slack workspace and the repositories whose new tickets it announces (none: every repository). */
export interface SlackAccount {
  id: string
  repos: readonly string[]
  notices: SlackNotices
}

type Credential = { via: 'oauth'; grant: Grant } | { via: 'token'; token: string } | { via: 'none' }

interface Live {
  url: string
  token: string | undefined
  fiber: Mounted
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class Connectors {
  private host: ConnectorsHost
  private live = new Map<string, Live>()
  private states = new Map<string, ConnectorPhase>()
  private flows = new Map<string, SignIn>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** Reconciliation runs one at a time. */
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  /** One MCP session per connected server the hub itself talks to, and what reads it. */
  private clients = new Map<string, { url: string; token: string | undefined; tickets?: LinearTickets; notices?: SlackNotices; sentry?: { target: string; issues: SentryIssues }; session: McpSession }>()

  private generations = new Map<string, number>()
  private endpoints = new Map<string, string>()
  private legacyEndpoints = new Map<string, string>()
  private busy = new Set<string>()
  private mutations = new Map<string, Promise<unknown>>()

  constructor(host: ConnectorsHost) {
    this.host = host
    for (const entry of host.entries()) {
      this.endpoints.set(entry.id, endpoint(entry.url))
      this.legacyEndpoints.set(entry.id, endpoint(entry.url))
    }
  }

  private valid(op: Operation): boolean {
    return !this.disposed && this.generations.get(op.id) === op.generation
      && this.endpoints.get(op.id) === op.url
      && this.host.entries().some((entry) => entry.id === op.id && endpoint(entry.url) === op.url)
  }

  private invalidate(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const flow = this.flows.get(id)
    this.flows.delete(id)
    flow?.cancel()
    this.busy.delete(id)
    this.unmount(id)
  }

  private begin(id: string, url: string): Operation {
    if (this.disposed) throw new Error('connectors disposed')
    if (!CONNECTOR_ID.test(id)) throw new Error('invalid connector id')
    const target = endpoint(url)
    if (!this.host.entries().some((entry) => entry.id === id && endpoint(entry.url) === target)) throw new Error('connector endpoint is not configured')
    this.invalidate(id)
    this.endpoints.set(id, target)
    this.busy.add(id)
    this.states.set(id, { phase: 'connecting' })
    return { id, url: target, generation: this.generations.get(id)! }
  }

  private state(id: string): ConnectorPhase {
    return this.states.get(id) ?? { phase: 'disconnected' }
  }

  private fail(op: Operation, error: unknown): ConnectorPhase {
    if (this.valid(op)) {
      this.busy.delete(op.id)
      this.states.set(op.id, { phase: 'error', message: message(error) })
    }
    return this.state(op.id)
  }

  private mutate<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.mutations.set(id, next)
    void next.finally(() => { if (this.mutations.get(id) === next) this.mutations.delete(id) }).catch(() => {})
    return next
  }

  private async read(op: Operation): Promise<Credential | undefined> {
    const stored = await this.host.credentials.readRecord(this.host.key(op.id)) as StoredRecord | undefined
    if (!this.valid(op) || stored === undefined) return undefined
    const payload = stored.kind === 'grant' ? stored.payload : undefined
    const bound = payload?.endpoint ?? stored.endpoint
    if (bound !== undefined && bound !== op.url) return undefined
    let credential: Credential | undefined
    if (stored.kind === 'api-key' && typeof stored.key === 'string' && stored.key !== '') credential = { via: 'token', token: stored.key }
    if (payload?.type === 'token' && typeof payload.token === 'string' && payload.token !== '') credential = { via: 'token', token: payload.token }
    if (payload?.type === 'none') credential = { via: 'none' }
    if (payload?.type === 'oauth' && typeof payload.access === 'string' && typeof payload.resource === 'string'
      && typeof payload.tokenEndpoint === 'string' && typeof payload.clientId === 'string') credential = { via: 'oauth', grant: payload as Grant }
    if (credential === undefined) return undefined
    // Legacy OAuth already names its resource. Legacy token/open records can only
    // be adopted for the endpoint observed at construction, then are bound on disk.
    if (bound === undefined) {
      if (this.legacyEndpoints.get(op.id) !== op.url) return undefined
      if (credential.via === 'oauth') {
        if (endpoint(credential.grant.resource) !== op.url) {
          // OAuth resource identifiers need not equal the transport URL. Verify
          // its unauthenticated metadata before adopting a legacy credential.
          const discovery = await discover(op.url)
          if (!this.valid(op) || discovery.kind !== 'oauth'
            || endpoint(discovery.resource) !== endpoint(credential.grant.resource)
            || endpoint(discovery.server.token_endpoint) !== endpoint(credential.grant.tokenEndpoint)) return undefined
        }
      }
      await this.write(op, stored)
      if (!this.valid(op)) return undefined
    }
    return credential
  }

  private write(op: Operation, record: StoredRecord): Promise<unknown> {
    return this.mutate(op.id, async () => {
      if (!this.valid(op)) return
      // Only grant.payload is guaranteed to survive DSH's credential serialization.
      const payload = record.kind === 'api-key' ? { type: 'token' as const, token: record.key } : record.payload
      return this.host.credentials.modifyRecord(this.host.key(op.id), (current) =>
        this.valid(op) ? { kind: 'grant', payload: { ...payload, endpoint: op.url } } : current as StoredRecord | undefined)
    })
  }

  /** Bring the mounted clients in line with the configuration and the stored credentials. */
  sync(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const wanted = new Map(this.host.entries().map((entry) => [entry.id, endpoint(entry.url)]))
    for (const [id, url] of this.endpoints) {
      if (wanted.get(id) !== url) {
        this.invalidate(id)
        this.legacyEndpoints.delete(id)
        this.states.set(id, { phase: 'disconnected' })
      }
    }
    this.endpoints = wanted
    this.queue = this.queue.then(() => this.reconcile()).catch((error: unknown) => this.host.log(`sync failed: ${message(error)}`))
    return this.queue
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const entries = this.host.entries().filter((entry) => CONNECTOR_ID.test(entry.id))
    const wanted = new Set(entries.map((entry) => entry.id))
    for (const id of [...this.live.keys()]) if (!wanted.has(id)) this.unmount(id)
    for (const id of [...this.states.keys()]) if (!wanted.has(id) && !this.flows.has(id)) this.states.delete(id)
    await Promise.all(entries.map((entry) => this.reconcileOne(entry)))
  }

  private async reconcileOne(entry: ConnectorEntry): Promise<void> {
    if (this.disposed || this.busy.has(entry.id) || this.flows.has(entry.id)) return
    if (!this.generations.has(entry.id)) this.generations.set(entry.id, 0)
    const op = { id: entry.id, url: endpoint(entry.url), generation: this.generations.get(entry.id)! }
    let credential = await this.read(op)
    if (!this.valid(op)) return
    if (credential === undefined) {
      this.unmount(entry.id)
      // A sign-in that asked for a token or a client ID, or just failed, keeps saying so until the next attempt.
      const phase = this.states.get(entry.id)?.phase
      if (phase !== 'token' && phase !== 'client' && phase !== 'error') this.states.set(entry.id, { phase: 'disconnected' })
      return
    }
    if (credential.via === 'oauth' && credential.grant.expiresAt !== undefined && credential.grant.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
      const refreshed = await this.refresh(op, credential.grant)
      if (refreshed === undefined || !this.valid(op)) return
      credential = { via: 'oauth', grant: refreshed }
    }
    const token = credential.via === 'oauth' ? credential.grant.access : credential.via === 'token' ? credential.token : undefined
    const current = this.live.get(entry.id)
    if (current !== undefined && current.url === entry.url && current.token === token && this.states.get(entry.id)?.phase === 'connected') {
      this.schedule(entry.id, credential)
      return
    }
    this.unmount(entry.id)
    await this.mount(entry, token, credential, op)
  }

  private async mount(entry: ConnectorEntry, token: string | undefined, credential: Credential, op: Operation): Promise<void> {
    if (!this.valid(op)) return
    this.states.set(entry.id, { phase: 'connecting' })
    const fiber = this.host.mount({
      transport: 'streamable-http',
      serverName: entry.id,
      url: entry.url,
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    })
    if (fiber === undefined) {
      this.states.set(entry.id, { phase: 'error', message: 'this DeepSeek Harness has no MCP client' })
      return
    }
    this.live.set(entry.id, { url: entry.url, token, fiber })
    try {
      await fiber.await()
    } catch (error) {
      if (!this.valid(op) || this.live.get(entry.id)?.fiber !== fiber) return
      this.unmount(entry.id)
      this.states.set(entry.id, { phase: 'error', message: message(error) })
      return
    }
    if (!this.valid(op) || this.live.get(entry.id)?.fiber !== fiber) return
    const tools = this.host.toolCount(entry.id)
    if (tools > 0) {
      this.states.set(entry.id, { phase: 'connected', tools, via: credential.via })
      this.schedule(entry.id, credential)
      return
    }
    // No tools: find out why, so the page can say what to do.
    try {
      await new McpSession(entry.url, token).probe()
      if (!this.valid(op) || this.live.get(entry.id)?.fiber !== fiber) return
      this.states.set(entry.id, { phase: 'connected', tools: 0, via: credential.via })
    } catch (error) {
      if (!this.valid(op) || this.live.get(entry.id)?.fiber !== fiber) return
      this.unmount(entry.id)
      const refused = error instanceof McpHttpError && (error.status === 401 || error.status === 403)
      if (refused && credential.via === 'oauth' && credential.grant.refresh !== undefined && credential.grant.expiresAt !== undefined) {
        // Expired early: one refresh, then the next pass mounts with it.
        if (await this.refresh(op, { ...credential.grant, expiresAt: 0 }) !== undefined && this.valid(op)) void this.sync()
        return
      }
      this.states.set(entry.id, refused ? { phase: 'expired' } : { phase: 'error', message: message(error) })
    }
  }

  /** A refreshed grant, stored; undefined (and `expired`) when the sign-in is gone. */
  private async refresh(op: Operation, grant: Grant): Promise<Grant | undefined> {
    try {
      const next = await refreshGrant(grant)
      if (!this.valid(op)) return undefined
      await this.write(op, { kind: 'grant', payload: next })
      return this.valid(op) ? next : undefined
    } catch (error) {
      if (!this.valid(op)) return undefined
      this.host.log(`${op.id}: token refresh failed: ${message(error)}`)
      this.unmount(op.id)
      this.states.set(op.id, { phase: 'expired' })
      return undefined
    }
  }

  /** Refresh an OAuth token ahead of its expiry; the remount carries the new one. */
  private schedule(id: string, credential: Credential): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    if (credential.via !== 'oauth' || credential.grant.expiresAt === undefined) return
    const delay = Math.max(30_000, credential.grant.expiresAt - Date.now() - REFRESH_AHEAD_MS)
    // setTimeout's ceiling is ~24.8 days; a later expiry is simply checked again then.
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.sync()
    }, Math.min(delay, 2 ** 31 - 1))
    timer.unref()
    this.timers.set(id, timer)
  }

  private unmount(id: string): void {
    this.clients.delete(id)
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    const live = this.live.get(id)
    if (live === undefined) return
    this.live.delete(id)
    try {
      void Promise.resolve(live.fiber.dispose()).catch((error: unknown) => this.host.log(`${id}: unmount failed: ${message(error)}`))
    } catch (error) {
      this.host.log(`${id}: unmount failed: ${message(error)}`)
    }
  }

  status(): ConnectorStatus[] {
    return this.host.entries().map((entry) => ({ id: entry.id, url: entry.url, state: this.states.get(entry.id) ?? { phase: 'connecting' } }))
  }

  /** Ids whose tools are in the registry now: the Claude bridge serves these. */
  connected(): string[] {
    return [...this.live.keys()].filter((id) => this.states.get(id)?.phase === 'connected')
  }

  /** Sign in: a browser flow where the server offers one (asking for a client ID where it registers none), else ask for a token. */
  async connect(id: string, url: string): Promise<ConnectorPhase> {
    const op = this.begin(id, url)
    try {
      const discovery = await discover(url)
      if (!this.valid(op)) return this.state(id)
      if (discovery.kind === 'open') {
        await this.write(op, { kind: 'grant', payload: { type: 'none' } })
        if (!this.valid(op)) return this.state(id)
        this.busy.delete(id)
        await this.sync()
        return this.state(id)
      }
      if (discovery.kind === 'token') {
        this.busy.delete(id)
        this.states.set(id, { phase: 'token' })
        return this.state(id)
      }
      const clientId = this.host.entries().find((entry) => entry.id === id)?.clientId?.trim()
      if (!clientId && discovery.server.registration_endpoint === undefined) {
        this.busy.delete(id)
        this.states.set(id, { phase: 'client' })
        return this.state(id)
      }
      // The server's challenge names the scopes; Slack's names none, its preset does.
      const scope = discovery.scope ?? presetOf(url)?.app?.scopes.join(' ')
      const flow = await signIn({ ...discovery, ...(scope === undefined ? {} : { scope }) }, clientId ? { id: clientId } : { name: 'DeepSeek Harness · Agent Hub' })
      if (!this.valid(op)) {
        flow.cancel()
        return this.state(id)
      }
      this.flows.set(id, flow)
      const state: ConnectorPhase = { phase: 'authorizing', authorizeUrl: flow.authorizeUrl }
      this.states.set(id, state)
      void flow.result.then(async (grant) => {
        if (!this.valid(op) || this.flows.get(id) !== flow) return
        await this.write(op, { kind: 'grant', payload: grant })
        if (!this.valid(op)) return
        this.flows.delete(id)
        this.busy.delete(id)
        await this.sync()
      }).catch((error: unknown) => {
        if (!this.valid(op)) return
        this.flows.delete(id)
        this.fail(op, error)
      })
      return state
    } catch (error) {
      return this.fail(op, error)
    }
  }

  /** Connect with a token typed in; it is tried before it is kept. */
  async token(id: string, url: string, token: string): Promise<ConnectorPhase> {
    const value = token.trim()
    if (value === '') throw new Error('empty token')
    const op = this.begin(id, url)
    try {
      await new McpSession(url, value).probe()
      if (!this.valid(op)) return this.state(id)
      await this.write(op, { kind: 'api-key', key: value })
      if (!this.valid(op)) return this.state(id)
      this.busy.delete(id)
      await this.sync()
      return this.state(id)
    } catch (error) {
      if (!this.valid(op)) return this.state(id)
      this.fail(op, error)
      if (error instanceof McpHttpError && (error.status === 401 || error.status === 403)) {
        this.states.set(id, { phase: 'error', message: 'token rejected', reason: 'rejected' })
      }
      return this.state(id)
    }
  }

  cancel(id: string): void {
    if (this.disposed) return
    this.invalidate(id)
    this.states.set(id, { phase: 'disconnected' })
  }

  /** Sign out: forget the credential and drop the server's tools. */
  async disconnect(id: string): Promise<void> {
    if (this.disposed) throw new Error('connectors disposed')
    this.cancel(id)
    const generation = this.generations.get(id)
    this.busy.add(id)
    try {
      await this.mutate(id, () => this.host.credentials.deleteRecord(this.host.key(id)))
      if (!this.disposed && this.generations.get(id) === generation) {
        this.busy.delete(id)
        this.states.set(id, { phase: 'disconnected' })
      }
    } catch (error) {
      if (!this.disposed && this.generations.get(id) === generation) {
        // Keep reconciliation suspended until an explicit retry; the credential
        // still exists and silently remounting it would undo a failed sign-out.
        this.states.set(id, { phase: 'error', message: `credential deletion failed: ${message(error)}` })
      }
      throw error
    }
  }

  /** Every connected Linear account, in the configured order. */
  linears(): LinearAccount[] {
    const entries = this.host.entries()
    return entries
      .filter((entry) => this.states.get(entry.id)?.phase === 'connected' && this.live.has(entry.id) && isLinear(this.live.get(entry.id)!.url))
      .map((entry) => ({ id: entry.id, repos: entry.repos ?? [], tickets: this.client(entry.id) }))
  }

  /** Every connected Slack workspace, in the configured order. */
  slacks(): SlackAccount[] {
    return this.host.entries()
      .filter((entry) => this.states.get(entry.id)?.phase === 'connected' && this.live.has(entry.id) && isSlack(this.live.get(entry.id)!.url))
      .map((entry) => {
        const held = this.held(entry.id)
        held.notices ??= new SlackNotices(() => held.session)
        return { id: entry.id, repos: entry.repos ?? [], notices: held.notices }
      })
  }

  private client(id: string): LinearTickets {
    const held = this.held(id)
    held.tickets ??= new LinearTickets(() => held.session)
    return held.tickets
  }

  /** Connected Sentry issues for the configured target. */
  sentry(target: SentryTarget): SentryIssues | undefined {
    const entry = this.host.entries().find((item) => this.states.get(item.id)?.phase === 'connected' && this.live.has(item.id) && isSentry(this.live.get(item.id)!.url))
    if (entry === undefined) return undefined
    const held = this.held(entry.id)
    const key = JSON.stringify(target)
    if (held.sentry?.target !== key) held.sentry = { target: key, issues: new SentryIssues(() => held.session, target) }
    return held.sentry.issues
  }

  /** A server's session, new when its endpoint or token changed. */
  private held(id: string): { url: string; token: string | undefined; tickets?: LinearTickets; notices?: SlackNotices; sentry?: { target: string; issues: SentryIssues }; session: McpSession } {
    const { url, token } = this.live.get(id)!
    let held = this.clients.get(id)
    if (held === undefined || held.url !== url || held.token !== token) {
      held = { url, token, session: new McpSession(url, token) }
      this.clients.set(id, held)
    }
    return held
  }

  /**
   * The Linear account that answers for a repository: the one linked to it, else one linked
   * to no repository in particular. Without a repository, the first unlinked account (else any).
   */
  issues(repo?: string): LinearTickets | undefined {
    const accounts = this.linears()
    if (repo !== undefined) {
      const key = pathKey(repo)
      const linked = accounts.find((account) => account.repos.some((item) => pathKey(item) === key))
      return (linked ?? accounts.find((account) => account.repos.length === 0))?.tickets
    }
    return (accounts.find((account) => account.repos.length === 0) ?? accounts[0])?.tickets
  }

  private async repoOf(cwd: unknown): Promise<string | undefined> {
    if (typeof cwd !== 'string' || cwd === '' || this.host.repoOf === undefined) return undefined
    return this.host.repoOf(cwd).catch(() => undefined)
  }

  async handle(request: ConnectorRequest): Promise<unknown> {
    switch (request.op) {
      case 'connect': return this.connect(String(request.id), String(request.url))
      case 'token': return this.token(String(request.id), String(request.url), String(request.token ?? ''))
      case 'cancel': return this.cancel(String(request.id))
      case 'disconnect': return this.disconnect(String(request.id))
      case 'issues': return this.issues(await this.repoOf(request.cwd))?.search(typeof request.query === 'string' ? request.query : '') ?? []
      case 'issue': return this.issues(await this.repoOf(request.cwd))?.issue(String(request.identifier)) ?? null
      case 'linked': return this.issues(await this.repoOf(request.cwd))?.linked(Array.isArray(request.branches) ? request.branches.filter((branch) => typeof branch === 'string').slice(0, 200) : []) ?? {}
      default: return { connectors: this.status(), issues: this.linears().length > 0 }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const flow of this.flows.values()) flow.cancel()
    this.flows.clear()
    for (const id of new Set([...this.live.keys(), ...this.timers.keys(), ...this.clients.keys()])) this.unmount(id)
    this.busy.clear()
    for (const id of this.states.keys()) this.states.set(id, { phase: 'disconnected' })
  }
}
