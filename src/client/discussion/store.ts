/** One lazy stream for the open panel. No polling, model credentials, or per-message listeners. */
import { DISCUSSION_METHOD, DISCUSSION_STREAM, type Discussion, type DiscussionEvent, type DiscussionScope, type DiscussionState } from '../../discussion/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'
/** x/y is the selection end; top and floor let the trigger flip above it when the composer leaves no room below. */
export interface SelectionDraft { sessionId: string; quote: string; source?: string; x: number; y: number; top: number; floor: number; scope?: DiscussionScope }
/** What a page holding discussed documents (the reader) lends the panel for its `doc:` owners. */
export interface DocBridge {
  /** The article's Markdown, so the panel can show what each level sends. */
  markdown(owner: string): string | undefined
  /** Keep a passage of the article (the whole article when `quote` is empty), with a note such as an answer. */
  keep(owner: string, quote: string, note?: string): Promise<void>
  /** Carry the discussion into a new DSH session about the article. */
  continueInSession(owner: string, thread: Discussion): Promise<void>
}
export interface DiscussionSnapshot { state?: DiscussionState; loading: boolean; busy: boolean; error?: string; disconnected: boolean }
export class DiscussionClient {
  private value: DiscussionSnapshot = { loading: false, busy: false, disconnected: false }
  private listeners = new Set<() => void>()
  private stream?: AbortController
  private loading?: Promise<void>
  private generation = 0
  private retiredBoots = new Set<string>()
  private request?: { id: string; question: string; requestId: string }
  private drafts = new Map<string, string>()
  draft(key: string): string { return this.drafts.get(key) ?? '' }
  setDraft(key: string, value: string): void {
    if (value === '') this.drafts.delete(key)
    else this.drafts.set(key, value)
    if (this.drafts.size > 32) this.drafts.delete(this.drafts.keys().next().value!)
  }
  readonly sessionId: string
  private rpc: Rpc
  constructor(sessionId: string, rpc: Rpc) { this.sessionId = sessionId; this.rpc = rpc }
  getSnapshot = (): DiscussionSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<DiscussionSnapshot>): void { this.value = { ...this.value, ...patch }; for (const listener of this.listeners) listener() }
  idle(): boolean { return this.listeners.size === 0 && this.stream === undefined && this.loading === undefined && !this.value.busy }
  private setState(state: DiscussionState): void {
    const current = this.value.state
    if (this.retiredBoots.has(state.boot) || current?.boot === state.boot && current.revision > state.revision) return
    if (current !== undefined && current.boot !== state.boot) this.retiredBoots.add(current.boot)
    const sent = { ...state.sent }
    for (const [id, through] of Object.entries(current?.sent ?? {})) sent[id] = Math.max(sent[id] ?? 0, through)
    this.set({ state: { ...state, sent } })
  }
  private acceptReply(state: DiscussionState, previous: DiscussionState | undefined): void {
    // A response started before a new stream epoch cannot resurrect an unseen old epoch.
    const current = this.value.state
    if (current !== previous && current?.boot !== state.boot) return
    this.setState(state)
  }
  async load(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    const previous = this.value.state
    this.set({ loading: true })
    this.loading = this.call({ op: 'list' }).then((state) => { this.acceptReply(state, previous); this.set({ error: undefined }) }, (error: unknown) => { this.set({ error: String(error) }) }).finally(() => { this.loading = undefined; this.set({ loading: false }) })
    return this.loading
  }
  private call(payload: object): Promise<DiscussionState> { return rpcValue(this.rpc, DISCUSSION_METHOD, { ...payload, sessionId: this.sessionId }, 'Discussion request failed', AbortSignal.timeout(30_000)) }
  async run(payload: object): Promise<DiscussionState> {
    if (this.value.busy) throw new Error('Another discussion operation is still pending')
    const previous = this.value.state
    this.set({ busy: true, error: undefined })
    try {
      const state = await this.call(payload)
      this.acceptReply(state, previous)
      return state
    } catch (error) { this.set({ error: error instanceof Error ? error.message : String(error) }); throw error }
    finally { this.set({ busy: false }) }
  }
  async ask(id: string, question: string, scope?: DiscussionScope): Promise<void> {
    // Reusing the same id after a lost response never creates an extra model turn.
    if (this.request?.id !== id || this.request.question !== question) this.request = { id, question, requestId: crypto.randomUUID() }
    await this.run({ op: 'ask', ...this.request, ...(scope === undefined ? {} : { scope }) })
    this.request = undefined
  }
  receive = (event: DiscussionEvent): void => {
    if (event.type === 'error') { this.set({ error: event.message }); return }
    if (event.type === 'state') { this.setState(event.state); return }
    const state = this.value.state
    if (state === undefined || event.boot !== state.boot || event.revision <= state.revision) return
    if (!state.threads.some((thread) => thread.id === event.id && thread.turns.some((turn) => turn.id === (event.type === 'turn' ? event.turn.id : event.turn)))) return
    this.set({ state: { ...state, revision: event.revision, threads: state.threads.map((thread) => thread.id !== event.id ? thread : {
      ...thread, turns: thread.turns.map((turn) => event.type === 'delta'
        ? turn.id !== event.turn ? turn : turn.answer.length >= event.offset + event.text.length ? turn : { ...turn, answer: turn.answer.slice(0, event.offset) + event.text }
        : turn.id !== event.turn.id ? turn : event.turn),
    }) } })
  }
  connect(): void {
    this.disconnect()
    const controller = new AbortController()
    const generation = this.generation
    this.stream = controller
    this.set({ disconnected: false })
    void this.read(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted && generation === this.generation) this.set({ disconnected: true, error: error instanceof Error ? error.message : String(error) })
    })
  }
  private async read(signal: AbortSignal): Promise<void> {
    const response = await fetch(`/api/${DISCUSSION_STREAM}`, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: DISCUSSION_STREAM, payload: { sessionId: this.sessionId } }),
    })
    if (!response.ok || response.body === null || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) throw new Error(`Discussion stream unavailable (${response.status})`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        signal.throwIfAborted()
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > 4_000_000) throw new Error('Discussion frame is too large')
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (line !== '') this.receive(JSON.parse(line) as DiscussionEvent)
        }
      }
      if (!signal.aborted) throw new Error('Discussion stream disconnected')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  disconnect(): void { this.generation++; this.stream?.abort(); this.stream = undefined }
}
export class DiscussionHub {
  private clients = new Map<string, DiscussionClient>()
  private listeners = new Set<() => void>()
  private value: { selection?: SelectionDraft; panel?: { sessionId: string; id?: string; draft?: SelectionDraft } } = {}
  private rpc: Rpc
  /** Set by the page that shows documents; absent, a `doc:` panel offers no document actions. */
  doc?: DocBridge
  constructor(rpc: Rpc) { this.rpc = rpc }
  getSnapshot = (): typeof this.value => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(value: typeof this.value): void { this.value = value; for (const listener of this.listeners) listener() }
  client(sessionId: string): DiscussionClient {
    let client = this.clients.get(sessionId)
    if (client === undefined) { client = new DiscussionClient(sessionId, this.rpc); this.clients.set(sessionId, client) }
    // Mounted docks and the open panel own subscriptions; only idle cached clients may leave.
    this.clients.delete(sessionId)
    this.clients.set(sessionId, client)
    for (const [id, candidate] of this.clients) {
      if (this.clients.size <= 8) break
      if (id !== sessionId && this.value.panel?.sessionId !== id && candidate.idle()) this.clients.delete(id)
    }
    return client
  }
  select(selection?: SelectionDraft): void {
    // Scrolling repositions the selection every frame: an unchanged value must not wake the overlay.
    const previous = this.value.selection
    if (selection?.quote === previous?.quote && selection?.sessionId === previous?.sessionId && selection?.source === previous?.source
      && selection?.x === previous?.x && selection?.y === previous?.y && selection?.top === previous?.top && selection?.floor === previous?.floor) return
    this.set({ ...this.value, selection })
  }
  open(sessionId: string, id?: string, draft?: SelectionDraft): void { this.set({ ...this.value, panel: { sessionId, id, draft } }) }
  close(): void { this.set({ ...this.value, panel: undefined }) }
  dispose(): void { for (const client of this.clients.values()) client.disconnect(); this.clients.clear(); this.listeners.clear() }
}
