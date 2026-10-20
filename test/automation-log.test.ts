import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog } from '../src/automation/log.ts'

test('run log appends one JSON event per line, strips control characters and rotates by size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'automation-log-'))
  try {
    const file = join(dir, 'nested', 'automation.log')
    const log = createRunLog(file, () => new Date('2026-10-18T02:00:00Z'))
    log({ event: 'run.start', id: 'daily', stderr: 'line-1\nforged {"event":"x"}\r\u0000' })
    log({ event: 'run.end', id: 'daily', status: 'succeeded' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!)
    assert.equal(first.ts, '2026-10-18T02:00:00.000Z'); assert.equal(first.event, 'run.start'); assert.doesNotMatch(first.stderr, /[\r\u0000]/); assert.ok(first.stderr.includes('\n'))
    await writeFile(file, 'x'.repeat(600 * 1024))
    log({ event: 'after-rotation' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal((await readFile(`${file}.1`, 'utf8')).length, 600 * 1024)
    assert.match(await readFile(file, 'utf8'), /after-rotation/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('run log failures are swallowed', async () => {
  const log = createRunLog('\0invalid/path/automation.log')
  assert.doesNotThrow(() => log({ event: 'x' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
})
