/**
 * The command line drawer at the bottom of the git pane. Commands run in the
 * repository root with the checked-out branch in the prompt; output streams
 * in with its colors; stdin stays open (type a reply while a command runs);
 * Ctrl+C interrupts; ↑↓ walk the history. The graph and status refresh when a
 * command finishes, so a `git rebase` typed here shows up at once.
 *
 * One session per repository lives outside React, so closing the drawer or
 * switching tabs never loses output or a running command.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AnsiBuffer, lineText, type Line } from './ansi.ts'
import { useRepo } from './context.ts'
import { t } from './i18n.ts'
import { IconBranch, IconClose, IconOpen, IconTerminal } from './icons.tsx'
import { VirtualList } from './kit.tsx'
import type { RepoStore } from './store.ts'

export type ConsoleCall = (payload: object) => Promise<unknown>

/** Host RPC method (mirrors src/git/console.ts, which the browser bundle must not import). */
export const CONSOLE_METHOD = 'agent-hub/console'

interface Start {
  id: string
  cwd: string
  shell: string
}

interface Read {
  chunks: Array<{ seq: number; text: string; stream: 'out' | 'err' }>
  exit?: number | null
  dropped: boolean
}

interface SessionState {
  version: number
  running: boolean
  cwd?: string
  shell?: string
}

const HISTORY_KEY = 'dsh-agent-hub.git.console.history'
const HISTORY_MAX = 200

function loadHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}

export class ConsoleSession {
  readonly buffer = new AnsiBuffer()
  history = loadHistory()
  private state: SessionState = { version: 0, running: false }
  private readonly listeners = new Set<() => void>()
  private job: { id: string; since: number } | undefined
  readonly repo: RepoStore
  private readonly call: ConsoleCall

  constructor(repo: RepoStore, call: ConsoleCall) {
    this.repo = repo
    this.call = call
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): SessionState => this.state

  private changed(next: Partial<SessionState> = {}): void {
    this.state = { ...this.state, ...next, version: this.buffer.version }
    for (const listener of this.listeners) listener()
  }

  async run(command: string, branch: string | undefined): Promise<void> {
    const text = command.trim()
    if (text === '') return
    if (this.state.running) {
      this.send(command)
      return
    }
    if (text === 'clear' || text === 'cls') {
      this.clear()
      return
    }
    this.remember(text)
    this.buffer.note(`${branch ?? ''} ❯ ${text}`, { fg: 'var(--gc-prompt)', bold: true })
    this.changed({ running: true })
    let start: Start
    try {
      start = await this.call({ op: 'run', cwd: this.repo.cwd, command: text }) as Start
    } catch (error) {
      this.buffer.note(error instanceof Error ? error.message : String(error), { fg: 'var(--gc-red)' })
      this.changed({ running: false })
      return
    }
    this.job = { id: start.id, since: 0 }
    this.changed({ cwd: start.cwd, shell: start.shell })
    await this.follow(start.id)
  }

  private async follow(id: string): Promise<void> {
    let failures = 0
    while (this.job?.id === id) {
      let read: Read
      try {
        read = await this.call({ op: 'read', id, since: this.job.since }) as Read
        failures = 0
      } catch (error) {
        if (++failures > 3) {
          this.buffer.note(error instanceof Error ? error.message : String(error), { fg: 'var(--gc-red)' })
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 600 * failures))
        continue
      }
      if (this.job?.id !== id) return
      for (const chunk of read.chunks) {
        this.buffer.write(chunk.text)
        this.job.since = chunk.seq
      }
      if (read.exit !== undefined) {
        if (read.exit === null) this.buffer.note(t('consoleStopped'), { fg: 'var(--gc-yellow)', dim: true })
        else if (read.exit !== 0) this.buffer.note(t('consoleExit', { code: read.exit }), { fg: 'var(--gc-red)', dim: true })
        break
      }
      this.changed()
    }
    if (this.job?.id === id) this.job = undefined
    this.changed({ running: false })
    // Whatever the command did to the repository shows up right away.
    void this.repo.refresh()
    if (this.repo.getSnapshot().log !== undefined) void this.repo.loadLog()
  }

  send(text: string): void {
    if (this.job === undefined) return
    this.buffer.write(`${text}\n`, { dim: true })
    this.changed()
    void this.call({ op: 'input', id: this.job.id, text }).catch(() => {})
  }

  interrupt(): void {
    if (this.job !== undefined) void this.call({ op: 'kill', id: this.job.id }).catch(() => {})
  }

  clear(): void {
    this.buffer.clear()
    this.changed()
  }

  private remember(command: string): void {
    this.history = [...this.history.filter((item) => item !== command), command].slice(-HISTORY_MAX)
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history))
    } catch {
      // History just doesn't persist.
    }
  }
}

const sessions = new Map<string, ConsoleSession>()

export function consoleFor(repo: RepoStore, call: ConsoleCall): ConsoleSession {
  let session = sessions.get(repo.cwd)
  if (session === undefined) {
    session = new ConsoleSession(repo, call)
    sessions.set(repo.cwd, session)
  }
  return session
}

const SUGGESTIONS = ['git status', 'git log --oneline --graph -20', 'git branch -vv', 'git fetch --all --prune', 'git stash list']

const HEIGHT_KEY = 'dsh-agent-hub.git.console.height'

/** The drawer's height (0 = the stylesheet default) and its handle: drag to resize, double-click to reset. */
export function useDrawerHeight(): [number, ReactNode] {
  const [height, setHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY))
      return Number.isFinite(saved) && saved >= 120 ? saved : 0
    } catch {
      return 0
    }
  })
  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drawer = event.currentTarget.parentElement
    const body = drawer?.parentElement
    if (drawer === null || drawer === undefined || body === null || body === undefined) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = drawer.getBoundingClientRect().height
    const max = body.getBoundingClientRect().height - 140
    const clamp = (e: PointerEvent): number => Math.round(Math.max(120, Math.min(max, startHeight + startY - e.clientY)))
    const move = (e: PointerEvent): void => setHeight(clamp(e))
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(HEIGHT_KEY, String(clamp(e)))
      } catch {
        // Not persisted.
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])
  const grip = (
    <div className="gc-grip" role="separator" aria-orientation="horizontal" aria-label={t('consoleResize')}
      onPointerDown={startResize}
      onDoubleClick={() => {
        setHeight(0)
        try {
          localStorage.removeItem(HEIGHT_KEY)
        } catch {
          // Nothing saved.
        }
      }} />
  )
  return [height, grip]
}

function LineView(props: { line: Line }): ReactNode {
  if (props.line.length === 0) return ' '
  return props.line.map((segment, i) => {
    const style = segment.style
    if (style === undefined) return <span key={i}>{segment.text}</span>
    const fg = style.inverse ? style.bg ?? 'var(--gc-bg)' : style.fg
    const bg = style.inverse ? style.fg ?? 'var(--gc-fg)' : style.bg
    return (
      <span key={i} style={{
        ...(fg ? { color: fg } : {}),
        ...(bg ? { background: bg } : {}),
        ...(style.bold ? { fontWeight: 600 } : {}),
        ...(style.dim ? { opacity: 0.62 } : {}),
        ...(style.italic ? { fontStyle: 'italic' } : {}),
        ...(style.underline ? { textDecoration: 'underline' } : {}),
      }}>{segment.text}</span>
    )
  })
}

export function ConsoleDrawer(props: {
  session: ConsoleSession
  coarse: boolean
  onClose: () => void
  openTerminal?: () => void
}): ReactNode {
  const { session } = props
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const branch = useRepo(session.repo, (repo) => repo.status?.branch ?? repo.status?.head?.slice(0, 7))
  const root = useRepo(session.repo, (repo) => repo.status?.root)
  const folder = (state.cwd ?? root ?? session.repo.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  const [input, setInput] = useState('')
  const [cursor, setCursor] = useState<number | undefined>()
  const [height, grip] = useDrawerHeight()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pinned = useRef(true)
  const lines = session.buffer.lines
  // The last line is the open one; hide it while empty.
  const count = lines.length > 0 && lines[lines.length - 1]!.length === 0 ? lines.length - 1 : lines.length
  const rowHeight = props.coarse ? 20 : 18

  useEffect(() => { inputRef.current?.focus({ preventScroll: true }) }, [])
  // Follow the output while the reader is at the bottom.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list !== null && pinned.current) list.scrollTop = list.scrollHeight
  }, [state.version, count])
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const onScroll = (): void => { pinned.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 4 }
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => list.removeEventListener('scroll', onScroll)
  }, [count === 0])
  // Widest line, so long lines scroll sideways instead of wrapping (rows have a fixed height).
  const widest = useMemo(() => {
    let max = 0
    for (const line of lines) {
      let width = 0
      for (const segment of line) width += segment.text.length
      if (width > max) max = width
    }
    return max
  }, [state.version, lines])

  const submit = (): void => {
    const text = input
    setInput('')
    setCursor(undefined)
    pinned.current = true
    void session.run(text, branch)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    const history = session.history
    if (event.key === 'Enter') submit()
    else if (event.key === 'ArrowUp' && !state.running && history.length > 0) {
      const next = cursor === undefined ? history.length - 1 : Math.max(0, cursor - 1)
      setCursor(next)
      setInput(history[next]!)
    } else if (event.key === 'ArrowDown' && cursor !== undefined) {
      const next = cursor + 1
      if (next >= history.length) {
        setCursor(undefined)
        setInput('')
      } else {
        setCursor(next)
        setInput(history[next]!)
      }
    } else if (event.key === 'c' && event.ctrlKey && !event.shiftKey && (input === '' || state.running) && window.getSelection()?.toString() === '') {
      if (state.running) session.interrupt()
      else setInput('')
    } else if (event.key === 'l' && event.ctrlKey) session.clear()
    else if (event.key === 'Escape') inputRef.current?.blur()
    else return
    event.preventDefault()
  }

  return (
    <section className="gc-drawer" style={height > 0 ? { height } : undefined} aria-label={t('console')}
      onClick={(event) => {
        // Clicking the output focuses the prompt, unless the reader is selecting text.
        if ((event.target as HTMLElement).closest('button, input') === null && window.getSelection()?.toString() === '') inputRef.current?.focus({ preventScroll: true })
      }}>
      {grip}
      <div className="gc-head">
        <IconTerminal size={14} />
        <span className="gc-title">{t('console')}</span>
        <span className="gc-context" title={state.cwd ?? root}>
          {branch !== undefined && <span className="gc-branch"><IconBranch size={11} />{branch}</span>}
          <span className="gc-folder">{folder}</span>
        </span>
        {state.running && <span className="gc-running" role="status"><span className="gc-dot" />{t('consoleRunning')}</span>}
        <span className="gp-grow" />
        {state.running && (
          <button type="button" className="gp-text-btn gc-stop" onClick={() => session.interrupt()} title="Ctrl+C">{t('consoleStop')}</button>
        )}
        <button type="button" className="gp-text-btn" onClick={() => session.clear()} title="Ctrl+L">{t('consoleClear')}</button>
        {props.openTerminal !== undefined && (
          <button type="button" className="ah-icon-btn" aria-label={t('consoleFull')} title={t('consoleFull')} onClick={props.openTerminal}><IconOpen size={14} /></button>
        )}
        <button type="button" className="ah-icon-btn" aria-label={t('close')} title={t('close')} onClick={props.onClose}><IconClose size={14} /></button>
      </div>
      {count === 0
        ? (
          <div className="gc-empty">
            <span className="gc-hint">{t('consoleHint')}</span>
            <div className="gc-chips">
              {SUGGESTIONS.map((command) => (
                <button key={command} type="button" className="gp-chip gp-mono" onClick={() => void session.run(command, branch)}>{command}</button>
              ))}
            </div>
          </div>
        )
        : (
          <VirtualList listRef={listRef} className="gc-output gp-mono" count={count} rowHeight={rowHeight} overscan={20}
            innerWidth={`calc(${widest}ch + 24px)`}
            render={(index, style) => (
              <div key={index} style={style} className="gc-line"><LineView line={lines[index]!} /></div>
            )} />
        )}
      <label className="gc-input-row">
        <span className="gc-prompt gp-mono" aria-hidden="true">{state.running ? '↳' : `${branch ?? ''} ❯`}</span>
        <input ref={inputRef} className="gc-input gp-mono" value={input} spellCheck={false} autoComplete="off" autoCapitalize="off"
          enterKeyHint="send" aria-label={state.running ? t('consoleStdin') : t('consolePlaceholder')}
          placeholder={state.running ? t('consoleStdin') : t('consolePlaceholder')}
          onChange={(event) => { setInput(event.currentTarget.value); setCursor(undefined) }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            const list = listRef.current
            if (list !== null) pinned.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 4
          }} />
      </label>
    </section>
  )
}

/** Plain text of everything in the console (copy all). */
export const consoleText = (session: ConsoleSession): string => session.buffer.lines.map(lineText).join('\n')
