/**
 * What every session is doing, folded from DSH's session events into the
 * device's ten states. The fold reads the durable log events every model
 * writes (turn, tool call, approval, title, to-do) plus one live signal, the
 * start of a reasoning block in the model's stream, for THINKING. Claude
 * Agent and Cursor run their tools inside their own processes, so their
 * sessions read RUNNING between turn start and end rather than TOOL.
 */

import { basename } from 'node:path'
import type { AgentRow, AgentState } from './types.ts'

export interface SessionEvent {
  type: string
  time?: number
  data?: Record<string, unknown>
}

export interface SessionRef {
  header?: { id?: string; cwd?: string; origin?: string; parentSession?: string }
}

interface Track {
  id: string
  cwd: string
  title: string
  todo?: string
  provider?: string
  model?: string
  state: AgentState
  tool?: string
  /** Epoch ms the state began. */
  since: number
  /** Epoch ms of the last event. */
  active: number
}

/** How many sessions a snapshot lists; the device shows a few at a time. */
export const MAX_ROWS = 8
/** A session silent this long leaves the list. */
const STALE_MS = 6 * 3600_000
const TASK_CHARS = 48
const MAX_TRACKS = 256
const EVENTS = new Set(['turn/start', 'step/start', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'turn/end', 'session/title', 'todo/write', 'request/context', 'model/selection'])

/** Tools that hand work to another agent: SUBAGENT rather than TOOL. */
const DELEGATING = /subagent|spawn|delegate|teammate|^task$|^agent$/i
/** DSH's question-to-the-user tool: the session waits on an answer. */
const ASKING = /^ask_user_question$|^AskUserQuestion$/

const clip = (text: string, max = TASK_CHARS): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export class Sessions {
  private tracks = new Map<string, Track>()
  private listeners = new Set<() => void>()

  private readonly providerName: (provider: string) => string | undefined

  constructor(providerName: (provider: string) => string | undefined = () => undefined) {
    this.providerName = providerName
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Fold a live session's recent history (on start, for sessions already open). */
  seed(session: SessionRef, events: readonly SessionEvent[]): void {
    for (const event of events.slice(-400)) this.fold(session, event)
    this.changed()
  }

  observe(session: SessionRef, event: SessionEvent): void {
    if (this.fold(session, event)) this.changed()
  }

  /** A chunk of a model's stream: a reasoning block starting is THINKING, an answer block back to RUNNING. */
  stream(sessionId: string, chunk: object): void {
    const track = this.tracks.get(sessionId)
    if (track === undefined || (track.state !== 'RUNNING' && track.state !== 'THINKING')) return
    const { type, blockType } = chunk as { type?: unknown; blockType?: unknown }
    if (type !== 'block-start') return
    const next: AgentState = blockType === 'reasoning' ? 'THINKING' : 'RUNNING'
    if (next !== track.state) {
      this.set(track, next, Date.now())
      this.changed()
    }
  }

  /** The rows a snapshot carries: who needs the person first, then what runs, then the most recent. */
  rows(now = Date.now()): AgentRow[] {
    for (const [id, track] of this.tracks) if (now - track.active > STALE_MS) this.tracks.delete(id)
    const rank = (state: AgentState): number => (state === 'WAIT_APPROVAL' || state === 'WAIT_INPUT' ? 0 : state === 'IDLE' || state === 'DONE' ? 2 : 1)
    return [...this.tracks.values()]
      .sort((a, b) => rank(a.state) - rank(b.state) || b.active - a.active)
      .slice(0, MAX_ROWS)
      .map((track) => ({
        id: track.id,
        agent: clip((track.provider === undefined ? undefined : this.providerName(track.provider)) ?? track.provider ?? 'DSH', 24),
        ws: clip(basename(track.cwd) || track.cwd, 24),
        state: track.state,
        ...(track.tool === undefined ? {} : { tool: clip(track.tool, 32) }),
        task: clip(track.todo ?? track.title),
        since: Math.floor(track.since / 1000),
        ...(track.model === undefined ? {} : { model: clip(track.model, 32) }),
      }))
  }

  has(id: string): boolean {
    return this.tracks.has(id)
  }

  cwd(id: string): string | undefined {
    return this.tracks.get(id)?.cwd
  }

  /** Apply one event; true when something the device shows changed. */
  private fold(session: SessionRef, event: SessionEvent): boolean {
    if (!EVENTS.has(event.type)) return false
    const header = session.header
    const id = header?.id
    if (id === undefined || header?.origin === 'subagent') return false
    const time = typeof event.time === 'number' ? event.time : Date.now()
    let track = this.tracks.get(id)
    if (track === undefined) {
      if (this.tracks.size >= MAX_TRACKS) {
        let oldest: Track | undefined
        for (const candidate of this.tracks.values()) if (oldest === undefined || candidate.active < oldest.active) oldest = candidate
        if (oldest !== undefined) this.tracks.delete(oldest.id)
      }
      track = { id, cwd: header?.cwd ?? '', title: '', state: 'IDLE', since: time, active: time }
      this.tracks.set(id, track)
    }
    track.active = Math.max(track.active, time)
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start': return this.set(track, 'RUNNING', time)
      case 'step/start': return track.state === 'TOOL' || track.state === 'SUBAGENT' ? this.set(track, 'RUNNING', time) : false
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        return this.set(track, ASKING.test(name) ? 'WAIT_INPUT' : DELEGATING.test(name) ? 'SUBAGENT' : 'TOOL', time, name)
      }
      case 'tool/result': return this.set(track, 'RUNNING', time)
      case 'approval/asked': return this.set(track, 'WAIT_APPROVAL', time, typeof data.toolName === 'string' ? data.toolName : undefined)
      case 'approval/decided': return this.set(track, 'RUNNING', time)
      case 'turn/end': {
        const kind = (data.reason as { kind?: unknown } | undefined)?.kind
        return this.set(track, kind === 'completed' ? 'DONE' : kind === 'cancelled' || kind === 'aborted' || kind === 'interrupted' ? 'IDLE' : 'ERROR', time)
      }
      case 'session/title': {
        const title = typeof data.title === 'string' ? clip(data.title) : ''
        if (title === track.title) return false
        track.title = title
        return true
      }
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos as Array<{ content?: unknown; status?: unknown }> : []
        const current = todos.find((todo) => todo.status === 'in_progress')?.content
        const todo = typeof current === 'string' ? clip(current) : undefined
        if (todo === track.todo) return false
        track.todo = todo
        return true
      }
      case 'request/context':
      case 'model/selection': {
        const provider = typeof data.provider === 'string' ? data.provider : track.provider
        const model = typeof data.model === 'string' ? data.model : track.model
        if (provider === track.provider && model === track.model) return false
        track.provider = provider
        track.model = model
        return true
      }
      default: return false
    }
  }

  private set(track: Track, state: AgentState, time: number, tool?: string): boolean {
    if (track.state === state && track.tool === tool) return false
    track.state = state
    track.since = time
    if (tool === undefined) delete track.tool
    else track.tool = tool
    return true
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}
