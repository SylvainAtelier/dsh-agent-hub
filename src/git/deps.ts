/**
 * A worktree's installed packages, shared with the main tree's where the disk allows. Each tree
 * of a JavaScript project carries its own `node_modules`, a full copy (a gigabyte is common).
 * On a file system that clones (APFS, Btrfs, XFS), a copy made by cloning shares every block
 * with its source until either side writes, so a new tree starts with the main tree's packages
 * at almost no cost, and a later install there changes only what differs.
 *
 * Only `node_modules` next to a tracked lockfile is taken: a virtual environment (`.venv`)
 * names its own absolute path inside, so a copy would run the main tree's. A file system that
 * cannot clone gets nothing: a real copy would cost what this means to save.
 */

import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { exec } from '../exec.ts'
import type { Reclaimed } from './types.ts'

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
const DIR = 'node_modules'
/** Cloning a large `node_modules` takes seconds per hundred thousand files. */
const CLONE_MS = 10 * 60_000

/** The tracked lockfiles of a tree, relative to it: one per package that installs into its own `node_modules`. */
export const LOCKFILE_PATHSPECS = LOCKFILES.map((name) => `:(glob)**/${name}`)

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)

/**
 * Whether a copy of `from` made in the folder `dir` would be a clone: both on one APFS volume
 * on macOS, where `cp -c` falls back to a real copy otherwise. On Linux the copy itself refuses
 * (`--reflink=always`); elsewhere nothing clones.
 */
async function clones(from: string, dir: string): Promise<boolean> {
  if (process.platform === 'linux') return true
  if (process.platform !== 'darwin') return false
  const [a, b] = await Promise.all([stat(from).catch(() => undefined), stat(dir).catch(() => undefined)])
  if (a === undefined || b === undefined || a.dev !== b.dev) return false
  const where = await realpath(dir).catch(() => dir)
  const mounts = (await exec('mount', [], { timeoutMs: 10_000 }).catch(() => undefined))?.stdout ?? ''
  let best = { at: '', type: '' }
  for (const line of mounts.split('\n')) {
    const match = / on (.+) \((\w+)[,)]/.exec(line)
    if (match === null) continue
    const at = match[1]!
    if (at.length > best.at.length && (where === at || where.startsWith(at.endsWith('/') ? at : `${at}/`))) best = { at, type: match[2]! }
  }
  return best.type === 'apfs'
}

/** Clone the directory `from` to `to` (which must not exist), whole; false when it could not. */
async function cloneDir(from: string, to: string): Promise<boolean> {
  if (await cloneInto(dirname(from), [basename(from)], to)) return true
  await rm(to, { recursive: true, force: true }).catch(() => {})
  return false
}

/**
 * Clone `names` (paths in `cwd`) into the folder `into`: each one, whole, under its own last name.
 * With a single name, `into` may also not exist yet, and becomes the clone.
 */
async function cloneInto(cwd: string, names: readonly string[], into: string): Promise<boolean> {
  const flags = process.platform === 'darwin' ? ['-cR'] : process.platform === 'linux' ? ['-R', '--reflink=always'] : undefined
  if (flags === undefined) return false
  const result = await exec('cp', [...flags, '--', ...names, into], { cwd, timeoutMs: CLONE_MS }).catch(() => undefined)
  return result?.code === 0
}

export interface Shared {
  /** The `node_modules` folders, relative to the tree, now shared with the main tree's. */
  dirs: string[]
}

/**
 * Give the new tree `tree` the main tree's `node_modules` (cloned) wherever both have the
 * lockfile `lockfiles` names and the tree has none yet. Best effort: nothing is reported as failed.
 */
export async function shareDeps(main: string, tree: string, lockfiles: readonly string[]): Promise<Shared> {
  const dirs: string[] = []
  for (const lockfile of lockfiles) {
    const rel = join(dirname(lockfile), DIR)
    const from = join(main, rel)
    const to = join(tree, rel)
    if (!(await exists(from)) || await exists(to) || !(await exists(join(tree, lockfile)))) continue
    if (!(await clones(from, dirname(to)))) break
    if (await cloneDir(from, to)) dirs.push(rel)
  }
  return { dirs }
}

const sameFile = async (a: string, b: string): Promise<boolean> => {
  const [left, right] = await Promise.all([readFile(a).catch(() => undefined), readFile(b).catch(() => undefined)])
  return left !== undefined && right !== undefined && left.equals(right)
}

const isDir = (path: string): Promise<boolean> => lstat(path).then((info) => info.isDirectory(), () => false)
const freeBytes = (dir: string): Promise<number | undefined> => statfs(dir).then((fs) => fs.bavail * fs.bsize, () => undefined)
/** Sources per `cp`: keeps its arguments well within the system's limit. */
const BATCH = 400

/** The installed packages of a `node_modules`, by their path in it (`name`, `@scope/name`). */
async function packages(modules: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!entry.name.startsWith('@')) out.push(entry.name)
    else for (const inner of await readdir(join(modules, entry.name), { withFileTypes: true }).catch(() => [])) {
      if (inner.isDirectory() && !inner.name.startsWith('.')) out.push(`${entry.name}/${inner.name}`)
    }
  }
  return out
}

/**
 * The packages `to` holds just as `from` does: the same manifest (name, version and all), and no
 * packages of their own inside, which an install lays out by the whole tree's lockfile.
 */
async function samePackages(from: string, to: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await packages(to)) {
    const [a, b] = [join(from, name), join(to, name)]
    if (await isDir(join(a, DIR)) || await isDir(join(b, DIR)) || !(await isDir(a))) continue
    if (await sameFile(join(a, 'package.json'), join(b, 'package.json'))) out.push(name)
  }
  return out
}

/**
 * Swap `to`'s copies of `names` for clones of `from`'s: cloned beside them first, a few hundred
 * per `cp`, then put in place by renames, so no package is ever missing. Returns how many moved.
 */
async function swapPackages(from: string, to: string, names: readonly string[]): Promise<number> {
  const stage = `${to}.ah-shared`
  const old = `${to}.ah-old`
  await Promise.all([rm(stage, { recursive: true, force: true }), rm(old, { recursive: true, force: true })])
  let moved = 0
  const byParent = new Map<string, string[]>()
  for (const name of names) {
    const parent = dirname(name)
    byParent.set(parent, [...byParent.get(parent) ?? [], name])
  }
  try {
    for (const [parent, group] of byParent) {
      await mkdir(join(stage, parent), { recursive: true })
      await mkdir(join(old, parent), { recursive: true })
      for (let i = 0; i < group.length; i += BATCH) {
        const batch = group.slice(i, i + BATCH)
        if (!(await cloneInto(from, batch, join(stage, parent)))) continue
        for (const name of batch) {
          try {
            await rename(join(to, name), join(old, name))
          } catch {
            continue
          }
          await rename(join(stage, name), join(to, name)).then(() => moved++, () => rename(join(old, name), join(to, name)))
        }
      }
    }
  } finally {
    await Promise.all([rm(stage, { recursive: true, force: true }), rm(old, { recursive: true, force: true, maxRetries: 4 })]).catch(() => {})
  }
  return moved
}

/**
 * Share each other tree's installed packages with the main tree's, package by package: one
 * installed alike in both (see `samePackages`) becomes a clone of the main tree's, freeing its
 * copy. Trees whose lockfiles drifted apart still share all they have in common.
 */
export async function reclaimDeps(main: string, trees: readonly string[], lockfiles: readonly string[]): Promise<Reclaimed> {
  const out: Reclaimed = { trees: 0, packages: 0 }
  const before = await freeBytes(main)
  for (const lockfile of lockfiles) {
    const rel = join(dirname(lockfile), DIR)
    const from = join(main, rel)
    if (!(await isDir(from))) continue
    for (const tree of trees) {
      const to = join(tree, rel)
      if (!(await isDir(to)) || !(await clones(from, dirname(to)))) continue
      const moved = await swapPackages(from, to, await samePackages(from, to))
      if (moved === 0) continue
      out.trees++
      out.packages += moved
    }
  }
  const after = await freeBytes(main)
  if (before !== undefined && after !== undefined) out.freed = Math.max(0, after - before)
  return out
}
