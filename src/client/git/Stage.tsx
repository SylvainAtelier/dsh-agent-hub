/**
 * The stage host, mounted in DSH's `shell.overlay` layer. It finds the middle
 * column (the agent conversation), covers exactly that rectangle with the
 * diff, and follows it as the window or the sidebars resize. Closing removes
 * the cover and the conversation is simply there again, untouched. Where there
 * is no middle column to cover (phones, a fullscreen sidebar), the stage takes
 * the whole window instead.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { PaneContext, useRepo, type MenuState, type PaneApi } from './context.ts'
import { DiffPanel } from './Detail.tsx'
import { t } from './i18n.ts'
import { Dialog, Menu, Toasts, useCoarse, type DialogSpec } from './kit.tsx'
import { stage, type StageState } from './stage.ts'
import { injectGitStyle } from './style.ts'

type Box = { left: number; top: number; width: number; height: number } | 'full'

/** The conversation column: the frame's grid cell just before the right sidebar column. */
function centerColumn(): HTMLElement | null {
  const rightbar = document.querySelector<HTMLElement>('[data-rightbar-col]')
  const center = rightbar?.previousElementSibling
  if (center instanceof HTMLElement) return center
  return document.querySelector<HTMLElement>('[class*="centerCol"]')
}

export function DiffStage(): ReactNode {
  useEffect(() => stage.mountHost(), [])
  useEffect(injectGitStyle, [])
  const current = useSyncExternalStore(stage.subscribe, stage.get)
  if (current === undefined) return null
  return <StageView state={current} />
}

function StageView(props: { state: StageState }): ReactNode {
  const { state } = props
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Box | undefined>()
  const coarse = useCoarse()
  const [dialog, setDialog] = useState<DialogSpec | undefined>()
  const [menu, setMenu] = useState<MenuState | undefined>()
  const root = useRepo(state.repo, (repo) => repo.status?.root)

  useLayoutEffect(() => {
    const element = ref.current
    const layer = element?.parentElement
    if (element === null || layer === null || layer === undefined) return
    let frame = 0
    let observed: HTMLElement | null = null
    const observer = new ResizeObserver(() => schedule())
    const measure = (): void => {
      const center = centerColumn()
      if (center !== observed) {
        if (observed !== null) observer.unobserve(observed)
        if (center !== null) observer.observe(center)
        observed = center
      }
      const fullscreenSidebar = center?.parentElement?.hasAttribute('data-rightbar-fullscreen') === true
      const rect = center?.getBoundingClientRect()
      if (center === null || rect === undefined || rect.width < 420 || fullscreenSidebar || window.innerWidth < 640) {
        setBox('full')
        return
      }
      const outer = layer.getBoundingClientRect()
      setBox({ left: rect.left - outer.left, top: rect.top - outer.top, width: rect.width, height: rect.height })
    }
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    observer.observe(layer)
    window.addEventListener('resize', schedule)
    // The frame toggles its fullscreen-sidebar attribute without resizing the centre column.
    const mutations = new MutationObserver(schedule)
    const frameElement = centerColumn()?.parentElement
    if (frameElement) mutations.observe(frameElement, { attributes: true, attributeFilter: ['data-rightbar-fullscreen', 'data-rightbar-collapsed'] })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [])

  const width = box === undefined ? 0 : box === 'full' ? window.innerWidth : box.width
  const panel = useMemo(() => ({ kind: 'diff' as const, target: state.target, ...(state.siblings ? { siblings: state.siblings } : {}) }), [state])
  const api = useMemo<PaneApi>(() => ({
    repo: state.repo,
    root,
    width,
    coarse,
    chrome: 'stage',
    open: (next) => {
      if (next.kind === 'diff') stage.show({ ...state, target: next.target, siblings: next.siblings ?? state.siblings })
    },
    back: () => stage.close(),
    top: panel,
    stack: [panel],
    activeDiff: state.target,
    showDiff: (target, siblings) => stage.show({ ...state, target, siblings: siblings ?? state.siblings }),
    dialog: setDialog,
    menu: setMenu,
    ...(state.openFile ? { openFile: state.openFile } : {}),
    insert: state.insert,
    backToSession: () => { stage.close(); state.backToSession?.() },
    setView: () => {},
  }), [state, root, width, coarse, panel])

  const style = box === undefined
    ? { visibility: 'hidden' as const, inset: 0 }
    : box === 'full'
      ? { inset: 0 }
      : { left: box.left, top: box.top, width: box.width, height: box.height }

  return (
    <PaneContext.Provider value={api}>
      <div ref={ref} className="gp-root gs-stage" data-full={box === 'full' ? '' : undefined} data-coarse={coarse ? '' : undefined}
        style={style} role="dialog" aria-label={t('diffStage')}>
        {state.context !== undefined && (
          <div className="gs-context" title={state.context}>
            <span className="gs-context-text">{state.context}</span>
            <span className="gs-hint">{t('stageHint')}</span>
          </div>
        )}
        <div className="gs-body">
          <DiffPanel target={state.target} {...(state.siblings ? { siblings: state.siblings } : {})} />
        </div>
        <Toasts repo={state.repo} />
        {menu !== undefined && (
          <Menu anchor={menu.anchor} entries={menu.entries} label={menu.label} onClose={() => setMenu(undefined)}
            onSelect={(id) => { setMenu(undefined); menu.onSelect(id) }} />
        )}
        {dialog !== undefined && <Dialog spec={dialog} onClose={() => setDialog(undefined)} />}
      </div>
    </PaneContext.Provider>
  )
}
