/**
 * The 接力 page: what Qoder and the Hermes personas did elsewhere, and the
 * way back into it. A list beside a detail column: the list holds every
 * thread, newest first by day, filtered by agent and searched; the detail
 * column reads a thread (prompts, answers, tool calls folded) and carries it
 * on: typing into it takes the thread over into a DSH session and sends the
 * message there. Before a thread is picked it shows the glasses' workspaces
 * and the cloud form (Overview.tsx). On a narrow page (a phone through remote
 * access) the two columns become two steps, the detail with a way back.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { ThreadView, Turn } from '../../relay/types.ts'
import { copyText } from '../editor/shared.ts'
import { Menu, type MenuAnchor, type MenuEntry } from '../git/kit.tsx'
import { injectGitStyle } from '../git/style.ts'
import { Markdown } from '../review/Markdown.tsx'
import { OVERVIEW, type Filter, type RelaySnapshot, type RelayStore } from './api.ts'
import { ago, groupOf, originLabel, procLine, who, type Group } from './format.ts'
import { IconBack, IconChevron, IconCopy, IconExternal, IconGear, IconHash, IconMore, IconRefresh, IconSend, IconTerminal, OriginIcon, PhaseMark } from './icons.tsx'
import { t, type RelayKey } from './i18n.ts'
import { Overview } from './Overview.tsx'

export { RELAY_PANEL_ID } from './icons.tsx'

export interface RelayFace {
  store: RelayStore
  openSettings(): void
  openSession(sessionId: string): void
  /** The page runs on the machine itself: a terminal opened there is seen. */
  local: boolean
}

const FILTERS: Filter[] = ['all', 'qoder', 'hermes']
const GROUPS: Group[] = ['today', 'yesterday', 'week', 'older']

function matches(thread: ThreadView, filter: Filter, query: string): boolean {
  if (filter !== 'all' && thread.agent !== filter) return false
  if (query === '') return true
  return [thread.title, thread.detail, thread.persona, thread.cwd, thread.id, thread.branch, originLabel(thread)]
    .some((field) => field?.toLowerCase().includes(query))
}

export function RelayPage(props: RelayFace): ReactNode {
  const { store } = props
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => store.poll(true), [store])
  useEffect(injectGitStyle, [])
  // An unchanged poll renders nothing; "3 分钟前" still moves on.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') tick((n) => n + 1) }, 30_000)
    return () => clearInterval(timer)
  }, [])

  const split = useRef<HTMLDivElement>(null)
  const shown = snap.selected ?? OVERVIEW
  // A pick on a narrow page swaps the columns: the detail's heading takes the focus. A wide page keeps it in the list.
  useLayoutEffect(() => {
    if (snap.selected === undefined) return
    const list = split.current?.querySelector<HTMLElement>('.rl-list')
    if (list === null || list === undefined || getComputedStyle(list).display !== 'none') return
    split.current?.querySelector<HTMLElement>('.rl-detail [data-focus-target]')?.focus()
  }, [snap.selected])

  return (
    <div className="rl-page">
      <div ref={split} className="rl-split" data-view={snap.selected === undefined ? 'list' : 'detail'}>
        <List face={props} snap={snap} />
        <section className="rl-detail" aria-live="off">
          {shown === OVERVIEW
            ? <Overview store={store} status={snap.status} pending={snap.pending} openSettings={props.openSettings} onBack={() => store.select(undefined)} />
            : <ThreadPane key={shown} face={props} snap={snap} threadKey={shown} />}
        </section>
      </div>
    </div>
  )
}

function List(props: { face: RelayFace; snap: RelaySnapshot }): ReactNode {
  const { store } = props.face
  const { snap } = props
  const query = snap.query.trim().toLowerCase()
  const threads = useMemo(() => (snap.status?.threads ?? []).filter((thread) => matches(thread, snap.filter, query)), [snap.status, snap.filter, query])
  const counts = useMemo(() => {
    const all = snap.status?.threads ?? []
    return { all: all.length, qoder: all.filter((thread) => thread.agent === 'qoder').length, hermes: all.filter((thread) => thread.agent === 'hermes').length }
  }, [snap.status])
  const groups = useMemo(() => {
    const now = new Date()
    const by = new Map<Group, ThreadView[]>()
    for (const thread of threads) {
      const group = groupOf(thread.updatedAt, now)
      by.set(group, [...(by.get(group) ?? []), thread])
    }
    return GROUPS.flatMap((group) => (by.has(group) ? [[group, by.get(group)!] as const] : []))
  }, [threads])
  const now = Date.now()
  const qoder = snap.status?.qoder
  const online = qoder?.workspaces.filter((workspace) => workspace.phase === 'online').length ?? 0
  const overviewState = qoder === undefined ? '' : !qoder.installed ? t('overview.off')
    : qoder.workspaces.length === 0 ? t('overview.none')
      : online === 0 ? t('overview.stopped') : t('overview.online', { n: online, total: qoder.workspaces.length })
  const troubled = qoder?.workspaces.some((workspace) => workspace.phase === 'retrying' || (workspace.error !== undefined && workspace.phase !== 'stopped')) === true

  // Up and down move between the rows.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next === undefined) return
    event.preventDefault()
    next.focus()
  }

  return (
    <aside className="rl-list" aria-label={t('title')}>
      <header className="rl-list-head">
        <h2 className="rl-title">{t('title')}</h2>
        <button type="button" className="ah-icon-btn rl-icon-btn" aria-label={t('refresh')} title={t('refresh')} onClick={() => void store.refresh()}><IconRefresh /></button>
        <button type="button" className="ah-icon-btn rl-icon-btn" aria-label={t('settings')} title={t('settings')} onClick={props.face.openSettings}><IconGear /></button>
      </header>
      <div className="rl-tools">
        <div className="ah-seg rl-seg" role="radiogroup" aria-label={t('filter.label')}>
          {FILTERS.map((filter) => (
            <button key={filter} type="button" role="radio" aria-checked={snap.filter === filter} onClick={() => store.setFilter(filter)}>
              {t(`filter.${filter}` as RelayKey)}<span className="rl-count">{counts[filter]}</span>
            </button>
          ))}
        </div>
        <input type="search" className="rl-input rl-search" placeholder={t('search')} aria-label={t('search')} value={snap.query}
          onChange={(event) => store.setQuery(event.target.value)} />
      </div>
      {snap.error !== null && <p className="rl-alert" data-tone="danger" role="alert">{t('failedLoad', { message: snap.error })}</p>}
      <div className="rl-scroll" onKeyDown={onKeyDown}>
        {snap.filter !== 'hermes' && query === '' && (
          <button type="button" data-row="" className="rl-row rl-row-pin" aria-current={snap.selected === OVERVIEW || snap.selected === undefined ? 'true' : undefined}
            data-default={snap.selected === undefined ? '' : undefined} onClick={() => store.select(OVERVIEW)}>
            <span className="rl-row-icon" data-agent="qoder"><OriginIcon origin="glasses" /></span>
            <span className="rl-row-main">
              <span className="rl-row-title">{t('overview')}</span>
              <span className="rl-row-sub" data-tone={troubled ? 'warn' : undefined}>{overviewState}</span>
            </span>
            <span className="rl-row-chevron" aria-hidden="true"><IconChevron /></span>
          </button>
        )}
        {snap.status !== undefined && threads.length === 0 && (
          query !== '' || snap.filter !== 'all'
            ? <p className="rl-none">{t('noMatch')}</p>
            : <div className="rl-none"><p className="rl-empty-title">{t('empty')}</p><p>{t('emptyHint')}</p></div>
        )}
        {groups.map(([group, list]) => (
          <section key={group} className="rl-group" aria-label={t(`group.${group}` as RelayKey)}>
            <h3 className="rl-group-title">{t(`group.${group}` as RelayKey)}</h3>
            <ul className="rl-rows">
              {list.map((thread) => <Row key={thread.key} thread={thread} now={now} selected={snap.selected === thread.key} onPick={() => store.select(thread.key)} />)}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  )
}

function Row(props: { thread: ThreadView; now: number; selected: boolean; onPick(): void }): ReactNode {
  const { thread } = props
  const origin = originLabel(thread)
  return (
    <li>
      <button type="button" data-row="" className="rl-row" aria-current={props.selected ? 'true' : undefined} onClick={props.onPick}>
        <span className="rl-row-icon" data-agent={thread.agent} title={origin}>
          <OriginIcon origin={thread.origin} />
          <span className="rl-sr">{origin}</span>
        </span>
        <span className="rl-row-main">
          <span className="rl-row-top">
            <span className="rl-row-title">{thread.title}</span>
            <time className="rl-time" dateTime={new Date(thread.updatedAt).toISOString()}>{ago(thread.updatedAt, props.now)}</time>
          </span>
          <span className="rl-row-sub">
            <span className="rl-row-who">{who(thread)}</span>
            {thread.detail !== undefined && <span className="rl-row-detail" data-tone={thread.phase === 'failed' ? 'danger' : undefined}>{thread.detail}</span>}
            {thread.session !== undefined && <span className="rl-chip" title={t('linkedHint')}>{t('linked')}</span>}
            {thread.phase !== 'idle' && (
              <span className="rl-phase" data-phase={thread.phase} title={t(`phase.${thread.phase}` as RelayKey)}>
                <PhaseMark phase={thread.phase} />
                <span className="rl-sr">{t(`phase.${thread.phase}` as RelayKey)}</span>
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}

/** Consecutive tool calls fold into one line; one alone stays a line. */
type Block = { kind: 'turn'; turn: Turn; index: number } | { kind: 'tools'; turns: Turn[]; index: number }

function blocks(turns: readonly Turn[]): Block[] {
  const out: Block[] = []
  turns.forEach((turn, index) => {
    const last = out[out.length - 1]
    if (turn.role === 'tool' && last?.kind === 'tools') last.turns.push(turn)
    else if (turn.role === 'tool') out.push({ kind: 'tools', turns: [turn], index })
    else out.push({ kind: 'turn', turn, index })
  })
  return out
}

function ThreadPane(props: { face: RelayFace; snap: RelaySnapshot; threadKey: string }): ReactNode {
  const { store } = props.face
  const { snap, threadKey } = props
  const detail = snap.detail?.key === threadKey ? snap.detail : undefined
  // The list's copy is the freshest; the detail's stands in when the list no longer holds it.
  const thread = snap.status?.threads.find((entry) => entry.key === threadKey) ?? detail?.data?.thread
  const turns = detail?.data?.turns
  const now = Date.now()

  const scroller = useRef<HTMLDivElement>(null)
  const placed = useRef(false)
  // Open at the end; follow new turns only from the end.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null || turns === undefined) return
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 96
    if (!placed.current || near) element.scrollTop = element.scrollHeight
    placed.current = true
  }, [turns])

  const [menu, setMenu] = useState<MenuAnchor | undefined>()
  const [flash, setFlash] = useState<string | undefined>()
  useEffect(() => {
    if (flash === undefined) return
    const timer = setTimeout(() => setFlash(undefined), 2000)
    return () => clearTimeout(timer)
  }, [flash])

  if (thread === undefined) {
    return (
      <div className="rl-thread">
        <header className="rl-d-head">
          <button type="button" className="ah-icon-btn rl-back" aria-label={t('back')} title={t('back')} onClick={() => store.select(undefined)}><IconBack /></button>
          <div className="rl-d-id"><h2 className="rl-d-title" tabIndex={-1} data-focus-target="">{detail?.error ?? t('loading')}</h2></div>
        </header>
      </div>
    )
  }

  const takeOver = (send: boolean): void => {
    void store.takeover(thread.key, send).then((session) => { if (session !== undefined) props.face.openSession(session) })
  }
  const entries: MenuEntry[] = [
    ...(thread.url === undefined ? [] : [{ id: 'web', label: t('menu.web'), icon: <IconExternal /> }]),
    ...(props.face.local ? [{ id: 'terminal', label: t('menu.terminal'), icon: <IconTerminal /> }] : []),
    { id: 'copy', label: t('menu.copy'), hint: thread.command.length > 36 ? `${thread.command.slice(0, 35)}…` : thread.command, icon: <IconCopy /> },
    { id: 'id', label: t('menu.copyId'), icon: <IconHash /> },
  ]
  const pick = (id: string): void => {
    setMenu(undefined)
    if (id === 'web' && thread.url !== undefined) window.open(thread.url, '_blank', 'noopener,noreferrer')
    if (id === 'terminal') store.terminal(thread.key).then(() => setFlash(t('terminalOpened')), (error: unknown) => setFlash((error as Error).message))
    if (id === 'copy') void copyText(thread.command).then(() => setFlash(t('copied')))
    if (id === 'id') void copyText(thread.id).then(() => setFlash(t('copied')))
  }
  const blocked = thread.session === undefined && (thread.phase === 'cloud' || (thread.agent === 'qoder' && thread.phase === 'running'))
  const meta = [
    originLabel(thread),
    who(thread),
    ...(thread.branch === undefined ? [] : [thread.branch]),
    ...(thread.model === undefined ? [] : [thread.model]),
    ...(thread.prompts === undefined ? [] : [t(thread.agent === 'hermes' ? 'messages' : 'prompts', { n: thread.prompts })]),
    ago(thread.updatedAt, now),
  ]
  const task = thread.task
  const live = task === undefined ? undefined
    : task.worker !== undefined ? [procLine(task.worker, now), ...(task.restored === undefined ? [] : [t('restored', { n: task.restored })])].join(' · ')
      : task.phase === 'dormant' ? t('dormant') : undefined

  return (
    <div className="rl-thread">
      <header className="rl-d-head">
        <button type="button" className="ah-icon-btn rl-back" aria-label={t('back')} title={t('back')} onClick={() => store.select(undefined)}><IconBack /></button>
        <span className="rl-d-mark" data-agent={thread.agent} aria-hidden="true"><OriginIcon origin={thread.origin} /></span>
        <div className="rl-d-id">
          <h2 className="rl-d-title" tabIndex={-1} data-focus-target="" title={thread.title}>{thread.title}</h2>
          <p className="rl-d-meta">
            <span className="rl-badge" data-phase={thread.phase}><PhaseMark phase={thread.phase} />{t(`phase.${thread.phase}` as RelayKey)}</span>
            {meta.map((part, index) => <span key={index} className="rl-meta-part" title={index === 1 && thread.cwd !== undefined ? thread.cwd : undefined}>{part}</span>)}
          </p>
        </div>
        <div className="rl-d-actions">
          {flash !== undefined && <span className="rl-flash" role="status">{flash}</span>}
          {thread.session !== undefined
            ? <button type="button" className="ah-btn" onClick={() => props.face.openSession(thread.session!)}>{t('open')}</button>
            : !blocked && <button type="button" className="ah-btn rl-takeover" disabled={snap.sending !== undefined} onClick={() => takeOver(false)}>{t('takeover')}</button>}
          <button type="button" className="ah-icon-btn rl-icon-btn" aria-label={t('more')} title={t('more')} aria-haspopup="menu" aria-expanded={menu !== undefined}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.right, y: rect.bottom, rect, align: 'end' })
            }}><IconMore /></button>
        </div>
      </header>
      {menu !== undefined && <Menu anchor={menu} entries={entries} label={t('more')} onClose={() => setMenu(undefined)} onSelect={pick} />}

      {(live !== undefined || (task?.phase === 'running' && task.tool !== undefined)) && (
        <p className="rl-live">
          {task?.phase === 'running' && task.tool !== undefined && <span className="rl-live-tool"><PhaseMark phase="running" />{task.tool}</span>}
          {live !== undefined && <span>{live}</span>}
        </p>
      )}
      {thread.phase === 'failed' && thread.detail !== undefined && <p className="rl-alert rl-d-alert" data-tone="danger">{thread.detail}</p>}

      <div ref={scroller} className="rl-transcript" tabIndex={0} aria-label={thread.title}>
        {detail?.data?.truncated === true && <p className="rl-note rl-center">{t('truncated')}</p>}
        {turns === undefined && detail?.error === undefined && <p className="rl-note rl-center">{t('loading')}</p>}
        {detail?.error !== undefined && <p className="rl-alert" data-tone="danger" role="alert">{t('failedLoad', { message: detail.error })}</p>}
        {turns?.length === 0 && <p className="rl-note rl-center">{t('noTurns')}</p>}
        {turns !== undefined && blocks(turns).map((block) => <TurnBlock key={block.index} block={block} agent={thread.agent === 'qoder' ? 'Qoder' : thread.persona ?? 'Hermes'} />)}
      </div>

      <Composer face={props.face} snap={snap} thread={thread} blocked={blocked} onSent={takeOver} />
    </div>
  )
}

function TurnBlock(props: { block: Block; agent: string }): ReactNode {
  const { block } = props
  if (block.kind === 'tools') {
    if (block.turns.length === 1) return <p className="rl-tool"><IconTerminal />{block.turns[0]!.text}</p>
    return (
      <details className="rl-tools-group">
        <summary><IconChevron />{t('tools', { n: block.turns.length })}</summary>
        <ul>{block.turns.map((turn, index) => <li key={index} className="rl-tool">{turn.text}</li>)}</ul>
      </details>
    )
  }
  const { turn } = block
  return (
    <div className="rl-turn" data-role={turn.role}>
      <span className="rl-turn-who">{turn.role === 'user' ? t('you') : props.agent}</span>
      {/* Agents answer in Markdown (rendered safe: raw HTML stays text); a prompt is shown as typed. */}
      {turn.role === 'assistant' ? <Markdown text={turn.text} className="rl-turn-text" /> : <div className="rl-turn-text">{turn.text}</div>}
    </div>
  )
}

function Composer(props: { face: RelayFace; snap: RelaySnapshot; thread: ThreadView; blocked: boolean; onSent(send: boolean): void }): ReactNode {
  const { store } = props.face
  const { thread, snap, blocked } = props
  const id = useId()
  const draft = snap.drafts[thread.key] ?? ''
  const sending = snap.sending === thread.key
  const error = snap.sendError?.key === thread.key ? snap.sendError.message : undefined
  const linked = thread.session !== undefined
  const field = useRef<HTMLTextAreaElement>(null)
  // Grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const element = field.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`
  }, [draft])
  const hint = error ?? (sending ? t('sending')
    : linked ? t('hint.linked')
      : thread.phase === 'cloud' ? t('hint.cloud')
        : blocked ? t('hint.running')
          : thread.agent === 'hermes' ? t('hint.context')
            : thread.origin === 'glasses' ? t('hint.glasses') : t('hint.load'))
  const canSend = !blocked && !sending && draft.trim() !== '' && snap.sending === undefined
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (canSend) props.onSent(true)
  }
  return (
    <form className="rl-compose" onSubmit={submit}>
      <label className="rl-sr" htmlFor={`${id}-text`}>{t('compose.label')}</label>
      <div className="rl-compose-box" data-disabled={blocked ? '' : undefined}>
        <textarea ref={field} id={`${id}-text`} className="rl-compose-text" rows={1} value={draft} disabled={blocked}
          placeholder={linked ? t('compose.linked') : t(thread.takeover === 'load' ? 'compose.load' : 'compose.context')}
          aria-describedby={`${id}-hint`}
          onChange={(event) => store.setDraft(thread.key, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }} />
        <button type="submit" className="rl-send" disabled={!canSend} aria-busy={sending} aria-label={linked ? t('send') : t('sendTakeover')} title={linked ? t('send') : t('sendTakeover')}>
          <IconSend />
        </button>
      </div>
      <p id={`${id}-hint`} className="rl-hint" data-tone={error !== undefined ? 'danger' : blocked ? 'warn' : undefined} aria-live="polite">{hint}</p>
    </form>
  )
}
