import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceStatus } from '../src/device/types.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
let pauseWrite = false
let gate = deferred()
let started = deferred()
mock.module('node:fs/promises', { namedExports: {
  ...fs,
  async writeFile(...args: Parameters<typeof fs.writeFile>) {
    if (pauseWrite && String(args[0]).endsWith('devices.json.tmp')) {
      pauseWrite = false
      started.resolve()
      await gate.promise
    }
    return fs.writeFile(...args)
  },
} })
const { createDevice, Typer } = await import('../src/device/index.ts')
const { pair } = await import('../src/device/client.ts')
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('pairing: cancellation during persistence rolls back keys and closes the unused listener', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'device-pair-lifecycle-'))
  gate = deferred()
  started = deferred()
  const device = createDevice({
    file: join(dir, 'devices.json'),
    settings: () => ({ port: 0, approve: true, stt: 'minimax', hints: false, typing: 'auto' }),
    sessions: () => undefined, sttKey: async () => ({}), setSttKey: async () => {},
    typer: new Typer(undefined, () => {}), log: () => {}, bindHost: '127.0.0.1', mdns: false,
  })
  try {
    const listening = await device.handle({ op: 'pair' }) as DeviceStatus
    assert.equal(listening.link.state, 'listening')
    if (listening.link.state !== 'listening') throw new Error('not listening')
    const pairing = pair('127.0.0.1', listening.link.port, 'fixture', async () => {
      await device.handle({ op: 'pair-confirm' })
      pauseWrite = true
      return true
    })
    const rejected = assert.rejects(pairing, /cancelled|connection closed/)
    await started.promise
    const cancel = device.handle({ op: 'pair-cancel' })
    // Let endPairing's first ensureLink observe the temporary, not-yet-durable record.
    await tick(); await tick()
    gate.resolve()
    await cancel
    await rejected
    await tick()
    const status = await device.handle({ op: 'status' }) as DeviceStatus
    assert.equal(status.devices.length, 0)
    assert.deepEqual(status.link, { state: 'off' })
    await device.dispose()
    const saved = JSON.parse(await fs.readFile(join(dir, 'devices.json'), 'utf8')) as { devices: unknown[] }
    assert.deepEqual(saved.devices, [])
  } finally {
    pauseWrite = false
    gate.resolve()
    await device.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
