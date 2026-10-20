/**
 * One ACP turn as DSH stream chunks. Session updates stream in as text and
 * thinking; each tool call becomes a one-line reasoning note (`→ Shell: npm
 * test`, `✗ …` when it fails), never a DSH tool call, so the DSH loop ends
 * after exactly one model step — as with Claude Agent. Shared by every ACP
 * route (Cursor, Qoder); each stamps its own replay state on the finish.
 */

import { beat, minutes } from '../claude/translate.ts'
import type { SessionUpdate } from './client.ts'

/** A DSH stream chunk; `R` is the route's replay state, stamped on the finish. */
export type Chunk<R = unknown> =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' }
  | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text' | 'reasoning'; text: string } }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } }
  | { type: 'finish'; reason: { kind: 'stop' }; replayState: R }

/** A chunk mid-turn: everything but the finish, which only {@link AcpTurn.end} writes. */
export type Part = Chunk<never>

const KIND_NAMES: Record<string, string> = {
  execute: 'Shell', edit: 'Edit', delete: 'Delete', move: 'Move', read: 'Read', search: 'Search', fetch: 'Fetch', think: 'Think',
}

/** A tool call on one short line: `Shell: npm test`, `Read: src/a.ts`. */
export function toolLine(kind: unknown, title: unknown): string {
  const name = typeof kind === 'string' ? KIND_NAMES[kind] : undefined
  const raw = typeof title === 'string' ? title.trim().replace(/^`([^`]*)`$/, '$1').replace(/\s+/g, ' ') : ''
  const detail = raw.length > 120 ? `${raw.slice(0, 119)}…` : raw
  if (name === undefined) return detail || 'tool'
  // Titles often already lead with the action (`Read src/a.ts`).
  const rest = detail.toLowerCase().startsWith(`${name.toLowerCase()} `) ? detail.slice(name.length + 1).trim() : detail
  return rest === '' || rest.toLowerCase() === name.toLowerCase() ? name : `${name}: ${rest}`
}

interface Open {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

export class AcpTurn {
  /** Who the heartbeat names when nothing arrives: "No output from Cursor". */
  protected readonly agent: string
  private next = 0
  private open: Open | undefined
  private tools = new Map<string, string>()
  private lastPlan = ''
  /** Tool calls still running: since when, and the heartbeat mark (minutes) last shown. */
  private running = new Map<string, { since: number; mark: number }>()
  /** Since when Cursor sent nothing, and the heartbeat mark last shown for that silence. */
  private quiet: { since: number; mark: number }

  constructor(agent: string, now = Date.now()) {
    this.agent = agent
    this.quiet = { since: now, mark: 0 }
  }

  /**
   * Heartbeat notes, read on a clock: ACP reports no progress of its own. A
   * running tool gets one at each mark (`⏳ Shell: npm test · 5m`); with none
   * running, a silence does (`⏳ No output from Cursor · 2m`).
   */
  tick(now = Date.now()): Part[] {
    const chunks: Part[] = []
    for (const [id, tool] of this.running) {
      const mark = beat(now - tool.since)
      if (mark <= tool.mark) continue
      tool.mark = mark
      chunks.push(...this.note(`⏳ ${this.tools.get(id) ?? 'tool'} · ${minutes(mark)}`))
    }
    const mark = beat(now - this.quiet.since)
    if (this.running.size === 0 && mark > this.quiet.mark) {
      this.quiet.mark = mark
      chunks.push(...this.note(`⏳ No output from ${this.agent} · ${minutes(mark)}`))
    }
    return chunks
  }

  /** Follow which tool calls run, by the status ACP reports with them. */
  private track(update: SessionUpdate, now: number): void {
    const id = String(update.toolCallId ?? '')
    if (id === '') return
    if (update.status === 'completed' || update.status === 'failed') this.running.delete(id)
    else if (update.sessionUpdate === 'tool_call' && !this.running.has(id)) this.running.set(id, { since: now, mark: 0 })
  }

  /** A whole reasoning block: a tool note or a host notice. */
  note(text: string): Part[] {
    const chunks = this.close()
    const index = this.next++
    chunks.push(
      { type: 'block-start', index, blockType: 'reasoning' },
      { type: 'reasoning-delta', index, text },
      { type: 'block-end', index, block: { type: 'reasoning', text } },
    )
    return chunks
  }

  protected close(): Part[] {
    const open = this.open
    if (open === undefined) return []
    this.open = undefined
    return [{ type: 'block-end', index: open.index, block: { type: open.type, text: open.text } }]
  }

  private delta(type: 'text' | 'reasoning', text: string): Part[] {
    if (text === '') return []
    const chunks: Part[] = []
    if (this.open?.type !== type) {
      chunks.push(...this.close())
      this.open = { index: this.next++, type, text: '' }
      chunks.push({ type: 'block-start', index: this.open.index, blockType: type })
    }
    this.open!.text += text
    chunks.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: this.open!.index, text })
    return chunks
  }

  push(update: SessionUpdate, now = Date.now()): Part[] {
    this.quiet = { since: now, mark: 0 }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') this.track(update, now)
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type !== 'text' || typeof content.text !== 'string') return []
        return this.delta(update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning', content.text)
      }
      case 'tool_call': {
        const id = String(update.toolCallId ?? '')
        const line = toolLine(update.kind, update.title)
        if (id !== '') this.tools.set(id, line)
        return this.note(`→ ${line}`)
      }
      case 'tool_call_update': {
        const id = String(update.toolCallId ?? '')
        if (typeof update.title === 'string') this.tools.set(id, toolLine(update.kind, update.title))
        const output = update.rawOutput as { exitCode?: unknown; stderr?: unknown; error?: unknown } | undefined
        const exit = typeof output?.exitCode === 'number' ? output.exitCode : undefined
        if (update.status !== 'failed' && (exit === undefined || exit === 0)) return []
        const detail = [output?.error, output?.stderr, contentText(update.content)].find((value): value is string => typeof value === 'string' && value.trim() !== '')
        const first = detail?.trim().split(/\r?\n/)[0]?.slice(0, 160)
        const reason = exit !== undefined && exit !== 0 ? `exit ${exit}${first ? `, ${first}` : ''}` : first
        return this.note(`✗ ${this.tools.get(id) ?? 'tool'}${reason ? `: ${reason}` : ''}`)
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries as Array<{ content?: unknown; status?: unknown }> : []
        const text = entries.map((entry) => `${entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '▸' : '☐'} ${String(entry.content ?? '')}`).join('\n')
        if (text === '' || text === this.lastPlan) return []
        this.lastPlan = text
        return this.note(text)
      }
      default:
        return []
    }
  }

  /**
   * The closing chunks: closing notes (a usage line), then the usage chunk and
   * the finish. The usage chunk carries the turn's output only: DSH reads its
   * prompt side as how full the context window is, which ACP does not report
   * (the agent manages its own context).
   */
  end<R>(replayState: R, notes: readonly string[] = [], outputTokens = 0): Chunk<R>[] {
    const chunks: Chunk<R>[] = this.close()
    for (const note of notes) chunks.push(...this.note(note), ...this.close())
    chunks.push(
      { type: 'usage', usage: { inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: outputTokens } },
      { type: 'finish', reason: { kind: 'stop' }, replayState },
    )
    return chunks
  }

  /** Close an open block without finishing: the turn failed or was stopped. */
  abort(): Part[] {
    return this.close()
  }
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const texts = content.map((item) => {
    const inner = (item as { content?: { text?: unknown } }).content
    return typeof inner?.text === 'string' ? inner.text : ''
  }).filter((text) => text !== '')
  return texts.length === 0 ? undefined : texts.join('\n')
}
