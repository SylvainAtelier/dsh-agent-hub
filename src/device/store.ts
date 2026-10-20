/**
 * Paired devices, kept on this machine only (`~/.dsh/dsh-agent-hub/devices.json`,
 * owner-only): each one's name and pre-shared key, and this host's id, which
 * devices use to tell this computer apart from others announcing themselves.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DeviceRecord {
  /** The PSK identity the device connects with. */
  id: string
  name: string
  /** Base64 of the 32-byte pre-shared key. */
  psk: string
  paired: number
  seen?: number
  fw?: string
}

interface Doc {
  hostId: string
  devices: DeviceRecord[]
}

export class DeviceStore {
  private doc: Doc = { hostId: '', devices: [] }
  readonly ready: Promise<void>
  private writing: Promise<void> = Promise.resolve()

  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.ready = this.load()
    void this.ready.catch(() => {})
  }

  /** Resolves once every change so far is on disk. */
  get settled(): Promise<void> {
    return this.writing
  }

  get hostId(): string {
    return this.doc.hostId
  }

  list(): readonly DeviceRecord[] {
    return this.doc.devices
  }

  get(id: string): DeviceRecord | undefined {
    return this.doc.devices.find((device) => device.id === id)
  }

  /** Keep a newly paired device; a new id every time, so a re-paired device never reuses an old key. */
  add(name: string, psk: Buffer): DeviceRecord {
    if (this.doc.devices.length >= 16) throw new Error('At most 16 devices may be paired')
    if (psk.length !== 32) throw new Error('Invalid device key')
    const record: DeviceRecord = { id: `cp-${randomBytes(6).toString('hex')}`, name, psk: psk.toString('base64'), paired: Date.now() }
    this.doc.devices.push(record)
    void this.save()
    return record
  }

  update(id: string, change: Partial<Pick<DeviceRecord, 'name' | 'seen' | 'fw'>>): void {
    const record = this.get(id)
    if (record === undefined) return
    Object.assign(record, change)
    void this.save()
  }

  remove(id: string): boolean {
    const before = this.doc.devices.length
    this.doc.devices = this.doc.devices.filter((device) => device.id !== id)
    if (this.doc.devices.length === before) return false
    void this.save()
    return true
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Doc>
      const devices = Array.isArray(raw.devices)
        ? raw.devices.filter((device): device is DeviceRecord => typeof device?.id === 'string' && typeof device.psk === 'string' && typeof device.name === 'string')
        : []
      this.doc = { hostId: typeof raw.hostId === 'string' && raw.hostId !== '' ? raw.hostId : '', devices }
    } catch (error) {
      // Never overwrite an unreadable or corrupt file containing existing keys.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.doc.hostId === '') {
      this.doc.hostId = randomBytes(6).toString('hex')
      await this.save()
    }
  }

  /** Writes are serialized and atomic, so a crash never leaves half a key file. */
  private save(): Promise<void> {
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(this.doc, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
      await chmod(this.file, 0o600).catch(() => {})
    })
    // Callers may fire-and-forget metadata updates; settled still exposes write failure.
    void this.writing.catch(() => {})
    return this.writing
  }
}
