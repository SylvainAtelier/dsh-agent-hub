import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openFiles, type RowFilesDeps } from '../src/client/git/row-files.ts'

function fixture(screen: string | undefined, options: { showing?: boolean; sessionIds?: string[] } = {}) {
  const calls: string[] = []
  let current = screen
  const deps: RowFilesDeps = {
    sidebar: {
      commandTarget: () => (current === undefined ? undefined : { sessionId: current }),
      openTabFromTarget: (kind, target) => { calls.push(`tab:${kind}:${(target as { sessionId: string }).sessionId}`) },
      isExpanded: () => options.showing ?? false,
      active: () => ({ kind: 'files' }),
      toggleExpanded: () => { calls.push('collapse') },
    },
    workspaces: () => ({ items: [{ workspaceId: 'w', path: '/w', sessionIds: options.sessionIds ?? ['old', 'new', 'gone'] }], archivedSessionIds: ['gone'] }),
    sessions: () => ({ byId: { old: { cwd: '/w', updatedAt: 1 }, new: { cwd: '/w', updatedAt: 2 }, gone: { cwd: '/w', updatedAt: 3 }, other: { cwd: '/x' }, fresh: { cwd: '/w' } } }),
    openSession: (id) => { calls.push(`session:${id}`); current = id },
    openWorkspace: (id) => { calls.push(`workspace:${id}`); current = 'fresh' },
  }
  return { deps, calls }
}

const frames = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number)

test('row files: the workspace on screen opens its tab, or collapses it when in front', () => {
  const closed = fixture('old')
  openFiles(closed.deps, 'w')
  assert.deepEqual(closed.calls, ['tab:files:old'])
  const open = fixture('old', { showing: true })
  openFiles(open.deps, 'w')
  assert.deepEqual(open.calls, ['collapse'])
})

test('row files: another workspace shows its latest live session first, then the tab', async () => {
  const { deps, calls } = fixture('other')
  openFiles(deps, 'w')
  await frames()
  assert.deepEqual(calls, ['session:new', 'tab:files:new'])
})

test('row files: a workspace without sessions gets a new one', async () => {
  const { deps, calls } = fixture(undefined, { sessionIds: [] })
  openFiles(deps, 'w')
  await frames()
  // The new session is not listed under the workspace yet; its cwd says where it belongs.
  assert.deepEqual(calls, ['workspace:w', 'tab:files:fresh'])
  openFiles(deps, 'unknown')
  assert.deepEqual(calls, ['workspace:w', 'tab:files:fresh'])
})
