import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevicePairing, HostPairing, commitment, verifyCommitment } from '../src/device/pairing.ts'
import { Sessions } from '../src/device/view.ts'
import { Approvals, risky, type ApprovalRequest, type Outcome } from '../src/device/control.ts'
import { correct, wav } from '../src/device/voice.ts'
import { asksForUs, parseQuestions, readName, response, SERVICE } from '../src/device/mdns.ts'
import { createDevice, type DeviceSettings, type SessionControl } from '../src/device/index.ts'
import { Typer } from '../src/device/type.ts'
import { connect, nextFrame, pair, sendFrame } from '../src/device/client.ts'
import type { DeviceStatus } from '../src/device/types.ts'

test('pairing: both sides derive the same code and key; a broken commitment is caught', () => {
  const host = new HostPairing()
  const device = new DevicePairing()
  const hello = device.hello('Desk')
  const commit = host.start(hello.name, hello.pk)
  const nonce = device.committed(commit.pk, commit.c)
  const reveal = host.reveal(nonce.n)
  const code = device.revealed(reveal.n)
  assert.match(code, /^\d{6}$/)
  assert.equal(code, reveal.code)
  assert.equal(host.name, 'Desk')
  assert.ok(host.psk !== undefined && device.psk !== undefined)
  assert.deepEqual(host.psk, device.psk)

  // A host that commits to one nonce and reveals another is refused.
  const liar = new DevicePairing()
  const honest = new HostPairing()
  const c = honest.start('x', liar.hello('x').pk)
  liar.committed(c.pk, c.c)
  assert.throws(() => liar.revealed(Buffer.alloc(16, 1).toString('base64')), /commitment/)
  const n = Buffer.alloc(16, 2)
  assert.ok(verifyCommitment(commitment(n, Buffer.alloc(32), Buffer.alloc(32, 1)), n, Buffer.alloc(32), Buffer.alloc(32, 1)))
  assert.throws(() => new HostPairing().start('x', 'c2hvcnQ='), /malformed/)
})

test('sessions fold DSH events into device states', () => {
  const names: Record<string, string> = { 'claude-agent': 'Claude' }
  const sessions = new Sessions((id) => names[id])
  const s = { header: { id: 's1', cwd: 'C:\\pro\\api' } }
  const at = (type: string, data: Record<string, unknown> = {}, time = Date.now()) => sessions.observe(s, { type, time, data })
  at('session/title', { title: '修复登录' })
  at('request/context', { provider: 'claude-agent', model: 'opus' })
  at('turn/start', { turn: 1 })
  assert.equal(sessions.rows()[0]?.state, 'RUNNING')
  sessions.stream('s1', { type: 'block-start', blockType: 'reasoning' })
  assert.equal(sessions.rows()[0]?.state, 'THINKING')
  at('tool/call', { name: 'bash' })
  assert.deepEqual([sessions.rows()[0]?.state, sessions.rows()[0]?.tool], ['TOOL', 'bash'])
  at('tool/call', { name: 'ask_user_question' })
  assert.equal(sessions.rows()[0]?.state, 'WAIT_INPUT')
  at('todo/write', { todos: [{ content: 'run the tests', status: 'in_progress' }] })
  at('turn/end', { reason: { kind: 'completed' } })
  const row = sessions.rows()[0]!
  assert.deepEqual({ ...row, since: 0 }, { id: 's1', agent: 'Claude', ws: 'api', state: 'DONE', task: 'run the tests', since: 0, model: 'opus' })
  // Subagent sessions stay off the device.
  sessions.observe({ header: { id: 'sub', origin: 'subagent' } }, { type: 'turn/start' })
  assert.equal(sessions.rows().length, 1)
  // A waiting session sorts first.
  sessions.observe({ header: { id: 's2', cwd: '/w' } }, { type: 'approval/asked', data: { toolName: 'Bash' } })
  assert.equal(sessions.rows()[0]?.id, 's2')
})

test('risky operations are recognized from the tool line', () => {
  assert.equal(risky('Bash', 'Bash: rm -rf build', '/w'), true)
  assert.equal(risky('Bash', 'git push --force origin main', '/w'), true)
  assert.equal(risky('Bash', 'git push origin main', '/w'), false)
  assert.equal(risky('Write', 'Write: /w/src/a.ts', '/w'), false)
  assert.equal(risky('Write', 'Write: /etc/hosts', '/w'), true)
  assert.equal(risky('Edit', 'Edit C:\\Users\\vi\\pro\\x\\a.ts', 'C:\\Users\\vi\\pro\\x'), false)
  assert.equal(risky('Edit', 'Edit C:\\Windows\\x.ini', 'C:\\Users\\vi\\pro\\x'), true)
  assert.equal(risky('Write', 'Write: /w/../etc/hosts', '/w'), true)
  assert.equal(risky('Write', 'Write: ../secret', '/w'), true)
  assert.equal(risky('Write', 'Write: /W/a.ts', '/w'), true)
})

const request = (reason = 'Bash: pnpm test'): ApprovalRequest => ({
  agent: { id: 's1', session: { header: { id: 's1', cwd: '/w' } } },
  toolName: 'Bash',
  reason,
  signal: new AbortController().signal,
})

/** The browser's dialog: answers when told, or `cancelled` once its signal aborts. */
function dialog(req: ApprovalRequest): { next: () => Promise<Outcome>; answer(outcome: Outcome): void; seen?: AbortSignal } {
  let answer: (outcome: Outcome) => void = () => {}
  const state: { next: () => Promise<Outcome>; answer(outcome: Outcome): void; seen?: AbortSignal } = {
    next: () => new Promise<Outcome>((resolve) => {
      state.seen = req.signal
      answer = resolve
      req.signal?.addEventListener('abort', () => resolve('cancelled'))
    }),
    answer: (outcome) => answer(outcome),
  }
  return state
}

test('approvals: the device and the dialog race, the first answer wins', async () => {
  let online = true
  const approvals = new Approvals(() => online)

  // The device answers first: the dialog is dismissed and its "cancelled" ignored.
  const first = request()
  const original = first.signal
  const browser = dialog(first)
  const outcome = approvals.answer(first, browser.next)
  const ask = approvals.list()[0]!
  assert.equal(ask.sid, 's1')
  assert.equal(approvals.decide(ask.id, true), 'ok')
  assert.equal(await outcome, 'allowed-once')
  assert.equal(browser.seen?.aborted, true)
  assert.equal(first.signal, original)
  assert.equal(approvals.list().length, 0)

  // The dialog answers first: the device's ask is withdrawn.
  const second = request()
  const browser2 = dialog(second)
  const outcome2 = approvals.answer(second, browser2.next)
  const id = approvals.list()[0]!.id
  browser2.answer('rejected')
  assert.equal(await outcome2, 'rejected')
  assert.equal(approvals.decide(id, true), 'unknown')

  // A risky ask can only be denied on the device.
  const third = request('Bash: rm -rf /')
  const outcome3 = approvals.answer(third, dialog(third).next)
  const risk = approvals.list()[0]!
  assert.equal(risk.risk, true)
  assert.equal(approvals.decide(risk.id, true), 'refused')
  assert.equal(approvals.decide(risk.id, false), 'ok')
  assert.equal(await outcome3, 'rejected')

  // No device online: straight to the dialog.
  online = false
  const fourth = request()
  const browser4 = dialog(fourth)
  const outcome4 = approvals.answer(fourth, browser4.next)
  assert.equal(approvals.list().length, 0)
  browser4.answer('allowed-once')
  assert.equal(await outcome4, 'allowed-once')
})

test('approvals: with no device online, a session another answerer follows still waits here', async () => {
  const followed = new Approvals((sessionId) => sessionId === 's1')
  const outcome = followed.answer(request(), dialog(request()).next)
  assert.equal(followed.list()[0]?.sid, 's1')
  assert.equal(followed.decide(followed.list()[0]!.id, false), 'ok')
  assert.equal(await outcome, 'rejected')

  const other: ApprovalRequest = { ...request(), agent: { id: 's2', session: { header: { id: 's2', cwd: '/w' } } } }
  const browser = dialog(other)
  const passed = followed.answer(other, browser.next)
  assert.equal(followed.list().length, 0, 'one it does not follow goes straight to the dialog')
  browser.answer('allowed-once')
  assert.equal(await passed, 'allowed-once')
})

test('voice: WAV header and spoken file names', () => {
  const audio = wav(Buffer.alloc(3200))
  assert.equal(audio.length, 44 + 3200)
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF')
  assert.equal(audio.readUInt32LE(24), 16000)
  assert.deepEqual(wav([Buffer.alloc(1600), Buffer.alloc(1600)]), audio)
  const names = new Set(['view.ts', 'readme.md'])
  assert.equal(correct('打开 view 点 ts 看一下', names), '打开 view.ts 看一下')
  assert.equal(correct('看 README dot MD', names), '看 README.md')
  assert.equal(correct('foo 点 ts', names), 'foo 点 ts')
})

test('mdns: answers queries for the service with SRV, TXT and A records', () => {
  const name = Buffer.concat([..._labels(SERVICE)])
  const query = Buffer.concat([Buffer.from([0, 7, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), name, Buffer.from([0, 12, 0, 1])])
  const questions = parseQuestions(query)
  assert.deepEqual(questions, [{ name: SERVICE, type: 12 }])
  const announcement = { name: 'Studio', hostId: 'abc123', port: 7655 }
  assert.equal(asksForUs(questions, announcement), true)
  assert.equal(asksForUs([{ name: '_other._tcp.local', type: 12 }], announcement), false)
  const packet = response(announcement, ['192.168.1.20'], 7)
  assert.equal(packet.readUInt16BE(0), 7)
  assert.equal(packet.readUInt16BE(6), 4)
  assert.equal(readName(packet, 12)[0], SERVICE)
  assert.ok(packet.includes(Buffer.from('id=abc123')))
  assert.ok(packet.includes(Buffer.from([192, 168, 1, 20])))
})

function _labels(name: string): Buffer[] {
  return [...name.split('.').map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])), Buffer.from([0])]
}

test('device: pair, follow sessions, approve and send over TLS-PSK', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'device-'))
  const sent: Array<[string, string]> = []
  let blocked: Promise<void> | undefined
  let stopped = 0
  const control: SessionControl = {
    send: async (sessionId, text) => { sent.push([sessionId, text]); await blocked },
    cancel: async () => { stopped++ },
  }
  const settings: DeviceSettings = { port: 0, approve: true, stt: 'minimax', hints: true, typing: 'auto' }
  const device = createDevice({
    file: join(dir, 'devices.json'),
    settings: () => settings,
    sessions: () => control,
    sttKey: async () => ({}),
    setSttKey: async () => {},
    typer: new Typer(undefined, () => {}),
    log: () => {},
    bindHost: '127.0.0.1',
    mdns: false,
  })
  try {
    let status = await device.handle({ op: 'status' }) as DeviceStatus
    assert.deepEqual(status.link, { state: 'off' })
    status = await device.handle({ op: 'pair' }) as DeviceStatus
    assert.equal(status.link.state, 'listening')
    const port = (status.link as { port: number }).port
    assert.equal(status.pairing?.phase, 'waiting')

    const paired = pair('127.0.0.1', port, 'Desk', async (code) => {
      const view = await device.handle({ op: 'status' }) as DeviceStatus
      assert.equal(view.pairing?.phase, 'compare')
      assert.equal((view.pairing as { code: string }).code, code)
      await device.handle({ op: 'pair-confirm' })
      return true
    })
    const result = await paired
    assert.match(result.id, /^cp-/)
    status = await device.handle({ op: 'status' }) as DeviceStatus
    assert.equal(status.devices.length, 1)
    assert.equal(status.devices[0]?.name, 'Desk')
    assert.ok((await readFile(join(dir, 'devices.json'), 'utf8')).includes(result.id))

    // A wrong key is refused at the TLS handshake.
    await assert.rejects(connect('127.0.0.1', port, result.id, Buffer.alloc(32)))

    const ws = await connect('127.0.0.1', port, result.id, result.psk)
    const empty = await nextFrame(ws, 'view')
    assert.deepEqual(empty.agents, [])
    sendFrame(ws, { t: 'hello', fw: '0.1.0', bat: 82, rssi: -58 })

    device.observe({ header: { id: 's1', cwd: '/w/api' } }, { type: 'turn/start', data: { turn: 1 } })
    const running = await nextFrame(ws, 'view')
    assert.equal(running.agents[0]?.state, 'RUNNING')
    assert.equal(running.focus, 's1')

    // An approval reaches the device at once; approving there dismisses the dialog.
    const req = request()
    const browser = dialog(req)
    const outcome = device.answer(req, browser.next)
    const asking = await nextFrame(ws, 'view')
    assert.ok(asking.ask !== undefined)
    sendFrame(ws, { t: 'cmd', id: 'm1', op: 'approve', ask: asking.ask.id })
    assert.deepEqual(await nextFrame(ws, 'ack'), { t: 'ack', id: 'm1', ok: true })
    assert.equal(await outcome, 'allowed-once')
    assert.equal(browser.seen?.aborted, true)

    sendFrame(ws, { t: 'cmd', id: 'm2', op: 'send', sid: 's1', text: '继续跑测试' })
    assert.equal((await nextFrame(ws, 'ack')).ok, true)
    assert.deepEqual(sent, [['s1', '继续跑测试']])
    // A retransmitted command is acknowledged without a second side effect.
    sendFrame(ws, { t: 'cmd', id: 'm2', op: 'send', sid: 's1', text: '继续跑测试' })
    assert.equal((await nextFrame(ws, 'ack')).ok, true)
    assert.equal(sent.length, 1)
    sendFrame(ws, { t: 'cmd', id: 'm3', op: 'type', text: 'x' })
    assert.equal((await nextFrame(ws, 'ack')).ok, false)

    sendFrame(ws, { t: 'voice', id: 'v1', target: 'agent', sid: 's1' })
    sendFrame(ws, { t: 'voice', id: 'v2', target: 'agent', sid: 's1' })
    assert.equal((await nextFrame(ws, 'ack')).error, 'voice busy')
    // An out-of-order end must not discard the current recording.
    sendFrame(ws, { t: 'voice-end', id: 'other' })
    ws.send(Buffer.alloc(9600))
    sendFrame(ws, { t: 'voice-end', id: 'v1' })
    assert.match((await nextFrame(ws, 'ack')).error ?? '', /MiniMax API key/)

    status = await device.handle({ op: 'status' }) as DeviceStatus
    assert.deepEqual([status.devices[0]?.online, status.devices[0]?.bat, status.devices[0]?.fw], [true, 82, '0.1.0'])

    // Slow messages must never consume the reserved stop/approval capacity.
    let release!: () => void
    blocked = new Promise<void>((resolve) => { release = resolve })
    for (let i = 0; i < 8; i++) sendFrame(ws, { t: 'cmd', id: `slow-${i}`, op: 'send', sid: 's1', text: 'slow' })
    sendFrame(ws, { t: 'cmd', id: 'emergency-stop', op: 'stop', sid: 's1' })
    assert.deepEqual(await nextFrame(ws, 'ack'), { t: 'ack', id: 'emergency-stop', ok: true })
    assert.equal(stopped, 1)
    release()

    // Removing the last device closes its connection and the port.
    const closed = new Promise<void>((resolve) => ws.once('close', resolve))
    status = await device.handle({ op: 'remove', id: result.id }) as DeviceStatus
    await closed
    assert.deepEqual(status.link, { state: 'off' })
  } finally {
    await device.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
