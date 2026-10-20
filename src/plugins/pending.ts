/**
 * Plugin installs that wait for DSH to restart. A host with hot reload refuses
 * to replace an installed plugin in place (its modules would be swapped while
 * the files are half written), and nothing should replace this plugin's own
 * files under its feet. So such upgrades are written down here, by the plugin
 * updates page and by settings sync alike, and run by the restart helper
 * (restart/index.ts) once DSH has quit and before it opens again: one
 * `pnpm add` in the profile, its package.json and lockfile put back if it
 * fails. The outcome is left in a file the next start reads.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSpec } from '../sync/portable.ts'
import { packageCommand } from './registry.ts'
import type { UpdateProfile } from './types.ts'

export interface PendingOp {
  name: string
  /** What `pnpm add <name>@<spec>` installs. */
  spec: string
  /** The version installed before, when known. */
  from?: string
}

export interface PendingResult {
  ok: boolean
  ops: PendingOp[]
  at: string
  error?: string
  /** The last lines of pnpm's standard output (never its error stream: it can hold registry credentials). */
  log?: string[]
}

/** What the restart helper runs between DSH quitting and opening again. */
export interface RestartJob {
  cwd: string
  commands: Array<{ command: string; args: string[] }>
  env?: Record<string, string | undefined>
  /** Put back as they were when a command fails. */
  files: string[]
  ops: PendingOp[]
  /** Where the outcome is written, and the list cleared on the way. */
  result: string
  pending: string
}

const EXACT = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/

export class PendingOps {
  private readonly file: string
  private readonly resultFile: string
  private ops: PendingOp[]
  private result: PendingResult | undefined

  constructor(dir: string) {
    this.file = join(dir, 'pending-upgrades.json')
    this.resultFile = join(dir, 'pending-upgrades.result.json')
    mkdirSync(dir, { recursive: true })
    this.ops = read<{ ops?: PendingOp[] }>(this.file)?.ops?.filter((op) => typeof op?.name === 'string' && typeof op.spec === 'string') ?? []
    this.result = read<PendingResult>(this.resultFile)
  }

  list(): PendingOp[] {
    return this.ops.map((op) => ({ ...op }))
  }

  /** Waiting ops, a later one for a plugin replacing the earlier. */
  add(ops: readonly PendingOp[]): void {
    const names = new Set(ops.map((op) => op.name))
    this.save([...this.ops.filter((op) => !names.has(op.name)), ...ops.map((op) => ({ ...op }))])
  }

  /** Drop these (all, without names). */
  remove(names?: readonly string[]): void {
    this.save(names === undefined ? [] : this.ops.filter((op) => !names.includes(op.name)))
  }

  /** Drop what the profile already has (installed some other way since). */
  prune(dependencies: Readonly<Record<string, string>>): void {
    const left = this.ops.filter((op) => dependencies[op.name] === undefined || canonicalSpec(dependencies[op.name]!) !== canonicalSpec(op.spec))
    if (left.length !== this.ops.length) this.save(left)
  }

  /** The outcome of the upgrades the last restart ran, until dismissed. */
  lastResult(): PendingResult | undefined {
    return this.result === undefined ? undefined : structuredClone(this.result)
  }

  dismissResult(): void {
    this.result = undefined
    rmSync(this.resultFile, { force: true })
  }

  /** The commands for the restart helper; exact versions are saved exact, ranges as written. */
  job(profile: UpdateProfile, registry?: string): RestartJob | undefined {
    if (this.ops.length === 0) return undefined
    const manager = profile.packageManager ?? { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm' }
    const commands: RestartJob['commands'] = []
    for (const exact of [true, false]) {
      const specs = this.ops.filter((op) => EXACT.test(op.spec) === exact).map((op) => `${op.name}@${op.spec}`)
      if (specs.length === 0) continue
      commands.push(packageCommand(manager.command, [...(manager.args ?? []), 'add', ...specs, ...(exact ? ['--save-exact'] : []), ...(registry ? [`--registry=${registry}`] : [])]))
    }
    return {
      cwd: profile.dir,
      commands,
      ...(manager.env === undefined ? {} : { env: manager.env }),
      files: [join(profile.dir, 'package.json'), join(profile.dir, 'pnpm-lock.yaml')],
      ops: this.list(),
      result: this.resultFile,
      pending: this.file,
    }
  }

  private save(ops: PendingOp[]): void {
    this.ops = ops
    if (ops.length === 0) rmSync(this.file, { force: true })
    else writeFileSync(this.file, `${JSON.stringify({ ops }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}

function read<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : undefined
  } catch {
    return undefined
  }
}
