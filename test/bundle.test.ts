import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOST } from '../scripts/host.mjs'

// DSH imports the host half as ESM. A bundled CommonJS dependency that requires a Node
// builtin (yaml requires `process` and `buffer`) must still load there.
test('bundle: the host build loads as ESM with its bundled CommonJS dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hub-bundle-'))
  try {
    const outfile = join(dir, 'portable.mjs')
    await build({ ...HOST, entryPoints: ['src/sync/portable.ts'], outfile, logLevel: 'silent' })
    const module = await import(pathToFileURL(outfile).href) as typeof import('../src/sync/portable.ts')
    assert.equal(module.portablePatch('- x: /Users/vi/a\n', { home: '/Users/vi', platform: 'darwin' }), '- x: ~/a\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
