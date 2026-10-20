import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countChanges, parseWorktrees } from '../src/git/parse.ts'
import { reclaimDeps, shareDeps } from '../src/git/deps.ts'
import { GitService, pathKey, workspaceGate, type Workspaces } from '../src/git/service.ts'
import type { GitReply, WorktreeList, WorktreeOpened } from '../src/git/types.ts'

test('worktree porcelain and change counts', () => {
  const raw = [
    'worktree /r/main', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r/main.wt/feat/x', 'HEAD bbb', 'branch refs/heads/feat/x', 'locked busy agent', '',
    'worktree /r/gone', 'HEAD ccc', 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\0')
  assert.deepEqual(parseWorktrees(raw), [
    { path: '/r/main', head: 'aaa', branch: 'main', bare: false },
    { path: '/r/main.wt/feat/x', head: 'bbb', branch: 'feat/x', bare: false, locked: 'busy agent' },
    { path: '/r/gone', head: 'ccc', bare: false, prunable: 'gitdir file points to non-existent location' },
  ])
  const status = ['# branch.oid x', '1 .M N... 1 1 1 a b f.ts', '2 R. N... 1 1 1 a b R100 new.ts', 'old.ts', '? n.ts', ''].join('\0')
  assert.equal(countChanges(status), 3)
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** An in-memory stand-in for DSH's workspace registry. */
function registry(): Workspaces & { records: Map<string, { id: string; path: string; title: string; sessionIds: string[] }>; archived: Set<string>; busy: Set<string> } {
  const records = new Map<string, { id: string; path: string; title: string; sessionIds: string[] }>()
  const archived = new Set<string>()
  const busy = new Set<string>()
  let next = 0
  return {
    records, archived, busy,
    list: () => [...records.values()],
    async create(path, title) {
      const id = `w${++next}`
      records.set(id, { id, path: realpathSync(path), title, sessionIds: [] })
      return { id }
    },
    async delete(id) { return records.delete(id) },
    async archiveSession(id) {
      if (busy.has(id)) throw new Error(`cannot archive session '${id}': the session is active (turn)`)
      archived.add(id)
    },
    async unarchiveSession(id) { archived.delete(id) },
  }
}

test('worktrees: add next to the repository, register, open, refuse and remove', { skip: !hasGit() }, async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-wt-')))
  const dir = join(parent, 'proj')
  mkdirSync(dir)
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    git('branch', 'existing')

    const workspaces = registry()
    await workspaces.create(dir, 'proj')
    const released: string[] = []
    const service = new GitService(workspaceGate(() => workspaces.list().map((w) => w.path)), undefined, undefined, {
      workspaces: () => workspaces, release: (folder) => { released.push(folder) },
    })
    const call = async <T>(payload: Record<string, unknown>, cwd = dir): Promise<GitReply<T>> => await service.handle({ cwd, ...payload }) as GitReply<T>
    const ok = async <T>(payload: Record<string, unknown>, cwd = dir): Promise<T> => {
      const reply = await call<T>(payload, cwd)
      if (!reply.ok) throw new Error(`${String(payload.op)}: ${reply.error.message}`)
      return reply.value
    }

    // A new branch and an existing one, each under <repo>/.worktrees/<branch>, which the
    // repository's own exclude file keeps out of the main tree's status (written once).
    const feat = await ok<WorktreeOpened>({ op: 'worktree-add', branch: 'feat/x' })
    assert.equal(pathKey(feat.path), pathKey(join(dir, '.worktrees', 'feat', 'x')))
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).includes('.worktrees'), false)
    assert.ok(feat.workspaceId)
    assert.equal(workspaces.records.get(feat.workspaceId!)!.title, 'proj · feat/x')
    const existing = await ok<WorktreeOpened>({ op: 'worktree-add', branch: 'existing' })
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: existing.path, encoding: 'utf8' }).trim(), 'existing')
    const again = await call({ op: 'worktree-add', branch: 'feat/x' })
    assert.equal(again.ok, false)
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(exclude.split(/\r?\n/).filter((line) => line === '/.worktrees/').length, 1)

    // The pane inside a tree sees every tree, marks its own and the main one.
    writeFileSync(join(feat.path, 'b.txt'), 'new\n')
    const list = await ok<WorktreeList>({ op: 'worktree-list' }, feat.path)
    assert.equal(pathKey(list.home), pathKey(join(dir, '.worktrees')))
    assert.equal(list.worktrees.length, 3)
    assert.ok(list.worktrees[0]!.main)
    const self = list.worktrees.find((tree) => tree.current)!
    assert.equal(self.branch, 'feat/x')
    assert.equal(self.changes, 1)
    assert.equal(self.workspace?.id, feat.workspaceId)

    // A tree made outside DSH registers on open.
    const outsidePath = join(parent, 'manual')
    git('worktree', 'add', '-q', '-b', 'manual', outsidePath)
    const opened = await ok<WorktreeOpened>({ op: 'worktree-open', path: outsidePath })
    assert.equal(workspaces.records.get(opened.workspaceId!)!.title, 'proj · manual')
    assert.equal((await call({ op: 'worktree-open', path: parent })).ok, false)

    // Removing: never the main tree or the pane's own; a working session blocks it and nothing changes.
    assert.equal((await call({ op: 'worktree-remove', path: dir }, feat.path)).ok, false)
    assert.equal((await call({ op: 'worktree-remove', path: feat.path }, feat.path)).ok, false)
    workspaces.records.get(feat.workspaceId!)!.sessionIds.push('s1', 's2')
    workspaces.busy.add('s2')
    const blocked = await call({ op: 'worktree-remove', path: feat.path })
    assert.equal(!blocked.ok && blocked.error.code, 'busy')
    assert.equal(workspaces.archived.size, 0)
    // Uncommitted changes need force; the refusal also undoes the archiving.
    workspaces.busy.clear()
    assert.equal((await call({ op: 'worktree-remove', path: feat.path })).ok, false)
    assert.equal(workspaces.archived.size, 0)
    await ok({ op: 'worktree-remove', path: feat.path, force: true, deleteBranch: true })
    assert.ok(!existsSync(feat.path))
    assert.equal(pathKey(released.at(-1)!), pathKey(feat.path), 'processes working in the tree are let go first')
    assert.deepEqual([...workspaces.archived].sort(), ['s1', 's2'])
    assert.ok(!workspaces.records.has(feat.workspaceId!))
    assert.equal(git('branch', '--list', 'feat/x').trim(), '')

    // Lock, unlock, prune.
    await ok({ op: 'worktree-lock', path: existing.path })
    assert.equal((await ok<WorktreeList>({ op: 'worktree-list' })).worktrees.find((tree) => tree.branch === 'existing')!.locked, '')
    await ok({ op: 'worktree-unlock', path: existing.path })
    rmSync(outsidePath, { recursive: true, force: true })
    const pruned = (await ok<WorktreeList>({ op: 'worktree-list' })).worktrees.find((tree) => tree.branch === 'manual')!
    assert.ok(pruned.prunable !== undefined)
    await ok({ op: 'worktree-prune' })
    assert.equal((await ok<WorktreeList>({ op: 'worktree-list' })).worktrees.length, 2)

    // A remote branch: a local branch tracking it, the remote asked for even when origin has one too.
    for (const remote of ['origin', 'fork']) {
      git('remote', 'add', remote, dir)
      git('update-ref', `refs/remotes/${remote}/rx`, 'HEAD')
    }
    const fromFork = await ok<WorktreeOpened>({ op: 'worktree-add', branch: 'rx', base: 'fork/rx' })
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: fromFork.path, encoding: 'utf8' }).trim(), 'rx')
    assert.equal(git('rev-parse', '--abbrev-ref', 'rx@{upstream}').trim(), 'fork/rx')
    git('update-ref', 'refs/remotes/origin/ry', 'HEAD')
    await ok<WorktreeOpened>({ op: 'worktree-add', branch: 'ry' })
    assert.equal(git('rev-parse', '--abbrev-ref', 'ry@{upstream}').trim(), 'origin/ry')
    service.dispose()
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('worktrees: opening one tree of a repository registers the others', { skip: !hasGit() }, async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-adopt-')))
  const dir = join(parent, 'proj')
  mkdirSync(dir)
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first')
    const side = join(parent, 'side')
    const gone = join(parent, 'gone')
    git('worktree', 'add', '-q', '-b', 'side', side)
    git('worktree', 'add', '-q', '--detach', gone)
    rmSync(gone, { recursive: true, force: true })

    const workspaces = registry()
    const service = new GitService(workspaceGate(() => workspaces.list().map((w) => w.path)), undefined, undefined, { workspaces: () => workspaces })
    // Opened from a linked tree: the main tree comes along, a tree whose folder is gone does not.
    await workspaces.create(side, 'side')
    assert.equal(await service.adopt(side), 1)
    const titles = (): Map<string, string> => new Map(workspaces.list().map((w) => [pathKey(w.path), w.title]))
    assert.deepEqual(titles(), new Map([[pathKey(side), 'side'], [pathKey(dir), 'proj']]))
    // Again: nothing new, nothing retitled.
    assert.equal(await service.adopt(dir), 0)
    assert.equal(workspaces.list().length, 2)
    // A worktree added later from the command line: the next refresh registers it, titled by its folder.
    const late = join(parent, 'late')
    git('worktree', 'add', '-q', '-b', 'feat/late', late)
    assert.equal(await service.adopt(dir), 1)
    assert.equal(titles().get(pathKey(late)), 'late')
    // Outside git: nothing.
    assert.equal(await service.adopt(parent), 0)
    assert.equal(workspaces.list().length, 3)
    service.dispose()
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('dropWorktree: a deleted worktree workspace takes its folder along; the main tree, locked and re-registered trees stay', { skip: !hasGit() }, async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-wt-drop-')))
  const dir = join(parent, 'proj')
  mkdirSync(dir)
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    const feat = join(parent, 'feat')
    const locked = join(parent, 'locked')
    const kept = join(parent, 'kept')
    git('worktree', 'add', '-q', '-b', 'feat', feat)
    git('worktree', 'add', '-q', '-b', 'locked', locked)
    git('worktree', 'lock', locked)
    git('worktree', 'add', '-q', '-b', 'kept', kept)
    writeFileSync(join(feat, 'dirty.txt'), 'uncommitted\n')

    const workspaces = registry()
    await workspaces.create(kept, 'proj · kept')
    const released: string[] = []
    const service = new GitService(workspaceGate(() => workspaces.list().map((w) => w.path)), undefined, undefined, {
      workspaces: () => workspaces, release: (folder) => { released.push(folder) },
    })

    assert.equal(await service.dropWorktree(feat), true)
    assert.equal(existsSync(feat), false)
    assert.deepEqual(released, [feat])
    assert.match(git('branch', '--list', 'feat'), /feat/)
    assert.equal(await service.dropWorktree(dir), false)
    assert.equal(existsSync(join(dir, 'a.txt')), true)
    assert.equal(await service.dropWorktree(locked), false)
    assert.equal(existsSync(locked), true)
    assert.equal(await service.dropWorktree(kept), false)
    assert.equal(existsSync(kept), true)
    assert.equal(await service.dropWorktree(join(parent, 'missing')), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('worktree packages: cloned from the main tree, shared again only where the lockfile matches', { skip: process.platform !== 'darwin' }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ah-deps-')))
  try {
    const tree = (name: string, lock: string): string => {
      const dir = join(base, name, 'front')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package-lock.json'), lock)
      return join(base, name)
    }
    const main = tree('main', 'v1')
    mkdirSync(join(main, 'front', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(main, 'front', 'node_modules', 'pkg', 'index.js'), 'main')
    const lockfiles = ['front/package-lock.json']

    // A new tree gets the main tree's packages; one that has its own keeps them.
    const fresh = tree('fresh', 'v1')
    assert.deepEqual((await shareDeps(main, fresh, lockfiles)).dirs, ['front/node_modules'])
    assert.equal(readFileSync(join(fresh, 'front', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'main')
    assert.deepEqual((await shareDeps(main, fresh, lockfiles)).dirs, [])

    // Reclaiming swaps each package installed alike (same manifest, nothing nested) for a clone,
    // whatever the lockfiles say, and leaves the others alone.
    const install = (dir: string, name: string, manifest: string, body: string, nested = false): void => {
      const at = join(dir, 'front', 'node_modules', ...name.split('/'))
      mkdirSync(join(at, ...(nested ? ['node_modules', 'dep'] : [])), { recursive: true })
      writeFileSync(join(at, 'package.json'), manifest)
      writeFileSync(join(at, 'index.js'), body)
    }
    for (const [name, manifest, nested] of [['same', 'a@1', false], ['@s/scoped', 's@1', false], ['bumped', 'b@1', false], ['deep', 'd@1', true]] as const) install(main, name, manifest, 'main', nested)
    const other = tree('other', 'v2')
    install(other, 'same', 'a@1', 'own')
    install(other, '@s/scoped', 's@1', 'own')
    install(other, 'bumped', 'b@2', 'own')
    install(other, 'deep', 'd@1', 'own', true)
    install(other, 'extra', 'e@1', 'own')
    const read = (name: string): string => readFileSync(join(other, 'front', 'node_modules', ...name.split('/'), 'index.js'), 'utf8')
    const result = await reclaimDeps(main, [other], lockfiles)
    assert.equal(result.trees, 1)
    assert.equal(result.packages, 2)
    assert.deepEqual(['same', '@s/scoped', 'bumped', 'deep', 'extra'].map(read), ['main', 'main', 'own', 'own', 'own'])
    assert.equal(existsSync(join(other, 'front', 'node_modules.ah-old')), false)
    assert.equal(existsSync(join(other, 'front', 'node_modules.ah-shared')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
