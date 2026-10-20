/** A bounded RFC 6455 transport for the device link; no extensions or fragmented sends. */
import { createHash, randomBytes } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 256 * 1024
const MAX_FRAGMENTS = 1024
const MAX_PENDING = 1024 * 1024
const MAX_HEADER = 8192
const MAX_FRAME = MAX_MESSAGE + 14

export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64')

export interface WsEvents {
  text: [string]
  binary: [Buffer]
  close: []
}

export class WsConnection extends EventEmitter<WsEvents> {
  private buffer: Buffer = Buffer.alloc(0)
  private used = 0
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private fragmentCount = 0
  private fragmentOp = 0
  private closed = false
  private closeTimer?: ReturnType<typeof setTimeout>
  readonly socket: Duplex
  private readonly masked: boolean
  private readonly onData = (chunk: Buffer): void => this.receive(chunk)
  private readonly onEnd = (): void => this.fail()
  private readonly onClose = (): void => {
    clearTimeout(this.closeTimer)
    this.socket.off('error', this.onError)
    this.finish()
  }
  private readonly onError = (): void => this.fail()

  constructor(socket: Duplex, masked: boolean, head?: Buffer) {
    super()
    this.socket = socket
    this.masked = masked
    socket.on('data', this.onData)
    socket.on('end', this.onEnd)
    socket.on('close', this.onClose)
    socket.on('error', this.onError)
    if (head !== undefined && head.length > 0) {
      // Let the upgrade promise's consumer attach listeners before delivering head.
      socket.pause()
      setImmediate(() => {
        this.receive(head)
        if (!this.closed) socket.resume()
      })
    }
  }

  get open(): boolean { return !this.closed }

  send(message: string | Buffer): void {
    if (this.closed) return
    const text = typeof message === 'string'
    // Check strings before allocating their encoded representation.
    if ((text ? Buffer.byteLength(message) : message.length) > MAX_MESSAGE) return this.fail()
    this.frame(text ? 0x1 : 0x2, text ? Buffer.from(message) : message)
  }

  close(): void { this.closeWith(Buffer.alloc(0)) }

  private closeWith(payload: Buffer): void {
    if (this.closed) return
    this.frame(0x8, payload)
    if (this.closed) return
    // A peer that stops reading must not retain a half-closed socket forever.
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1000)
    this.closeTimer.unref()
    this.socket.end(() => this.socket.destroy())
    this.finish()
  }

  private frame(op: number, payload: Buffer): void {
    const length = payload.length
    const size = length < 126 ? 0 : length < 65536 ? 2 : 8
    const total = 2 + size + (this.masked ? 4 : 0) + length
    // Disconnect slow consumers instead of queuing unbounded audio/snapshots.
    if (this.socket.destroyed || !this.socket.writable || this.socket.writableLength + total > MAX_PENDING) return this.fail()
    const frame = Buffer.allocUnsafe(total)
    frame[0] = 0x80 | op
    frame[1] = (this.masked ? 0x80 : 0) | (size === 0 ? length : size === 2 ? 126 : 127)
    if (size === 2) frame.writeUInt16BE(length, 2)
    if (size === 8) frame.writeBigUInt64BE(BigInt(length), 2)
    const at = 2 + size
    if (this.masked) {
      const mask = randomBytes(4)
      mask.copy(frame, at)
      for (let i = 0; i < length; i++) frame[at + 4 + i] = payload[i]! ^ mask[i & 3]!
    } else payload.copy(frame, at)
    this.socket.write(frame)
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    let offset = 0
    while (offset < chunk.length && !this.closed) {
      const take = Math.min(chunk.length - offset, MAX_FRAME - this.used)
      if (take === 0) return this.fail()
      const needed = this.used + take
      if (needed > this.buffer.length) {
        const next = Buffer.allocUnsafe(Math.min(MAX_FRAME, Math.max(needed, this.buffer.length * 2, 1024)))
        this.buffer.copy(next, 0, 0, this.used)
        this.buffer = next
      }
      chunk.copy(this.buffer, this.used, offset, offset + take)
      this.used += take
      offset += take
      this.parse()
    }
  }

  private parse(): void {
    let consumed = 0
    while (!this.closed && this.used - consumed >= 2) {
      const first = this.buffer[consumed]!
      const second = this.buffer[consumed + 1]!
      const op = first & 0x0f
      const fin = (first & 0x80) !== 0
      const control = op >= 8
      const hasMask = (second & 0x80) !== 0
      let length = second & 0x7f
      let at = consumed + 2
      if ((first & 0x70) !== 0 || hasMask === this.masked || ![0, 1, 2, 8, 9, 10].includes(op)
        || (control && (!fin || length > 125))) return this.fail()
      if (length === 126) {
        if (this.used - at < 2) break
        length = this.buffer.readUInt16BE(at)
        at += 2
        if (length < 126) return this.fail()
      } else if (length === 127) {
        if (this.used - at < 8) break
        const big = this.buffer.readBigUInt64BE(at)
        if (big < 65536n || big > BigInt(MAX_MESSAGE)) return this.fail()
        length = Number(big)
        at += 8
      }
      if (length > MAX_MESSAGE || (!control && this.fragmentBytes + length > MAX_MESSAGE)) return this.fail()
      const end = at + (hasMask ? 4 : 0) + length
      if (this.used < end) break
      const payload = Buffer.from(this.buffer.subarray(end - length, end))
      if (hasMask) for (let i = 0; i < payload.length; i++) payload[i]! ^= this.buffer[at + (i & 3)]!
      consumed = end
      this.handle(op, fin, payload)
    }
    if (!this.closed && consumed > 0) {
      this.buffer.copy(this.buffer, 0, consumed, this.used)
      this.used -= consumed
    }
  }

  private handle(op: number, fin: boolean, payload: Buffer): void {
    if (op === 0x8) {
      if (payload.length === 1) return this.fail()
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0)
        if (!((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))
          || !isUtf8(payload.subarray(2))) return this.fail()
      }
      return this.closeWith(payload)
    }
    if (op === 0x9) return this.frame(0xa, payload)
    if (op === 0xa) return
    if (op === 0 ? this.fragmentOp === 0 : this.fragmentOp !== 0) return this.fail()
    if (op === 0 || !fin) {
      if (++this.fragmentCount > MAX_FRAGMENTS) return this.fail()
      if (op !== 0) this.fragmentOp = op
      this.fragmentBytes += payload.length
      if (payload.length > 0) this.fragments.push(payload)
      if (!fin) return
      const message = Buffer.concat(this.fragments, this.fragmentBytes)
      const messageOp = this.fragmentOp
      this.resetFragments()
      this.deliver(messageOp, message)
      return
    }
    this.deliver(op, payload)
  }

  private deliver(op: number, payload: Buffer): void {
    if (op === 0x1) {
      if (!isUtf8(payload)) return this.fail()
      this.emit('text', payload.toString('utf8'))
    } else this.emit('binary', payload)
  }

  private resetFragments(): void {
    this.fragments = []
    this.fragmentOp = this.fragmentBytes = this.fragmentCount = 0
  }

  private fail(): void {
    this.socket.destroy()
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.socket.off('data', this.onData)
    this.socket.off('end', this.onEnd)
    this.buffer = Buffer.alloc(0)
    this.used = 0
    this.resetFragments()
    this.emit('close')
  }
}

/** Read only the bounded HTTP header; bytes after it belong to the first frame. */
function handshake(socket: Duplex, timeoutMs: number, validate: (text: string) => void, masked: boolean): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => done(new Error('handshake timed out')), timeoutMs)
    const done = (error?: Error, extra?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      head = Buffer.alloc(0)
      if (error) {
        socket.destroy()
        reject(error)
      } else resolve(new WsConnection(socket, masked, extra))
    }
    const onError = (error: Error): void => done(error)
    const onEnd = (): void => done(new Error('connection closed during handshake'))
    const onData = (chunk: Buffer): void => {
      // Copy at most one header plus its terminator, even for a huge first chunk.
      const take = Math.min(chunk.length, MAX_HEADER + 4 - head.length)
      head = Buffer.concat([head, chunk.subarray(0, take)])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) {
        if (head.length >= MAX_HEADER + 4) done(new Error('handshake too large'))
        return
      }
      if (end + 4 > MAX_HEADER) return done(new Error('handshake too large'))
      try {
        validate(head.subarray(0, end).toString('latin1'))
        done(undefined, Buffer.concat([head.subarray(end + 4), chunk.subarray(take)]))
      } catch (error) { done(error instanceof Error ? error : new Error(String(error))) }
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    if (socket.destroyed || socket.readableEnded) onEnd()
  })
}

function headers(text: string): { line: string; fields: Map<string, string> } {
  const [line = '', ...rows] = text.split('\r\n')
  const fields = new Map<string, string>()
  for (const row of rows) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(row)
    if (!match) throw new Error('malformed upgrade header')
    const name = match[1]!.toLowerCase()
    const value = match[2]!.trim()
    if (fields.has(name)) {
      if (name !== 'connection' && name !== 'upgrade') throw new Error('duplicate upgrade header')
      fields.set(name, `${fields.get(name)},${value}`)
    } else fields.set(name, value)
  }
  return { line, fields }
}

const token = (value: string | undefined, expected: string): boolean => value?.split(',').some((part) => part.trim().toLowerCase() === expected) ?? false

export function acceptUpgrade(socket: Duplex, path: string, timeoutMs = 5000): Promise<WsConnection> {
  return handshake(socket, timeoutMs, (text) => {
    const { line, fields } = headers(text)
    const match = /^GET ([^ ]+) HTTP\/1\.1$/.exec(line)
    const key = fields.get('sec-websocket-key')
    if (!match || match[1]!.split('?')[0] !== path || !fields.get('host')
      || !token(fields.get('upgrade'), 'websocket') || !token(fields.get('connection'), 'upgrade')
      || fields.get('sec-websocket-version') !== '13' || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key)
      || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('not a WebSocket upgrade')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(key)}\r\n\r\n`)
  }, false)
}

export function requestUpgrade(socket: Duplex, host: string, path: string, timeoutMs = 5000): Promise<WsConnection> {
  if (/[\r\n]/.test(host) || /[\s\x00-\x1f\x7f]/.test(path)) {
    socket.destroy()
    return Promise.reject(new Error('invalid upgrade target'))
  }
  const key = randomBytes(16).toString('base64')
  const result = handshake(socket, timeoutMs, (text) => {
    const { line, fields } = headers(text)
    if (!/^HTTP\/1\.1 101(?: [\x20-\x7e]*)?$/.test(line)
      || !token(fields.get('upgrade'), 'websocket') || !token(fields.get('connection'), 'upgrade')
      || fields.get('sec-websocket-accept') !== acceptKey(key)
      || fields.has('sec-websocket-extensions') || fields.has('sec-websocket-protocol')) throw new Error(`upgrade refused: ${line}`)
  }, true)
  if (!socket.destroyed) socket.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: ${key}\r\nsec-websocket-version: 13\r\n\r\n`)
  return result
}
