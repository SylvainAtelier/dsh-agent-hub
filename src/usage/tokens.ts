/**
 * Token ledger: every model call DSH's session logs record, summed per day,
 * provider route and model.
 *
 * The logs are the source. Each `assistant/message` (and compaction summary)
 * carries the provider's usage in DSH's normalized split; Claude Agent and
 * Cursor replies carry cumulative per-model totals in their replay state
 * instead (see claude/translate.ts, cursor/translate.ts), and each reply
 * counts the difference from the one before it.
 *
 * Reading is incremental. A log is a stream of zstd frames that only grows, so
 * an entry remembers how many bytes it has folded and reads only what follows.
 * A shorter or moved file is read again from the start; an entry's numbers are
 * always a function of its file's content, never added twice.
 *
 * Entries are persisted, and an entry whose log is gone stays: that is the
 * ledger of deleted sessions. {@link TokenLedger.capture} runs just before DSH
 * deletes a log, so its last lines are folded first.
 *
 * Some calls never reach a log under the model that answered them: a Claude
 * Agent session's background requests (titles, compaction), which another
 * model answers, and the git pane's commit messages. Their streams pass
 * through {@link metered}, and {@link TokenLedger.record} folds the usage
 * into one more entry that has no log.
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../persistence.ts'
import { BOT_ROUTE, botReplay } from '../team/types.ts'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import type { TokenCounts, TokenRow, TokenUsage } from './types.ts'

const inflate = promisify(zstdDecompress)

/** Logs are re-listed at most this often; a forced read waits at most for the floor. */
const SCAN_TTL_MS = 5_000
const FORCE_FLOOR_MS = 1_000
/** A deletion never waits longer than this for its log to be folded. */
const CAPTURE_TIMEOUT_MS = 3_000
const VERSION = 1
/** The entry of calls recorded as they stream; no session directory has this name. */
const DIRECT = '@direct'
/** Claude Agent's and Cursor's routes: their compaction is answered by another model and recorded directly. */
const DELEGATING_ROUTES: readonly string[] = ['claude-agent', 'cursor-agent']

// ---------------------------------------------------------------------------
// zstd frames

const ZSTD_MAGIC = 0xfd2fb528

/** End offset of the zstd frame at `start`, or undefined when it is torn or not a frame. */
function zstdFrameEnd(bytes: Uint8Array, start: number): number | undefined {
  let at = start + 4
  if (at >= bytes.length) return undefined
  const descriptor = bytes[at++]!
  const sizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  if (singleSegment === 0) at += 1
  at += [0, 1, 2, 4][descriptor & 3]!
  at += sizeFlag === 0 ? singleSegment : [0, 2, 4, 8][sizeFlag]!
  for (;;) {
    if (at + 3 > bytes.length) return undefined
    const header = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
    at += 3
    const type = (header >> 1) & 3
    if (type === 3) return undefined
    // An RLE block stores one byte however long it decodes.
    at += type === 1 ? 1 : header >>> 3
    if (at > bytes.length) return undefined
    if ((header & 1) === 1) break
  }
  if (checksum === 1) at += 4
  return at <= bytes.length ? at : undefined
}

/**
 * The complete frames at the head of `bytes`, as `[start, end)` ranges.
 * Skippable frames are stepped over; scanning stops at a torn tail or at
 * anything that is not a frame, which a later read retries.
 */
export function completeFrames(bytes: Uint8Array): Array<[number, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frames: Array<[number, number]> = []
  let at = 0
  while (at + 4 <= bytes.length) {
    const magic = view.getUint32(at, true)
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      if (at + 8 > bytes.length) break
      const end = at + 8 + view.getUint32(at + 4, true)
      if (end > bytes.length) break
      at = end
      continue
    }
    if (magic !== ZSTD_MAGIC) break
    const end = zstdFrameEnd(bytes, at)
    if (end === undefined) break
    frames.push([at, end])
    at = end
  }
  return frames
}

// ---------------------------------------------------------------------------
// Folding events

/** `[input, output, cacheRead, cacheWrite]` */
type Tuple = [number, number, number, number]

export interface Entry {
  /** The log; absent once the session was deleted, which makes the entry part of the ledger. */
  file?: string
  /** Bytes folded: the end of the last complete frame. */
  size: number
  /** The log's mtime when it was last read; the same size with a new mtime means it was rewritten. */
  mtime?: number
  /** Text after the last newline, should a line ever span frames. */
  rest: string
  /** Inside a seeded log's inherited prefix: those calls belong to the parent's log. */
  seeded: boolean
  /** The route the session last used, for usage records that name none (compaction). */
  route?: [string, string]
  /** Live logs from older accounting rules are rebuilt; deleted-session rows are retained. */
  accounting?: number
  /** Account/session owning the cumulative baseline. */
  claudeIdentity?: string
  /** The last cumulative Claude Agent totals in this log. */
  claude?: Record<string, TokenCounts>
  /** Claude Agent replies from before cumulative totals were stamped were counted as reported. */
  legacyClaude?: boolean
  /** `day \t provider \t model` → counts. */
  rows: Record<string, Tuple>
  since?: number
}

export const emptyEntry = (file?: string): Entry => ({ ...(file === undefined ? {} : { file }), size: 0, rest: '', seeded: false, rows: {}, accounting: 2 })

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar day, `YYYY-MM-DD`. */
export function dayOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

function add(entry: Entry, time: number, provider: string, model: string, tuple: Tuple): void {
  if (tuple.every((value) => value === 0)) return
  const key = `${dayOf(time)}\t${provider}\t${model}`
  const row = entry.rows[key] ??= [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) row[i]! += tuple[i]!
  if (entry.since === undefined || time < entry.since) entry.since = time
}

function countsOf(value: unknown): TokenCounts | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return { input: count(record.input), output: count(record.output), cacheRead: count(record.cacheRead), cacheWrite: count(record.cacheWrite) }
}

/** What one model used since the previous total; a total that went down was reset, so it counts whole. */
function since(current: TokenCounts, previous: TokenCounts | undefined): Tuple {
  const now: Tuple = [current.input, current.output, current.cacheRead, current.cacheWrite]
  if (previous === undefined) return now
  const delta: Tuple = [now[0] - previous.input, now[1] - previous.output, now[2] - previous.cacheRead, now[3] - previous.cacheWrite]
  return delta.some((value) => value < 0) ? now : delta
}

interface LogEvent {
  type?: string
  time?: number
  isSeeded?: boolean
  data?: {
    provider?: string
    model?: string
    usage?: Record<string, unknown>
    message?: { source?: { provider?: string; model?: string; replayState?: unknown } }
  }
}

/** Fold one parsed log event into its entry; shapes it does not know are ignored. */
export function fold(entry: Entry, parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) return
  const event = parsed as LogEvent
  switch (event.type) {
    case 'session':
      entry.seeded = event.isSeeded === true
      return
    case 'session/end-seed':
      entry.seeded = false
      return
    case 'model/selection':
      if (typeof event.data?.provider === 'string' && typeof event.data.model === 'string') entry.route = [event.data.provider, event.data.model]
      return
    case 'compaction/summary':
      // The model that wrote it already recorded the call (see the delegate in index.ts).
      if (DELEGATING_ROUTES.includes(event.data?.provider ?? '')) return
  }
  const usage = event.data?.usage
  if (typeof usage !== 'object' || usage === null || typeof event.time !== 'number') return
  const outer = event.data?.message?.source
  const wrapped = outer?.provider === BOT_ROUTE ? botReplay(outer.replayState) : undefined
  const source = wrapped === undefined ? outer : { ...outer, ...wrapped.via, replayState: wrapped.state }
  if (typeof source?.provider === 'string' && typeof source.model === 'string') entry.route = [source.provider, source.model]
  // Claude Agent and Cursor replies carry the same cumulative per-model totals.
  const replay = source?.replayState as { claude?: { session?: string; account?: string; total?: unknown }; cursor?: { session?: string; total?: unknown } } | undefined
  const external = replay?.claude ?? replay?.cursor
  const claude = external !== null && typeof external === 'object' ? external as { session?: string; account?: string; total?: unknown } : undefined
  const identity = claude === undefined ? undefined : JSON.stringify([claude.account ?? 'default', claude.session])
  if (identity !== undefined && entry.claudeIdentity !== undefined && identity !== entry.claudeIdentity) {
    delete entry.claude
    delete entry.legacyClaude
  }
  if (identity !== undefined) entry.claudeIdentity = identity
  const total = claude?.total
  if (source?.provider !== undefined && typeof total === 'object' && total !== null) {
    const current: Record<string, TokenCounts> = {}
    for (const [model, value] of Object.entries(total)) {
      const counts = countsOf(value)
      if (counts !== undefined) current[model] = counts
    }
    const previous = entry.claude
    entry.claude = current
    // A session that already counted Claude replies as reported takes its first total as the baseline.
    if (entry.seeded || (previous === undefined && entry.legacyClaude === true)) return
    for (const [model, counts] of Object.entries(current)) add(entry, event.time, source.provider, model, since(counts, previous?.[model]))
    return
  }

  if (claude !== undefined) entry.legacyClaude = true
  if (entry.seeded) return
  const [provider, model] = typeof source?.provider === 'string'
    ? [source.provider, typeof source.model === 'string' ? source.model : 'unknown']
    : entry.route ?? ['unknown', 'unknown']
  add(entry, event.time, provider, model, [count(usage.inputTokens), count(usage.outputTokens), count(usage.cacheReadTokens), count(usage.cacheWriteTokens)])
}

/** Only these lines can change an entry; the rest are skipped unparsed. */
const relevant = (line: string): boolean =>
  line.includes('"usage"') || line.includes('"type":"session"') || line.includes('"session/end-seed"') || line.includes('"model/selection"')

/** Fold decoded log text; a trailing partial line waits in `rest`. */
export function foldText(entry: Entry, text: string): void {
  const lines = (entry.rest + text).split('\n')
  entry.rest = lines.pop() ?? ''
  for (const line of lines) {
    if (!relevant(line)) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    fold(entry, event)
  }
}

// ---------------------------------------------------------------------------
// Files

const LOG = /^session\.v(\d+)\.jsonl\.zstd$/
/** Directory reads and log reads in flight at once: a few hundred sessions cost a few round trips, not hundreds. */
const PARALLEL = 8

/** Run `fn` over `items`, at most PARALLEL at a time; the first failure rejects once the rest in flight settle. */
export async function eachLimited<T>(items: Iterable<T>, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  let failure: { error: unknown } | undefined
  const worker = async (): Promise<void> => {
    while (queue.length > 0 && failure === undefined) {
      try {
        await fn(queue.shift()!)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker))
  if (failure !== undefined) throw failure.error
}

/** Every session's current log under `root/<project>/<session dir>/`, the highest format version winning. */
export async function listLogs(root: string): Promise<Map<string, string>> {
  const logs = new Map<string, { path: string; version: number }>()
  const dirs = async (path: string): Promise<string[]> => {
    try {
      return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }
  const sessions: Array<[project: string, session: string]> = []
  await eachLimited(await dirs(root), async (project) => {
    // `session-<uuid>` for top-level sessions, the bare id for subagents.
    for (const session of await dirs(join(root, project))) sessions.push([project, session])
  })
  await eachLimited(sessions, async ([project, session]) => {
    let names: string[]
    try {
      names = await readdir(join(root, project, session))
    } catch {
      return
    }
    for (const name of names) {
      const version = Number(LOG.exec(name)?.[1])
      if (!Number.isInteger(version)) continue
      const known = logs.get(session)
      if (known === undefined || version > known.version) logs.set(session, { path: join(root, project, session, name), version })
    }
  })
  return new Map([...logs].map(([id, { path }]) => [id, path]))
}

/**
 * Bring an entry up to date with its log. Frames are committed one by one, so
 * a failure leaves the entry consistent at the last good frame.
 */
export async function scanLog(path: string, previous: Entry | undefined): Promise<Entry> {
  const { size, mtimeMs } = await stat(path)
  const rewritten = previous === undefined || previous.accounting !== 2 || previous.file !== path || size < previous.size
    || (size === previous.size && previous.mtime !== undefined && mtimeMs !== previous.mtime)
  const entry = rewritten ? emptyEntry(path) : previous
  entry.mtime = mtimeMs
  if (size === entry.size) return entry
  const bytes = new Uint8Array(size - entry.size)
  const handle = await open(path, 'r')
  try {
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, entry.size + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
  } finally {
    await handle.close()
  }
  const base = entry.size
  for (const [start, end] of completeFrames(bytes)) {
    let text: string
    try {
      text = (await inflate(bytes.subarray(start, end))).toString('utf8')
    } catch {
      break
    }
    foldText(entry, text)
    entry.size = base + end
  }
  return entry
}

// ---------------------------------------------------------------------------
// The ledger

export interface TokenLedger {
  /** The totals, after an incremental scan. Never rejects. */
  read(force?: boolean): Promise<TokenUsage>
  /** Fold a session's log completely; DSH is about to delete it. Never rejects. */
  capture(sessionId: string): Promise<void>
  /** Count one call no session log records under its model. Never rejects. */
  record(provider: string, model: string, usage: Record<string, unknown>): Promise<void>
}

export interface LedgerOptions {
  /** DSH's session log root (`<DSH_HOME>/sessions`). */
  root: string
  /** Where entries persist. */
  file: string
  /** Display names of the registered provider routes. */
  names(): Record<string, string>
  now?: () => number
}

/** Pass a dsh-llm stream through, handing each usage chunk to `record`. */
export async function* metered<T>(chunks: AsyncIterable<T>, record: (usage: Record<string, unknown>) => void): AsyncGenerator<T> {
  for await (const chunk of chunks) {
    const usage = (chunk as { type?: unknown; usage?: unknown }).type === 'usage' ? (chunk as { usage?: unknown }).usage : undefined
    if (typeof usage === 'object' && usage !== null) record(usage as Record<string, unknown>)
    yield chunk
  }
}

/** Sum every entry into wire rows. */
export function totals(entries: Iterable<Entry>): { rows: TokenRow[]; since?: number } {
  const sums = new Map<string, Tuple>()
  let first: number | undefined
  for (const entry of entries) {
    if (entry.since !== undefined && (first === undefined || entry.since < first)) first = entry.since
    for (const [key, tuple] of Object.entries(entry.rows)) {
      const sum = sums.get(key)
      if (sum === undefined) sums.set(key, [...tuple])
      else for (let i = 0; i < 4; i++) sum[i]! += tuple[i]!
    }
  }
  const rows = [...sums].map(([key, [input, output, cacheRead, cacheWrite]]): TokenRow => {
    const [day = '', provider = '', model = ''] = key.split('\t')
    return { day, provider, model, input, output, cacheRead, cacheWrite }
  })
  return { rows, ...(first === undefined ? {} : { since: first }) }
}

export function createTokenLedger(options: LedgerOptions): TokenLedger {
  const now = options.now ?? Date.now
  let entries = new Map<string, Entry>()
  let scannedAt = 0
  let error: string | undefined
  let written = ''

  const loaded = readFile(options.file, 'utf8').then((text) => {
    const stored = JSON.parse(text) as { version?: number; entries?: Record<string, Entry> }
    if (stored.version === VERSION && typeof stored.entries === 'object' && stored.entries !== null) entries = new Map(Object.entries(stored.entries))
    written = text
  }, () => {})

  const persist = async (): Promise<void> => {
    const text = JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) })
    if (text === written) return
    await atomicWriteJson(options.file, { version: VERSION, entries: Object.fromEntries(entries) })
    written = text
  }

  // Scans and captures run one at a time: both rewrite entries.
  let chain: Promise<unknown> = loaded
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  const scan = (ttl: number): Promise<void> => serial(async () => {
    if (now() - scannedAt < ttl) return
    const logs = await listLogs(options.root)
    await eachLimited(logs, async ([id, path]) => { entries.set(id, await scanLog(path, entries.get(id))) })
    for (const [id, entry] of entries) {
      if (logs.has(id) || entry.file === undefined) continue
      // The log is gone: keep what it used, drop the rest.
      if (Object.keys(entry.rows).length === 0) entries.delete(id)
      else entries.set(id, { size: entry.size, rest: '', seeded: false, rows: entry.rows, ...(entry.since === undefined ? {} : { since: entry.since }) })
    }
    scannedAt = now()
    await persist()
  })

  return {
    async read(force = false) {
      try {
        await scan(force ? FORCE_FLOOR_MS : SCAN_TTL_MS)
        error = undefined
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      let providers: Record<string, string> = {}
      try {
        providers = options.names()
      } catch {
        // Names are cosmetic; ids stand in.
      }
      return {
        ...totals(entries.values()),
        providers,
        today: dayOf(now()),
        ...(error === undefined ? {} : { error: { code: 'failed' as const, message: error } }),
      }
    },
    async capture(sessionId) {
      const task = serial(async () => {
        const path = entries.get(sessionId)?.file ?? (await listLogs(options.root)).get(sessionId)
        if (path === undefined) return
        entries.set(sessionId, await scanLog(path, entries.get(sessionId)))
        await persist()
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, CAPTURE_TIMEOUT_MS) })
      try {
        await Promise.race([task, timeout])
      } catch {
        // The ledger keeps what earlier scans folded.
      } finally {
        clearTimeout(timer)
      }
    },
    async record(provider, model, usage) {
      try {
        await serial(async () => {
          const entry = entries.get(DIRECT) ?? emptyEntry()
          add(entry, now(), provider, model, [count(usage.inputTokens), count(usage.outputTokens), count(usage.cacheReadTokens), count(usage.cacheWriteTokens)])
          entries.set(DIRECT, entry)
          await persist()
        })
      } catch {
        // The row stays in memory; the next scan persists it.
      }
    },
  }
}
