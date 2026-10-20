import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bound, identitiesValid, identityOf, parseIdentity, remoteOwner } from '../src/git/identity.ts'
import { applyStrict, isMainGlobal, readStash } from '../src/git/strict.ts'
import { GitService, runGit, workspaceGate } from '../src/git/service.ts'
import type { GitReply, GitStatus } from '../src/git/types.ts'
import type { IdentityList } from '../src/git/identity.ts'

// Every git this file runs (the service's too) reads this global config, never the user's.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-ident-')))
const globalFile = join(home, 'gitconfig')
writeFileSync(globalFile, '')
process.env.GIT_CONFIG_GLOBAL = globalFile
process.env.GIT_CONFIG_NOSYSTEM = '1'
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key]
test.after(() => rmSync(home, { recursive: true, force: true }))

const hasGit = (): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const record = (scope: string, origin: string, key: string, value: string): string => `${scope}\0${origin}\0${key}\n${value}\0`

test('identity: source is the weaker of name and email; env outranks files', () => {
  const main = (origin: string): boolean => origin === 'file:/home/me/.gitconfig'
  const raw = record('global', 'file:/home/me/.gitconfig', 'user.name', 'Me') + record('global', 'file:/home/me/.gitconfig', 'user.email', 'me@home')
    + record('local', 'file:.git/config', 'user.email', 'me@work')
  // Name inherited, email bound: still inherited.
  assert.deepEqual(parseIdentity(raw, {}, main), { name: 'Me', email: 'me@work', source: 'global' })
  const work = raw + record('local', 'file:.git/config', 'user.name', 'Work Me')
  assert.deepEqual(parseIdentity(work, {}, main), { name: 'Work Me', email: 'me@work', source: 'local' })
  const included = record('global', 'file:/home/me/work.inc', 'user.name', 'W') + record('global', 'file:/home/me/work.inc', 'user.email', 'w@x')
  assert.equal(parseIdentity(included, {}, main)?.source, 'include')
  assert.deepEqual(parseIdentity(work, { GIT_AUTHOR_EMAIL: 'bot@ci' }, main), { name: 'Work Me', email: 'bot@ci', source: 'env' })
  assert.equal(parseIdentity(record('local', 'file:.git/config', 'user.email', 'x@y'), {}, main), undefined)
  assert.equal(parseIdentity('', {}, main), undefined)
  assert.equal(bound({ name: 'a', email: 'b', source: 'include' }), true)
  assert.equal(bound({ name: 'a', email: 'b', source: 'global' }), false)
})

test('identity: validation, presets and remote owners', () => {
  assert.deepEqual(identityOf({ name: ' A ', email: 'a@b.c', signingKey: ' ' }), { name: 'A', email: 'a@b.c' })
  assert.equal(identityOf({ name: 'A <x>', email: 'a@b.c' }), undefined)
  assert.equal(identityOf({ name: 'A', email: 'not-an-email' }), undefined)
  assert.equal(identitiesValid([{ name: 'A', email: 'a@b.c' }, { name: 'B', email: 'A@B.C' }]), false)
  assert.equal(identitiesValid([{ name: 'A', email: 'a@b.c' }, { name: 'B', email: 'b@b.c', signingKey: 'ABC' }]), true)
  assert.equal(remoteOwner('git@github.com:Acme/app.git'), 'github.com/acme')
  assert.equal(remoteOwner('https://user@github.com/acme/app.git'), 'github.com/acme')
  assert.equal(remoteOwner('ssh://git@host:2222/team/app.git'), 'host/team')
  assert.equal(remoteOwner('/srv/git/app.git'), undefined)
  assert.equal(isMainGlobal(`file:${globalFile}`), true)
  assert.equal(isMainGlobal(`file:${join(home, 'other')}`), false)
})

test('strict: sets the global identity aside and puts it back', { skip: !hasGit() }, async () => {
  const g = (...args: string[]): string => execFileSync('git', ['config', '--global', ...args], { encoding: 'utf8' }).trim()
  const has = (key: string): boolean => {
    try {
      g('--get', key)
      return true
    } catch {
      return false
    }
  }
  g('user.name', 'Home')
  g('user.email', 'home@me')
  g('user.signingkey', 'KEY1')
  await applyStrict(runGit, true)
  assert.equal(has('user.name') || has('user.email') || has('user.signingkey'), false)
  assert.equal(g('--get', 'user.useConfigOnly'), 'true')
  assert.deepEqual(await readStash(runGit), { name: 'Home', email: 'home@me', signingKey: 'KEY1' })
  // Applying again changes nothing.
  await applyStrict(runGit, true)
  assert.deepEqual(await readStash(runGit), { name: 'Home', email: 'home@me', signingKey: 'KEY1' })
  await applyStrict(runGit, false)
  assert.equal(g('--get', 'user.email'), 'home@me')
  assert.equal(g('--get', 'user.signingkey'), 'KEY1')
  assert.equal(has('user.useConfigOnly') || has('agent-hub.email'), false)
  // A useConfigOnly of the user's own survives turning strict off.
  g('user.useConfigOnly', 'true')
  await applyStrict(runGit, true)
  await applyStrict(runGit, false)
  assert.equal(g('--get', 'user.useConfigOnly'), 'true')
  g('--unset', 'user.useConfigOnly')
})

test('service: strict mode, binding, and commits refused under another identity', { skip: !hasGit() }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-ident-repo-')))
  try {
    writeFileSync(globalFile, '')
    execFileSync('git', ['config', '--global', 'user.name', 'Home'])
    execFileSync('git', ['config', '--global', 'user.email', 'home@me'])
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'commit.gpgsign', 'false')
    git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
    let strict = true
    const service = new GitService(workspaceGate(() => [dir]), undefined, undefined, {
      watch: false,
      strict: () => strict,
      identities: () => [{ name: 'Work', email: 'work@acme.io' }],
    })
    const call = async <T>(payload: Record<string, unknown>): Promise<GitReply<T>> => await service.handle({ cwd: dir, ...payload }) as GitReply<T>
    const value = async <T>(payload: Record<string, unknown>): Promise<T> => {
      const reply = await call<T>(payload)
      if (!reply.ok) throw new Error(`${String(payload.op)}: ${reply.error.message}`)
      return reply.value
    }

    // Strict: no identity anywhere, so git itself refuses (a terminal would too).
    let status = await value<GitStatus>({ op: 'status' })
    assert.equal(status.identity, undefined)
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const refused = await call({ op: 'commit', message: 'one', all: true })
    assert.equal(refused.ok, false)
    assert.throws(() => git('commit', '-qm', 'x'))
    git('rm', '-q', '--cached', 'a.txt')

    const list = await value<IdentityList>({ op: 'identities' })
    assert.deepEqual(list.presets, [{ name: 'Work', email: 'work@acme.io' }])
    assert.deepEqual(list.stashed, { name: 'Home', email: 'home@me' })

    await value({ op: 'identity-set', identity: { name: 'Work', email: 'work@acme.io', signingKey: 'K2' } })
    status = await value<GitStatus>({ op: 'status' })
    assert.deepEqual(status.identity, { name: 'Work', email: 'work@acme.io', source: 'local' })
    // A different identity than the pane showed: refused before anything is staged.
    const wrong = await call({ op: 'commit', message: 'one', all: true, as: 'home@me' })
    assert.equal(!wrong.ok && wrong.error.code, 'identity')
    assert.equal(git('status', '--porcelain'), '?? a.txt')
    // Rebinding without a key drops the old key instead of inheriting it.
    await value({ op: 'identity-set', identity: { name: 'Work', email: 'work@acme.io' } })
    assert.throws(() => git('config', '--local', '--get', 'user.signingkey'))
    await value({ op: 'commit', message: 'one', all: true, as: 'work@acme.io' })
    assert.equal(git('log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'Work <work@acme.io> / Work <work@acme.io>')

    // Amend keeps the original author unless asked to reset it.
    await value({ op: 'identity-set', identity: { name: 'Other', email: 'other@acme.io' } })
    await value({ op: 'commit', message: 'one, amended', amend: true, as: 'other@acme.io' })
    assert.equal(git('log', '-1', '--format=%ae %ce'), 'work@acme.io other@acme.io')
    await value({ op: 'commit', message: 'one, again', amend: true, as: 'other@acme.io', resetAuthor: true })
    assert.equal(git('log', '-1', '--format=%ae %ce'), 'other@acme.io other@acme.io')

    // Unbinding falls back to nothing (strict); turning strict off brings the global identity back.
    await value({ op: 'identity-set' })
    status = await value<GitStatus>({ op: 'status' })
    assert.equal(status.identity, undefined)
    strict = false
    status = await value<GitStatus>({ op: 'status' })
    assert.deepEqual(status.identity, { name: 'Home', email: 'home@me', source: 'global' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
