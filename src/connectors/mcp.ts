/**
 * The few MCP requests the hub makes itself, over Streamable HTTP: probing a
 * server before it is connected (does it want a sign-in, does the credential
 * still work) and the ticket lookups behind the worktree picker. The models'
 * own tool calls go through DSH's mcp-client, not this.
 */

const PROTOCOL = '2025-06-18'
const TIMEOUT_MS = 20_000

export class McpHttpError extends Error {
  readonly status: number
  /** `resource_metadata` and `scope` from a 401's Bearer challenge (WWW-Authenticate). */
  readonly resourceMetadata: string | undefined
  readonly scope: string | undefined
  constructor(status: number, message: string, challenge?: string | null) {
    super(message)
    this.status = status
    this.resourceMetadata = challenge == null ? undefined : /resource_metadata="([^"]+)"/i.exec(challenge)?.[1]
    this.scope = challenge == null ? undefined : /scope="([^"]+)"/i.exec(challenge)?.[1]
  }
}

/** The JSON-RPC message answering `id` in a JSON or SSE body. */
async function answer(response: Response, id: number): Promise<Record<string, unknown> | undefined> {
  const matching = (value: unknown): Record<string, unknown> | undefined =>
    (Array.isArray(value) ? value : [value]).find((message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null && (message as { id?: unknown }).id === id)
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const text = await response.text()
    return text.trim() === '' ? undefined : matching(JSON.parse(text))
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
        const block = pending.slice(0, boundary.index)
        pending = pending.slice(boundary.index + boundary[0].length)
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n')
        try {
          const found = matching(JSON.parse(data))
          if (found !== undefined) return found
        } catch { /* Ignore non-JSON frames and keep waiting for this request. */ }
      }
      if (done) return undefined
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** One MCP session against one server with one credential. */
export class McpSession {
  private session: string | undefined
  private ready: Promise<void> | undefined
  private next = 1
  private url: string
  private token: string | undefined

  constructor(url: string, token: string | undefined) {
    this.url = url
    this.token = token
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
      ...(this.session === undefined ? {} : { 'mcp-session-id': this.session }),
      ...(this.ready === undefined ? {} : { 'mcp-protocol-version': PROTOCOL }),
    }
  }

  private async post(body: object, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: signal === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new McpHttpError(response.status, `${response.status} ${response.statusText}`.trim(), response.headers.get('www-authenticate'))
    }
    return response
  }

  private async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = this.next++
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal)
    const session = response.headers.get('mcp-session-id')
    if (session !== null) this.session = session
    const message = await answer(response, id)
    if (message === undefined) throw new McpHttpError(0, `no answer to ${method}`)
    const error = message.error as { message?: string } | undefined
    if (error !== undefined) throw new McpHttpError(0, error.message ?? `${method} failed`)
    return message.result
  }

  /** Initialize once; a lost session (404) starts over on the next call. */
  private start(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'dsh-agent-hub', version: '0.1.0' } }, signal)
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).then((response) => response.body?.cancel(), () => {})
    })().catch((error: unknown) => {
      this.ready = undefined
      this.session = undefined
      throw error
    })
    return this.ready
  }

  private async call<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    await this.start(signal)
    try {
      return await this.request(method, params, signal) as T
    } catch (error) {
      if (!(error instanceof McpHttpError) || error.status !== 404) throw error
      this.ready = undefined
      this.session = undefined
      await this.start(signal)
      return await this.request(method, params, signal) as T
    }
  }

  /** Initialize only: throws McpHttpError 401 when the server wants a (new) credential. */
  probe(signal?: AbortSignal): Promise<void> {
    return this.start(signal)
  }

  async tools(signal?: AbortSignal): Promise<Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>> {
    const result = await this.call<{ tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }>('tools/list', {}, signal)
    return result.tools ?? []
  }

  /** A tool's result: its structured content when it has some, else its text parsed as JSON when it is JSON, else the text. */
  async tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const result = await this.call<{ isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }>('tools/call', { name, arguments: args }, signal)
    const text = (result.content ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    if (result.isError) throw new McpHttpError(0, text || `${name} failed`)
    if (result.structuredContent !== undefined) return result.structuredContent
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}
