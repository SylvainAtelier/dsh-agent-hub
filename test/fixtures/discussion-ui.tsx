/** Offline real-browser fixture: exercises the public slots without credentials or model calls. */
import { createRoot } from 'react-dom/client'
import { useSyncExternalStore } from 'react'
import { applyDiscussions, type DiscussionContext } from '../../src/client/discussion/index.tsx'
import { DiscussionPanel } from '../../src/client/discussion/Panel.tsx'
import { injectBaseStyle } from '../../src/client/theme/base.ts'
import type { DiscussionEvent, DiscussionState } from '../../src/discussion/types.ts'

const globals = globalThis as unknown as { require: { async(path: string): Promise<unknown> }; fixture: { state: DiscussionState; draft: string; calls: string[]; mainSends: number }; ready: Promise<void> }
globals.require = { async: async () => ({ DiscussionPanel }) }
const state: DiscussionState = { boot: 'fixture', revision: 0, enabled: true, sent: {}, threads: [], defaultRoute: { provider: 'fixture', model: 'small-model' } }
const fixture = globals.fixture = { state, draft: '', calls: [] as string[], mainSends: 0 }
const listeners = new Set<() => void>()
let input = { draft: '', phase: 'plain', occurrences: [] }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const writes = () => { fixture.draft = input.draft; for (const listener of listeners) listener() }
const streams = new Set<(event: DiscussionEvent) => void>()
const publish = (event: DiscussionEvent) => { for (const stream of streams) stream(event) }
const rpc = { async call(_channel: string, _method: string, payload: unknown) {
  const request = payload as Record<string, unknown>
  fixture.calls.push(String(request.op))
  if (request.op === 'create') state.threads.push({ id: String(request.id), quote: String(request.quote), source: String(request.source), route: { provider: 'fixture', model: 'small-model' }, turns: [], confirmed: 0, createdAt: Date.now() })
  const thread = state.threads.find((item) => item.id === request.id)
  if (request.op === 'ask' && thread !== undefined) {
    const turn = { id: String(request.requestId), question: String(request.question), answer: '', status: 'running' as 'running' | 'complete' }
    thread.turns.push(turn)
    setTimeout(() => {
      turn.answer = '**A concise answer.**\n\n```ts\nconst selected = true\n```\n\n![external](https://invalid.example/not-loaded)'
      turn.status = 'complete'
      state.revision++
      publish({ type: 'turn', boot: state.boot, revision: state.revision, id: thread.id, turn: structuredClone(turn) })
    }, 80)
  }
  if (request.op === 'stage' && thread !== undefined) thread.confirmed = Number(request.through)
  state.revision++
  publish({ type: 'state', state: structuredClone(state) })
  const response = { ok: true, value: structuredClone(state) }
  if (request.op === 'ask') await new Promise((resolve) => setTimeout(resolve, 160))
  return response
} }
globalThis.fetch = async (url, init) => {
  if (String(url) !== '/api/agent-hub/discussion-stream') throw new Error('Unexpected network request')
  let send!: (event: DiscussionEvent) => void
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (event) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`))
      streams.add(send)
      send({ type: 'state', state: structuredClone(state) })
      init?.signal?.addEventListener('abort', () => { streams.delete(send); controller.close() }, { once: true })
    }, cancel() { streams.delete(send) },
  })
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
}
const actions = { captureInsertion: () => ({ start: input.draft.length, end: input.draft.length, draftRev: 1 }) }
const scope = { bail(_subject: unknown, event: string, payload: unknown) {
  if (event !== 'slash/input-insert-reference') return false
  const request = payload as { span: { start: number; end: number }; reference: { clipboardText: string } }
  input = { ...input, draft: input.draft.slice(0, request.span.start) + request.reference.clipboardText + ' ' + input.draft.slice(request.span.end) }
  writes()
  return true
} }
const entries = new Map<string, { component: React.ComponentType<Record<string, unknown>>; entry: { inject?(): object } }>()
const disposers: Array<() => void> = []
const ctx = {
  get(name: string) { return name === 'connection' ? { rpc } : name === 'sessions' ? { scope: () => scope } : name === 'inputTriggers' ? { registerSource: () => () => {} } : undefined },
  effect(body: () => () => void) { disposers.push(body()) },
  inject(deps: string[], body: (ctx: unknown) => void) { if (deps.includes('inputTriggers')) body(ctx) },
  slots: {
    inject(_name: string, body: () => () => void) { disposers.push(body()) },
    register(entry: { id: string; inject?(): object }, component: React.ComponentType<Record<string, unknown>>) { entries.set(entry.id, { component, entry }); return () => {} },
  },
}
injectBaseStyle()
applyDiscussions(ctx as unknown as DiscussionContext, () => {})
const snapshot = () => input
function App() {
  const current = useSyncExternalStore(subscribe, snapshot)
  const dock = entries.get('dsh-agent-hub.discussions')!
  const overlay = entries.get('dsh-agent-hub.discussion-overlay')!
  const Dock = dock.component
  const Overlay = overlay.component
  return <><main id="main" style={{ maxWidth: 760, margin: '20px auto', padding: 16 }}><h1>Conversation fixture</h1><div data-conversation-session="session" data-conversation-region="chat">
    <div data-chat-flow-kind="assistant-step" data-chat-node-key="message:7"><p id="quote">This is the selected conversation text.</p><p>The rest of the main conversation stays independent.</p></div>
    <div data-conversation-region="composer"><Dock sessionId="session" inputActions={actions} useInput={(select: (value: unknown) => unknown) => select(current)} useSession={(select: (value: unknown) => unknown) => select({ running: false })} {...dock.entry.inject?.()} />
      <textarea id="main-composer" aria-label="Main composer" readOnly value={current.draft} style={{ width: '100%', minHeight: 90 }} /><button onClick={() => fixture.mainSends++}>Main send</button>
    </div>
  </div></main><Overlay {...overlay.entry.inject?.()} /></>
}
createRoot(document.getElementById('root')!).render(<App />)
globals.ready = new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
window.addEventListener('unload', () => { for (const off of disposers) off() })
