/**
 * The terminal screen: one xterm per pane on screen, showing that pane's
 * terminal. Built as its own chunk (lib/client.terminal.js) and
 * loaded the first time the panel opens, so xterm costs nothing until then.
 *
 * Output never passes through React: the screen subscribes to the view's
 * store and writes frames straight into xterm, acknowledging each one so the
 * host paces the stream. Switching tabs detaches the old view (its process
 * keeps running on the host) and attaches the new one, whose first frame is
 * the host's serialized screen.
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TerminalView } from './terminal-host.ts'
import type { MenuAnchor } from './kit.tsx'
import { t } from './i18n.ts'
import { CODE_FONT_EVENT, codeFontFor } from '../font/shared.ts'
import { isMenuKey } from '../editor/shared.ts'

export interface ScreenProps {
  view: TerminalView
  label: string
  /** A line was submitted and its output has started. */
  onSubmit: () => void
  /** Snapshot the selection before a menu takes focus. */
  onSelectionMenu: (text: string, anchor: MenuAnchor, refocus: () => void) => void
  /** The pane with the keyboard, among split ones; absent: true. Gaining it focuses the screen. */
  focused?: boolean
}

let styles = 0
let styleTag: HTMLStyleElement | undefined

function useXtermStyle(): void {
  useEffect(() => {
    if (styles++ === 0) {
      styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-agent-hub'
      styleTag.dataset.pluginCss = 'dsh-agent-hub/xterm'
      styleTag.textContent = xtermCss
      document.head.appendChild(styleTag)
    }
    return () => {
      if (--styles === 0) {
        styleTag?.remove()
        styleTag = undefined
      }
    }
  }, [])
}

/** rgb()/rgba() → rgba() at `alpha`, for xterm's selection color. */
function withAlpha(color: string, alpha: number): string {
  const channels = color.match(/[\d.]+/g)
  return channels === null || channels.length < 3 ? color : `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`
}

const TERMINAL_STACK = 'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace'

/** How far a finger moves before a touch scrolls instead of tapping. */
const DRAG_PX = 6

/** Frames the colors are re-read for after a possible theme change (DSH animates its switch). */
const SETTLE_FRAMES = 40

/** A computed rgb() color is dark when its relative luminance is under the midpoint. */
export function isDarkColor(color: string): boolean {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (channels === undefined || channels.length < 3) return false
  const [r, g, b] = channels.map((value) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18
}

/**
 * The 16 ANSI colors for each background: on light, deep enough to read and with black and
 * white swapped toward the page's own ink (white text on white is the classic failure); on
 * dark, bright. Picked to sit near DSH's own hues.
 */
const ANSI = {
  light: {
    black: '#24292f', red: '#c62828', green: '#1b7f3b', yellow: '#8a6100', blue: '#1f5fd1', magenta: '#8e3fb4', cyan: '#0b7a86', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#d73a3a', brightGreen: '#23964a', brightYellow: '#9e7400', brightBlue: '#3b74e0', brightMagenta: '#a24fc8', brightCyan: '#13909c', brightWhite: '#8c959f',
  },
  dark: {
    black: '#3b3f46', red: '#f2555a', green: '#3cb371', yellow: '#d9a514', blue: '#5b8ff9', magenta: '#c77ce0', cyan: '#22b8c8', white: '#c9cdd4',
    brightBlack: '#6b717a', brightRed: '#ff7b7f', brightGreen: '#5fd38d', brightYellow: '#f0c03c', brightBlue: '#82abff', brightMagenta: '#dc9cf0', brightCyan: '#4fd3e0', brightWhite: '#f2f4f7',
  },
} as const

export function TerminalScreen(props: ScreenProps): ReactNode {
  useXtermStyle()
  const element = useRef<HTMLDivElement>(null)
  const screen = useRef<{ xterm: Terminal; fit: FitAddon; fitNow: () => void }>()
  const view = useRef(props.view)
  view.current = props.view
  const onSubmit = useRef(props.onSubmit)
  onSubmit.current = props.onSubmit
  const onSelectionMenu = useRef(props.onSelectionMenu)
  onSelectionMenu.current = props.onSelectionMenu
  const [selected, setSelected] = useState(false)
  const focused = useRef(props.focused !== false)
  focused.current = props.focused !== false
  // Armed by Enter, spent by the first output after it; typing disarms.
  const armed = useRef(false)

  useLayoutEffect(() => {
    const node = element.current!
    const xterm = new Terminal({
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.15,
      fontFamily: codeFontFor(TERMINAL_STACK),
      scrollback: 1000,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(node)
    const input = xterm.onData((data) => {
      armed.current = /[\r\n]/.test(data)
      view.current.write(data)
    })
    const selection = xterm.onSelectionChange(() => setSelected(xterm.hasSelection()))
    const openMenu = (anchor: MenuAnchor): void => onSelectionMenu.current(xterm.getSelection(), anchor, () => xterm.focus())
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      openMenu({ x: event.clientX, y: event.clientY })
    }
    const preserveSelection = (event: MouseEvent): void => {
      if (event.button === 2 && xterm.hasSelection()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    node.addEventListener('mousedown', preserveSelection, true)
    node.addEventListener('contextmenu', onContextMenu, true)
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !isMenuKey(event)) return true
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      openMenu({ x: rect.left + 16, y: rect.top + 24 })
      return false
    })
    // xterm 6 has no touch scrolling. A one-finger vertical drag scrolls line for line under the
    // finger: through the scrollback in a shell, and, in a full-screen program or one that tracks
    // the mouse, as one wheel notch per line, which xterm turns into arrow keys or wheel reports
    // as for a mouse. (A synthetic wheel cannot scroll the scrollback: xterm's scrollable reads
    // `wheelDeltaY`, which only a real wheel carries.) A tap stays a tap (focus, keyboard):
    // nothing moves until the finger has gone DRAG_PX.
    let touch: { y: number; target: EventTarget | null; dragging: boolean; rest: number } | undefined
    const onTouchStart = (event: TouchEvent): void => {
      touch = event.touches.length === 1 ? { y: event.touches[0]!.clientY, target: event.target, dragging: false, rest: 0 } : undefined
    }
    const onTouchMove = (event: TouchEvent): void => {
      const point = event.touches.length === 1 ? event.touches[0]! : undefined
      if (touch === undefined || point === undefined) return
      const delta = touch.y - point.clientY
      if (!touch.dragging && Math.abs(delta) < DRAG_PX) return
      event.preventDefault()
      touch.dragging = true
      touch.y = point.clientY
      const cell = (xterm.element?.querySelector('.xterm-screen')?.clientHeight ?? 0) / xterm.rows
      if (!(cell > 0)) return
      touch.rest += delta / cell
      const lines = Math.trunc(touch.rest)
      touch.rest -= lines
      if (lines === 0) return
      if (xterm.buffer.active.type === 'normal' && xterm.modes.mouseTrackingMode === 'none') {
        xterm.scrollLines(lines)
        return
      }
      for (let i = 0; i < Math.abs(lines); i++) {
        touch.target?.dispatchEvent(new WheelEvent('wheel', {
          deltaY: Math.sign(lines), deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: point.clientX, clientY: point.clientY, bubbles: true, cancelable: true,
        }))
      }
    }
    const onTouchEnd = (): void => { touch = undefined }
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: false })
    node.addEventListener('touchend', onTouchEnd)
    node.addEventListener('touchcancel', onTouchEnd)
    // Fit at most once a frame, and tell the host only when the grid really changes.
    let frame = 0
    const fitNow = (): void => {
      cancelAnimationFrame(frame)
      frame = 0
      const state = view.current.state.getSnapshot()
      if (!state.writable || node.clientWidth === 0 || node.clientHeight === 0) return
      const proposed = fit.proposeDimensions()
      const environment = state.environment
      if (proposed === undefined || environment === undefined) return
      const cols = Math.min(proposed.cols, environment.maxCols)
      const rows = Math.min(proposed.rows, environment.maxRows)
      if (cols < 2 || rows < 1) return
      if (cols !== xterm.cols || rows !== xterm.rows) xterm.resize(cols, rows)
      if (cols !== state.info?.cols || rows !== state.info?.rows) view.current.resize(cols, rows)
    }
    const observer = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(fitNow)
    })
    observer.observe(node)
    // The code font changed (and is loaded): xterm measures the new cells, then the grid refits.
    const onFont = (): void => {
      xterm.options.fontFamily = codeFontFor(TERMINAL_STACK)
      fitNow()
    }
    window.addEventListener(CODE_FONT_EVENT, onFont)
    screen.current = { xterm, fit, fitNow }
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener(CODE_FONT_EVENT, onFont)
      observer.disconnect()
      selection.dispose()
      node.removeEventListener('mousedown', preserveSelection, true)
      node.removeEventListener('contextmenu', onContextMenu, true)
      node.removeEventListener('touchstart', onTouchStart)
      node.removeEventListener('touchmove', onTouchMove)
      node.removeEventListener('touchend', onTouchEnd)
      node.removeEventListener('touchcancel', onTouchEnd)
      input.dispose()
      xterm.dispose()
      screen.current = undefined
    }
  }, [])

  useEffect(() => {
    screen.current?.xterm.textarea?.setAttribute('aria-label', props.label)
  }, [props.label])

  // A split pane given the focus (a click on its tab, a shortcut, a closed neighbour) takes the keyboard.
  const wasFocused = useRef(focused.current)
  useEffect(() => {
    if (props.focused !== false && !wasFocused.current) screen.current?.xterm.focus()
    wasFocused.current = props.focused !== false
  }, [props.focused])

  // DSH colors: the element's own text and background (theme tokens), read again whenever the
  // theme may have changed. The DOM is watched rather than a theme event, which comes before the
  // new tokens apply: DSH flips `data-ds-dark-theme` on <body> and animates the switch, so the
  // computed colors change only a few frames later; a custom theme swaps style sheets in <head>;
  // the system scheme can change underneath. After any such change the colors are read every
  // frame for a short while and written whenever they differ, so the screen lands on the final
  // colors however long the switch takes.
  useLayoutEffect(() => {
    const xterm = screen.current?.xterm
    const node = element.current
    if (xterm === undefined || node === null) return
    let applied = ''
    let frame = 0
    let frames = 0
    const apply = (): void => {
      const style = getComputedStyle(node)
      const background = style.backgroundColor
      const foreground = style.color
      if (`${background}|${foreground}` === applied) return
      applied = `${background}|${foreground}`
      xterm.options.theme = {
        ...ANSI[isDarkColor(background) ? 'dark' : 'light'],
        background,
        foreground,
        cursor: foreground,
        cursorAccent: background,
        selectionBackground: withAlpha(foreground, 0.28),
        selectionInactiveBackground: withAlpha(foreground, 0.16),
      }
    }
    const settle = (): void => {
      apply()
      frame = --frames > 0 ? requestAnimationFrame(settle) : 0
    }
    const later = (): void => {
      frames = SETTLE_FRAMES
      if (frame === 0) frame = requestAnimationFrame(settle)
    }
    apply()
    const observer = new MutationObserver(later)
    observer.observe(document.documentElement, { attributes: true })
    observer.observe(document.body, { attributes: true })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', later)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      media.removeEventListener('change', later)
    }
  }, [])

  // Attach the active terminal; frames go straight from its store into xterm.
  useLayoutEffect(() => {
    const current = screen.current
    if (current === undefined) return
    const { xterm, fitNow } = current
    const model = props.view
    xterm.reset()
    armed.current = false
    let revision = 0
    let writable: boolean | undefined
    let rendered: unknown
    const apply = (): void => {
      const state = model.state.getSnapshot()
      const render = state.render
      if (render !== undefined && render !== rendered && render.revision > revision) {
        rendered = render
        revision = render.revision
        if (render.frame.type === 'snapshot') {
          xterm.reset()
          xterm.resize(render.frame.info.cols, render.frame.info.rows)
        } else if (armed.current) {
          armed.current = false
          onSubmit.current()
        }
        const at = render.revision
        xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => model.acknowledge(at))
      }
      if (state.writable !== writable) {
        writable = state.writable
        xterm.options.disableStdin = !writable
        if (writable) {
          fitNow()
          if (focused.current) xterm.focus()
        } else if (state.info !== undefined && (state.info.cols !== xterm.cols || state.info.rows !== xterm.rows)) {
          // Read-only: mirror the controlling page's grid.
          xterm.resize(state.info.cols, state.info.rows)
        }
      }
    }
    const unsubscribe = model.state.subscribe(apply)
    const unmount = model.mount()
    apply()
    return () => {
      unsubscribe()
      unmount()
    }
  }, [props.view])

  return <>
    <div ref={element} className="gt-screen" />
    {selected && <div className="gp-selection-actions gt-selection-actions" role="toolbar" aria-label={t('selectionMenu')}>
      <button type="button" className="gp-text-btn" onClick={(event) => {
        const xterm = screen.current?.xterm
        if (xterm === undefined) return
        const rect = event.currentTarget.getBoundingClientRect()
        onSelectionMenu.current(xterm.getSelection(), { x: rect.left, y: rect.bottom, rect }, () => xterm.focus())
      }}>{t('selectionMenu')}</button>
    </div>}
  </>
}
