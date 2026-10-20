import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, connect, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { acceptKey, acceptUpgrade, requestUpgrade, WsConnection } from '../src/device/ws.ts'
import { startLink } from '../src/device/link.ts'

async function pair(t: TestContext): Promise<[Socket, Socket]> {
  const server = createServer()
  const sockets: Socket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const accepted = once(server, 'connection')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = connect(address.port, '127.0.0.1')
  sockets.push(client)
  client.on('error', () => {})
  const connected = once(client, 'connect')
  const [peer] = await accepted as [Socket]
  sockets.push(peer)
  peer.on('error', () => {})
  await connected
  return [client, peer]
}

function frame(op: number, payload = Buffer.alloc(0), options: { fin?: boolean; masked?: boolean; rsv?: boolean } = {}): Buffer {
  const masked = options.masked ?? true
  const extended = payload.length >= 126
  const header = Buffer.alloc(2 + (extended ? 2 : 0) + (masked ? 4 : 0))
  header[0] = ((options.fin ?? true) ? 128 : 0) | (options.rsv ? 64 : 0) | op
  header[1] = (masked ? 128 : 0) | (extended ? 126 : payload.length)
  if (extended) header.writeUInt16BE(payload.length, 2)
  // A zero mask keeps hand-built payloads readable while remaining RFC-compliant.
  return Buffer.concat([header, payload])
}
const request = (overrides: Record<string, string> = {}, line = 'GET /device HTTP/1.1'): string => {
  const fields = {
    host: 'localhost', upgrade: 'websocket', connection: 'keep-alive, Upgrade',
    'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'), ...overrides,
  }
  return `${line}\r\n${Object.entries(fields).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`
}

test('WS: real TCP handshake, coalesced head, fragmented UTF-8 and ping', { timeout: 5000 }, async (t) => {
  const [client, peer] = await pair(t)
  const accepted = acceptUpgrade(peer, '/device')
  const pong = new Promise<Buffer>((resolve) => {
    client.on('data', (chunk: Buffer) => { if (chunk.includes(Buffer.from('ping'))) resolve(chunk) })
  })
  client.write(Buffer.concat([Buffer.from(request()), frame(1, Buffer.from('first'))]))
  const server = await accepted
  assert.deepEqual(await once(server, 'text'), ['first'])
  const text = once(server, 'text')
  const bytes = Buffer.from('hello 世界')
  client.write(Buffer.concat([
    frame(1, bytes.subarray(0, 7), { fin: false }), frame(9, Buffer.from('ping')),
    frame(0, bytes.subarray(7)),
  ]))
  assert.deepEqual(await text, ['hello 世界'])
  assert.ok((await pong).includes(Buffer.from([0x8a, 4])))
})

test('WS: client and server complete exact upgrades and exchange messages', { timeout: 5000 }, async (t) => {
  const [client, peer] = await pair(t)
  const [server, device] = await Promise.all([acceptUpgrade(peer, '/device'), requestUpgrade(client, 'localhost', '/device')])
  const binary = once(server, 'binary')
  device.send(Buffer.from([1, 2, 3]))
  assert.deepEqual(await binary, [Buffer.from([1, 2, 3])])
  const large = once(server, 'binary')
  const maximum = Buffer.alloc(256 * 1024, 42)
  device.send(maximum)
  assert.deepEqual(await large, [maximum])
  const text = once(device, 'text')
  server.send('snapshot')
  assert.deepEqual(await text, ['snapshot'])
  const closed = once(server, 'close')
  device.close()
  await closed
  assert.equal(server.open, false)
})

const invalidFrames = [
  ['missing mask', frame(1, Buffer.from('x'), { masked: false })],
  ['RSV bit', frame(1, Buffer.alloc(0), { rsv: true })],
  ['reserved opcode', frame(3)],
  ['fragmented ping', frame(9, Buffer.alloc(0), { fin: false })],
  ['oversized ping', frame(9, Buffer.alloc(126))],
  ['unexpected continuation', frame(0)],
  ['nested fragments', Buffer.concat([frame(1, Buffer.alloc(0), { fin: false }), frame(2)])],
  ['invalid UTF-8', frame(1, Buffer.from([0xff]))],
  ['one-byte close', frame(8, Buffer.from([3]))],
  ['reserved close code', frame(8, Buffer.from([3, 237]))],
  ['invalid close reason', frame(8, Buffer.from([3, 232, 255]))],
  ['noncanonical length', Buffer.from([0x82, 0xfe, 0, 1])],
  ['huge 64-bit length', Buffer.from([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0])],
] as const
for (const [name, packet] of invalidFrames) {
  test(`WS refuses ${name}`, { timeout: 5000 }, async (t) => {
    const [client, peer] = await pair(t)
    const ws = new WsConnection(peer, false)
    const closed = once(ws, 'close')
    client.write(packet)
    await closed
    assert.equal(ws.open, false)
    assert.equal(peer.destroyed, true)
    assert.equal(peer.listenerCount('data'), 0)
  })
}

test('WS client refuses masked server frames', { timeout: 5000 }, async (t) => {
  const [client, peer] = await pair(t)
  const ws = new WsConnection(client, true)
  const closed = once(ws, 'close')
  peer.write(frame(1))
  await closed
})

test('WS limits empty fragments and total message bytes', { timeout: 5000 }, async (t) => {
  for (const packets of [
    [frame(1, Buffer.alloc(0), { fin: false }), ...Array.from({ length: 1024 }, () => frame(0, Buffer.alloc(0), { fin: false }))],
    [frame(2, Buffer.alloc(60000), { fin: false }), ...Array.from({ length: 4 }, () => frame(0, Buffer.alloc(60000), { fin: false }))],
  ]) {
    const [client, peer] = await pair(t)
    const ws = new WsConnection(peer, false)
    const closed = once(ws, 'close')
    client.write(Buffer.concat(packets))
    await closed
    assert.equal(peer.destroyed, true)
  }
})

test('WS parses bytewise input and many coalesced frames', { timeout: 5000 }, async (t) => {
  const [client, peer] = await pair(t)
  const ws = new WsConnection(peer, false)
  const received: string[] = []
  ws.on('text', (text) => received.push(text))
  const packet = frame(1, Buffer.alloc(4000, 65))
  for (const byte of packet) client.write(Buffer.from([byte]))
  const last = new Promise<void>((resolve) => ws.on('text', (text) => { if (text === 'last') resolve() }))
  client.write(Buffer.concat([...Array.from({ length: 2000 }, () => frame(1, Buffer.from('ok'))), frame(1, Buffer.from('last'))]))
  await last
  assert.equal(received.length, 2002)
  assert.equal(received[0], 'A'.repeat(4000))
})

test('WS bounds pending writes without waiting for drain', () => {
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, _callback) {} })
  const ws = new WsConnection(socket, false)
  let closes = 0
  ws.on('close', () => closes++)
  for (let i = 0; i < 10; i++) ws.send(Buffer.alloc(256 * 1024))
  assert.equal(ws.open, false)
  assert.equal(socket.destroyed, true)
  assert.ok(socket.writableLength <= 1024 * 1024)
  assert.equal(closes, 1)
})

test('WS drops a stalled TCP consumer instead of accumulating snapshots', { timeout: 5000 }, async (t) => {
  const [client, peer] = await pair(t)
  client.pause()
  const ws = new WsConnection(peer, false)
  const payload = Buffer.alloc(64 * 1024)
  for (let i = 0; i < 512 && ws.open; i++) ws.send(payload)
  assert.equal(ws.open, false)
  assert.equal(peer.destroyed, true)
  assert.ok(peer.writableLength <= 1024 * 1024)
})

test('WS disconnects oversized outgoing messages', () => {
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
  const ws = new WsConnection(socket, true)
  ws.send('x'.repeat(256 * 1024 + 1))
  assert.equal(socket.destroyed, true)
})

test('handshake cleans listeners immediately on EOF, close and timeout', { timeout: 5000 }, async (t) => {
  for (const upgrade of [acceptUpgrade, (socket: Socket, _path: string, timeout: number) => requestUpgrade(socket, 'localhost', '/device', timeout)]) {
    for (const action of ['end', 'destroy', 'timeout']) {
      const [client, peer] = await pair(t)
      const baseline = peer.listenerCount('error')
      const baselineEnd = peer.listenerCount('end')
      const result = upgrade(peer, '/device', action === 'timeout' ? 20 : 4000)
      const refused = assert.rejects(result, /closed|timed out/)
      if (action === 'end') client.end()
      if (action === 'destroy') peer.destroy()
      await refused
      assert.equal(peer.listenerCount('data'), 0)
      assert.equal(peer.listenerCount('end'), baselineEnd)
      assert.equal(peer.listenerCount('error'), baseline)
    }
  }
})

for (const [name, packet] of [
  ['Connection token', request({ connection: 'keep-alive' })],
  ['version', request({ 'sec-websocket-version': '12' })],
  ['invalid key', request({ 'sec-websocket-key': 'not-a-key' })],
  ['HTTP version', request({}, 'GET /device HTTP/1.0')],
  ['duplicate key', request().replace('\r\n\r\n', '\r\nsec-websocket-key: other\r\n\r\n')],
  ['malformed header', request().replace('\r\n\r\n', '\r\nbroken\r\n\r\n')],
  ['oversized complete header', request({ extra: 'x'.repeat(8192) })],
  ['oversized incomplete header', 'x'.repeat(8200)],
] as const) {
  test(`server handshake refuses ${name}`, { timeout: 5000 }, async (t) => {
    const [client, peer] = await pair(t)
    const refused = assert.rejects(acceptUpgrade(peer, '/device'))
    client.write(packet)
    await refused
  })
}

test('client handshake validates exact status, accept value and negotiated headers', { timeout: 5000 }, async (t) => {
  for (const mode of ['status', 'case', 'wrong-header', 'missing-connection', 'extension', 'oversized']) {
    const [client, peer] = await pair(t)
    const refused = assert.rejects(requestUpgrade(client, 'localhost', '/device'))
    const [requestBytes] = await once(peer, 'data') as [Buffer]
    const key = /sec-websocket-key: (.+)\r\n/.exec(requestBytes.toString())![1]!
    const accept = acceptKey(key)
    let response = `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`
    if (mode === 'status') response = response.replace('101 Switching', '1010 Switching')
    if (mode === 'case') response = response.replace(accept, accept.toLowerCase())
    if (mode === 'wrong-header') response = response.replace('sec-websocket-accept:', 'x-accept:')
    if (mode === 'missing-connection') response = response.replace('connection: Upgrade\r\n', '')
    if (mode === 'extension') response = response.replace('\r\n\r\n', '\r\nsec-websocket-extensions: permessage-deflate\r\n\r\n')
    if (mode === 'oversized') response = 'x'.repeat(8200)
    peer.write(response)
    await refused
    assert.equal(client.listenerCount('data'), 0)
  }
})

test('TLS link close releases TCP peers stalled before ClientHello and is idempotent', { timeout: 5000 }, async (t) => {
  const link = await startLink({ port: 0, host: '127.0.0.1', keyOf: () => null, onPeer: () => assert.fail('unexpected peer'), log: () => {} })
  t.after(() => link.close())
  const socket = connect(link.port, '127.0.0.1')
  socket.on('error', () => {})
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  const first = link.close()
  assert.equal(link.close(), first)
  await first
  await closed
})
