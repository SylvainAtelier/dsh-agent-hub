/**
 * Restart: quit DSH Desktop and open it again, so rebuilt plugins and profile
 * edits that need a fresh process take effect. Desktop only: the Host runs as
 * Electron's Node-mode child there, and Electron offers it no restart message,
 * so a detached helper does it from outside. It ends the Electron shell; the
 * Host sees its IPC channel close and shuts down gracefully on its own (the
 * same path as any Desktop quit). Once both have exited, the helper opens the
 * application again. Under `dsh web` nothing can start DSH again, so the
 * restart is not offered there.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { RestartJob } from '../plugins/pending.ts'
import type { RestartStatus } from './types.ts'

/** The slices of DSH's `agents` and `jobs` services the count reads; anything else counts as idle. */
export interface TaskSources {
  agents(): { list?(): unknown[] } | undefined
  jobs(): { list?(agentId?: string): unknown[] } | undefined
}

/** How the application starts again, or undefined where this Host is not DSH Desktop's child. */
export interface Relaunch {
  /** The Electron shell's process. */
  shell: number
  command: string
  args: string[]
}

const BOOT = randomUUID()

/** DSH Desktop runs the Host as `ELECTRON_RUN_AS_NODE` with an IPC channel back to the shell. */
export function desktopRelaunch(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform = process.platform): Relaunch | undefined {
  if (process.versions.electron === undefined || env.ELECTRON_RUN_AS_NODE !== '1' || typeof process.send !== 'function') return undefined
  const shell = process.ppid
  if (platform === 'darwin') {
    // The bundle, so Launch Services starts it the way the Dock does.
    const at = execPath.indexOf('.app/')
    return at < 0 ? { shell, command: execPath, args: [] } : { shell, command: 'open', args: [execPath.slice(0, at + 4)] }
  }
  // An AppImage's mount point goes away with it; start the image itself.
  if (platform === 'linux' && env.APPIMAGE) return { shell, command: env.APPIMAGE, args: [] }
  return { shell, command: execPath, args: [] }
}

const status = (agent: unknown): boolean => {
  const item = agent as { status?: unknown; inbox?: { nextTurn?: unknown[]; nextStep?: unknown[] } }
  return item.status === 'running' || (item.inbox?.nextTurn?.length ?? 0) > 0 || (item.inbox?.nextStep?.length ?? 0) > 0
}

/** The work DSH Desktop's own quit check counts: busy agents, and running jobs of the Host and of each agent. */
export function countRunning(sources: TaskSources): number {
  let agents: unknown[] = []
  try {
    agents = sources.agents()?.list?.() ?? []
  } catch {
    // No agents service yet: nothing of theirs is running.
  }
  let count = agents.filter(status).length
  const jobs = sources.jobs()
  if (jobs?.list === undefined) return count
  for (const id of [undefined, ...agents.map((agent) => (agent as { id?: string }).id)]) {
    try {
      count += jobs.list(id).filter((job) => ['running', 'stopping'].includes((job as { status?: string }).status ?? '')).length
    } catch {
      // A job list that fails to read counts as idle.
    }
  }
  return count
}

/** Runs a program and gives its stdout, or undefined when it fails or times out. */
export type Run = (file: string, args: string[]) => Promise<string | undefined>

const runFile: Run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout))
})

const MARK = '__DSH_PATH__'

/**
 * PATH as a fresh launch would see it. The Host's own PATH dates from when
 * DSH started, so a tool installed since then stays missing however often the
 * restart copies it on. Windows: the machine and user values from the
 * registry (expanded), in the order a logon builds them. macOS and Linux: the
 * login shell's PATH, unless the restart goes through `open`, where Launch
 * Services gives the application launchd's environment and ours never reaches
 * it. Undefined keeps the inherited PATH.
 */
export async function freshPath(target: Relaunch, platform = process.platform, env: NodeJS.ProcessEnv = process.env, run: Run = runFile): Promise<string | undefined> {
  if (platform === 'win32') {
    const powershell = env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json -Compress @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))"
    const out = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script])
    try {
      const parts = (JSON.parse(out ?? '') as unknown[]).filter((part): part is string => typeof part === 'string' && part !== '')
      return parts.length > 0 ? parts.join(';') : undefined
    } catch {
      return undefined
    }
  }
  if (platform === 'darwin' && target.command === 'open') return undefined
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  const out = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`])
  const found = out?.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'))?.[1]
  return found ? found : undefined
}

/**
 * The helper, run by Electron in Node mode: wait a moment so the RPC reply
 * reaches the browser, end the shell, wait for the Host's graceful shutdown
 * (ended after a deadline), run the plugin upgrades waiting for a restart
 * (plugins/pending.ts) while nothing of DSH runs, then start the application
 * without the Node-mode variables the Host was given, and with the fresh PATH
 * when there is one. A failed upgrade puts package.json and the lockfile back.
 */
export const HELPER = `
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const [shell, host, command, args, path, job] = JSON.parse(process.argv[process.argv.length - 1])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const gone = async (pid, ms) => { const end = Date.now() + ms; while (alive(pid) && Date.now() < end) await sleep(200); return !alive(pid) }
const upgrade = (job) => {
  const saved = job.files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null])
  let ok = true, error, out = ''
  for (const step of job.commands) {
    const run = spawnSync(step.command, step.args, { cwd: job.cwd, env: { ...process.env, ...(job.env || {}) }, encoding: 'utf8', timeout: 600000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, windowsVerbatimArguments: /(^|[\\\\/])cmd(\\.exe)?$/i.test(step.command) })
    out += run.stdout || ''
    if (run.error || run.status !== 0) { ok = false; error = run.error ? run.error.message : 'pnpm exited with ' + run.status; break }
  }
  if (!ok) for (const [file, data] of saved) { try { data === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, data) } catch {} }
  const log = out.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').split(/\\r?\\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-40)
  try { fs.writeFileSync(job.result, JSON.stringify({ ok, ops: job.ops, at: new Date().toISOString(), ...(error ? { error } : {}), log })) } catch {}
  try { fs.rmSync(job.pending, { force: true }) } catch {}
}
;(async () => {
  await sleep(400)
  try { process.kill(shell) } catch {}
  await gone(shell, 15000)
  if (!(await gone(host, 90000))) { try { process.kill(host, 'SIGKILL') } catch {} await gone(host, 5000) }
  await sleep(500)
  if (job) { try { upgrade(job) } catch {} }
  const env = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'DSH_CLIENT_VERSION', 'DSH_DESKTOP_NODE_EXECUTABLE']) delete env[name]
  if (typeof path === 'string') {
    // Windows names it Path; a second spelling beside it would be ambiguous.
    const names = Object.keys(env).filter((name) => name.toUpperCase() === 'PATH')
    for (const name of names) delete env[name]
    env[names[0] ?? 'PATH'] = path
  }
  spawn(command, args, { detached: true, stdio: 'ignore', env }).unref()
})()
`

/** Hand the restart to the helper; the caller's reply goes out before the shell ends. */
export async function startRestart(target: Relaunch, job?: RestartJob, path: (target: Relaunch) => Promise<string | undefined> = freshPath): Promise<void> {
  const fresh = await path(target).catch(() => undefined)
  const child = spawn(process.execPath, ['-e', HELPER, JSON.stringify([target.shell, process.pid, target.command, target.args, fresh ?? null, job ?? null])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
}

/** The plugin upgrades a restart runs on the way (plugins/pending.ts). */
export interface RestartUpgrades {
  list(): Array<{ name: string; spec: string; from?: string }>
  job(): RestartJob | undefined | Promise<RestartJob | undefined>
}

export function createRestart(sources: TaskSources, relaunch: () => Relaunch | undefined = desktopRelaunch, start: (target: Relaunch, job?: RestartJob) => void | Promise<void> = startRestart, upgrades?: RestartUpgrades) {
  let pending = false
  return async (payload: Record<string, unknown>): Promise<RestartStatus | { started: true }> => {
    const target = relaunch()
    if (payload.op !== 'restart') {
      const list = upgrades?.list() ?? []
      return { supported: target !== undefined, running: countRunning(sources), boot: BOOT, ...(list.length === 0 ? {} : { upgrades: list }) }
    }
    if (target === undefined) throw new Error('Restart is only available in DSH Desktop')
    if (!pending) {
      const job = await upgrades?.job()
      pending = true
      await start(target, job)
    }
    return { started: true }
  }
}
