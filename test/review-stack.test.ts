import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps, blankSheet, parseSheet, serializeSheet } from '../src/review/sheet.ts'
import { GitHub, type Neighbors, type Pull } from '../src/review/github.ts'
import { ReviewService } from '../src/review/index.ts'
import { firstMessage, stackSection } from '../src/review/prompt.ts'
import { stacksOf, type ReviewState } from '../src/review/types.ts'

const SHA = 'a'.repeat(40)

test('review stacks: each pull request above its parent, a fork in the stack on a line of its own', () => {
  const item = (number: number, parent?: number) => ({ key: `o/r#${number}`, number, ...(parent === undefined ? {} : { parent: `o/r#${parent}` }) })
  // 1 ← 2 ← 3, and 4 on 1 too; 9's parent is not among them, 5 stands alone.
  const stacks = stacksOf([item(3, 2), item(1), item(4, 1), item(2, 1), item(9, 8), item(5)])
  assert.equal(stacks.rootOf('o/r#3'), 'o/r#1')
  assert.equal(stacks.rootOf('o/r#1'), 'o/r#1')
  assert.equal(stacks.rootOf('o/r#5'), undefined)
  assert.equal(stacks.rootOf('o/r#9'), undefined, 'a parent not listed is none')
  // The side branch first: shown top down, it sits right above where it forks off.
  assert.deepEqual(stacks.rows('o/r#1'), [{ key: 'o/r#1', level: 0 }, { key: 'o/r#4', level: 1 }, { key: 'o/r#2', level: 0 }, { key: 'o/r#3', level: 0 }])
  assert.deepEqual(stacks.below('o/r#3'), ['o/r#2', 'o/r#1'])
  assert.deepEqual(stacks.above('o/r#1'), ['o/r#4', 'o/r#2', 'o/r#3'])
  // A loop never hangs.
  const loop = stacksOf([{ key: 'o/r#1', number: 1, parent: 'o/r#2' }, { key: 'o/r#2', number: 2, parent: 'o/r#1' }])
  assert.deepEqual(loop.below('o/r#1'), ['o/r#2'])
})

test('review sheet: the stack picked as context is kept in the front matter', () => {
  const sheet = blankSheet({ pr: 'o/r#3', title: 'T', author: 'a', base: 'b', head: SHA, round: 1, context: ['o/r#2', 'o/r#1'] })
  const text = serializeSheet(sheet)
  assert.match(text, /^context: o\/r#2 o\/r#1$/m)
  const read = parseSheet(text)
  assert.ok('sheet' in read)
  assert.deepEqual(read.sheet.context, ['o/r#2', 'o/r#1'])
  assert.deepEqual(applyOps(read.sheet, [{ op: 'context', keys: ['o/r#1', 'o/r#1', 'not a key'] }]).context, ['o/r#1'])
  const none = applyOps(read.sheet, [{ op: 'context', keys: [] }])
  assert.equal(none.context, undefined)
  assert.doesNotMatch(serializeSheet(none), /^context:/m)
})

test('review prompts: the stack is named, the picked pull requests given with their diff', () => {
  const stack = stackSection({
    below: [{ number: 1, title: 'Extract client', author: 'alice', range: 'refs/remotes/origin/main...refs/reviews/pr-1' }],
    above: [{ number: 3, title: 'Retry UI', author: 'bob' }],
  })
  assert.match(stack, /- below, it builds on #1 "Extract client" @alice: `git diff refs\/remotes\/origin\/main\.\.\.refs\/reviews\/pr-1`/)
  assert.match(stack, /- above, built on it #3 "Retry UI" @bob$/m)
  assert.match(stack, /context only/)
  assert.doesNotMatch(stackSection({ below: [{ number: 1, title: 'A', author: '' }], above: [] }), /context only/, 'nothing picked: only named')
  const message = firstMessage({
    slug: 'o/r', number: 2, title: 'T', url: 'u', author: 'a', base: 'feat-a', baseRef: 'refs/remotes/origin/feat-a', head: SHA, round: 1, stat: '', threads: [], rules: '', stack,
  })
  assert.ok(message.includes(stack))
})

test('review github: stack neighbours, the parent never a fork, a fork asked for no children', async () => {
  const queries: string[] = []
  const node = (number: number, branch: string, base: string, cross = false): object => ({
    number, title: 't', url: 'u', isDraft: false, headRefOid: SHA, headRefName: branch, baseRefName: base, updatedAt: '2026-01-01T00:00:00Z',
    isCrossRepository: cross, author: { login: 'a' }, repository: { nameWithOwner: 'o/r' },
  })
  const github = new GitHub(async (_command, args) => {
    queries.push(args.find((arg) => arg.startsWith('query=')) ?? '')
    const data = {
      p0: { defaultBranchRef: { name: 'main' }, up: { nodes: [node(1, 'a', 'main'), node(7, 'a', 'main', true)] }, down: { nodes: [node(3, 'c', 'b')] } },
      p1: null,
    }
    return { code: 0, stdout: JSON.stringify({ data }), stderr: '', missing: false, timedOut: false, stopped: false, overflow: false }
  })
  const pull = (number: number, branch: string, base: string, cross: boolean, slug = 'o/r'): Pull =>
    ({ slug, number, title: 't', url: 'u', draft: false, head: SHA, branch, base, author: 'a', updatedAt: 1, cross })
  const answers = await github.neighbors([pull(2, 'b', 'a', false), pull(8, 'x', 'y', true, 'x/gone')])
  assert.deepEqual(answers.map((answer: Neighbors) => [answer.key, answer.trunk, answer.up.map((up) => up.number), answer.down.map((down) => down.number)]), [['o/r#2', 'main', [1], [3]]])
  assert.equal(queries.length, 1)
  assert.match(queries[0]!, /p0: repository\(owner: "o", name: "r"\) \{ defaultBranchRef \{ name \} up: pullRequests\(headRefName: "a", states: OPEN, first: 5\)/)
  assert.match(queries[0]!, /down: pullRequests\(baseRefName: "b"/)
  assert.doesNotMatch(queries[0]!.slice(queries[0]!.indexOf('p1:')), /down:/, 'a fork has no children here')
})

test('review service: the stack around a pull request asked of me comes along, and an analysis reads what I pick', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-stack-')))
  try {
    const repo = join(root, 'app')
    mkdirSync(repo, { recursive: true })
    const pull = (number: number, branch: string, base: string, author = 'a'): Pull =>
      ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch, base, author, updatedAt: number, cross: false })
    // main ← 1 (a) ← 2 (b, asked of me) ← 3 (c); 4 (d) on 1 too; 9 is a release from main, no stack's bottom.
    const pulls = [pull(1, 'a', 'main'), pull(2, 'b', 'a'), pull(3, 'c', 'b'), pull(4, 'd', 'a'), pull(9, 'main', 'release')]
    const asked: string[][] = []
    const neighbors = async (frontier: Pull[]): Promise<Neighbors[]> => {
      asked.push(frontier.map((entry) => `#${entry.number}`))
      return frontier.map((entry) => ({
        key: `${entry.slug}#${entry.number}`,
        trunk: 'main',
        up: pulls.filter((other) => other.branch === entry.base),
        down: pulls.filter((other) => other.base === entry.branch),
      }))
    }
    const fetches: string[][] = []
    const sent: string[] = []
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => 's1', send: async (_session, text) => { sent.push(text) }, cancel: async () => {}, archive: async () => {} }),
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: { requested: async () => [pulls[1]!], neighbors, threads: async () => [] } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'fetch') fetches.push([...args])
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const state = await service.state()
    assert.deepEqual(state.items.map((item) => [item.number, item.parent]), [[2, 'acme/app#1']])
    assert.deepEqual(state.related?.map((item) => [item.number, item.parent, item.requested]).sort(), [[1, undefined, false], [3, 'acme/app#2', false], [4, 'acme/app#1', false]])
    assert.deepEqual(asked, [['#2'], ['#1', '#3'], ['#4']], 'level by level, each asked once')
    // Cached: asked again, not looked up again.
    await service.state()
    assert.equal(asked.length, 3)

    const analysed = await service.handle({ op: 'analyze', key: 'acme/app#2', context: ['acme/app#1'] }) as { ok: true; value: ReviewState }
    assert.equal(analysed.ok, true)
    for (let i = 0; i < 200 && service.progress().runs.find((run) => run.key === 'acme/app#2')?.step !== 'analyzing'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(service.progress().runs.find((run) => run.key === 'acme/app#2')?.step, 'analyzing')
    assert.ok(fetches.some((args) => args.includes('+refs/pull/1/head:refs/reviews/pr-1') && args.includes('+refs/heads/main:refs/remotes/origin/main')), 'the picked one is fetched with its base')
    assert.ok(!fetches.some((args) => args.some((arg) => arg.includes('refs/pull/3/'))), 'what is not picked is not fetched')
    const message = sent.at(-1) ?? ''
    assert.match(message, /below, it builds on #1 "T1" @a: `git diff refs\/remotes\/origin\/main\.\.\.refs\/reviews\/pr-1`/)
    assert.match(message, /above, built on it #3 "T3" @a$/m)
    const sheet = parseSheet(readFileSync(join(repo, '.reviews', 'pr-2.md'), 'utf8'))
    assert.ok('sheet' in sheet)
    assert.deepEqual(sheet.sheet.context, ['acme/app#1'], 'the pick is kept in the sheet')
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review service: a review I submitted stays on its stack while its pull request is open', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-stack-')))
  try {
    const repo = join(root, 'app')
    mkdirSync(join(repo, '.reviews'), { recursive: true })
    const pull = (number: number, branch: string, base: string): Pull =>
      ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: SHA, branch, base, author: 'a', updatedAt: number, cross: false })
    // main ← 1 (a, reviewed by me and no longer asked of me) ← 2 (b); 5 (z) was reviewed and merged.
    const pulls = [pull(1, 'a', 'main'), pull(2, 'b', 'a')]
    const now = Date.now()
    for (const number of [1, 5]) {
      writeFileSync(join(repo, '.reviews', `pr-${number}.md`), serializeSheet({
        ...blankSheet({ pr: `acme/app#${number}`, title: `T${number}`, author: 'a', base: 'main', head: SHA, round: 1, status: 'submitted' }),
        submitted: new Date(now - 3_600_000).toISOString(),
      }))
    }
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => undefined,
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: {
        requested: async () => [],
        viewer: async () => 'me',
        pullStates: async () => [
          { pull: pulls[0]!, state: 'OPEN' },
          { pull: pull(5, 'z', 'main'), state: 'MERGED', at: now - 60_000 },
        ],
        neighbors: async (frontier: Pull[]): Promise<Neighbors[]> => frontier.map((entry) => ({
          key: `${entry.slug}#${entry.number}`, trunk: 'main',
          up: pulls.filter((other) => other.branch === entry.base), down: pulls.filter((other) => other.base === entry.branch),
        })),
      } as unknown as GitHub,
      git: async (args) => (args[0] === 'config' ? { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    })
    const state = await service.state()
    assert.deepEqual(state.items.map((item) => [item.number, item.phase]).sort(), [[1, 'submitted'], [5, 'merged']])
    assert.deepEqual(state.related?.map((item) => [item.number, item.parent]), [[2, 'acme/app#1']], 'what is stacked on it comes along')
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
