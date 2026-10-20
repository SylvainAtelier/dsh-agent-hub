/**
 * Pairing by numeric comparison, the scheme of Bluetooth LE Secure
 * Connections: X25519 keys, a commitment to the host's nonce sent before the
 * device's nonce is seen, and a six-digit number both sides derive from the
 * exchange. When the person sees the same number on both screens, no one in
 * between swapped keys (a man in the middle gets one guess in a million per
 * attempt), and the shared secret becomes the device's TLS pre-shared key.
 *
 *   device → host  pair       { name, pk: PKd }
 *   host → device  pair-commit { pk: PKh, c: HMAC(Nh, PKh‖PKd) }
 *   device → host  pair-nonce { n: Nd }
 *   host → device  pair-reveal { n: Nh }           device checks c
 *   both           code = SHA-256("dsh-code"‖PKd‖PKh‖Nd‖Nh)[0..4] mod 10⁶
 *   both           PSK  = HKDF-SHA256(X25519, salt Nd‖Nh, "dsh-device-psk")
 *
 * All of it runs inside TLS under the well-known `pair` identity, so the
 * device has one connection path; that outer layer protects nothing by itself.
 */

import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto'

/** The PSK identity and key of the pairing channel: public by design. */
export const PAIR_IDENTITY = 'pair'
export const PAIR_KEY = createHash('sha256').update('dsh-device-pair').digest()

export interface KeyPair {
  privateKey: KeyObject
  /** The raw 32-byte public key. */
  publicKey: Buffer
}

export function keyPair(seed?: Buffer): KeyPair {
  if (seed !== undefined) {
    // PKCS#8 wrapping of a raw X25519 private key, for reproducible tests.
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
    return { privateKey, publicKey: rawPublic(createPublicKey(privateKey)) }
  }
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return { privateKey, publicKey: rawPublic(publicKey) }
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url')
}

function publicKeyOf(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('not an X25519 public key')
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export function commitment(nonce: Buffer, hostKey: Buffer, deviceKey: Buffer): Buffer {
  return createHmac('sha256', nonce).update(hostKey).update(deviceKey).digest()
}

export function verifyCommitment(c: Buffer, nonce: Buffer, hostKey: Buffer, deviceKey: Buffer): boolean {
  const expected = commitment(nonce, hostKey, deviceKey)
  return c.length === expected.length && timingSafeEqual(c, expected)
}

/** The number both screens show, zero-padded to six digits. */
export function comparisonCode(deviceKey: Buffer, hostKey: Buffer, deviceNonce: Buffer, hostNonce: Buffer): string {
  const digest = createHash('sha256').update('dsh-code').update(deviceKey).update(hostKey).update(deviceNonce).update(hostNonce).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function derivePsk(own: KeyPair, peerKey: Buffer, deviceNonce: Buffer, hostNonce: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: own.privateKey, publicKey: publicKeyOf(peerKey) })
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([deviceNonce, hostNonce]), 'dsh-device-psk', 32))
}

/** Decode a base64 field of a pairing frame, refusing anything of the wrong length. */
export function bytes(value: unknown, length: number): Buffer {
  const buffer = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0)
  if (buffer.length !== length) throw new Error('malformed pairing frame')
  return buffer
}

/**
 * The host's half of one pairing exchange. Feed it the device's frames in
 * order; it answers with the frames to send back. The PSK exists once the
 * device's nonce is in, but the device is kept only after both people say the
 * numbers match.
 */
export class HostPairing {
  readonly own = keyPair()
  readonly nonce = randomBytes(16)
  deviceKey?: Buffer
  deviceNonce?: Buffer
  name = ''
  code?: string
  psk?: Buffer

  /** `pair`: the device's key arrives; commit to the host nonce. */
  start(name: unknown, pk: unknown): { pk: string; c: string } {
    if (this.deviceKey !== undefined) throw new Error('pairing already started')
    this.deviceKey = bytes(pk, 32)
    this.name = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 32) : 'Cardputer'
    return { pk: this.own.publicKey.toString('base64'), c: commitment(this.nonce, this.own.publicKey, this.deviceKey).toString('base64') }
  }

  /** `pair-nonce`: the device's nonce arrives; reveal ours, and both sides can show the code. */
  reveal(n: unknown): { n: string; code: string } {
    if (this.deviceKey === undefined || this.deviceNonce !== undefined) throw new Error('pairing out of order')
    this.deviceNonce = bytes(n, 16)
    this.code = comparisonCode(this.deviceKey, this.own.publicKey, this.deviceNonce, this.nonce)
    this.psk = derivePsk(this.own, this.deviceKey, this.deviceNonce, this.nonce)
    return { n: this.nonce.toString('base64'), code: this.code }
  }
}

/** The device's half, for the simulator and tests: what the firmware does. */
export class DevicePairing {
  readonly own: KeyPair
  readonly nonce = randomBytes(16)
  hostKey?: Buffer
  commit?: Buffer
  code?: string
  psk?: Buffer

  constructor(seed?: Buffer) {
    this.own = keyPair(seed)
  }

  hello(name: string): { t: 'pair'; name: string; pk: string } {
    return { t: 'pair', name, pk: this.own.publicKey.toString('base64') }
  }

  /** `pair-commit` in: remember it and send our nonce. */
  committed(pk: unknown, c: unknown): { t: 'pair-nonce'; n: string } {
    this.hostKey = bytes(pk, 32)
    this.commit = bytes(c, 32)
    return { t: 'pair-nonce', n: this.nonce.toString('base64') }
  }

  /** `pair-reveal` in: check the commitment, then derive the code and the key. */
  revealed(n: unknown): string {
    if (this.hostKey === undefined || this.commit === undefined) throw new Error('pairing out of order')
    const hostNonce = bytes(n, 16)
    if (!verifyCommitment(this.commit, hostNonce, this.hostKey, this.own.publicKey)) throw new Error('the host broke its commitment')
    this.code = comparisonCode(this.own.publicKey, this.hostKey, this.nonce, hostNonce)
    this.psk = derivePsk(this.own, this.hostKey, this.nonce, hostNonce)
    return this.code
  }
}
