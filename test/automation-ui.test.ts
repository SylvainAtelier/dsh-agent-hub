import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { AutomationStore, parseArguments, validDefinition } from '../src/client/automation/api.ts'
import { AUTOMATION_METHOD, type ScriptTask } from '../src/automation/types.ts'
import { FIELDS, CATEGORIES } from '../src/client/config/form.ts'

const definition: ScriptTask = { id: 'check', title: 'Check', command: 'C:\\tools\\check.exe', args: ['--check', 'a b'], cwd: 'C:\\work', provider: 'bots', model: 'helper', timeoutMs: 1000 }
const output = await build({
  stdin: { contents: `export { AutomationPanel } from './src/client/config/automation.tsx'; export { reset, rerender } from 'react'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'automation-ui-hooks', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'mock' }))
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'jsx' ? `
      export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = 'fragment';
    ` : `
      let values = [], cursor = 0;
      export const reset = () => { values = []; cursor = 0 };
      export const rerender = () => { cursor = 0 };
      export const useState = (initial) => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = next }] };
      export const useEffect = () => {}; export const useRef = () => ({ current: null });
      export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
    ` }))
  } }],
})
const { AutomationPanel, reset, rerender } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.text).toString('base64')}`)
interface Element { type: string; props: Record<string, any> }
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
function view(options: { manual?: { status: string; summary?: string }; run?: Record<string, unknown>; history?: Record<string, unknown>[]; enabled?: boolean; uncertain?: boolean; fresh?: boolean; empty?: boolean; available?: boolean; definition?: ScriptTask } = {}) {
  if (options.fresh !== false) reset(); else rerender()
  const calls: any[] = [], opened: any[] = []
  const reply = { presetAvailable: options.available ?? false, definitions: options.empty ? [] : [options.definition ?? definition], tasks: options.empty ? [] : [{ id: definition.id, title: definition.title, enabled: options.enabled ?? false, sessionId: 'session', taskId: 'task', time: '09:00', timeZone: 'Asia/Shanghai', ...(options.manual ? { manual: options.manual } : {}), ...(options.run ? { run: options.run } : {}), ...(options.history ? { history: options.history } : {}) }] }
  const tree = AutomationPanel({ disabled: false, models: {}, store: {
    getSnapshot: () => ({ reply, uncertain: options.uncertain }), subscribe: () => () => {},
    request: async (action: string, payload: unknown) => { calls.push({ action, payload }); return { ...reply, preset: definition } },
  }, openTask: (...ids: string[]) => { opened.push(ids); return true } })
  return { nodes: nodes(tree), calls, opened }
}
const button = (elements: Element[], text: string): Element => elements.find((node) => node.type === 'button' && node.props.children === text)!

test('automation config is dedicated and never autosaves definitions', () => {
  assert.ok(CATEGORIES.find((entry) => entry.id === 'work')?.groups.includes('automation'))
  assert.equal(FIELDS.some((entry) => entry.section === 'automation'), false)
})
test('automation arguments preserve boundaries and validation requires absolute paths and route', () => {
  assert.deepEqual(parseArguments('["a b", "", "--check"]'), ['a b', '', '--check'])
  assert.throws(() => parseArguments('[1]'))
  assert.equal(validDefinition(definition), true)
  for (const patch of [{ command: 'check.exe' }, { cwd: '.' }, { model: '' }, { provider: '' }, { timeoutMs: 0 }, { timeoutMs: 999 }]) assert.equal(validDefinition({ ...definition, ...patch }), false)
})
test('automation validator aligns with host identifier, text, argument and timeout bounds', () => {
  for (const patch of [
    { id: 'Upper' }, { id: 'under_score' }, { id: 'with.dot' }, { id: 'a'.repeat(121) },
    { title: 'a'.repeat(121) }, { command: '/'.repeat(4097) }, { cwd: '/'.repeat(4097) },
    { provider: 'a'.repeat(201) }, { model: 'a'.repeat(201) },
    { title: 'bad\0title' }, { command: '/bad\0command' }, { cwd: '/bad\0cwd' },
    { provider: 'bad\0provider' }, { model: 'bad\0model' },
    { args: Array(129).fill('') }, { args: ['a'.repeat(8193)] }, { args: ['bad\0argument'] },
    { timeoutMs: 3_600_001 }, { timeoutMs: 1000.5 },
  ]) assert.equal(validDefinition({ ...definition, ...patch }), false, JSON.stringify(patch))
  assert.equal(validDefinition({ ...definition, id: 'a'.repeat(120), title: 'a'.repeat(120), timeoutMs: 3_600_000, args: Array(128).fill('a'.repeat(8192)) }), true)
  for (const provider of ['claude-agent', 'cursor-agent', 'qoder-agent', 'hermes-agent']) assert.equal(validDefinition({ ...definition, provider }), false)
  assert.equal(validDefinition({ ...definition, provider: 'bots' }), true)
})
test('automation empty view has no implicit execution and preset only fills a draft', async () => {
  // The Qoder CN template shows only where it can work, and only while its task does not exist yet.
  assert.equal(view({ empty: true }).nodes.some((node) => node.props?.children === '用此模板'), false)
  assert.equal(view({ available: true }).nodes.some((node) => node.props?.children === '用此模板'), true)
  assert.equal(view({ available: true, definition: { ...definition, id: 'qoder-cn-daily-credit' } }).nodes.some((node) => node.props?.children === '用此模板'), false)
  const initial = view({ empty: true, available: true })
  assert.deepEqual(initial.calls, [])
  await button(initial.nodes, '用此模板').props.onClick()
  assert.deepEqual(initial.calls, [{ action: 'preset', payload: undefined }])
  const draft = view({ empty: true, fresh: false })
  assert.ok(draft.nodes.some((node) => node.type === 'form'))
  assert.deepEqual(draft.calls, [])
})
test('automation enables only after risk confirmation and opens native task identifiers', () => {
  const initial = view()
  button(initial.nodes, '打开原生任务管理').props.onClick()
  assert.deepEqual(initial.opened, [['session', 'task']])
  button(initial.nodes, '启用每日调度').props.onClick({ currentTarget: {} })
  assert.deepEqual(initial.calls, [])
  const confirm = view({ fresh: false })
  assert.ok(confirm.nodes.some((node) => node.type === 'pre' && String(node.props.children).includes('check.exe')))
  button(confirm.nodes, '了解风险，启用每日调度').props.onClick()
  assert.deepEqual(confirm.calls, [{ action: 'enable', payload: { id: 'check', expected: definition } }])
})
test('automation confirmation freezes the authorized definition across polling updates', () => {
  const original = { ...definition, args: [...definition.args] }
  const initial = view({ definition: original })
  button(initial.nodes, '启用每日调度').props.onClick({ currentTarget: {} })
  // Also mutate the old catalog object to prove arguments were copied, not retained by reference.
  original.args[0] = '--changed-in-place'
  const updated = { ...definition, command: 'C:\\other\\unsafe.exe', args: ['--changed'] }
  const confirm = view({ fresh: false, definition: updated })
  const preview = confirm.nodes.find((node) => node.type === 'pre')!.props.children
  assert.ok(String(preview).includes('check.exe'))
  assert.equal(String(preview).includes('unsafe.exe'), false)
  assert.equal(String(preview).includes('--changed-in-place'), false)
  button(confirm.nodes, '了解风险，启用每日调度').props.onClick()
  assert.deepEqual(confirm.calls, [{ action: 'enable', payload: { id: 'check', expected: definition } }])
})
test('automation confirmation cancellation never invokes the backend', () => {
  const initial = view()
  button(initial.nodes, '启用每日调度').props.onClick({ currentTarget: {} })
  const confirm = view({ fresh: false })
  button(confirm.nodes, '取消').props.onClick()
  assert.deepEqual(confirm.calls, [])
  assert.equal(view({ fresh: false }).nodes.some((node) => node.props.role === 'group'), false)
})
test('automation active definitions cannot edit or remove and uncertain results block activation', () => {
  const active = view({ enabled: true })
  assert.equal(button(active.nodes, '编辑配置').props.disabled, true)
  assert.equal(button(active.nodes, '删除配置').props.disabled, true)
  button(active.nodes, '停用').props.onClick({ currentTarget: {} })
  assert.deepEqual(active.calls, [{ action: 'disable', payload: { id: 'check' } }])
  const uncertain = view({ uncertain: true })
  assert.equal(button(uncertain.nodes, '启用每日调度').props.disabled, true)
  assert.equal(button(uncertain.nodes, '刷新状态').props.disabled, false)
})
test('automation edit submits only explicitly and includes original definition fence', async () => {
  const initial = view()
  button(initial.nodes, '编辑配置').props.onClick()
  assert.deepEqual(initial.calls, [])
  const draft = view({ fresh: false })
  await draft.nodes.find((node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(draft.calls, [{ action: 'upsert', payload: { definition, expected: definition } }])
  assert.equal(draft.nodes.some((node) => node.type === 'input' && node.props.type === 'time'), false)
  assert.equal(draft.nodes.find((node) => node.type === 'input' && node.props.type === 'number')!.props.min, 1000)
  assert.equal(draft.nodes.find((node) => node.type === 'input' && node.props.type === 'number')!.props.max, 3_600_000)
  const picker = draft.nodes.find((node) => node.props.id === 'ac-automation-route' && node.props.models !== undefined)!
  assert.deepEqual(picker.props.exclude, ['claude-agent', 'cursor-agent', 'qoder-agent', 'hermes-agent'])
})
test('automation client serializes mutations and reconciles uncertain outcomes without retries', async () => {
  let fail = false
  const calls: any[] = []
  const store = new AutomationStore({ async call(channel, method, payload) {
    calls.push({ channel, method, payload })
    if (fail) throw new Error('Connection lost')
    return { ok: true, value: { definitions: [definition], tasks: [] } }
  } })
  await store.request()
  assert.equal(calls[0].method, AUTOMATION_METHOD)
  fail = true
  await store.request('enable', { id: 'check' })
  assert.equal(store.getSnapshot().uncertain, true)
  await store.request('enable', { id: 'check' })
  assert.equal(calls.length, 2)
  fail = false
  await store.request()
  assert.equal(store.getSnapshot().uncertain, false)
  await store.request('upsert', { definition, expected: null })
  assert.deepEqual(calls.at(-1).payload, { action: 'upsert', definition, expected: null })
  store.dispose()
})

test('manual run needs risk confirmation, sends the frozen definition and never touches scheduling', () => {
  const initial = view()
  button(initial.nodes, '立即运行一次').props.onClick({ currentTarget: {} })
  assert.deepEqual(initial.calls, [])
  const confirm = view({ fresh: false })
  assert.ok(confirm.nodes.some((node) => node.type === 'pre' && String(node.props.children).includes('check.exe')))
  assert.ok(confirm.nodes.some((node) => node.type === 'strong' && node.props.children === '确认立即运行脚本'))
  button(confirm.nodes, '了解风险，立即运行').props.onClick()
  assert.deepEqual(confirm.calls, [{ action: 'run', payload: { id: 'check', expected: definition } }])
})
test('manual run works while disabled, is locked while running and is cancelled by the same control', () => {
  const idle = view({ enabled: false })
  assert.equal(button(idle.nodes, '立即运行一次').props.disabled, false)
  const running = view({ manual: { status: 'running' } })
  const cancel = button(running.nodes, '取消运行')
  assert.equal(cancel.props.disabled, false)
  assert.equal(button(running.nodes, '编辑配置').props.disabled, true)
  assert.equal(button(running.nodes, '启用每日调度').props.disabled, true)
  cancel.props.onClick({ currentTarget: {} })
  assert.deepEqual(running.calls, [{ action: 'cancel', payload: { id: 'check' } }])
})
test('manual run result is announced politely and uncertain state blocks only new runs', () => {
  const done = view({ manual: { status: 'succeeded', summary: 'Checked' } })
  const status = done.nodes.find((node) => node.props['aria-live'] === 'polite')!
  assert.ok(JSON.stringify(status.props.children).includes('Checked'))
  const uncertain = view({ uncertain: true })
  assert.equal(button(uncertain.nodes, '立即运行一次').props.disabled, true)
})

test('run history leads with the latest outcome and folds earlier runs without raw JSON', () => {
  const now = Date.now()
  const iso = (ago: number): string => new Date(now - ago).toISOString()
  const { nodes } = view({
    run: { status: 'failed', occurrence: 'task:b', kind: 'scheduled', startedAt: iso(60_000), finishedAt: iso(55_000), summary: 'http:status-401', code: 1 },
    history: [{ status: 'failed', occurrence: 'task:b', kind: 'scheduled', startedAt: iso(60_000), finishedAt: iso(55_000), summary: 'http:status-401', code: 1 },
      { status: 'succeeded', occurrence: 'manual:a', startedAt: iso(86_400_000), finishedAt: iso(86_395_000), summary: 'Claim confirmed' }],
  })
  const latest = nodes.find((node) => node.props.className === 'ac-run-latest')!
  assert.equal(latest.props['data-tone'], 'error')
  const text = JSON.stringify(latest.props.children)
  assert.ok(text.includes('执行失败') && text.includes('http:status-401') && text.includes('退出码 1') && text.includes('定时触发'))
  const rows = nodes.filter((node) => node.props.className === 'ac-run-row')
  assert.equal(rows.length, 1); assert.equal(rows[0]!.props['data-tone'], 'ok')
  assert.ok(JSON.stringify(rows[0]!.props.children).includes('手动运行'))
  assert.equal(nodes.some((node) => node.type === 'pre'), false)
})
test('a delivery that never starts turns into a visible warning', () => {
  const fresh = view({ run: { status: 'delivered', occurrence: 'task:c', deliveredAt: new Date(Date.now() - 60_000).toISOString() } })
  assert.equal(fresh.nodes.find((node) => node.props.className === 'ac-run-latest')!.props['data-tone'], 'pending')
  const stalled = view({ run: { status: 'delivered', occurrence: 'task:c', deliveredAt: new Date(Date.now() - 30 * 60_000).toISOString() } })
  const latest = stalled.nodes.find((node) => node.props.className === 'ac-run-latest')!
  assert.equal(latest.props['data-tone'], 'stalled')
  assert.ok(JSON.stringify(latest.props.children).includes('automation_run'))
})
