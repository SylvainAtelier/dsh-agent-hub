/**
 * Signing in to a remote MCP server the way the MCP spec lays out: the
 * server's 401 names its protected-resource metadata (RFC 9728), which names
 * the authorization server (RFC 8414); the hub registers itself there
 * (dynamic client registration, RFC 7591) and runs an authorization-code flow
 * with PKCE whose redirect lands on a loopback port open only for that sign-in
 * (RFC 8252), so it works from the desktop app and a browser alike. A server
 * without registration (Slack) signs in the same way through an app the user
 * registered there once, as Cursor does with its own: its client ID, PKCE in
 * place of a secret, and a fixed loopback redirect the app lists.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { McpHttpError, McpSession } from './mcp.ts'
import { APP_REDIRECT, APP_REDIRECT_PORT } from './types.ts'

const FETCH_TIMEOUT_MS = 15_000
/** How long the loopback port waits for the browser. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000

/** What the hub keeps for an OAuth sign-in (a `grant` record's payload). */
export interface Grant {
  type: 'oauth'
  access: string
  refresh?: string
  /** Epoch ms. */
  expiresAt?: number
  clientId: string
  clientSecret?: string
  /** `client_secret_basic` sends the secret as Basic auth; anything else in the body. */
  authMethod?: string
  tokenEndpoint: string
  resource: string
}

interface AuthServer {
  authorization_endpoint?: string
  token_endpoint?: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
}

export type Discovery =
  /** The server answers without a credential. */
  | { kind: 'open' }
  /** No `registration_endpoint`: only a client registered by hand can sign in. */
  | { kind: 'oauth'; server: Required<Pick<AuthServer, 'authorization_endpoint' | 'token_endpoint'>> & Pick<AuthServer, 'registration_endpoint'>; resource: string; scope?: string }
  /** It wants a credential but offers no sign-in this hub can do. */
  | { kind: 'token' }

const base64url = (bytes: Buffer): string => bytes.toString('base64url')

async function getJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const value = await response.json() as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** RFC 8414 / OpenID discovery for an issuer, path-inserted first. */
async function authServer(issuer: string): Promise<AuthServer | undefined> {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/+$/, '')
  const candidates = path === ''
    ? [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`]
    : [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`]
  for (const candidate of candidates) {
    const metadata = await getJson(candidate)
    if (metadata !== undefined && typeof metadata.token_endpoint === 'string') return metadata as AuthServer
  }
  return undefined
}

/** How a server wants to be signed in to. Throws when it cannot be reached at all. */
export async function discover(url: string): Promise<Discovery> {
  let challenge: McpHttpError
  try {
    await new McpSession(url, undefined).probe()
    return { kind: 'open' }
  } catch (error) {
    if (!(error instanceof McpHttpError) || (error.status !== 401 && error.status !== 403)) throw error
    challenge = error
  }
  const target = new URL(url)
  const path = target.pathname.replace(/\/+$/, '')
  const prm = await getJson(challenge.resourceMetadata ?? `${target.origin}/.well-known/oauth-protected-resource${path}`)
    ?? (path === '' ? undefined : await getJson(`${target.origin}/.well-known/oauth-protected-resource`))
  const issuers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers.filter((value): value is string => typeof value === 'string') : []
  // Servers from before protected-resource metadata are their own authorization server.
  const server = await authServer(issuers[0] ?? target.origin)
  const methods = server?.code_challenge_methods_supported
  if (server?.authorization_endpoint === undefined || server.token_endpoint === undefined
    || (methods !== undefined && !methods.includes('S256'))) return { kind: 'token' }
  return {
    kind: 'oauth',
    server: {
      authorization_endpoint: server.authorization_endpoint,
      token_endpoint: server.token_endpoint,
      ...(server.registration_endpoint === undefined ? {} : { registration_endpoint: server.registration_endpoint }),
    },
    resource: typeof prm?.resource === 'string' ? prm.resource : url,
    ...(challenge.scope === undefined ? {} : { scope: challenge.scope }),
  }
}

async function tokenRequest(grant: Pick<Grant, 'clientId' | 'clientSecret' | 'authMethod' | 'tokenEndpoint' | 'resource'>, params: Record<string, string>, previous?: Grant, signal?: AbortSignal): Promise<Grant> {
  const body = new URLSearchParams({ ...params, resource: grant.resource })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (grant.clientSecret !== undefined && grant.authMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(grant.clientId)}:${encodeURIComponent(grant.clientSecret)}`).toString('base64')}`
  } else {
    body.set('client_id', grant.clientId)
    if (grant.clientSecret !== undefined) body.set('client_secret', grant.clientSecret)
  }
  const response = await fetch(grant.tokenEndpoint, { method: 'POST', headers, body, signal: signal === undefined ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) })
  const value = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!response.ok || typeof value.access_token !== 'string') {
    throw new McpHttpError(response.status, value.error_description ?? value.error ?? `token endpoint answered ${response.status}`)
  }
  const refresh = value.refresh_token ?? previous?.refresh
  return {
    type: 'oauth',
    access: value.access_token,
    ...(refresh === undefined ? {} : { refresh }),
    ...(typeof value.expires_in === 'number' ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}),
    clientId: grant.clientId,
    ...(grant.clientSecret === undefined ? {} : { clientSecret: grant.clientSecret }),
    ...(grant.authMethod === undefined ? {} : { authMethod: grant.authMethod }),
    tokenEndpoint: grant.tokenEndpoint,
    resource: grant.resource,
  }
}

/** A new access token; the refresh token rotates when the server says so. Throws when the sign-in is gone. */
export function refreshGrant(grant: Grant): Promise<Grant> {
  if (grant.refresh === undefined) return Promise.reject(new McpHttpError(401, 'no refresh token'))
  return tokenRequest(grant, { grant_type: 'refresh_token', refresh_token: grant.refresh }, grant)
}

const PAGE = (ok: boolean, detail: string): string => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Agent Hub</title>
<style>body{font:15px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{max-width:420px;padding:24px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0;opacity:.7}</style>
<main><h1>${ok ? '✓ 已连接 · Connected' : '连接失败 · Sign-in failed'}</h1><p>${detail}</p></main>
${ok ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}`

const escape = (text: string): string => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

export interface SignIn {
  authorizeUrl: string
  /** Settles with the grant once the browser comes back, or rejects (denied, timed out, cancelled). */
  result: Promise<Grant>
  cancel(): void
}

interface Registered { client_id: string; client_secret?: string; token_endpoint_auth_method?: string }

/** Dynamic client registration (RFC 7591) as a public client on this redirect. */
async function register(endpoint: string, name: string, redirect: string): Promise<Registered> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const client = await response.json().catch(() => ({})) as Partial<Registered> & { error_description?: string }
  if (!response.ok || typeof client.client_id !== 'string') throw new Error(client.error_description ?? `client registration failed (${response.status})`)
  return client as Registered
}

/** Who signs in: the hub registering itself under a name, or an app registered by hand. */
export type Client = { name: string } | { id: string }

/** Start a browser sign-in: register on a loopback redirect (or use the app's), then wait for the code there. */
export async function signIn(discovery: Extract<Discovery, { kind: 'oauth' }>, who: Client): Promise<SignIn> {
  const registration = discovery.server.registration_endpoint
  if (!('id' in who) && registration === undefined) throw new Error('the server registers no clients: a client ID is needed')
  const server: Server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE'
      ? new Error(`port ${APP_REDIRECT_PORT} is in use: finish or cancel the other sign-in first`) : error))
    server.listen('id' in who ? APP_REDIRECT_PORT : 0, '127.0.0.1', () => resolve())
  })
  const close = (): void => { server.close(); server.closeAllConnections() }
  try {
    const port = (server.address() as { port: number }).port
    const redirect = 'id' in who ? APP_REDIRECT : `http://127.0.0.1:${port}/callback`
    const client: Registered = 'id' in who ? { client_id: who.id } : await register(registration!, who.name, redirect)

    const verifier = base64url(randomBytes(32))
    const state = base64url(randomBytes(16))
    const authorize = new URL(discovery.server.authorization_endpoint)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      resource: discovery.resource,
      ...(discovery.scope === undefined ? {} : { scope: discovery.scope }),
    }).toString()

    let settle!: { resolve(grant: Grant): void; reject(error: Error): void }
    const result = new Promise<Grant>((resolve, reject) => { settle = { resolve, reject } })
    result.catch(() => {})
    const controller = new AbortController()
    let consumed = false
    const timer = setTimeout(() => { controller.abort(); settle.reject(new Error('sign-in timed out')); close() }, SIGN_IN_TIMEOUT_MS)
    timer.unref()
    // Free the port at once (the app redirect's is fixed); the reply page gets a moment to finish.
    const finish = (): void => {
      clearTimeout(timer)
      server.close()
      setTimeout(() => server.closeAllConnections(), 1000).unref()
    }
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirect)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      const reply = (ok: boolean, detail: string): void => {
        response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(ok, escape(detail)))
      }
      if (url.searchParams.get('state') !== state) return reply(false, 'state mismatch')
      if (consumed) return reply(false, 'callback already handled')
      consumed = true
      const code = url.searchParams.get('code')
      if (code === null) {
        const reason = url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no code'
        reply(false, reason)
        settle.reject(new Error(reason))
        return finish()
      }
      tokenRequest({
        clientId: client.client_id,
        ...(client.client_secret === undefined ? {} : { clientSecret: client.client_secret }),
        ...(client.token_endpoint_auth_method === undefined ? {} : { authMethod: client.token_endpoint_auth_method }),
        tokenEndpoint: discovery.server.token_endpoint,
        resource: discovery.resource,
      }, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }, undefined, controller.signal).then((grant) => {
        reply(true, '可以关闭此页面，回到 DSH。You can close this tab.')
        settle.resolve(grant)
      }, (error: Error) => {
        reply(false, error.message)
        settle.reject(error)
      }).finally(finish).catch((error: unknown) => {
        settle.reject(error instanceof Error ? error : new Error(String(error)))
        close()
      })
    })
    return {
      authorizeUrl: authorize.toString(),
      result,
      cancel: () => {
        consumed = true
        controller.abort()
        clearTimeout(timer)
        settle.reject(new Error('cancelled'))
        close()
      },
    }
  } catch (error) {
    close()
    throw error
  }
}
