import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseResetText, parseUsageText } from '../src/usage/sources/claude.ts'
import { parseCodexUsage, parseVault } from '../src/usage/sources/codex.ts'
import { parseRemains, subscriptionExpiry } from '../src/usage/sources/minimax.ts'
import { mergeWithLast } from '../src/usage/hub.ts'
import type { PlanQuota } from '../src/usage/types.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// 2026-10-02 23:00 local
const NOW = new Date(2026, 9, 2, 23, 0).getTime()

test('claude: parses the /usage text the CLI prints', () => {
  const text = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 5% used · resets Oct 3, 3:29am (Europe/Budapest)',
    'Current week (all models): 38% used · resets Oct 3, 11:59am (Europe/Budapest)',
    'Current week (Sonnet only): 12% used · resets Oct 9, 1pm (Europe/Budapest)',
    '',
    'Last 7d · 1592 requests · 35 sessions',
  ].join('\n')
  const windows = parseUsageText(text, NOW)
  assert.equal(windows.length, 3)
  assert.deepEqual(windows[0], { key: '5h', usedPercent: 5, resetsAt: new Date(2026, 9, 3, 3, 29).getTime(), windowMs: 5 * HOUR })
  assert.equal(windows[1].key, 'week')
  assert.equal(windows[1].group, undefined)
  assert.equal(windows[1].resetsAt, new Date(2026, 9, 3, 11, 59).getTime())
  assert.equal(windows[2].group, 'Sonnet')
  assert.equal(windows[2].resetsAt, new Date(2026, 9, 9, 13, 0).getTime())
})

test('claude: reset text without a date rolls forward, past month/day rolls a year', () => {
  assert.equal(parseResetText('10:30pm', NOW), new Date(2026, 9, 3, 22, 30).getTime() - DAY)
  assert.equal(parseResetText('9am', NOW), new Date(2026, 9, 3, 9, 0).getTime())
  assert.equal(parseResetText('Jan 2, 9am (UTC)', NOW), new Date(2027, 0, 2, 9, 0).getTime())
  assert.equal(parseResetText('soon', NOW), undefined)
})

test('claude: newer "Oct 11 at 9:59pm" reset text keeps its time', () => {
  // Before the fix the time was dropped: midnight already passed, so it rolled a year ahead.
  const now = new Date(2026, 9, 11, 20, 6).getTime()
  const windows = parseUsageText([
    'Current session: 55% used · resets Oct 11 at 9:59pm (Europe/Paris)',
    'Current week (all models): 34% used · resets Oct 14 at 2:59pm (Europe/Paris)',
  ].join('\n'), now)
  assert.equal(windows[0].resetsAt, new Date(2026, 9, 11, 21, 59).getTime())
  assert.equal(windows[1].resetsAt, new Date(2026, 9, 14, 14, 59).getTime())
  assert.equal(parseResetText('Oct 14 at 14:59', now), new Date(2026, 9, 14, 14, 59).getTime())
  assert.equal(parseResetText('21:59', now), new Date(2026, 9, 11, 21, 59).getTime())
})

test('claude: unknown text yields no windows', () => {
  assert.deepEqual(parseUsageText('/usage is only available for subscription plans.', NOW), [])
})

test('codex: main, extra and code-review limits plus credits', () => {
  const parsed = parseCodexUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 1791000000 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1791500000 },
    },
    additional_rate_limits: [{ metered_feature: 'spark', limit_name: 'GPT-Spark', rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: 0 } } }],
    credits: { has_credits: true, unlimited: false, balance: '12.50' },
  })
  assert.equal(parsed.plan, 'plus')
  assert.equal(parsed.credits, '12.50')
  assert.deepEqual(parsed.windows.map((w) => [w.key, w.group, w.usedPercent]), [['5h', undefined, 28], ['week', undefined, 12], ['5h', 'GPT-Spark', 50]])
  assert.equal(parsed.windows[0].resetsAt, 1791000000 * 1000)
  assert.equal(parsed.windows[2].resetsAt, undefined)
})

test('codex: vault shape guard', () => {
  const account = { id: 'a', label: 'Work', credential: { access: 'x', expires: 1, accountId: 'acc' } }
  assert.deepEqual(parseVault({ kind: 'grant', payload: { version: 1, activeId: 'a', accounts: [account] } }), { activeId: 'a', accounts: [account] })
  assert.equal(parseVault({ kind: 'grant', payload: { version: 2, activeId: 'a', accounts: [account] } }), undefined)
  assert.equal(parseVault({ kind: 'api-key' }), undefined)
})

test('minimax: usage_count is the remaining count; weekly window when active', () => {
  const end = NOW + 2 * HOUR
  const parsed = parseRemains({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      start_time: end - 5 * HOUR,
      end_time: end,
      current_interval_total_count: 1500,
      current_interval_usage_count: 1398,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 80,
      weekly_end_time: NOW + 3 * DAY,
      remains_time: 20 * 86400,
    }],
  }, NOW)
  assert.equal(parsed.windows.length, 2)
  assert.deepEqual(parsed.windows[0], { key: '5h', usedPercent: (102 / 1500) * 100, resetsAt: end, windowMs: 5 * HOUR, used: 102, limit: 1500 })
  assert.equal(parsed.windows[1].key, 'week')
  assert.equal(parsed.windows[1].usedPercent, 20)
  assert.equal(parsed.expiresAt, NOW + 20 * DAY)
})

test('minimax: provider errors surface their message', () => {
  assert.throws(() => parseRemains({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }, NOW), /invalid api key/)
})

test('minimax: subscription expiry unit inference', () => {
  assert.equal(subscriptionExpiry(30 * 86400, undefined, NOW), NOW + 30 * DAY) // seconds
  assert.equal(subscriptionExpiry(30 * DAY, undefined, NOW), NOW + 30 * DAY) // milliseconds
  assert.equal(subscriptionExpiry(2 * HOUR, NOW + 2 * HOUR, NOW), undefined) // restates the 5h window
  assert.equal(subscriptionExpiry(undefined, undefined, NOW), undefined)
})

test('hub: a failed read falls back to the last good snapshot, pruned to live ids', () => {
  const good: PlanQuota = { id: 'codex:b', provider: 'codex', windows: [{ key: '5h', usedPercent: 10 }], fetchedAt: 1 }
  const gone: PlanQuota = { id: 'codex:old', provider: 'codex', windows: [], fetchedAt: 1 }
  const last = new Map([[good.id, good], [gone.id, gone]])
  const { quotas, last: next } = mergeWithLast([
    { id: 'codex:b', provider: 'codex', active: false, windows: [], fetchedAt: 0, error: { code: 'expired' } },
    { id: 'claude', provider: 'claude', windows: [{ key: 'week', usedPercent: 5 }], fetchedAt: 2 },
  ], last)
  assert.equal(quotas[0].stale, true)
  assert.equal(quotas[0].windows[0].usedPercent, 10)
  assert.equal(quotas[0].error?.code, 'expired')
  assert.deepEqual([...next.keys()].sort(), ['claude', 'codex:b'])
})

test('hub: polls past the TTL get the previous read while the source revalidates', async () => {
  const { createHub } = await import('../src/usage/hub.ts')
  let calls = 0
  let release: (() => void) | undefined
  const quota = (n: number): PlanQuota[] => [{ id: 'claude', provider: 'claude', windows: [{ key: '5h', usedPercent: n }], fetchedAt: n }]
  const hub = createHub({
    claude: () => {
      calls += 1
      const n = calls
      return n === 1 ? Promise.resolve(quota(n)) : new Promise((resolve) => { release = () => resolve(quota(n)) })
    },
    codex: async () => [],
    minimax: async () => [],
  })
  const realNow = Date.now
  try {
    assert.equal((await hub.overview()).quotas[0].fetchedAt, 1)
    Date.now = () => realNow() + 10 * 60_000 // past every TTL
    assert.equal((await hub.overview()).quotas[0].fetchedAt, 1) // served stale, revalidating
    assert.equal((await hub.overview()).quotas[0].fetchedAt, 1) // still in flight: no wait
    assert.equal(calls, 2)
    release?.()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await hub.overview()).quotas[0].fetchedAt, 2)
  } finally {
    Date.now = realNow
  }
})

test('hub: Claude is read rarely while idle, and soon after a turn touches it', async () => {
  const { createHub } = await import('../src/usage/hub.ts')
  let calls = 0
  const hub = createHub({
    claude: async () => [{ id: 'claude', provider: 'claude', windows: [], fetchedAt: ++calls }],
    codex: async () => [],
    minimax: async () => [],
  })
  const realNow = Date.now
  const start = realNow()
  try {
    await hub.overview()
    Date.now = () => start + 2 * 60_000
    await hub.overview()
    assert.equal(calls, 1, 'two idle minutes are within the Claude TTL')
    hub.touch('claude')
    await hub.overview()
    assert.equal(calls, 2, 'a touched source older than a minute revalidates')
    Date.now = () => start + 2 * 60_000 + 30_000
    hub.touch('claude')
    await hub.overview()
    assert.equal(calls, 2, 'but not one read moments ago')
  } finally {
    Date.now = realNow
  }
})
