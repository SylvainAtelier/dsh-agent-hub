export interface Rpc {
  call(channel: string, method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

type Envelope<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } } | undefined

/**
 * Unwrap DSH's transport envelope; a failed one becomes `failed(message)`. Modules whose replies
 * carry their own failures (`{ ok, value | error }`) map it into that shape instead of throwing.
 */
export async function rpcReply<T>(rpc: Rpc, method: string, payload: unknown, failure: string, failed: (message: string) => T, signal?: AbortSignal): Promise<T> {
  const response = await rpc.call('/api', method, payload, signal) as Envelope<T>
  return response?.ok === true ? response.value : failed(response?.error?.message ?? failure)
}

/** Unwrap only DSH's transport envelope; domain replies remain owned by their modules. */
export function rpcValue<T>(rpc: Rpc, method: string, payload: unknown, failure: string, signal?: AbortSignal): Promise<T> {
  return rpcReply<T>(rpc, method, payload, failure, (message) => { throw new Error(message) }, signal)
}
