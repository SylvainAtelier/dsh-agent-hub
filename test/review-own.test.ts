import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps, blankSheet, parseSheet, serializeSheet } from '../src/review/sheet.ts'
import { buildResponse, ownPhase, respondMessage, waiting } from '../src/review/author.ts'
import type { Conversation, FullThread, GitHub, OwnPull } from '../src/review/github.ts'
import { ReviewService, type ReviewSettings, type SessionHost } from '../src/review/index.ts'
import type { PullThread, ResponsePosted, ResponsePreview, ReviewRun, ReviewState, Sheet, TreePlaces } from '../src/review/types.ts'
import type { Worktree } from '../src/git/types.ts'

const SHA = 'b'.repeat(40)

const RESPONSE = `---
pr: acme/app#7
title: Retry webhooks
author: me
base: main
head: ${SHA}
round: 1
status: ready
summary: Thanks for the review!
session: s-1
role: author
branch: vi/eng-7-retry
tree: /work/app/.worktrees/vi/eng-7-retry
read: 2026-10-01T10:00:00.000Z
---

## Overview

Two asks.

## Fix

- [x] C1 \`src/hook.ts:10\` 需要上限
  thread: PRRT_1 @alice
  > EN: Good catch, capped it at 5.

## Reply

- [x] C2 \`src/hook.ts:20\` 有意为之
  thread: PRRT_2 @bob
  > EN: This is on purpose: the caller retries too.
- [ ] C3 CI 噪音
  thread: - @ci-bot
`

test('response sheet: Fix and Reply sections, threads, verdicts; a round trip keeps them', () => {
  const parsed = parseSheet(RESPONSE)
  assert.ok('sheet' in parsed)
  const sheet = parsed.sheet
  assert.deepEqual([sheet.role, sheet.branch, sheet.tree, sheet.read, sheet.decision], ['author', 'vi/eng-7-retry', '/work/app/.worktrees/vi/eng-7-retry', '2026-10-01T10:00:00.000Z', 'comment'])
  assert.deepEqual(sheet.findings.map((f) => [f.id, f.severity, f.checked, f.thread, f.reviewer, f.text]), [
    ['C1', 'must', true, 'PRRT_1', 'alice', '需要上限'],
    ['C2', 'nice', true, 'PRRT_2', 'bob', '有意为之'],
    ['C3', 'nice', false, undefined, 'ci-bot', 'CI 噪音'],
  ])
  const written = serializeSheet(sheet)
  assert.match(written, /^## Fix$/m)
  assert.match(written, /^## Reply$/m)
  assert.match(written, /^ {2}thread: PRRT_1 @alice$/m)
  assert.match(written, /^ {2}thread: - @ci-bot$/m)
  assert.deepEqual((parseSheet(written) as { sheet: Sheet }).sheet, sheet)

  // 修改 / 仅回复 / 忽略 move an item between the sections and pick or leave it.
  const next = applyOps(sheet, [{ op: 'verdict', id: 'C2', value: 'fix' }, { op: 'verdict', id: 'C1', value: 'skip' }, { op: 'verdict', id: 'C3', value: 'reply' }])
  assert.deepEqual(next.findings.map((f) => [f.id, f.severity, f.checked]), [['C1', 'must', false], ['C2', 'must', true], ['C3', 'nice', true]])
  assert.throws(() => applyOps(sheet, [{ op: 'verdict', id: 'C1', value: 'later' as 'fix' }]), /unknown verdict/)
  // A review sheet is unchanged by all this: F ids, its own section names.
  const review = serializeSheet(blankSheet({ pr: 'a/b#1', title: 'T', author: 'x', base: 'main', head: SHA, round: 1 }))
  assert.match(review, /^## Must fix$/m)
  assert.doesNotMatch(review, /role:/)
})

const remark = (id: string, author: string, at: string, body = `${author} says`): FullThread['comments'][number] => ({ id, author, body, at })

function thread(id: string, comments: FullThread['comments'], resolved = false): FullThread {
  return { id, path: 'hook.ts', line: 2, resolved, outdated: false, hunk: '@@ -1 +1,2 @@\n export const a = 1\n+export const retry = 3', comments }
}

test('response: what waits on me, the round message, where a card stands, what posting does', () => {
  const conversation: Conversation = {
    viewer: 'me',
    threads: [
      thread('T1', [remark('c1', 'alice', '2026-10-01T09:00:00Z')]),
      thread('T2', [remark('c2', 'bob', '2026-10-01T09:00:00Z'), remark('c3', 'me', '2026-10-01T09:30:00Z')]),
      thread('T3', [remark('c4', 'carol', '2026-10-01T09:00:00Z')], true),
      thread('T4', [remark('c5', 'bot', '2026-10-01T08:00:00Z')]),
    ],
    reviews: [
      { ...remark('r1', 'alice', '2026-10-01T09:00:00Z', 'Please cap retries'), state: 'CHANGES_REQUESTED' },
      { ...remark('r2', 'alice', '2026-10-01T11:00:00Z', ''), state: 'COMMENTED' },
      { ...remark('r3', 'me', '2026-10-01T11:00:00Z', 'mine'), state: 'COMMENTED' },
    ],
    comments: [remark('i1', 'dave', '2026-10-01T12:00:00Z', 'any update?')],
  }
  // First round: unresolved threads whose last word is not mine, and every summary and comment by others with words.
  const first = waiting(conversation)
  assert.deepEqual(first.threads.map((t) => t.id), ['T1', 'T4'])
  assert.deepEqual(first.reviews.map((r) => r.id), ['r1'])
  assert.deepEqual(first.comments.map((c) => c.id), ['i1'])
  // Next round: a thread left alone stays left until someone adds to it; old summaries are not read again.
  const previous = { read: '2026-10-01T10:00:00Z', findings: [{ id: 'C1', severity: 'nice' as const, checked: false, thread: 'T4', text: '', en: '' }] }
  const next = waiting(conversation, previous)
  assert.deepEqual(next.threads.map((t) => t.id), ['T1'])
  assert.deepEqual(next.reviews, [])
  assert.deepEqual(next.comments.map((c) => c.id), ['i1'])
  conversation.threads[3]!.comments.push(remark('c6', 'bot', '2026-10-01T13:00:00Z'))
  assert.deepEqual(waiting(conversation, previous).threads.map((t) => t.id), ['T1', 'T4'])

  const text = respondMessage({
    slug: 'acme/app', number: 7, title: 'Retry', url: 'u', branch: 'vi/eng-7-retry', base: 'main', baseRef: 'origin/main', head: SHA, round: 1,
    sheet: '/w/.reviews/pr-7.md', stat: ' hook.ts | 1 +', diff: '+x', waiting: first, rules: '', analysis: 'sort them', note: 'diverged',
  })
  assert.match(text, /### thread: T1 · `hook\.ts:2`/)
  assert.match(text, /```diff\n@@ -1 \+1,2 @@/)
  assert.match(text, /- @alice changes requested \(2026-10-01\): Please cap retries/)
  assert.match(text, /Note: diverged/)
  assert.match(text, /Do not change any code yet/)

  const sheet = (parseSheet(RESPONSE) as { sheet: Sheet }).sheet
  assert.deepEqual(ownPhase(undefined, undefined, ['PRRT_1']), { phase: 'new' })
  assert.deepEqual(ownPhase(sheet, undefined, ['PRRT_1']), { phase: 'ready', unseen: 0 })
  assert.deepEqual(ownPhase(sheet, undefined, ['PRRT_1', 'PRRT_9']), { phase: 'stale', unseen: 1 })
  assert.deepEqual(ownPhase({ ...sheet, status: 'fixed' }, undefined, ['PRRT_9']), { phase: 'fixed', unseen: 1 })
  // Posted: every thread it answered ends with my reply, so one waiting on me again is news.
  assert.deepEqual(ownPhase({ ...sheet, status: 'submitted' }, undefined, ['PRRT_1']), { phase: 'stale', unseen: 1 })
  assert.deepEqual(ownPhase({ ...sheet, status: 'submitted' }, undefined, []), { phase: 'submitted', unseen: 0 })
  assert.deepEqual(ownPhase(sheet, 'broken', []), { phase: 'invalid' })

  const facts = { commits: [{ sha: SHA, subject: 'cap retries' }], behind: 0, dirty: false }
  // Items to fix that were never fixed stop it; dashes and a remote ahead too.
  assert.deepEqual(buildResponse(sheet, facts).problems, [{ code: 'unfixed', ids: ['C1'] }])
  const fixed = { ...sheet, status: 'fixed' as const }
  const preview = buildResponse(fixed, facts)
  assert.deepEqual(preview.problems, [])
  assert.deepEqual(preview.replies.map((r) => [r.id, r.thread, r.resolve]), [['C1', 'PRRT_1', true], ['C2', 'PRRT_2', false]])
  assert.equal(preview.comment, 'Thanks for the review!')
  assert.deepEqual(buildResponse(fixed, { ...facts, behind: 2, dirty: true }).problems, [{ code: 'behind' }])
  assert.deepEqual(buildResponse(fixed, { ...facts, dirty: true }).warnings, [{ code: 'dirty' }])
  const dashed = applyOps(fixed, [{ op: 'en', id: 'C2', text: 'On purpose — the caller retries' }, { op: 'en', id: 'C1', text: '' }])
  assert.deepEqual(buildResponse(dashed, facts).problems.map((p) => [p.code, p.ids]), [['dash', ['C2']]])
  // A picked thread with its reply left empty is only resolved.
  const silent = applyOps(fixed, [{ op: 'en', id: 'C2', text: '' }])
  assert.deepEqual(buildResponse(silent, facts).problems, [])
  assert.deepEqual(buildResponse(silent, facts).replies.map((r) => [r.id, r.body === '', r.resolve]), [['C1', false, true], ['C2', true, true]])
  const nothing = { ...fixed, summary: '', findings: fixed.findings.map((f) => ({ ...f, checked: false })) }
  assert.deepEqual(buildResponse(nothing, { commits: [], behind: 0, dirty: false }).problems, [{ code: 'nothing' }])
  // A thread-less answer joins the conversation comment, addressed to who wrote it.
  const loose = applyOps(fixed, [{ op: 'verdict', id: 'C3', value: 'reply' }, { op: 'en', id: 'C3', text: 'Known flake.' }])
  assert.equal(buildResponse(loose, facts).comment, 'Thanks for the review!\n\n@ci-bot Known flake.')
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** `git worktree list --porcelain`, as the Git pane reads it. */
function listTrees(repo: string): Worktree[] {
  return git(repo, 'worktree', 'list', '--porcelain').split(/\n\n+/).filter(Boolean).map((block, index) => {
    const path = /^worktree (.+)$/m.exec(block)![1]!
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    const changes = git(path, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).length
    return { path: realpathSync(path), main: index === 0, current: false, changes, ...(branch === undefined ? {} : { branch }), workspace: { id: `w-${index}`, title: path, sessions: 0 } }
  })
}

test('response service: 我的 lists my pull requests; answered in a worktree, fixed on confirm, pushed and replied once', { skip: !hasGit() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-own-')))
  try {
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't')
    writeFileSync(join(seed, 'hook.ts'), 'export const a = 1\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'base')
    git(seed, 'push', '-q', origin, 'main')
    const branch = 'vi/eng-7-retry'
    git(seed, 'checkout', '-qb', branch)
    writeFileSync(join(seed, 'hook.ts'), 'export const a = 1\nexport const retry = 3\n')
    git(seed, 'commit', '-qam', 'retry')
    git(seed, 'push', '-q', origin, branch)
    const repo = join(root, 'app')
    execFileSync('git', ['clone', '-q', origin, repo])
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')

    // GitHub as far as my pull request goes: its threads change as replies land.
    const conversation: Conversation = {
      viewer: 'me',
      threads: [
        thread('T1', [remark('c1', 'alice', '2026-10-01T09:00:00Z', 'Cap the retries?')]),
        thread('T2', [remark('c2', 'bob', '2026-10-01T09:00:00Z', 'Why not exponential?')]),
      ],
      reviews: [],
      comments: [],
    }
    const pull = (): OwnPull => ({
      slug: 'acme/app', number: 7, title: 'Retry webhooks', url: 'https://github.com/acme/app/pull/7', draft: false, head: git(origin, 'rev-parse', branch),
      branch, base: 'main', author: 'me', updatedAt: 1, cross: false, decision: 'CHANGES_REQUESTED',
      pending: conversation.threads.filter((t) => !t.resolved && t.comments.at(-1)!.author !== 'me').map((t) => t.id),
    })
    const replies: Array<{ thread: string; body: string }> = []
    const resolved: string[] = []
    const github = {
      requested: async () => [],
      authored: async () => [pull()],
      conversation: async () => structuredClone(conversation),
      reply: async (id: string, body: string) => {
        replies.push({ thread: id, body })
        conversation.threads.find((t) => t.id === id)!.comments.push(remark(`r${replies.length}`, 'me', '2026-10-02T00:00:00Z', body))
        return { id: `r${replies.length}` }
      },
      resolve: async (id: string) => {
        resolved.push(id)
        conversation.threads.find((t) => t.id === id)!.resolved = true
      },
      comment: async (_slug: string, _number: number, body: string) => {
        conversation.comments.push(remark('i', 'me', '2026-10-02T00:00:00Z', body))
        return { id: 'i' }
      },
      viewer: async () => 'me',
    } as unknown as GitHub
    const sent: Array<{ session: string; text: string; id: string }> = []
    const started: Array<Parameters<SessionHost['start']>[0]> = []
    const sessions: SessionHost = {
      start: async (input) => { started.push(input); return `s-${started.length}` },
      send: async (session, text, id) => { sent.push({ session, text, id }) },
      cancel: async () => {},
      archive: async () => {},
    }
    const settings: ReviewSettings = { repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }
    const service = new ReviewService({
      settings: () => settings,
      repos: async () => [{ key: repo, name: 'app', members: [{ workspaceId: 'w-0', path: repo, title: 'app', main: true, branch: 'main' }] }],
      sessions: () => sessions,
      bots: () => [{ id: 'reviewer', persona: 'review it' }, { id: 'fixer', persona: 'fix it' }],
      helper: async () => undefined,
      llm: () => undefined,
      trees: {
        list: async (cwd) => listTrees(cwd),
        add: async (cwd, name) => {
          const path = join(repo, '.worktrees', ...name.split('/'))
          git(cwd, 'worktree', 'add', '-q', '--track', '-b', name, path, `origin/${name}`)
          return { path: realpathSync(path), workspaceId: 'w-new' }
        },
        open: async (_cwd, path) => ({ path, workspaceId: listTrees(repo).find((tree) => tree.path === path)?.workspace?.id ?? 'w-x' }),
      },
      stateFile: join(root, 'review.json'),
      log: () => {},
      github,
      git: async (args, cwd, options) => {
        if (args[0] === 'config' && args[1] === '--get-regexp') return { code: 0, stdout: 'remote.origin.url git@github.com:acme/app.git\n', stderr: '' }
        const { runGit } = await import('../src/git/service.ts')
        return runGit(args, cwd, options)
      },
    })

    // 我的 is read only once asked for; its count shows from then on.
    const mine = await service.state()
    assert.equal(mine.counts?.own, undefined)
    const own = await service.state(false, 'own')
    assert.equal(own.counts?.own, 1)
    const item = own.items[0]!
    assert.deepEqual([item.own, item.phase, item.pending, item.reviewDecision, item.requested], [true, 'new', 2, 'CHANGES_REQUESTED', false])
    // Never in a batch.
    await assert.rejects(service.analyzeAll(), /analysed already/)

    // Its review threads, drawn on the diff; a reply on one is posted at once and the threads come back with it.
    const shown = (await service.handle({ op: 'threads', key: item.key }) as { ok: true; value: PullThread[] }).value
    assert.deepEqual(shown.map((t) => [t.id, t.path, t.line, t.waiting, t.comments.length]), [['T1', 'hook.ts', 2, true, 1], ['T2', 'hook.ts', 2, true, 1]])
    const answered = (await service.handle({ op: 'reply', key: item.key, thread: 'T2', body: ' Linear on purpose. ' }) as { ok: true; value: PullThread[] }).value
    assert.deepEqual(replies, [{ thread: 'T2', body: 'Linear on purpose.' }])
    assert.deepEqual(answered.map((t) => [t.id, t.waiting, t.comments.at(-1)?.author]), [['T1', true, 'alice'], ['T2', false, 'me']])
    assert.equal((await service.handle({ op: 'reply', key: item.key, thread: 'T9', body: 'x' }) as { error?: string }).error, 'This review thread is no longer on the pull request')
    assert.equal((await service.handle({ op: 'reply', key: item.key, thread: 'T1', body: '  ' }) as { error?: string }).error, 'Write the reply first')
    conversation.threads[1]!.comments.pop()
    replies.length = 0

    // No tree is on the branch: where to work is asked; the main tree is clean, so it is offered.
    const places = (await service.handle({ op: 'places', key: item.key }) as { ok: true; value: TreePlaces }).value
    assert.equal(places.existing, undefined)
    assert.deepEqual(places.options.map((o) => [o.main, o.branch, o.dirty]), [[true, 'main', false]])
    // Without a choice it cannot start; with one, a new worktree on the branch, a session there on the chosen bot.
    await service.handle({ op: 'analyze', key: item.key, scope: 'own', bot: 'fixer', tree: { kind: 'new' } })
    for (let i = 0; i < 200 && sent.length === 0; i++) await tick()
    const tree = realpathSync(join(repo, '.worktrees', 'vi', 'eng-7-retry'))
    assert.equal(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD'), branch)
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the main tree stays where it was')
    assert.deepEqual(started[0], { cwd: tree, workspaceId: 'w-new', title: 'Respond #7 · Retry webhooks', route: { provider: 'agent-hub-bot', model: 'fixer' } })
    assert.match(sent[0]!.text, /### thread: T1 · `hook\.ts:2`/)
    assert.match(sent[0]!.text, /Cap the retries\?/)
    assert.match(sent[0]!.text, /git diff origin\/main\.\.\.HEAD/)
    assert.match(sent[0]!.text, /\+export const retry = 3/)
    const path = join(repo, '.reviews', 'pr-7.md')
    const blank = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    assert.deepEqual([blank.role, blank.branch, blank.tree, blank.status, blank.session], ['author', branch, tree, 'analyzing', 's-1'])
    // Its own section, and none of the review guard: it does what I ask, fixing included.
    assert.ok(service.section('s-1')?.includes('Responding to the review'))
    assert.ok(!service.section('s-1')?.includes('Fix now'))
    assert.equal(service.sessionRepo('s-1'), undefined)
    assert.equal(service.responding('s-1'), true)

    // Its turn fails on the model (a spend limit, say): the run fails with that error, and the card is not busy.
    const runOf = (): ReviewRun | undefined => service.progress().runs.find((entry) => entry.key === item.key)
    service.status('s-1', true)
    service.turnError('s-1', new Error('Claude Code: You\'ve hit your org\'s monthly spend limit'))
    service.status('s-1', false)
    for (let i = 0; i < 50 && runOf()?.step !== 'failed'; i++) await tick()
    assert.deepEqual((({ step, error, code }) => [step, error, code])(runOf()!), ['failed', 'Claude Code: You\'ve hit your org\'s monthly spend limit', undefined])
    assert.equal((await service.state(false, 'own')).items[0]!.running, undefined)
    // Asked again: the same session, under a new request id (the same one would be dropped as a resend).
    await service.handle({ op: 'analyze', key: item.key, scope: 'own' })
    for (let i = 0; i < 200 && sent.length < 2; i++) await tick()
    assert.deepEqual([sent[1]!.session, started.length], ['s-1', 1])
    assert.notEqual(sent[1]!.id, sent[0]!.id)
    // No turn came of it: stopping frees the card at once rather than waiting on a turn that never ends.
    assert.equal((await service.state(false, 'own')).items[0]!.running, true)
    await service.handle({ op: 'cancel', key: item.key, scope: 'own' })
    assert.equal(runOf()!.step, 'cancelled')
    assert.equal((await service.state(false, 'own')).items[0]!.running, undefined)

    // The agent writes the sheet; its turn ends.
    writeFileSync(path, serializeSheet({
      ...blank, status: 'ready', summary: '',
      findings: [
        { id: 'C1', severity: 'must', checked: true, path: 'hook.ts', line: 2, thread: 'T1', reviewer: 'alice', text: '要加上限', en: 'Good call, capping it.' },
        { id: 'C2', severity: 'nice', checked: true, path: 'hook.ts', line: 2, thread: 'T2', reviewer: 'bob', text: '有意为之', en: 'Kept it linear on purpose.' },
      ],
    }))
    service.status('s-1', false)
    for (let i = 0; i < 50 && (await service.state(false, 'own')).items[0]!.phase !== 'ready'; i++) await tick()
    assert.equal((await service.state(false, 'own')).items[0]!.tree, tree)

    // Posting before fixing is refused: C1 was to be fixed.
    const early = (await service.handle({ op: 'preview', path }) as { ok: true; value: ResponsePreview }).value
    assert.deepEqual(early.problems, [{ code: 'unfixed', ids: ['C1'] }])

    // 按单修改: the same session is told which items; it may change its tree now, never push.
    const fix = await service.handle({ op: 'fix', path }) as { ok: boolean }
    assert.equal(fix.ok, true)
    assert.match(sent[2]!.text, /^Fix the checked items .*C1\./)
    assert.equal(sent[2]!.session, 's-1')
    assert.equal(((await service.handle({ op: 'fix', path })) as { ok: boolean; error?: string }).error, 'Its session is busy now')
    assert.deepEqual((({ phase, running }) => [phase, running])((await service.state(false, 'own')).items[0]!), ['fixing', true])
    writeFileSync(join(tree, 'hook.ts'), 'export const a = 1\nexport const retry = Math.min(3, 5)\n')
    git(tree, 'commit', '-qam', 'cap retries')
    const fixedHead = git(tree, 'rev-parse', 'HEAD')
    service.status('s-1', false)
    for (let i = 0; i < 50 && (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet.status !== 'fixed'; i++) await tick()
    const fixedSheet = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    assert.deepEqual([fixedSheet.status, fixedSheet.fixed], ['fixed', fixedHead])
    assert.equal((await service.state(false, 'own')).items[0]!.phase, 'fixed')

    // Fixing again from a fixed sheet: the same session, told some may be done; stopped, it stays fixed.
    assert.equal(((await service.handle({ op: 'fix', path })) as { ok: boolean }).ok, true)
    assert.match(sent[3]!.text, /^Fix the checked items .*C1\.[\s\S]*fixed already by an earlier turn/)
    assert.equal((await service.state(false, 'own')).items[0]!.phase, 'fixing')
    await service.handle({ op: 'cancel', key: (await service.state(false, 'own')).items[0]!.key, scope: 'own' })
    service.status('s-1', false)
    for (let i = 0; i < 50 && (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet.status !== 'fixed'; i++) await tick()
    assert.deepEqual((({ status, fixed }) => [status, fixed])((parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet), ['fixed', fixedHead])

    const preview = (await service.handle({ op: 'preview', path }) as { ok: true; value: ResponsePreview }).value
    assert.deepEqual(preview.problems, [])
    assert.deepEqual(preview.commits.map((c) => c.subject), ['cap retries'])
    assert.deepEqual(preview.replies.map((r) => [r.thread, r.resolve]), [['T1', true], ['T2', false]])

    const done = (await service.handle({ op: 'submit', path }) as { ok: true; value: { preview: ResponsePreview; posted?: ResponsePosted } }).value
    assert.deepEqual(done.posted, { pushed: fixedHead, replies: 2, resolved: 1, url: 'https://github.com/acme/app/pull/7' })
    assert.equal(git(origin, 'rev-parse', branch), fixedHead, 'pushed')
    assert.deepEqual(replies.map((r) => r.thread), ['T1', 'T2'])
    assert.deepEqual(resolved, ['T1'])
    assert.equal((parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet.status, 'submitted')
    // A retry after a failure on our side recognizes what is already there: nothing is posted twice.
    writeFileSync(path, serializeSheet({ ...fixedSheet, status: 'fixed' }))
    const again = (await service.handle({ op: 'submit', path }) as { ok: true; value: { posted?: ResponsePosted } }).value
    assert.deepEqual([again.posted?.replies, again.posted?.resolved, again.posted?.pushed], [2, 0, undefined])
    // A picked thread with its reply left empty gets no reply: it is only resolved.
    writeFileSync(path, serializeSheet({ ...fixedSheet, status: 'fixed', findings: fixedSheet.findings.map((f) => (f.thread === 'T2' ? { ...f, en: '' } : f)) }))
    const silent = (await service.handle({ op: 'submit', path }) as { ok: true; value: { posted?: ResponsePosted } }).value
    assert.deepEqual([silent.posted?.replies, silent.posted?.resolved], [1, 1])
    assert.deepEqual(replies.map((r) => r.thread), ['T1', 'T2'])
    assert.deepEqual(resolved, ['T1', 'T2'])
    conversation.threads[1]!.resolved = false

    // A new comment on a thread I answered: the card has news, and the next round goes on in the same session.
    conversation.threads[1]!.comments.push(remark('c9', 'bob', '2026-10-03T00:00:00Z', 'Fair, but add a comment?'))
    const stale = (await service.state(true, 'own')).items[0]!
    assert.deepEqual([stale.phase, stale.unseen], ['stale', 1])
    await service.handle({ op: 'analyze', key: item.key, scope: 'own' })
    for (let i = 0; i < 200 && sent.length < 5; i++) await tick()
    assert.equal(started.length, 1, 'no new session')
    assert.equal(sent[4]!.session, 's-1')
    assert.match(sent[4]!.text, /### thread: T2/)
    assert.doesNotMatch(sent[4]!.text, /### thread: T1/)
    assert.ok(existsSync(join(repo, '.reviews', 'pr-7.round1.md')))
    const round2 = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    assert.deepEqual([round2.round, round2.status, round2.tree], [2, 'analyzing', tree])

    // My response is not one of my reviews: 待我审 never lists it.
    const reviews: ReviewState = await service.state()
    assert.deepEqual(reviews.items, [])
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('response service: a tree with changes is not switched; a clean one is, tracking the remote branch', { skip: !hasGit() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-own-')))
  try {
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't')
    writeFileSync(join(seed, 'a.ts'), '1\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'base')
    git(seed, 'push', '-q', origin, 'main')
    git(seed, 'push', '-q', origin, 'main:feat')
    const repo = join(root, 'app')
    execFileSync('git', ['clone', '-q', origin, repo])
    const sent: string[] = []
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [{ workspaceId: 'w-0', path: repo, title: 'app', main: true }] }],
      sessions: () => ({ start: async () => 's-1', send: async (_s, text) => { sent.push(text) }, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      trees: { list: async (cwd) => listTrees(cwd), add: async () => { throw new Error('not here') }, open: async (_cwd, path) => ({ path, workspaceId: 'w-0' }) },
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: {
        requested: async () => [],
        authored: async () => [{ slug: 'acme/app', number: 3, title: 'T', url: 'u', draft: false, head: git(origin, 'rev-parse', 'feat'), branch: 'feat', base: 'main', author: 'me', updatedAt: 1, cross: false, pending: [] }],
        conversation: async () => ({ viewer: 'me', threads: [], reviews: [], comments: [] }),
      } as unknown as GitHub,
      git: async (args, cwd, options) => {
        if (args[0] === 'config' && args[1] === '--get-regexp') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app\n', stderr: '' }
        const { runGit } = await import('../src/git/service.ts')
        return runGit(args, cwd, options)
      },
    })
    const key = (await service.state(false, 'own')).items[0]!.key
    writeFileSync(join(repo, 'a.ts'), 'changed\n')
    assert.deepEqual((await service.placesOf(key)).options.map((o) => o.dirty), [true])
    await service.analyze(key, false, 'own', undefined, { kind: 'path', path: repo })
    let run = (await service.state(false, 'own')).progress?.runs[0]
    for (let i = 0; i < 100 && run?.step !== 'failed'; i++) {
      await tick()
      run = service.progress().runs[0]
    }
    assert.match(run?.error ?? '', /uncommitted changes/)
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')

    git(repo, 'checkout', '-q', '--', 'a.ts')
    await service.analyze(key, false, 'own', undefined, { kind: 'path', path: repo })
    for (let i = 0; i < 200 && sent.length === 0; i++) await tick()
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat')
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'feat@{upstream}'), 'origin/feat')
    assert.match(sent[0]!, /No comment waits on me now/)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
