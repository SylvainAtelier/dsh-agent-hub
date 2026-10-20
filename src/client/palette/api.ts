/** Where the clipboard window stands on this computer, read while 设置 shows it. */
import { PALETTE_METHOD, type PaletteStatus, type PaletteTheme } from '../../palette/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'
import { isDark, type ThemeService } from '../theme/toggle.ts'

export interface PaletteSnapshot {
  status: PaletteStatus | undefined
}

const POLL_MS = 3000

/** Tells the host DSH's light or dark theme, now and whenever it changes, so the window wears it too. Returns the stop. */
export function followTheme(rpc: Rpc, theme: ThemeService, onChange: (listener: () => void) => () => void): () => void {
  let told: PaletteTheme | undefined
  const tell = (): void => {
    const next: PaletteTheme = isDark(theme) ? 'dark' : 'light'
    if (next === told) return
    told = next
    // Not heard: the next change, or the next start, tells it again.
    rpcValue(rpc, PALETTE_METHOD, { op: 'theme', theme: next }, 'agent-hub clipboard window RPC failed').catch(() => void (told = undefined))
  }
  tell()
  return onChange(tell)
}

export class PaletteStore {
  private snapshot: PaletteSnapshot = { status: undefined }
  private readonly listeners = new Set<() => void>()
  private watchers = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private reading = false
  private readonly rpc: Rpc

  constructor(rpc: Rpc) {
    this.rpc = rpc
  }

  getSnapshot = (): PaletteSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reads now and then every few seconds, only while something shows it and the tab is visible. */
  watch(): () => void {
    if (this.watchers++ === 0) void this.tick()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.watchers === 0) clearTimeout(this.timer)
    }
  }

  /** A setting just changed: the helper takes a moment to answer for it. */
  refresh(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), 400)
  }

  private async tick(): Promise<void> {
    clearTimeout(this.timer)
    if (this.reading || this.watchers === 0) return
    if (globalThis.document?.visibilityState !== 'hidden') {
      this.reading = true
      try {
        const status = await rpcValue<PaletteStatus>(this.rpc, PALETTE_METHOD, { op: 'status' }, 'agent-hub clipboard window RPC failed')
        if (JSON.stringify(status) !== JSON.stringify(this.snapshot.status)) {
          this.snapshot = { status }
          for (const listener of this.listeners) listener()
        }
      } catch {
        // Keep what is shown; the next read tries again.
      } finally {
        this.reading = false
      }
    }
    if (this.watchers > 0) this.timer = setTimeout(() => void this.tick(), POLL_MS)
  }
}
