/**
 * A DNS-SD announcement of the device link on the local network, so the
 * Cardputer lists this computer without anyone typing an address:
 * `<name>._dsh._tcp.local` → SRV (port) + TXT (`id=<hostId>`, `v=1`) + A.
 * Just a responder for our own records: it answers queries for them and
 * announces them when started; it browses nothing.
 */

import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

export const SERVICE = '_dsh._tcp.local'
const GROUP = '224.0.0.251'
const PORT = 5353
const TTL = 120

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const

export interface Announcement {
  /** Shown on the device's host list: this computer's name. */
  name: string
  hostId: string
  port: number
}

/** IPv4 addresses on the local network, the ones a device can reach. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry!.address)
}

/** DNS labels are bytes; keep the instance name readable and within a label. */
const label = (text: string): string => text.replace(/[.\u0000-\u001f]/g, '-').slice(0, 63) || 'DSH'

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean).map((part) => {
    const bytes = Buffer.from(part)
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return Buffer.concat([...parts, Buffer.from([0])])
}

/** Read a possibly compressed name at `at`; returns it lower-cased and the offset after it. */
export function readName(packet: Buffer, at: number): [string, number] {
  const labels: string[] = []
  let offset = at
  let end = -1
  for (let jumps = 0; jumps < 16; jumps++) {
    const length = packet[offset]
    if (length === undefined) throw new Error('truncated name')
    if (length === 0) {
      return [labels.join('.').toLowerCase(), end < 0 ? offset + 1 : end]
    }
    if ((length & 0xc0) === 0xc0) {
      if (end < 0) end = offset + 2
      offset = ((length & 0x3f) << 8) | packet[offset + 1]!
      continue
    }
    labels.push(packet.subarray(offset + 1, offset + 1 + length).toString())
    offset += 1 + length
  }
  throw new Error('name loop')
}

/** The questions of a query packet; answers and responses are ignored. */
export function parseQuestions(packet: Buffer): Array<{ name: string; type: number }> {
  if (packet.length < 12 || (packet.readUInt16BE(2) & 0x8000) !== 0) return []
  const count = packet.readUInt16BE(4)
  const questions: Array<{ name: string; type: number }> = []
  let at = 12
  for (let i = 0; i < count; i++) {
    const [name, next] = readName(packet, at)
    if (next + 4 > packet.length) break
    questions.push({ name, type: packet.readUInt16BE(next) })
    at = next + 4
  }
  return questions
}

function record(name: string, type: number, flush: boolean, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2)
  head.writeUInt32BE(TTL, 4)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([encodeName(name), head, data])
}

/** Names of our records; queries are matched case-insensitively. */
export function names(announcement: Announcement): { instance: string; target: string } {
  return { instance: `${label(announcement.name)}.${SERVICE}`, target: `dsh-${announcement.hostId}.local` }
}

export function response(announcement: Announcement, addresses: readonly string[], id = 0): Buffer {
  const { instance, target } = names(announcement)
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(announcement.port, 4)
  const txt = Buffer.concat([`id=${announcement.hostId}`, 'v=1'].map((entry) => Buffer.concat([Buffer.from([Buffer.byteLength(entry)]), Buffer.from(entry)])))
  const answers = [
    record(SERVICE, TYPE.PTR, false, encodeName(instance)),
    record(instance, TYPE.SRV, true, Buffer.concat([srv, encodeName(target)])),
    record(instance, TYPE.TXT, true, txt),
    ...addresses.map((address) => record(target, TYPE.A, true, Buffer.from(address.split('.').map(Number)))),
  ]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(answers.length, 6)
  return Buffer.concat([header, ...answers])
}

/** Whether a query asks for any of our records. */
export function asksForUs(questions: ReadonlyArray<{ name: string; type: number }>, announcement: Announcement): boolean {
  const { instance, target } = names(announcement)
  return questions.some(({ name, type }) =>
    (name === SERVICE && (type === TYPE.PTR || type === TYPE.ANY))
    || (name === instance.toLowerCase() && (type === TYPE.SRV || type === TYPE.TXT || type === TYPE.ANY))
    || (name === target.toLowerCase() && (type === TYPE.A || type === TYPE.ANY)))
}

export interface Responder {
  close(): void
}

/** Start answering; a failure (port 5353 unavailable) is reported, and the link works without discovery. */
export function startResponder(announcement: Announcement, log: (message: string) => void): Responder {
  let socket: Socket | undefined = createSocket({ type: 'udp4', reuseAddr: true })
  const send = (packet: Buffer, port = PORT, host = GROUP): void => {
    socket?.send(packet, port, host, () => {})
  }
  const announce = (): void => send(response(announcement, lanAddresses()))
  socket.on('error', (error) => {
    log(`mDNS unavailable, devices need this computer's address: ${error.message}`)
    socket?.close()
    socket = undefined
  })
  socket.on('message', (packet, from) => {
    let questions
    try {
      questions = parseQuestions(packet)
    } catch {
      return
    }
    if (!asksForUs(questions, announcement)) return
    // A one-shot query (from a port other than 5353) wants a unicast answer carrying its id.
    if (from.port !== PORT) send(response(announcement, lanAddresses(), packet.readUInt16BE(0)), from.port, from.address)
    else announce()
  })
  const timers: NodeJS.Timeout[] = []
  socket.bind(PORT, () => {
    for (const address of lanAddresses()) {
      try {
        socket?.addMembership(GROUP, address)
      } catch {
        // An interface without multicast.
      }
    }
    socket?.setMulticastTTL(255)
    announce()
    timers.push(setTimeout(announce, 1000))
  })
  return {
    close() {
      for (const timer of timers) clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // Already closed.
      }
      socket = undefined
    },
  }
}
