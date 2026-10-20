import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { ReviewScheduleStore, REVIEW_SCHEDULE_METHOD, type ScheduleStatus } from '../src/client/review/schedule.ts'
import { FIELDS } from '../src/client/config/form.ts'

const output = await build({
  stdin: { contents: `export { ReviewScheduleField } from './src/client/config/review.tsx'; export { reset, rerender } from 'react'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'review-ui-hooks', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'mock' }))
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'jsx' ? `
      export const jsx = (type, props) => ({ type, props });
      export const jsxs = jsx;
      export const Fragment = 'fragment';
    ` : `
      let values = [], cursor = 0;
      export const reset = () => { values = []; cursor = 0 };
      export const rerender = () => { cursor = 0 };
      export const useState = (initial) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = next }] };
      export const useEffect = () => {};
      export const useRef = () => ({ current: null });
      export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
    ` }))
  } }],
})
const source = output.outputFiles[0]!.text
const { ReviewScheduleField, reset, rerender } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
interface Element { type: string; props: Record<string, any> }
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (tree === null || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
function render(status?: ScheduleStatus, error?: string, busy?: string, fresh = true) {
  if (fresh) reset()
  else rerender()
  const calls: string[] = []
  const opened: string[][] = []
  const tree = ReviewScheduleField({
    store: { getSnapshot: () => ({ status, error, busy, uncertain: error !== undefined && status?.error === undefined }), subscribe: () => () => {}, request: (action = 'status') => calls.push(action) },
    disabled: false,
    openTask: (sessionId: string, id: string) => { opened.push([sessionId, id]); return true },
  })
  return { nodes: nodes(tree), calls, opened }
}

test('review UI: legacy clock fields stay hidden and helper uses the existing route pair', () => {
  for (const key of ['auto', 'at']) assert.equal(FIELDS.find((field) => field.section === 'review' && field.key === key)?.hidden, true)
  assert.equal(FIELDS.find((field) => field.section === 'review' && field.key === 'helperModel')?.provider, 'review.helperProvider')
})

test('review UI: task status, title and summary are read-only; management uses task identifiers', () => {
  const view = render({ enabled: true, taskId: 'task-1', sessionId: 'session-1', title: 'Review title', summary: 'Analysed 3 PRs', time: '09:30', timeZone: 'Europe/Budapest', nextRun: 1_800_000_000_000 })
  assert.equal(view.nodes.filter((node) => ['input', 'select', 'textarea'].includes(node.type)).length, 0)
  assert.equal(view.nodes.find((node) => node.props.role === 'switch')?.props['aria-checked'], true)
  assert.ok(view.nodes.some((node) => node.type === 'dd' && node.props.children === 'Review title'))
  assert.ok(view.nodes.some((node) => node.type === 'details' && node.props.open !== true))
  assert.ok(view.nodes.some((node) => node.type === 'pre' && node.props.children === 'Analysed 3 PRs'))
  const buttons = view.nodes.filter((node) => node.type === 'button')
  buttons[2]!.props.onClick()
  assert.deepEqual(view.opened, [['session-1', 'task-1']])
  buttons[0]!.props.onClick()
  assert.deepEqual(view.calls, ['disable'])
})

test('review UI: unknown, pending and errored states cannot toggle; errors remain near a retry', () => {
  for (const view of [render(), render({ enabled: false }, undefined, 'enable'), render({ enabled: false }, 'Host unavailable')]) {
    assert.equal(view.nodes.find((node) => node.props.role === 'switch')?.props.disabled, true)
  }
  const failed = render({ enabled: false }, 'Host unavailable')
  assert.ok(failed.nodes.some((node) => node.props.role === 'alert'))
  failed.nodes.filter((node) => node.type === 'button')[1]!.props.onClick()
  assert.deepEqual(failed.calls, ['status'])
})

test('review UI: enabling needs a separate confirmation and cancellation never starts a task', () => {
  const first = render({ enabled: false })
  first.nodes.find((node) => node.props.role === 'switch')!.props.onClick()
  assert.deepEqual(first.calls, [])
  const confirmation = render({ enabled: false }, undefined, undefined, false)
  const group = confirmation.nodes.find((node) => node.props.role === 'group')!
  assert.ok(group)
  const actions = nodes(group).filter((node) => node.type === 'button')
  actions[0]!.props.onClick()
  assert.deepEqual(confirmation.calls, [])
  const cancelled = render({ enabled: false }, undefined, undefined, false)
  assert.equal(cancelled.nodes.some((node) => node.props.role === 'group'), false)
  cancelled.nodes.find((node) => node.props.role === 'switch')!.props.onClick()
  const confirmed = render({ enabled: false }, undefined, undefined, false)
  nodes(confirmed.nodes.find((node) => node.props.role === 'group')).filter((node) => node.type === 'button')[1]!.props.onClick()
  assert.deepEqual(confirmed.calls, ['enable'])
})

test('review UI: a title warning does not prevent disabling an enabled task', () => {
  const view = render({ enabled: true, error: 'Title could not be updated' }, 'Title could not be updated')
  const toggle = view.nodes.find((node) => node.props.role === 'switch')!
  assert.equal(toggle.props.disabled, false)
  toggle.props.onClick()
  assert.deepEqual(view.calls, ['disable'])
})

test('review UI: known missing-task warnings allow explicit enable to recreate a task', () => {
  const error = 'No active native review task'
  const view = render({ enabled: false, error }, error)
  const toggle = view.nodes.find((node) => node.props.role === 'switch')!
  assert.equal(toggle.props.disabled, false)
  toggle.props.onClick()
  assert.deepEqual(view.calls, [])
  const confirmation = render({ enabled: false, error }, error, undefined, false)
  const confirm = nodes(confirmation.nodes.find((node) => node.props.role === 'group')).filter((node) => node.type === 'button')[1]!
  assert.equal(confirm.props.disabled, false)
  confirm.props.onClick()
  assert.deepEqual(confirmation.calls, ['enable'])
})

test('review schedule client: uses the agreed action RPC and native response', async () => {
  const calls: unknown[] = []
  const store = new ReviewScheduleStore({ async call(channel, method, payload) {
    calls.push({ channel, method, payload })
    return { ok: true, value: { enabled: true, taskId: 'native', title: 'Review', summary: 'Done' } }
  } })
  await store.request('enable')
  assert.deepEqual(calls, [{ channel: '/api', method: REVIEW_SCHEDULE_METHOD, payload: { action: 'enable' } }])
  assert.equal(store.getSnapshot().status?.taskId, 'native')
  assert.equal(store.getSnapshot().status?.summary, 'Done')
  assert.equal(store.getSnapshot().busy, undefined)
  store.dispose()
})

test('review schedule client: serializes requests and never flips state optimistically', async () => {
  let resolve!: (value: unknown) => void
  let count = 0
  const store = new ReviewScheduleStore({ call() { count++; return new Promise((done) => { resolve = done }) } })
  const pending = store.request('enable')
  assert.equal(store.getSnapshot().busy, 'enable')
  assert.equal(store.getSnapshot().status, undefined)
  const duplicate = store.request('enable')
  assert.equal(count, 1)
  resolve({ ok: true, value: { enabled: true } })
  await Promise.all([pending, duplicate])
  assert.equal(store.getSnapshot().status?.enabled, true)
  store.dispose()
})

test('review schedule client: transport errors preserve last known state until explicit refresh', async () => {
  let fail = false
  const store = new ReviewScheduleStore({ async call() {
    if (fail) throw new Error('Connection lost')
    return { ok: true, value: { enabled: true, taskId: 'task' } }
  } })
  await store.request()
  fail = true
  await store.request('disable')
  assert.equal(store.getSnapshot().status?.enabled, true)
  assert.equal(store.getSnapshot().error, 'Connection lost')
  fail = false
  await store.request()
  assert.equal(store.getSnapshot().error, undefined)
  store.dispose()
})
