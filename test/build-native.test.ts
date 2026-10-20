import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { signingIdentity, installNative } = await import(new URL('../scripts/build-native.mjs', import.meta.url).href)
const development = 'A'.repeat(40)
const distribution = 'B'.repeat(40)
const identities = `1) ${distribution} "Developer ID Application: Example (TEAM)"\n2) ${development} "Apple Development: Example (TEAM)"`

test('native signing retains the installed identity rather than changing certificate preference', () => {
  assert.equal(signingIdentity('Authority=Apple Development: Example (TEAM)', identities), development)
  assert.equal(signingIdentity('', identities), distribution)
  assert.throws(() => signingIdentity('Authority=Apple Development: Removed (TEAM)', identities), /Installed helper unchanged/)
  assert.equal(signingIdentity('Authority=Apple Development: Removed (TEAM)', identities, distribution), distribution)
  assert.equal(signingIdentity('', ''), '-')
})

test('native installation leaves the old helper in place until signing and verification succeed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-install-'))
  try {
    const source = join(directory, 'cargo-output')
    const installed = join(directory, 'dsh-type')
    await writeFile(source, 'new helper')
    await writeFile(installed, 'working helper')
    await assert.rejects(installNative(source, directory, 'darwin-arm64', async (staged: string, current: string) => {
      assert.equal(await readFile(staged, 'utf8'), 'new helper')
      assert.equal(await readFile(current, 'utf8'), 'working helper')
      throw new Error('signature verification failed')
    }), /signature verification failed/)
    assert.equal(await readFile(installed, 'utf8'), 'working helper')
    assert.deepEqual((await readdir(directory)).sort(), ['cargo-output', 'dsh-type'])
    await installNative(source, directory, 'darwin-arm64', async (staged: string, current: string) => {
      assert.equal(await readFile(current, 'utf8'), 'working helper')
      await writeFile(staged, 'signed helper')
    })
    assert.equal(await readFile(installed, 'utf8'), 'signed helper')
    assert.deepEqual((await readdir(directory)).sort(), ['cargo-output', 'dsh-type'])
  } finally {
    // directory is the exact temporary directory allocated by this test.
    await rm(directory, { recursive: true, force: true })
  }
})
