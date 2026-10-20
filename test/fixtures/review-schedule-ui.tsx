/** Offline settings fixture: only an in-memory native-task RPC, never a real model. */
import { createRoot } from 'react-dom/client'
import { ReviewScheduleField } from '../../src/client/config/review.tsx'
import { ReviewScheduleStore, type ScheduleStatus } from '../../src/client/review/schedule.ts'
import { injectConfigStyle } from '../../src/client/config/style.ts'
import { injectBaseStyle } from '../../src/client/theme/base.ts'

const calls: string[] = []
const opened: string[][] = []
let fail = false
let status: ScheduleStatus = { enabled: false }
const store = new ReviewScheduleStore({ async call(_channel, _method, payload) {
  const action = (payload as { action: string }).action
  calls.push(action)
  await new Promise((resolve) => setTimeout(resolve, 80))
  if (fail) throw new Error('Offline host unavailable')
  if (action === 'enable') status = {
    enabled: true, taskId: 'native-task', sessionId: 'native-session',
    title: '审核同步完成：3 个 PR 已分析，1 个失败待重试',
    time: '09:00:00', timeZone: 'Europe/Budapest', nextRun: 1_800_000_000_000,
    summary: `## Latest review sync\n${'Repository/with-a-very-long-unbroken-name-'.repeat(12)}\n${Array.from({ length: 50 }, (_, index) => `- PR #${index + 1}: analysed; ready to inspect`).join('\n')}`,
  }
  if (action === 'disable') status = { ...status, enabled: false, nextRun: undefined }
  return { ok: true, value: status }
} })
injectBaseStyle()
injectConfigStyle()
Object.assign(window, { fixture: {
  calls, opened,
  fail(value: boolean) { fail = value },
  refresh() { return store.request() },
} })
createRoot(document.getElementById('root')!).render(
  <div className="ac-page"><section className="ac-group"><div className="ac-rows">
    <ReviewScheduleField store={store} disabled={false} openTask={(sessionId, id) => { opened.push([sessionId, id]); return true }} />
  </div></section></div>,
)
