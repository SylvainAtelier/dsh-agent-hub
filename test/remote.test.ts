import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { startProxy, startRedirect } from '../src/remote/proxy.ts'
import { parseServe, parseStatus } from '../src/remote/tailscale.ts'

const HOST = 'box.tail1.ts.net'
const OWNER = 'me@example.com'
const phone = (extra: IncomingHttpHeaders = {}): IncomingHttpHeaders => ({ host: HOST, 'tailscale-user-login': OWNER, ...extra })

/** A stand-in for DSH's web server: the index wants a session cookie, which `?token=t` mints. */
async function fakeDsh(): Promise<{ port: number; seen: IncomingHttpHeaders[]; close(): void }> {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/' && url.searchParams.get('token') === 't') {
      res.writeHead(302, { location: './', 'set-cookie': 'dsh=1; HttpOnly' })
      return void res.end()
    }
    if (url.pathname === '/' && req.headers.cookie !== 'dsh=1') {
      res.writeHead(401)
      return void res.end()
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`ok ${req.method} ${req.url}`)
  })
  server.on('upgrade', (req, socket: Socket) => {
    seen.push(req.headers)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.on('data', (data) => socket.write(data))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, seen, close: () => { server.closeAllConnections(); server.close() } }
}

function get(port: number, path: string, headers: IncomingHttpHeaders): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject).end()
  })
}

test('remote: the owner reaches DSH as a loopback caller; a first visit signs in with the launch token', async () => {
  const dsh = await fakeDsh()
  const proxy = await startProxy({ authority: HOST, owner: OWNER, upstream: () => dsh.port, signIn: (base) => `${base}?token=t` })
  try {
    const first = await get(proxy.port, '/', phone({ origin: `https://${HOST}` }))
    assert.equal(first.status, 302)
    assert.equal(first.headers.location, `https://${HOST}/?token=t`)
    assert.equal(first.headers['cache-control'], 'no-store')

    // The token request reaches DSH as-is and its cookie comes back.
    const exchange = await get(proxy.port, '/?token=t', phone())
    assert.equal(exchange.status, 302)
    assert.deepEqual(exchange.headers['set-cookie'], ['dsh=1; HttpOnly'])

    const page = await get(proxy.port, '/api/x', phone({ cookie: 'dsh=1', origin: `https://${HOST}`, 'x-forwarded-for': '100.1.2.3' }))
    assert.equal(page.body, 'ok GET /api/x')
    const upstream = dsh.seen.at(-1)!
    assert.equal(upstream.host, `127.0.0.1:${dsh.port}`)
    assert.equal(upstream.origin, undefined)
    assert.equal(upstream['tailscale-user-login'], undefined)
    assert.equal(upstream['x-forwarded-for'], undefined)
    assert.equal(upstream.cookie, 'dsh=1')
  } finally {
    proxy.close()
    dsh.close()
  }
})

test('remote: anyone but the owner, and any foreign host or origin, is refused before DSH sees it', async () => {
  const dsh = await fakeDsh()
  const proxy = await startProxy({ authority: HOST, owner: OWNER, upstream: () => dsh.port, signIn: () => 'unused' })
  try {
    for (const headers of [
      { host: HOST },
      phone({ 'tailscale-user-login': 'someone@else.com' }),
      phone({ host: 'evil.example' }),
      phone({ origin: 'https://evil.example' }),
      phone({ 'sec-fetch-site': 'cross-site' }),
    ]) {
      assert.equal((await get(proxy.port, '/api/x', headers)).status, 403)
    }
    assert.equal(dsh.seen.length, 0)
  } finally {
    proxy.close()
    dsh.close()
  }
})

test('remote: a page load from a link in another app is reloaded same-origin, so the Strict session cookie flows', async () => {
  const dsh = await fakeDsh()
  const proxy = await startProxy({ authority: HOST, owner: OWNER, upstream: () => dsh.port, signIn: (base) => `${base}?token=t` })
  try {
    const link = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    const first = await get(proxy.port, '/', phone(link))
    assert.equal(first.status, 200)
    assert.match(first.body, /location\.replace\(location\.href\)/)
    assert.equal(first.headers['cache-control'], 'no-store')
    assert.equal(dsh.seen.length, 0)
    // A cross-site fetch is still refused.
    assert.equal((await get(proxy.port, '/api/x', phone({ ...link, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).status, 403)
  } finally {
    proxy.close()
    dsh.close()
  }
})

test('remote: a request landing after the plugin scope went inactive is answered 503 instead of crashing the host', async () => {
  const inactive = (): never => { throw new Error('cannot get required service "webServer" in inactive context') }
  const proxy = await startProxy({ authority: HOST, owner: OWNER, upstream: inactive, signIn: inactive })
  try {
    const page = await get(proxy.port, '/', phone())
    assert.equal(page.status, 503)
    const refused = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxy.port, path: '/api/remote.mux', headers: phone({ connection: 'Upgrade', upgrade: 'websocket' }) })
        .on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
        .on('upgrade', () => reject(new Error('upgraded')))
        .on('error', reject)
        .end()
    })
    assert.equal(refused, 503)
  } finally {
    proxy.close()
  }
})

test('remote: a sign-in URL that throws leaves the 401 to pass through', async () => {
  const dsh = await fakeDsh()
  const proxy = await startProxy({ authority: HOST, owner: OWNER, upstream: () => dsh.port, signIn: () => { throw new Error('inactive context') } })
  try {
    assert.equal((await get(proxy.port, '/', phone())).status, 401)
  } finally {
    proxy.close()
    dsh.close()
  }
})

test('remote: WebSocket upgrades are tunneled for the owner and cut when the proxy closes', async () => {
  const dsh = await fakeDsh()
  const proxy = await startProxy({ authority: HOST, owner: OWNER, upstream: () => dsh.port, signIn: () => undefined })
  try {
    const socket = await new Promise<Socket>((resolve, reject) => {
      request({ host: '127.0.0.1', port: proxy.port, path: '/api/remote.mux', headers: phone({ connection: 'Upgrade', upgrade: 'websocket' }) })
        .on('upgrade', (_res, tunnel) => resolve(tunnel))
        .on('error', reject)
        .end()
    })
    assert.equal(dsh.seen.at(-1)?.host, `127.0.0.1:${dsh.port}`)
    const echoed = new Promise<string>((resolve) => socket.once('data', (data) => resolve(String(data))))
    socket.write('ping')
    assert.equal(await echoed, 'ping')
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    proxy.close()
    await closed
  } finally {
    proxy.close()
    dsh.close()
  }
})

test('remote: tailscale status yields this node, and HTTPS only when the tailnet issues its certificate', () => {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: 'box.tail1.ts.net.', UserID: 7 },
    User: { 7: { LoginName: OWNER } },
    CertDomains: ['box.tail1.ts.net'],
  }
  assert.deepEqual(parseStatus(status), { dnsName: HOST, login: OWNER, https: true })
  assert.equal(parseStatus({ ...status, CertDomains: null })?.https, false)
  assert.equal(parseStatus({ ...status, BackendState: 'Stopped' }), undefined)
})

test('remote: the serve rule on a port of this name is read as its proxy target, or "other"', () => {
  const site = (host: string, port: number, handlers: Record<string, { Proxy?: string }>) => ({ [`${host}:${port}`]: { Handlers: handlers } })
  assert.equal(parseServe({}, 443, HOST), undefined)
  assert.equal(parseServe({ TCP: { 443: { HTTPS: true } }, Web: site(HOST, 443, { '/': { Proxy: 'http://127.0.0.1:5000' } }) }, 443, HOST), 'http://127.0.0.1:5000')
  assert.equal(parseServe({ TCP: { 443: { HTTPS: true } }, Web: site(HOST, 443, { '/': { Proxy: 'http://127.0.0.1:5000' } }) }, 443, HOST.toUpperCase()), 'http://127.0.0.1:5000')
  assert.equal(parseServe({ TCP: { 443: { HTTPS: true } }, Web: site(HOST, 443, { '/': { Proxy: 'http://127.0.0.1:5000' }, '/x': { Proxy: 'http://127.0.0.1:6000' } }) }, 443, HOST), 'other')
  assert.equal(parseServe({ TCP: { 443: { HTTPS: true } }, Web: site(HOST, 443, { '/': { Proxy: 'http://127.0.0.1:5000' } }) }, 8443, HOST), undefined)
  assert.equal(parseServe({ TCP: { 80: { HTTP: true } }, Web: site(HOST, 80, { '/': { Proxy: 'http://127.0.0.1:5001' } }) }, 80, HOST), 'http://127.0.0.1:5001')
  assert.equal(parseServe({ TCP: { 443: {} } }, 443, HOST), 'other', 'a raw TCP forward is someone else\'s')
  // A rule left under the name the node had before a rename does not answer for the new name.
  assert.equal(parseServe({ TCP: { 443: { HTTPS: true } }, Web: site('box-1.tail1.ts.net', 443, { '/': { Proxy: 'http://127.0.0.1:5000' } }) }, 443, HOST), undefined)
})

test('remote: plain http is sent on to the HTTPS name and never forwarded', async () => {
  const hop = await startRedirect({ authority: HOST })
  try {
    // The target is fixed: whatever Host the request names, it cannot redirect elsewhere.
    const answer = await get(hop.port, '/s/1?x=2', phone({ host: 'evil.example' }))
    assert.equal(answer.status, 307)
    assert.equal(answer.headers.location, `https://${HOST}/s/1?x=2`)
  } finally { hop.close() }
})
