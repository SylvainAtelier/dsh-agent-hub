import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../src/exec.ts'
import { cached } from '../src/cached.ts'
import { jsonWriter } from '../src/persistence.ts'
import { within } from '../src/git/service.ts'
import { replyText } from '../src/git/message.ts'

const node = (script: string) => exec(process.execPath, ['-e', script], { timeoutMs: 15_000 })

test('exec: a chatty stderr past its cap is dropped, and the process runs to its end', async () => {
  const result = await node('process.stderr.write("x".repeat(200000)); setTimeout(() => process.stdout.write("done"), 50)')
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'done')
  assert.equal(result.stopped, false)
  assert.equal(result.overflow, true)
  assert.equal(Buffer.byteLength(result.stderr), 64 << 10)
})

test('exec: stdout past its cap stops the process, unless a partial read is asked for', async () => {
  const script = 'process.stdout.write("y".repeat(1000)); setTimeout(() => process.stdout.write("z"), 5000)'
  const begun = Date.now()
  const stopped = await exec(process.execPath, ['-e', script], { maxBytes: 10, timeoutMs: 15_000 })
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.overflow, true)
  assert.equal(stopped.stdout, 'y'.repeat(10))
  assert.ok(Date.now() - begun < 4_000, 'stopped, not waited out')
  const partial = await exec(process.execPath, ['-e', 'process.stdout.write("y".repeat(1000))'], { maxBytes: 10, partial: true, timeoutMs: 15_000 })
  assert.equal(partial.code, 0)
  assert.equal(partial.stopped, false)
  assert.equal(partial.overflow, true)
  assert.equal(partial.stdout, 'y'.repeat(10))
})

test('exec: lines stream, a missing program is reported, the cwd is optional', async () => {
  const lines: string[] = []
  const result = await exec(process.execPath, ['-e', 'console.log("a\\r\\nb"); console.log("c")'], { onLine: (line) => { lines.push(line) } })
  assert.equal(result.code, 0)
  assert.deepEqual(lines, ['a', 'b', 'c'])
  const missing = await exec('definitely-not-a-program-agent-hub', [], {})
  assert.equal(missing.missing, true)
})

test('exec: a timeout ends the process tree and settles', async () => {
  const begun = Date.now()
  const result = await exec(process.execPath, ['-e', 'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" }); setTimeout(() => {}, 60000)'], { timeoutMs: 500 })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - begun < 10_000, 'the descendant does not hold the pipes open')
})

test('cached: waits for the first read, serves stale while one refresh runs, waits when asked for fresh', async () => {
  let clock = 0
  let reads = 0
  let release: (() => void) | undefined
  const value = cached(async () => {
    reads++
    if (reads > 1) await new Promise<void>((resolve) => { release = resolve })
    return reads
  }, 100, () => clock)
  assert.equal(await value.get(), 1)
  assert.equal(await value.get(), 1, 'fresh enough: no read')
  clock = 150
  assert.equal(await value.get(), 1, 'stale is served at once')
  assert.equal(await value.get(), 1, 'one refresh in flight')
  assert.equal(reads, 2)
  release!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(value.peek()?.value, 2)
  const fresh = value.get(true)
  release!()
  assert.equal(await fresh, 3, 'fresh waits for its read')
})

test('cached: a stale value serves at once, its first read runs behind it', async () => {
  let release: (() => void) | undefined
  const value = cached(async () => {
    await new Promise<void>((resolve) => { release = resolve })
    return 'read'
  }, 100, () => 0, 'stale')
  assert.equal(await value.get(), 'stale', 'no wait for the read')
  assert.equal(await value.get(), 'stale', 'one read in flight')
  release!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(value.peek()?.value, 'read')
})

test('cached: a failed read keeps the last value; a read from before invalidate does not count', async () => {
  let fail = false
  let release: (() => void) | undefined
  let n = 0
  const value = cached(async () => {
    n++
    if (fail) throw new Error('down')
    if (n === 2) await new Promise<void>((resolve) => { release = resolve })
    return n
  }, 0)
  assert.equal(await value.get(), 1)
  const old = value.get(true)
  value.invalidate()
  release!()
  assert.equal(await old, 2)
  assert.equal(value.peek(), undefined, 'the read from before invalidate is dropped')
  assert.equal(await value.get(), 3)
  fail = true
  await assert.rejects(value.get(true), /down/)
  assert.equal(value.peek()?.value, 3)
})

test('jsonWriter: writes in order, skips what is already written, survives a failure, writes the value as it was asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-writer-'))
  try {
    const file = join(dir, 'state.json')
    const writes: unknown[] = []
    let failNext = false
    const write = jsonWriter(file, async (path, value) => {
      if (failNext) {
        failNext = false
        throw new Error('disk busy')
      }
      writes.push(value)
      const { atomicWriteJson } = await import('../src/persistence.ts')
      await atomicWriteJson(path, value)
    })
    const state = { n: 1 }
    const first = write(state)
    state.n = 2 // Changed before its turn: the write keeps what was asked.
    await first
    await write({ n: 1 })
    assert.deepEqual(writes, [{ n: 1 }], 'the same value is not written again')
    failNext = true
    await assert.rejects(write({ n: 3 }), /disk busy/)
    await write({ n: 4 })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 4 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('within: the folder itself and below, never a sibling with the same prefix', () => {
  const root = join(tmpdir(), 'ah-within')
  assert.equal(within(root, root), true)
  assert.equal(within(root, join(root, 'a', 'b')), true)
  assert.equal(within(root, `${root}-other`), false)
  assert.equal(within(join(root, 'a'), root), false)
  if (process.platform === 'win32') assert.equal(within(root.toUpperCase(), join(root, 'a')), true)
})

test('replyText: the text as it streams; a failure only without text; the token cap is no failure', async () => {
  async function* chunks(...items: unknown[]) { yield* items as Parameters<typeof replyText>[0] extends AsyncIterable<infer C> ? C[] : never }
  const heard: string[] = []
  assert.equal(await replyText(chunks({ type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }, { type: 'finish', reason: { kind: 'max-tokens' } }), (text) => heard.push(text)), 'ab')
  assert.deepEqual(heard, ['a', 'b'])
  await assert.rejects(replyText(chunks({ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } })), /boom/)
  assert.equal(await replyText(chunks({ type: 'text-delta', text: 'kept' }, { type: 'finish', reason: { kind: 'error' } })), 'kept')
})
