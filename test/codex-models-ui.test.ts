import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

interface Element {
  type: string | ((props: Record<string, unknown>) => unknown)
  props: Record<string, any>
}

// Preserve JSX element props and read the directory synchronously without a DOM.
const result = await build({
  entryPoints: ['src/client/config/visibility.tsx'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{
    name: 'synchronous-hooks',
    setup(builder) {
      builder.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'jsx' }))
      builder.onLoad({ filter: /.*/, namespace: 'jsx' }, () => ({ contents: `
        export const jsx = (type, props) => ({ type, props });
        export const jsxs = jsx;
        export const Fragment = 'fragment';
      ` }))
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hooks' }))
      builder.onLoad({ filter: /.*/, namespace: 'hooks' }, () => ({ contents: `
        export const useEffect = () => {};
        export const useRef = () => ({ current: null });
        export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();
      ` }))
    },
  }],
})
const { AgentModelsField } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`)

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  if (typeof element.type === 'function') return elements(element.type(element.props))
  return [element, ...elements(element.props.children)]
}

function render(value: string[], catalog = ['gpt-5.4', 'gpt-5.3-codex']) {
  const edits: unknown[] = []
  const tree = AgentModelsField({
    id: 'codex.models', disabled: false,
    field: { value, overridden: true },
    form: { edit: (id: string, next: unknown) => edits.push({ id, next }) },
    models: { subscribe: () => () => {}, getSnapshot: () => ({ groups: [{ provider: 'openai-codex', models: catalog.map((id) => ({ id, name: id })) }] }) },
  })
  return { nodes: elements(tree), edits }
}

test('Codex model UI: uses the Codex catalog, supports individual and bulk selection', () => {
  const all = render([])
  const checks = all.nodes.filter((node) => node.type === 'input')
  assert.equal(checks.length, 2)
  assert.ok(checks.every((node) => node.props.checked))
  checks[0]!.props.onChange({ target: { checked: false } })
  assert.deepEqual(all.edits, [{ id: 'codex.models', next: ['gpt-5.3-codex'] }])
  const buttons = all.nodes.filter((node) => node.type === 'button' && node.props.className === 'ac-link')
  buttons.at(-1)!.props.onClick()
  assert.deepEqual(all.edits.at(-1), { id: 'codex.models', next: ['(none)'] })
  const none = render(['(none)'])
  assert.ok(none.nodes.filter((node) => node.type === 'input').every((node) => !node.props.checked))
  none.nodes.filter((node) => node.type === 'button' && node.props.className === 'ac-link').at(-2)!.props.onClick()
  assert.deepEqual(none.edits, [{ id: 'codex.models', next: [] }])
})

test('Codex model UI: missing saved ids remain removable, and all includes future catalog additions', () => {
  const missing = render(['retired'])
  const checks = missing.nodes.filter((node) => node.type === 'input')
  assert.equal(checks.length, 3)
  assert.equal(checks[2]!.props.checked, true)
  checks[2]!.props.onChange({ target: { checked: false } })
  assert.deepEqual(missing.edits, [{ id: 'codex.models', next: ['(none)'] }])
  const future = render([], ['gpt-5.4', 'future-model'])
  assert.ok(future.nodes.filter((node) => node.type === 'input').every((node) => node.props.checked))
})
