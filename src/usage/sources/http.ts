/** Thrown with the HTTP status so sources can map 401/403 onto `expired`. */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

/**
 * GET a JSON document from the host. The DSH host's http proxy swaps Node's
 * global dispatcher for one that drops automatic decompression, so every
 * host fetch must ask for an identity-encoded body.
 */
export async function getJson(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(url, {
    headers: { ...headers, accept: 'application/json', 'accept-encoding': 'identity', 'cache-control': 'no-store' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new HttpError(response.status)
  return response.json()
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function num(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value))

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

/** Shared window vocabulary from a window length. */
export function windowKey(ms: number | undefined): string {
  if (ms === 5 * HOUR) return '5h'
  if (ms === 7 * DAY) return 'week'
  if (ms === 30 * DAY) return 'month'
  return 'custom'
}
