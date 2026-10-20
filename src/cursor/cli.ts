/**
 * The local Cursor CLI installation (`agent`). The hub never signs in: it runs
 * the official CLI, which uses its own stored login, and reads that login's
 * access token only to ask Cursor's dashboard for this account's usage (see
 * usage.ts). Nothing is refreshed or written.
 */

import { exec } from '../exec.ts'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** How to start the CLI: a program and the arguments before the CLI's own. */
export interface Launch {
  command: string
  args: readonly string[]
}

/** `2026.10.01-e373342` or `2026.10.1-12-30-00-e373342` → a sortable number; NaN when it is not a version folder. */
export function versionRank(name: string): number {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/.exec(name)
  if (match === null) return Number.NaN
  const [, year, month, day, h = '0', m = '0', s = '0'] = match
  return Number(year) * 1e10 + Number(month) * 1e8 + Number(day) * 1e6 + Number(h) * 1e4 + Number(m) * 1e2 + Number(s)
}

/** The newest version folder under `root`, or undefined. */
export function latestVersion(root: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return undefined
  }
  const ranked = names.filter((name) => !Number.isNaN(versionRank(name))).sort((a, b) => versionRank(b) - versionRank(a))
  return ranked[0] === undefined ? undefined : join(root, ranked[0])
}

let found: Launch | undefined

/**
 * The CLI. On Windows the installer's `agent.cmd` only finds the newest
 * version folder and runs its bundled node through PowerShell, so the hub
 * does the same without the two shells. Elsewhere `agent` is a plain
 * executable on PATH (or in ~/.local/bin).
 */
export function findCursorAgent(): Launch | undefined {
  if (found !== undefined && existsSync(found.command)) return found
  found = undefined
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const version = latestVersion(join(base, 'cursor-agent', 'versions'))
    if (version !== undefined && existsSync(join(version, 'node.exe')) && existsSync(join(version, 'index.js'))) {
      found = { command: join(version, 'node.exe'), args: [join(version, 'index.js')] }
    }
    return found
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== ''), join(homedir(), '.local', 'bin')]
  for (const name of ['agent', 'cursor-agent']) {
    const file = dirs.map((dir) => join(dir, name)).find((path) => existsSync(path))
    if (file !== undefined) return (found = { command: file, args: [] })
  }
  return undefined
}

/** Where the CLI keeps its login (its own `getAuthFilePath`). */
export function authFile(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json')
  if (process.platform === 'darwin') return join(homedir(), '.cursor', 'auth.json')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cursor', 'auth.json')
}

/** The CLI's settings file. Choosing a model's parameters over ACP rewrites it (see acp.ts). */
export function configFile(): string {
  const dir = process.env.CURSOR_CONFIG_DIR?.trim() || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME, 'cursor') : join(homedir(), '.cursor'))
  return join(dir, 'cli-config.json')
}

/** The token the CLI keeps in the macOS keychain (its `cursor-access-token` item), or undefined. */
export function keychainToken(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined)
  return exec('/usr/bin/security', ['find-generic-password', '-s', 'cursor-access-token', '-w'], { timeoutMs: 5_000 }).then((result) => {
    const token = result.code === 0 ? result.stdout.trim() : ''
    return token === '' ? undefined : token
  })
}

/**
 * The signed-in access token, or undefined when the CLI is signed out. Read
 * per use: the CLI rotates it. On macOS the CLI keeps it in the keychain;
 * the auth file is where it lives elsewhere (and a fallback on macOS).
 */
export async function accessToken(file = authFile(), keychain = keychainToken): Promise<string | undefined> {
  const stored = await keychain()
  if (stored !== undefined) return stored
  try {
    const token = (JSON.parse(await readFile(file, 'utf8')) as { accessToken?: unknown }).accessToken
    return typeof token === 'string' && token !== '' ? token : undefined
  } catch {
    return undefined
  }
}

/** Variables that would make the CLI use a key or token other than its own login. */
const FOREIGN_AUTH = ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN']

export function cursorEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CURSOR_INVOKED_AS: 'agent' }
  for (const name of FOREIGN_AUTH) delete env[name]
  return env
}
