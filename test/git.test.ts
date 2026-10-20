import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedDiff, parseCommitFiles, parseLog, parseRefs, parseStashes, parseStatus } from '../src/git/parse.ts'
import { GitService, runGit, workspaceGate, type Runner } from '../src/git/service.ts'
import { RepoStore } from '../src/client/git/store.ts'
import type { CommitDetail, DiffText, GitLog, GitReply, GitStatus, SuggestInput } from '../src/git/types.ts'
import { cleanMessage, createSuggest, resolveRoute, systemPrompt, userPrompt } from '../src/git/message.ts'
import { layout, WORKTREE } from '../src/client/git/lanes.ts'
import { parseConflict, parseDiff, splitRows, wordDiff } from '../src/client/git/diff.ts'

test('status: porcelain v2 with branch, renames, conflicts and untracked', () => {
  const raw = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb src/a b.ts',
    '1 .M N... 100644 100644 100644 aaa bbb src/c.ts',
    '1 MM N... 100644 100644 100644 aaa bbb both.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
    'old name.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
    '? 新文件.md',
    '',
  ].join('\0')
  const status = parseStatus(raw)
  assert.equal(status.branch, 'main')
  assert.equal(status.head, '1234567890abcdef1234567890abcdef12345678')
  assert.equal(status.upstream, 'origin/main')
  assert.equal(status.ahead, 2)
  assert.equal(status.behind, 1)
  assert.deepEqual(status.staged.map((c) => [c.code, c.path, c.from]), [
    ['M', 'src/a b.ts', undefined], ['M', 'both.ts', undefined], ['R', 'new name.ts', 'old name.ts'],
  ])
  assert.deepEqual(status.unstaged.map((c) => c.path), ['src/c.ts', 'both.ts'])
  assert.deepEqual(status.conflicts.map((c) => c.path), ['conflict.ts'])
  assert.deepEqual(status.untracked.map((c) => c.path), ['新文件.md'])
})

test('status: unborn and detached heads, and the entry cap', () => {
  const unborn = parseStatus(['# branch.oid (initial)', '# branch.head main', '? a', '? b', '? c', ''].join('\0'), 2)
  assert.equal(unborn.head, undefined)
  assert.equal(unborn.branch, 'main')
  assert.equal(unborn.untracked.length, 2)
  assert.equal(unborn.truncated, true)
  const detached = parseStatus(['# branch.oid abc', '# branch.head (detached)', ''].join('\0'))
  assert.equal(detached.branch, undefined)
})

test('log, refs, stashes and commit files', () => {
  const log = parseLog(`aaa1\x1fbbb2 ccc3\x1fAda\x1fada@x\x1f1700000000\x1fMerge branch\x1fwith US\0\nbbb2\x1f\x1fBo\x1fbo@x\x1f1690000000\x1froot\0`)
  assert.equal(log.length, 2)
  assert.deepEqual(log[0]!.parents, ['bbb2', 'ccc3'])
  assert.equal(log[0]!.subject, 'Merge branch\x1fwith US')
  assert.equal(log[0]!.at, 1700000000000)
  assert.deepEqual(log[1]!.parents, [])

  const refs = parseRefs([
    'h1\x1f\x1frefs/heads/main\x1forigin/main',
    'h1\x1f\x1frefs/remotes/origin/main\x1f',
    'h1\x1f\x1frefs/remotes/origin/HEAD\x1f',
    'tagobj\x1fh0\x1frefs/tags/v1\x1f',
  ].join('\n'))
  assert.deepEqual(refs, [
    { kind: 'head', name: 'main', hash: 'h1', upstream: 'origin/main' },
    { kind: 'remote', name: 'origin/main', hash: 'h1' },
    { kind: 'tag', name: 'v1', hash: 'h0' },
  ])

  assert.deepEqual(parseStashes('stash@{0}\x1f1700000000\x1fWIP on main: x\0stash@{1}\x1f1600000000\x1fOn dev: y\0'), [
    { index: 0, at: 1700000000000, message: 'WIP on main: x' },
    { index: 1, at: 1600000000000, message: 'On dev: y' },
  ])

  const files = parseCommitFiles('M\0a.ts\0R087\0old.ts\0new.ts\0A\0img.png\0', '3\t1\ta.ts\0' + '5\t2\t\0old.ts\0new.ts\0' + '-\t-\timg.png\0')
  assert.deepEqual(files.map((f) => [f.code, f.path, f.from, f.added, f.deleted, f.binary]), [
    ['M', 'a.ts', undefined, 3, 1, false],
    ['R', 'new.ts', 'old.ts', 5, 2, false],
    ['A', 'img.png', undefined, 0, 0, true],
  ])
})

test('diff: parses hunks, pairs del/add runs, splits sides', () => {
  const text = [
    'diff --git a/x b/x', '--- a/x', '+++ b/x',
    '@@ -1,4 +1,4 @@ fn',
    ' keep',
    '-const a = 1',
    '-const b = 2',
    '+const a = 10',
    '+const b = 2 // same',
    '+extra',
    ' tail',
    '\\ No newline at end of file',
  ].join('\n')
  const parsed = parseDiff(text)
  assert.equal(parsed.added, 3)
  assert.equal(parsed.deleted, 2)
  const kinds = parsed.lines.map((l) => l.kind)
  assert.deepEqual(kinds, ['hunk', 'ctx', 'del', 'del', 'add', 'add', 'add', 'ctx', 'note'])
  assert.equal(parsed.lines[2]!.pair, 4)
  assert.equal(parsed.lines[4]!.pair, 2)
  assert.equal(parsed.lines[3]!.pair, 5)
  assert.equal(parsed.lines[6]!.pair, undefined)
  assert.equal(parsed.lines[1]!.old, 1)
  assert.equal(parsed.lines[7]!.old, 4)
  assert.equal(parsed.lines[7]!.new, 5)
  const rows = splitRows(parsed.lines)
  assert.deepEqual(rows.slice(0, 5), [{ full: 0 }, { left: 1, right: 1 }, { left: 2, right: 4 }, { left: 3, right: 5 }, { right: 6 }])
})

test('diff: word spans and conflict regions', () => {
  const [del, add] = wordDiff('const value = compute(a, b)', 'const value = compute(a, c)')
  assert.deepEqual(del, [{ start: 25, end: 26 }])
  assert.deepEqual(add, [{ start: 25, end: 26 }])
  const [allDel] = wordDiff('alpha beta gamma', 'totally different words here')
  assert.deepEqual(allDel, [{ start: 0, end: 16 }])

  const conflict = parseConflict('a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> dev\nb\n')
  assert.deepEqual(conflict.lines.map((l) => l.region), ['none', 'marker', 'ours', 'marker', 'theirs', 'marker', 'none'])
  assert.equal(conflict.blocks, 1)
  assert.equal(addedDiff('f', 'x\ny\n').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, 2)
})

test('lanes: straight history stays in one lane', () => {
  const graph = layout([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }])
  assert.deepEqual(graph.rows.map((r) => r.lane), [0, 0, 0])
  assert.equal(graph.width, 1)
  assert.deepEqual(graph.rows[2]!.lines.map((l) => l.half), ['top'])
})

test('lanes: a merge forks a lane that rejoins at the common parent', () => {
  // m merges f into main; f and b both descend from a.
  const graph = layout([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.deepEqual(graph.rows.map((r) => r.lane), [0, 1, 0, 0])
  assert.equal(graph.width, 2)
  const merge = graph.rows[0]!
  assert.ok(merge.lines.some((l) => l.half === 'bottom' && l.from === 0 && l.to === 1))
  const root = graph.rows[3]!
  // Both lanes flow into the root commit.
  assert.deepEqual(root.lines.filter((l) => l.half === 'top').map((l) => [l.from, l.to]).sort(), [[0, 0], [1, 0]])
  // Lane colors stay with their line.
  assert.equal(graph.rows[1]!.color, merge.lines.find((l) => l.to === 1)!.color)
})

test('lanes: independent tips take new lanes and freed lanes are reused', () => {
  const graph = layout([
    { hash: 'x', parents: ['a'] },
    { hash: 'y', parents: ['a'] },
    { hash: 'a', parents: [] },
    { hash: 'z', parents: [] },
  ])
  assert.deepEqual(graph.rows.map((r) => r.lane), [0, 1, 0, 0])
  // The worktree pseudo-commit draws dashed into HEAD.
  const worktree = layout([{ hash: WORKTREE, parents: ['h'] }, { hash: 'h', parents: [] }])
  assert.ok(worktree.rows[0]!.lines.every((l) => l.dashed))
  assert.ok(worktree.rows[1]!.lines.every((l) => l.dashed))
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('service: stage, commit, diff, graph and branch operations on a real repository', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-git-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-out-')))
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    const service = new GitService(workspaceGate(() => [dir]))
    const call = async <T>(payload: Record<string, unknown>): Promise<T> => {
      const reply = await service.handle({ cwd: dir, ...payload }) as GitReply<T>
      if (!reply.ok) throw new Error(`${String(payload.op)}: ${reply.error.message}`)
      return reply.value
    }

    const denied = await service.handle({ cwd: outside, op: 'status' })
    assert.equal(denied.ok, false)
    assert.equal(!denied.ok && denied.error.code, 'denied')

    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'b c.txt'), 'space\n')
    let status = await call<GitStatus>({ op: 'status' })
    assert.equal(status.untracked.length, 2)
    assert.equal(status.head, undefined)

    const untracked = await call<DiffText>({ op: 'diff', source: 'untracked', path: 'a.txt' })
    assert.match(untracked.text, /^\+one$/m)

    await call({ op: 'stage', paths: ['a.txt'] })
    status = await call<GitStatus>({ op: 'status' })
    assert.deepEqual(status.staged.map((c) => c.path), ['a.txt'])
    await call({ op: 'unstage', paths: ['a.txt'] })
    status = await call<GitStatus>({ op: 'status' })
    assert.equal(status.staged.length, 0)

    await call({ op: 'commit', message: 'first\n\nbody line', all: true })
    status = await call<GitStatus>({ op: 'status' })
    assert.equal(status.untracked.length + status.staged.length + status.unstaged.length, 0)
    assert.ok(status.head)

    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\n')
    const unstaged = await call<DiffText>({ op: 'diff', source: 'unstaged', path: 'a.txt' })
    assert.match(unstaged.text, /^-two$/m)
    assert.match(unstaged.text, /^\+TWO$/m)
    const before = status.key
    status = await call<GitStatus>({ op: 'status' })
    assert.notEqual(status.key, before)
    await call({ op: 'discard', paths: ['a.txt'], untracked: [] })
    status = await call<GitStatus>({ op: 'status' })
    assert.equal(status.unstaged.length, 0)

    await call({ op: 'branch-create', name: 'feature', checkout: true })
    writeFileSync(join(dir, 'f.txt'), 'feature\n')
    await call({ op: 'commit', message: 'feature work', all: true })
    await call({ op: 'checkout', ref: 'main', kind: 'branch' })
    await call({ op: 'merge', ref: 'feature' })
    const log = await call<GitLog>({ op: 'log' })
    assert.equal(log.branch, 'main')
    assert.equal(log.commits.length, 2)
    assert.ok(log.refs.some((ref) => ref.kind === 'head' && ref.name === 'feature'))

    // A scoped log reads one ref's history only; unknown refs read as empty, option-like ones are refused.
    git('branch', 'side', log.commits[1]!.hash)
    git('checkout', '-q', 'side')
    writeFileSync(join(dir, 'side.txt'), 'side\n')
    git('add', 'side.txt')
    git('commit', '-q', '-m', 'side work')
    git('checkout', '-q', 'main')
    assert.equal((await call<GitLog>({ op: 'log' })).commits.length, 3)
    assert.deepEqual((await call<GitLog>({ op: 'log', ref: 'main' })).commits.map((c) => c.subject), ['feature work', log.commits[1]!.subject])
    assert.deepEqual((await call<GitLog>({ op: 'log', ref: 'side' })).commits.map((c) => c.subject), ['side work', log.commits[1]!.subject])
    assert.equal((await call<GitLog>({ op: 'log', ref: 'gone' })).commits.length, 0)
    const optionRef = await service.handle({ cwd: dir, op: 'log', ref: '--all' })
    assert.equal(optionRef.ok, false)
    git('branch', '-D', 'side')

    const detail = await call<CommitDetail>({ op: 'show', hash: log.commits[0]!.hash })
    assert.equal(detail.subject, 'feature work')
    assert.deepEqual(detail.files.map((f) => [f.code, f.path, f.added]), [['A', 'f.txt', 1]])
    const commitDiff = await call<DiffText>({ op: 'diff', source: 'commit', hash: detail.hash, path: 'f.txt' })
    assert.match(commitDiff.text, /^\+feature$/m)
    const root = await call<CommitDetail>({ op: 'show', hash: log.commits[1]!.hash })
    assert.equal(root.body, 'body line')
    assert.equal(root.files.length, 2)
    const rootDiff = await call<DiffText>({ op: 'diff', source: 'commit', hash: root.hash, path: 'b c.txt' })
    assert.match(rootDiff.text, /^\+space$/m)

    // Images: both sides come back byte-exact as data URLs.
    const pngA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x01])
    const pngB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfe, 0x02, 0x03])
    const dataUrl = (bytes: Buffer): string => `data:image/png;base64,${bytes.toString('base64')}`
    writeFileSync(join(dir, 'pic.png'), pngA)
    const addedImage = await call<DiffText>({ op: 'diff', source: 'untracked', path: 'pic.png' })
    assert.deepEqual(addedImage.images, { after: { size: pngA.length, url: dataUrl(pngA) } })
    await call({ op: 'commit', message: 'image', all: true })
    writeFileSync(join(dir, 'pic.png'), pngB)
    const changedImage = await call<DiffText>({ op: 'diff', source: 'unstaged', path: 'pic.png' })
    assert.equal(changedImage.images?.before?.url, dataUrl(pngA))
    assert.equal(changedImage.images?.after?.url, dataUrl(pngB))
    await call({ op: 'stage', paths: ['pic.png'] })
    const stagedImage = await call<DiffText>({ op: 'diff', source: 'staged', path: 'pic.png' })
    assert.equal(stagedImage.images?.before?.url, dataUrl(pngA))
    assert.equal(stagedImage.images?.after?.url, dataUrl(pngB))
    await call({ op: 'commit', message: 'image 2', all: true })
    const imageHead = (await call<GitLog>({ op: 'log' })).commits[0]!.hash
    const commitImage = await call<DiffText>({ op: 'diff', source: 'commit', hash: imageHead, path: 'pic.png' })
    assert.equal(commitImage.images?.before?.size, pngA.length)
    assert.equal(commitImage.images?.after?.url, dataUrl(pngB))
    await call({ op: 'reset', hash: log.commits[0]!.hash, mode: 'hard' })

    await call({ op: 'tag-create', name: 'v1', at: detail.hash })
    await call({ op: 'branch-delete', name: 'feature' })
    const after = await call<GitLog>({ op: 'log' })
    assert.ok(after.refs.some((ref) => ref.kind === 'tag' && ref.name === 'v1'))
    assert.ok(!after.refs.some((ref) => ref.name === 'feature'))

    writeFileSync(join(dir, 'a.txt'), 'stash me\n')
    await call({ op: 'stash-push', message: 'wip' })
    status = await call<GitStatus>({ op: 'status' })
    assert.equal(status.stashes.length, 1)
    await call({ op: 'stash-pop', index: 0 })
    status = await call<GitStatus>({ op: 'status' })
    assert.equal(status.unstaged.length, 1)

    const amended = await call<string>({ op: 'head-message' })
    assert.equal(amended, 'feature work')

    const bad = await service.handle({ cwd: dir, op: 'checkout', ref: '--orphan', kind: 'branch' })
    assert.equal(bad.ok, false)
    const escape = await service.handle({ cwd: dir, op: 'diff', source: 'untracked', path: '../x' })
    assert.equal(escape.ok, false)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('service: checking out a remote branch fetches it and fast-forwards the local branch', { skip: !hasGit() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-remote-')))
  try {
    const at = (cwd: string) => (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
    const origin = join(root, 'origin.git')
    const dir = join(root, 'here')
    const other = join(root, 'other')
    at(root)('init', '-q', '--bare', '-b', 'main', origin)
    at(root)('clone', '-q', origin, other)
    const theirs = at(other)
    theirs('config', 'user.name', 'Test')
    theirs('config', 'user.email', 'test@example.com')
    theirs('config', 'commit.gpgsign', 'false')
    theirs('commit', '-q', '--allow-empty', '-m', 'root')
    theirs('push', '-q', 'origin', 'main')
    theirs('switch', '-q', '-c', 'feature')
    theirs('commit', '-q', '--allow-empty', '-m', 'feature one')
    theirs('push', '-q', 'origin', 'feature')
    at(root)('clone', '-q', origin, dir)
    const git = at(dir)
    const service = new GitService(workspaceGate(() => [dir]))
    const call = async (payload: Record<string, unknown>): Promise<void> => {
      const reply = await service.handle({ cwd: dir, ...payload }) as GitReply<unknown>
      if (!reply.ok) throw new Error(`${String(payload.op)}: ${reply.error.message}`)
    }

    // First time: a local branch tracking the remote one.
    await call({ op: 'checkout', ref: 'origin/feature', kind: 'remote' })
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature')
    git('switch', '-q', 'main')

    // The remote moves on without a fetch here: checking it out again fetches and catches the local branch up.
    theirs('commit', '-q', '--allow-empty', '-m', 'feature two')
    theirs('push', '-q', 'origin', 'feature')
    await call({ op: 'checkout', ref: 'origin/feature', kind: 'remote' })
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature')
    assert.equal(git('rev-parse', 'HEAD').trim(), theirs('rev-parse', 'HEAD').trim())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status: a watched repository answers unchanged polls without running git', { skip: !hasGit() || !['win32', 'darwin'].includes(process.platform) }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-watch-')))
  const runs: string[] = []
  const service = new GitService(workspaceGate(() => [dir]), (args, cwd, options) => {
    runs.push(args[0]!)
    return runGit(args, cwd, options)
  }, undefined, { watch: true })
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    const status = async (fresh = false): Promise<GitStatus> => {
      const reply = await service.handle({ cwd: dir, op: 'status', ...(fresh ? { fresh } : {}) }) as GitReply<GitStatus>
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.value
    }
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))
    const first = await status()
    assert.equal(first.watched, true)
    await settle()
    await status()
    runs.length = 0
    assert.equal((await status()).key, (await status()).key)
    assert.equal(runs.length, 0, 'an unchanged poll runs no git')

    // A work-tree edit re-runs `git status` alone.
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    let seen: GitStatus | undefined
    for (let i = 0; i < 40 && (seen?.untracked.length ?? 0) === 0; i++) {
      await settle()
      seen = await status()
    }
    assert.deepEqual(seen!.untracked.map((change) => change.path), ['a.txt'])
    assert.ok(!runs.includes('for-each-ref'), 'refs are reused for a work-tree change')

    // A commit made outside the service moves refs: the watcher sees `.git` change.
    git('add', '-A')
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one')
    for (let i = 0; i < 40 && seen!.head === undefined; i++) {
      await settle()
      seen = await status()
    }
    assert.ok(seen!.head)
    assert.notEqual(seen!.refsKey, first.refsKey)

    // fresh always reads.
    runs.length = 0
    await status(true)
    assert.ok(runs.includes('status'))
  } finally {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('suggest-message: reads the change a commit would record and hands it to the model', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-suggest-')))
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    const seen: SuggestInput[] = []
    const service = new GitService(workspaceGate(() => [dir]), undefined, async (input) => {
      seen.push(input)
      return '  feat: add greeting\r\n'
    })
    const suggest = (): Promise<GitReply<string>> => service.handle({ cwd: dir, op: 'suggest-message' }) as Promise<GitReply<string>>

    const empty = await suggest()
    assert.equal(!empty.ok && empty.error.code, 'invalid')

    // Unborn, nothing staged: the untracked files are the change.
    writeFileSync(join(dir, 'hello.txt'), 'hi\n')
    const first = await suggest()
    assert.deepEqual(first, { ok: true, value: 'feat: add greeting' })
    assert.equal(seen[0]!.scope, 'all')
    assert.deepEqual(seen[0]!.untracked, [{ path: 'hello.txt', text: 'hi\n' }])

    git('add', '-A')
    git('commit', '-q', '-m', 'chore: init')
    writeFileSync(join(dir, 'hello.txt'), 'hello\n')
    writeFileSync(join(dir, 'other.txt'), 'x\n')
    await suggest()
    assert.equal(seen[1]!.scope, 'all')
    assert.match(seen[1]!.patch, /^\+hello$/m)
    assert.deepEqual(seen[1]!.untracked.map((file) => file.path), ['other.txt'])
    assert.deepEqual(seen[1]!.recent, ['chore: init'])
    assert.equal(seen[1]!.branch, 'main')

    // Something staged: only the index counts.
    git('add', 'other.txt')
    await suggest()
    assert.equal(seen[2]!.scope, 'staged')
    assert.match(seen[2]!.stat, /other\.txt/)
    assert.doesNotMatch(seen[2]!.patch, /hello/)
    assert.deepEqual(seen[2]!.untracked, [])

    const none = new GitService(workspaceGate(() => [dir]))
    const unavailable = await none.handle({ cwd: dir, op: 'suggest-message' })
    assert.equal(!unavailable.ok && unavailable.error.code, 'unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('service: queues entire multi-command operations and recovers from failure', async () => {
  const cwd = process.cwd()
  const events: string[] = []
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const runner: Runner = async (args) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${cwd}\n${join(cwd, '.git')}\n`, stderr: '' }
    events.push(args[0]!)
    if (args[0] === 'add') { started(); await held }
    return { code: args[0] === 'commit' ? 1 : 0, stdout: '', stderr: '' }
  }
  const service = new GitService(async () => cwd, runner)
  const commit = service.handle({ cwd, op: 'commit', all: true, message: 'one' })
  await began
  const checkout = service.handle({ cwd, op: 'checkout', kind: 'branch', ref: 'other' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['add'])
  release()
  assert.equal((await commit).ok, false)
  assert.equal((await checkout).ok, true)
  assert.deepEqual(events, ['add', 'commit', 'switch'])
})

test('service: rejects incomplete machine reads/writes, only diff and suggestion patch allow partial output', async () => {
  const cwd = process.cwd()
  let broken = 'status'
  let code = 0
  const runner: Runner = async (args, _cwd, options) => {
    const verb = args[0] === '--literal-pathspecs' ? args[1] : args[0]
    if (verb === 'rev-parse') return { code: 0, stdout: `${cwd}\n${join(cwd, '.git')}\n`, stderr: '' }
    if (verb === broken) {
      if (verb === 'diff') assert.equal(options?.allowPartial, true)
      return { code, stdout: 'partial\n', stderr: '', overflow: true, truncated: true }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const service = new GitService(async () => cwd, runner)
  for (const op of ['status', 'stage']) {
    broken = op === 'stage' ? 'add' : 'status'
    const reply = await service.handle({ cwd, op })
    assert.equal(!reply.ok && reply.error.code, 'overflow')
  }
  broken = 'for-each-ref'
  const status = await service.handle({ cwd, op: 'status' })
  assert.equal(!status.ok && status.error.code, 'overflow', 'auxiliary machine reads cannot swallow overflow')
  broken = 'diff'
  const diff = await service.handle({ cwd, op: 'diff', source: 'unstaged', path: 'x' }) as GitReply<DiffText>
  assert.equal(diff.ok && diff.value.truncated, true)
  code = 1
  assert.equal((await service.handle({ cwd, op: 'diff', source: 'unstaged', path: 'x' })).ok, false)
})

test('client: queued mutations keep busy through every request and refresh', async () => {
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const store = new RepoStore(process.cwd(), async (_cwd, request) => {
    calls.push(request.op)
    if (request.op === 'stage') { started(); await held }
    return { ok: false, error: { code: 'failed', message: 'expected' } }
  })
  const busy: Array<string | undefined> = []
  store.subscribe(() => { busy.push(store.getSnapshot().busy) })
  const first = store.run({ op: 'stage' }, { quiet: true })
  const second = store.run({ op: 'checkout', kind: 'branch', ref: 'main' }, { quiet: true })
  await began
  assert.deepEqual(calls, ['stage'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['stage', 'status', 'checkout', 'status'])
  assert.equal(busy.at(-1), undefined)
  assert.ok(busy.slice(0, -1).every((value) => value !== undefined))
})

test('runGit: bounded streams report overflow without inventing success', { skip: !hasGit() }, async () => {
  const cwd = process.cwd()
  const partial = await runGit(['--version'], cwd, { read: true, allowPartial: true, maxBytes: 5 })
  assert.equal(partial.code, 0)
  assert.equal(partial.stdout.length, 5)
  assert.equal(partial.overflow, true)
  assert.equal(partial.truncated, true)
  const failed = await runGit(['definitely-not-a-command'], cwd, { maxStderrBytes: 5 })
  assert.notEqual(failed.code, 0)
  assert.ok(Buffer.byteLength(failed.stderr) <= 5)
  assert.equal(failed.overflow, true)
})

test('runGit: timeout terminates descendants and settles only after close', { skip: !hasGit(), timeout: 15_000 }, async () => {
  const begun = Date.now()
  const result = await runGit(['-c', 'alias.agent-hub-wait=!node -e "setTimeout(() => {}, 60000)"', 'agent-hub-wait'], process.cwd(), { timeoutMs: 500 })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.code, 0)
  assert.ok(Date.now() - begun < 10_000, 'descendants must not keep the close event blocked')
})

test('service: suggestion marks an explicitly partial patch but rejects incomplete names', async () => {
  const cwd = process.cwd()
  let namesOverflow = false
  let seen: SuggestInput | undefined
  const runner: Runner = async (args, _cwd, options) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${cwd}\n${join(cwd, '.git')}\n`, stderr: '' }
    if (args.includes('--name-only')) return { code: 0, stdout: 'x\0', stderr: '', overflow: namesOverflow }
    if (args.includes('-U2')) {
      assert.equal(options?.allowPartial, true)
      return { code: 0, stdout: '+x\npartial', stderr: '', overflow: true, truncated: true }
    }
    return { code: 0, stdout: args.includes('--stat=100') ? ' x | 1 +' : '', stderr: '' }
  }
  const service = new GitService(async () => cwd, runner, async (input) => { seen = input; return 'message' })
  assert.equal((await service.handle({ cwd, op: 'suggest-message' })).ok, true)
  assert.equal(seen?.truncated, true)
  assert.equal(seen?.patch, '+x')
  namesOverflow = true
  const reply = await service.handle({ cwd, op: 'suggest-message' })
  assert.equal(!reply.ok && reply.error.code, 'overflow')
})

test('service: special filenames are literal single-file operations', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-literal-')))
  const service = new GitService(workspaceGate(() => [dir]), undefined, undefined, { watch: false })
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    const names = ['[ab].txt', 'a.txt', '-dash.txt', '空 格.txt', ...(process.platform === 'win32' ? [] : ['*.txt', ':(glob)*.txt'])]
    for (const name of names) writeFileSync(join(dir, name), `original ${name}\n`)
    const call = async (payload: Record<string, unknown>): Promise<void> => {
      const reply = await service.handle({ cwd: dir, ...payload })
      assert.equal(reply.ok, true, JSON.stringify(reply))
    }
    for (const name of names) {
      await call({ op: 'stage', paths: [name] })
      assert.deepEqual(git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean), [name])
      await call({ op: 'unstage', paths: [name] })
    }
    git('add', '-A')
    git('-c', 'user.name=T', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial')
    for (const name of names) writeFileSync(join(dir, name), `changed ${name}\n`)
    const diff = await service.handle({ cwd: dir, op: 'diff', source: 'unstaged', path: '[ab].txt' }) as GitReply<DiffText>
    assert.ok(diff.ok)
    assert.match(diff.value.text, /changed \[ab\]\.txt/)
    assert.doesNotMatch(diff.value.text, /changed a\.txt/)
    for (const name of names) {
      await call({ op: 'stage', paths: [name] })
      assert.deepEqual(git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean), [name])
      await call({ op: 'unstage', paths: [name] })
      await call({ op: 'discard', paths: [name], untracked: [] })
    }
    for (const name of names) writeFileSync(join(dir, `new-${name}`), 'new\n')
    for (const name of names) await call({ op: 'discard', paths: [], untracked: [`new-${name}`] })
    assert.equal(git('status', '--porcelain'), '')
  } finally {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commit message prompt, cleanup and model call', async () => {
  assert.equal(cleanMessage('```\nfix: a\n\n- b\n```'), 'fix: a\n\n- b')
  assert.equal(cleanMessage('Commit message: "fix: a"'), 'fix: a')
  assert.match(systemPrompt('Write in Chinese'), /Write in Chinese$/)
  const input: SuggestInput = { scope: 'staged', stat: ' a | 1 +', patch: '+x', untracked: [{ path: 'n.bin' }], recent: ['feat: y'], truncated: true }
  const prompt = userPrompt(input)
  assert.match(prompt, /- feat: y/)
  assert.match(prompt, /--- n\.bin/)
  assert.match(prompt, /too large/)

  const calls: Array<Record<string, unknown>> = []
  const llm = {
    async *stream(options: object) {
      calls.push(options as Record<string, unknown>)
      yield { type: 'text-delta', text: 'feat: ' }
      yield { type: 'text-delta', text: 'z' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const suggest = createSuggest(() => llm, () => resolveRoute({ provider: ' p ', model: 'm' }, () => undefined), () => ({}))
  assert.equal(await suggest(input), 'feat: z')
  assert.equal(calls[0]!.provider, 'p')
  assert.deepEqual(resolveRoute({}, () => ({ provider: 'd', model: 'e' })), { provider: 'd', model: 'e' })
  const missing = createSuggest(() => llm, () => undefined, () => ({}))
  await assert.rejects(missing(input), (error: { code?: string }) => error.code === 'unavailable')
})
