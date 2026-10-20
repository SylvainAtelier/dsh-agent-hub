/**
 * Qoder's worktrees in DSH's one place for working trees. Remote tasks run in
 * the workspace itself (daemon.ts); a worktree is made only when one is asked
 * for (the agent's EnterWorktree, `qodercn --worktree`). Left alone, Qoder
 * CLI CN puts such a worktree under `<repo>/.qoder/worktrees/<name>`
 * (built in, no option moves it); DSH's own trees (the Git pane, the board,
 * reviews, alerts) go to `<repo>/.worktrees/<branch>` (git/service.ts).
 *
 * Qoder hands worktree creation to a `WorktreeCreate` hook when one is
 * configured, git repositories included, and removal to `WorktreeRemove`.
 * So DSH writes both into the repository's `.qoder/settings.local.json` (a
 * daemon's workers read the project's settings, not `--settings`), and each
 * such tree becomes `<repo>/.worktrees/qoder/<name>` on branch
 * `qoder/<name>`: listed, opened and removed from the Git pane like any
 * other, out of git status through the same `info/exclude` line.
 *
 * The hooks run a small script with the host's own runtime, in exec form (no
 * shell: the same on Windows and macOS). Removal keeps a tree with
 * uncommitted changes, and a branch with commits of its own, for review; it
 * only touches trees under `.worktrees/qoder/`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { exec, type Exec } from '../exec.ts'
import { WORKTREE_DIR } from '../git/service.ts'

/** Qoder's trees, under DSH's worktree folder; also their branch prefix. */
export const QODER_TREES = 'qoder'
/** Qoder's per-user project settings: local only, kept out of git status here. */
export const LOCAL_SETTINGS = join('.qoder', 'settings.local.json')
const SCRIPT_NAME = 'qoder-worktree.cjs'

/**
 * The hook script, run as `node qoder-worktree.cjs create|remove` with the
 * hook's JSON on stdin. `create` prints the new tree's absolute path;
 * `remove` answers whether it removed the tree.
 */
export const HOOK_SCRIPT = `'use strict'
// Written by dsh-agent-hub (src/qoder/worktree.ts): Qoder's worktrees under <repo>/${WORKTREE_DIR}/${QODER_TREES}/.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const DIR = ${JSON.stringify(WORKTREE_DIR)}
const PREFIX = ${JSON.stringify(QODER_TREES)}
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const main = (cwd) => {
  const first = /^worktree (.+)$/m.exec(git(cwd, ['worktree', 'list', '--porcelain']))
  return path.resolve(first ? first[1] : path.dirname(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])))
}
const exclude = (root) => {
  const file = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']))
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (text.split(/\\r?\\n/).some((line) => line.trim() === '/' + DIR + '/')) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, (text === '' || text.endsWith('\\n') ? '' : '\\n') + '/' + DIR + '/\\n')
}
const answer = (status) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'WorktreeRemove', status } }))
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  const cwd = input.cwd || process.cwd()
  if (process.argv[2] === 'create') {
    const name = String(input.name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
    if (name === '') throw new Error('no worktree name')
    const root = main(cwd)
    const tree = path.join(root, DIR, PREFIX, name)
    const branch = PREFIX + '/' + name
    exclude(root)
    if (!fs.existsSync(tree)) {
      let known = true
      try { git(root, ['show-ref', '--verify', '-q', 'refs/heads/' + branch]) } catch { known = false }
      git(cwd, known ? ['worktree', 'add', '--', tree, branch] : ['worktree', 'add', '--no-track', '-b', branch, '--', tree, 'HEAD'])
    }
    process.stdout.write(tree)
  } else if (process.argv[2] === 'remove') {
    const tree = path.resolve(String(input.worktree_path || ''))
    const root = main(fs.existsSync(tree) ? tree : cwd)
    const inside = path.relative(path.join(root, DIR, PREFIX), tree)
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) answer('retained')
    else if (!fs.existsSync(tree)) { git(root, ['worktree', 'prune']); answer('removed') }
    else if (git(tree, ['status', '--porcelain']) !== '') answer('retained')
    else {
      const branch = git(tree, ['branch', '--show-current'])
      git(root, ['worktree', 'remove', '--', tree])
      // -d keeps a branch with commits of its own.
      if (branch !== '') try { git(root, ['branch', '-d', '--', branch]) } catch {}
      answer('removed')
    }
  } else throw new Error('usage: create | remove')
} catch (error) {
  process.stderr.write(String(error && error.stderr || error && error.message || error))
  process.exit(1)
}
`

/** A hook entry of ours: the one running our script. */
const ours = (hook: unknown): boolean => {
  const args = (hook as { args?: unknown } | undefined)?.args
  return Array.isArray(args) && typeof args[0] === 'string' && args[0].endsWith(SCRIPT_NAME)
}

/** Qoder settings with our two hooks in place of any earlier copy of them; everything else kept. */
export function withHooks(settings: Record<string, unknown>, node: string, script: string): Record<string, unknown> {
  const hooks = { ...(typeof settings.hooks === 'object' && settings.hooks !== null ? settings.hooks as Record<string, unknown> : {}) }
  for (const [event, op] of [['WorktreeCreate', 'create'], ['WorktreeRemove', 'remove']] as const) {
    const groups = (Array.isArray(hooks[event]) ? hooks[event] as Array<{ hooks?: unknown[] }> : [])
      .map((group) => ({ ...group, hooks: (Array.isArray(group.hooks) ? group.hooks : []).filter((hook) => !ours(hook)) }))
      .filter((group) => group.hooks.length > 0)
    // ELECTRON_RUN_AS_NODE: DSH Desktop's runtime is Electron's, which runs as plain Node with it.
    hooks[event] = [...groups, { hooks: [{ type: 'command', command: node, args: [script, op], env: { ELECTRON_RUN_AS_NODE: '1' }, timeout: 300 }] }]
  }
  return { ...settings, hooks }
}

export interface PrepareOptions {
  /** The runtime the hooks run the script with: the host's own. */
  node: string
  /** Where the script is written. */
  script: string
  run?: Exec
}

/**
 * Make a repository's Qoder tasks use DSH's worktree folder: the script, the
 * hooks in its `.qoder/settings.local.json`, and both kept out of git status.
 * Idempotent; run before each daemon start (the host's runtime may have moved
 * with an update).
 */
export async function prepareWorkspace(repo: string, options: PrepareOptions): Promise<void> {
  const run = options.run ?? exec
  await mkdir(dirname(options.script), { recursive: true })
  if (await readFile(options.script, 'utf8').catch(() => '') !== HOOK_SCRIPT) await writeFile(options.script, HOOK_SCRIPT)

  const file = join(repo, LOCAL_SETTINGS)
  const raw = await readFile(file, 'utf8').catch(() => '')
  let settings: Record<string, unknown> = {}
  if (raw.trim() !== '') {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>
    } catch (error) {
      throw new Error(`${file} is not valid JSON, so its worktree hooks were not set: ${(error as Error).message}`)
    }
  }
  const next = `${JSON.stringify(withHooks(settings, options.node, options.script), null, 2)}\n`
  if (next !== raw) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, next)
  }

  const result = await run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repo, timeoutMs: 10_000 })
  const path = result.code === 0 ? result.stdout.trim() : ''
  if (path === '') return
  const exclude = isAbsolute(path) ? path : resolve(repo, path)
  const text = await readFile(exclude, 'utf8').catch(() => '')
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()))
  const missing = [`/${WORKTREE_DIR}/`, `/${LOCAL_SETTINGS.replaceAll('\\', '/')}`].filter((line) => !lines.has(line))
  if (missing.length === 0) return
  await mkdir(dirname(exclude), { recursive: true })
  await writeFile(exclude, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`)
}
