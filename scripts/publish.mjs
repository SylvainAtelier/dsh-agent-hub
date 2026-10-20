// Publish a snapshot of a private development branch to the public repository as one commit.
//
//   node scripts/publish.mjs [-m "message"] [--dry-run]
//
// The public history is a line of snapshots: each run commits the branch's current tree on top
// of the public branch, authored as the public identity at the moment of publishing, and pushes
// it. Nothing of the private history (commits, authors, times, messages) travels along.
//
// Settings live in this clone's .git, never in the repository:
//   git config publish.name   "Your Name"                    (required)
//   git config publish.email  "you@users.noreply.github.com" (required)
//   git config publish.remote public                         (default: public)
//   git config publish.branch main                           (private branch to publish; default: main)
//   .git/publish-deny         one extended regex per line, matched case-insensitively against every
//                             tracked file: any hit stops the publish (company names, hosts, ids…)
//
// refs/published/<branch> records the private commit last published, so `git diff
// refs/published/main main` shows what the next publish brings.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const messageAt = args.findIndex((arg) => arg === '-m' || arg === '--message')
const message = messageAt === -1 ? undefined : args[messageAt + 1]

const git = (gitArgs, options = {}) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options })?.trim() ?? ''
const tryGit = (gitArgs) => { try { return git(gitArgs) } catch { return '' } }
const fail = (text) => { console.error(`publish: ${text}`); process.exit(1) }

const name = tryGit(['config', 'publish.name'])
const email = tryGit(['config', 'publish.email'])
if (name === '' || email === '') fail('set the public identity first: git config publish.name "…" && git config publish.email "…"')
const remote = tryGit(['config', 'publish.remote']) || 'public'
const branch = tryGit(['config', 'publish.branch']) || 'main'
if (tryGit(['remote', 'get-url', remote]) === '') fail(`no remote "${remote}": git remote add ${remote} git@github.com:<you>/<repo>.git`)

const source = git(['rev-parse', '--verify', `${branch}^{commit}`])
const tree = git(['rev-parse', `${source}^{tree}`])
// An empty public repository (the first publish) has no main yet.
const published = git(['ls-remote', '--heads', remote, 'main']) !== ''
if (published) git(['fetch', '--quiet', remote, `+refs/heads/main:refs/remotes/${remote}/main`], { stdio: ['pipe', 'pipe', 'inherit'] })
const parent = published ? git(['rev-parse', '--verify', `refs/remotes/${remote}/main^{commit}`]) : ''
if (parent !== '' && git(['rev-parse', `${parent}^{tree}`]) === tree) {
  console.log(`publish: ${remote}/main already has ${branch}'s tree; nothing to publish`)
  process.exit(0)
}

// Anything that must never be public: patterns kept outside the repository, so they are not published themselves.
const denyFile = join(git(['rev-parse', '--git-common-dir']), 'publish-deny')
const deny = existsSync(denyFile) ? readFileSync(denyFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')) : []
if (deny.length === 0) console.warn(`publish: no deny patterns in ${denyFile}; nothing is checked`)
else {
  const hits = tryGit(['grep', '-I', '-n', '-i', '-E', ...deny.flatMap((pattern) => ['-e', pattern]), tree])
  if (hits !== '') fail(`these lines match .git/publish-deny; fix them on ${branch} first:\n${hits.split('\n').slice(0, 40).join('\n')}`)
}

const version = JSON.parse(git(['show', `${source}:package.json`])).version
const subject = message ?? `dsh-agent-hub ${version}`
const changed = parent === '' ? 'first publish' : tryGit(['diff', '--shortstat', parent, tree])
console.log(`publish: ${branch} (${source.slice(0, 7)}) → ${remote}/main as "${subject}", by ${name} <${email}>; ${changed}`)
if (dryRun) process.exit(0)

// Dated now, as git does by itself: the moment of publishing, not of any private commit.
const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
const commit = git(['commit-tree', tree, ...(parent === '' ? [] : ['-p', parent]), '-m', subject], { env })
git(['push', remote, `${commit}:refs/heads/main`], { stdio: ['pipe', 'inherit', 'inherit'] })
git(['update-ref', `refs/published/${branch}`, source])
git(['update-ref', `refs/remotes/${remote}/main`, commit])
console.log(`publish: done, ${remote}/main is ${commit.slice(0, 7)}`)
