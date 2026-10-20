import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Archify } from '../src/archify.ts'

const ZIP = Buffer.from('archify zip bytes')
const release = { version: '3.2.0', url: 'https://example.test/archify.zip', sha256: createHash('sha256').update(ZIP).digest('hex') }

/** Stands in for unzip: the archive's `archify/` folder, claiming `version`. */
const unpack = (version = '3.2.0') => async (_zip: string, into: string): Promise<void> => {
  await mkdir(join(into, 'archify', 'bin'), { recursive: true })
  await writeFile(join(into, 'archify', 'SKILL.md'), '---\nname: archify\n---\n')
  await writeFile(join(into, 'archify', 'skill-release.json'), JSON.stringify({ version }))
}

function serving(body: Buffer, status = 200): typeof fetch & { calls: number } {
  const fake = (async () => {
    fake.calls++
    return new Response(new Uint8Array(body), { status })
  }) as unknown as typeof fetch & { calls: number }
  fake.calls = 0
  return fake
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'archify-'))
}

test('archify: installs the pinned release once, leaving only its folder', async () => {
  const dir = await root()
  await mkdir(join(dir, '3.1.0'), { recursive: true })
  const fetch = serving(ZIP)
  const archify = new Archify(dir, { fetch, extract: unpack(), probe: async () => [], release })
  assert.equal(archify.dir, undefined)
  const install = archify.ensure()
  assert.equal(archify.status(true).phase, 'installing')
  await Promise.all([install, archify.ensure()])
  assert.equal(fetch.calls, 1)
  assert.equal(archify.dir, join(dir, '3.2.0'))
  assert.ok(existsSync(join(dir, '3.2.0', 'SKILL.md')))
  assert.deepEqual(await readdir(dir), ['3.2.0'])
  assert.deepEqual(archify.status(true), { phase: 'ready', version: '3.2.0' })
  assert.deepEqual(archify.status(false), { phase: 'off', version: '3.2.0' })

  // A restarted host finds it installed and downloads nothing.
  const again = new Archify(dir, { fetch, extract: unpack(), probe: async () => ['browser'], release })
  assert.equal(again.dir, join(dir, '3.2.0'))
  await again.ensure()
  assert.equal(fetch.calls, 1)
  assert.deepEqual(again.status(true), { phase: 'ready', version: '3.2.0', missing: ['browser'] })
  await rm(dir, { recursive: true, force: true })
})

test('archify: a download that fails its checksum installs nothing, and a retry downloads again', async () => {
  const dir = await root()
  const archify = new Archify(dir, { fetch: serving(Buffer.from('tampered')), extract: unpack(), probe: async () => [], release })
  await archify.ensure()
  assert.equal(archify.dir, undefined)
  const status = archify.status(true)
  assert.equal(status.phase, 'failed')
  assert.match(status.error ?? '', /checksum mismatch/)
  assert.deepEqual(await readdir(dir), [])

  const retry = new Archify(dir, { fetch: serving(ZIP), extract: unpack(), probe: async () => [], release })
  await retry.ensure()
  assert.equal(retry.status(true).phase, 'ready')
  await rm(dir, { recursive: true, force: true })
})

test('archify: an HTTP error or another version in the archive fails the install', async () => {
  const dir = await root()
  const offline = new Archify(dir, { fetch: serving(ZIP, 404), extract: unpack(), probe: async () => [], release })
  await offline.ensure()
  assert.match(offline.status(true).error ?? '', /HTTP 404/)
  const other = new Archify(dir, { fetch: serving(ZIP), extract: unpack('3.1.0'), probe: async () => [], release })
  await other.ensure()
  assert.match(other.status(true).error ?? '', /holds Archify 3\.1\.0/)
  assert.equal(other.dir, undefined)
  assert.deepEqual(await readdir(dir), [])
  await rm(dir, { recursive: true, force: true })
})
