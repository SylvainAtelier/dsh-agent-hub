import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneSettings, type SettingsOp, type SettingsService } from '../src/remote/settings.ts'
import { PhoneScope } from '../src/client/config/phone.ts'
import type { Rpc } from '../src/client/rpc.ts'

function fakeSettings(): SettingsService & { writes: Array<{ ops: SettingsOp[]; revision?: number }>; revision: number; conflict: boolean } {
  const user: Record<string, Record<string, unknown>> = { sync: { remote: 'https://token@git.example/settings.git' }, claude: { keepOnline: 3 } }
  const service = {
    writable: true,
    revision: 4,
    conflict: false,
    writes: [] as Array<{ ops: SettingsOp[]; revision?: number }>,
    describe: () => [
      { ns: 'other-plugin', value: { secret: { token: 'x' } }, revision: 1 },
      {
        ns: 'agent-hub',
        revision: service.revision,
        value: { claude: { fullAccess: false, keepOnline: 3 }, prompt: { blockedCommands: [] }, sync: { remote: 'https://token@git.example/settings.git' }, connectors: { servers: [{ id: 'x', url: 'https://mcp.example/?key=secret' }] }, remote: { phoneSettings: true } },
        base: { claude: { keepOnline: 3 }, sync: { remote: '' } },
        user,
      },
    ],
    async mutate(_ns: string, ops: SettingsOp[], revision?: number) {
      if (service.conflict) throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT', expected: revision, actual: service.revision })
      service.writes.push({ ops, ...(revision === undefined ? {} : { revision }) })
      service.revision++
    },
  }
  return service
}

test('phone settings: closed until the computer switches it on', async () => {
  const settings = fakeSettings()
  let enabled = false
  const handle = createPhoneSettings({ enabled: () => enabled, settings: () => settings })
  assert.deepEqual(await handle({ op: 'read' }), { view: { enabled: false } })
  assert.deepEqual(await handle({ op: 'mutate', ops: [{ op: 'set', path: ['claude', 'keepOnline'], value: 5 }], revision: 4 }), { view: { enabled: false }, landed: false })
  assert.equal(settings.writes.length, 0)
  enabled = true
  const { view } = await handle({ op: 'read' })
  assert.equal(view.enabled, true)
})

test('phone settings: credential-bearing sections never reach the phone', async () => {
  const handle = createPhoneSettings({ enabled: () => true, settings: fakeSettings })
  const { view } = await handle({ op: 'read' })
  assert.ok(view.enabled)
  for (const doc of [view.value, view.base, view.user]) {
    assert.equal(Object.hasOwn(doc, 'sync'), false)
    assert.equal(Object.hasOwn(doc, 'connectors'), false)
    assert.equal(Object.hasOwn(doc, 'remote'), false)
  }
  assert.doesNotMatch(JSON.stringify(view), /token|secret/)
  assert.deepEqual(view.value.claude, { fullAccess: false, keepOnline: 3 })
})

test('phone settings: only field edits the phone may make are written, always fenced', async () => {
  const settings = fakeSettings()
  const handle = createPhoneSettings({ enabled: () => true, settings: () => settings })
  const refused = [
    [{ op: 'set', path: ['sync', 'remote'], value: 'x' }],
    [{ op: 'set', path: ['remote', 'phoneSettings'], value: false }],
    [{ op: 'set', path: ['claude', 'fullAccess'], value: true }],
    [{ op: 'unset', path: ['prompt', 'blockedCommands'] }],
    [{ op: 'set', path: ['claude'], value: {} }],
    [{ op: 'set', path: ['claude', '__proto__'], value: {} }],
    [{ op: 'set', path: ['nowhere', 'key'], value: 1 }],
    [{ op: 'set', path: ['claude', 'keepOnline'] }],
    [{ op: 'set', path: ['claude', 'keepOnline'], value: 5 }, { op: 'set', path: ['claude', 'fullAccess'], value: true }],
    [],
  ] as unknown as SettingsOp[][]
  for (const ops of refused) await assert.rejects(handle({ op: 'mutate', ops, revision: 4 }), /computer/)
  await assert.rejects(handle({ op: 'mutate', ops: [{ op: 'set', path: ['claude', 'keepOnline'], value: 5 }] } as never), /revision/)
  assert.equal(settings.writes.length, 0)

  const reply = await handle({ op: 'mutate', ops: [{ op: 'set', path: ['claude', 'keepOnline'], value: 5 }], revision: 4 })
  assert.equal(reply.landed, true)
  assert.deepEqual(settings.writes, [{ ops: [{ op: 'set', path: ['claude', 'keepOnline'], value: 5 }], revision: 4 }])
  assert.ok(reply.view.enabled && reply.view.revision === 5)

  settings.conflict = true
  const stale = await handle({ op: 'mutate', ops: [{ op: 'set', path: ['claude', 'keepOnline'], value: 6 }], revision: 4 })
  assert.equal(stale.landed, false)
  assert.ok(stale.view.enabled && stale.view.revision === 5)
})

/** An Rpc whose answers are released by hand, in any order. */
function manualRpc(): Rpc & { pending: Array<{ payload: { op: string }; answer(value: unknown): void }> } {
  const pending: Array<{ payload: { op: string }; answer(value: unknown): void }> = []
  return {
    pending,
    call: (_channel, _method, payload) => new Promise((resolve) => {
      pending.push({ payload: payload as { op: string }, answer: (value) => resolve({ ok: true, value }) })
    }),
  }
}

const open = (revision: number, keepOnline: number) => ({ view: { enabled: true, writable: true, revision, value: { claude: { keepOnline } }, base: {}, user: {} } })

test('phone scope: locked, then open; a read older than a write never wins', async () => {
  const rpc = manualRpc()
  const scope = new PhoneScope(rpc)
  assert.equal(scope.getSnapshot().status, 'loading')
  const first = scope.refresh()
  rpc.pending.shift()!.answer({ view: { enabled: false } })
  await first
  assert.deepEqual(scope.getSnapshot(), { status: 'unavailable', writable: false, phone: 'locked' })

  const read = scope.refresh()
  const write = scope.mutate([{ op: 'set', path: ['claude', 'keepOnline'], value: 7 }], 1)
  const [readCall, writeCall] = rpc.pending.splice(0)
  assert.equal(readCall!.payload.op, 'read')
  assert.equal(writeCall!.payload.op, 'mutate')
  writeCall!.answer({ ...open(2, 7), landed: true })
  assert.equal(await write, true)
  readCall!.answer(open(1, 3))
  await read
  const snapshot = scope.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.revision, 2)
  assert.deepEqual(snapshot.value, { claude: { keepOnline: 7 } })
})

test('phone scope: no read is sent beside a write, whose answer is the stored entry', async () => {
  const rpc = manualRpc()
  const scope = new PhoneScope(rpc)
  const write = scope.mutate([{ op: 'set', path: ['claude', 'keepOnline'], value: 7 }], 1)
  const read = scope.refresh()
  assert.equal(rpc.pending.length, 1)
  rpc.pending.shift()!.answer({ ...open(2, 7), landed: true })
  await Promise.all([write, read])
  assert.equal(scope.getSnapshot().revision, 2)
})

test('phone scope: one read at a time, and a fresh one is reused', async () => {
  const rpc = manualRpc()
  const scope = new PhoneScope(rpc)
  const a = scope.refresh()
  const b = scope.refresh()
  assert.equal(a, b)
  assert.equal(rpc.pending.length, 1)
  rpc.pending.shift()!.answer(open(1, 3))
  await a
  await scope.refresh(5_000)
  assert.equal(rpc.pending.length, 0)
})
