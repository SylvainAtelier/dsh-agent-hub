/**
 * Cardputer module: an M5Stack Cardputer on the desk shows what every DSH
 * session is doing, answers approvals, sends a session text or voice, and
 * dictates into this computer's front app. The device speaks one WebSocket
 * over TLS-PSK to this host (link.ts), found by mDNS (mdns.ts) and paired by
 * numeric comparison (pairing.ts). The host folds session events into a
 * snapshot of at most a few rows (view.ts), pushes it whole whenever it
 * changes (throttled), and answers the device's commands. The port is open
 * only while a device is paired or a pairing is in progress.
 */

import { hostname } from 'node:os'
import { localized } from '../locale.ts'
import { Approvals } from './control.ts'
import { startLink, type Link, type Peer } from './link.ts'
import { lanAddresses, startResponder, type Responder } from './mdns.ts'
import { HostPairing, PAIR_IDENTITY, PAIR_KEY } from './pairing.ts'
import { DeviceStore, type DeviceRecord } from './store.ts'
import type { Typer, TypeWay } from './type.ts'
import type { DeviceFrame, DeviceRequest, DeviceStatus, HostFrame, Pairing, SttProvider } from './types.ts'
import { Sessions } from './view.ts'
import { correct, MAX_PCM, RATE, transcribe, vocabulary, wav, type SttKey } from './voice.ts'
import type { WsConnection } from './ws.ts'

export { Typer, typerPath } from './type.ts'
export { DEVICE_METHOD } from './types.ts'

export interface DeviceSettings {
  port: number
  /** Whether the device may approve (risky operations aside); off, it can only deny. */
  approve: boolean
  stt: SttProvider
  sttUrl?: string
  sttModel?: string
  language?: string
  /** Put spoken file names of the session's workspace back together. */
  hints: boolean
  typing: TypeWay
}

/** The slice of DSH's sessions the device drives. */
export interface SessionControl {
  send(sessionId: string, text: string, requestId: string): Promise<void>
  cancel(sessionId: string): Promise<void>
}

export interface DeviceOptions {
  file: string
  settings: () => DeviceSettings
  sessions: () => SessionControl | undefined
  providerName?: (provider: string) => string | undefined
  /** The recognizer's key: DSH's MiniMax key, or the one stored for the OpenAI-compatible service. */
  sttKey: (provider: SttProvider) => Promise<SttKey>
  setSttKey: (key: string) => Promise<void>
  typer: Typer
  log: (message: string) => void
  /** Sessions another answerer follows (the glasses, bridge/service.ts): their approvals wait here with no device online too. */
  follows?: (sessionId: string) => boolean
  /** Tests: bind loopback and skip mDNS. */
  bindHost?: string
  mdns?: boolean
}

/** How long "添加设备" waits for a device, and how long a finished pairing stays on the page. */
export const PAIR_MS = 120_000
const RESULT_MS = 8_000
/** A device sends `hello` every 30 s; one silent this long is gone. */
const SILENT_MS = 75_000
const PUSH_MS = 250

const hostName = (): string => hostname().replace(/\.local$/i, '')
/** Shorter than this is a slip of the finger, not speech. */
const MIN_PCM = RATE * 2 * 0.3

interface Client {
  record: DeviceRecord
  ws: WsConnection
  focus?: string
  bat?: number
  rssi?: number
  last: number
  sent?: string
  voice?: { id: string; target: 'agent' | 'type'; sid?: string; chunks: Buffer[]; bytes: number; started: number }
  abort: AbortController
  hearing: boolean
  commands: Map<string, Promise<string | undefined>>
  pending: number
  controls: number
  completed: string[]
}

interface PairingRun {
  state: Pairing
  peer?: WsConnection
  exchange?: HostPairing
  timer?: NodeJS.Timeout
  finishing?: boolean
}

export interface Device {
  readonly online: boolean
  /** The `approval/request` waterfall listener. */
  answer: Approvals['answer']
  observe: Sessions['observe']
  seed: Sessions['seed']
  stream: Sessions['stream']
  handle(request: DeviceRequest): Promise<unknown>
  /**
   * Answer a session's oldest waiting approval for the answerer `follows` names, by the device's
   * rules: `off` when the approve switch allows only denying, `refused` for a risky one.
   */
  decide(sessionId: string, allow: boolean): 'ok' | 'none' | 'refused' | 'off'
  /** Whether the session has an approval waiting here. */
  waiting(sessionId: string): boolean
  /** The settings changed: reopen the port if it moved, push the approve switch. */
  reconfigure(): void
  dispose(): Promise<void>
}

export function createDevice(options: DeviceOptions): Device {
  const store = new DeviceStore(options.file)
  const sessions = new Sessions(options.providerName)
  const clients = new Map<string, Client>()
  const approvals = new Approvals((sessionId) => clients.size > 0 || options.follows?.(sessionId) === true)
  let pairing: PairingRun | undefined
  const pairingWrites = new Set<Promise<void>>()
  let link: Link | undefined
  /** The port the open link was asked for (0 in tests picks any). */
  let linkPort = 0
  let responder: Responder | undefined
  let linkState: DeviceStatus['link'] = { state: 'off' }
  let linking: Promise<void> = Promise.resolve()
  let disposed = false
  let hearings = 0
  let rev = 0
  let pushTimer: NodeJS.Timeout | undefined
  let silence: NodeJS.Timeout | undefined

  const send = (ws: WsConnection, frame: HostFrame): void => ws.send(JSON.stringify(frame))

  // Snapshots ------------------------------------------------------------

  const viewFor = (client: Client, agents = sessions.rows(), asks = approvals.list()): HostFrame => {
    const ask = asks.find((item) => item.sid === client.focus) ?? asks[0]
    const focus = ask?.sid ?? (client.focus !== undefined && agents.some((row) => row.id === client.focus) ? client.focus : agents[0]?.id)
    client.focus = focus
    return { t: 'view', rev, ...(focus === undefined ? {} : { focus }), agents, ...(ask === undefined ? {} : { ask }), approve: options.settings().approve }
  }

  const flush = (): void => {
    clearTimeout(pushTimer)
    pushTimer = undefined
    if (disposed || clients.size === 0) return
    rev++
    const agents = sessions.rows()
    const asks = approvals.list()
    for (const client of clients.values()) {
      const frame = viewFor(client, agents, asks)
      const body = JSON.stringify({ ...frame, rev: 0 })
      if (body === client.sent) continue
      client.sent = body
      send(client.ws, frame)
    }
  }
  const schedule = (): void => {
    if (pushTimer === undefined && clients.size > 0) pushTimer = setTimeout(flush, PUSH_MS)
  }
  const offSessions = sessions.onChange(schedule)
  // An approval is the one thing worth no delay.
  const offApprovals = approvals.onChange(() => {
    clearTimeout(pushTimer)
    flush()
  })

  // The link -------------------------------------------------------------

  const wanted = (): boolean => store.list().length > 0 || pairing?.state.phase === 'waiting' || pairing?.state.phase === 'compare'

  const ensureLink = (): Promise<void> => {
    linking = linking.then(async () => {
      await store.ready
      const want = !disposed && wanted()
      const port = options.settings().port
      if (link !== undefined && (!want || linkPort !== port)) {
        responder?.close()
        responder = undefined
        await link.close()
        link = undefined
        linkState = { state: 'off' }
      }
      if (!want || link !== undefined) return
      try {
        link = await startLink({ port, ...(options.bindHost === undefined ? {} : { host: options.bindHost }), keyOf, onPeer, log: options.log })
        linkPort = port
        linkState = { state: 'listening', port: link.port, addresses: lanAddresses() }
        if (options.mdns !== false) responder = startResponder({ name: hostName(), hostId: store.hostId, port: link.port }, options.log)
      } catch (error) {
        linkState = { state: 'error', error: (error as Error).message }
        options.log(`device link: port ${port}: ${(error as Error).message}`)
      }
    }).catch((error: unknown) => options.log(`device link: ${String(error)}`))
    return linking
  }

  const keyOf = (identity: string): Buffer | null => {
    if (identity === PAIR_IDENTITY) return pairing?.state.phase === 'waiting' && pairing.peer === undefined ? PAIR_KEY : null
    const record = store.get(identity)
    return record === undefined ? null : Buffer.from(record.psk, 'base64')
  }

  const onPeer = (peer: Peer): void => {
    if (peer.identity === PAIR_IDENTITY) pairPeer(peer.ws)
    else connect(peer)
  }

  // Paired devices ---------------------------------------------------------

  const connect = (peer: Peer): void => {
    const record = store.get(peer.identity)
    if (record === undefined) return peer.ws.close()
    clients.get(record.id)?.ws.close()
    const client: Client = { record, ws: peer.ws, last: Date.now(), abort: new AbortController(), hearing: false, commands: new Map(), pending: 0, controls: 0, completed: [] }
    clients.set(record.id, client)
    store.update(record.id, { seen: Date.now() })
    peer.ws.on('text', (text) => {
      client.last = Date.now()
      let frame: DeviceFrame
      try {
        frame = JSON.parse(text) as DeviceFrame
      } catch {
        return
      }
      void command(client, frame).catch((error: unknown) => options.log(`device ${record.name}: ${(error as Error).message}`))
    })
    peer.ws.on('binary', (chunk) => {
      client.last = Date.now()
      const voice = client.voice
      if (voice === undefined || chunk.length === 0) return
      if (voice.bytes + chunk.length > MAX_PCM || voice.chunks.length >= 8192 || Date.now() - voice.started > 120_000) {
        client.voice = undefined
        return ack(client, voice.id, 'recording too long')
      }
      voice.chunks.push(chunk)
      voice.bytes += chunk.length
    })
    peer.ws.on('close', () => {
      client.abort.abort()
      client.voice = undefined
      client.commands.clear()
      if (clients.get(record.id) !== client) return
      clients.delete(record.id)
      store.update(record.id, { seen: Date.now() })
      if (clients.size === 0) {
        clearInterval(silence)
        silence = undefined
        clearTimeout(pushTimer)
        pushTimer = undefined
      }
    })
    if (silence === undefined) {
      silence = setInterval(() => {
        for (const item of clients.values()) {
          if (Date.now() - item.last > SILENT_MS) item.ws.close()
          else if (item.voice !== undefined && Date.now() - item.voice.started > 120_000) {
            ack(item, item.voice.id, 'recording too long')
            item.voice = undefined
          }
        }
      }, 15_000)
      silence.unref()
    }
    send(peer.ws, viewFor(client))
  }

  const ack = (client: Client, id: string, error?: string): void =>
    send(client.ws, { t: 'ack', id, ok: error === undefined, ...(error === undefined ? {} : { error }) })

  async function command(client: Client, frame: DeviceFrame): Promise<void> {
    if (disposed || client.abort.signal.aborted || frame === null || typeof frame !== 'object') return
    switch (frame.t) {
      case 'hello':
        client.bat = typeof frame.bat === 'number' && frame.bat >= 0 && frame.bat <= 100 ? frame.bat : client.bat
        client.rssi = typeof frame.rssi === 'number' && frame.rssi >= -127 && frame.rssi <= 0 ? frame.rssi : client.rssi
        if (typeof frame.fw === 'string' && frame.fw.length <= 32 && frame.fw !== client.record.fw) store.update(client.record.id, { fw: frame.fw })
        return
      case 'voice':
        if (typeof frame.id !== 'string' || frame.id.length > 80) return
        if (client.hearing || client.voice !== undefined) return ack(client, frame.id, 'voice busy')
        client.voice = { id: frame.id, target: frame.target === 'type' ? 'type' : 'agent', ...(typeof frame.sid === 'string' ? { sid: frame.sid } : {}), chunks: [], bytes: 0, started: Date.now() }
        return
      case 'voice-end': {
        const voice = client.voice
        if (voice === undefined || voice.id !== frame.id) return
        client.voice = undefined
        if (voice.bytes < MIN_PCM || voice.bytes % 2 !== 0) return ack(client, voice.id, 'too short or invalid PCM')
        if (hearings >= 2) return ack(client, voice.id, 'speech recognition busy')
        client.hearing = true
        hearings++
        try {
          const text = await hear(voice.chunks, voice.sid ?? client.focus, client.abort.signal)
          if (client.abort.signal.aborted) return
          const app = voice.target === 'type' ? await options.typer.front() : undefined
          send(client.ws, { t: 'heard', id: voice.id, text, target: voice.target, ...(voice.sid === undefined ? {} : { sid: voice.sid }), ...(app === undefined ? {} : { app }) })
        } catch (error) {
          ack(client, voice.id, (error as Error).message)
        } finally {
          hearings--
          client.hearing = false
        }
        return
      }
      case 'cmd': {
        const id = frame.id
        if (typeof id !== 'string' || id === '' || id.length > 80) return
        const previous = client.commands.get(id)
        if (previous !== undefined) return ack(client, id, await previous)
        // Reserve independent capacity for stop/approval/navigation even during slow sends.
        const control = frame.op === 'stop' || frame.op === 'approve' || frame.op === 'deny' || frame.op === 'select'
        if (control ? client.controls >= 4 : client.pending >= 8) return ack(client, id, 'device busy')
        if (control) client.controls++
        else client.pending++
        const task = run(client, frame).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error))
        client.commands.set(id, task)
        const error = await task
        if (control) client.controls--
        else client.pending--
        // Completed outcomes are bounded; in-flight requests are never evicted.
        client.completed.push(id)
        if (client.completed.length > 64) client.commands.delete(client.completed.shift()!)
        ack(client, id, error)
        return
      }
      default:
        return
    }
  }

  async function run(client: Client, frame: Extract<DeviceFrame, { t: 'cmd' }>): Promise<void> {
    const sid = typeof frame.sid === 'string' ? frame.sid : client.focus
    const control = (): SessionControl => {
      const host = options.sessions()
      if (host === undefined) throw new Error('DSH sessions are unavailable')
      if (sid === undefined || !sessions.has(sid)) throw new Error('unknown session')
      return host
    }
    switch (frame.op) {
      case 'select':
        if (sid === undefined || !sessions.has(sid)) throw new Error('unknown session')
        client.focus = sid
        client.sent = undefined
        return flush()
      case 'send': {
        const text = typeof frame.text === 'string' ? frame.text.trim() : ''
        if (text === '' || text.length > 16_000) throw new Error('empty message or message too long')
        return control().send(sid!, text, `device-${frame.id}`)
      }
      case 'resume':
        return control().send(sid!, localized({ zh: '继续', en: 'Continue' }), `device-${frame.id}`)
      case 'stop':
        return control().cancel(sid!)
      case 'approve':
      case 'deny': {
        const allow = frame.op === 'approve'
        if (allow && !options.settings().approve) throw new Error('approve on the computer')
        const outcome = approvals.decide(String(frame.ask), allow)
        if (outcome === 'refused') throw new Error('approve this one on the computer')
        if (outcome === 'unknown') throw new Error('already answered')
        return
      }
      case 'type': {
        const text = typeof frame.text === 'string' ? frame.text : ''
        if (text === '') throw new Error('nothing to type')
        return options.typer.type(text, options.settings().typing)
      }
      default:
        throw new Error('unknown command')
    }
  }

  async function hear(chunks: Buffer[], sid: string | undefined, signal: AbortSignal): Promise<string> {
    const settings = options.settings()
    const audio = wav(chunks)
    chunks.length = 0
    const cwd = sid === undefined ? '' : sessions.cwd(sid) ?? ''
    const names = settings.hints ? await vocabulary(cwd) : new Set<string>()
    signal.throwIfAborted()
    const text = await transcribe(audio, settings, await options.sttKey(settings.stt), [...names].slice(0, 60), signal)
    return correct(text, names)
  }

  // Pairing --------------------------------------------------------------

  const endPairing = (state: Pairing | null): void => {
    const run = pairing
    if (run === undefined) return
    clearTimeout(run.timer)
    if (state === null) {
      pairing = undefined
    } else {
      pairing = { state, timer: setTimeout(() => { if (pairing?.state === state) pairing = undefined }, RESULT_MS) }
    }
    void ensureLink()
  }

  const pairPeer = (ws: WsConnection): void => {
    const run = pairing
    if (run === undefined || run.state.phase !== 'waiting' || run.peer !== undefined) return ws.close()
    run.peer = ws
    const exchange = new HostPairing()
    run.exchange = exchange
    const fail = (reason: string): void => {
      if (pairing !== run) return
      send(ws, { t: 'pair-fail', reason })
      ws.close()
      endPairing({ phase: 'failed', reason })
    }
    ws.on('text', (text) => {
      if (pairing !== run) return
      let frame: DeviceFrame
      try {
        frame = JSON.parse(text) as DeviceFrame
        if (frame.t === 'pair') {
          const commit = exchange.start(frame.name, frame.pk)
          send(ws, { t: 'pair-commit', ...commit, host: hostName(), hostId: store.hostId })
        } else if (frame.t === 'pair-nonce') {
          const { n, code } = exchange.reveal(frame.n)
          send(ws, { t: 'pair-reveal', n })
          run.state = { phase: 'compare', until: run.state.phase === 'waiting' ? run.state.until : Date.now() + PAIR_MS, code, name: exchange.name, confirmed: { host: false, device: false } }
        } else if (frame.t === 'pair-ok' && run.state.phase === 'compare') {
          run.state = { ...run.state, confirmed: { ...run.state.confirmed, device: true } }
          finish()
        }
      } catch (error) {
        fail((error as Error).message)
      }
    })
    ws.on('close', () => {
      if (pairing === run && run.state.phase !== 'done') endPairing({ phase: 'failed', reason: 'device left' })
    })
  }

  /** Both people said the numbers match: keep the device and tell it its identity. */
  function finish(): void {
    const run = pairing
    if (run?.state.phase !== 'compare' || !run.state.confirmed.host || !run.state.confirmed.device) return
    const psk = run.exchange?.psk
    if (psk === undefined || run.peer === undefined) return
    if (run.finishing) return
    run.finishing = true
    try {
      const record = store.add(run.state.name, psk)
      const peer = run.peer
      const saving = store.settled.then(() => {
        if (disposed || pairing !== run) {
          store.remove(record.id)
          void ensureLink()
          return
        }
        send(peer, { t: 'paired', id: record.id })
        endPairing({ phase: 'done', name: record.name })
        peer.close()
      }, (error: unknown) => {
        store.remove(record.id)
        void ensureLink()
        if (pairing !== run) return
        const reason = `Cannot save device: ${String(error)}`
        send(peer, { t: 'pair-fail', reason })
        endPairing({ phase: 'failed', reason })
        peer.close()
      })
      pairingWrites.add(saving)
      void saving.then(() => pairingWrites.delete(saving), (error: unknown) => {
        pairingWrites.delete(saving)
        options.log(`device pairing: ${String(error)}`)
      })
    } catch (error) {
      const reason = String(error)
      send(run.peer, { t: 'pair-fail', reason })
      endPairing({ phase: 'failed', reason })
      run.peer.close()
    }
  }

  const startPairing = (): void => {
    if (pairing?.peer !== undefined) {
      send(pairing.peer, { t: 'pair-fail', reason: 'restarted' })
      pairing.peer.close()
    }
    clearTimeout(pairing?.timer)
    const until = Date.now() + PAIR_MS
    const run: PairingRun = { state: { phase: 'waiting', until } }
    run.timer = setTimeout(() => {
      if (pairing !== run) return
      if (run.peer !== undefined) send(run.peer, { t: 'pair-fail', reason: 'timeout' })
      run.peer?.close()
      endPairing({ phase: 'failed', reason: 'timeout' })
    }, PAIR_MS)
    pairing = run
  }

  // The settings page ----------------------------------------------------

  let permission: { at: number; value: Promise<boolean | undefined> } | undefined
  const typerPermission = (): Promise<boolean | undefined> => {
    if (permission === undefined || Date.now() - permission.at > 5000) permission = { at: Date.now(), value: options.typer.permission() }
    return permission.value
  }

  const status = async (): Promise<DeviceStatus> => {
    await store.ready
    await linking
    await store.settled
    const settings = options.settings()
    const sttReady = settings.stt === 'minimax' ? (await options.sttKey('minimax').catch(() => ({} as SttKey))).key !== undefined : (settings.sttUrl ?? '').trim() !== ''
    const allowed = options.typer.available && (store.list().length > 0 || pairing !== undefined) ? await typerPermission() : undefined
    return {
      host: hostName(),
      devices: store.list().map((record) => {
        const client = clients.get(record.id)
        return {
          id: record.id,
          name: record.name,
          online: client !== undefined,
          ...(record.seen === undefined ? {} : { seen: record.seen }),
          ...(record.fw === undefined ? {} : { fw: record.fw }),
          ...(client?.bat === undefined ? {} : { bat: client.bat }),
          ...(client?.rssi === undefined ? {} : { rssi: client.rssi }),
        }
      }),
      pairing: pairing?.state ?? null,
      link: linkState.state === 'listening' ? { ...linkState, addresses: lanAddresses() } : linkState,
      stt: { provider: settings.stt, ready: sttReady },
      typer: { available: options.typer.available, ...(allowed === undefined ? {} : { permission: allowed }) },
    }
  }

  const handle = async (request: DeviceRequest): Promise<unknown> => {
    if (disposed) throw new Error('device module disposed')
    await store.ready
    if (disposed) throw new Error('device module disposed')
    switch (request.op) {
      case 'pair':
        startPairing()
        await ensureLink()
        break
      case 'pair-confirm':
        if (pairing?.state.phase === 'compare') {
          pairing.state = { ...pairing.state, confirmed: { ...pairing.state.confirmed, host: true } }
          finish()
        }
        break
      case 'pair-cancel':
        if (pairing?.peer !== undefined) {
          send(pairing.peer, { t: 'pair-fail', reason: 'cancelled' })
          pairing.peer.close()
        }
        endPairing(null)
        await linking
        break
      case 'rename': {
        const name = typeof request.name === 'string' ? request.name.trim().slice(0, 32) : ''
        if (name === '' || store.get(request.id) === undefined) throw new Error('Unknown device or empty name')
        store.update(request.id, { name })
        break
      }
      case 'remove':
        if (!store.remove(request.id)) throw new Error('Unknown device')
        clients.get(request.id)?.ws.close()
        clients.delete(request.id)
        await ensureLink()
        break
      case 'stt-key':
        await options.setSttKey(typeof request.key === 'string' ? request.key.trim() : '')
        break
      case 'open-perm':
        await options.typer.openPermission()
        permission = undefined
        break
      case 'status':
        break
      default:
        throw new Error('Unknown device request')
    }
    return status()
  }

  void ensureLink()

  return {
    get online() { return clients.size > 0 && !disposed },
    answer: approvals.answer,
    observe: (session, event) => sessions.observe(session, event),
    seed: (session, events) => sessions.seed(session, events),
    stream: (sessionId, chunk) => sessions.stream(sessionId, chunk),
    handle,
    decide(sessionId, allow) {
      const ask = approvals.list().find((item) => item.sid === sessionId)
      if (ask === undefined) return 'none'
      if (allow && !options.settings().approve) return 'off'
      const outcome = approvals.decide(ask.id, allow)
      return outcome === 'unknown' ? 'none' : outcome
    },
    waiting: (sessionId) => approvals.list().some((item) => item.sid === sessionId),
    reconfigure() {
      for (const client of clients.values()) client.sent = undefined
      schedule()
      void ensureLink()
    },
    async dispose() {
      disposed = true
      clearInterval(silence)
      clearTimeout(pushTimer)
      clearTimeout(pairing?.timer)
      offSessions()
      offApprovals()
      approvals.dispose()
      for (const client of clients.values()) client.ws.close()
      clients.clear()
      pairing?.peer?.close()
      pairing = undefined
      options.typer.dispose()
      await ensureLink()
      await Promise.allSettled([...pairingWrites])
      await store.settled.catch((error: unknown) => options.log(`device store: ${String(error)}`))
    },
  }
}
