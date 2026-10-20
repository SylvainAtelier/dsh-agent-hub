// Runtime modules the DSH host provides; only the members this plugin uses.

declare module '@deepseek-ai/dsh-credentials' {
  export function credentialKey(owner: string, id: string): unknown
  export function credentialRef(name: string): unknown
}

declare module '@deepseek-ai/dsh-llm' {
  /** Provider-wire adapter base; the runtime validates what these return. */
  export class LlmAdapter {
    providerInfo(provider: string): { id: string; name: string }
    listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string; description?: string }>>
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<object>
    /** Exact model metadata and a stream entry bound to one adapter generation. */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: object; stream(options: object): AsyncIterable<object> }>
  }
  export class LlmError extends Error {
    constructor(message: string, code: string, options?: { cause?: unknown })
    readonly code: string
  }
  export function ReasoningEffortId(id: string): string
  /** Whether dsh-agent-loop assembled this exact request (as opposed to titles, compaction, ...). */
  export function isAgentLoopRequest(request: object): boolean
  /** Record a request object as the agent loop's (a bot's request to its own model stays a conversation turn). */
  export function markAgentLoopRequest<T extends object>(request: T): T
  /** An identified, frozen user-role message; its source says who it is from. */
  export function createUserMessage(input: { content: Array<{ type: 'text'; text: string }>; source: object }): object
}

declare module '@deepseek-ai/dsh-client-connection' {
  export const clientRequestSchema: {
    safeParse(value: unknown):
      | { success: true; data: { method: string; rpcId: unknown; payload?: unknown } }
      | { success: false }
  }
}

declare module '@deepseek-ai/dsh-mcp-client' {
  /** The Cordis plugin: one instance connects one MCP server and registers its tools on `ctx.tools`. */
  export const name: string
  export const inject: string[]
  export const Config: unknown
  export function apply(ctx: unknown, config: unknown): Promise<void>
}

declare module '@deepseek-ai/dsh-atomic-write' {
  /** Serializes writers of `filename` through a `<filename>.lock` file; DSH's profile writers share it. */
  export function withFileLock<T>(filename: string, operation: () => Promise<T>, options?: { waitMs?: number }): Promise<T>
}

declare module '@deepseek-ai/dsh-app-boot' {
  /** The profile's patches as the Loader composes them, read from disk. */
  export function readProfilePatches(app: string, profile: unknown): unknown
  /** Apply composed patches to the running Loader, as DSH's settings service does before every edit. */
  export function reconcileProfilePatches(root: unknown, patches: unknown, app: string): Promise<unknown>
}
