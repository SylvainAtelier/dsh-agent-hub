/**
 * One Cursor turn as DSH stream chunks: the shared ACP translator
 * (acp/turn.ts), closed with Cursor's usage line and replay state.
 */

import { AcpTurn, type Chunk as AcpChunk } from '../acp/turn.ts'
import type { TurnUsage } from './usage.ts'

export { toolLine } from '../acp/turn.ts'

/** One model's cumulative tokens, as the token ledger reads them (usage/tokens.ts). */
export interface ModelTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * The `replayState` stamped on Cursor replies. `session` is the ACP session
 * to load; `since` when it started (local time) and `through` the newest
 * usage event counted, which bound the next usage read. `total` is every
 * model call of the session so far, per Cursor model, cumulative across
 * turns: the token ledger counts the difference between consecutive replies.
 * `cents` is the session's charged cost so far.
 */
export type Chunk = AcpChunk<CursorReplay>

export interface CursorReplay {
  cursor: {
    session: string
    since: number
    through?: number
    total?: Record<string, ModelTokens>
    cents?: number
    /** Digest of the persona and instructions last sent; a change sends them again. */
    context?: string
  }
}

/** The previous reply's replay state, when it names an ACP session. */
export function cursorReplay(state: unknown): CursorReplay['cursor'] | undefined {
  const replay = (state as Partial<CursorReplay> | undefined)?.cursor
  return typeof replay?.session === 'string' && replay.session !== '' ? replay : undefined
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 })

/** `$0.0125`, `$1.24`: small costs keep their significant digits. */
export function dollars(cents: number): string {
  const value = cents / 100
  if (value === 0) return '$0'
  return value < 0.1 ? `$${value.toPrecision(2)}` : `$${value.toFixed(2)}`
}

/** The turn's closing note: what it used and cost. */
export function usageLine(usage: TurnUsage): string {
  const parts = [`${COMPACT.format(usage.input)} in`, `${COMPACT.format(usage.output)} out`]
  if (usage.cacheRead > 0) parts.push(`${COMPACT.format(usage.cacheRead)} cache read`)
  if (usage.cacheWrite > 0) parts.push(`${COMPACT.format(usage.cacheWrite)} cache write`)
  const names = Object.keys(usage.byModel)
  const models = names.length === 0 ? '' : ` (${names.join(', ')})`
  return `Cursor usage: ${parts.join(' · ')} · ${dollars(usage.cents)}${models}`
}

/** Fold a turn's usage into the session's cumulative totals, per Cursor model. */
export function addTotals(total: Record<string, ModelTokens> | undefined, usage: TurnUsage): Record<string, ModelTokens> {
  const next: Record<string, ModelTokens> = { ...(total ?? {}) }
  for (const [model, counts] of Object.entries(usage.byModel)) {
    const previous = next[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    next[model] = {
      input: previous.input + counts.input,
      output: previous.output + counts.output,
      cacheRead: previous.cacheRead + counts.cacheRead,
      cacheWrite: previous.cacheWrite + counts.cacheWrite,
    }
  }
  return next
}

export class CursorTurn extends AcpTurn {
  constructor(now = Date.now()) {
    super('Cursor', now)
  }

  /** The closing chunks: the usage line, the turn's output tokens, and the replay state the token ledger reads. */
  finish(replay: CursorReplay, usage: TurnUsage | undefined): Chunk[] {
    return this.end(replay, usage === undefined ? [] : [usageLine(usage)], usage?.output ?? 0)
  }
}
