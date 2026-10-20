import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { ConnectorScope, connectorOfTool, serves, withoutHidden, type RepoLookup } from '../src/connectors/scope.ts'
import { RepoIndex } from '../src/repos/index.ts'
import type { ConnectorEntry } from '../src/connectors/types.ts'
import type { Runner } from '../src/git/service.ts'

const app = resolve('/work/app')
const other = resolve('/work/other')
const tree = resolve('/work/app.wt/feat')

test('connector scope: tool names map to their connector', () => {
  assert.equal(connectorOfTool('mcp__linear__list_issues'), 'linear')
  assert.equal(connectorOfTool('mcp__linear-2__get_issue'), 'linear-2')
  assert.equal(connectorOfTool('mcp__linear__'), undefined)
  assert.equal(connectorOfTool('bash'), undefined)
  assert.equal(connectorOfTool('mcp__Bad__x'), undefined)
})

test('connector scope: a linked connector serves its repository and its worktrees only', () => {
  const linked = { repos: [app] }
  assert.ok(serves({}, undefined, undefined))
  assert.ok(serves({ repos: [] }, tree, app))
  assert.ok(serves(linked, tree, app))
  assert.ok(serves(linked, join(app, 'src'), app))
  assert.ok(!serves(linked, other, other))
  assert.ok(!serves(linked, undefined, undefined))
  assert.ok(!serves(linked, '', undefined))
  // A repository nested under a linked one is its own repository.
  assert.ok(!serves(linked, join(app, 'vendor', 'lib'), join(app, 'vendor', 'lib')))
  // Git did not answer: a folder under the linked path still counts, another does not.
  assert.ok(serves(linked, join(app, 'src'), undefined))
  assert.ok(!serves(linked, tree, undefined))
})

test('connector scope: hidden connectors leave the assembly, the rest stays in order', () => {
  const assembly = { sections: [], tools: [{ name: 'read' }, { name: 'mcp__linear__list_issues' }, { name: 'mcp__notion__search' }, { name: 'mcp__linear-2__x' }] }
  assert.equal(withoutHidden(assembly, new Set()), assembly)
  assert.equal(withoutHidden(assembly, new Set(['sentry'])), assembly)
  assert.deepEqual(withoutHidden(assembly, new Set(['linear'])).tools.map((tool) => tool.name), ['read', 'mcp__notion__search', 'mcp__linear-2__x'])
})

test('connector scope: sessions see unlinked connectors and those linked to their repository', async () => {
  let entries: ConnectorEntry[] = [
    { id: 'notion', url: 'https://mcp.notion.com/mcp' },
    { id: 'linear', url: 'https://mcp.linear.app/mcp', repos: [app] },
    { id: 'linear-2', url: 'https://mcp.linear.app/mcp', repos: [other] },
  ]
  const known = new Map<string, string | undefined>()
  let lookups = 0
  const repos: RepoLookup = {
    async repoOf(dir) {
      lookups++
      const repo = dir.startsWith(other) ? other : dir.startsWith(resolve('/work/app')) ? app : undefined
      known.set(dir, repo)
      return repo
    },
    known: (dir) => (known.has(dir) ? { repo: known.get(dir) } : undefined),
  }
  const scope = new ConnectorScope(() => entries, repos)
  assert.deepEqual([...await scope.hidden(tree)], ['linear-2'])
  assert.deepEqual([...await scope.hidden(other)], ['linear'])
  assert.deepEqual([...await scope.hidden(undefined)].sort(), ['linear', 'linear-2'])
  assert.deepEqual([...await scope.hidden(resolve('/elsewhere'))].sort(), ['linear', 'linear-2'])
  // Synchronous checks: an unknown folder hides every linked connector until git answers.
  assert.deepEqual([...scope.hiddenNow(resolve('/fresh'))].sort(), ['linear', 'linear-2'])
  assert.deepEqual([...scope.hiddenNow(tree)], ['linear-2'])
  // Nothing linked: no lookup at all.
  entries = entries.map(({ repos: _repos, ...entry }) => entry)
  const before = lookups
  assert.equal((await scope.hidden(resolve('/anything'))).size, 0)
  assert.equal(scope.hiddenNow(undefined).size, 0)
  assert.equal(lookups, before)
})

test('repos: a folder\'s repository is known synchronously once git answered, and stays known while re-read', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const run: Runner = async () => {
    calls++
    if (calls > 1) await new Promise<void>((done) => { release = done })
    return { code: 0, stdout: `${join(app, '.git')}\n${join(app, '.git', 'worktrees', 'feat')}\n`, stderr: '' } as Awaited<ReturnType<Runner>>
  }
  const index = new RepoIndex(() => undefined, run)
  assert.equal(index.known(tree), undefined)
  await index.repoOf(tree)
  assert.deepEqual(index.known(tree), { repo: app })
  assert.equal(calls, 1)
  // Expire the entry: the next read starts a lookup and still answers with the last result.
  const entry = (index as unknown as { found: Map<string, { at: number }> }).found.values().next().value!
  entry.at = 0
  assert.deepEqual(index.known(tree), { repo: app })
  assert.equal(calls, 2)
  assert.deepEqual(index.known(tree), { repo: app })
  assert.equal(calls, 2)
  release?.()
})
