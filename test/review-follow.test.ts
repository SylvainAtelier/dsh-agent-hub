import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankSheet, parseSheet, serializeSheet } from '../src/review/sheet.ts'
import type { Conversation, GitHub, Pull, PullActivity, PullState } from '../src/review/github.ts'
import { followOf, ReviewService, talkOf } from '../src/review/index.ts'
import { firstMessage, followSection } from '../src/review/prompt.ts'
import { findingOfThread, followed, REVIEW_DIR, reviewRank, sheetName, type Sheet } from '../src/review/types.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const SENT = Date.parse('2026-10-14T08:00:00Z')
const at = (minutes: number): number => SENT + minutes * 60_000

const sent = (extra: Partial<Sheet> = {}): Sheet => ({
  ...blankSheet({ pr: 'acme/app#7', title: 'Retry', author: 'alice', base: 'main', head: A, round: 1, status: 'submitted' }),
  submitted: new Date(SENT).toISOString(),
  findings: [{ id: 'F1', severity: 'must', checked: true, path: 'src/a.ts', line: 3, text: '要加上限', en: 'Cap the retries  here.' }],
  ...extra,
})

const activity = (extra: Partial<PullActivity> = {}): PullActivity => ({ commits: [{ oid: A, at: at(-60) }], threads: [], remarks: [], ...extra })

test('follow-up: commits past the head I saw, counted from the list or at least the push', () => {
  assert.deepEqual(followOf(sent(), A, activity(), 'me'), { commits: 0, comments: 0, authors: [], mine: { replied: 0, resolved: 0, outdated: 0, open: 0 } })
  const two = activity({ commits: [{ oid: A, at: at(-60) }, { oid: B, at: at(10) }, { oid: C, at: at(20) }] })
  assert.equal(followOf(sent(), C, two, 'me')?.commits, 2)
  // Rebased: the old head is gone, those committed since count, and at least the push.
  assert.equal(followOf(sent(), C, activity({ commits: [{ oid: C, at: at(20) }, { oid: B, at: at(30) }] }), 'me')?.commits, 2)
  assert.equal(followOf(sent(), C, activity({ commits: [{ oid: C, at: at(-90) }] }), 'me')?.commits, 1)
  // Unknown activity: only the commits, and only when the head moved.
  assert.deepEqual(followOf(sent(), B, undefined, 'me'), { commits: 1, comments: 0, authors: [], mine: { replied: 0, resolved: 0, outdated: 0, open: 0 } })
  assert.equal(followOf(sent(), A, undefined, 'me'), undefined)
  // Caught up at B: only what came after.
  assert.equal(followOf(sent({ seen: B }), B, two, 'me')?.commits, 0)
  assert.equal(followOf(sent({ seen: B }), C, two, 'me')?.commits, 1)
  // Not a submitted review of mine: nothing to follow.
  assert.equal(followOf(sent({ status: 'ready' }), B, two, 'me'), undefined)
  assert.equal(followOf(sent({ role: 'author' }), B, two, 'me'), undefined)
})

test('follow-up: comments by anyone but me (bots too) since I caught up, and where my threads stand', () => {
  const act = activity({
    threads: [
      // Mine, answered after the review.
      { resolved: false, outdated: false, root: 'me', comments: [{ author: 'me', at: at(-1) }, { author: 'alice', at: at(5) }] },
      // Mine, resolved without a word; mine, its lines changed; mine, untouched.
      { resolved: true, outdated: false, root: 'Me', comments: [{ author: 'me', at: at(-1) }] },
      { resolved: false, outdated: true, root: 'me', comments: [{ author: 'me', at: at(-1) }] },
      { resolved: false, outdated: false, root: 'me', comments: [{ author: 'me', at: at(-1) }, { author: 'alice', at: at(1) }, { author: 'me', at: at(2) }] },
      // Someone else's thread: its comments count, its stand does not.
      { resolved: false, outdated: false, root: 'bob', comments: [{ author: 'bob', at: at(3) }, { author: 'codecov', at: at(4) }] },
    ],
    remarks: [
      { kind: 'review', author: 'me', at: at(0), empty: false, state: 'COMMENTED' },
      // A review that is only its thread comments, counted there; a bare approval counts.
      { kind: 'review', author: 'alice', at: at(5), empty: true, state: 'COMMENTED' },
      { kind: 'review', author: 'bob', at: at(6), empty: true, state: 'APPROVED' },
      { kind: 'comment', author: 'github-actions', at: at(7), empty: false },
      // Before the review: not news.
      { kind: 'comment', author: 'alice', at: at(-30), empty: false },
    ],
  })
  const follow = followOf(sent(), A, act, 'ME')!
  assert.deepEqual(follow, {
    commits: 0, comments: 6, authors: ['alice', 'bob', 'codecov', 'github-actions'],
    mine: { replied: 1, resolved: 1, outdated: 1, open: 1 },
  })
  assert.equal(followed({ follow }), true)
  assert.equal(reviewRank({ phase: 'submitted', follow }), 0)
  assert.equal(reviewRank({ phase: 'submitted', follow: { ...follow, comments: 0 } }), 2, 'nothing new: it stays down')
  // Read at minute 5: only what came after.
  const later = followOf(sent({ read: new Date(at(5)).toISOString() }), A, act, 'me')!
  assert.deepEqual([later.comments, later.authors], [2, ['bob', 'github-actions']])
  assert.deepEqual(later.mine, follow.mine, 'where my threads stand does not depend on what I read')
  // Who I am unknown: my own comments cannot be told apart, so none count.
  assert.equal(followOf(sent(), A, act, ''), undefined)
})

test('talk: threads I started are marked and placed on the head the diff shows; remarks since the review', () => {
  const conversation: Conversation = {
    viewer: 'me',
    threads: [
      {
        id: 'T1', path: 'src/a.ts', line: 9, resolved: false, outdated: false, hunk: '', original: { commit: A, line: 3 },
        comments: [{ id: 'c1', author: 'me', body: 'Cap the retries here.', at: new Date(at(0)).toISOString() }, { id: 'c2', author: 'alice', body: 'Done', at: new Date(at(5)).toISOString() }],
      },
      {
        id: 'T2', path: 'src/b.ts', line: 4, start: 2, resolved: false, outdated: false, hunk: '', original: { commit: B, line: 4, start: 2 },
        comments: [{ id: 'c3', author: 'bob', body: 'Why?', at: new Date(at(6)).toISOString() }],
      },
    ],
    reviews: [
      { id: 'r0', author: 'me', body: 'Two things.', at: new Date(at(0)).toISOString(), state: 'COMMENTED' },
      { id: 'r1', author: 'alice', body: '', at: new Date(at(5)).toISOString(), state: 'COMMENTED' },
      { id: 'r2', author: 'bob', body: 'LGTM now', at: new Date(at(8)).toISOString(), state: 'APPROVED', url: 'u2' },
    ],
    comments: [
      { id: 'k1', author: 'alice', body: 'Earlier', at: new Date(at(-10)).toISOString() },
      { id: 'k2', author: 'alice', body: 'Pushed a fix', at: new Date(at(7)).toISOString() },
    ],
  }
  // The diff shows the analysed head A while GitHub is at C: T1 sits where it was left; T2 was left on B, so on no line.
  const talk = talkOf(conversation, { own: false, head: C }, sent())
  assert.deepEqual(talk.threads.map((thread) => [thread.id, thread.line, thread.start, thread.mine === true, thread.waiting]), [
    ['T1', 3, undefined, true, true],
    ['T2', undefined, undefined, false, false],
  ])
  assert.deepEqual(talk.remarks.map((remark) => [remark.author, remark.body, remark.state]), [['alice', 'Pushed a fix', undefined], ['bob', 'LGTM now', 'APPROVED']])
  // At the head GitHub has: where each is now.
  assert.deepEqual(talkOf(conversation, { own: false, head: A }, sent()).threads.map((thread) => [thread.line, thread.start]), [[9, undefined], [4, 2]])
  // My own pull request: every thread as GitHub places it, each waiting when its last word is not mine; no remarks.
  const own = talkOf(conversation, { own: true, head: C }, undefined)
  assert.deepEqual(own.threads.map((thread) => [thread.line, thread.mine, thread.waiting]), [[9, undefined, true], [4, undefined, true]])
  assert.deepEqual(own.remarks, [])
  // The finding a thread came from: same file, same comment, whitespace aside.
  assert.equal(findingOfThread(talk.threads[0]!, sent().findings)?.id, 'F1')
  assert.equal(findingOfThread(talk.threads[1]!, sent().findings), undefined)

  const section = followSection({ submitted: '2026-10-14T08:00:00Z', viewer: 'me', threads: talk.threads.filter((thread) => thread.mine), remarks: talk.remarks, findings: sent().findings })
  assert.match(section, /Since your last review \(submitted 2026-10-14T08:00:00Z\)/)
  assert.match(section, /- F1 `src\/a\.ts:3` \(replied\): Cap the retries here\./)
  assert.match(section, / {2}- @alice: Done/)
  assert.match(section, /- @bob \(review, approved\): LGTM now/)
  assert.equal(followSection({ submitted: 'x', viewer: 'me', threads: [], remarks: [], findings: [] }), '')
  // The round after: told beside the diff since the last review.
  const brief = firstMessage({
    slug: 'acme/app', number: 7, title: 'Retry', url: 'u', author: 'alice', base: 'main', baseRef: 'origin/main', head: C, round: 2, stat: '', threads: [], rules: '',
    previous: { head: A, sheet: '.reviews/pr-7.round1.md' }, followed: section,
  })
  assert.ok(brief.indexOf('new since the last review') < brief.indexOf('Since your last review'))
})

test('sheet: a submitted review keeps when and at which head I caught up', () => {
  const sheet = sent({ read: '2026-10-15T09:00:00.000Z', seen: B })
  const back = (parseSheet(serializeSheet(sheet)) as { sheet: Sheet }).sheet
  assert.deepEqual([back.read, back.seen], [sheet.read, B])
})

test('review lane: a sent review followed up rises with what came, until marked seen', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-follow-')))
  try {
    const repo = join(root, 'app')
    mkdirSync(join(repo, REVIEW_DIR), { recursive: true })
    const NOW = at(60)
    const path = join(repo, REVIEW_DIR, sheetName(7))
    writeFileSync(path, serializeSheet(sent()))
    writeFileSync(join(repo, REVIEW_DIR, sheetName(8)), serializeSheet({ ...sent(), pr: 'acme/app#8' }))
    const pull = (number: number, head: string): Pull => ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head, branch: 'b', base: 'main', author: 'alice', updatedAt: at(30), cross: false })
    const states: PullState[] = [
      {
        pull: pull(7, B), state: 'OPEN', activity: activity({
          commits: [{ oid: A, at: at(-60) }, { oid: B, at: at(10) }],
          threads: [{ resolved: false, outdated: true, root: 'me', comments: [{ author: 'me', at: at(-1) }, { author: 'alice', at: at(12) }] }],
        }),
      },
      { pull: pull(8, A), state: 'OPEN', activity: activity() },
    ]
    let asked: unknown[] = []
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
        requested: async () => [],
        stillOpen: async () => [],
        viewer: async () => 'me',
        pullStates: async (...args: unknown[]) => {
          asked = args
          return states
        },
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const first = await service.state()
    assert.equal(asked[1], true, 'looked up with what happened on them')
    assert.deepEqual(first.items.map((item) => [item.number, item.phase, item.head, item.follow?.commits, item.follow?.comments]), [[7, 'submitted', B, 1, 1], [8, 'submitted', A, 0, 0]])
    assert.deepEqual(first.items[0]!.follow?.mine, { replied: 1, resolved: 0, outdated: 0, open: 0 })

    const after = (await service.handle({ op: 'seen', key: 'acme/app#7' }) as { ok: true; value: { items: Array<{ number: number; follow?: { commits: number; comments: number } }> } }).value
    assert.deepEqual(after.items.map((item) => [item.number, item.follow?.commits, item.follow?.comments]), [[7, 0, 0], [8, 0, 0]])
    const kept = (parseSheet(readFileSync(path, 'utf8')) as { sheet: Sheet }).sheet
    assert.deepEqual([kept.read, kept.seen, kept.status], [new Date(NOW).toISOString(), B, 'submitted'])
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review lane: a review just submitted shows at once while GitHub is asked what followed the others', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-follow-')))
  try {
    const repo = join(root, 'app')
    mkdirSync(join(repo, REVIEW_DIR), { recursive: true })
    writeFileSync(join(repo, REVIEW_DIR, sheetName(7)), serializeSheet(sent()))
    const pull = (number: number): Pull => ({ slug: 'acme/app', number, title: `T${number}`, url: `u${number}`, draft: false, head: B, branch: 'b', base: 'main', author: 'alice', updatedAt: at(30), cross: false })
    let lookups = 0
    let release: (() => void) | undefined
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => undefined,
      bots: () => [],
      helper: async () => undefined,
      llm: () => undefined,
      stateFile: join(root, 'review.json'),
      log: () => {},
      now: () => at(60),
      github: {
        requested: async () => [],
        stillOpen: async () => [],
        viewer: async () => 'me',
        neighbors: async () => [],
        pullStates: async (keys: string[]) => {
          lookups++
          if (lookups > 1) await new Promise<void>((resolve) => { release = resolve })
          return keys.map((key): PullState => ({ pull: pull(Number(key.split('#')[1])), state: 'OPEN', activity: activity() }))
        },
      } as unknown as GitHub,
      git: async (args) => (args[0] === 'config' ? { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    })
    assert.deepEqual((await service.state()).items.map((item) => [item.number, item.head]), [[7, B]])
    // Another review is submitted: the list does not wait on GitHub for it.
    writeFileSync(join(repo, REVIEW_DIR, sheetName(8)), serializeSheet({ ...sent(), pr: 'acme/app#8' }))
    const second = await service.state()
    assert.deepEqual(second.items.map((item) => [item.number, item.head]).sort(), [[7, B], [8, A]], '#7 as last looked up, #8 as its sheet has it')
    assert.equal(lookups, 2, 'looked up behind the answer')
    release!()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual((await service.state()).items.map((item) => [item.number, item.head]).sort(), [[7, B], [8, B]])
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
