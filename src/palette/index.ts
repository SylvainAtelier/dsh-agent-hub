/**
 * Clipboard history and translation window. The window, the global hotkey, the clipboard
 * listener and the history (SQLite) all live in the native helper's palette mode
 * (native/dsh-type, `--palette`), which a plugin's Node process could not do itself; this half
 * keeps that process alive, hands it the settings, and answers the one thing it cannot: a
 * translation by a bot's model. Nothing here sits on the path of opening the window, searching
 * or typing, so a busy host never slows them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { localized } from '../locale.ts'
import { personaText, type AgentProfile } from '../team/profiles.ts'
import type { Llm, Route } from '../git/message.ts'
import { brief, clean, langKeys, langOf, MAX_SOURCE, Recent } from './translate.ts'
import type { PaletteSettings, PaletteStatus, PaletteTheme, PinItem } from './types.ts'

export { PALETTE_METHOD } from './types.ts'
export type { PaletteSettings, PaletteStatus, PaletteTheme, PinItem } from './types.ts'

/** Wait for the host to settle before building the window, so its start is not slowed. */
const WARM_MS = 5000
/** One line is at most the pinned texts (each up to 64 KB) in one event. */
const MAX_LINE = 8 * 1024 * 1024
/** The helper answers a request to set the pins within this time. */
const PINS_MS = 10_000
const TRANSLATE_MS = 45_000
/** Streamed text reaches the window at most this often: a token at a time would redraw it for nothing. */
const FLUSH_MS = 40
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]
/** A helper that crashes this often within the window is left alone, with its reason shown. */
const CRASHES = 5
const CRASH_WINDOW_MS = 10 * 60_000

export interface PaletteOptions {
  settings: () => PaletteSettings
  bots: () => readonly AgentProfile[]
  /** Where a bot answers one request; with no bot, the helper model. */
  route: (bot: AgentProfile | undefined) => Promise<Route | undefined>
  llm: () => Llm | undefined
  /** The native helper, undefined where it is not built. */
  binary: string | undefined
  page: string
  db: string
  data: string
  log: (message: string) => void
  launch?: typeof spawn
  /** Systems the helper is built for; tests stand in for another. */
  platform?: readonly string[]
}

const HELPER_PLATFORMS: readonly string[] = ['win32', 'darwin']

type Chunk = { type: string; text?: string; reason?: { kind: string; failure?: { message?: string } } }

export class Palette {
  private child?: ChildProcessWithoutNullStreams
  private stopping = false
  private disposed = false
  private hotkey: PaletteStatus['hotkey'] = null
  private error: string | undefined
  private crashes: number[] = []
  private restart?: NodeJS.Timeout
  private warm?: NodeJS.Timeout
  private job?: { rid: number; abort: AbortController }
  /** The pinned texts as the helper last told; unknown while it is not running. */
  private pinned?: PinItem[]
  private pinRid = 0
  private readonly pinAnswers = new Map<number, (ok: boolean) => void>()
  private readonly pinWaiters = new Set<() => void>()
  /** DSH's light or dark theme as a client last told; unknown until one does, and the window follows the system. */
  private theme: PaletteTheme | undefined
  private readonly recent = new Recent()
  private readonly options: PaletteOptions

  constructor(options: PaletteOptions) {
    this.options = options
  }

  get supported(): boolean {
    // The helper is built for Windows and macOS only, so a binary is also the platform check.
    return this.options.binary !== undefined && existsSync(this.options.page)
  }

  /** On a system the helper is made for, a missing piece is a build left undone, not "unsupported". */
  private missing(): string | undefined {
    if (this.supported || !(this.options.platform ?? HELPER_PLATFORMS).includes(process.platform)) return undefined
    return this.options.binary === undefined
      ? 'the native helper (lib/bin/…/dsh-type) is not built: run pnpm build:native in the plugin folder, then reload'
      : 'the window page (lib/palette.html) is missing: run pnpm build in the plugin folder, then reload'
  }

  status(): PaletteStatus {
    const settings = this.options.settings()
    const error = this.error ?? (settings.enabled ? this.missing() : undefined)
    return {
      supported: this.supported,
      enabled: settings.enabled,
      running: this.child !== undefined,
      hotkey: this.hotkey,
      ...(error === undefined ? {} : { error }),
    }
  }

  /** The settings changed (or the plugin started): bring the helper into line with them. */
  reconfigure(): void {
    if (this.disposed) return
    const settings = this.options.settings()
    if (!settings.enabled || !this.supported) {
      const missing = settings.enabled ? this.missing() : undefined
      if (missing !== undefined) this.options.log(`palette: ${missing}`)
      this.stop()
      this.error = undefined
      this.hotkey = null
      return
    }
    if (this.child === undefined) return this.start()
    this.configure(false)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  /** DSH's theme changed: the window takes its colours, at once when it is running. */
  setTheme(theme: PaletteTheme): void {
    if (theme === this.theme) return
    this.theme = theme
    this.send({ op: 'config', theme })
  }

  /** The pinned texts, as the helper last told; waits up to `waitMs` for the first answer of a helper just started. Unknown (undefined) while none runs. */
  async pins(waitMs = 0): Promise<PinItem[] | undefined> {
    if (this.pinned === undefined && this.child !== undefined && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.pinWaiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, waitMs)
        this.pinWaiters.add(done)
      })
    }
    return this.pinned
  }

  /** Makes these the pinned texts; a text already in the history is pinned in place, never added twice. False when the helper is not there or does not answer. */
  setPins(items: readonly PinItem[]): Promise<boolean> {
    if (this.child === undefined) return Promise.resolve(false)
    const rid = ++this.pinRid
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        this.pinAnswers.delete(rid)
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), PINS_MS)
      this.pinAnswers.set(rid, done)
      this.send({ op: 'pins', rid, items })
    })
  }

  /** The helper is gone: what it knew is stale, and nobody should wait for it. */
  private forget(): void {
    this.pinned = undefined
    for (const answer of [...this.pinAnswers.values()]) answer(false)
    for (const wake of [...this.pinWaiters]) wake()
  }

  private configure(warm: boolean): void {
    const settings = this.options.settings()
    this.send({
      op: 'config',
      hotkey: settings.hotkey,
      keep: settings.keep,
      ignore: (settings.ignore ?? '').split(/[,\n;]/).map((name) => name.trim()).filter((name) => name !== ''),
      bots: this.options.bots().map((bot) => ({ id: bot.id, name: bot.id })),
      bot: settings.bot,
      keys: langKeys(settings.langKey),
      theme: this.theme ?? '',
      ...(warm ? { warm: true } : {}),
    })
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child
    if (child === undefined || child.stdin.destroyed) return
    child.stdin.write(`${JSON.stringify(message)}\n`, () => {})
  }

  private start(): void {
    const { binary, db, page, data, log } = this.options
    if (this.child !== undefined || binary === undefined || this.disposed) return
    clearTimeout(this.restart)
    this.stopping = false
    const child = (this.options.launch ?? spawn)(binary, ['--palette', '--db', db, '--page', page, '--data', data], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams
    this.child = child
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffered += chunk
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue // a line that is not ours is skipped
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        // A failure here must be seen: swallowed, it left the hotkey silently unregistered.
        try {
          this.event(value as Record<string, unknown>)
        } catch (error) {
          log(`palette: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        }
      }
      if (buffered.length > MAX_LINE) buffered = ''
    })
    child.stderr.on('data', (data: Buffer) => log(`palette: ${data.toString().trim().slice(0, 1024)}`))
    child.stdin.on('error', () => {})
    child.on('error', (error) => this.ended(child, `cannot start: ${error.message}`))
    child.on('exit', (code) => this.ended(child, `exited (${code ?? 'signal'})`))
  }

  private ended(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child) return
    this.child = undefined
    this.hotkey = null
    this.forget()
    clearTimeout(this.warm)
    this.job?.abort.abort()
    this.job = undefined
    if (this.stopping || this.disposed) return
    const now = Date.now()
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now]
    if (this.crashes.length >= CRASHES) {
      this.error = `The clipboard window stopped repeatedly (${reason}); turn it off and on to try again`
      this.options.log(`palette: ${this.error}`)
      return
    }
    this.error = undefined
    this.options.log(`palette: ${reason}; restarting`)
    this.restart = setTimeout(() => this.start(), BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)])
    this.restart.unref()
  }

  private stop(): void {
    clearTimeout(this.restart)
    clearTimeout(this.warm)
    this.crashes = []
    this.job?.abort.abort()
    this.job = undefined
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.child = undefined
    this.forget()
    // Closing stdin is the polite way out; a helper that ignores it is killed shortly after.
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 1500)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  }

  private event(event: Record<string, unknown>): void {
    switch (event.event) {
      case 'ready':
        this.configure(false)
        this.warm = setTimeout(() => this.send({ op: 'config', warm: true }), WARM_MS)
        this.warm.unref()
        return
      case 'hotkey':
        this.hotkey = {
          ok: event.ok === true,
          accel: typeof event.accel === 'string' ? event.accel : '',
          ...(typeof event.active === 'string' ? { active: event.active } : {}),
          ...(typeof event.error === 'string' ? { error: event.error } : {}),
        }
        return
      case 'pins': {
        this.pinned = (Array.isArray(event.items) ? event.items : [])
          .filter((item): item is PinItem => item !== null && typeof item === 'object' && typeof (item as PinItem).text === 'string')
          .map((item) => ({ text: item.text, at: Number.isFinite(item.at) ? item.at : 0 }))
        for (const wake of [...this.pinWaiters]) wake()
        if (typeof event.rid === 'number') this.pinAnswers.get(event.rid)?.(true)
        return
      }
      case 'translate': return void this.translate(event)
      case 'cancel':
        if (this.job !== undefined && this.job.rid === event.rid) this.job.abort.abort()
        return
      case 'log': return this.options.log(`palette: ${String(event.message ?? '').slice(0, 1024)}`)
      case 'fatal':
        this.error = String(event.message ?? 'the clipboard window cannot start').slice(0, 500)
        this.options.log(`palette: ${this.error}`)
    }
  }

  private reply(rid: number, text: string, done: boolean, error?: string): void {
    this.send({ op: 'tr', rid, text, done, ...(error === undefined ? {} : { error }) })
  }

  /** One translation at a time: a new request, or the window closing, ends the one before. */
  private async translate(request: Record<string, unknown>): Promise<void> {
    const rid = Number(request.rid)
    const text = typeof request.text === 'string' ? request.text.trim() : ''
    if (!Number.isInteger(rid)) return
    this.job?.abort.abort()
    const abort = new AbortController()
    const job = { rid, abort }
    this.job = job
    try {
      if (text === '') throw new Error('Nothing to translate')
      if (text.length > MAX_SOURCE) throw new Error(`The text is too long to translate (over ${MAX_SOURCE} characters)`)
      const lang = langOf(request.to)
      const botId = typeof request.bot === 'string' ? request.bot : ''
      const bot = botId === '' ? undefined : this.options.bots().find((profile) => profile.id === botId)
      const key = `${lang}\n${botId}\n${text}`
      const known = this.recent.get(key)
      if (known !== undefined) return this.reply(rid, known, true)
      const llm = this.options.llm()
      const route = await this.options.route(bot)
      if (llm === undefined || route === undefined) throw new Error(`No model is available: pick a helper model in ${localized({ zh: '设置', en: 'Settings' })} → Agent Hub`)
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        system: brief(lang, bot === undefined ? undefined : personaText(bot)),
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: 4096,
        purpose: 'agent-hub-translate',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TRANSLATE_MS)]),
      }) as AsyncIterable<Chunk>
      let answer = ''
      let failure: string | undefined
      let sent = 0
      for await (const chunk of chunks) {
        if (abort.signal.aborted) return
        if (chunk.type === 'text-delta') {
          answer += chunk.text ?? ''
          const now = Date.now()
          if (now - sent >= FLUSH_MS) {
            sent = now
            this.reply(rid, answer, false)
          }
        } else if (chunk.type === 'finish' && chunk.reason !== undefined && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'max-tokens') {
          failure = chunk.reason.failure?.message ?? `model stopped: ${chunk.reason.kind}`
        }
      }
      if (abort.signal.aborted) return
      const result = clean(answer)
      if (result === '') throw new Error(failure ?? 'The model gave no translation')
      this.recent.set(key, result)
      this.reply(rid, result, true)
    } catch (error) {
      // Ended on purpose (a newer request, the window closing): nobody is waiting for an answer.
      if (abort.signal.aborted) return
      this.reply(rid, '', true, error instanceof Error && error.message !== '' ? error.message : 'Translation failed')
    } finally {
      if (this.job === job) this.job = undefined
    }
  }
}
