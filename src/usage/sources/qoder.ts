/**
 * Qoder CLI CN credits. The CLI keeps its login and its API traffic behind its
 * own encryption, so the hub does not call Qoder itself: it reads what the CLI
 * logged. Each interactive `qodercn` start (and each `/usage`) fetches
 * `/api/v2/quota/usage` and writes the whole response to its run log; the
 * newest such line is the snapshot, dated by the line. Logs are read
 * incrementally, and only those of interactive runs (`--acp`, `-p`, the
 * remote-control daemon and subcommands never fetch the quota).
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findQoder } from '../../qoder/cli.ts'
import { DAY, isRecord, num } from './http.ts'
import type { PlanQuota, QuotaWindow } from '../types.ts'

const NEEDLE = Buffer.from('/api/v2/quota/usage response: ')
const NEWLINE = 0x0a
/** Runs untouched for longer than this are not opened (the CLI prunes its logs too). */
const MAX_AGE_MS = 60 * DAY
/** An expiry this far out is the service's "never" (it sends 9999-12-31). */
const NEVER_MS = 50 * 365 * DAY
const NOT_INTERACTIVE = new Set(['-p', '--print', '--acp', '--remote-control', '--list-models', '--list-sessions', '-v', '--version', '-h', '--help'])
const SUBCOMMANDS = new Set(['mcp', 'plugins', 'plugin', 'skills', 'skill', 'hooks', 'hook', 'agents', 'agent', 'login', 'rollback', 'update',
  'status', 'config', 'commit', 'feedback', 'security', 'remote-control', 'sites', 'wiki'])

/** Whether a run's argv (after the runtime and script) is the interactive TUI, the only mode that fetches the quota. */
export function interactive(args: readonly string[]): boolean {
  if (args.some((arg) => NOT_INTERACTIVE.has(arg))) return false
  const first = args.find((arg) => !arg.startsWith('-'))
  return first === undefined || !SUBCOMMANDS.has(first)
}

interface Snapshot { at: number; body: unknown }

/** The last quota response in a chunk of complete log lines. */
export function lastSnapshot(chunk: Buffer): Snapshot | undefined {
  let index = chunk.lastIndexOf(NEEDLE)
  while (index !== -1) {
    const start = chunk.lastIndexOf(NEWLINE, index) + 1
    const endAt = chunk.indexOf(NEWLINE, index)
    const line = chunk.subarray(start, endAt === -1 ? chunk.length : endAt).toString('utf8')
    const at = Date.parse(line.slice(0, line.indexOf(' ')))
    try {
      const body: unknown = JSON.parse(line.slice(line.indexOf(NEEDLE.toString()) + NEEDLE.length))
      if (Number.isFinite(at)) return { at, body }
    } catch { /* a truncated line: try the one before */ }
    index = start === 0 ? -1 : chunk.lastIndexOf(NEEDLE, start - 1)
  }
  return undefined
}

const pool = (value: unknown): { used: number; total: number } | undefined => {
  if (!isRecord(value)) return undefined
  const total = num(value.total) ?? num(value.cap) ?? 0
  if (total <= 0 || value.available === false) return undefined
  return { used: Math.max(0, num(value.used) ?? total - (num(value.remaining) ?? total)), total }
}

const credits = (key: string, used: number, total: number, label?: string, resetsAt?: number): QuotaWindow => ({
  key, usedPercent: Math.min(100, (used / total) * 100), used, limit: total, unit: 'credits',
  ...(label === undefined ? {} : { label }),
  ...(resetsAt === undefined ? {} : { resetsAt }),
})

/** `personal_standard` → `standard`. */
const planOf = (userType: unknown): string | undefined =>
  typeof userType === 'string' && userType !== '' ? userType.replace(/^personal_/, '').replace(/_/g, ' ') : undefined

/** One credit pool per window: the plan's own, add-on packs, the organization's shared pool, dedicated packages. */
export function quotaOf(body: unknown, at: number): PlanQuota {
  if (!isRecord(body)) return { id: 'qoder', provider: 'qoder', windows: [], fetchedAt: at, error: { code: 'incompatible' } }
  const windows: QuotaWindow[] = []
  for (const [key, field, alias] of [['plan', 'userQuota', 'user_quota'], ['addon', 'addOnQuota', 'add_on_quota'], ['shared', 'orgResourcePackage', 'sharedQuota']] as const) {
    const found = pool(body[field] ?? body[alias])
    if (found !== undefined) windows.push(credits(key, found.used, found.total))
  }
  const dedicated = body.dedicatedResourcePackages ?? body.dedicated_resource_packages
  if (Array.isArray(dedicated)) {
    for (const item of dedicated) {
      const found = pool(item)
      if (found === undefined || !isRecord(item)) continue
      const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : undefined
      const expires = num(item.expiresAt ?? item.expires_at)
      windows.push(credits('custom', found.used, found.total, name, expires !== undefined && expires > 0 ? expires : undefined))
    }
  }
  const total = num(body.totalUsagePercentage ?? body.total_usage_percentage)
  if (windows.length === 0 && total !== undefined) {
    windows.push({ key: 'custom', usedPercent: Math.min(100, total <= 1 ? total * 100 : total) })
  }
  const expiresAt = num(body.expiresAt ?? body.expires_at)
  const plan = planOf(body.userType ?? body.user_type)
  return {
    id: 'qoder',
    provider: 'qoder',
    ...(plan === undefined ? {} : { plan }),
    ...(expiresAt !== undefined && expiresAt > 0 && expiresAt - at < NEVER_MS ? { expiresAt } : {}),
    windows,
    fetchedAt: at,
    snapshot: true,
    ...(windows.length === 0 ? { error: { code: 'incompatible' as const, message: 'no credit pool in the response' } } : {}),
  }
}

interface Run { mtimeMs: number; offset: number; interactive?: boolean; hit?: Snapshot }

export interface QoderReaderOptions {
  root?: string
  installed?: () => boolean
  now?: () => number
}

/** A reader that remembers how far it read each run's log, so a poll reads only what was appended. */
export function qoderReader(options: QoderReaderOptions = {}): () => Promise<PlanQuota[]> {
  const root = options.root ?? join(homedir(), '.qoder-cn', 'logs', 'runs')
  const installed = options.installed ?? (() => findQoder() !== undefined)
  const now = options.now ?? Date.now
  const runs = new Map<string, Run>()

  const isInteractive = async (dir: string): Promise<boolean> => {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      const argv = isRecord(manifest) && Array.isArray(manifest.argv) ? manifest.argv.filter((arg): arg is string => typeof arg === 'string') : undefined
      return argv !== undefined && interactive(argv.slice(2))
    } catch {
      return false
    }
  }

  const scan = async (name: string, mtimeMs: number, size: number): Promise<void> => {
    const dir = join(root, name)
    let run = runs.get(name)
    if (run === undefined) {
      run = { mtimeMs: 0, offset: 0, interactive: await isInteractive(dir) }
      runs.set(name, run)
    }
    if (!run.interactive || (run.mtimeMs === mtimeMs && run.offset >= size)) return
    run.mtimeMs = mtimeMs
    if (size < run.offset) run.offset = 0
    const handle = await open(join(dir, 'qodercli.log'), 'r')
    try {
      const chunk = Buffer.alloc(size - run.offset)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, run.offset)
      const complete = chunk.lastIndexOf(NEWLINE, bytesRead - 1) + 1
      const hit = lastSnapshot(chunk.subarray(0, complete))
      if (hit !== undefined) run.hit = hit
      run.offset += complete
    } finally {
      await handle.close()
    }
  }

  return async () => {
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      return installed() ? [{ id: 'qoder', provider: 'qoder', windows: [], fetchedAt: 0, error: { code: 'no-data' } }] : []
    }
    const cutoff = now() - MAX_AGE_MS
    const seen = new Set<string>()
    await Promise.all(names.map(async (name) => {
      try {
        const info = await stat(join(root, name, 'qodercli.log'))
        if (info.mtimeMs < cutoff && !runs.has(name)) return
        seen.add(name)
        await scan(name, info.mtimeMs, info.size)
      } catch { /* a run being pruned or still starting */ }
    }))
    for (const name of runs.keys()) if (!seen.has(name)) runs.delete(name)
    let latest: Snapshot | undefined
    for (const run of runs.values()) if (run.hit !== undefined && (latest === undefined || run.hit.at > latest.at)) latest = run.hit
    if (latest !== undefined) return [quotaOf(latest.body, latest.at)]
    return installed() ? [{ id: 'qoder', provider: 'qoder', windows: [], fetchedAt: 0, error: { code: 'no-data' } }] : []
  }
}
