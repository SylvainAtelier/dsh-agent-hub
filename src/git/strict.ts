/**
 * Strict identity mode (`git.strict`), applied to the user's global git
 * configuration so it holds for every committer, not just this plugin: git is
 * told never to guess an identity (`user.useConfigOnly`) and the global
 * identity is set aside, so a repository without one of its own refuses to
 * commit instead of committing as whoever happened to be the default.
 *
 * Nothing is lost: the global identity moves to `agent-hub.*` in the same file
 * (the picker offers it, and turning strict off puts it back), and
 * `agent-hub.strict` marks a `useConfigOnly` this mode turned on, so turning
 * strict off never undoes the user's own.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Identity } from './identity.ts'

type Run = (args: readonly string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>

const STASH = 'agent-hub'
const KEYS = { name: 'user.name', email: 'user.email', signingKey: 'user.signingkey' } as const

/** The user's own global files (not ones they include), as `--show-origin` names them. */
export function mainGlobalFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const norm = (path: string): string => {
    const full = resolve(path).replace(/\\/g, '/')
    return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full
  }
  const files = env.GIT_CONFIG_GLOBAL
    ? [env.GIT_CONFIG_GLOBAL]
    : [join(homedir(), '.gitconfig'), join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'config')]
  return files.map(norm)
}

export function isMainGlobal(origin: string, files = mainGlobalFiles()): boolean {
  if (!origin.startsWith('file:')) return false
  const path = resolve(origin.slice(5)).replace(/\\/g, '/')
  const key = process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
  return files.includes(key)
}

async function readGlobal(run: Run): Promise<Map<string, string>> {
  const result = await run(['config', '--global', '-z', '--get-regexp', `^(user\\.(name|email|signingkey|useconfigonly)|${STASH}\\..*)$`], homedir())
  // 1: nothing matched.
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || 'git config failed')
  const values = new Map<string, string>()
  for (const record of result.stdout.split('\0')) {
    const cut = record.indexOf('\n')
    if (record !== '') values.set((cut < 0 ? record : record.slice(0, cut)).toLowerCase(), cut < 0 ? '' : record.slice(cut + 1))
  }
  return values
}

async function config(run: Run, ...args: string[]): Promise<void> {
  const result = await run(['config', '--global', ...args], homedir())
  // 5: unsetting a key that is not there.
  if (result.code !== 0 && !(result.code === 5 && args[0]!.startsWith('--unset'))) throw new Error(result.stderr.trim() || `git config ${args.join(' ')} failed`)
}

/** The identity strict mode set aside, if any. */
export async function readStash(run: Run): Promise<Identity | undefined> {
  const values = await readGlobal(run)
  const name = values.get(`${STASH}.name`)
  const email = values.get(`${STASH}.email`)
  if (!name || !email) return undefined
  const signingKey = values.get(`${STASH}.signingkey`)
  return { name, email, ...(signingKey ? { signingKey } : {}) }
}

export async function applyStrict(run: Run, on: boolean): Promise<void> {
  const values = await readGlobal(run)
  const global = { name: values.get(KEYS.name), email: values.get(KEYS.email), signingKey: values.get(KEYS.signingKey) }
  if (on) {
    if (global.name !== undefined || global.email !== undefined) {
      // Stashed whole before anything is unset, so a failure part way loses nothing.
      for (const field of ['name', 'email', 'signingKey'] as const) {
        const value = global[field]
        if (value === undefined) await config(run, '--unset-all', `${STASH}.${field.toLowerCase()}`)
        else await config(run, `${STASH}.${field.toLowerCase()}`, value)
      }
      for (const key of Object.values(KEYS)) await config(run, '--unset-all', key)
    }
    if (values.get('user.useconfigonly') !== 'true') {
      await config(run, 'user.useConfigOnly', 'true')
      await config(run, `${STASH}.strict`, 'true')
    }
    return
  }
  if (values.get(`${STASH}.strict`) === 'true') await config(run, '--unset-all', 'user.useConfigOnly')
  const stash = await readStash(run)
  if (stash !== undefined && global.name === undefined && global.email === undefined) {
    await config(run, KEYS.name, stash.name)
    await config(run, KEYS.email, stash.email)
    if (stash.signingKey !== undefined && global.signingKey === undefined) await config(run, KEYS.signingKey, stash.signingKey)
  }
  if ([...values.keys()].some((key) => key.startsWith(`${STASH}.`))) await config(run, '--remove-section', STASH)
}
