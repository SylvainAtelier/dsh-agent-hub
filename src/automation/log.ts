import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LogEvent = Record<string, unknown>
const MAX_BYTES = 512 * 1024
const MAX_LINE = 6000

/** Control characters would let a script forge extra log lines; keep one event per line. */
const clean = (value: unknown): unknown => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, 4000) : value

/**
 * Append-only JSON-lines trace of script task runs (one file, one rotated backup).
 * Logging is strictly best effort: it never throws into, delays, or changes a run.
 */
export function createRunLog(file: string, now: () => Date = () => new Date()): (event: LogEvent) => void {
  let tail: Promise<void> = Promise.resolve()
  return (event) => {
    const line = `${JSON.stringify({ ts: now().toISOString(), ...Object.fromEntries(Object.entries(event).map(([key, value]) => [key, clean(value)])) }).slice(0, MAX_LINE)}\n`
    tail = tail.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const size = await stat(file).then((entry) => entry.size, () => 0)
      if (size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => {})
      await appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
    }).catch(() => {})
  }
}
