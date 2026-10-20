/** Authenticated RPC + bounded streaming carrier and explicit-reference preparation. */
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type { DiscussionEvent } from './types.ts'
import { DISCUSSION_METHOD, DISCUSSION_STREAM } from './types.ts'
import { DiscussionService, type DiscussionHost, type DiscussionMessage } from './service.ts'
interface Connection {
  fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => void }
}
interface Context {
  get(name: string): unknown
  on(event: 'agent/pre-step', listener: (event: { agent: { id: string; session?: { id?: string } } }, next: () => Promise<{ kind: string; messages?: readonly DiscussionMessage[] }>) => Promise<unknown>, options: { prepend: boolean }): () => void
}
export function discussionEvents(ctx: Pick<Context, 'get'>): DiscussionHost['events'] {
  return async (sessionId) => {
    const sessions = ctx.get('sessionController') as { resolveAgent(id: string): Promise<{ agent?: { session?: { snapshotEvents(): readonly unknown[] } }; error?: unknown }> } | undefined
    if (sessions === undefined) throw new Error('Session service is unavailable')
    const result = await sessions.resolveAgent(sessionId)
    if (result.agent?.session === undefined) throw new Error('Session not found')
    return result.agent.session.snapshotEvents()
  }
}
export function mountDiscussions(ctx: Context, connection: Connection, host: DiscussionHost): () => void {
  const service = new DiscussionService(host)
  const streams = new Set<() => void>()
  const register = (method: string, streaming: boolean): (() => void) => connection.fetch.register({
    path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let raw: unknown
      try { raw = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
      const envelope = clientRequestSchema.safeParse(raw)
      if (!envelope.success || envelope.data.method !== method) return new Response('Invalid RPC envelope', { status: 400 })
      const payload = (envelope.data.payload ?? {}) as Record<string, unknown>
      if (!streaming) {
        let result: unknown
        try { result = { ok: true, value: await service.handle(payload) } }
        catch (error) { result = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: { issues: [] } } } }
        return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result })
      }
      if (typeof payload.sessionId !== 'string') return new Response('Missing session', { status: 400 })
      // Validate before publishing streaming response headers.
      try { await service.check(payload.sessionId) } catch { return new Response('Session unavailable', { status: 404 }) }
      const encoder = new TextEncoder()
      let off: (() => void) | undefined
      let ended = false
      let close = (): void => { ended = true; off?.() }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          close = () => {
            if (ended) return
            ended = true
            off?.()
            streams.delete(close)
            request.signal.removeEventListener('abort', close)
            try { controller.close() } catch { /* Already cancelled by the consumer. */ }
          }
          streams.add(close)
          const emit = (event: DiscussionEvent): void => {
            if (ended) return
            // A stalled reader reconnects from a snapshot instead of retaining an unbounded queue.
            if ((controller.desiredSize ?? 0) < -65_536) { close(); return }
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          }
          request.signal.addEventListener('abort', close, { once: true })
          if (request.signal.aborted) { close(); return }
          void service.watch(payload.sessionId as string, emit).then((dispose) => {
            off = dispose
            if (ended) dispose()
          }, (error: unknown) => { emit({ type: 'error', message: String(error) }); close() })
        },
        cancel() { close() },
      }, { highWaterMark: 65_536, size: (chunk) => chunk.byteLength })
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
    },
  })
  const offRpc = register(DISCUSSION_METHOD, false)
  const offStream = register(DISCUSSION_STREAM, true)
  const offStep = ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || decision.messages === undefined) return decision
    return { ...decision, messages: await service.prepare(agent.session?.id ?? agent.id, decision.messages) }
  }, { prepend: true })
  return () => {
    offStep(); offRpc(); offStream()
    for (const close of streams) close()
    void service.dispose().catch((error: unknown) => host.log(String(error)))
  }
}
