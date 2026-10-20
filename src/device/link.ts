/**
 * The device link: one WebSocket on `/device`, inside TLS 1.2 with a
 * pre-shared key per paired device. The PSK identity names the device; the
 * `pair` identity, with its public key, is accepted only while a pairing is
 * open. No certificates: mbedTLS on the device and Node here both speak
 * PSK suites natively, and the handshake is light enough for an ESP32-S3
 * without PSRAM.
 */

import { createServer, type TLSSocket } from 'node:tls'
import type { AddressInfo, Socket } from 'node:net'
import { acceptUpgrade, type WsConnection } from './ws.ts'

/** PSK suites with AEAD, in the order mbedTLS on the ESP32 prefers. */
export const CIPHERS = 'PSK-AES128-GCM-SHA256:PSK-CHACHA20-POLY1305'
export const PATH = '/device'

export interface Peer {
  identity: string
  address: string
  ws: WsConnection
}

export interface LinkOptions {
  port: number
  /** Bind address; all interfaces unless given (tests bind loopback). */
  host?: string
  /** The key of a PSK identity, or null to refuse it. */
  keyOf(identity: string): Buffer | null
  onPeer(peer: Peer): void
  log(message: string): void
}

export interface Link {
  port: number
  close(): Promise<void>
}

export function startLink(options: LinkOptions): Promise<Link> {
  const identities = new WeakMap<TLSSocket, string>()
  const sockets = new Set<Socket>()
  let closing = false
  let closePromise: Promise<void> | undefined
  const server = createServer({
    handshakeTimeout: 5000,
    ciphers: CIPHERS,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    pskIdentityHint: 'dsh',
    pskCallback(socket, identity) {
      const key = options.keyOf(identity)
      if (key !== null) identities.set(socket, identity)
      return key
    },
  }, (socket) => {
    if (closing) return void socket.destroy()
    socket.setKeepAlive(true, 10_000)
    socket.setNoDelay(true)
    const identity = identities.get(socket)
    if (identity === undefined) return void socket.destroy()
    acceptUpgrade(socket, PATH).then(
      (ws) => {
        if (closing || !ws.open) return void ws.close()
        options.onPeer({ identity, address: socket.remoteAddress ?? '', ws })
      },
      () => {},
    )
  })
  server.maxConnections = 32
  // Track raw TCP sockets before TLS starts, including peers that never send ClientHello.
  server.on('connection', (socket) => {
    if (closing) return void socket.destroy()
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  // Failed TLS handshakes must release the transport as well.
  server.on('tlsClientError', (_error, socket) => socket.destroy())
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      server.on('error', (error) => options.log(`device link: ${error.message}`))
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => {
          if (closePromise) return closePromise
          closing = true
          closePromise = new Promise((done) => {
            server.close(() => done())
            for (const socket of sockets) socket.destroy()
          })
          return closePromise
        },
      })
    })
  })
}
