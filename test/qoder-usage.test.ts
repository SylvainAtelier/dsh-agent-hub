import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interactive, lastSnapshot, qoderReader, quotaOf } from '../src/usage/sources/qoder.ts'

// As qoderclicn 1.1.73 logs it.
const BODY = {
  userId: 'u1', userType: 'personal_standard', usageType: 'credits', totalUsagePercentage: 0.05, isQuotaExceeded: false,
  expiresAt: 253402214400000, upgradeUrl: 'https://qoder.com.cn/pricing?client=qoder', outerProviders: [],
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
  addOnQuota: { total: 1800, used: 84, remaining: 1716, percentage: 0.05, unit: 'credits', detailUrl: 'https://qoder.com.cn/account/usage' },
  isPlanQuotaProrated: false,
}
const line = (at: string, body: unknown): string =>
  `${at} INFO  debug.message [qoderApi] GET https://openapi.qoder.com.cn/api/v2/quota/usage response: ${JSON.stringify(body)}\n`

test('qoder usage: only the interactive TUI fetches the quota', () => {
  assert.equal(interactive([]), true)
  assert.equal(interactive(['-m', 'auto', 'fix the bug']), true)
  assert.equal(interactive(['--acp']), false)
  assert.equal(interactive(['-p', 'hi']), false)
  assert.equal(interactive(['status', '-o', 'json']), false)
  assert.equal(interactive(['remote-control']), false)
})

test('qoder usage: empty pools are dropped, the "never" expiry ignored, the plan named', () => {
  const quota = quotaOf(BODY, 1000)
  assert.deepEqual(quota.windows, [{ key: 'addon', usedPercent: (84 / 1800) * 100, used: 84, limit: 1800, unit: 'credits' }])
  assert.equal(quota.plan, 'standard')
  assert.equal(quota.expiresAt, undefined)
  assert.equal(quota.snapshot, true)
  assert.equal(quota.fetchedAt, 1000)
  assert.equal(quota.error, undefined)
})

test('qoder usage: plan, shared and dedicated pools each become a window', () => {
  const quota = quotaOf({
    userType: 'personal_pro', expiresAt: 2_000_000,
    userQuota: { total: 2000, used: 500 },
    orgResourcePackage: { cap: 100, used: 10, available: true },
    dedicatedResourcePackages: [{ id: 'd', name: 'Launch pack', total: 50, remaining: 20, expiresAt: 3_000_000, available: true }],
  }, 1000)
  assert.deepEqual(quota.windows.map((w) => [w.key, w.label, w.used, w.limit, w.resetsAt]), [
    ['plan', undefined, 500, 2000, undefined], ['shared', undefined, 10, 100, undefined], ['custom', 'Launch pack', 30, 50, 3_000_000],
  ])
  assert.equal(quota.expiresAt, 2_000_000)
})

test('qoder usage: the last complete response line wins', () => {
  const chunk = Buffer.from(line('2026-10-17T08:00:00.000+02:00', { ...BODY, addOnQuota: { total: 1800, used: 1 } })
    + line('2026-10-17T09:00:00.000+02:00', BODY) + '2026-10-17T09:00:01.000+02:00 INFO other\n')
  const hit = lastSnapshot(chunk)!
  assert.equal(hit.at, Date.parse('2026-10-17T09:00:00.000+02:00'))
  assert.deepEqual(hit.body, BODY)
  assert.equal(lastSnapshot(Buffer.from('nothing here\n')), undefined)
})

test('qoder usage: the reader follows appended lines and skips non-interactive runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qoder-runs-'))
  const run = async (name: string, argv: string[], log: string): Promise<string> => {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'manifest.json'), JSON.stringify({ argv: ['bun', 'B:/~BUN/root/qoderclicn', ...argv] }))
    await writeFile(join(root, name, 'qodercli.log'), log)
    return join(root, name, 'qodercli.log')
  }
  const read = qoderReader({ root, installed: () => true })
  assert.equal((await read())[0]!.error?.code, 'no-data')
  const tui = await run('a', [], line('2026-10-17T08:00:00.000+02:00', BODY))
  await run('b', ['--acp'], line('2026-10-17T10:00:00.000+02:00', { ...BODY, addOnQuota: { total: 1800, used: 900 } }))
  let [quota] = await read()
  assert.equal(quota!.windows[0]!.used, 84)
  // A half-written line waits for its end.
  const later = line('2026-10-17T11:00:00.000+02:00', { ...BODY, addOnQuota: { total: 1800, used: 200 } })
  await appendFile(tui, later.slice(0, 40))
  ;[quota] = await read()
  assert.equal(quota!.windows[0]!.used, 84)
  await appendFile(tui, later.slice(40))
  ;[quota] = await read()
  assert.equal(quota!.windows[0]!.used, 200)
  assert.equal(quota!.fetchedAt, Date.parse('2026-10-17T11:00:00.000+02:00'))
})

test('qoder usage: nothing at all without the CLI', async () => {
  assert.deepEqual(await qoderReader({ root: join(tmpdir(), 'qoder-missing-runs'), installed: () => false })(), [])
})
