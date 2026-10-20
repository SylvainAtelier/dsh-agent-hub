import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockTime, localClock, remaining, zoneName } from '../src/client/automation/api.ts'

test('countdown rounds up to whole minutes and is due at or after the target', () => {
  const at = Date.parse('2026-10-19T02:05:00Z')
  assert.deepEqual(remaining(at, at - 30_000), { days: 0, hours: 0, minutes: 1 })
  assert.deepEqual(remaining(at, at - (3 * 60 + 12) * 60_000), { days: 0, hours: 3, minutes: 12 })
  assert.deepEqual(remaining(at, at - (26 * 60 + 1) * 60_000), { days: 1, hours: 2, minutes: 1 })
  assert.equal(remaining(at, at), undefined)
  assert.equal(remaining(at, at + 1), undefined)
  assert.equal(remaining(Number.NaN, at), undefined)
})

test('10:05 Beijing is shown on the Paris clock, across the daylight-saving change', () => {
  // Summer time (CEST, UTC+2): 10:05 CST = 04:05 Paris.
  const summer = localClock('2026-10-19T02:05:00Z', Date.parse('2026-10-18T20:00:00Z'), 'Europe/Paris')
  assert.deepEqual(summer, { day: 'tomorrow', date: '10/19', time: '04:05' })
  // Winter time (CET, UTC+1): the same 10:05 CST becomes 03:05 Paris; the native scheduler follows the zone, not a fixed offset.
  const winter = localClock('2026-10-26T02:05:00Z', Date.parse('2026-10-26T01:00:00Z'), 'Europe/Paris')
  assert.deepEqual(winter, { day: 'today', date: '10/26', time: '03:05' })
  assert.equal(localClock('2026-10-30T02:05:00Z', Date.parse('2026-10-26T01:00:00Z'), 'Europe/Paris')?.day, 'date')
  assert.equal(localClock('not a date', Date.now()), undefined)
})

test('native time strings and zone names are humanized', () => {
  assert.equal(clockTime('10:05:00.000'), '10:05')
  assert.equal(clockTime('9:30'), '9:30')
  assert.equal(clockTime('odd'), 'odd')
  assert.match(zoneName('Asia/Shanghai', 'en'), /China/)
  assert.equal(zoneName('Not/AZone', 'en'), 'Not/AZone')
})
