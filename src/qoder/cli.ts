/**
 * The local Qoder CLI CN installation (`qoderclicn`). The hub never signs in:
 * it runs the official CLI, which uses its own stored login (`qodercn` then
 * `/login`, or QODERCN_PERSONAL_ACCESS_TOKEN). The installer puts a stable
 * entry point at ~/.qoder-cn/bin/qoderclicn/ that follows its updates; a
 * QODERCN_CLI_BIN override (the CLI's own dispatcher honours it) wins.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const EXE = process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn'

/** The CLI's executable, or undefined when it is not installed. */
export function findQoder(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync, home = homedir()): string | undefined {
  const override = env.QODERCN_CLI_BIN?.trim()
  if (override && exists(override)) return override
  const entry = join(home, '.qoder-cn', 'bin', 'qoderclicn', EXE)
  if (exists(entry)) return entry
  // An npm or package-manager install: a real executable on PATH (a `.cmd` shim would need a shell).
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter((part) => part !== '')) {
    const file = join(dir, EXE)
    if (exists(file)) return file
  }
  return undefined
}

export const INSTALL_HINT = 'Qoder CLI CN not found: install it (irm https://qoder.com.cn/install.ps1 | iex, or curl -fsSL https://qoder.com.cn/install | bash), then run qodercn and /login'

/** The workers file format this was measured against (Qoder CLI CN 1.1.73). */
const WORKERS_VERSION = 4

interface Instance {
  dir: string
  sourceCwd?: unknown
  claim?: { pid?: unknown }
}

/** The remote-control instances on this machine: `remote-control/<family>/<scope>/instances/<id>/instance.json`, a scope per account and service. */
function instances(home: string): Instance[] {
  const root = join(home, '.qoder-cn', 'remote-control')
  const found: Instance[] = []
  const list = (dir: string): string[] => { try { return readdirSync(dir) } catch { return [] } }
  for (const family of list(root)) {
    for (const scope of list(join(root, family))) {
      const parent = join(root, family, scope, 'instances')
      for (const id of list(parent)) {
        const dir = join(parent, id)
        try {
          found.push({ dir, ...(JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) as object) })
        } catch { /* Not an instance, or half written. */ }
      }
    }
  }
  return found
}

/**
 * `cleared` once no workers file of `cwd` lists a session; `retry` when one cannot be read or
 * written now (half written, held open by a process still exiting); `unknown`, untouched, when
 * one is in a format this does not know.
 */
export type Cleared = 'cleared' | 'retry' | 'unknown'

/**
 * Empty the workers files of `cwd`'s remote-control instances, those no running daemon claims, so a
 * daemon starting there starts no worker for an earlier session. A daemon restores every session its
 * file lists, each a ~250 MB process that only waits; a worker is stateless (the service dispatches
 * one again on the session's next message, and it restores the conversation from the server), so
 * none is lost.
 *
 * The dead daemon's broker lock goes too. It is a lockfile directory its owner touched every 5s and
 * that counts as stale only 10s after: a daemon started sooner (a reclaim's restart) finds it held,
 * and exits with "Remote-control broker failed to start". Qoder removes the instance's own lock of a
 * dead claim itself, not this one.
 */
export function clearWorkers(cwd: string, alive: (pid: number) => boolean, note: (message: string) => void = () => {}, home = homedir()): Cleared {
  const same = (path: unknown): boolean => typeof path === 'string' && (process.platform === 'win32' ? path.toLowerCase() === cwd.toLowerCase() : path === cwd)
  let result: Cleared = 'cleared'
  for (const instance of instances(home)) {
    if (!same(instance.sourceCwd)) continue
    // Another daemon (a `qodercn remote-control` in a terminal) still holds it: its own business.
    if (typeof instance.claim?.pid === 'number' && alive(instance.claim.pid)) continue
    const owners = join(instance.dir, 'broker', 'owners')
    for (const lock of (() => { try { return readdirSync(owners) } catch { return [] } })()) {
      if (!lock.endsWith('.lock')) continue
      try {
        rmSync(join(owners, lock), { recursive: true, force: true })
        note(`Qoder broker lock of the exited daemon removed in ${instance.dir}`)
      } catch {
        result = 'retry'
      }
    }
    const file = join(instance.dir, 'workers', 'remote-control-workers.json')
    let state: { version?: unknown; workers?: Record<string, unknown> }
    try {
      state = JSON.parse(readFileSync(file, 'utf8')) as typeof state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result = 'retry'
      continue
    }
    if (state.version !== WORKERS_VERSION || typeof state.workers !== 'object' || state.workers === null) return 'unknown'
    const count = Object.keys(state.workers).length
    if (count === 0) continue
    try {
      writeFileSync(file, JSON.stringify({ ...state, workers: {} }))
      note(`Qoder workers file of ${instance.dir} emptied: ${count} idle session(s) not restored`)
    } catch {
      result = 'retry'
    }
  }
  return result
}
