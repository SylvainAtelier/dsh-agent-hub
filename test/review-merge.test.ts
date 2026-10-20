import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHub, type OwnPull, type Pull } from '../src/review/github.ts'
import { ReviewService, type SessionHost } from '../src/review/index.ts'
import type { MergeState, ReviewReply } from '../src/review/types.ts'

const SHA = 'c'.repeat(40)
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false, stopped: false, overflow: false })

const repository = (pr: Record<string, unknown>) => JSON.stringify({ data: { repository: {
  mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'REBASE',
  pullRequest: {
    id: 'PR_1', state: 'OPEN', isDraft: false, mergedAt: null, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', headRefOid: SHA, baseRefName: 'main',
    reviewDecision: 'APPROVED', viewerCanEnableAutoMerge: true, autoMergeRequest: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'StatusContext', state: 'PENDING' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ] } } } }] },
    ...pr,
  },
} } })

test('merge github: where a pull request stands, read from one query', async () => {
  const github = new GitHub(async () => ok(repository({ autoMergeRequest: { mergeMethod: 'SQUASH', enabledBy: { login: 'me' } } })))
  const state = await github.mergeState('acme/app', 7)
  assert.deepEqual(state.methods, ['SQUASH', 'REBASE'])
  assert.equal(state.preferred, 'REBASE')
  assert.deepEqual(state.checks, { passed: 3, failed: 1, pending: 2 })
  assert.deepEqual(state.auto, { method: 'SQUASH', by: 'me' })
  assert.deepEqual([state.id, state.status, state.decision, state.head, state.base, state.canAuto], ['PR_1', 'BLOCKED', 'APPROVED', SHA, 'main', true])
  assert.equal(state.mergedAt, undefined)
})

test('merge github: merging now holds GitHub to the head I saw; auto-merge and turning it off are their own mutations', async () => {
  const calls: string[][] = []
  const github = new GitHub(async (_command, args) => {
    calls.push([...args])
    return ok('{"data":{}}')
  })
  await github.merge('PR_1', 'SQUASH', false, SHA)
  await github.merge('PR_1', 'REBASE', true)
  await github.cancelAutoMerge('PR_1')
  const query = (args: string[]): string => args.find((arg) => arg.startsWith('query='))!
  assert.match(query(calls[0]!), /mergePullRequest\(input: \{ pullRequestId: \$id, mergeMethod: \$method, expectedHeadOid: \$head \}/)
  assert.ok(calls[0]!.includes('method=SQUASH') && calls[0]!.includes(`head=${SHA}`))
  assert.match(query(calls[1]!), /enablePullRequestAutoMerge/)
  assert.ok(calls[1]!.includes('method=REBASE') && !calls[1]!.some((arg) => arg.startsWith('head=')))
  assert.match(query(calls[2]!), /disablePullRequestAutoMerge/)
})

test('merge github: a draft again and ready for review are their own mutations', async () => {
  const calls: string[][] = []
  const github = new GitHub(async (_command, args) => {
    calls.push([...args])
    return ok('{"data":{}}')
  })
  await github.setDraft('PR_1', true)
  await github.setDraft('PR_1', false)
  const query = (args: string[]): string => args.find((arg) => arg.startsWith('query='))!
  assert.match(query(calls[0]!), /convertPullRequestToDraft\(input: \{ pullRequestId: \$id \}\)/)
  assert.match(query(calls[1]!), /markPullRequestReadyForReview\(input: \{ pullRequestId: \$id \}\)/)
  assert.ok(calls.every((args) => args.includes('id=PR_1')))
})

test('merge service: only my own pull request is merged, and GitHub\'s word after it comes back', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-merge-')))
  try {
    const repo = join(root, 'app')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    const base = { title: 'T', draft: false, head: SHA, branch: 'b', base: 'main', updatedAt: 1, cross: false }
    const theirs: Pull = { ...base, slug: 'acme/app', number: 3, url: 'https://github.com/acme/app/pull/3', author: 'alice' }
    const mine: OwnPull = { ...base, slug: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', author: 'me', pending: [] }
    let merged = false
    const merges: Array<[string, string, boolean, string | undefined]> = []
    const github = {
      requested: async () => [theirs],
      authored: async () => (merged ? [] : [mine]),
      viewer: async () => 'me',
      mergeState: async (): Promise<MergeState & { id: string }> => ({
        id: 'PR_7', state: merged ? 'MERGED' : 'OPEN', draft: false, status: 'CLEAN', mergeable: 'MERGEABLE', methods: ['SQUASH'], canAuto: false,
        checks: { passed: 1, failed: 0, pending: 0 }, head: SHA, base: 'main', ...(merged ? { mergedAt: '2026-10-15T00:00:00Z' } : {}),
      }),
      merge: async (id: string, method: string, auto: boolean, head?: string) => {
        merges.push([id, method, auto, head])
        merged = true
      },
    } as unknown as GitHub
    const sessions: SessionHost = { start: async () => 's', send: async () => {}, cancel: async () => {}, archive: async () => {} }
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [{ workspaceId: 'w-0', path: repo, title: 'app', main: true, branch: 'main' }] }],
      sessions: () => sessions,
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      trees: { list: async () => [], add: async () => ({ path: repo }), open: async (_cwd, path) => ({ path }) },
      stateFile: join(root, 'review.json'),
      log: () => {},
      github,
      git: async (args, cwd, options) => {
        if (args[0] === 'config' && args[1] === '--get-regexp') return { code: 0, stdout: 'remote.origin.url git@github.com:acme/app.git\n', stderr: '' }
        const { runGit } = await import('../src/git/service.ts')
        return runGit(args, cwd, options)
      },
    })
    await service.state(false, 'own')
    const refused = await service.handle({ op: 'merge', key: 'acme/app#3', method: 'SQUASH' }) as ReviewReply<MergeState>
    assert.deepEqual(refused, { ok: false, error: 'Only your own pull requests can be merged here' })
    assert.equal((await service.handle({ op: 'merge', key: 'acme/app#7', method: 'FAST' as never }) as { error?: string }).error, 'unknown merge method')

    const before = await service.handle({ op: 'mergeState', key: 'acme/app#7' }) as { ok: true; value: MergeState }
    assert.equal(before.value.state, 'OPEN')
    assert.equal('id' in before.value, false, 'the node id stays on the host')
    const after = await service.handle({ op: 'merge', key: 'acme/app#7', method: 'SQUASH', head: SHA }) as { ok: true; value: MergeState }
    assert.deepEqual(merges, [['PR_7', 'SQUASH', false, SHA]])
    assert.deepEqual([after.value.state, after.value.mergedAt], ['MERGED', '2026-10-15T00:00:00Z'])
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('github: at most four gh processes at once, the rest run as they end', async () => {
  let running = 0
  let most = 0
  const github = new GitHub(async () => {
    most = Math.max(most, ++running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running--
    return ok(JSON.stringify({ data: { repository: { pullRequest: { id: 'P', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: 'a' } } } }))
  })
  const answers = await Promise.allSettled(Array.from({ length: 10 }, () => github.setDraft('P', true)))
  assert.equal(answers.length, 10)
  assert.equal(most, 4)
  assert.equal(running, 0)
})
