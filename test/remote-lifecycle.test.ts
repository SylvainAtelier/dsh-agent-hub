import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const trace: string[] = []
/** The HTTPS rule's target and the name it was set under; the port-80 rule's target. */
let target: string | undefined
let targetHost: string | undefined
let plain: string | undefined
let dnsName = 'box.tail.ts.net'
let nextPort = 9000
let proxyStart: ((options: unknown) => Promise<{ port: number; close(): void }>) | undefined
let removeGate: Promise<void> | undefined
let serveGate: Promise<void> | undefined
let serveStarted: (() => void) | undefined
mock.module('../src/remote/proxy.ts', { namedExports: {
  startProxy: async (options: unknown) => {
    trace.push('proxy')
    if (proxyStart !== undefined) return proxyStart(options)
    const port = ++nextPort
    return { port, close() { trace.push(`close:${port}`) } }
  },
  startRedirect: async () => {
    trace.push('redirect')
    const port = ++nextPort
    return { port, close() { trace.push(`close:${port}`) } }
  },
} })
mock.module('../src/remote/tailscale.ts', { namedExports: {
  findTailscale: () => 'tailscale',
  node: async () => ({ dnsName, login: 'owner', https: true }),
  served: async (_file: string, port: number, host: string) => port === 80 ? (host === dnsName ? plain : undefined) : (host === targetHost ? target : undefined),
  serve: async (_file: string, _port: number, value: string, scheme = 'https') => {
    if (scheme === 'http') { trace.push('serve:http'); plain = value; return }
    trace.push('serve'); serveStarted?.(); await serveGate; target = value; targetHost = dnsName
  },
  unserve: async (_file: string, _port: number, scheme = 'https') => {
    if (scheme === 'http') { trace.push('unserve:http'); plain = undefined; return }
    trace.push('unserve'); await removeGate; target = undefined
  },
} })
const { createRemote } = await import('../src/remote/index.ts')
const options = (file: string, httpsPort = 443, http = false) => ({ file, httpsPort, http, upstream: () => 19387, signIn: () => undefined, log: () => {} })
const reset = () => { trace.length = 0; target = undefined; targetHost = undefined; plain = undefined; dnsName = 'box.tail.ts.net' }

test('remote: dispose during proxy allocation closes the late proxy and never serves it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-life-'))
  const gate = deferred<{ port: number; close(): void }>()
  reset()
  const started = deferred<void>()
  proxyStart = () => { started.resolve(); return gate.promise }
  const remote = createRemote(options(join(dir, 'remote.json')))
  try {
    const enabling = remote.run('enable')
    await started.promise
    assert.deepEqual(trace, ['proxy'])
    const closing = remote.dispose()
    gate.resolve({ port: 12345, close() { trace.push('late-close') } })
    const result = await enabling
    await closing
    assert.match(result.error!, /shutting down/)
    assert.deepEqual(trace, ['proxy', 'late-close'])
    await assert.rejects(remote.run('enable'), /shutting down/)
    remote.resume(); await tick()
    assert.equal(trace.filter((item) => item === 'proxy').length, 1)
  } finally {
    proxyStart = undefined
    await remote.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: cleanup drains an in-flight serve and removes its rule before replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-handoff-'))
  const gate = deferred<void>()
  reset()
  serveGate = gate.promise
  const started = deferred<void>()
  serveStarted = () => started.resolve()
  const remote = createRemote(options(join(dir, 'remote.json')))
  try {
    const enabling = remote.run('enable')
    await started.promise
    assert.ok(trace.includes('serve'))
    let closed = false
    const closing = remote.dispose().then(() => { closed = true })
    await tick()
    assert.equal(closed, false)
    gate.resolve(); await enabling; await closing
    assert.equal(target, undefined)
    assert.ok(trace.indexOf('unserve') > trace.indexOf('serve'))
    assert.ok(trace.at(-1)!.startsWith('close:'))
  } finally {
    serveGate = undefined; serveStarted = undefined; gate.resolve()
    await remote.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: failed cleanup retries the original owned target after its proxy is closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-retry-'))
  reset()
  const remote = createRemote(options(join(dir, 'remote.json')))
  try {
    await remote.run('enable')
    const owned = target
    removeGate = Promise.reject(new Error('temporary CLI failure'))
    // The rejection is consumed by the cleanup initiated immediately below.
    await assert.rejects(remote.dispose(), /temporary CLI failure/)
    assert.equal(target, owned)
    assert.ok(trace.at(-1)!.startsWith('close:'))
    removeGate = undefined
    await remote.dispose()
    assert.equal(target, undefined)
    assert.equal(trace.filter((item) => item === 'unserve').length, 2)
    assert.equal(trace.filter((item) => item.startsWith('close:')).length, 1)
  } finally {
    removeGate = undefined
    await remote.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: awaitable disposal preserves enabled choice and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-enabled-'))
  const file = join(dir, 'remote.json')
  reset()
  const remote = createRemote(options(file))
  const gate = deferred<void>()
  try {
    assert.equal((await remote.run('enable')).view.state, 'on')
    removeGate = gate.promise
    const first = remote.dispose()
    const second = remote.dispose()
    assert.equal(first, second)
    await tick()
    assert.equal(trace.filter((item) => item === 'unserve').length, 1)
    gate.resolve(); await first
    assert.equal(JSON.parse(await readFile(file, 'utf8')).enabled, true)
    const replacement = createRemote(options(file, 8443))
    try {
      replacement.resume(); await tick(); await tick()
      assert.equal((await replacement.run('status')).view.state, 'on')
    } finally { await replacement.dispose() }
  } finally {
    removeGate = undefined; gate.resolve()
    await remote.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: http:// gets a redirect hop of its own on port 80, removed with the HTTPS rule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-http-'))
  const file = join(dir, 'remote.json')
  reset()
  const remote = createRemote(options(file, 443, true))
  try {
    assert.equal((await remote.run('enable')).view.state, 'on')
    assert.deepEqual(trace, ['proxy', 'serve', 'redirect', 'serve:http'])
    assert.notEqual(plain, target)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved, { enabled: true, target, redirect: plain })
    await remote.dispose()
    assert.equal(target, undefined)
    assert.equal(plain, undefined)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved, 'quitting keeps the choice')
  } finally {
    await remote.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: a hand-made port-80 rule to the HTTPS hop is taken over; a foreign one is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-adopt-'))
  const file = join(dir, 'remote.json')
  reset()
  const first = createRemote(options(file))
  await first.run('enable')
  await first.dispose()
  const hop = JSON.parse(await readFile(file, 'utf8')).target as string
  plain = hop
  const second = createRemote(options(file, 443, true))
  try {
    await second.run('enable')
    assert.ok(plain !== undefined && plain !== hop && plain !== target)
    await second.dispose()
    plain = 'http://127.0.0.1:1'
    const third = createRemote(options(file, 443, true))
    try {
      assert.equal((await third.run('enable')).view.state, 'on')
      assert.equal(plain, 'http://127.0.0.1:1')
      await third.dispose()
      assert.equal(plain, 'http://127.0.0.1:1')
    } finally { await third.dispose() }
  } finally {
    await second.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: turning the http option off removes the rule this plugin set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-http-off-'))
  const file = join(dir, 'remote.json')
  reset()
  const first = createRemote(options(file, 443, true))
  await first.run('enable')
  // A rule surviving a crash: the next instance, with http off, cleans it up.
  const leftover = plain
  const second = createRemote(options(file, 443, false))
  try {
    assert.ok(leftover !== undefined)
    second.resume(); await tick(); await tick()
    assert.equal((await second.run('status')).view.state, 'on')
    assert.equal(plain, undefined)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).redirect, undefined)
  } finally {
    await first.dispose(); await second.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote: after the node is renamed, status re-serves under the new name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-remote-rename-'))
  reset()
  const remote = createRemote(options(join(dir, 'remote.json'), 443, true))
  try {
    await remote.run('enable')
    dnsName = 'box-2.tail.ts.net'
    trace.length = 0
    const result = await remote.run('status')
    assert.equal(result.view.state, 'on')
    assert.equal(result.view.state === 'on' && result.view.url, 'https://box-2.tail.ts.net')
    assert.equal(targetHost, 'box-2.tail.ts.net')
    assert.ok(trace.includes('serve') && trace.includes('serve:http'))
    trace.length = 0
    await remote.run('status')
    assert.deepEqual(trace, [], 'an intact rule is left as it is')
  } finally {
    await remote.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
