import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReviewStore, type ReviewCall } from '../src/client/review/api.ts'
import type { SheetReply } from '../src/review/types.ts'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('review store: a view that resubscribes keeps its sheet and asks the host once, not in a loop', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } })
  try {
    let reads = 0
    const call: ReviewCall = async (payload) => {
      if (payload.op !== 'sheet') return { ok: false, error: 'unexpected' }
      reads++
      return { ok: true, value: { version: 'v1', unchanged: payload.since === 'v1' } satisfies SheetReply }
    }
    const store = new ReviewStore(call)
    const path = 'C:/repo/.reviews/pr-1.md'
    let renders = 0
    const listener = (): void => { renders++ }

    // React resubscribes this way when its subscribe function changes: unsubscribe, then subscribe at once.
    let off = store.watch(path, listener)
    await tick()
    assert.equal(store.sheet(path)?.version, 'v1')
    for (let i = 0; i < 20; i++) {
      off()
      off = store.watch(path, listener)
      assert.equal(store.sheet(path)?.version, 'v1', 'the sheet stays while the view resubscribes')
      await tick()
    }
    assert.equal(reads, 1, 'no read per resubscription')
    assert.equal(renders, 1)

    // Nothing shows it any more: forgotten after a moment.
    off()
    await tick(1_100)
    assert.equal(store.sheet(path), undefined)
    store.dispose()
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document
    else Object.defineProperty(globalThis, 'document', original)
  }
})

test('review store: an idle sheet is asked after less often; a hidden page asks nothing, and coming back asks at once', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const handlers = new Set<() => void>()
  const page = {
    visibilityState: 'visible',
    addEventListener: (_type: string, handler: () => void) => handlers.add(handler),
    removeEventListener: (_type: string, handler: () => void) => handlers.delete(handler),
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
  try {
    let reads = 0
    const call: ReviewCall = async (payload) => {
      if (payload.op !== 'sheet') return { ok: false, error: 'unexpected' }
      reads++
      return { ok: true, value: { version: 'v1', unchanged: payload.since === 'v1' } satisfies SheetReply }
    }
    const store = new ReviewStore(call)
    const off = store.watch('C:/repo/.reviews/pr-1.md', () => {})
    // 0, then 1.5 s, then 3 s later: about three reads in five seconds, not four.
    await tick(5_000)
    assert.equal(reads, 3)
    page.visibilityState = 'hidden'
    for (const handler of handlers) handler()
    await tick(7_000)
    assert.equal(reads, 3, 'hidden: no reads')
    page.visibilityState = 'visible'
    for (const handler of handlers) handler()
    await tick()
    assert.equal(reads, 4, 'back: read at once')
    off()
    store.dispose()
    assert.equal(handlers.size, 0, 'no listener left behind')
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document
    else Object.defineProperty(globalThis, 'document', original)
  }
})
