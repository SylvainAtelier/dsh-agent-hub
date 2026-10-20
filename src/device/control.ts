/**
 * Approvals on the device, for every model DSH runs. DSH asks its answerers
 * through the `approval/request` waterfall; this one sits first, puts the
 * question on the device and passes it on to the browser's dialog at the same
 * time. The first answer wins: when the device answers, the dialog is
 * dismissed through the request's signal, which the browser's dialog follows.
 * With no device online, and no other answerer (the glasses) following the
 * session, the request passes straight through.
 */

import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { Ask } from './types.ts'

export type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The approval request DSH passes down the waterfall (dsh-user-approval). */
export interface ApprovalRequest {
  agent: { id?: string; session?: { header?: { id?: string; cwd?: string } } }
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

/**
 * Operations the device may only refuse: they are approved at the computer,
 * where the full command is in view. Read from the tool line DSH shows.
 */
const RISKY = [
  /\brm\s+(?:-\w*r\w*f|-\w*f\w*r|--recursive\s+--force|--force\s+--recursive)\b/i,
  /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|branch\s+-D)\b/i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\b(?:rd|rmdir)\s+\/s\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\b(?:mkfs|diskpart|format\s+[a-z]:)/i,
  /\bdd\s+if=/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\bsudo\b/,
  /\bchmod\s+-R\b|\bchown\s+-R\b/,
  /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sh|bash|iex|pwsh|powershell)\b/i,
]
const WRITES = /write|edit|patch|create|delete|move|rename/i
const ABSOLUTE = /(?:^|[\s'"`(=])((?:[A-Za-z]:[\\/]|\/)[^\s'"`)]+)/g

const norm = (path: string): string => {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
  const value = (windows ? win32 : posix).normalize(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return windows ? value.toLowerCase() : value
}

/** Whether an approval is one the device may only deny. */
export function risky(tool: string, text: string, cwd: string): boolean {
  const line = `${tool} ${text}`
  if (RISKY.some((rule) => rule.test(line))) return true
  // A write outside the session's folder.
  if (!WRITES.test(tool)) return false
  if (cwd === '' || /(?:^|[\s'"`(=])\.\.[\\/]/.test(text)) return true
  const root = norm(cwd)
  for (const match of text.matchAll(ABSOLUTE)) {
    const path = norm(match[1]!)
    if (path !== root && !path.startsWith(`${root}/`)) return true
  }
  return false
}

interface Pending {
  ask: Ask
  settle(outcome: Outcome): void
}

export class Approvals {
  private pending = new Map<string, Pending>()
  private listeners = new Set<() => void>()

  /** `online`: whether something can answer the session's approval now; without it the waterfall passes straight on. */
  private readonly online: (sessionId: string) => boolean

  constructor(online: (sessionId: string) => boolean) {
    this.online = online
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Waiting asks, oldest first. */
  list(): Ask[] {
    return [...this.pending.values()].map((entry) => entry.ask)
  }

  get(id: string): Ask | undefined {
    return this.pending.get(id)?.ask
  }

  /** The `approval/request` waterfall listener. */
  answer = (request: ApprovalRequest, next: () => Promise<Outcome>): Promise<Outcome> => {
    const header = request.agent.session?.header
    const sid = header?.id ?? request.agent.id ?? ''
    if (!this.online(sid)) return next()
    const cwd = header?.cwd ?? ''
    const text = request.reason ?? request.toolName
    const ask: Ask = { id: randomUUID().slice(0, 8), sid, tool: request.toolName.slice(0, 80), text: text.length > 256 ? `${text.slice(0, 255)}…` : text, cwd, risk: text.length > 256 || risky(request.toolName, text, cwd) }
    // The dialog follows the request's signal: give it one we can abort when the device answers first.
    const dismiss = new AbortController()
    const original = request.signal
    try {
      request.signal = original === undefined ? dismiss.signal : AbortSignal.any([original, dismiss.signal])
    } catch {
      // A frozen request: the dialog then stays until answered, and its answer is ignored.
    }
    return new Promise<Outcome>((resolve) => {
      let done = false
      const settle = (outcome: Outcome): void => {
        if (done) return
        done = true
        this.pending.delete(ask.id)
        original?.removeEventListener('abort', onAbort)
        dismiss.abort()
        try {
          request.signal = original
        } catch {
          // Frozen, as above.
        }
        this.changed()
        resolve(outcome)
      }
      const onAbort = (): void => settle('cancelled')
      if (original?.aborted) return settle('cancelled')
      original?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(ask.id, { ask, settle })
      this.changed()
      try {
        next().then(
          (outcome) => { if (!dismiss.signal.aborted) settle(outcome) },
          () => { if (!dismiss.signal.aborted) settle('unavailable') },
        )
      } catch {
        settle('unavailable')
      }
    })
  }

  /** The device's answer; a risky ask can only be denied there. */
  decide(id: string, allow: boolean): 'ok' | 'unknown' | 'refused' {
    const entry = this.pending.get(id)
    if (entry === undefined) return 'unknown'
    if (allow && entry.ask.risk) return 'refused'
    entry.settle(allow ? 'allowed-once' : 'rejected')
    return 'ok'
  }

  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.settle('cancelled')
    this.listeners.clear()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}
