/**
 * The loopback hop between `tailscale serve` and DSH's own web server.
 *
 * DSH's /api fence accepts only loopback (or configured) Host names, so a
 * request for the tailnet name is re-issued as a loopback one. That rewrite
 * would void the fence's DNS-rebinding and cross-site defenses, so this hop
 * applies them itself, against the public name, first. It also lets in only
 * the tailnet account that owns this node: tailscaled stamps that identity on
 * every request it proxies (`Tailscale-User-Login`).
 *
 * Identity is not authentication in DSH's terms. The first page load without
 * a DSH browser session is answered with DSH's own launch-token URL, which
 * mints its usual session cookie; nothing here stores or checks a credential.
 */

import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

export interface ProxyOptions {
  /** Public authority phones use: `host` (port 443) or `host:port`. */
  authority: string
  /** The one tailnet login let in. */
  owner: string
  /** DSH's web server port, read per request. */
  upstream: () => number
  /** DSH's launch-token URL for a base URL (`ctx.connection.authenticatedUrl`). */
  signIn: (base: string) => string | undefined
  /** Loopback port to listen on; 0 picks a free one. */
  port?: number
}

export interface Proxy {
  port: number
  close(): void
}

/**
 * A top-level page load: what a link tapped in another app or site produces.
 * Browsers mark those `cross-site` too, but they carry no forged intent, so
 * only subresource, fetch, form-POST and WebSocket requests from elsewhere are refused.
 */
function isNavigation(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  return (method === 'GET' || method === 'HEAD') && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document'
}

/** Why a request must not pass, or undefined when it may. */
export function refusal(method: string | undefined, headers: IncomingHttpHeaders, options: Pick<ProxyOptions, 'authority' | 'owner'>): string | undefined {
  if (headers.host?.toLowerCase() !== options.authority) return 'unknown host'
  if (headers['tailscale-user-login'] !== options.owner) return 'not the owner of this tailnet node'
  if (headers.origin !== undefined && headers.origin !== `https://${options.authority}`) return 'cross-origin request'
  if (headers['sec-fetch-site'] === 'cross-site' && !isNavigation(method, headers)) return 'cross-site request'
  return undefined
}

/** The request as DSH should see it: from loopback, with no foreign origin. */
export function upstreamHeaders(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  // Preserve the trust boundary after the loopback Host rewrite. Callers cannot unset this marker.
  const next: OutgoingHttpHeaders = { ...headers, host: `127.0.0.1:${port}`, 'x-dsh-agent-hub-remote': '1' }
  delete next.origin
  for (const name of Object.keys(next)) if (name.startsWith('tailscale-') || name.startsWith('x-forwarded-')) delete next[name]
  return next
}

/** A page load DSH refused for want of a browser session, which its launch token would open. */
export function needsSignIn(method: string | undefined, url: string | undefined, status: number | undefined): boolean {
  if (method !== 'GET' || status !== 401) return false
  const target = new URL(url ?? '/', 'https://x')
  return target.pathname === '/' && !target.searchParams.has('token')
}

/**
 * DSH's session cookie is SameSite=Strict, which a browser withholds for the
 * whole of a navigation that began on another site, redirects included; the
 * launch-token exchange would then loop. Reloading from the page itself makes
 * the navigation same-origin, so the cookie flows. Such loads never reach DSH.
 */
function bounce(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end('<!doctype html><meta charset="utf-8"><script>location.replace(location.href)</script><noscript><meta http-equiv="refresh" content="0"></noscript>')
}

/**
 * DSH's port and sign-in URL come from the plugin's scope, which goes inactive
 * (and throws) while the hop is still draining during a reload or shutdown.
 */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function unavailable(res: ServerResponse): void {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('DeepSeek Harness is restarting')
}

function refuse(res: ServerResponse, reason: string): void {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`DeepSeek Harness: ${reason}`)
}

export function startProxy(options: ProxyOptions): Promise<Proxy> {
  /** Upgraded sockets leave the server's books; closing must still cut them. */
  const sockets = new Set<Duplex>()
  const forward = (req: IncomingMessage, res: ServerResponse): void => {
    const reason = refusal(req.method, req.headers, options)
    if (reason !== undefined) return refuse(res, reason)
    if (req.headers['sec-fetch-site'] === 'cross-site') return bounce(res)
    const port = attempt(options.upstream)
    if (port === undefined) return unavailable(res)
    const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, port) }, (answer) => {
      const signIn = needsSignIn(req.method, req.url, answer.statusCode) ? attempt(() => options.signIn(`https://${options.authority}/`)) : undefined
      if (signIn !== undefined) {
        answer.resume()
        res.writeHead(302, { location: signIn, 'cache-control': 'no-store' })
        return void res.end()
      }
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('DeepSeek Harness is not answering')
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy())
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (refusal(req.method, req.headers, options) !== undefined) return void socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
    const port = attempt(options.upstream)
    if (port === undefined) return void socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
    const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, port) })
    upstream.on('upgrade', (answer, tunnel, rest) => {
      const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`]
      for (let index = 0; index < answer.rawHeaders.length; index += 2) lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (rest.length > 0) socket.write(rest)
      if (head.length > 0) tunnel.write(head)
      tunnel.on('error', () => socket.destroy())
      socket.on('close', () => tunnel.destroy())
      tunnel.pipe(socket).pipe(tunnel)
    })
    upstream.on('response', (answer) => {
      socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\nconnection: close\r\n\r\n`)
      answer.resume()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  }

  const server = createServer(forward)
  server.on('upgrade', upgrade)
  return listen(server, options.port, sockets)
}

/**
 * The hop behind plain `http://` on the tailnet name: it only points the
 * browser at the HTTPS name, so nothing sent over it reaches DSH. Tailscale
 * does not tell a proxy which scheme a request came in on, hence a hop of its own.
 */
export function startRedirect(options: Pick<ProxyOptions, 'authority' | 'port'>): Promise<Proxy> {
  const server = createServer((req, res) => {
    const path = req.url?.startsWith('/') === true ? req.url : '/'
    res.writeHead(307, { location: `https://${options.authority}${path}`, 'cache-control': 'no-store' })
    res.end()
  })
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    socket.on('error', () => socket.destroy())
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
  })
  return listen(server, options.port, new Set())
}

function listen(server: ReturnType<typeof createServer>, port: number | undefined, sockets: Set<Duplex>): Promise<Proxy> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => {
          server.close()
          server.closeAllConnections()
          for (const socket of sockets) socket.destroy()
        },
      })
    })
  })
}
