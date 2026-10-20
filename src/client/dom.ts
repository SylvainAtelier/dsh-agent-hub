/**
 * Following an element of DSH's own DOM that comes and goes (the workspace
 * list, a header, the panel list): the plugin decorates it in place. One
 * observer per followed element watches only that element; when it leaves
 * the page, one shared timer looks for it again every two seconds (paused
 * while the page is hidden), however many elements are followed.
 */

const FIND_MS = 2000

export interface FollowOptions {
  /** The element now, or undefined while it is not on the page. */
  locate(): Element | undefined
  /** Decorate it: runs once per animation frame after it appears or changes. */
  apply(target: Element): void
  /** What to watch under it; its subtree's children by default. */
  observe?: MutationObserverInit
  /** The plugin's own nodes: children added or removed that are all ours are not news. */
  ours?(node: Node): boolean
  /** Also run on each tick of the shared timer, not at the start (a change nothing in the DOM announces). */
  tick?(): void
}

export interface Followed {
  /** Apply again at the next frame. */
  schedule(): void
  dispose(): void
}

const tickers = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
const findAll = (): void => {
  if (document.visibilityState === 'hidden') return
  for (const tick of tickers) tick()
}

export function follow(options: FollowOptions): Followed {
  let target: Element | undefined
  let frame = 0
  const run = (): void => {
    frame = 0
    if (target !== undefined) options.apply(target)
  }
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(run)
  }
  const ours = options.ours
  const observer = new MutationObserver((records) => {
    if (ours !== undefined && records.every((record) => record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(ours))) return
    schedule()
  })
  const find = (): void => {
    if (target?.isConnected === true) return
    const next = options.locate()
    if (next === target) return
    observer.disconnect()
    target = next
    if (target === undefined) return
    observer.observe(target, options.observe ?? { childList: true, subtree: true })
    schedule()
  }
  const tick = (): void => {
    options.tick?.()
    find()
  }
  tickers.add(tick)
  if (timer === undefined) {
    timer = setInterval(findAll, FIND_MS)
    document.addEventListener('visibilitychange', findAll)
  }
  find()
  return {
    schedule,
    dispose() {
      observer.disconnect()
      cancelAnimationFrame(frame)
      tickers.delete(tick)
      if (tickers.size > 0 || timer === undefined) return
      clearInterval(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', findAll)
    },
  }
}

const bodyListeners = new Set<() => void>()
let bodyObserver: MutationObserver | undefined
let bodyFrame = 0
const runBody = (): void => {
  bodyFrame = 0
  for (const fn of bodyListeners) fn()
}

/**
 * Run `fn` at most once per animation frame while anything under <body>
 * changes; returns the stop. Every caller shares one observer and one frame,
 * so a streaming transcript costs one callback batch per frame however many
 * listen. Keep `fn` cheap when nothing moved.
 */
export function onBodyChange(fn: () => void): () => void {
  bodyListeners.add(fn)
  if (bodyObserver === undefined) {
    bodyObserver = new MutationObserver(() => {
      if (bodyFrame === 0) bodyFrame = requestAnimationFrame(runBody)
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })
  }
  return () => {
    if (!bodyListeners.delete(fn) || bodyListeners.size > 0) return
    bodyObserver?.disconnect()
    bodyObserver = undefined
    cancelAnimationFrame(bodyFrame)
    bodyFrame = 0
  }
}

/**
 * Run `fn` when the page comes back (window focus, or the tab shown again),
 * once per `minMs`: focus and visibilitychange often arrive together.
 */
export function onPageBack(fn: () => void, minMs = 2000): () => void {
  let last = -Infinity
  const wake = (): void => {
    if (document.visibilityState === 'hidden') return
    const now = performance.now()
    if (now - last < minMs) return
    last = now
    fn()
  }
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  return () => {
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}
