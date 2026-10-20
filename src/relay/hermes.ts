/**
 * Hermes' own record of its conversations: each persona's `state.db`
 * (SQLite, WAL), a `sessions` row per conversation (`source`: telegram, cli,
 * tui, cron, api_server, acp…) and a `messages` row per message. Opened read
 * only for each read, through Node's built-in SQLite; columns newer Hermes
 * versions added are used only when the file has them. ACP sessions are
 * DSH's own conversations on the Hermes route, and one-shot probes and
 * subagent runs are no conversation: all three are left out.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toolOf } from '../qoder/daemon.ts'
import { preview } from './qoder.ts'
import type { Turn } from './types.ts'

export interface HermesSession {
  id: string
  persona: string
  source: string
  title?: string
  cwd?: string
  branch?: string
  model?: string
  startedAt: number
  updatedAt: number
  ended: boolean
  messages: number
  /** An answer is under way: the last message is a prompt, a tool call or its result. */
  waiting: boolean
  last?: string
}

interface Statement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
interface Database {
  prepare(sql: string): Statement
  close(): void
}
type Sqlite = { DatabaseSync: new (file: string, options: { readOnly: boolean }) => Database }

let loading: Promise<Sqlite | undefined> | undefined
/** Node's SQLite (22.13 and later); undefined on a runtime without it. */
const sqlite = (): Promise<Sqlite | undefined> => {
  loading ??= import('node:sqlite').then((module) => module as unknown as Sqlite, () => undefined)
  return loading
}

/** Sessions listed per persona, newest first. */
const KEEP_SESSIONS = 30
const HIDDEN_SOURCES = ['acp', 'oneshot', 'subagent']
const TEXT_MAX = 8000

const ms = (seconds: unknown): number | undefined => (typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/** Open a persona's database, run `read`, close it; undefined when there is none or it cannot be read. */
async function withDb<T>(file: string, read: (db: Database, columns: (table: string) => Set<string>) => T): Promise<T | undefined> {
  const module = await sqlite()
  if (module === undefined) return undefined
  try {
    await stat(file)
  } catch {
    return undefined
  }
  let db: Database | undefined
  try {
    db = new module.DatabaseSync(file, { readOnly: true })
    const known = new Map<string, Set<string>>()
    const columns = (table: string): Set<string> => {
      let set = known.get(table)
      if (set === undefined) {
        set = new Set((db!.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
        known.set(table, set)
      }
      return set
    }
    return read(db, columns)
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

export const stateDb = (home: string): string => join(home, 'state.db')

/** When a persona's database last changed (its write-ahead log moves first). */
export async function dbStamp(home: string): Promise<string> {
  const times = await Promise.all(['state.db', 'state.db-wal'].map((name) => stat(join(home, name)).then((info) => `${info.mtimeMs}:${info.size}`, () => '-')))
  return times.join('|')
}

/** A persona's newest conversations. */
export async function hermesSessions(persona: string, home: string, now = Date.now()): Promise<HermesSession[]> {
  return await withDb(stateDb(home), (db, columns) => {
    const has = columns('sessions')
    const activity = has.has('last_activity_at') ? 'coalesce(last_activity_at, started_at)' : 'started_at'
    // A chat reset leaves an empty session behind: no conversation.
    const filters = [`source not in (${HIDDEN_SOURCES.map(() => '?').join(', ')})`, 'exists (select 1 from messages where messages.session_id = sessions.id)']
    if (has.has('archived')) filters.push('coalesce(archived, 0) = 0')
    if (has.has('hidden')) filters.push('coalesce(hidden, 0) = 0')
    const pick = ['id', 'source', 'title', 'started_at', 'ended_at', 'message_count', 'model', `${activity} as activity`,
      has.has('cwd') ? 'cwd' : 'null as cwd', has.has('git_branch') ? 'git_branch' : 'null as git_branch']
    const rows = db.prepare(`select ${pick.join(', ')} from sessions where ${filters.join(' and ')} order by activity desc limit ${KEEP_SESSIONS}`)
      .all(...HIDDEN_SOURCES) as Array<Record<string, unknown>>
    if (rows.length === 0) return []
    const ids = rows.map((row) => String(row.id))
    const marks = ids.map(() => '?').join(', ')
    // Each one's last message (whose move it is) and last words (the line under its title).
    const lastAny = new Map((db.prepare(`select session_id, role, tool_calls is not null as calls, timestamp from messages where id in (select max(id) from messages where session_id in (${marks}) group by session_id)`)
      .all(...ids) as Array<{ session_id: string; role: string; calls: number; timestamp: number }>).map((row) => [row.session_id, row]))
    const lastText = new Map((db.prepare(`select session_id, substr(content, 1, 400) as content from messages where id in (select max(id) from messages where session_id in (${marks}) and role in ('user', 'assistant') and content is not null and content <> '' group by session_id)`)
      .all(...ids) as Array<{ session_id: string; content: string }>).map((row) => [row.session_id, row.content]))
    return rows.map((row): HermesSession => {
      const id = String(row.id)
      const last = lastAny.get(id)
      const startedAt = ms(row.started_at) ?? 0
      const updatedAt = Math.max(ms(row.activity) ?? startedAt, ms(last?.timestamp) ?? 0)
      const ended = row.ended_at !== null && row.ended_at !== undefined
      // A prompt or a tool step with nothing after it, recently: the persona is at it.
      const waiting = !ended && last !== undefined && (last.role === 'user' || last.role === 'tool' || (last.role === 'assistant' && last.calls === 1)) && now - updatedAt < 10 * 60_000
      const text = lastText.get(id)
      const cwd = str(row.cwd)
      const branch = str(row.git_branch)
      const model = str(row.model)
      const title = str(row.title)
      return {
        id, persona, source: String(row.source), startedAt, updatedAt, ended, waiting,
        messages: typeof row.message_count === 'number' ? row.message_count : 0,
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(branch === undefined ? {} : { branch }),
        ...(model === undefined ? {} : { model }),
        ...(text === undefined ? {} : { last: preview(text) }),
      }
    })
  }) ?? []
}

/** A conversation's messages, oldest first: prompts, answers, and each tool call as a line. Compressed-away messages are kept. */
export async function hermesTurns(home: string, id: string): Promise<Turn[] | undefined> {
  return await withDb(stateDb(home), (db, columns) => {
    const has = columns('messages')
    const live = has.has('active') && has.has('compacted') ? ' and (active = 1 or compacted = 1)' : ''
    const rows = db.prepare(`select role, content, tool_calls, timestamp from messages where session_id = ?${live} order by id`).all(id) as Array<{ role: string; content: string | null; tool_calls: string | null; timestamp: number }>
    const turns: Turn[] = []
    for (const row of rows) {
      const at = ms(row.timestamp)
      const stamp = at === undefined ? {} : { at }
      const content = row.content?.trim() ?? ''
      if (row.role === 'user' && content !== '') turns.push({ role: 'user', text: content.length > TEXT_MAX ? `${content.slice(0, TEXT_MAX - 1)}…` : content, ...stamp })
      if (row.role !== 'assistant') continue
      if (content !== '') turns.push({ role: 'assistant', text: content.length > TEXT_MAX ? `${content.slice(0, TEXT_MAX - 1)}…` : content, ...stamp })
      if (row.tool_calls === null) continue
      try {
        for (const call of JSON.parse(row.tool_calls) as Array<{ function?: { name?: unknown; arguments?: unknown } }>) {
          const name = call.function?.name
          if (typeof name !== 'string') continue
          let input: Record<string, unknown> | undefined
          try {
            input = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) as Record<string, unknown> : undefined
          } catch { /* Not JSON: the name alone. */ }
          turns.push({ role: 'tool', text: toolOf(name, input), ...stamp })
        }
      } catch { /* Unreadable calls: skipped. */ }
    }
    return turns
  })
}
