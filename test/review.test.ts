import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps, blankSheet, parseLocation, parseSheet, serializeSheet } from '../src/review/sheet.ts'
import { readTracked, reviewCommandReason, reviewTrusts, reviewWriteReason, writtenPath } from '../src/review/guard.ts'
import { commentableLines, GitHub, repoSlug, type Pull, type PullState, type ReviewPayload } from '../src/review/github.ts'
import { buildReview, reviewPayload } from '../src/review/submit.ts'
import { diffCounts, lastRun, nextRun, phaseOf, ReviewService, splitPatches, symbolsOf, type ReviewSettings, type SessionHost } from '../src/review/index.ts'
import { DEFAULT_STYLE, firstMessage, reviewSection, rewritePrompt } from '../src/review/prompt.ts'
import { setLocaleSource } from '../src/locale.ts'
import { REVIEW_DIR, reviewRank, sheetName, type Explained, type Finding, type Explanation, type PullDiff, type ReviewItem, type ReviewPreview, type ReviewRun, type ReviewState, type Sheet, type SheetReply } from '../src/review/types.ts'

const SHA = 'a'.repeat(40)

const SAMPLE = `---
pr: acme/app#12
title: Add retry to webhook
author: alice
base: main
head: ${SHA}
round: 1
status: ready
decision: request-changes
summary: Nice work, a couple of things first.
session: session-1
---

## 变更说明

Adds a retry loop.

## 必须修改

- [x] **F1**: \`src/hook.ts#L10-L12\` 没有幂等键
  可能重复扣款
  > EN: Looks good. One thing though, add an idempotency key?
  > Thanks!

## Nice to have
- [ ] F2 \`src/hook.ts:30\` 常量可以提出来
  > EN: Small nit: pull this into a constant.
- [ ] 整体可以加日志
  > EN: Maybe log retries.

## Rules

- focus on payments

## Something else

kept as is
`

test('review sheet: lenient read, canonical write, round trip', () => {
  const parsed = parseSheet(SAMPLE)
  assert.ok('sheet' in parsed)
  const sheet = parsed.sheet
  assert.equal(sheet.pr, 'acme/app#12')
  assert.equal(sheet.decision, 'request-changes')
  assert.equal(sheet.overview, 'Adds a retry loop.')
  assert.deepEqual(sheet.findings.map((f) => [f.id, f.severity, f.checked, f.path, f.start, f.line]), [
    ['F1', 'must', true, 'src/hook.ts', 10, 12],
    ['F2', 'nice', false, 'src/hook.ts', undefined, 30],
    ['F3', 'nice', false, undefined, undefined, undefined],
  ])
  assert.equal(sheet.findings[0]!.text, '没有幂等键\n可能重复扣款')
  assert.equal(sheet.findings[0]!.en, 'Looks good. One thing though, add an idempotency key?\nThanks!')
  assert.equal(sheet.findings[2]!.text, '整体可以加日志')
  assert.equal(sheet.rules, '- focus on payments')
  assert.match(sheet.extra, /## Something else\n\nkept as is/)

  const written = serializeSheet(sheet)
  assert.match(written, /^- \[x\] F1 `src\/hook.ts:10-12` 没有幂等键$/m)
  assert.match(written, /^ {2}> EN: Looks good/m)
  assert.match(written, /## Something else/)
  const again = parseSheet(written)
  assert.ok('sheet' in again)
  assert.deepEqual(again.sheet, sheet)
})

test('review sheet: what it needs, and edits', () => {
  assert.deepEqual(parseSheet('no front matter'), { error: 'missing front matter (--- … ---)' })
  assert.ok('error' in parseSheet('---\ntitle: x\nhead: abcdef1\n---\n'))
  assert.ok('error' in parseSheet('---\npr: a/b#1\n---\n'))
  const blank = blankSheet({ pr: 'a/b#1', title: 'T', author: 'x', base: 'main', head: SHA, round: 1, session: 's' })
  const read = parseSheet(serializeSheet(blank))
  assert.ok('sheet' in read)
  assert.equal(read.sheet.status, 'analyzing')
  assert.equal(read.sheet.session, 's')

  const sheet = (parseSheet(SAMPLE) as { sheet: Sheet }).sheet
  const next = applyOps(sheet, [
    { op: 'check', id: 'F2', checked: true },
    { op: 'en', id: 'F2', text: '  Nice, maybe a constant?  ' },
    { op: 'decision', value: 'approve' },
    { op: 'summary', value: 'Well done\noverall' },
    { op: 'rules', value: 'r\r\n' },
  ])
  assert.equal(next.findings[1]!.checked, true)
  assert.equal(next.findings[1]!.en, 'Nice, maybe a constant?')
  assert.equal(next.decision, 'approve')
  assert.equal(next.summary, 'Well done overall')
  assert.equal(next.rules, 'r')
  assert.equal(sheet.findings[1]!.checked, false, 'the original is untouched')
  assert.throws(() => applyOps(sheet, [{ op: 'check', id: 'F9', checked: true }]), /no finding F9/)
  assert.deepEqual(parseLocation('a/b.ts#L5'), { path: 'a/b.ts', line: 5 })
  assert.deepEqual(parseLocation('a/b.ts:9-3'), { path: 'a/b.ts', start: 3, line: 9 })
  assert.equal(parseLocation('two words'), undefined)
})

test('review guard: reads pass; branch moves, tracked edits and GitHub writes are refused', () => {
  const allowed = [
    'git diff refs/remotes/origin/main...refs/reviews/pr-12', 'git show refs/reviews/pr-12:src/a.ts', 'git log --oneline main..refs/reviews/pr-12',
    'git grep -n retry refs/reviews/pr-12', 'git status', 'git fetch origin', 'git branch -a', 'git branch --list "feat/*"', 'git tag -l',
    'git config --get user.name', 'git -C /repo diff', 'git remote -v', 'gh pr view 12 --json title', 'gh pr diff 12', 'gh api repos/a/b/pulls/12',
    'gh api graphql -f query="query { viewer { login } }"', 'gh api -X GET repos/a/b/pulls', 'cat src/a.ts | head -20', 'rg retry',
  ]
  for (const command of allowed) assert.equal(reviewCommandReason(command), undefined, command)
  const refused = [
    'git checkout feature', 'git switch -c x', 'git reset --hard', 'git stash', 'git commit -m x', 'git push', 'git pull', 'git restore a.ts',
    'git -C /repo checkout main', 'cd /repo && git checkout main', 'echo $(git stash)', 'timeout 20s git rebase main', 'git branch new-one',
    'git branch -D old', 'git tag v1', 'git config user.name x', 'git worktree add ../x', 'git add .', 'git remote add up url',
    'gh pr review 12 --approve', 'gh pr comment 12 -b hi', 'gh pr merge 12', 'gh pr checkout 12', 'gh api -X POST repos/a/b/pulls/12/reviews',
    'gh api --method=PATCH repos/a/b', 'gh api repos/a/b/issues/1/comments -f body=hi', 'gh api graphql -f query="mutation { x }"', 'gh issue create',
  ]
  for (const command of refused) assert.match(reviewCommandReason(command) ?? '', /^Blocked: this is a read-only review session/, command)

  const repo = '/work/app'
  assert.equal(reviewWriteReason('/work/app/.reviews/pr-12.md', repo), undefined)
  assert.equal(reviewWriteReason('.reviews/pr-12.md', repo, repo), undefined)
  assert.equal(reviewWriteReason(join(tmpdir(), 'scratch.txt'), repo), undefined)
  assert.match(reviewWriteReason('src/a.ts', repo, repo) ?? '', /^Blocked/)
  assert.match(reviewWriteReason('/work/app/.reviews/../src/a.ts', repo) ?? '', /^Blocked/)
  assert.match(reviewWriteReason('/work/other/.reviews/pr-1.md', repo) ?? '', /^Blocked/)

  // Once its tracked folders are known: any folder of the project holding no tracked file, and anything outside it.
  const tracked = [
    { root: repo, dirs: new Set(['', 'src', 'src/a.ts', 'readme.md']) },
    { root: '/work/app-wt', dirs: new Set(['', 'lib']) },
    { root: '/work/app/.trees/broken' },
  ]
  const write = (path: string, cwd = repo): string | undefined => reviewWriteReason(path, repo, cwd, tracked)
  assert.equal(write('dist/out.js'), undefined)
  assert.equal(write('node_modules/x/index.js'), undefined)
  assert.equal(write('src/fresh/new.ts'), undefined, 'a new folder holds no tracked file')
  assert.equal(write('/work/other/notes.md'), undefined, 'outside the project')
  assert.equal(write('/Users/me/.dsh/canvases/c.html'), undefined)
  assert.match(write('src/b.ts') ?? '', /^Blocked/, 'a new file beside tracked ones')
  assert.match(write('notes.md') ?? '', /^Blocked/, 'the root holds tracked files')
  assert.match(write('dist/../src/a.ts') ?? '', /^Blocked/)
  assert.match(write('.git/hooks/pre-commit') ?? '', /^Blocked/)
  assert.match(write('/work/app-wt/lib/x.ts') ?? '', /^Blocked/, 'another working tree of the project')
  assert.equal(write('/work/app-wt/tmp/x.ts'), undefined)
  assert.match(write('/work/app/.trees/broken/any.txt') ?? '', /^Blocked/, 'a tree that could not be read is kept whole')
  assert.ok(reviewTrusts('Write', { file_path: 'dist/out.js' }, repo, repo, () => undefined, tracked))
  assert.ok(!reviewTrusts('Write', { file_path: 'src/b.ts' }, repo, repo, () => undefined, tracked))
  assert.equal(writtenPath('Edit', { file_path: 'x' }), 'x')
  assert.equal(writtenPath('NotebookEdit', { notebook_path: 'n' }), 'n')
  assert.equal(writtenPath('str_replace_editor', { command: 'view', path: 'v' }), undefined)
  assert.equal(writtenPath('str_replace_editor', { command: 'create', path: 'v' }), 'v')
  assert.equal(writtenPath('read', { file_path: 'r' }), undefined)
})

test('review guard: the tracked folders of every working tree, a submodule counted as one', async () => {
  const trees = await readTracked('/work/app', async (args, cwd) => {
    if (args[0] === 'worktree') return { code: 0, stdout: 'worktree /work/app\0HEAD x\0branch refs/heads/main\0\0worktree /work/wt\0HEAD y\0\0', stderr: '' }
    if (cwd === '/work/wt') return { code: 128, stdout: '', stderr: 'gone' }
    return { code: 0, stdout: 'src/a/b.ts\0README.md\0vendor/lib\0', stderr: '' }
  })
  assert.deepEqual(trees.map((tree) => [tree.root, tree.dirs === undefined ? undefined : [...tree.dirs].sort()]), [
    ['/work/app', ['', 'readme.md', 'src', 'src/a', 'src/a/b.ts', 'vendor', 'vendor/lib'].map((dir) => (process.platform === 'linux' ? dir.replace('readme', 'README') : dir)).sort()],
    ['/work/wt', undefined],
  ])
})

test('review github: remotes and the lines a comment can land on', () => {
  assert.equal(repoSlug('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(repoSlug('https://github.com/acme/app'), 'acme/app')
  assert.equal(repoSlug('ssh://git@github.com/acme/my.app.git'), 'acme/my.app')
  assert.equal(repoSlug('https://gitlab.com/acme/app.git'), undefined)
  const patch = '@@ -1,3 +1,4 @@\n line1\n-old\n+new\n+added\n line3\n@@ -20,2 +21,2 @@\n ctx\n+x\n\\ No newline at end of file'
  assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4, 21, 22])
  assert.equal(commentableLines(undefined).size, 0)
})

test('review submit: comments on diff lines, the rest in the body, problems listed', () => {
  const sheet = (parseSheet(SAMPLE) as { sheet: Sheet }).sheet
  const lines = new Map([['src/hook.ts', new Set([10, 11, 12])]])
  const preview = buildReview({ ...sheet, findings: sheet.findings.map((f) => ({ ...f, checked: true })) }, { lines, viewer: 'me', author: 'alice', remoteHead: SHA })
  assert.equal(preview.event, 'REQUEST_CHANGES')
  assert.deepEqual(preview.comments.map((c) => [c.id, c.path, c.start, c.line]), [['F1', 'src/hook.ts', 10, 12]])
  assert.deepEqual(preview.folded, ['F2', 'F3'])
  assert.match(preview.body, /^Nice work, a couple of things first\.\n\n\*\*`src\/hook.ts:30`\*\* Small nit/)
  assert.deepEqual(preview.problems, [])
  const payload = reviewPayload(preview, SHA)
  assert.deepEqual(payload.comments[0], { path: 'src/hook.ts', line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT', body: 'Looks good. One thing though, add an idempotency key?\nThanks!' })

  const codes = (value: ReturnType<typeof buildReview>): string[] => value.problems.map((p) => p.code)
  assert.deepEqual(codes(buildReview({ ...sheet, summary: 'Great work — thanks' })), ['dash'])
  assert.deepEqual(codes(buildReview({ ...sheet, decision: 'approve' }, { viewer: 'Alice', author: 'alice' })), ['own'])
  assert.deepEqual(codes(buildReview({ ...sheet, summary: '', findings: [] })), ['body'])
  assert.deepEqual(codes(buildReview({ ...sheet, decision: 'comment', summary: '', findings: [] })), ['nothing'])
  assert.deepEqual(buildReview({ ...sheet, findings: [{ ...sheet.findings[0]!, en: '' }] }).problems, [{ code: 'empty', ids: ['F1'] }])
  // New commits only warn: the review still posts, on the analysed head.
  const moved = buildReview(sheet, { remoteHead: 'b'.repeat(40) })
  assert.deepEqual(codes(moved), [])
  assert.deepEqual(moved.warnings, [{ code: 'stale' }])
  assert.equal(moved.head, SHA)
  assert.deepEqual(buildReview(sheet, { remoteHead: SHA }).warnings, [])
  assert.deepEqual(codes(buildReview({ ...sheet, status: 'analyzing', review: '1' })), ['submitted', 'analyzing'])
})

test('review phases and the daily time', () => {
  const sheet = (parseSheet(SAMPLE) as { sheet: Sheet }).sheet
  assert.equal(phaseOf(undefined, undefined, SHA), 'new')
  assert.equal(phaseOf(sheet, 'bad', SHA), 'invalid')
  assert.equal(phaseOf(sheet, undefined, SHA.slice(0, 12)), 'ready')
  assert.equal(phaseOf(sheet, undefined, 'b'.repeat(40)), 'stale')
  assert.equal(phaseOf({ ...sheet, status: 'analyzing' }, undefined, SHA), 'analyzing')
  assert.equal(phaseOf({ ...sheet, status: 'submitted' }, undefined, SHA), 'submitted')
  // Submitted stays so; what came after it is its follow-up.
  assert.equal(phaseOf({ ...sheet, status: 'submitted' }, undefined, 'b'.repeat(40)), 'submitted')
  assert.equal(phaseOf({ ...sheet, status: 'submitted' }, undefined, undefined), 'submitted')

  const now = new Date(2026, 9, 11, 8, 30).getTime()
  assert.equal(nextRun('09:00', now), new Date(2026, 9, 11, 9, 0).getTime())
  assert.equal(nextRun('8:00', now), new Date(2026, 9, 12, 8, 0).getTime())
  assert.equal(lastRun('8:00', now), new Date(2026, 9, 11, 8, 0).getTime())
  assert.equal(lastRun('09:00', now), new Date(2026, 9, 10, 9, 0).getTime())
  assert.equal(nextRun('25:00', now), undefined)
  assert.equal(nextRun('9am', now), undefined)
})

test('review prompts: the default comment style follows the UI language; one left at the Config default reads as unset', () => {
  const finding: Finding = { id: 'F1', severity: 'must', checked: true, text: 'no retry key', en: '' }
  const zh = setLocaleSource(() => 'zh-CN')
  assert.match(reviewSection(''), /不要使用破折号/)
  assert.match(reviewSection(DEFAULT_STYLE), /不要使用破折号/)
  zh()
  const en = setLocaleSource(() => 'en')
  assert.match(reviewSection(''), /Do not use dashes/)
  assert.doesNotMatch(reviewSection(DEFAULT_STYLE), /不要使用破折号/, 'the Chinese default is a default, not a choice')
  assert.match(rewritePrompt({ finding, style: DEFAULT_STYLE }).system, /Write comments in English\./)
  assert.match(reviewSection('Be terse.'), /Be terse\.$/, 'a style of its own stays as written')
  en()
})

test('review prompts: the section carries the rules, the first message the pull request', () => {
  const section = reviewSection('')
  assert.match(section, /read-only/)
  assert.match(section, /git show <head>:<path>/)
  const text = firstMessage({
    slug: 'acme/app', number: 12, title: 'T', url: 'u', author: 'alice', base: 'main', baseRef: 'refs/remotes/origin/main', head: SHA, round: 2,
    stat: ' a.ts | 2 +-', threads: [{ path: 'a.ts', line: 3, author: 'bob', body: 'why?', outdated: false }], rules: 'be brief',
    previous: { head: 'b'.repeat(40), sheet: '.reviews/pr-12.round1.md' },
  })
  assert.match(text, /git diff refs\/remotes\/origin\/main\.\.\.refs\/reviews\/pr-12/)
  assert.match(text, /new since the last review/)
  assert.match(text, /`a.ts:3` @bob: why\?/)
  assert.match(text, /Rules for this review:\nbe brief/)
  assert.match(text, /\.reviews\/pr-12\.md/)
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

test('review service: sync analyses into a sheet, edits apply, the review posts once', { skip: !hasGit() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-')))
  try {
    // A "GitHub" remote with main and a pull request ref, and my clone of it.
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    writeFileSync(join(seed, 'hook.ts'), 'export const a = 1\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'base')
    git(seed, 'push', '-q', origin, 'main')
    git(seed, 'checkout', '-qb', 'feat')
    writeFileSync(join(seed, 'hook.ts'), 'export const a = 1\nexport const retry = 3\n')
    git(seed, 'commit', '-qam', 'retry')
    git(seed, 'push', '-q', origin, 'feat:refs/pull/12/head')
    const head = git(seed, 'rev-parse', 'HEAD')
    const repo = join(root, 'app')
    execFileSync('git', ['clone', '-q', origin, repo])

    const pull: Pull = { slug: 'acme/app', number: 12, title: 'Add retry', url: 'https://github.com/acme/app/pull/12', draft: false, head, branch: 'vi/eng-7-retry', base: 'main', author: 'alice', updatedAt: 1, cross: false }
    const posted: ReviewPayload[] = []
    let remoteHead = head
    let mine: Array<{ id: string; commit: string; body: string }> = []
    const github = {
      requested: async () => [{ ...pull, head: remoteHead }],
      threads: async () => [],
      pull: async () => ({ head: remoteHead, state: 'open', author: 'alice' }),
      commentable: async () => new Map([['hook.ts', new Set([1, 2])]]),
      viewer: async () => 'me',
      myReviews: async () => mine,
      submit: async (_slug: string, _number: number, payload: ReviewPayload) => {
        posted.push(payload)
        return { id: '99', url: 'https://github.com/acme/app/pull/12#pullrequestreview-99' }
      },
    } as unknown as GitHub
    const sent: Array<{ session: string; text: string; id: string }> = []
    const archived: string[] = []
    const started: Array<Parameters<SessionHost['start']>[0]> = []
    const sessions: SessionHost = {
      start: async (input) => { started.push(input); return `session-${started.length}` },
      send: async (session, text, id) => { sent.push({ session, text, id }) },
      cancel: async () => {},
      archive: async (session) => { archived.push(session) },
    }
    const settings: ReviewSettings = { repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }
    const service = new ReviewService({
      settings: () => settings,
      repos: async () => [{ key: repo, name: 'app', members: [{ workspaceId: 'w1', path: repo, title: 'app', main: true }] }],
      sessions: () => sessions,
      bots: () => [{ id: 'reviewer', persona: 'review it' }],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github,
      git: async (args, cwd, options) => {
        // Answer the remote lookup with a GitHub URL; everything else is real git.
        if (args[0] === 'config' && args[1] === '--get-regexp') return { code: 0, stdout: `remote.origin.url git@github.com:acme/app.git\n`, stderr: '' }
        const { runGit } = await import('../src/git/service.ts')
        return runGit(args, cwd, options)
      },
    })

    const state = await service.sync()
    assert.equal(state.enabled, true)
    // The analysis starts in the background; wait for its first message.
    for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(started.length, 1)
    assert.deepEqual(started[0], { cwd: repo, workspaceId: 'w1', title: 'Review #12 · Add retry', route: { provider: 'agent-hub-bot', model: 'reviewer' } })
    assert.equal(git(repo, 'rev-parse', 'refs/reviews/pr-12'), head, 'fetched to its own ref')
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'no branch switched')
    assert.equal(readFileSync(join(repo, '.reviews', '.gitignore'), 'utf8'), '*\n')
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the sheets folder ignores itself')
    assert.match(sent[0]!.text, /git diff refs\/remotes\/origin\/main\.\.\.refs\/reviews\/pr-12/)
    assert.match(sent[0]!.text, /hook\.ts \| 1 \+/)
    assert.equal(service.sessionRepo('session-1'), repo)
    assert.ok(service.section('session-1')?.includes('read-only'))
    assert.equal(service.section('other'), undefined)

    const path = join(repo, '.reviews', 'pr-12.md')
    let item = (await service.state()).items[0]!
    assert.equal(item.phase, 'analyzing')
    assert.equal(item.running, true)

    // The agent writes its findings; its turn ends.
    const written = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    writeFileSync(path, serializeSheet({
      ...written, status: 'ready', decision: 'request-changes', summary: 'Nice one, one thing first.',
      findings: [
        { id: 'F1', severity: 'must', checked: true, path: 'hook.ts', line: 2, text: '没有上限', en: 'Looks good. Should retry be capped?' },
        { id: 'F2', severity: 'nice', checked: false, path: 'other.ts', line: 9, text: '命名', en: 'Tiny nit on the name.' },
      ],
    }))
    service.status('session-1', false)
    item = (await service.state()).items[0]!
    assert.equal(item.phase, 'ready')
    assert.deepEqual([item.must, item.nice, item.checked, item.running], [1, 1, 1, undefined])

    const patched = await service.handle({ op: 'patch', path, ops: [{ op: 'check', id: 'F2', checked: true }, { op: 'decision', value: 'comment' }] }) as { ok: true; value: SheetReply }
    assert.equal(patched.value.sheet?.findings[1]?.checked, true)
    assert.match(readFileSync(path, 'utf8'), /^- \[x\] F2 `other.ts:9` 命名$/m)
    const refused = await service.handle({ op: 'sheet', path: join(root, 'elsewhere', '.reviews', 'pr-1.md') })
    assert.deepEqual(refused, { ok: false, error: 'the sheet is not in a registered repository' })

    const preview = (await service.handle({ op: 'preview', path }) as { ok: true; value: ReviewPreview }).value
    assert.equal(preview.event, 'COMMENT')
    assert.deepEqual(preview.comments.map((c) => c.id), ['F1'])
    assert.deepEqual(preview.folded, ['F2'])

    const result = (await service.handle({ op: 'submit', path }) as { ok: true; value: { posted?: { id: string } } }).value
    assert.equal(result.posted?.id, '99')
    assert.equal(posted.length, 1)
    assert.equal(posted[0]!.commit_id, head)
    assert.equal(posted[0]!.event, 'COMMENT')
    const after = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    assert.equal(after.status, 'submitted')
    assert.equal(after.review, '99')
    assert.deepEqual(archived, ['session-1'])
    for (let i = 0; i < 50 && existsSync(join(repo, '.git', 'refs', 'reviews', 'pr-12')); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.throws(() => git(repo, 'rev-parse', '--verify', '-q', 'refs/reviews/pr-12'))

    // Posting again is refused; a review already on GitHub with the same body is recognized, never posted twice.
    const again = (await service.handle({ op: 'submit', path }) as { ok: true; value: { preview: ReviewPreview; posted?: unknown } }).value
    assert.equal(again.posted, undefined)
    assert.deepEqual(again.preview.problems.map((p) => p.code), ['submitted'])
    writeFileSync(path, serializeSheet({ ...after, status: 'ready', review: undefined, submitted: undefined }))
    mine = [{ id: '99', commit: head, body: posted[0]!.body }]
    const recognized = (await service.handle({ op: 'submit', path }) as { ok: true; value: { posted?: { id: string } } }).value
    assert.equal(recognized.posted?.id, '99')
    assert.equal(posted.length, 1)

    // New commits: the sent card shows them and a sync starts round 2, keeping round 1's sheet.
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'more')
    git(seed, 'push', '-q', origin, 'feat:refs/pull/12/head')
    remoteHead = git(seed, 'rev-parse', 'HEAD')
    const stale = await service.state(true)
    assert.equal(stale.items[0]!.phase, 'submitted')
    assert.equal(stale.items[0]!.follow?.commits, 1)
    assert.equal(reviewRank(stale.items[0]!), 0, 'followed up: it rises')
    // It still posts, with a warning: on the commit the analysis read, its lines from that diff (GitHub's are the new head's).
    writeFileSync(path, serializeSheet({ ...after, status: 'ready', review: undefined, submitted: undefined, summary: 'Second look.' }))
    const warned = (await service.handle({ op: 'preview', path }) as { ok: true; value: ReviewPreview }).value
    assert.deepEqual(warned.problems, [])
    assert.deepEqual(warned.warnings, [{ code: 'stale' }])
    assert.deepEqual(warned.comments.map((c) => c.id), ['F1'])
    const late = (await service.handle({ op: 'submit', path }) as { ok: true; value: { posted?: { id: string } } }).value
    assert.equal(late.posted?.id, '99')
    assert.equal(posted.length, 2)
    assert.equal(posted[1]!.commit_id, head)
    await service.sync()
    for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sent.length, 2)
    assert.match(sent[1]!.text, /new since the last review/)
    assert.ok(existsSync(join(repo, '.reviews', 'pr-12.round1.md')))
    const round2 = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    assert.deepEqual([round2.round, round2.head, round2.status, round2.session], [2, remoteHead, 'analyzing', 'session-2'])

    // A stray edit to a tracked file during an analysis is flagged on the card.
    writeFileSync(join(repo, 'hook.ts'), 'changed\n')
    service.status('session-2', false)
    for (let i = 0; i < 50; i++) {
      const flagged: ReviewItem | undefined = (await service.state()).items[0]
      if (flagged?.dirty === true) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const final: ReviewState = await service.state()
    assert.equal(final.items[0]!.dirty, true)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review service: a sheet the agent broke shows as unreadable, and its session can be told to fix it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-bad-')))
  try {
    const repo = join(root, 'app')
    const dir = join(repo, '.reviews')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pr-3.md'), '---\npr: acme/app#3\nsession: session-9\n---\n## Must fix\n')
    const sent: string[] = []
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => 's', send: async (session, text) => { sent.push(`${session}: ${text}`) }, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: { requested: async () => [{ slug: 'acme/app', number: 3, title: 'T', url: 'u', draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: 1 }] } as unknown as GitHub,
      git: async () => ({ code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }),
    })
    const item = (await service.state()).items[0]!
    assert.equal(item.phase, 'invalid')
    assert.equal(item.session, 'session-9')
    assert.match(item.error ?? '', /head/)
    assert.equal(service.sessionRepo('session-9'), repo, 'still a review session: its guard applies')
    const told = await service.handle({ op: 'tell', path: join(dir, 'pr-3.md'), text: 'fix it' })
    assert.deepEqual(told, { ok: true, value: { sent: true } })
    assert.deepEqual(sent, ['session-9: fix it'])
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review daily run: a stalled analysis is taken up again; sync never writes scheduler state', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-stalled-')))
  try {
    const repo = join(root, 'app')
    const dir = join(repo, '.reviews')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    // Left by an earlier DSH run: the session's first turn failed, the sheet never got past analyzing.
    writeFileSync(join(dir, 'pr-5.md'), serializeSheet(blankSheet({ pr: 'acme/app#5', title: 'T5', author: 'a', base: 'main', head: SHA, round: 1, session: 'old' })))
    const sent: Array<{ session: string; text: string }> = []
    let starts = 0
    let offline = false
    let clock = 1_000_000
    const state = join(root, 'review.json')
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => `s${++starts}`, send: async (session, text) => { sent.push({ session, text }) }, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: state,
      log: () => {},
      now: () => clock,
      github: {
        requested: async () => {
          if (offline) throw new Error('offline')
          return [{ slug: 'acme/app', number: 5, title: 'T5', url: 'u5', draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: 1 }]
        },
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const before = (await service.state()).items[0]!
    assert.equal(before.phase, 'analyzing')
    assert.equal(before.running, undefined, 'no session answers for it')

    const synced = await service.sync()
    assert.equal(synced.progress?.sync?.due, 1)
    for (let i = 0; i < 200 && service.progress().runs[0]?.step !== 'analyzing'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    const run = service.progress().runs[0]!
    assert.equal(run.step, 'analyzing')
    assert.equal(run.mode, 'fresh', 'the old session never analysed it: nothing to look again at')
    assert.equal(starts, 1)
    assert.deepEqual(sent.map((entry) => entry.session), ['s1'])
    assert.equal((parseSheet(readFileSync(join(dir, 'pr-5.md'), 'utf8')) as { sheet: Sheet }).sheet.session, 's1')
    assert.equal(existsSync(state), false, 'scheduler persistence belongs to the native task bridge')

    // Running now: the next sync leaves it alone.
    assert.equal((await service.sync()).progress?.sync?.due, 0)

    // GitHub cannot be read: the run fails and the day is not marked as done.
    offline = true
    clock += 60_000
    ;(service as unknown as { requested: { invalidate(): void } }).requested.invalidate()
    const failed = await service.sync()
    assert.equal(failed.progress?.sync?.step, 'failed')
    assert.equal(existsSync(state), false, 'scheduler persistence belongs to the native task bridge')
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review sync: a draft pull request is listed but never analysed on its own', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-draft-')))
  try {
    const repo = join(root, 'app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(repo, { recursive: true })
    let starts = 0
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => `s${++starts}`, send: async () => {}, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: {
        requested: async () => [{ slug: 'acme/app', number: 8, title: 'WIP', url: 'u8', draft: true, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: 1 }],
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    for (const manual of [false, true]) {
      const synced = await service.sync(manual)
      assert.equal(synced.items.length, 1)
      assert.equal(synced.items[0]!.draft, true)
      assert.equal(synced.items[0]!.phase, 'new')
      assert.equal(synced.progress?.sync?.found, 1)
      assert.equal(synced.progress?.sync?.due, 0)
    }
    assert.equal(starts, 0)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review sync button only lists; analyse all queues what has no analysis at its head and skips the rest', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-all-')))
  try {
    const repo = join(root, 'app')
    const dir = join(repo, '.reviews')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    // #2 is analysed at the current head; #1 and #3 have no sheet; #4 is a draft.
    writeFileSync(join(dir, 'pr-2.md'), serializeSheet({ ...blankSheet({ pr: 'acme/app#2', title: 'T2', author: 'a', base: 'main', head: SHA, round: 1, session: 'old' }), status: 'ready' }))
    let starts = 0
    // Fetches in one clone fight over its ref locks: they must take turns.
    let fetching = 0
    let overlapped = false
    const state = join(root, 'review.json')
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 1 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => `s${++starts}`, send: async () => {}, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: state,
      log: () => {},
      github: {
        requested: async () => [1, 2, 3, 4].map((number): Pull => ({
          slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: number === 4, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: number, cross: false,
        })),
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'fetch') {
          if (++fetching > 1) overlapped = true
          await new Promise((resolve) => setTimeout(resolve, 20))
          fetching--
          return { code: 0, stdout: '', stderr: '' }
        }
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    // Manual list refresh never creates or alters the native scheduled task.
    const listed = await service.handle({ op: 'sync' }) as { ok: true; value: ReviewState }
    assert.equal(listed.value.items.length, 4)
    assert.equal(listed.value.progress?.sync?.found, 4)
    assert.equal(listed.value.progress?.sync?.due, undefined)
    assert.deepEqual(listed.value.progress?.runs, [])
    assert.equal(existsSync(state), false, 'manual listing does not touch the native task state')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(starts, 0)

    // All of them, past maxPerRun; the analysed one and the draft are left alone.
    await service.handle({ op: 'analyzeAll' })
    assert.deepEqual(service.progress().runs.map((run) => run.key).sort(), ['acme/app#1', 'acme/app#3'])
    for (let i = 0; i < 200 && service.progress().runs.some((run) => run.step !== 'analyzing'); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(starts, 2)
    assert.equal(overlapped, false, 'one fetch at a time')

    // Nothing left: queued and running ones are not started twice.
    const again = await service.handle({ op: 'analyzeAll' })
    assert.equal(again.ok, false)
    assert.equal(starts, 2)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review diff counts: the last --stat line', () => {
  assert.deepEqual(diffCounts(' a.ts | 3 ++-\n 2 files changed, 10 insertions(+), 1 deletion(-)\n'), { files: 2, added: 10, removed: 1 })
  assert.deepEqual(diffCounts(' 1 file changed, 4 insertions(+)'), { files: 1, added: 4, removed: 0 })
  assert.deepEqual(diffCounts(''), {})
})

test('review runs: each step shows as it goes; retry asks again, fresh starts over, the queue can be left', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-runs-')))
  try {
    const repo = join(root, 'app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(repo, { recursive: true })
    const pull = (number: number): Pull => ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: number, cross: false })
    const sent: Array<{ session: string; text: string }> = []
    let starts = 0
    let refuse = false
    const routes: Array<{ provider: string; model: string } | undefined> = []
    const sessions: SessionHost = {
      start: async (input) => {
        if (refuse) throw new Error('no model')
        routes.push(input.route)
        return `s${++starts}`
      },
      send: async (session, text) => { sent.push({ session, text }) },
      cancel: async () => {},
      archive: async () => {},
    }
    let clock = 1_000_000
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => sessions,
      bots: () => [{ id: 'reviewer', description: 'Default review bot' }, { id: 'auditor', description: 'Security specialist' }],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      now: () => clock,
      github: { requested: async () => [pull(1), pull(2), pull(3)], threads: async () => [1, 2].map((line) => ({ path: 'a.ts', line, author: 'b', body: 'why?', outdated: false })) } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        if (args[0] === 'diff') return { code: 0, stdout: ' a.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(check(), `timed out: ${JSON.stringify(service.progress().runs)}`)
    }
    const run = (key: string): ReviewRun | undefined => service.progress().runs.find((entry) => entry.key === key)
    const path = (n: number): string => join(repo, '.reviews', `pr-${n}.md`)
    const finish = (n: number, status: Sheet['status']): void => {
      const sheet = (parseSheet(readFileSync(path(n), 'utf8')) as { sheet: Sheet }).sheet
      writeFileSync(path(n), serializeSheet({ ...sheet, status }))
    }

    // A first analysis: queued, fetched, read, a session, the model.
    const first = await service.handle({ op: 'analyze', key: 'acme/app#1' }) as { ok: true; value: ReviewState }
    assert.deepEqual(first.value.bots, [{ id: 'reviewer', description: 'Default review bot' }, { id: 'auditor', description: 'Security specialist' }])
    assert.equal(first.value.defaultBot, 'reviewer')
    assert.ok(first.value.progress?.runs.some((entry) => entry.key === 'acme/app#1' && entry.manual))
    await until(() => run('acme/app#1')?.step === 'analyzing')
    const one = run('acme/app#1')!
    assert.deepEqual(one.log.map((entry) => entry.step), ['queued', 'fetch', 'context', 'session', 'analyzing'])
    assert.equal(one.mode, 'fresh')
    assert.deepEqual(one.log[1]!.info, { head: SHA.slice(0, 12) })
    assert.deepEqual(one.log[2]!.info, { files: 1, added: 2, removed: 1, threads: 2 })
    assert.deepEqual(one.log[3]!.info, { round: 1 })
    assert.deepEqual(routes[0], { provider: 'agent-hub-bot', model: 'reviewer' })
    // Not twice while it runs.
    assert.deepEqual(await service.handle({ op: 'analyze', key: 'acme/app#1' }), { ok: false, error: 'This pull request is being analysed now' })

    // Its turn ends with the sheet written: done.
    clock += 5_000
    finish(1, 'ready')
    service.status('s1', false)
    await until(() => run('acme/app#1')?.step === 'done')
    assert.equal(run('acme/app#1')!.endedAt! - run('acme/app#1')!.startedAt, 5_000)

    // A retry on the same head asks its session again; a turn that leaves the sheet unfinished stalled.
    await service.analyze('acme/app#1')
    await until(() => run('acme/app#1')?.step === 'analyzing')
    assert.equal(run('acme/app#1')!.mode, 'again')
    assert.equal(sent.at(-1)!.session, 's1')
    assert.equal(starts, 1)
    finish(1, 'analyzing')
    service.status('s1', false)
    await until(() => run('acme/app#1')?.step === 'failed')
    assert.equal(run('acme/app#1')!.code, 'stalled')

    // A manually chosen bot always gets a fresh session, even though the old one could look again.
    const chosen = await service.handle({ op: 'analyze', key: 'acme/app#1', bot: 'auditor' })
    assert.equal(chosen.ok, true)
    await until(() => run('acme/app#1')?.step === 'analyzing')
    assert.equal(run('acme/app#1')!.mode, 'fresh')
    assert.equal(starts, 2)
    assert.deepEqual(routes[1], { provider: 'agent-hub-bot', model: 'auditor' })

    // Two slots: #2 takes the second, #3 waits and can be taken out of the queue.
    await service.analyze('acme/app#2')
    await until(() => run('acme/app#2')?.step === 'analyzing')
    await service.analyze('acme/app#3')
    assert.equal(run('acme/app#3')!.step, 'queued')
    const cancelled = await service.handle({ op: 'cancel', key: 'acme/app#3' }) as { ok: true; value: ReviewState }
    assert.equal(cancelled.value.items.find((item) => item.key === 'acme/app#3')!.queued, undefined)
    assert.equal(run('acme/app#3')!.step, 'cancelled')
    assert.deepEqual(await service.handle({ op: 'cancel', key: 'acme/app#3' }), { ok: false, error: 'This pull request is not being analysed' })

    // A start that fails ends its run with the reason, on the run and the card.
    finish(2, 'ready')
    service.status('s3', false)
    refuse = true
    await service.analyze('acme/app#3')
    await until(() => run('acme/app#3')?.step === 'failed')
    assert.equal(run('acme/app#3')!.error, 'no model')
    assert.deepEqual(run('acme/app#3')!.log.map((entry) => entry.step), ['queued', 'fetch', 'context', 'session', 'failed'])
    assert.equal((await service.state()).items.find((item) => item.key === 'acme/app#3')!.error, 'no model')

    // The progress answer is a copy; ended runs leave after a while.
    const copy = service.progress()
    copy.runs[0]!.log.push({ step: 'done', at: 0 })
    assert.notEqual(service.progress().runs[0]!.log.length, copy.runs[0]!.log.length)
    clock += 16 * 60_000
    assert.deepEqual(service.progress().runs.map((entry) => entry.key), ['acme/app#1'])
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review stop: a queued, a starting and an analysing run each stop, one at a time or all at once', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-stop-')))
  try {
    const repo = join(root, 'app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(repo, { recursive: true })
    const pull = (number: number): Pull => ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: number, cross: false })
    let starts = 0
    const cancelled: string[] = []
    const sent: string[] = []
    // A fetch held open: the run waits at that step until released.
    let release: (() => void) | undefined
    let hold = false
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({
        start: async () => `s${++starts}`,
        send: async (session) => { sent.push(session) },
        cancel: async (session) => { cancelled.push(session) },
        archive: async () => {},
      }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: { requested: async () => [pull(1), pull(2), pull(3)], threads: async () => [] } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        if (args[0] === 'fetch' && hold) await new Promise<void>((resolve) => { release = resolve })
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(check(), `timed out: ${JSON.stringify(service.progress().runs)}`)
    }
    const run = (key: string): ReviewRun | undefined => service.progress().runs.find((entry) => entry.key === key)

    // Analysing: its session's turn is stopped; the turn ending after is no failure.
    await service.analyze('acme/app#1')
    await until(() => run('acme/app#1')?.step === 'analyzing')
    service.status('s1', true)
    await service.cancel('acme/app#1')
    assert.deepEqual(cancelled, ['s1'])
    assert.equal(run('acme/app#1')!.step, 'cancelled')
    assert.equal(run('acme/app#1')!.code, 'stopped')
    service.status('s1', false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(run('acme/app#1')!.step, 'cancelled')

    // Starting: it gives up at its next step, opening no session.
    hold = true
    await service.analyze('acme/app#2')
    await until(() => release !== undefined)
    await service.cancel('acme/app#2')
    assert.equal(run('acme/app#2')!.step, 'cancelled')
    release!()
    await until(() => (service as unknown as { jobs: Array<{ starting?: boolean }> }).jobs.every((job) => job.starting !== true))
    assert.equal(starts, 1)
    assert.equal(run('acme/app#2')!.error, undefined)
    assert.equal((await service.state()).items.find((item) => item.key === 'acme/app#2')!.error, undefined)

    // All at once: one analysing, one starting, one queued behind them.
    hold = false
    release = undefined
    await service.analyze('acme/app#1')
    await until(() => run('acme/app#1')?.step === 'analyzing')
    hold = true
    await service.analyze('acme/app#2')
    await until(() => release !== undefined)
    await service.analyze('acme/app#3')
    assert.equal(run('acme/app#3')!.step, 'queued')
    const all = await service.handle({ op: 'cancelAll' }) as { ok: true; value: ReviewState }
    assert.ok(all.ok)
    assert.deepEqual(['acme/app#1', 'acme/app#2', 'acme/app#3'].map((key) => run(key)!.step), ['cancelled', 'cancelled', 'cancelled'])
    assert.equal(cancelled.at(-1), 's2')
    release!()
    await until(() => (service as unknown as { jobs: Array<{ starting?: boolean }> }).jobs.every((job) => job.starting !== true))
    assert.equal(starts, 2, 'the starting one opened no session')
    service.status('s2', false)
    assert.deepEqual(await service.handle({ op: 'cancelAll' }), { ok: false, error: 'No analysis is running' })
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review order: what wants analysing first, then what waits to be sent, then what was sent; asked again, a sent one rises', async () => {
  const rank = (phase: ReviewItem['phase'], extra: Partial<ReviewItem> = {}): number => reviewRank({ phase, session: 's', ...extra })
  assert.deepEqual([rank('new'), rank('stale'), rank('invalid'), rank('analyzing', { running: true }), rank('ready'), rank('submitted')], [0, 0, 0, 1, 1, 2])
  assert.equal(rank('analyzing', { running: false }), 0, 'stalled: its analysis never finished')
  assert.equal(rank('ready', { session: undefined }), 0, 'only my own comments: not analysed yet')
  assert.equal(rank('submitted', { rerequested: true }), 0)
  assert.deepEqual([rank('merged'), rank('closed')], [3, 3], 'merged or closed since: below the sent ones')

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-order-')))
  try {
    const repo = join(root, 'app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(repo, REVIEW_DIR), { recursive: true })
    const NOW = Date.parse('2026-10-15T12:00:00Z')
    const sent = new Date(NOW - 3600_000).toISOString()
    const base = (parseSheet(SAMPLE) as { sheet: Sheet }).sheet
    const write = (number: number, sheet: Partial<Sheet>): void => writeFileSync(join(repo, REVIEW_DIR, sheetName(number)), serializeSheet({ ...base, pr: `acme/app#${number}`, ...sheet }))
    write(2, { status: 'ready' })
    write(3, { status: 'submitted', submitted: sent })
    // Asked of me again an hour after I sent it; 5 is still listed just after I sent it (GitHub's search lags).
    write(4, { status: 'submitted', submitted: sent })
    write(5, { status: 'submitted', submitted: sent })
    const pull = (number: number, updatedAt: number): Pull => ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt, cross: false })
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => 's', send: async () => {}, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      now: () => NOW,
      github: {
        requested: async () => [pull(2, NOW - 10), pull(1, NOW - 20), pull(4, NOW - 60_000), pull(5, NOW - 3600_000 - 60_000)],
        stillOpen: async () => [],
        pullStates: async () => [],
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const items = (await service.state()).items
    assert.deepEqual(items.map((item) => [item.number, item.phase, item.rerequested === true]),
      [[1, 'new', false], [4, 'submitted', true], [2, 'ready', false], [3, 'submitted', false], [5, 'submitted', false]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review lane: a sent review whose pull request merged or closed sinks below the sent ones, then leaves the days set later', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-landed-')))
  try {
    const repo = join(root, 'app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(repo, REVIEW_DIR), { recursive: true })
    const NOW = Date.parse('2026-10-15T12:00:00Z')
    const DAY = 24 * 3600_000
    const base = (parseSheet(SAMPLE) as { sheet: Sheet }).sheet
    const write = (number: number, sentDaysAgo: number): void => writeFileSync(join(repo, REVIEW_DIR, sheetName(number)),
      serializeSheet({ ...base, pr: `acme/app#${number}`, status: 'submitted', submitted: new Date(NOW - sentDaysAgo * DAY).toISOString() }))
    write(3, 1)
    write(6, 3)
    write(7, 3)
    write(8, 9)
    write(9, 17)
    const pull = (number: number): Pull => ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt: NOW, cross: false })
    const states: Record<number, PullState> = {
      3: { pull: pull(3), state: 'OPEN' },
      6: { pull: pull(6), state: 'MERGED', at: NOW - 2 * DAY },
      7: { pull: pull(7), state: 'CLOSED', at: NOW - 1 * DAY },
      // Merged six days ago: past the five kept.
      8: { pull: pull(8), state: 'MERGED', at: NOW - 6 * DAY },
      // Sent long before; merged after it had left the board: it does not come back.
      9: { pull: pull(9), state: 'MERGED', at: NOW - 1 * DAY },
    }
    const looked: string[][] = []
    let keepMerged: number | undefined
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5, ...(keepMerged === undefined ? {} : { keepMerged }) }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => 's', send: async () => {}, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      now: () => NOW,
      github: {
        requested: async () => [pull(1)],
        stillOpen: async () => [],
        pullStates: async (keys: string[]) => {
          looked.push(keys)
          return keys.map((key) => states[Number(key.split('#')[1])]!)
        },
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const first = await service.state()
    assert.deepEqual(first.items.map((item) => [item.number, item.phase]), [[1, 'new'], [3, 'submitted'], [7, 'closed'], [6, 'merged']])
    assert.equal(first.items.find((item) => item.number === 6)!.updatedAt, NOW - 2 * DAY, 'sorted and shown by when it landed')
    assert.equal(first.keepMerged, 5)
    assert.equal(first.counts?.mine, 4)
    assert.deepEqual(looked, [['acme/app#3', 'acme/app#6', 'acme/app#7', 'acme/app#8', 'acme/app#9'].map((key) => key.toLowerCase())])

    // Landed is for good: read again, only the open one is looked up.
    await service.state(true)
    assert.deepEqual(looked.at(-1), ['acme/app#3'])

    keepMerged = 0
    const none = await service.state()
    assert.deepEqual(none.items.map((item) => item.number), [1, 3], 'kept 0 days: gone once merged')
    assert.equal(none.keepMerged, 0)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review scopes: 全部 lists every open pull request of the repositories, mine first, read only when asked for', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-scope-')))
  try {
    const repo = join(root, 'app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(repo, { recursive: true })
    const pull = (number: number, updatedAt: number, slug = 'acme/app'): Pull => ({ slug, number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch: 'b', base: 'main', author: 'a', updatedAt, cross: false })
    const asked: string[][] = []
    const looked: string[][] = []
    let stillOpen = true
    let starts = 0
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => `s${++starts}`, send: async () => {}, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: {
        requested: async () => [pull(1, 10)],
        // GitHub's search answers mine too, and pull requests of repositories not asked for are dropped.
        open: async (slugs: string[]) => { asked.push(slugs); return [pull(3, 30), pull(1, 10), pull(2, 20), pull(9, 99, 'other/repo')] },
        stillOpen: async (keys: string[]) => { looked.push(keys); return stillOpen ? [pull(3, 30)] : [] },
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const mine = await service.state()
    assert.deepEqual(mine.items.map((item) => item.number), [1])
    assert.deepEqual(mine.counts, { mine: 1 })
    assert.equal(asked.length, 0, 'the open list is not read until asked for')

    const all = (await service.handle({ op: 'state', scope: 'all' }) as { ok: true; value: ReviewState }).value
    assert.equal(all.scope, 'all')
    assert.deepEqual(all.items.map((item) => [item.number, item.requested]), [[1, true], [3, false], [2, false]])
    assert.deepEqual(all.counts, { mine: 1, all: 3 })
    assert.deepEqual(asked, [['acme/app']])
    assert.equal(all.items[1]!.phase, 'new')
    // Cached: asked again, not read again; the other list now knows the count.
    await service.state(false, 'all')
    assert.equal(asked.length, 1)
    assert.deepEqual((await service.state()).counts, { mine: 1, all: 3 })

    // One of the others can be analysed; 全部分析 still queues only mine.
    const analysed = (await service.handle({ op: 'analyze', key: 'acme/app#3', scope: 'all' }) as { ok: true; value: ReviewState }).value
    assert.equal(analysed.scope, 'all')
    for (let i = 0; i < 200 && service.progress().runs.find((run) => run.key === 'acme/app#3')?.step !== 'analyzing'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(service.progress().runs.find((run) => run.key === 'acme/app#3')?.step, 'analyzing')
    await service.analyzeAll()
    assert.deepEqual(service.progress().runs.map((run) => run.key).sort(), ['acme/app#1', 'acme/app#3'])

    // Analysed unasked: it joins 待我审 while GitHub has it open, and leads 全部 with those asked of me;
    // the one not analysed yet comes first, the one being analysed after it.
    const picked = await service.state()
    assert.deepEqual(picked.items.map((item) => [item.number, item.requested, item.picked === true]), [[1, true, false], [3, false, true]])
    assert.equal(picked.counts?.mine, 2)
    assert.deepEqual(looked.at(-1), ['acme/app#3'], 'looked up by number, mine asked of me left out')
    assert.deepEqual((await service.state(false, 'all')).items.map((item) => item.number), [1, 3, 2])
    stillOpen = false
    assert.deepEqual((await service.state(true)).items.map((item) => item.number), [1], 'closed, it leaves')
    stillOpen = true

    // The sync button of 全部 reads it fresh and says how many it found.
    const synced = (await service.handle({ op: 'sync', scope: 'all' }) as { ok: true; value: ReviewState }).value
    assert.equal(asked.length, 2)
    assert.equal(synced.progress?.sync?.total, 3)
    assert.equal(synced.progress?.sync?.found, 1)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review github: the open list searches a few repositories at a time, side by side, and drops repeats', async () => {
  const calls: string[][] = []
  const node = (number: number, slug: string, at: string): string => JSON.stringify({ number, title: 't', url: 'u', isDraft: false, headRefOid: SHA, headRefName: 'b', baseRefName: 'main', updatedAt: at, author: { login: 'a' }, repository: { nameWithOwner: slug } })
  const github = new GitHub(async (_command, args) => {
    calls.push([...args])
    const query = args.find((arg) => arg.startsWith('q=')) ?? ''
    const out = query.includes('repo:o/r0 ') ? [node(1, 'o/r0', '2026-01-01T00:00:00Z'), node(1, 'o/r0', '2026-01-01T00:00:00Z')] : [node(2, 'o/r7', '2026-02-01T00:00:00Z')]
    return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '', missing: false, timedOut: false, stopped: false, overflow: false }
  })
  const pulls = await github.open(Array.from({ length: 8 }, (_, index) => `o/r${index}`))
  assert.equal(calls.length, 2)
  assert.ok(calls.every((args) => args.includes('--paginate')))
  assert.deepEqual(pulls.map((entry) => `${entry.slug}#${entry.number}`), ['o/r7#2', 'o/r0#1'])
})

test('review github: analysed pull requests are looked up by number, the closed and the missing dropped', async () => {
  const queries: string[] = []
  const pr = (number: number, state: string): object => ({ state, mergedAt: state === 'MERGED' ? '2026-01-02T00:00:00Z' : null, closedAt: null, number, title: 't', url: 'u', isDraft: false, headRefOid: SHA, headRefName: 'b', baseRefName: 'main', updatedAt: '2026-01-01T00:00:00Z', author: null, repository: { nameWithOwner: 'o/r' } })
  const github = new GitHub(async (_command, args) => {
    queries.push(args.find((arg) => arg.startsWith('query=')) ?? '')
    const data = { p0: { pullRequest: pr(1, 'OPEN') }, p1: { pullRequest: pr(2, 'MERGED') }, p2: { pullRequest: null }, p3: null }
    return { code: 1, stdout: JSON.stringify({ data, errors: [{ message: 'Could not resolve to a Repository' }] }), stderr: 'gh: Could not resolve to a Repository', missing: false, timedOut: false, stopped: false, overflow: false }
  })
  const pulls = await github.stillOpen(['o/r#1', 'o/r#2', 'o/r#3', 'x/gone#4'])
  assert.deepEqual(pulls.map((pull) => `${pull.slug}#${pull.number}`), ['o/r#1'])
  assert.equal(queries.length, 1)
  assert.match(queries[0]!, /p3: repository\(owner: "x", name: "gone"\) \{ pullRequest\(number: 4\)/)
  const states = await github.pullStates(['o/r#1', 'o/r#2', 'o/r#3', 'x/gone#4'])
  assert.deepEqual(states.map((entry) => [entry.pull.number, entry.state, 'at' in entry ? entry.at : undefined]), [[1, 'OPEN', undefined], [2, 'MERGED', Date.parse('2026-01-02T00:00:00Z')]])
  assert.match(queries[1]!, /state mergedAt closedAt/)
})

test('review diff helpers: patches split per file, names a change touches', () => {
  const text = 'diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\n@@ -1 +1 @@\n-p\n+q\n'
  assert.deepEqual(splitPatches(text, 2, false).map((part) => part.split('\n')[0]), ['diff --git a/a b/a', 'diff --git a/b b/b'])
  assert.equal(splitPatches(text, 2, true).length, 1, 'a cut output drops its last, maybe partial, file')
  assert.deepEqual(symbolsOf([
    '@@ -1,3 +1,6 @@',
    '+export function retryWebhook(event) {',
    '+  const delay = backoff(attempt)',
    '-const handler = async (req) => {',
    '+  async dispatch(job: Job): Promise<void> {',
    ' unchanged retry(x)',
    '+if (ok) {',
  ].join('\n')), ['retryWebhook', 'delay', 'handler', 'dispatch'])
})

test('review diff and explanations: a new pull request is fetched without a ref, explained, asked again, kept', { skip: !hasGit() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-diff-')))
  try {
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    writeFileSync(join(seed, 'hook.ts'), 'export const a = 1\n')
    writeFileSync(join(seed, 'router.ts'), 'import { a } from "./hook"\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'base')
    git(seed, 'push', '-q', origin, 'main')
    const repo = join(root, 'app')
    execFileSync('git', ['clone', '-q', origin, repo])
    git(seed, 'checkout', '-qb', 'feat')
    writeFileSync(join(seed, 'hook.ts'), 'export const a = 1\nexport function retryWebhook() {\n  return 3\n}\n')
    writeFileSync(join(seed, 'router.ts'), 'import { a, retryWebhook } from "./hook"\nretryWebhook()\n')
    writeFileSync(join(seed, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'retry')
    // The pull request is pushed after the clone: this clone has never seen its head.
    git(seed, 'push', '-q', origin, 'feat:refs/pull/12/head')
    const head = git(seed, 'rev-parse', 'HEAD')

    const pull: Pull = { slug: 'acme/app', number: 12, title: 'Add retry', url: 'https://github.com/acme/app/pull/12', draft: false, head, branch: 'feat', base: 'main', author: 'alice', updatedAt: 1, cross: false }
    const github = { requested: async () => [pull], threads: async () => [] } as unknown as GitHub
    const calls: Array<{ system: string; messages: Array<{ role: string; content: Array<{ text: string }>; source?: object }> }> = []
    let release: () => void = () => {}
    let guide = ''
    let explainBot = ''
    const host = (): ConstructorParameters<typeof ReviewService>[0] => ({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', explain: guide, explainBot, maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [{ workspaceId: 'w1', path: repo, title: 'app', main: true }] }],
      sessions: () => undefined,
      bots: () => [{ id: 'risk', persona: 'Look for what breaks.', provider: 'q', model: 'b' }],
      helper: async () => ({ provider: 'p', model: 'm' }),
      botRoute: async (bot) => ({ provider: bot.provider!, model: bot.model! }),
      llm: () => ({
        async *stream(options: object) {
          calls.push(options as (typeof calls)[number])
          yield { type: 'text-delta', text: `**目的** answer ${calls.length}` }
          // Held until the test lets it go: the answer is seen while it streams.
          await new Promise<void>((resolve) => { release = resolve })
          yield { type: 'text-delta', text: ' done' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
      stateFile: join(root, 'review.json'),
      log: () => {},
      github,
      git: async (args, cwd, options) => {
        if (args[0] === 'config' && args[1] === '--get-regexp') return { code: 0, stdout: `remote.origin.url git@github.com:acme/app.git\n`, stderr: '' }
        const { runGit } = await import('../src/git/service.ts')
        return runGit(args, cwd, options)
      },
    })
    const service = new ReviewService(host())
    const key = 'acme/app#12'
    const call = async <T>(payload: Record<string, unknown>): Promise<T> => {
      const reply = await service.handle(payload)
      if (!reply.ok) throw new Error(reply.error)
      return reply.value as T
    }

    const diff = await call<PullDiff>({ op: 'diff', key })
    assert.equal(diff.head, head)
    assert.equal(diff.base, git(repo, 'rev-parse', 'origin/main'))
    assert.deepEqual(diff.files.map((file) => [file.path, file.code, file.held]), [['hook.ts', 'M', undefined], ['pnpm-lock.yaml', 'A', 'generated'], ['router.ts', 'M', undefined]])
    assert.match(diff.files[0]!.patch!, /^\+export function retryWebhook\(\) \{$/m)
    assert.match(diff.files[2]!.patch!, /^diff --git a\/router\.ts/)
    assert.equal(diff.files[1]!.patch, undefined, 'a lock file is held back')
    // Only fetched: no branch switched, no ref made, nothing in the working tree.
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
    assert.equal(git(repo, 'for-each-ref', 'refs/reviews'), '')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    const lock = await call<PullDiff>({ op: 'diff', key, file: 'pnpm-lock.yaml' })
    assert.equal(lock.files.length, 1)
    assert.match(lock.files[0]!.patch!, /^\+lockfileVersion: 9$/m)
    assert.equal(lock.files[0]!.held, undefined)

    // Explain a hunk: the entry comes back at once and its answer streams.
    const hunk = diff.files[0]!.patch!.slice(diff.files[0]!.patch!.indexOf('@@'))
    const target = { path: 'hook.ts', kind: 'hunk', start: 1, end: 4, diff: hunk }
    const started = await call<Explanation>({ op: 'explain', key, target, lang: 'zh' })
    assert.deepEqual(started.turns, [{ answer: '', done: false }])
    let seen: Explained | undefined
    for (let i = 0; i < 100; i++) {
      seen = await call<Explained>({ op: 'explained', key })
      if (seen.items[0]?.turns[0]?.answer !== '') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(seen!.items[0]!.turns[0]!.answer, '**目的** answer 1')
    assert.equal(seen!.items[0]!.turns[0]!.done, false)
    assert.equal((await call<Explained>({ op: 'explained', key, since: seen!.version })).unchanged, true)
    release()
    for (let i = 0; i < 100 && (await call<Explained>({ op: 'explained', key })).items[0]?.turns[0]?.done !== true; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    const done = await call<Explained>({ op: 'explained', key })
    assert.deepEqual(done.items[0]!.turns, [{ answer: '**目的** answer 1 done', done: true }])
    assert.match(calls[0]!.system, /Answer in Chinese/)
    const prompt = calls[0]!.messages[0]!.content[0]!.text
    assert.match(prompt, /Pull request: Add retry/)
    assert.match(prompt, /export function retryWebhook/)
    assert.match(prompt, /# retryWebhook\nrouter\.ts:1:import/, 'where the name it adds is used')
    assert.match(prompt, /\*\*如何生效\*\*/)

    // The same hunk again costs nothing; a follow-up continues the conversation.
    const again = await call<Explanation>({ op: 'explain', key, target, lang: 'zh' })
    assert.equal(again.id, started.id)
    assert.equal(calls.length, 1)
    await call<Explanation>({ op: 'explain', key, id: started.id, question: '为什么返回 3？', lang: 'zh' })
    await assert.rejects(call({ op: 'explain', key, id: started.id, question: 'again', lang: 'zh' }), /Still answering/)
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    for (let i = 0; i < 100 && (await call<Explained>({ op: 'explained', key })).items[0]?.turns[1]?.done !== true; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(calls[1]!.messages.map((entry) => [entry.role, entry.content[0]!.text.slice(0, 14)]), [
      ['user', 'Pull request: '], ['assistant', '**目的** answer '], ['user', '为什么返回 3？'],
    ])
    // DSH reads an assistant message's source: without one a follow-up fails before it reaches the model.
    assert.deepEqual(calls[1]!.messages[1]!.source, { kind: 'model', provider: 'p', model: 'm' })

    // Kept beside the sheet: a restarted host has it.
    for (let i = 0; i < 100 && !existsSync(join(repo, '.reviews', 'pr-12.explain.json')); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const restarted = new ReviewService(host())
    const kept = await restarted.handle({ op: 'explained', key }) as { ok: true; value: Explained }
    assert.deepEqual(kept.value.items[0]!.turns, [
      { answer: '**目的** answer 1 done', done: true },
      { question: '为什么返回 3？', answer: '**目的** answer 2 done', done: true },
    ])
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the explanations stay in the ignored folder')

    // 设置 → 审核's prompt says how the next explanation goes; what it explains still comes along.
    guide = '只说这段改动会让什么坏掉。'
    await call<Explanation>({ op: 'explain', key, target: { path: 'hook.ts', kind: 'file', diff: hunk }, lang: 'zh' })
    for (let i = 0; i < 100 && calls.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    const custom = calls[2]!.messages[0]!.content[0]!.text
    assert.match(custom, /export function retryWebhook/)
    assert.ok(custom.trimEnd().endsWith(guide))
    assert.doesNotMatch(custom, /\*\*如何生效\*\*/)
    assert.match(calls[2]!.system, /Answer in Chinese/)
    assert.deepEqual([(calls[2] as { provider?: string }).provider, (calls[2] as { model?: string }).model], ['p', 'm'], 'no bot: the helper model')

    // An explain bot: its persona leads the prompt, its model answers.
    explainBot = 'risk'
    await call<Explanation>({ op: 'explain', key, target: { path: 'hook.ts', kind: 'lines', start: 2, end: 2, diff: hunk }, lang: 'zh' })
    for (let i = 0; i < 100 && calls.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    assert.match(calls[3]!.system, /^You are "risk"\.\n\nLook for what breaks\.\n\nYou explain a change/)
    assert.deepEqual([(calls[3] as { provider?: string }).provider, (calls[3] as { model?: string }).model], ['q', 'b'])
    service.dispose()
    restarted.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
