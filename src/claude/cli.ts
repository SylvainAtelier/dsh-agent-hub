/**
 * The local Claude Code installation, shared by every module that talks to
 * it. The hub never reads, stores or forwards Claude credentials: each spawn
 * runs the official CLI, which signs in with its own stored login.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const BINARY = process.platform === 'win32' ? 'claude.exe' : 'claude'

let found: string | undefined

/** The native `claude` executable: PATH first, then the native installer's location. Remembered while it exists. */
export function findClaudeExecutable(): string | undefined {
  if (found !== undefined && existsSync(found)) return found
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  found = [...dirs, join(homedir(), '.local', 'bin')].map((dir) => join(dir, BINARY)).find((file) => existsSync(file))
  return found
}

/**
 * Variables that would make the CLI bill an API key, a third-party endpoint or
 * an injected token instead of the user's own claude.ai login. Removing them
 * keeps every request on the subscription the CLI signed in with (and keeps
 * Remote Control eligible).
 */
const FOREIGN_AUTH = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']

/**
 * The working directory of the short CLI runs that never touch files (`/usage`, `auth status`, the
 * model list probe): an empty folder of their own. Claude Code lists its working directory when it
 * starts (`rg --files`), and the system temp folder can hold a hundred thousand files.
 */
export function probeDir(): string {
  const dir = join(tmpdir(), 'dsh-agent-hub-claude-probe')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The environment a spawned CLI gets: the host's, minus {@link FOREIGN_AUTH}. */
export function claudeEnv(configDir?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of FOREIGN_AUTH) delete env[name]
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir
  return env
}
