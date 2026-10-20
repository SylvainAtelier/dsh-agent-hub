/** Per-source TTL/in-flight cache and a persisted last-good snapshot per account. */
import { readFile } from 'node:fs/promises'
import { jsonWriter, type atomicWriteJson } from '../persistence.ts'
import type { PlanQuota, ProviderId, UsageOverview } from './types.ts'

const TTL_MS: Record<ProviderId, number> = { claude: 300_000, codex: 60_000, minimax: 60_000, cursor: 120_000, qoder: 30_000 }
const TOUCHED_TTL_MS = 60_000
const FORCE_FLOOR_MS = 10_000
const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'minimax', 'cursor', 'qoder']
export type Source = (force?: boolean) => Promise<PlanQuota[]>

/** Prune removed accounts only when their directory was successfully read. */
export function mergeWithLast(fresh: PlanQuota[], last: ReadonlyMap<string, PlanQuota>): { quotas: PlanQuota[]; last: Map<string, PlanQuota> } {
  const next = new Map<string, PlanQuota>()
  const expanded = fresh.flatMap((quota) => {
    if (quota.error?.scope !== 'source') return [quota]
    const previous = [...last.values()].filter((item) => item.provider === quota.provider)
    return previous.length === 0 ? [quota] : previous.map((item) => ({ ...item, stale: true, error: quota.error }))
  })
  const quotas = expanded.map((quota) => {
    if (quota.error === undefined) {
      next.set(quota.id, quota)
      return quota
    }
    const previous = last.get(quota.id)
    if (previous === undefined) return quota
    next.set(quota.id, previous)
    return { ...previous, ...(quota.account === undefined ? {} : { account: quota.account }), ...(quota.active === undefined ? {} : { active: quota.active }), stale: true, error: quota.error }
  })
  return { quotas, last: next }
}

export interface Hub {
  overview(force?: boolean): Promise<UsageOverview>
  touch(provider: ProviderId): void
  invalidate(provider: ProviderId): void
}

export function createHub(sources: Partial<Record<ProviderId, Source>>, file?: string, options: {
  log?(message: string): void
  write?: typeof atomicWriteJson
} = {}): Hub {
  interface Entry { at: number; value: Promise<PlanQuota[]>; settled?: PlanQuota[]; previous?: PlanQuota[] }
  const cache = new Map<ProviderId, Entry>()
  const touched = new Set<ProviderId>()
  let last = new Map<string, PlanQuota>()
  const write = file === undefined ? undefined : jsonWriter(file, options.write)
  const log = (error: unknown): void => options.log?.(`usage snapshot: ${error instanceof Error ? error.message : String(error)}`)
  const loaded = file === undefined ? Promise.resolve() : (async () => {
    try {
      const list: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(list) || !list.every((item): item is PlanQuota =>
        item !== null && typeof item === 'object' && typeof item.id === 'string'
        && PROVIDERS.includes(item.provider) && Number.isFinite(item.fetchedAt) && Array.isArray(item.windows)
        && item.windows.every((window: unknown) => window !== null && typeof window === 'object'
          && typeof (window as { key?: unknown }).key === 'string' && Number.isFinite((window as { usedPercent?: number }).usedPercent)))) {
        throw new Error('invalid snapshot')
      }
      last = new Map(list.map((quota) => [quota.id, quota]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(error)
    }
  })()

  const persist = async (): Promise<void> => { await write?.([...last.values()]) }

  const read = (provider: ProviderId, force: boolean): Promise<PlanQuota[]> => {
    const hit = cache.get(provider)
    const now = Date.now()
    const ttl = force ? FORCE_FLOOR_MS : touched.has(provider) ? Math.min(TOUCHED_TTL_MS, TTL_MS[provider]) : TTL_MS[provider]
    // TTL applies to settled data, never to ownership of an in-flight request.
    if (hit !== undefined && (hit.settled === undefined || now - hit.at < ttl)) {
      return !force && hit.settled === undefined && hit.previous !== undefined ? Promise.resolve(hit.previous) : hit.value
    }
    touched.delete(provider)
    const value = Promise.resolve().then(() => sources[provider]?.(force) ?? []).catch((error: unknown): PlanQuota[] => [{
      id: provider, provider, windows: [], fetchedAt: 0,
      error: { code: 'failed', scope: 'source', message: error instanceof Error ? error.message : String(error) },
    }])
    const previous = hit?.settled ?? hit?.previous
    const entry: Entry = { at: now, value, ...(previous === undefined ? {} : { previous }) }
    value.then((quotas) => { entry.settled = quotas; entry.at = Date.now() })
    cache.set(provider, entry)
    return !force && previous !== undefined ? Promise.resolve(previous) : value
  }

  return {
    async overview(force = false) {
      await loaded
      const fresh = (await Promise.all(PROVIDERS.map((provider) => read(provider, force)))).flat()
      const merged = mergeWithLast(fresh, last)
      last = merged.last
      // Best-effort cache persistence must not prevent the live overview from working.
      void persist().catch(log)
      return { quotas: merged.quotas, at: Date.now() }
    },
    touch(provider) { touched.add(provider) },
    invalidate(provider) { cache.delete(provider); touched.delete(provider) },
  }
}
