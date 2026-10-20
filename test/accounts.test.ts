import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ClaudeAccounts } from '../src/claude/accounts.ts'
import { setLocaleSource } from '../src/locale.ts'
import { claudeEnv } from '../src/claude/cli.ts'
import { pendingInput, type HarnessMessage } from '../src/claude/translate.ts'

const reply = (session: string, account?: string): HarnessMessage => ({
  role: 'assistant', content: [{ type: 'text', text: `reply from ${account ?? 'default'}` }],
  source: { provider: 'claude-agent', replayState: { claude: { session, ...(account ? { account } : {}) } } },
})
const question = (text: string): HarnessMessage => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

test('accounts: isolate generated config directories; preserve default and never delete CLI data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-accounts-'))
  try {
    const file = join(root, 'accounts.json')
    const store = new ClaudeAccounts(file)
    await store.ready
    const added = await store.add('工作')
    const id = added.accounts[1].id
    assert.equal(store.dir('default'), undefined)
    assert.equal(store.dir(id), join(root, 'claude-accounts', id))
    assert.match(added.accounts[1].loginCommand!, /CLAUDE_CONFIG_DIR/)
    assert.equal(added.active, 'default')
    await store.select(id)
    const restored = new ClaudeAccounts(file)
    await restored.ready
    assert.equal(restored.selected, id)
    await store.remove(id)
    assert.equal(store.selected, 'default')
    assert.rejects(store.select(id))
    assert.equal((await readFile(file, 'utf8')).includes('工作'), false)
    assert.equal(claudeEnv(store.dir('default')).CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('accounts: rename display names without touching ids or directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-accounts-'))
  try {
    const file = join(root, 'accounts.json')
    const store = new ClaudeAccounts(file)
    await store.ready
    const id = (await store.add('工作')).accounts[1].id
    const renamed = await store.rename(id, '  个人  ')
    assert.equal(renamed.accounts[1].name, '个人')
    assert.equal(store.dir(id), join(root, 'claude-accounts', id))
    assert.equal((await store.rename('default', '公司')).accounts[0].renamed, true)
    await assert.rejects(store.rename(id, '公司'), /already exists/)
    await assert.rejects(store.rename(id, ''), /1–64/)
    const restored = new ClaudeAccounts(file)
    await restored.ready
    assert.deepEqual(restored.list().accounts.map((item) => item.name), ['公司', '个人'])
    const zh = setLocaleSource(() => 'zh-CN')
    const reset = await restored.rename('default', '')
    zh()
    assert.equal(reset.accounts[0].name, '默认账号')
    assert.equal(reset.accounts[0].renamed, undefined)
    const en = setLocaleSource(() => 'en')
    assert.equal(restored.list().accounts[0].name, 'Default account', 'named in the UI language')
    en()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('accounts: resume only same-account transcript and supply intervening conversation as context', () => {
  const history = [question('one'), reply('session-a'), question('two'), reply('session-b', 'work'), question('three')]
  const work = pendingInput(history, 'claude-agent', 'work')
  assert.equal(work.resume, 'session-b')
  assert.equal(work.prompt, 'three')
  const original = pendingInput(history, 'claude-agent', 'default')
  assert.equal(original.resume, 'session-a')
  assert.match(original.prompt, /reply from work/)
  const neverUsed = pendingInput(history, 'claude-agent', 'personal')
  assert.equal(neverUsed.resume, undefined)
  assert.match(neverUsed.prompt, /reply from default/)
  assert.match(neverUsed.prompt, /reply from work/)
})
