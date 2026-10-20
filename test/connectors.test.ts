import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { APP_REDIRECT, connectorId, connectorName, datadogOptions, datadogUrl, issueBranch, issueInBranch, presetOf, tokenUrlOf, validServerUrl } from '../src/connectors/types.ts'
import { issuesIn, teamKeysIn, toIssue, LinearTickets } from '../src/connectors/linear.ts'
import { McpHttpError, McpSession } from '../src/connectors/mcp.ts'
import { discover, refreshGrant, signIn } from '../src/connectors/oauth.ts'
import { Connectors, type ConnectorsHost, type Mounted } from '../src/connectors/index.ts'
import { bridges, type ToolRegistry } from '../src/claude/bridge.ts'
import { connectorsValid } from '../src/client/config/form.ts'

test('connectors: Slack, Datadog and Temporal presets', () => {
  assert.equal(connectorId('https://mcp.slack.com/mcp', []), 'slack')
  assert.equal(connectorId('https://temporal.mcp.kapa.ai/', []), 'temporal')
  const us1 = 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp'
  assert.deepEqual(datadogOptions(us1), { site: 'us1', toolsets: ['core'] })
  const eu = datadogUrl(us1, { site: 'eu1', toolsets: ['core', 'apm'] })
  assert.equal(eu, 'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp?toolsets=core,apm')
  assert.deepEqual(datadogOptions(eu), { site: 'eu1', toolsets: ['core', 'apm'] })
  assert.equal(connectorId(eu, []), 'datadog')
  assert.equal(connectorName({ id: 'dd', url: eu }), 'Datadog')
  assert.equal(tokenUrlOf(eu), 'https://app.datadoghq.eu/personal-settings/access-tokens')
  assert.equal(datadogUrl(`${eu}&subdomain=acme`, { site: 'eu1', toolsets: ['core'] }), 'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp?subdomain=acme')
  assert.equal(datadogOptions('https://mcp.datadoghq.com/other'), undefined)
  assert.equal(presetOf('https://evil.example/api/unstable/mcp-server/mcp'), undefined)
  assert.equal(tokenUrlOf('https://mcp.slack.com/mcp'), 'https://api.slack.com/apps')
})

test('connectors: ids, names and URLs', () => {
  assert.equal(connectorId('https://mcp.linear.app/mcp', []), 'linear')
  assert.equal(connectorId('https://mcp.linear.app/mcp/', ['linear']), 'linear-2')
  assert.equal(connectorId('https://mcp.example-corp.com/mcp', []), 'example-corp')
  assert.equal(connectorId('https://42.example.com/mcp', []), 'example')
  assert.equal(connectorId('https://mcp.dsh.io/mcp', ['dsh']), 'dsh-2')
  assert.equal(presetOf('https://MCP.linear.app/mcp/')?.id, 'linear')
  assert.equal(connectorName({ id: 'x', url: 'https://mcp.deepwiki.com/mcp' }), 'deepwiki.com')
  assert.equal(connectorName({ id: 'notion', url: 'https://mcp.notion.com/mcp' }), 'Notion')
  assert.ok(validServerUrl('https://mcp.linear.app/mcp'))
  assert.ok(validServerUrl('http://127.0.0.1:3000/mcp'))
  assert.ok(!validServerUrl('http://example.com/mcp'))
  assert.ok(!validServerUrl('not a url'))
  assert.ok(connectorsValid([{ id: 'linear', url: 'https://mcp.linear.app/mcp' }]))
  assert.ok(!connectorsValid([{ id: 'linear', url: 'https://a.dev/mcp' }, { id: 'linear', url: 'https://b.dev/mcp' }]))
  assert.ok(!connectorsValid([{ id: 'Bad Id', url: 'https://a.dev/mcp' }]))
})

test('connectors: a branch names a ticket only with a known team key', () => {
  const keys = ['ENG', 'OPS']
  assert.equal(issueInBranch('vi/eng-123-fix-login', keys), 'ENG-123')
  assert.equal(issueInBranch('ENG-7', keys), 'ENG-7')
  assert.equal(issueInBranch('feature/OPS-42/cleanup', keys), 'OPS-42')
  assert.equal(issueInBranch('feat/login-2', keys), undefined)
  assert.equal(issueInBranch('engine-12', keys), undefined)
  assert.equal(issueInBranch('vi/eng-123-fix', []), undefined)
  assert.equal(issueBranch({ identifier: 'ENG-9', title: 'Fix the Login: crash!' }), 'eng-9-fix-the-login-crash')
  assert.equal(issueBranch({ identifier: 'ENG-9', title: '修复登录' }), 'eng-9')
})

test('linear: issues are read leniently from MCP output', () => {
  assert.deepEqual(toIssue({ identifier: 'eng-1', title: 'T', status: { name: 'In Progress', type: 'started' }, gitBranchName: 'vi/eng-1-t', url: 'u' }),
    { identifier: 'ENG-1', title: 'T', url: 'u', branch: 'vi/eng-1-t', state: 'In Progress', stateType: 'started' })
  assert.deepEqual(toIssue({ id: 'OPS-2', title: 'x', status: 'Done' }), { identifier: 'OPS-2', title: 'x', state: 'Done' })
  assert.equal(toIssue({ id: 'uuid-like-thing-xyz', title: 'x' }), undefined)
  assert.equal(issuesIn({ issues: [{ identifier: 'A-1', title: 'a' }, { nope: 1 }] }).length, 1)
  assert.equal(issuesIn([{ identifier: 'A-1', title: 'a' }])[0]!.identifier, 'A-1')
  assert.equal(issuesIn({ identifier: 'A-2', title: 'b' })[0]!.identifier, 'A-2')
  assert.deepEqual(teamKeysIn({ teams: [{ key: 'ENG' }, { name: 'no key' }, { key: 'OPS' }] }), ['ENG', 'OPS'])
})

test('linear: tickets come through the server\'s own tools, arguments trimmed to its schema', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const session = {
    async tools() {
      return [
        { name: 'list_issues', inputSchema: { properties: { query: {}, assignee: {}, limit: {} } } },
        { name: 'get_issue', inputSchema: { properties: { id: {} } } },
        { name: 'list_teams', inputSchema: { properties: {} } },
      ]
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push([name, args])
      if (name === 'list_teams') return [{ key: 'ENG' }]
      if (name === 'get_issue') return args.id === 'ENG-5' ? { identifier: 'ENG-5', title: 'five' } : { error: 'not found' }
      return { issues: [
        { identifier: 'ENG-1', title: 'open', status: { name: 'Todo', type: 'unstarted' } },
        { identifier: 'ENG-2', title: 'done', status: { name: 'Done', type: 'completed' } },
      ] }
    },
  } as unknown as McpSession
  const tickets = new LinearTickets(() => session)
  assert.deepEqual((await tickets.search()).map((issue) => issue.identifier), ['ENG-1'])
  assert.deepEqual(calls[0], ['list_issues', { assignee: 'me', limit: 50 }])
  assert.deepEqual((await tickets.search('ENG-5')).map((issue) => issue.identifier), ['ENG-5'])
  const linked = await tickets.linked(['vi/eng-5-five', 'feat/login-2', 'eng-404-gone'])
  assert.deepEqual(Object.keys(linked), ['vi/eng-5-five'])
})

/** A fake remote MCP server with its own OAuth authorization server, on a loopback port. */
async function fakeServer(options: { open?: boolean; registration?: boolean; resourcePath?: string; onRegister?: () => Promise<void>; onRefresh?: () => Promise<void> } = {}) {
  const tokens = new Set<string>()
  const codes = new Map<string, string>()
  let issued = 0
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const base = `http://127.0.0.1:${port}`
    const url = new URL(request.url ?? '/', base)
    const body = await new Promise<string>((resolve) => {
      let text = ''
      request.on('data', (chunk) => { text += chunk })
      request.on('end', () => resolve(text))
    })
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
    }
    if (url.pathname === '/mcp' && request.method === 'POST') {
      const token = request.headers.authorization?.replace(/^Bearer /, '')
      if (!options.open && (token === undefined || !tokens.has(token))) {
        response.writeHead(401, { 'www-authenticate': `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"` }).end()
        return
      }
      const message = JSON.parse(body) as { id?: number; method: string }
      if (message.id === undefined) return void response.writeHead(202).end()
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: '{"pong":true}' }] }
      // Answer as an SSE stream, the way most remote servers do.
      response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' })
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
      return
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}${options.resourcePath ?? '/mcp'}`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        ...(options.registration === false ? {} : { registration_endpoint: `${base}/register` }), code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/register') {
      await options.onRegister?.()
      return json(201, { client_id: 'client-1', ...JSON.parse(body) })
    }
    if (url.pathname === '/authorize') {
      // The person approves at once: back to the client's redirect with a code bound to the PKCE challenge.
      assert.equal(url.searchParams.get('resource'), `${base}${options.resourcePath ?? '/mcp'}`)
      assert.equal(url.searchParams.get('scope'), 'read write')
      const code = `code-${codes.size + 1}`
      codes.set(code, url.searchParams.get('code_challenge')!)
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state')!)
      response.writeHead(302, { location: back.toString() }).end()
      return
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(form.get('code')!)
        if (challenge !== createHash('sha256').update(form.get('code_verifier')!).digest('base64url')) return json(400, { error: 'invalid_grant' })
      } else {
        await options.onRefresh?.()
        if (form.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant' })
      }
      const access = `access-${++issued}`
      tokens.add(access)
      return json(200, { access_token: access, refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' })
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => { server.close(); server.closeAllConnections() } }
}

test('oauth: discovery, registration, PKCE sign-in on a loopback redirect, refresh', async () => {
  const fake = await fakeServer()
  try {
    const found = await discover(fake.url)
    assert.equal(found.kind, 'oauth')
    if (found.kind !== 'oauth') return
    assert.equal(found.scope, 'read write')
    const flow = await signIn(found, { name: 'test' })
    // The browser: open the page, follow the redirect to the loopback callback.
    const page = await fetch(flow.authorizeUrl)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Connected/)
    const grant = await flow.result
    assert.equal(grant.access, 'access-1')
    assert.equal(grant.clientId, 'client-1')
    assert.ok(grant.expiresAt! > Date.now())
    const session = new McpSession(fake.url, grant.access)
    assert.deepEqual((await session.tools()).map((tool) => tool.name), ['ping'])
    assert.deepEqual(await session.tool('ping', {}), { pong: true })
    const next = await refreshGrant(grant)
    assert.equal(next.access, 'access-2')
    assert.equal(next.refresh, 'refresh-1')
    await assert.rejects(new McpSession(fake.url, 'wrong').probe(), (error: McpHttpError) => error.status === 401)
  } finally {
    fake.close()
  }
})

test('oauth: a server without registration signs in with a hand-registered client on the fixed redirect; an open one needs nothing', async () => {
  const closed = await fakeServer({ registration: false })
  const open = await fakeServer({ open: true })
  try {
    assert.deepEqual(await discover(open.url), { kind: 'open' })
    const found = await discover(closed.url)
    if (found.kind !== 'oauth') throw new Error('expected oauth')
    assert.equal(found.server.registration_endpoint, undefined)
    await assert.rejects(signIn(found, { name: 'test' }), /client ID/)
    const flow = await signIn(found, { id: 'app-1' })
    const authorize = new URL(flow.authorizeUrl)
    assert.equal(authorize.searchParams.get('client_id'), 'app-1')
    assert.equal(authorize.searchParams.get('redirect_uri'), APP_REDIRECT)
    assert.equal((await fetch(flow.authorizeUrl)).status, 200)
    const grant = await flow.result
    assert.equal(grant.clientId, 'app-1')
    assert.equal(grant.clientSecret, undefined)
    assert.equal((await refreshGrant(grant)).access, 'access-2')
  } finally {
    closed.close()
    open.close()
  }
})

test('connectors: a server without registration asks for a client ID, then signs in with the one configured', async () => {
  const fake = await fakeServer({ registration: false })
  const entries: Array<{ id: string; url: string; clientId?: string }> = [{ id: 'slack', url: fake.url }]
  const { connectors } = harness(entries)
  try {
    assert.deepEqual(await connectors.connect('slack', fake.url), { phase: 'client' })
    await connectors.sync()
    assert.deepEqual(connectors.status()[0]!.state, { phase: 'client' })
    entries[0]!.clientId = ' app-1 '
    const state = await connectors.connect('slack', fake.url)
    if (state.phase !== 'authorizing') throw new Error(`expected authorizing, got ${state.phase}`)
    assert.equal(new URL(state.authorizeUrl).searchParams.get('client_id'), 'app-1')
    connectors.cancel('slack')
  } finally {
    connectors.dispose()
    fake.close()
  }
})

test('connectors: the Slack preset offers a ready-filled app with MCP, PKCE and the fixed redirect', () => {
  const app = presetOf('https://mcp.slack.com/mcp')!.app!
  const manifest = JSON.parse(new URL(app.createUrl).searchParams.get('manifest_json')!)
  assert.equal(manifest.settings.is_mcp_enabled, true)
  assert.equal(manifest.oauth_config.pkce_enabled, true)
  assert.deepEqual(manifest.oauth_config.redirect_urls, [APP_REDIRECT])
  assert.deepEqual(manifest.oauth_config.scopes.user, [...app.scopes])
})

test('oauth: a cancelled sign-in settles and frees its port', async () => {
  const fake = await fakeServer()
  try {
    const found = await discover(fake.url)
    if (found.kind !== 'oauth') throw new Error('expected oauth')
    const flow = await signIn(found, { name: 'test' })
    const port = new URL(new URL(flow.authorizeUrl).searchParams.get('redirect_uri')!).port
    flow.cancel()
    await assert.rejects(flow.result, /cancelled/)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`))
  } finally {
    fake.close()
  }
})

/** Connectors over in-memory credentials and a fake mcp-client. */
function harness(entries: Array<{ id: string; url: string }>) {
  const records = new Map<string, unknown>()
  const mounted: Array<{ config: { serverName: string; headers: Record<string, string> }; disposed: boolean }> = []
  const host: ConnectorsHost = {
    entries: () => entries,
    credentials: {
      async readRecord(key) { return records.get(String(key)) as never },
      async modifyRecord(key, mutate) {
        const next = mutate(records.get(String(key)))
        // Match DSH's documented seam: only the grant payload is opaque/verbatim.
        if (next !== undefined) records.set(String(key), next.kind === 'grant'
          ? { kind: 'grant', payload: structuredClone(next.payload) }
          : { kind: 'api-key', key: next.key })
        return next
      },
      async deleteRecord(key) { records.delete(String(key)) },
    },
    key: (id) => `dsh-agent-hub/connector-${id}`,
    mount(config) {
      const entry = { config: config as { serverName: string; headers: Record<string, string> }, disposed: false }
      mounted.push(entry)
      const fiber: Mounted = { dispose: () => { entry.disposed = true }, await: async () => fiber }
      return fiber
    },
    toolCount: (id) => mounted.filter((entry) => !entry.disposed && entry.config.serverName === id).length * 2,
    log: () => {},
  }
  return { connectors: new Connectors(host), host, records, mounted }
}

test('connectors: a token is tried, kept in the credential store and mounted as a Bearer header', async () => {
  const fake = await fakeServer({ open: false })
  try {
    // Sign in once to have a token the fake server accepts.
    const found = await discover(fake.url)
    if (found.kind !== 'oauth') throw new Error('expected oauth')
    const flow = await signIn(found, { name: 'test' })
    await fetch(flow.authorizeUrl)
    const { access } = await flow.result

    const { connectors, records, mounted } = harness([{ id: 'fake', url: fake.url }])
    await connectors.sync()
    assert.deepEqual(connectors.status()[0]!.state, { phase: 'disconnected' })
    assert.deepEqual(await connectors.token('fake', fake.url, 'nope'), { phase: 'error', message: 'token rejected', reason: 'rejected' })
    assert.equal(records.size, 0)
    const state = await connectors.token('fake', fake.url, ` ${access} `)
    assert.deepEqual(state, { phase: 'connected', tools: 2, via: 'token' })
    assert.deepEqual(records.get('dsh-agent-hub/connector-fake'), { kind: 'grant', payload: { type: 'token', token: access, endpoint: fake.url } })
    assert.equal(mounted[0]!.config.headers.Authorization, `Bearer ${access}`)
    assert.deepEqual(connectors.connected(), ['fake'])
    // A second pass with nothing changed keeps the same client.
    await connectors.sync()
    assert.equal(mounted.length, 1)
    await connectors.disconnect('fake')
    assert.equal(mounted[0]!.disposed, true)
    assert.equal(records.size, 0)
    assert.deepEqual(connectors.connected(), [])
    connectors.dispose()
  } finally {
    fake.close()
  }
})

test('connectors: a browser sign-in mounts once the grant lands; removing the entry unmounts', async () => {
  const fake = await fakeServer()
  const entries = [{ id: 'fake', url: fake.url }]
  try {
    const { connectors, records, mounted } = harness(entries)
    const state = await connectors.connect('fake', fake.url)
    assert.equal(state.phase, 'authorizing')
    if (state.phase !== 'authorizing') return
    await fetch(state.authorizeUrl)
    for (let i = 0; i < 50 && connectors.status()[0]!.state.phase !== 'connected'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(connectors.status()[0]!.state, { phase: 'connected', tools: 2, via: 'oauth' })
    assert.equal((records.get('dsh-agent-hub/connector-fake') as { kind: string }).kind, 'grant')
    entries.length = 0
    await connectors.sync()
    assert.equal(mounted[0]!.disposed, true)
    assert.deepEqual(connectors.status(), [])
    connectors.dispose()
  } finally {
    fake.close()
  }
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const storedKey = 'dsh-agent-hub/connector-fake'
const localUrl = 'http://127.0.0.1:12345/mcp'

test('connectors: dispose while reading or mounting cannot resurrect clients', async () => {
  for (const stage of ['read', 'mount']) {
    const { connectors, host, records, mounted } = harness([{ id: 'fake', url: localUrl }])
    records.set(storedKey, { kind: 'api-key', key: 'old', endpoint: localUrl })
    const gate = deferred()
    if (stage === 'read') host.credentials.readRecord = async () => { await gate.promise; return records.get(storedKey) as never }
    else {
      const mount = host.mount
      host.mount = (config) => {
        const fiber = mount(config)!
        fiber.await = () => gate.promise
        return fiber
      }
    }
    const sync = connectors.sync()
    await turn()
    connectors.dispose()
    gate.resolve()
    await sync
    await connectors.sync()
    assert.equal(mounted.filter((entry) => !entry.disposed).length, 0)
    assert.deepEqual(connectors.connected(), [])
    await assert.rejects(connectors.connect('fake', localUrl), /disposed/)
    await assert.rejects(connectors.token('fake', localUrl, 'new'), /disposed/)
  }
})

test('connectors: an old failed mount cannot unmount a newer operation', async () => {
  const { connectors, host, records, mounted } = harness([{ id: 'fake', url: localUrl }])
  records.set(storedKey, { kind: 'api-key', key: 'old', endpoint: localUrl })
  const gate = deferred()
  const mount = host.mount
  host.mount = (config) => {
    const fiber = mount(config)!
    if (mounted.length === 1) fiber.await = () => gate.promise
    return fiber
  }
  const probe = mock.method(McpSession.prototype, 'probe', async () => {})
  try {
    const old = connectors.sync()
    await turn()
    const newer = connectors.token('fake', localUrl, 'new')
    await turn()
    gate.reject(new Error('late old failure'))
    await Promise.all([old, newer])
    assert.deepEqual(connectors.connected(), ['fake'])
    assert.equal(mounted.at(-1)!.config.headers.Authorization, 'Bearer new')
  } finally { probe.mock.restore(); connectors.dispose() }
})

test('connectors: overlapping token/discovery requests and cancel keep only the latest generation', async () => {
  for (const older of ['token', 'connect']) {
    const { connectors, records } = harness([{ id: 'fake', url: localUrl }])
    const gate = deferred()
    let calls = 0
    const probe = mock.method(McpSession.prototype, 'probe', async () => { if (++calls === 1) await gate.promise })
    try {
      const old = older === 'token' ? connectors.token('fake', localUrl, 'old') : connectors.connect('fake', localUrl)
      await turn()
      await connectors.token('fake', localUrl, 'new')
      gate.resolve()
      await old
      assert.equal((records.get(storedKey) as { payload: { token: string } }).payload.token, 'new')
      assert.equal(connectors.status()[0]!.state.phase, 'connected')
      const pending = deferred()
      probe.mock.mockImplementation(async () => pending.promise)
      const cancelled = connectors.token('fake', localUrl, 'cancelled')
      connectors.cancel('fake')
      pending.resolve()
      await cancelled
      assert.equal((records.get(storedKey) as { payload: { token: string } }).payload.token, 'new')
      assert.equal(connectors.status()[0]!.state.phase, 'disconnected')
    } finally { probe.mock.restore(); connectors.dispose() }
  }
})

test('connectors: disconnect deletion failure is visible and never silently remounts', async () => {
  const { connectors, host, records, mounted } = harness([{ id: 'fake', url: localUrl }])
  records.set(storedKey, { kind: 'api-key', key: 'old', endpoint: localUrl })
  await connectors.sync()
  host.credentials.deleteRecord = async () => { throw new Error('disk denied') }
  await assert.rejects(connectors.disconnect('fake'), /disk denied/)
  assert.match((connectors.status()[0]!.state as { message: string }).message, /credential deletion failed/)
  await connectors.sync()
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0]!.disposed, true)
  assert.equal(records.size, 1)
  host.credentials.deleteRecord = async () => { records.delete(storedKey) }
  await connectors.disconnect('fake')
  assert.equal(records.size, 0)
  connectors.dispose()
})

test('connectors: records bind to the endpoint and legacy records migrate only on the original endpoint', async () => {
  for (const syncFirst of [true, false]) {
    const entries = [{ id: 'fake', url: localUrl }]
    const { connectors, records, mounted } = harness(entries)
    records.set(storedKey, { kind: 'api-key', key: 'legacy' })
    if (syncFirst) {
      await connectors.sync()
      assert.equal((records.get(storedKey) as { payload: { endpoint: string } }).payload.endpoint, localUrl)
    }
    entries[0]!.url = `${localUrl}/different`
    await connectors.sync()
    assert.equal(connectors.status()[0]!.state.phase, 'disconnected')
    assert.equal(mounted.filter((entry) => !entry.disposed).length, 0)
    connectors.dispose()
  }
  const { connectors, records, mounted } = harness([{ id: 'fake', url: localUrl }])
  records.set(storedKey, { kind: 'grant', payload: { type: 'oauth', access: 'old', resource: `${localUrl}/other` } })
  await connectors.sync()
  assert.equal(mounted.length, 0)
  connectors.dispose()
})

test('connectors: changing the endpoint cancels an authorizing flow and closes its callback', async () => {
  const fake = await fakeServer()
  const entries = [{ id: 'fake', url: fake.url }]
  const { connectors, records } = harness(entries)
  try {
    const state = await connectors.connect('fake', fake.url)
    if (state.phase !== 'authorizing') throw new Error('expected authorizing')
    const redirect = new URL(state.authorizeUrl).searchParams.get('redirect_uri')!
    entries[0]!.url = `${fake.url}/other`
    await connectors.sync()
    await assert.rejects(fetch(redirect))
    assert.equal(records.size, 0)
    assert.equal(connectors.status()[0]!.state.phase, 'disconnected')
  } finally { connectors.dispose(); fake.close() }
})

test('connectors: a valid legacy OAuth resource remains usable and becomes endpoint-bound', async () => {
  const { connectors, records } = harness([{ id: 'fake', url: localUrl }])
  records.set(storedKey, { kind: 'grant', payload: {
    type: 'oauth', access: 'legacy', resource: localUrl, clientId: 'client', tokenEndpoint: 'http://127.0.0.1:12345/token',
  } })
  await connectors.sync()
  assert.deepEqual(connectors.connected(), ['fake'])
  assert.equal((records.get(storedKey) as { payload: { endpoint: string } }).payload.endpoint, localUrl)
  connectors.dispose()
})

test('connectors: legacy OAuth resource may differ from its MCP transport URL', async () => {
  const fake = await fakeServer({ resourcePath: '/' })
  const { connectors, records, mounted } = harness([{ id: 'fake', url: fake.url }])
  try {
    const resource = new URL('/', fake.url).href
    records.set(storedKey, { kind: 'grant', payload: {
      type: 'oauth', access: 'legacy', resource, clientId: 'client', tokenEndpoint: new URL('/token', fake.url).href,
    } })
    await connectors.sync()
    assert.deepEqual(connectors.connected(), ['fake'])
    const payload = (records.get(storedKey) as { payload: { resource: string; endpoint: string } }).payload
    assert.equal(payload.resource, resource)
    assert.equal(payload.endpoint, fake.url)
    assert.equal(mounted.length, 1)
  } finally { connectors.dispose(); fake.close() }
})

test('connectors: OAuth background credential write failures are caught and reported', async () => {
  const fake = await fakeServer()
  const { connectors, host } = harness([{ id: 'fake', url: fake.url }])
  host.credentials.modifyRecord = async () => { throw new Error('store unavailable') }
  try {
    const state = await connectors.connect('fake', fake.url)
    if (state.phase !== 'authorizing') throw new Error('expected authorizing')
    await fetch(state.authorizeUrl)
    for (let i = 0; i < 50 && connectors.status()[0]!.state.phase === 'authorizing'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(connectors.status()[0]!.state, { phase: 'error', message: 'store unavailable' })
  } finally { connectors.dispose(); fake.close() }
})

test('connectors: late OAuth registration is cancelled instead of replacing a newer token', async () => {
  const registering = deferred()
  const release = deferred()
  const fake = await fakeServer({ onRegister: async () => { registering.resolve(); await release.promise } })
  const { connectors, records } = harness([{ id: 'fake', url: fake.url }])
  try {
    const old = connectors.connect('fake', fake.url)
    await registering.promise
    const probe = mock.method(McpSession.prototype, 'probe', async () => {})
    try { await connectors.token('fake', fake.url, 'new') } finally { probe.mock.restore() }
    release.resolve()
    await old
    assert.equal((records.get(storedKey) as { payload: { token: string } }).payload.token, 'new')
    assert.equal(connectors.status()[0]!.state.phase, 'connected')
  } finally { release.resolve(); connectors.dispose(); fake.close() }
})

test('connectors: a refresh already in flight cannot overwrite a newer token or disconnect', async () => {
  for (const next of ['token', 'disconnect']) {
    const refreshing = deferred()
    const release = deferred()
    const fake = await fakeServer({ onRefresh: async () => { refreshing.resolve(); await release.promise } })
    const { connectors, records } = harness([{ id: 'fake', url: fake.url }])
    records.set(storedKey, { kind: 'grant', endpoint: fake.url, payload: {
      type: 'oauth', access: 'old', refresh: 'refresh-1', expiresAt: 0,
      clientId: 'client-1', tokenEndpoint: fake.url.replace('/mcp', '/token'), resource: fake.url,
    } })
    try {
      const old = connectors.sync()
      await refreshing.promise
      let newer: Promise<unknown>
      if (next === 'disconnect') newer = connectors.disconnect('fake')
      else {
        const probe = mock.method(McpSession.prototype, 'probe', async () => {})
        newer = connectors.token('fake', fake.url, 'new')
        await turn()
        probe.mock.restore()
      }
      release.resolve()
      await Promise.all([old, newer])
      if (next === 'disconnect') {
        assert.equal(records.size, 0)
        assert.deepEqual(connectors.connected(), [])
      } else assert.equal((records.get(storedKey) as { payload: { token: string } }).payload.token, 'new')
    } finally { release.resolve(); connectors.dispose(); fake.close() }
  }
})

test('connectors: async credential mutations remain ordered across repeated operations', async () => {
  const { connectors, host, records } = harness([{ id: 'fake', url: localUrl }])
  const entered = deferred()
  const release = deferred()
  const modify = host.credentials.modifyRecord
  let writes = 0
  host.credentials.modifyRecord = async (key, mutate) => {
    if (++writes === 1) { entered.resolve(); await release.promise }
    return modify(key, mutate)
  }
  const probe = mock.method(McpSession.prototype, 'probe', async () => {})
  try {
    const old = connectors.token('fake', localUrl, 'old')
    await entered.promise
    const newer = connectors.token('fake', localUrl, 'new')
    release.resolve()
    await Promise.all([old, newer])
    assert.equal((records.get(storedKey) as { payload: { token: string } }).payload.token, 'new')
    await Promise.all([connectors.disconnect('fake'), connectors.disconnect('fake')])
    assert.equal(records.size, 0)
  } finally { release.resolve(); probe.mock.restore(); connectors.dispose() }
})

test('mcp: a continuous SSE response returns its matching frame without waiting for EOF', async () => {
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const message = JSON.parse(text) as { id?: number; method: string }
    if (message.id === undefined) return void response.writeHead(202).end()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: message\r\ndata: {"id":999,"result":{}}\r\n\r\n: heartbeat\r\n\r\n')
    const answer = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: '持续' }] } })
    const bytes = Buffer.from(`data: ${answer}\r\n\r\n`)
    // Split at arbitrary bytes, including inside the UTF-8 tool name.
    for (const byte of bytes) response.write(Buffer.from([byte]))
    // Deliberately leave this SSE response open.
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const session = new McpSession(`http://127.0.0.1:${port}/mcp`, undefined)
    assert.deepEqual(await session.tools(AbortSignal.timeout(2000)), [{ name: '持续' }])
  } finally { server.close(); server.closeAllConnections() }
})

test('mcp: waiting for an SSE answer still respects the caller timeout', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"id":999,"result":{}}\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await assert.rejects(new McpSession(`http://127.0.0.1:${port}/mcp`, undefined).probe(AbortSignal.timeout(100)))
  } finally { server.close(); server.closeAllConnections() }
})

test('claude bridge: connector tools keep their DSH names, and the signature follows the set', () => {
  const schemas = [
    { name: 'send_message', description: 'send', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__linear__list_issues', description: 'list', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'mcp__linear__get_issue', description: 'get', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__notion__search', description: 'search', parameters: { type: 'object', properties: {} } },
    { name: 'bash', description: 'shell', parameters: {} },
  ]
  const registry: ToolRegistry = { schemas: () => schemas, execute: async () => ({ isError: false, content: [] }) }
  const plan = bridges(registry, () => 'agent', { connectors: ['linear'] })
  assert.equal(plan.team, true)
  assert.equal(plan.signature, ['mcp__linear__get_issue', 'mcp__linear__list_issues', 'send_message'].join('\n'))
  const { servers, trusted } = plan.open()
  assert.deepEqual(Object.keys(servers).sort(), ['dsh', 'linear'])
  assert.deepEqual(trusted, ['mcp__dsh__', 'mcp__linear__'])
  const tools = (servers.linear!.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  assert.deepEqual(Object.keys(tools).sort(), ['get_issue', 'list_issues'])
  assert.notEqual(bridges(registry, () => 'agent', { connectors: ['linear', 'notion'] }).signature, plan.signature)
  assert.equal(bridges(registry, () => undefined, { connectors: ['linear'] }).signature, '')
})

test('linear: a ticket\'s pull requests come from attachments and the PRs its text names, each once', async () => {
  const { pullRequestsIn, pullRequestOf } = await import('../src/connectors/linear.ts')
  assert.deepEqual(pullRequestOf('https://github.com/acme/app/pull/12/files'), { label: 'acme/app#12', number: 12 })
  assert.deepEqual(pullRequestOf('https://gitlab.com/g/sub/app/-/merge_requests/7'), { label: 'g/sub/app#7', number: 7 })
  assert.equal(pullRequestOf('https://github.com/acme/app/issues/12'), undefined)
  const prs = pullRequestsIn(
    [
      { title: 'fix: the thing', url: 'https://github.com/acme/app/pull/12' },
      { title: 'Message from Slack', url: 'https://acme.slack.com/archives/C1/p1' },
    ],
    [
      'See <pull-request id="x" href="https://linear.app/acme/review/fix-1">acme/app#13</pull-request> and https://github.com/acme/app/pull/12.',
      '[acme/app#14](https://linear.app/acme/review/other) and [docs](https://example.com)',
      undefined,
    ],
  )
  assert.deepEqual(prs, [
    { url: 'https://github.com/acme/app/pull/12', label: 'acme/app#12', title: 'fix: the thing', number: 12 },
    { url: 'https://linear.app/acme/review/fix-1', label: 'acme/app#13', number: 13 },
    { url: 'https://linear.app/acme/review/other', label: 'acme/app#14', number: 14 },
  ])
})

test('linear: a ticket\'s detail merges its state history and comments into one activity, oldest first', async () => {
  const { detailOf } = await import('../src/connectors/linear.ts')
  const { plainMentions } = await import('../src/connectors/types.ts')
  const detail = detailOf('eng-1', {
    id: 'ENG-1',
    description: 'Blocks <issue id="u" href="h">ENG-2</issue>',
    project: 'Hub',
    projectMilestone: { name: 'M1' },
    labels: ['bug', { name: 'p1' }],
    attachments: [{ title: 'pr', url: 'https://github.com/a/b/pull/3' }],
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'vi@x.ai',
    stateHistory: [
      { state: { name: 'Backlog', type: 'backlog' }, startedAt: '2026-01-01T00:00:00Z' },
      { state: { name: 'In Progress', type: 'Started' }, startedAt: '2026-01-03T00:00:00Z' },
    ],
  }, { comments: [
    { body: 'later', createdAt: '2026-01-04T00:00:00Z', author: { name: 'Ann' }, parentId: 'c1' },
    { body: 'see [a/b#4](https://github.com/a/b/pull/4)', createdAt: '2026-01-02T00:00:00Z', author: { name: 'Bo' }, parentId: null },
  ] })
  assert.equal(detail.identifier, 'ENG-1')
  assert.equal(detail.project, 'Hub')
  assert.equal(detail.milestone, 'M1')
  assert.deepEqual(detail.labels, ['bug', 'p1'])
  assert.deepEqual(detail.pullRequests.map((pr) => pr.label), ['a/b#3', 'a/b#4'])
  assert.deepEqual(detail.activity.map((entry) => entry.kind), ['created', 'state', 'comment', 'state', 'comment'])
  assert.deepEqual(detail.activity[3], { kind: 'state', at: '2026-01-03T00:00:00Z', state: 'In Progress', stateType: 'started' })
  assert.deepEqual(detail.activity[4], { kind: 'comment', at: '2026-01-04T00:00:00Z', body: 'later', reply: true, actor: 'Ann' })
  assert.equal(plainMentions(detail.description!), 'Blocks ENG-2')
  assert.equal(plainMentions('see [a/b#4](https://github.com/a/b/pull/4)'), 'see a/b#4')
})

test('linear: pull requests are cached by the ticket\'s version; a detail survives a server without comments', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const session = {
    async tools() {
      return [{ name: 'get_issue', inputSchema: { properties: { id: {}, fields: {} } } }]
    },
    async tool(name: string, args: Record<string, unknown>) {
      calls.push([name, args])
      return { id: args.id, description: 'https://github.com/a/b/pull/9', attachments: [], createdAt: '2026-01-01T00:00:00Z' }
    },
  } as unknown as McpSession
  const tickets = new LinearTickets(() => session)
  assert.deepEqual((await tickets.pullRequests('ENG-1', 1)).map((pr) => pr.label), ['a/b#9'])
  await tickets.pullRequests('ENG-1', 1)
  assert.equal(calls.length, 1)
  await tickets.pullRequests('ENG-1', 2)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0]![1].fields, ['id', 'description', 'attachments'])
  const detail = await tickets.detail('ENG-1')
  assert.deepEqual(detail.activity.map((entry) => entry.kind), ['created'])
  assert.deepEqual(calls.map(([name]) => name), ['get_issue', 'get_issue', 'get_issue'])
})
