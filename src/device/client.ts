/**
 * The device's side of the link, as the Cardputer firmware runs it: connect
 * with a PSK identity, upgrade to the WebSocket, and pair. Used by the
 * simulator (scripts/device-sim.ts) and the tests; the plugin never loads it.
 */

import { connect as tlsConnect } from 'node:tls'
import { CIPHERS, PATH } from './link.ts'
import { DevicePairing, PAIR_IDENTITY, PAIR_KEY } from './pairing.ts'
import type { DeviceFrame, HostFrame } from './types.ts'
import { requestUpgrade, type WsConnection } from './ws.ts'

export function connect(host: string, port: number, identity: string, key: Buffer): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      ciphers: CIPHERS,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ identity, psk: key }),
    }, () => {
      clearTimeout(timer)
      socket.off('error', failed)
      socket.off('close', closed)
      requestUpgrade(socket, `${host}:${port}`, PATH).then(resolve, reject)
    })
    const failed = (error: Error): void => {
      clearTimeout(timer)
      socket.off('error', failed)
      socket.off('close', closed)
      socket.destroy()
      reject(error)
    }
    const closed = (): void => failed(new Error('TLS connection closed'))
    const timer = setTimeout(() => failed(new Error('TLS connection timed out')), 5000)
    socket.once('error', failed)
    socket.once('close', closed)
  })
}

export const sendFrame = (ws: WsConnection, frame: DeviceFrame): void => ws.send(JSON.stringify(frame))

/** The next host frame matching `t`, skipping others. */
export function nextFrame<T extends HostFrame['t']>(ws: WsConnection, t: T, timeoutMs = 5000): Promise<Extract<HostFrame, { t: T }>> {
  return new Promise((resolve, reject) => {
    const clean = (): void => {
      clearTimeout(timer)
      ws.off('text', onText)
      ws.off('close', closed)
    }
    const failed = (error: Error): void => { clean(); reject(error) }
    const closed = (): void => failed(new Error(`connection closed before ${t}`))
    const timer = setTimeout(() => failed(new Error(`no ${t} frame`)), timeoutMs)
    const onText = (text: string): void => {
      let frame: HostFrame
      try { frame = JSON.parse(text) as HostFrame } catch { return failed(new Error('invalid host frame')) }
      if (frame === null || typeof frame !== 'object') return failed(new Error('invalid host frame'))
      if (frame.t === 'pair-fail' && t !== 'pair-fail') return failed(new Error(`pairing failed: ${frame.reason}`))
      if (frame.t !== t) return
      clean()
      resolve(frame as Extract<HostFrame, { t: T }>)
    }
    if (!ws.open) return closed()
    ws.on('text', onText)
    ws.once('close', closed)
  })
}

export interface Paired {
  id: string
  psk: Buffer
  host: string
  hostId: string
}

/**
 * Pair with a host: `compare(code)` shows the number and resolves once the
 * person confirms it on the device; the host's confirmation comes separately.
 */
export async function pair(host: string, port: number, name: string, compare: (code: string, hostName: string) => Promise<boolean>): Promise<Paired> {
  const ws = await connect(host, port, PAIR_IDENTITY, PAIR_KEY)
  try {
    const exchange = new DevicePairing()
    sendFrame(ws, exchange.hello(name))
    const commit = await nextFrame(ws, 'pair-commit')
    sendFrame(ws, exchange.committed(commit.pk, commit.c))
    const reveal = await nextFrame(ws, 'pair-reveal')
    const code = exchange.revealed(reveal.n)
    const paired = nextFrame(ws, 'paired', 130_000)
    paired.catch(() => {})
    if (!await compare(code, commit.host)) {
      ws.close()
      throw new Error('the numbers did not match')
    }
    sendFrame(ws, { t: 'pair-ok' })
    const { id } = await paired
    return { id, psk: exchange.psk!, host: commit.host, hostId: commit.hostId }
  } finally {
    ws.close()
  }
}
