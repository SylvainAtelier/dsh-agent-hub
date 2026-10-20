import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorKey, filterByAuthors, listAuthors } from '../src/git/authors.ts'
import { GitService, workspaceGate } from '../src/git/service.ts'
import type { AuthorList, Commit, GitLog, GitReply } from '../src/git/types.ts'

const commit = (hash: string, parents: string[], email: string, author = email.split('@')[0]!): Commit =>
  ({ hash, parents, author, email, at: 0, subject: hash })

test('authorKey: email case-insensitive, name without one', () => {
  assert.equal(authorKey('Me@X.io', 'Me'), 'me@x.io')
  assert.equal(authorKey('', ' Bot '), 'bot')
})

test('filterByAuthors: parents skip dropped commits to the nearest kept ones', () => {
  // m merges b (by other) into a line; a1 ← o1 ← a0, and b ← a0.
  const commits = [
    commit('m', ['o1', 'b'], 'me@x'),
    commit('b', ['a0'], 'other@x'),
    commit('o1', ['a1'], 'other@x'),
    commit('a1', ['o0'], 'me@x'),
    commit('o0', ['a0'], 'other@x'),
    commit('a0', ['gone'], 'me@x'),
  ]
  const kept = filterByAuthors(commits, new Set(['me@x']))
  assert.deepEqual(kept.map((c) => [c.hash, c.parents]), [['m', ['a1', 'a0']], ['a1', ['a0']], ['a0', []]])
  assert.deepEqual(filterByAuthors(commits, new Set(['nobody'])), [])
})

test('listAuthors: grouped by key, most commits first, newest name', () => {
  const list = listAuthors([commit('3', [], 'B@x', 'Bee'), commit('2', [], 'a@x'), commit('1', [], 'b@x', 'Old Bee')])
  assert.deepEqual(list.map((a) => [a.key, a.name, a.count]), [['b@x', 'Bee', 2], ['a@x', 'a', 1]])
})

const hasGit = (): boolean => { try { execFileSync('git', ['--version']); return true } catch { return false } }

test('service: author-filtered log pages through a connected history', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-authors-')))
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Me')
    git('config', 'user.email', 'me@example.com')
    git('config', 'commit.gpgsign', 'false')
    const by = (who: string, n: number): void => {
      writeFileSync(join(dir, 'f.txt'), `${who} ${n}\n`)
      git('add', 'f.txt')
      git('-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@example.com`, 'commit', '-q', '-m', `${who} ${n}`)
    }
    by('Me', 1)
    by('Other', 1)
    by('Me', 2)
    by('Other', 2)
    by('Me', 3)
    const service = new GitService(workspaceGate(() => [dir]))
    const call = async <T>(payload: Record<string, unknown>): Promise<T> => {
      const reply = await service.handle({ cwd: dir, ...payload }) as GitReply<T>
      if (!reply.ok) throw new Error(`${String(payload.op)}: ${reply.error.message}`)
      return reply.value
    }
    const list = await call<AuthorList>({ op: 'authors' })
    assert.equal(list.me, 'me@example.com')
    assert.deepEqual(list.authors.map((a) => [a.key, a.count]), [['me@example.com', 3], ['other@example.com', 2]])

    const mine = await call<GitLog>({ op: 'log', authors: ['me@example.com'] })
    assert.deepEqual(mine.commits.map((c) => c.subject), ['Me 3', 'Me 2', 'Me 1'])
    assert.deepEqual(mine.commits.map((c) => c.parents), [[mine.commits[1]!.hash], [mine.commits[2]!.hash], []])
    assert.equal(mine.more, false)
    assert.ok(mine.head)

    const page = await call<GitLog>({ op: 'log', authors: ['me@example.com'], skip: 1, limit: 1 })
    assert.deepEqual(page.commits.map((c) => c.subject), ['Me 2'])
    assert.equal(page.more, true)

    // A new commit moves HEAD, so the history is read again.
    by('Other', 3)
    assert.deepEqual((await call<GitLog>({ op: 'log', authors: ['other@example.com'] })).commits.map((c) => c.subject), ['Other 3', 'Other 2', 'Other 1'])

    const bad = await service.handle({ cwd: dir, op: 'log', authors: [] })
    assert.equal(bad.ok, false)
    service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
