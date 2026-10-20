/** Offline real-React fixture: all RPCs are in-memory and never execute a script. */
import { createRoot } from 'react-dom/client'
import { AutomationPanel } from '../../src/client/config/automation.tsx'
import { AutomationStore } from '../../src/client/automation/api.ts'
import { ModelDirectory } from '../../src/client/config/models.ts'
import { injectConfigStyle } from '../../src/client/config/style.ts'
import { injectBaseStyle } from '../../src/client/theme/base.ts'
import type { ScriptTask, TaskStatus } from '../../src/automation/types.ts'

const preset: ScriptTask = { id: 'offline-check', title: 'Offline check', command: 'C:\\tools\\offline-check.exe', args: ['--check', 'space preserved'], cwd: 'C:\\work', timeoutMs: 300000, provider: '', model: '' }
let definitions: ScriptTask[] = []
let tasks: TaskStatus[] = []
const calls: unknown[] = []
const opened: string[][] = []
const store = new AutomationStore({ async call(_channel, _method, payload) {
  const request = payload as { action: string; definition?: ScriptTask; id?: string; expected?: ScriptTask }
  calls.push(structuredClone(request))
  await new Promise((done) => setTimeout(done, 30))
  if (request.action === 'upsert') {
    definitions = [structuredClone(request.definition!)]
    tasks = [{ id: definitions[0]!.id, title: definitions[0]!.title, enabled: false }]
  }
  if (request.action === 'enable') {
    if (JSON.stringify(request.expected) !== JSON.stringify(definitions[0])) return { ok: false, error: 'Definition changed; refresh and confirm again.' }
    tasks = [{ ...tasks[0]!, enabled: true, taskId: 'native-task', sessionId: 'native-session', time: '10:05:00.000', timeZone: 'Asia/Shanghai', nextRun: new Date(Date.now() + (3 * 60 + 12) * 60_000).toISOString() }]
  }
  if (request.action === 'disable') tasks = tasks.map((task) => ({ ...task, enabled: false }))
  return { ok: true, value: { definitions: structuredClone(definitions), tasks: structuredClone(tasks), ...(request.action === 'preset' ? { preset } : {}) } }
} })
const models = new ModelDirectory(async () => [
  { provider: 'bots', name: 'Bots', models: [{ id: 'helper', name: 'Offline helper' }] },
  { provider: 'claude-agent', name: 'External agent', models: [{ id: 'excluded', name: 'Excluded' }] },
])
void models.load()
injectBaseStyle()
injectConfigStyle()
Object.assign(window, { fixture: {
  calls, opened,
  changeDefinition() { definitions = definitions.map((task) => ({ ...task, command: 'C:\\changed\\unexpected.exe', args: ['--different'] })); return store.request() },
  refresh() { return store.request() },
} })
createRoot(document.getElementById('root')!).render(
  <div className="ac-page"><section className="ac-group"><div className="ac-rows">
    <AutomationPanel store={store} models={models} disabled={false} openTask={(sessionId, id) => { opened.push([sessionId, id]); return true }} />
  </div></section></div>,
)
