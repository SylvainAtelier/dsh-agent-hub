/**
 * Cursor's side of the shared ACP client (acp/client.ts): the CLI is `agent acp`.
 */

import { spawnAcp, type Child } from '../acp/client.ts'

export { AcpAgent, AcpError, type AcpOptions, type Child, type ConfigOption, type PermissionRequest, type SessionInfo, type SessionUpdate, type TurnListener } from '../acp/client.ts'

export function spawnAgent(command: string, args: readonly string[], env: Record<string, string | undefined>): Child {
  return spawnAcp(command, [...args, 'acp'], env)
}
