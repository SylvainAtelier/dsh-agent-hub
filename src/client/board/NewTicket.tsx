/**
 * A new ticket, in the detail's place: the card it will be, before it exists.
 * Wide, it slides in from the right beside the board; narrow, it is a bottom
 * sheet. Title and description first; under them the bot that can rewrite both
 * (✦ 处理, undone in one step); then the ticket's properties as chips, each a
 * searchable menu (a bottom sheet when narrow).
 *
 * - A repository with a Linear account offers 本地 | Linear; Linear adds team
 *   (when there are several), assignee, labels and project, and, with a Slack
 *   workspace for the repository, the channel announcing it.
 * - Where it went, team, project and channel are remembered per repository,
 *   and the bot picked, in the profile (they sync); priority, labels and
 *   assignee start afresh. The state follows the column it was opened from.
 * - The draft outlives closing the panel, until it is created.
 */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { accountFor, orderStates, pickState, PRIORITIES, stageOf, STAGES, type BoardState, type Draft, type Named, type Stage, type TicketOptions } from '../../board/types.ts'
import { samePath } from '../../repos/types.ts'
import type { BoardStore } from './api.ts'
import { rememberBot, rememberTicket, ticketBot, ticketDefaults } from './defaults.ts'
import { t, type BoardKey } from './i18n.ts'
import { LinearMark, PriorityMark, ProjectIcon } from './marks.tsx'

const SPARK = '✦'
/** A chip's menu: its width, and the room it wants below the chip before it opens above instead. */
const MENU_WIDTH = 260
const MENU_ROOM = 320
/** The draft while the panel is closed, until it is created. */
let kept: { title: string; note: string; source?: Draft } = { title: '', note: '' }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const stageName = (stage: Stage): string => t(`stage.${stage}` as BoardKey)

export interface Option { id: string; name: string; icon?: ReactNode; group?: string; hint?: ReactNode; title?: string }

const Dot = (props: { stage: Stage }): ReactNode => <span className="ab-dot" data-stage={props.stage} aria-hidden="true" />
const Avatar = (props: { name: string }): ReactNode => <span className="ab-avatar" aria-hidden="true">{props.name.slice(0, 1).toUpperCase()}</span>

function RepoIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 3.5a1 1 0 0 1 1-1h2.2l1 1.2h3.8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" />
    </svg>
  )
}

function LabelIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 2.5v3.3l4.7 4.7 4.3-4.3-4.7-4.7H2.5a1 1 0 0 0-1 1Z" /><circle cx="4" cy="4.5" r=".8" fill="currentColor" stroke="none" />
    </svg>
  )
}

function TeamIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="4" r="1.8" /><path d="M1.5 10c.3-1.8 1.5-2.8 3-2.8s2.7 1 3 2.8" /><path d="M8 2.4a1.8 1.8 0 0 1 0 3.3M9.3 7.4c.7.4 1.1 1.3 1.2 2.6" />
    </svg>
  )
}

function SlackIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M4.5 1.5v9M7.5 1.5v9M1.5 4.5h9M1.5 7.5h9" />
    </svg>
  )
}

/**
 * A property as a chip opening its menu: the options (grouped, filtered as typed when there are
 * many), or what `search` finds as typed. Arrow keys move, Enter picks, Esc closes back to the chip.
 */
export function Picker(props: {
  label: string
  icon?: ReactNode
  value: ReactNode
  /** Nothing set: the chip reads as a placeholder. */
  empty?: boolean
  options: readonly Option[]
  selected: readonly string[]
  multi?: boolean
  search?: (query: string) => Promise<Option[]>
  searchHint?: string
  disabled?: boolean
  /** Under the options: a link out, say. */
  footer?: ReactNode
  onPick(id: string, option: Option): void
}): ReactNode {
  const { options, search } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [found, setFound] = useState<{ query: string; options?: Option[]; error?: string }>({ query: '' })
  const [place, setPlace] = useState<CSSProperties>()
  const wrap = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const searchable = search !== undefined || options.length > 7

  useEffect(() => {
    if (!open) return
    const away = (event: Event): void => { if (!wrap.current?.contains(event.target as Node)) setOpen(false) }
    // Placed where the chip was: scrolling the panel or resizing leaves it behind, so it closes.
    // (A bottom sheet stays: a phone's keyboard opening resizes the page.)
    const moved = (): void => setOpen(false)
    const placed = place !== undefined
    document.addEventListener('pointerdown', away)
    if (placed) {
      window.addEventListener('scroll', away, true)
      window.addEventListener('resize', moved)
    }
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('resize', moved)
    }
  }, [open, place])
  // Searched as typed, a moment after the last key; the latest answer wins.
  useEffect(() => {
    if (!open || search === undefined) return
    const q = query.trim()
    if (q === '') { setFound({ query: '' }); return }
    let live = true
    const timer = setTimeout(() => {
      search(q).then((value) => { if (live) setFound({ query: q, options: value }) }, (error: unknown) => { if (live) setFound({ query: q, error: message(error) }) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [open, query, search])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const own = search === undefined && q !== '' ? options.filter((option) => option.name.toLowerCase().includes(q)) : options
    if (search === undefined || found.options === undefined) return own
    return [...own, ...found.options.filter((option) => !own.some((item) => item.id === option.id))]
  }, [options, query, search, found])
  const index = Math.min(active, Math.max(shown.length - 1, 0))

  const close = (): void => {
    setOpen(false)
    setQuery('')
    chip.current?.focus()
  }
  const pick = (option: Option): void => {
    props.onPick(option.id, option)
    if (!props.multi) close()
  }
  const toggle = (): void => {
    if (open) return close()
    setActive(Math.max(0, options.findIndex((option) => props.selected.includes(option.id))))
    // Over the panel's scrolling body, under the chip (above it when the room is there); narrow, a bottom sheet.
    const rect = chip.current?.getBoundingClientRect()
    if (rect === undefined || wrap.current?.closest('[data-narrow]') !== null) setPlace(undefined)
    else {
      const below = window.innerHeight - rect.bottom
      const up = below < MENU_ROOM && rect.top > below
      setPlace({
        position: 'fixed', right: 'auto', left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
        ...(up ? { top: 'auto', bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      })
    }
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    if (searchable) wrap.current?.querySelector<HTMLInputElement>('.ab-pick-search')?.focus()
    else (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current?.querySelector<HTMLElement>('[role="option"]'))?.focus()
  }, [open, searchable])
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, index])

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(shown.length, 1)
      setActive(next)
      if (!searchable) list.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
    } else if (event.key === 'Enter' && searchable && shown[index] !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      pick(shown[index]!)
    }
  }

  let group: string | undefined
  return (
    <div className="ab-pick-wrap" ref={wrap} onKeyDown={onKeyDown}>
      <button type="button" ref={chip} className="ab-pchip" data-empty={props.empty ? '' : undefined} disabled={props.disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={props.label} title={props.label} onClick={toggle}>
        {props.icon}<span className="ab-pchip-text">{props.value}</span>
      </button>
      {open && (
        <div className="ab-menu ab-pick" role="dialog" aria-label={props.label} style={place}>
          <span className="ab-menu-title">{props.label}</span>
          {searchable && (
            <input className="ab-input ab-pick-search" type="search" value={query} placeholder={props.searchHint ?? t('searchOptions')}
              aria-label={props.searchHint ?? t('searchOptions')} aria-controls={id} aria-activedescendant={shown[index] === undefined ? undefined : `${id}-${index}`}
              onChange={(event) => { setQuery(event.target.value); setActive(0) }} />
          )}
          <div className="ab-pick-list" role="listbox" id={id} ref={list} aria-multiselectable={props.multi}>
            {shown.map((option, i) => {
              const head = option.group !== undefined && option.group !== group ? option.group : undefined
              group = option.group
              const on = props.selected.includes(option.id)
              return (
                <div key={`${option.group ?? ''}/${option.id}`} className="ab-pick-item">
                  {head !== undefined && <span className="ab-pick-group">{head}</span>}
                  <button type="button" role="option" id={`${id}-${i}`} data-index={i} aria-selected={on} data-active={i === index ? '' : undefined}
                    tabIndex={searchable ? -1 : i === index ? 0 : -1} title={option.title} onMouseEnter={() => setActive(i)} onClick={() => pick(option)}>
                    {option.icon}<span className="ab-pick-name">{option.name}</span>
                    {option.hint !== undefined && <span className="ab-pick-hint">{option.hint}</span>}
                    {on && <svg className="ab-pick-check" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" /></svg>}
                  </button>
                </div>
              )
            })}
            {shown.length === 0 && <span className="ab-pick-empty">{search !== undefined && query.trim() === '' ? props.searchHint : t('noMatch')}</span>}
            {found.error !== undefined && <span className="ab-pick-empty" role="alert">{found.error}</span>}
          </div>
          {props.footer}
        </div>
      )}
    </div>
  )
}

export function NewTicket(props: {
  store: BoardStore
  /** The column it was opened from: a local task's state, a Linear ticket's default one. */
  stage: Stage
  repos: readonly string[]
  /** The repository the board shows; empty for all. */
  repo: string
  accounts: BoardState['accounts'] | undefined
  bots: BoardState['bots']
  narrow: boolean
  onClose(): void
  onCreated(key: string): void
}): ReactNode {
  const { store, onClose } = props
  const titleId = useId()
  const formId = useId()
  const first = props.repo !== '' ? props.repo : props.repos[0] ?? ''
  const [repo, setRepo] = useState(first)
  const linearAccount = accountFor(props.accounts?.linear ?? [], repo, samePath)
  const slackAccount = accountFor(props.accounts?.slack ?? [], repo, samePath)

  // Where it goes and how it is filed start from how this repository's last ticket was.
  const initial = (path: string): { linear: boolean; team?: string; project?: string; channel?: Named; notify: boolean } => {
    const kept = ticketDefaults(path)
    const channel = kept?.channel === undefined ? undefined : { id: kept.channel, name: kept.channelName ?? kept.channel }
    return {
      linear: kept?.linear ?? true,
      ...(kept?.team === undefined ? {} : { team: kept.team }),
      ...(kept?.project === undefined ? {} : { project: kept.project }),
      ...(channel === undefined ? {} : { channel }),
      notify: channel !== undefined && kept?.notify !== false,
    }
  }
  const [filing, setFiling] = useState(() => initial(first))
  const linear = linearAccount !== undefined && filing.linear

  const [title, setTitle] = useState(kept.title)
  const [note, setNote] = useState(kept.note)
  const [source, setSource] = useState<Draft | undefined>(kept.source)
  useEffect(() => { kept = { title, note, ...(source === undefined ? {} : { source }) } }, [title, note, source])

  const [stage, setStage] = useState(props.stage)
  const [stateId, setStateId] = useState<string>()
  const [priority, setPriority] = useState(0)
  const [assignee, setAssignee] = useState('me')
  const [labels, setLabels] = useState<string[]>([])
  const [options, setOptions] = useState<{ key: string; value?: TicketOptions; error?: string }>()
  const [bot, setBotState] = useState(() => ticketBot())
  const botId = props.bots.some((item) => item.id === bot) ? bot : ''
  const [busy, setBusy] = useState<'process' | 'create'>()
  const [error, setError] = useState<string>()
  const panel = useRef<HTMLElement>(null)
  const titleField = useRef<HTMLTextAreaElement>(null)

  // A Linear account's teams and the chosen team's states, labels, projects and people.
  const optionsKey = linear ? `${linearAccount!.id}\n${filing.team ?? ''}` : ''
  useEffect(() => {
    if (!linear || linearAccount === undefined) return
    let live = true
    store.options(linearAccount.id, filing.team).then(
      (value) => {
        if (!live) return
        setOptions({ key: optionsKey, value })
        // A remembered team that is gone, or none yet: the first one Linear lists.
        if (value.team !== filing.team) setFiling((current) => ({ ...current, team: value.team }))
      },
      (failure: unknown) => { if (live) setOptions({ key: optionsKey, error: message(failure) }) },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, optionsKey])
  const loaded = options?.value !== undefined && options.value.team === filing.team ? options.value : undefined
  const states = useMemo(() => (loaded === undefined ? [] : orderStates(loaded.states)), [loaded])
  const state = states.find((item) => item.id === stateId) ?? pickState(props.stage, states)
  const project = loaded?.projects.find((item) => item.id === filing.project)

  useEffect(() => { titleField.current?.focus() }, [])

  const changeRepo = (next: string): void => {
    setRepo(next)
    setFiling(initial(next))
    setStateId(undefined)
    setLabels([])
  }
  const changeTeam = (team: string): void => {
    if (team === filing.team) return
    const { project: _project, ...rest } = filing
    setFiling({ ...rest, team })
    setStateId(undefined)
    setLabels([])
  }
  const setBot = (id: string): void => {
    setBotState(id)
    void rememberBot(id)
  }

  const process = async (): Promise<void> => {
    if (botId === '' || (title.trim() === '' && note.trim() === '') || busy !== undefined) return
    setBusy('process')
    setError(undefined)
    try {
      const result = await store.compose(botId, { title, note }, repo)
      setSource(source ?? { title, note })
      setTitle(result.title)
      setNote(result.note)
    } catch (failure) {
      setError(message(failure))
    }
    setBusy(undefined)
    setTimeout(() => titleField.current?.focus(), 0)
  }
  const undo = (): void => {
    if (source === undefined) return
    setTitle(source.title)
    setNote(source.note)
    setSource(undefined)
  }

  const ready = title.trim() !== '' && repo !== '' && (!linear || loaded !== undefined)
  const create = async (): Promise<void> => {
    if (busy !== undefined) return
    if (title.trim() === '') {
      setError(t(botId === '' ? 'needTitle' : 'needTitleBot'))
      titleField.current?.focus()
      return
    }
    if (!ready) return
    setBusy('create')
    setError(undefined)
    const announce = linear && slackAccount !== undefined && filing.notify && filing.channel !== undefined
    try {
      const created = await store.create({
        repo, title: title.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        ...(priority === 0 ? {} : { priority }),
        ...(linear
          ? {
              linear: {
                connector: linearAccount!.id, team: loaded!.team,
                ...(state === undefined ? {} : { stateId: state.id }),
                ...(assignee === '' ? {} : { assignee }),
                ...(labels.length === 0 ? {} : { labels }),
                ...(project === undefined ? {} : { project: project.id }),
              },
              ...(announce ? { slack: { connector: slackAccount!.id, channel: filing.channel!.id } } : {}),
            }
          : { stage }),
      })
      void rememberTicket({
        repo,
        ...(linearAccount === undefined ? {} : { linear }),
        ...(linear ? { team: loaded!.team, ...(project === undefined ? {} : { project: project.id }) } : {}),
        ...(slackAccount === undefined || filing.channel === undefined ? {} : { channel: filing.channel.id, channelName: filing.channel.name, notify: filing.notify }),
      })
      kept = { title: '', note: '' }
      props.onCreated(created.key)
    } catch (failure) {
      setError(message(failure))
      setBusy(undefined)
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
  }

  const repoOptions: Option[] = props.repos.map((key) => ({ id: key, name: repoName(key), icon: <RepoIcon /> }))
  const priorityOptions: Option[] = PRIORITIES.map((value) => ({ id: String(value), name: t(`priority.${value}` as BoardKey), icon: <PriorityMark priority={value} /> }))
  const stateOptions: Option[] = linear
    ? states.map((item) => ({ id: item.id, name: item.name, icon: <Dot stage={stageOf(item.type)} />, group: stageName(stageOf(item.type)) }))
    : STAGES.map((item) => ({ id: item, name: stageName(item), icon: <Dot stage={item} /> }))
  const users = loaded?.users ?? []
  const assigneeName = assignee === 'me' ? t('assigneeMe') : users.find((user) => user.id === assignee)?.name
  const labelNames = (loaded?.labels ?? []).filter((label) => labels.includes(label.id)).map((label) => label.name)
  const team = loaded?.teams.find((item) => item.id === loaded.team)
  const channelOptions: Option[] = [
    { id: '', name: t('notifyOff') },
    ...(filing.channel === undefined ? [] : [{ id: filing.channel.id, name: `#${filing.channel.name}`, icon: <SlackIcon /> }]),
  ]
  const searchChannels = useMemo(() => (slackAccount === undefined ? undefined : async (query: string): Promise<Option[]> =>
    (await store.channels(slackAccount.id, query)).map((channel) => ({ id: channel.id, name: `#${channel.name}`, icon: <SlackIcon /> }))), [store, slackAccount?.id])

  const empty = title.trim() === '' && note.trim() === ''
  const botName = props.bots.find((item) => item.id === botId)?.id
  return (
    <>
      <div className="ab-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="ab-detail" data-new="" ref={panel} role="dialog" aria-modal={props.narrow} aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <header className="ab-detail-head">
          <h3 className="ab-new-heading" id={titleId}>{t('newTask')}</h3>
          <span className="ab-grow" />
          {linearAccount !== undefined && (
            <div className="ah-seg ab-target" role="radiogroup" aria-label={t('target')}>
              <button type="button" role="radio" aria-checked={!linear} onClick={() => setFiling({ ...filing, linear: false })}>{t('local')}</button>
              <button type="button" role="radio" aria-checked={linear} onClick={() => setFiling({ ...filing, linear: true })}><LinearMark />Linear</button>
            </div>
          )}
          <button type="button" className="ah-icon-btn" aria-label={t('close')} title={`${t('close')} (Esc)`} onClick={onClose}>
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" /></svg>
          </button>
        </header>
        <form id={formId} className="ab-detail-body ab-draft" onSubmit={(event) => { event.preventDefault(); void create() }}>
          <textarea ref={titleField} className="ab-title-input ab-new-title" rows={1} value={title} maxLength={300} disabled={busy !== undefined}
            placeholder={t('ticketTitle')} aria-label={t('ticketTitle')}
            onChange={(event) => { setTitle(event.target.value.replace(/\n/g, ' ')); setError(undefined) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); panel.current?.querySelector<HTMLTextAreaElement>('.ab-new-note')?.focus() } }} />
          <textarea className="ab-input ab-new-note" rows={5} value={note} disabled={busy !== undefined}
            placeholder={t(linear ? 'ticketNotePlaceholder' : 'taskNotePlaceholder')} aria-label={t('description')}
            onChange={(event) => { setNote(event.target.value); setError(undefined) }} />
          {props.bots.length > 0 && (
            <div className="ab-new-bot">
              <select className="ab-select" value={botId} disabled={busy !== undefined} aria-label={t('bot')} title={t('bot')} onChange={(event) => setBot(event.target.value)}>
                <option value="">{t('noBot')}</option>
                {props.bots.map((item) => <option key={item.id} value={item.id}>{item.description === undefined ? item.id : `${item.id} · ${item.description}`}</option>)}
              </select>
              <button type="button" className="ah-btn" disabled={botId === '' || empty || busy !== undefined}
                title={botId === '' ? t('pickBot') : t('processHint', { bot: botName ?? botId })} onClick={() => void process()}>
                {busy === 'process' ? <><span className="ab-spin" aria-hidden="true" /> {t('processing')}</> : <>{SPARK} {t('process')}</>}
              </button>
              {source !== undefined && busy === undefined && <button type="button" className="ab-link" onClick={undo}>{t('undo')}</button>}
            </div>
          )}
          <div className="ab-new-props" role="group" aria-label={t('properties')}>
            {props.repos.length > 1
              ? <Picker label={t('repo')} icon={<RepoIcon />} value={repoName(repo)} options={repoOptions} selected={[repo]} disabled={busy !== undefined} onPick={changeRepo} />
              : <span className="ab-pchip" data-static=""><RepoIcon /><span className="ab-pchip-text">{repoName(repo)}</span></span>}
            {linear && loaded !== undefined && loaded.teams.length > 1 && (
              <Picker label={t('team')} icon={<TeamIcon />} value={team?.name ?? loaded.team} disabled={busy !== undefined}
                options={loaded.teams.map((item) => ({ id: item.id, name: item.name }))} selected={[loaded.team]} onPick={changeTeam} />
            )}
            {linear && loaded === undefined
              ? <span className="ab-pchip" data-static="" role="status">{options?.key === optionsKey && options.error !== undefined ? t('optionsFailed', { message: options.error }) : t('optionsLoading')}</span>
              : (
                <>
                  <Picker label={t('state')} icon={<Dot stage={linear ? stageOf(state?.type) : stage} />}
                    value={linear ? state?.name ?? t('state') : stageName(stage)} disabled={busy !== undefined}
                    options={stateOptions} selected={[linear ? state?.id ?? '' : stage]}
                    onPick={(id) => (linear ? setStateId(id) : setStage(id as Stage))} />
                  <Picker label={t('priority')} icon={<PriorityMark priority={priority} />} value={t(`priority.${priority}` as BoardKey)} empty={priority === 0}
                    options={priorityOptions} selected={[String(priority)]} disabled={busy !== undefined}
                    onPick={(id) => setPriority((PRIORITIES as readonly number[]).includes(Number(id)) ? Number(id) : 0)} />
                  {linear && (
                    <>
                      <Picker label={t('assignee')} icon={assigneeName === undefined ? undefined : <Avatar name={assigneeName} />}
                        value={assigneeName ?? t('unassigned')} empty={assignee === ''} disabled={busy !== undefined}
                        options={[{ id: 'me', name: t('assigneeMe') }, { id: '', name: t('unassigned') }, ...users.map((user) => ({ id: user.id, name: user.name, icon: <Avatar name={user.name} /> }))]}
                        selected={[assignee]} onPick={setAssignee} />
                      <Picker label={t('labels')} icon={<LabelIcon />} multi disabled={busy !== undefined}
                        value={labelNames.length === 0 ? t('labels') : labelNames.length <= 2 ? labelNames.join(', ') : t('labelCount', { n: labelNames.length })}
                        empty={labelNames.length === 0} options={(loaded?.labels ?? []).map((label) => ({ id: label.id, name: label.name }))} selected={labels}
                        onPick={(id) => setLabels((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))} />
                      <Picker label={t('project')} icon={<ProjectIcon />} value={project?.name ?? t('noProject')} empty={project === undefined} disabled={busy !== undefined}
                        options={[{ id: '', name: t('noProject') }, ...(loaded?.projects ?? []).map((item) => ({ id: item.id, name: item.name, icon: <ProjectIcon /> }))]}
                        selected={[project?.id ?? '']}
                        onPick={(id) => {
                          const { project: _project, ...rest } = filing
                          setFiling(id === '' ? rest : { ...rest, project: id })
                        }} />
                    </>
                  )}
                </>
              )}
          </div>
          {linear && slackAccount !== undefined && (
            <div className="ab-new-props">
              <Picker label={t('notify')} icon={<SlackIcon />} search={searchChannels} searchHint={t('searchChannel')} disabled={busy !== undefined}
                value={filing.notify && filing.channel !== undefined ? t('notifyIn', { channel: filing.channel.name }) : t('notifyOff')}
                empty={!filing.notify || filing.channel === undefined}
                options={channelOptions} selected={[filing.notify && filing.channel !== undefined ? filing.channel.id : '']}
                onPick={(id, option) => setFiling(id === '' ? { ...filing, notify: false } : { ...filing, channel: { id, name: option.name.replace(/^#/, '') }, notify: true })} />
            </div>
          )}
          {error !== undefined && <p className="ab-new-error" role="alert">{error}</p>}
        </form>
        <footer className="ab-detail-foot">
          {!props.narrow && <span className="ab-hint ab-keys">{t('createKeys')}</span>}
          <span className="ab-grow" />
          <button type="button" className="ah-btn" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" form={formId} className="ah-btn" data-variant="primary" disabled={!ready || busy !== undefined}>
            {busy === 'create' ? t('creating') : linear ? t('createLinear') : t('create')}
          </button>
        </footer>
      </aside>
    </>
  )
}
