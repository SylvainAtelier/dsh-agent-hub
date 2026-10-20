/**
 * DSH's Agent Teams tools for Claude Code. A Claude Agent session runs its
 * turns in Claude Code, which has its own tools and never sees DSH's — so a
 * Claude Agent Lead could not create teammates and a Claude Agent teammate
 * could not message anyone. This bridge serves the team tools the session's
 * DSH agent can see as an in-process MCP server (`mcp__dsh__send_message`, …),
 * and the tools of every connected connector (Linear, Notion, …) the same way,
 * one server per connector. Every call runs through DSH's own tool registry as
 * that agent, with the same policy, guards and results as a DSH model's call.
 */

import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TEAM_TOOLS } from '../team/types.ts'

export { TEAM_TOOLS }

export const BRIDGE_SERVER = 'dsh'
/** Claude Code's name for a bridged tool. */
export const BRIDGE_PREFIX = `mcp__${BRIDGE_SERVER}__`

/**
 * A tool parameter schema. The registry serves standard JSON Schema (an object
 * lists its `required` names); tool sources also write `required: true` on the
 * property itself, which is accepted too.
 */
interface DshProperty {
  type?: string
  description?: string
  required?: boolean | string[]
  enum?: unknown[]
  const?: unknown
  items?: DshProperty
  properties?: Record<string, DshProperty>
  additionalProperties?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

/** The slice of DSH's tool registry (`ctx.tools`) the bridge uses. */
export interface ToolRegistry {
  schemas(scope?: unknown): Array<{ name: string; description: string; parameters: unknown }>
  execute(exec: { callId: string; name: string; arguments: Record<string, unknown>; agent?: unknown; signal: AbortSignal }): Promise<{
    isError: boolean
    content: ReadonlyArray<{ type: string; text?: string }>
    error?: { message?: string }
  }>
}

/** The names an object schema requires, in either spelling. */
function requiredNames(schema: DshProperty): Set<string> {
  const names = new Set(Array.isArray(schema.required) ? schema.required : [])
  for (const [key, value] of Object.entries(schema.properties ?? {})) if (value.required === true) names.add(key)
  return names
}

/** Standard JSON Schema throughout: per-property `required: true` moves into the object's `required` list. */
export function standardSchema(property: DshProperty): Record<string, unknown> {
  const { required: _required, properties, items, ...rest } = property
  const out: Record<string, unknown> = { ...rest }
  if (items !== undefined) out.items = standardSchema(items)
  if (properties !== undefined) {
    out.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, standardSchema(value)]))
    const required = [...requiredNames(property)]
    if (required.length > 0) out.required = required
  }
  return out
}

/** A tool's parameters (an object schema) as the zod raw shape `tool()` takes. */
export function zodShape(parameters: unknown): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {}
  if (parameters === null || typeof parameters !== 'object') return shape
  const schema = parameters as DshProperty
  const required = requiredNames(schema)
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    let field: z.ZodType
    try {
      field = z.fromJSONSchema(standardSchema(property) as Parameters<typeof z.fromJSONSchema>[0])
    } catch {
      field = z.any()
    }
    if (property.description !== undefined) field = field.describe(property.description)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return shape
}

/** Claude Code's own messaging between local Claude sessions: it would bypass the DSH team (and reach unrelated sessions). */
export const NATIVE_TEAM_TOOLS: readonly string[] = ['SendMessage', 'ListAgents']

const INSTRUCTIONS = `These are DeepSeek Harness Agent Teams tools. Wherever team guidance names a tool (spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent, team_task_*), call the tool of that name here. Create teammates only when the user asks for a team or teammates. As a teammate, report back to your Team Lead with send_message to "lead" — your final reply alone does not reach it. Messages sent to you arrive as your next input, once your current reply has ended: when wait_agent reports a change, end your reply with a one-line status instead of waiting again, and the messages follow.`

/**
 * An MCP server with the team tools `agent()` can see, or undefined when it
 * sees none (no team runtime). `agent` is read per call: the session's live
 * DSH agent may be replaced while the Claude Code process lives on.
 */
export function teamBridge(registry: ToolRegistry, agent: () => unknown, options: { eager?: boolean } = {}): McpSdkServerConfigWithInstance | undefined {
  const scope = agent()
  if (scope === undefined) return undefined
  const visible = registry.schemas(scope).filter((schema) => TEAM_TOOLS.includes(schema.name))
  if (visible.length === 0) return undefined
  return serve(registry, agent, BRIDGE_SERVER, visible, (schema) => schema.name, {
    instructions: INSTRUCTIONS,
    // A teammate must report back, so its tools are in the prompt from the start; a Lead finds them when asked for a team.
    ...(options.eager ? { alwaysLoad: true } : {}),
    // wait_agent may wait up to an hour.
    timeout: 3_700_000,
  })
}

type Schema = ReturnType<ToolRegistry['schemas']>[number]

/** DSH tools as one in-process MCP server; each call runs through the registry as the session's agent. */
function serve(registry: ToolRegistry, agent: () => unknown, name: string, schemas: readonly Schema[], rename: (schema: Schema) => string, options: { instructions?: string; alwaysLoad?: boolean; timeout?: number } = {}): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    ...options,
    tools: schemas.map((schema) => tool(rename(schema), schema.description, zodShape(schema.parameters), async (args, extra) => {
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal
      const result = await registry.execute({ callId: randomUUID(), name: schema.name, arguments: args as Record<string, unknown>, agent: agent(), signal })
      const text = result.content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text!).join('\n')
      return { content: [{ type: 'text' as const, text: text || (result.isError ? result.error?.message ?? 'failed' : 'ok') }], ...(result.isError ? { isError: true } : {}) }
    })),
  })
}

/** What one Claude Agent session would be served from DSH. */
export interface Bridges {
  /** The bridged tools' names, sorted and joined: a session whose set changed needs a new process. */
  signature: string
  /** Whether the team tools are among them. */
  team: boolean
  /** Build the servers; only a new Claude Code process needs them. */
  open(): {
    servers: Record<string, McpSdkServerConfigWithInstance>
    /** Tool-name prefixes that run without Claude Code asking: DSH applies its own policy when they execute. */
    trusted: string[]
  }
}

/**
 * The team tools plus every connected connector, each connector as its own
 * MCP server named after it. DSH names a connector tool
 * `mcp__<connector>__<tool>`, and Claude Code names a tool of server
 * `<connector>` the same way, so a tool has one name for every model.
 */
export function bridges(registry: ToolRegistry, agent: () => unknown, options: { eager?: boolean; connectors?: readonly string[] } = {}): Bridges {
  const scope = agent()
  const schemas = scope === undefined ? [] : registry.schemas(scope)
  const team = schemas.filter((schema) => TEAM_TOOLS.includes(schema.name))
  const connectors = (options.connectors ?? []).filter((id) => id !== BRIDGE_SERVER).map((id) => {
    const prefix = `mcp__${id}__`
    return { id, prefix, visible: schemas.filter((schema) => schema.name.startsWith(prefix) && schema.name.length > prefix.length) }
  }).filter((connector) => connector.visible.length > 0)
  const names = [...team, ...connectors.flatMap((connector) => connector.visible)].map((schema) => schema.name)
  return {
    signature: names.sort().join('\n'),
    team: team.length > 0,
    open() {
      const servers: Record<string, McpSdkServerConfigWithInstance> = {}
      const trusted: string[] = []
      const server = team.length > 0 ? teamBridge(registry, agent, options) : undefined
      if (server !== undefined) {
        servers[BRIDGE_SERVER] = server
        trusted.push(BRIDGE_PREFIX)
      }
      for (const { id, prefix, visible } of connectors) {
        // Deferred behind Claude Code's tool search: a connector can bring dozens of tools.
        servers[id] = serve(registry, agent, id, visible, (schema) => schema.name.slice(prefix.length), { alwaysLoad: false })
        trusted.push(prefix)
      }
      return { servers, trusted }
    },
  }
}
