import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReviewSchedule, type ReviewTask } from '../src/review/schedule.ts'

test('empty repositories defer migration and execution, prompt edits do not lose task ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-native-safety-'))
  let hasRepos = false
  let auto = true
  let prepared = 0
  const tasks: ReviewTask[] = []
  const options = {
    file: join(dir, 'state.json'), settings: () => ({ auto }), repositories: async () => hasRepos,
    setAuto: async (value: boolean) => { auto = value }, start: async () => 'session', prepare: async () => { prepared++ },
    rename: async () => { throw new Error('Title service unavailable') },
    run: async () => ({ title: '看板审核 · Done', summary: 'Authoritative summary' }),
    schedule: () => ({
      catalog: async () => structuredClone(tasks),
      create: async (sessionId: string, input: { title: string; prompt: string; daily: { time: string; time_zone: string } }) => {
        tasks.push({ id: 'owned', sessionId, status: 'active', title: input.title, prompt: input.prompt,
          time: input.daily.time, timeZone: input.daily.time_zone, scheduledAt: '2026-10-20T07:00:00.000Z' })
        return { id: 'owned' }
      },
      delete: async () => { tasks.splice(0) }, update: async () => ({ updated: true }),
    }),
  }
  const service = new ReviewSchedule(options)
  try {
    assert.equal((await service.initialize()).enabled, false)
    assert.equal(tasks.length, 0)
    assert.match((await service.handle({ action: 'enable' })).error!, /repository/)
    hasRepos = true
    assert.equal((await service.initialize()).enabled, true)
    tasks[0].prompt = 'Edited through native schedule UI'
    tasks[0].time = '11:30:00.000'
    tasks[0].timeZone = 'UTC'
    const status = await service.handle({ action: 'status' })
    assert.equal(status.enabled, true)
    assert.equal(status.time, '11:30:00.000')
    await service.reconfigure()
    assert.ok(prepared >= 2)
    const signal = new AbortController().signal
    assert.equal(await service.execute('session', signal), 'Authoritative summary')
    assert.match((await service.handle({ action: 'status' })).error!, /title update failed/)
    hasRepos = false
    await assert.rejects(service.execute('session', signal), /No review repositories/)
    assert.equal((await service.handle({ action: 'disable' })).enabled, false)
    assert.equal(tasks.length, 0)
    hasRepos = true
    assert.equal((await service.handle({ action: 'enable' })).enabled, true)
    assert.equal(tasks[0].time, '11:30:00.000')
    assert.equal(tasks[0].timeZone, 'UTC')
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }) }
})
