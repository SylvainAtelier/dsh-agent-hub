/**
 * 看板: Linear tickets and local tasks in one row of columns by stage, in the
 * middle column (a panel of the left sidebar, under 自动化任务).
 *
 * - A card is dragged to another column to move it; in Linear that is the
 *   team's plain-work state of that kind (In Progress, not In Review); the
 *   detail picks an exact state. Moves show at once and undo if refused.
 * - "开始", on the card or in its detail, makes a worktree on the card's
 *   branch (Linear's suggestion) and opens a session in it with the ticket in
 *   the composer; the ticket moves to in progress and, when no one has it, is
 *   assigned to me. The repository is picked for you when only one fits.
 * - A card whose worktree exists shows it; clicking goes to that workspace
 *   without starting another session.
 * - Wide: columns side by side, the detail slides in from the right. Narrow
 *   (phone, small window): one column at a time behind tabs with counts,
 *   swiped sideways; the detail is a bottom sheet.
 * - With repositories set for review, 待我审 leads the columns: the pull
 *   requests waiting for my review (or mine, or all), each opening its sheet (review/Lane.tsx).
 * - A pull request is linked to the Linear ticket its branch names, and to the
 *   Sentry issues its branch or title names: hovering or focusing a card
 *   outlines those linked to it, wherever they are on the board; resting on a
 *   ticket or an issue scrolls the review lane to its pull request. The search
 *   keeps them together: any one found shows those linked to it.
 * - A Linear card's project shows in its colour; clicking it (or picking it
 *   in the bar's project filter, which lists every project) shows only that
 *   project's cards. The detail shows the project and copies the ticket's link.
 * - Sentry alerts and 已完成 take turns: opening one folds the other. When the
 *   columns do not fit the page, 已取消 and then 已完成 fold on their own, so
 *   the first columns are never pushed out of view; one opened by hand stays.
 * - The bar holds what spans the board: the repository, the search (pull
 *   requests, tickets and the alerts Sentry's own filters fetched) and the refresh of the board; the pull requests'
 *   zone reads GitHub again from its own head. Each service's columns
 *   are a zone with its own head (board/zone.tsx): its name and actions, then
 *   its filters, lined up across the zones. 我的 / 全部成员 and the projects are
 *   the tickets' (Linear's); 新建 is there too.
 * - The zones follow the repository: Sentry's shows for the repository it is
 *   set up in, the pull requests' for those set for review, Linear's for those
 *   a Linear account serves; elsewhere the tickets are local tasks only. A
 *   zone not answered yet holds its place from the binding last seen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import { plainMentions, type Activity, type IssueDetail, type IssueState, type PullRequest } from '../../connectors/types.ts'
import { samePath } from '../../repos/types.ts'
import type { SentryIssue } from '../../alerts/types.ts'
import type { ReviewItem } from '../../review/types.ts'
import { accountFor, PRIORITIES, sortCards, stageOf, STAGES, startRepos, type Card, type ProjectInfo, type Stage } from '../../board/types.ts'
import { cardMatches, type BoardSnapshot, type BoardStore } from './api.ts'
import { isEnglish, t, type BoardKey } from './i18n.ts'
import { LinearMark, pairLink, PriorityMark, PullIcon, ZoneMark } from './marks.tsx'
import { boundTo, useBinding, Zone, ZoneHead } from './zone.tsx'
import { NewTicket } from './NewTicket.tsx'
import { ProjectDetail, ProjectDot, ProjectFilter, projectsUrl } from './projects.tsx'
import { COPY_LINK_KEY, CopyButton, LinkIcon } from '../copy.tsx'
import { alertsOf, itemMatches, REVIEW_PREFIX, ReviewColumn, ReviewDetail, ticketsOf, useReview, visibleItems, type ReviewFace, type RevealPull } from '../review/Lane.tsx'
import { t as reviewT } from '../review/i18n.ts'
import { ALERT_PREFIX, AlertDetail, AlertsColumn, issueMatches, useAlerts, type AlertsFace, type IssuePulls } from '../alerts/Lane.tsx'

export const BOARD_PANEL_ID = 'dsh-agent-hub.board'

export interface BoardFace {
  store: BoardStore
  /** Start a session in a workspace, its composer prefilled; absent without workspace navigation. */
  openWorkspace?: (workspaceId: string, draft?: string) => void
  /** 设置 → Agent Hub (connect Linear). */
  openSettings?: () => void
  /** The Sentry alerts lane; hidden when its URL/repository is not configured. */
  alerts?: AlertsFace
  /** The 待我审 lane; absent without the review module. */
  review?: ReviewFace
}

/** A column of the board: alerts, review, or a ticket stage. */
type Lane = 'alerts' | 'review' | Stage

type FoldableLane = 'alerts' | 'completed' | 'canceled'
const CANCELED_KEY = 'dsh-agent-hub.board.canceled'
const FOLDED_KEY = 'dsh-agent-hub.board.folded.v2'
function readFolded(): Set<FoldableLane> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? 'null') as unknown
    if (Array.isArray(parsed)) return new Set(parsed.filter((item): item is FoldableLane => item === 'alerts' || item === 'completed' || item === 'canceled'))
    return new Set(localStorage.getItem(CANCELED_KEY) === '1' ? [] : ['canceled'])
  } catch { return new Set(['canceled']) }
}
/** Below this page width the board shows one column at a time. */
const NARROW_PX = 640
/** The columns' least widths (style.ts), a folded one's, the gap between them and the row's side padding: what folding to fit reckons with. */
const LANE_PX = 248
const ALERTS_PX = 300
const FOLDED_PX = 40
const GAP_PX = 12
/** Between zones, wider than between the columns of one. */
const ZONE_GAP_PX = 20
const PAD_PX = 40
/** A stage column's widest (style.ts): the tickets' zone grows no wider than its columns. */
const LANE_MAX_PX = 360
/** The zones' bindings last seen, so they hold their place before their services answer. */
const ALERTS_BINDING_KEY = 'dsh-agent-hub.board.alertsBinding'
const REVIEW_BINDING_KEY = 'dsh-agent-hub.board.reviewBinding'
/** Folded to fit, in this order, while the columns are wider than the page. */
const FIT_ORDER: readonly FoldableLane[] = ['canceled', 'completed']
/** Linear state names that only repeat their column. */
const PLAIN_STATES = new Set(['backlog', 'todo', 'in progress', 'done', 'canceled', 'cancelled', 'triage'])

const stageName = (stage: Stage): string => t(`stage.${stage}` as BoardKey)
/** The repository filter, unless that repository is no longer registered. */
const repoKnownOf = (repo: string, repos: readonly { key: string }[]): string => (repo === '' || repos.some((group) => samePath(group.key, repo)) ? repo : '')
const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** A moment in the activity: month, day and time, the year only when it is not this one. */
const when = (at: string): string => {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(isEnglish() ? 'en' : 'zh-CN', {
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
/** A pull request's short name for a chip: `#123`, else its label. */
const prName = (pr: PullRequest): string => (pr.number === undefined ? pr.label : `#${pr.number}`)
const NO_PULLS: readonly PullRequest[] = []
const NO_PROJECTS: readonly ProjectInfo[] = []
const NO_ISSUES: readonly SentryIssue[] = []
/** What a new session on a card starts with in its composer. */
const draftOf = (card: Card): string => card.source === 'linear'
  ? t('draftLinear', { id: card.id, title: card.title, url: card.url ?? '' }).trim()
  : card.note === undefined ? card.title : t('draftLocal', { title: card.title, note: card.note })
/** Start work on a card and go to its workspace: a new worktree's session opens with the card in its composer. */
async function startCard(store: BoardStore, card: Card, repo: string, open: BoardFace['openWorkspace']): Promise<boolean> {
  const result = await store.start(card, repo)
  if (result === undefined) return false
  if (result.workspaceId !== undefined) open?.(result.workspaceId, result.created ? draftOf(card) : undefined)
  return true
}

/** How long the pointer rests on a ticket (or an issue) before its pull request is brought into view: sweeping past scrolls nothing. */
const REST_MS = 250

/**
 * Hovering or focusing a card outlines the cards linked to it across the columns (`data-link`,
 * {@link pairLink}): a pull request, its Linear ticket and the Sentry issues it fixes. Attributes
 * on a few elements, no render. Resting on a ticket or an issue with a mouse or pen, or reaching it
 * from the keyboard, then hands its link to `onRest`; nothing while a card is dragged.
 */
function usePairing(onRest: (link: string) => void): {
  onPointerOver(event: { target: EventTarget; currentTarget: HTMLElement; pointerType: string }): void
  onPointerLeave(event: { currentTarget: HTMLElement }): void
  onFocus(event: { target: EventTarget; currentTarget: HTMLElement }): void
  onBlur(event: { relatedTarget: EventTarget | null; currentTarget: HTMLElement }): void
} {
  const current = useRef<Element | null>(null)
  const resting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(resting.current), [])
  const mark = (target: EventTarget | null, root: HTMLElement, rest = false): void => {
    const card = target instanceof Element ? target.closest<HTMLElement>('[data-link]') : null
    if (card === current.current) return
    current.current = card
    clearTimeout(resting.current)
    for (const element of root.querySelectorAll('[data-pair]')) element.removeAttribute('data-pair')
    const links = card?.dataset.link?.split(' ').filter(Boolean) ?? []
    if (links.length === 0) return
    const linked = links.map((link) => `[data-link~="${CSS.escape(link)}"]`).join(',')
    for (const element of root.querySelectorAll(linked)) if (element !== card) element.setAttribute('data-pair', '')
    if (rest && !card!.classList.contains('rv-card')) resting.current = setTimeout(() => { if (dragging === undefined) onRest(links[0]!) }, REST_MS)
  }
  return {
    onPointerOver: (event) => mark(event.target, event.currentTarget, event.pointerType === 'mouse' || event.pointerType === 'pen'),
    onPointerLeave: (event) => mark(null, event.currentTarget),
    onFocus: (event) => mark(event.target, event.currentTarget, event.target instanceof Element && event.target.matches(':focus-visible')),
    onBlur: (event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) mark(null, event.currentTarget) },
  }
}

/** The card being dragged, shared by the columns (dataTransfer is unreadable during dragover). */
let dragging: Card | undefined

export function BoardPanelIcon(props: { size: number; active?: boolean }): ReactNode {
  return (
    <svg data-dsh-panel-entry={BOARD_PANEL_ID} viewBox="0 0 16 16" width={props.size} height={props.size} fill="none"
      stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="6.25" y="2.5" width="3.5" height="7" rx="1" />
      <rect x="10.5" y="2.5" width="3.5" height="9" rx="1" />
    </svg>
  )
}

/** The page's width; undefined until it is measured. */
function usePageWidth(ref: React.RefObject<HTMLElement>): number | undefined {
  const [width, setWidth] = useState<number | undefined>()
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => { if (entry !== undefined) setWidth(Math.round(entry.contentRect.width)) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export function BoardPage(props: BoardFace): ReactNode {
  const { store } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { data, filters } = snapshot
  const page = useRef<HTMLDivElement>(null)
  const columns = useRef<HTMLDivElement>(null)
  const width = usePageWidth(page)
  const narrow = width !== undefined && width < NARROW_PX
  const [selected, setSelected] = useState<string | undefined>()
  /** The column a new ticket is being written for. */
  const [drafting, setDrafting] = useState<Stage | undefined>()
  const [folded, setFolded] = useState<Set<FoldableLane>>(readFolded)
  const [tab, setTab] = useState<Lane>('unstarted')
  const alerts = props.alerts
  const alerting = useAlerts(alerts)
  const review = props.review
  const reviewing = useReview(review)
  const repos = snapshot.repos
  // A repository that is no longer registered falls back to all (once the repositories are read).
  const repoKnown = filters.repo === '' || repos.some((group) => samePath(group.key, filters.repo))
  const shown = repoKnown ? filters.repo : ''
  // Each zone's repositories: as its service last answered, else as last seen; a service that cannot be asked has none.
  const alertsBinding = useBinding(ALERTS_BINDING_KEY, alerts === undefined ? null
    : alerting.state === undefined ? (alerting.notice !== null ? null : undefined)
    : alerting.state.enabled ? (alerting.state.repo === undefined ? [] : [alerting.state.repo]) : null)
  const reviewBinding = useBinding(REVIEW_BINDING_KEY, review === undefined ? null
    : reviewing.state === undefined ? (reviewing.notice !== null ? null : undefined)
    : reviewing.state.enabled ? reviewing.state.repos ?? [] : null)
  const alertsOn = boundTo(alertsBinding, shown)
  const reviewOn = boundTo(reviewBinding, shown)
  const linearAccounts = data?.accounts.linear
  const linearOn = linearAccounts !== undefined && (shown === '' ? linearAccounts.length > 0 : accountFor(linearAccounts, shown, samePath) !== undefined)
  const lanes = useMemo<Lane[]>(() => [...(alertsOn ? ['alerts' as const] : []), ...(reviewOn ? ['review' as const] : []), ...STAGES], [alertsOn, reviewOn])
  /** The lane last opened by hand: folding to fit leaves it open. */
  const [opened, setOpened] = useState<FoldableLane | undefined>()
  /** What shows folded: as folded by hand, 已完成 while the alerts show, and then whatever fitting the page takes. */
  const shut = useMemo(() => {
    const out = new Set(folded)
    if (!alertsOn) out.delete('alerts')
    else if (!out.has('alerts')) out.add('completed')
    if (width === undefined || narrow) return out
    const zones = 1 + (alertsOn ? 1 : 0) + (reviewOn ? 1 : 0)
    const need = (): number => PAD_PX + GAP_PX * (lanes.length - 1) + (ZONE_GAP_PX - GAP_PX) * (zones - 1)
      + lanes.reduce((sum, lane) => sum + (out.has(lane as FoldableLane) ? FOLDED_PX : lane === 'alerts' ? ALERTS_PX : LANE_PX), 0)
    for (const lane of FIT_ORDER) {
      if (need() <= width) break
      if (lane !== opened) out.add(lane)
    }
    return out
  }, [folded, alertsOn, width, narrow, lanes, opened])

  useEffect(() => {
    void store.load()
    void alerts?.store.load()
    void review?.store.load()
    const wake = (): void => {
      if (document.visibilityState !== 'visible') return
      void store.load()
      void review?.store.load()
    }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [store, alerts, review])

  // Before the search: it is applied below, to the tickets and pull requests together.
  // Without Linear here there are no projects: a project picked elsewhere does not hide the local tasks.
  const unsearched = useMemo(() => store.visible(linearOn, false), [store, data, filters.repo, filters.project, snapshot.repos, linearOn])
  const repoItems = useMemo(() => visibleItems(reviewing.state?.items ?? [], repoKnownOf(filters.repo, snapshot.repos)), [reviewing.state, filters.repo, snapshot.repos])
  const tickets = useMemo(() => ticketsOf(repoItems, unsearched), [repoItems, unsearched])
  const allIssues = alerting.state?.issues ?? NO_ISSUES
  const linkedAlerts = useMemo(() => alertsOf(repoItems, allIssues), [repoItems, allIssues])
  // The other way round: the pull requests fixing each issue, for its card and detail.
  const issuePulls = useMemo<IssuePulls>(() => {
    const out = new Map<string, ReviewItem[]>()
    for (const item of repoItems) for (const issue of linkedAlerts.get(item.key) ?? []) out.set(issue.id, [...out.get(issue.id) ?? [], item])
    return out
  }, [repoItems, linkedAlerts])
  // The search keeps a pull request, its ticket and its issues together: any one found shows those linked to it.
  const query = filters.query.trim().toLowerCase()
  const reviewItems = useMemo(() => (query === '' ? repoItems : repoItems.filter((item) => {
    const ticket = tickets.get(item.key)
    return itemMatches(item, query) || (ticket !== undefined && cardMatches(ticket, query))
      || (linkedAlerts.get(item.key)?.some((issue) => issueMatches(issue, query)) ?? false)
  })), [query, repoItems, tickets, linkedAlerts])
  // The tickets of the pull requests found, as one key: a poll that finds the same leaves the columns be.
  const paired = query === '' ? '' : [...new Set(reviewItems.flatMap((item) => tickets.get(item.key)?.key ?? []))].sort().join('\n')
  const cards = useMemo(() => {
    if (query === '') return unsearched
    const keys = new Set(paired.split('\n'))
    return unsearched.filter((card) => keys.has(card.key) || cardMatches(card, query))
  }, [query, unsearched, paired])
  // Sentry's issues as its own filters fetched them, narrowed by the same search; the issues of the pull requests found stay.
  const pairedIssues = query === '' ? '' : [...new Set(reviewItems.flatMap((item) => linkedAlerts.get(item.key)?.map((issue) => issue.id) ?? []))].sort().join('\n')
  const alertIssues = useMemo(() => {
    if (query === '') return allIssues
    const ids = new Set(pairedIssues.split('\n'))
    return allIssues.filter((issue) => ids.has(issue.id) || issueMatches(issue, query))
  }, [query, allIssues, pairedIssues])
  const revealPull = useRef<RevealPull | undefined>(undefined)
  /** Whatever their project: what the project filter counts. */
  const anyProject = useMemo(() => store.visible(false), [store, data, filters, snapshot.repos])
  const projectList = data?.projects ?? NO_PROJECTS
  const projects = useMemo(() => new Map(projectList.map((project) => [project.name, project])), [projectList])
  const allProjectsUrl = useMemo(() => projectsUrl(data?.cards ?? []), [data])
  const setProject = useCallback((project: string) => store.setFilters({ project }), [store])
  // A project no longer in Linear, nor on any card, falls back to all (once the projects are read).
  const projectKnown = filters.project === '' || projects.has(filters.project) || (data?.cards.some((item) => item.project === filters.project) ?? true)
  useEffect(() => { if (projects.size > 0 && !projectKnown) store.setFilters({ project: '' }) }, [projects, projectKnown, store])
  const byStage = useMemo(() => {
    const out = new Map<Stage, Card[]>(STAGES.map((stage) => [stage, []]))
    for (const card of cards) out.get(card.stage)!.push(card)
    for (const [stage, list] of out) out.set(stage, sortCards(list))
    return out
  }, [cards])
  const card = useMemo(() => store.card(selected), [store, selected, data, snapshot.repos, filters.repo])
  // A pull request stacked with the list's opens like one of them.
  const reviewItem = selected?.startsWith(REVIEW_PREFIX)
    ? [...reviewing.state?.items ?? [], ...reviewing.state?.related ?? []].find((item) => REVIEW_PREFIX + item.key === selected)
    : undefined
  const alertItem = selected?.startsWith(ALERT_PREFIX) ? alerting.state?.issues.find((item) => ALERT_PREFIX + item.id === selected) : undefined
  const repoKeys = useMemo(() => repos.map((group) => group.key), [repos])
  const openWorkspace = props.openWorkspace
  /** A working tree's workspace, by its path: a review lane card of mine goes where its branch is worked on. */
  const openTree = useMemo(() => (openWorkspace === undefined ? undefined : (path: string) => {
    const member = repos.flatMap((group) => group.members).find((entry) => samePath(entry.path, path))
    if (member !== undefined) openWorkspace(member.workspaceId)
  }), [openWorkspace, repos])
  useEffect(() => { if (repos.length > 0 && !repoKnown) store.setFilters({ repo: '' }) }, [repos, repoKnown, store])
  const starting = useMemo(() => new Set(snapshot.starting), [snapshot.starting])
  const cardActions: CardActions = {
    starting,
    candidates: (item) => startRepos(item, shown, repoKeys, samePath),
    start: (item, repo) => { void startCard(store, item, repo, props.openWorkspace) },
    projects,
    project: linearOn ? filters.project : '',
    onProject: (name) => setProject(filters.project === name ? '' : name),
    ...(props.openWorkspace === undefined ? {} : { open: props.openWorkspace }),
  }

  const setLaneOpen = (lane: FoldableLane, open: boolean): void => {
    setOpened(open ? lane : (current) => (current === lane ? undefined : current))
    setFolded((current) => {
      const next = new Set(current)
      if (open) next.delete(lane); else next.add(lane)
      // The alerts and 已完成 take turns: opening 已完成 folds the alerts (opening the alerts folds 已完成 as it shows).
      if (open && lane === 'completed' && alertsOn) next.add('alerts')
      if (open && lane === 'alerts') next.delete('completed')
      try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])) } catch { /* not remembered */ }
      return next
    })
  }

  // Narrow: the tabs follow the swipe, and a tab scrolls its column in.
  const pairing = usePairing(useCallback((link: string) => revealPull.current?.(link), []))
  /** An issue's pull request: its review opens, its card comes into view in the lane. */
  const openPull = (key: string, issue: string): void => {
    select(REVIEW_PREFIX + key)
    revealPull.current?.(pairLink('sentry', issue))
  }
  const onScroll = useCallback(() => {
    const element = columns.current
    if (!narrow || element === null || element.clientWidth === 0) return
    const index = Math.round(element.scrollLeft / element.clientWidth)
    const lane = lanes[Math.min(Math.max(index, 0), lanes.length - 1)]!
    setTab((current) => (current === lane ? current : lane))
  }, [narrow, lanes])
  const showTab = (lane: Lane): void => {
    setTab(lane)
    const element = columns.current
    const index = Math.max(0, lanes.indexOf(lane))
    element?.scrollTo({ left: index * element.clientWidth, behavior: 'smooth' })
  }
  // Entering the narrow layout (or the review lane appearing) lands on the current tab.
  useEffect(() => {
    if (!narrow) return
    const element = columns.current
    if (element !== null) element.scrollLeft = Math.max(0, lanes.indexOf(tab)) * element.clientWidth
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, lanes])

  const newTask = (stage: Stage = narrow && tab !== 'review' && tab !== 'alerts' ? tab : 'unstarted'): void => {
    setSelected(undefined)
    setDrafting(stage)
  }
  const select = (key: string | undefined): void => {
    setDrafting(undefined)
    setSelected(key)
  }

  const accounts = data?.linear.accounts ?? 0
  // The tickets' zone: its filters (Linear's), or why there are none; and 新建, for this zone only.
  const ticketTools = linearOn
    ? (
      <>
        <div className="ah-seg" role="radiogroup" aria-label={t('scope')}>
          <button type="button" role="radio" aria-checked={filters.mine} onClick={() => store.setFilters({ mine: true })}>{t('mine')}</button>
          <button type="button" role="radio" aria-checked={!filters.mine} onClick={() => store.setFilters({ mine: false })}>{t('everyone')}</button>
        </div>
        <ProjectFilter cards={anyProject} projects={projects} value={filters.project} url={allProjectsUrl} onChange={setProject} />
      </>
    )
    : data !== undefined && (
      <p className="ab-zone-note">
        <span className="ab-zone-note-text">{t(accounts === 0 ? 'linearOff' : 'repoNoLinear')}</span>
        {props.openSettings !== undefined && (
          <button type="button" className="ab-link" onClick={props.openSettings}>{t(accounts === 0 ? 'connectLinear' : 'linearSettings')}</button>
        )}
      </p>
    )
  const newButton = (
    <button type="button" className="ah-btn ah-btn-sm ab-new" data-variant="primary" title={t('newTask')} onClick={() => newTask()}>
      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 2v8M2 6h8" /></svg>
      <span>{t('newShort')}</span>
    </button>
  )
  const searchKey: BoardKey = alertsOn ? 'searchAlerts' : 'search'
  const zoneOf = linearOn ? 'linear' as const : 'local' as const
  const openStages = STAGES.filter((stage) => narrow || !((stage === 'completed' || stage === 'canceled') && shut.has(stage))).length
  return (
    <div className="ab-page" ref={page} data-narrow={narrow ? '' : undefined}>
      <header className="ab-bar">
        <h2 className="ab-sr">{t('panel')}</h2>
        <select className="ab-select" aria-label={t('repo')} value={repoKnown ? filters.repo : ''}
          onChange={(event) => store.setFilters({ repo: event.target.value })}>
          <option value="">{t('allRepos')}</option>
          {repos.map((group) => <option key={group.key} value={group.key}>{group.name}</option>)}
        </select>
        <label className="ab-search-wrap">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
          </svg>
          <input className="ab-search" type="search" value={filters.query} placeholder={t(searchKey)} aria-label={t(searchKey)} title={t(searchKey)}
            onChange={(event) => store.setFilters({ query: event.target.value })} />
        </label>
        <button type="button" className="ah-icon-btn" aria-label={t('refresh')} title={t('refresh')} data-busy={snapshot.loading ? '' : undefined}
          onClick={() => {
            void store.load(true)
            void alerts?.store.load(true)
            void review?.store.load(true)
          }}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
        </button>
      </header>

      {data?.linear.errors.map((error) => <p key={error} className="ab-banner" role="alert">{t('linearError', { message: error })}</p>)}
      {snapshot.error !== null && <p className="ab-banner" role="alert">{t('failed', { message: snapshot.error })}</p>}
      {snapshot.notice !== null && (
        <p className="ab-banner" role="alert">
          {snapshot.notice}
          <button type="button" className="ab-link" onClick={() => store.dismiss()}>{t('close')}</button>
        </p>
      )}
      {alerting.undo !== undefined && (
        <p className="ab-hint-bar" role="status">
          {isEnglish() ? `${alerting.undo.id} resolved.` : `已解决 ${alerting.undo.id}。`}
          <button type="button" className="ab-link" onClick={() => { if (alerting.undo) void alerts?.store.undoResolve(alerting.undo) }}>{isEnglish() ? 'Undo' : '撤销'}</button>
        </p>
      )}
      {alerting.notice !== null && (
        <p className="ab-banner" role="alert">
          {alerting.notice}
          <button type="button" className="ab-link" onClick={() => alerts?.store.dismiss()}>{t('close')}</button>
        </p>
      )}
      {reviewing.notice !== null && (
        <p className="ab-banner" role="alert">
          {reviewing.notice}
          <button type="button" className="ab-link" onClick={() => review?.store.dismiss()}>{t('close')}</button>
        </p>
      )}

      {narrow && (
        <nav className="ab-tabs" role="tablist" aria-label={t('state')}>
          {lanes.map((lane, index) => (
            <button key={lane} type="button" role="tab" aria-selected={tab === lane} data-stage={lane}
              data-zone-start={index > 0 && lane === STAGES[0] ? '' : undefined} onClick={() => showTab(lane)}>
              {lane === 'alerts' || lane === 'review' ? <ZoneMark zone={lane} /> : <span className="ab-dot" aria-hidden="true" />}
              {lane === 'alerts' ? (isEnglish() ? 'Alerts' : '告警') : lane === 'review' ? reviewT(reviewing.scope === 'all' ? 'laneAll' : reviewing.scope === 'own' ? 'laneOwn' : 'lane') : stageName(lane)}
              <span className="ab-count">{lane === 'alerts' ? alerting.state === undefined ? '' : alertIssues.length : lane === 'review' ? reviewItems.length : byStage.get(lane)!.length}</span>
            </button>
          ))}
        </nav>
      )}

      {data === undefined && snapshot.error === null
        ? <p className="ab-loading" role="status">{t('loading')}</p>
        : (
          <div className="ab-columns" ref={columns} onScroll={onScroll} {...pairing}>
            {alertsOn && alerts !== undefined && (
              <AlertsColumn face={alerts} snapshot={alerting} issues={alertIssues} query={filters.query} onClearQuery={() => store.setFilters({ query: '' })} narrow={narrow} folded={!narrow && shut.has('alerts')} onFold={(open) => setLaneOpen('alerts', open)} selected={selected} onSelect={select}
                pulls={issuePulls} onPull={openPull} />
            )}
            {reviewOn && review !== undefined && (
              <ReviewColumn face={review} snapshot={reviewing} items={reviewItems} tickets={tickets} alerts={linkedAlerts} revealRef={revealPull} narrow={narrow} showRepo={filters.repo === ''}
                selected={selected} onSelect={select} {...(openTree === undefined ? {} : { onWorkspace: openTree })} />
            )}
            <Zone zone={zoneOf}
              style={narrow ? undefined : {
                flexGrow: openStages,
                flexBasis: openStages * LANE_PX + (STAGES.length - openStages) * FOLDED_PX + (STAGES.length - 1) * GAP_PX,
                maxWidth: openStages * LANE_MAX_PX + (STAGES.length - openStages) * FOLDED_PX + (STAGES.length - 1) * GAP_PX,
              }}
              head={!narrow && <ZoneHead zone={zoneOf} title={t(linearOn ? 'zoneLinear' : 'zoneLocal')} count={cards.length} actions={newButton} tools={ticketTools} />}>
              {STAGES.map((stage) => (
                <Column key={stage} stage={stage} cards={byStage.get(stage)!} store={store} narrow={narrow}
                  folded={!narrow && (stage === 'completed' || stage === 'canceled') && shut.has(stage)} onFold={(open) => { if (stage === 'completed' || stage === 'canceled') setLaneOpen(stage, open) }}
                  selected={selected} onSelect={select} actions={cardActions} pulls={snapshot.pulls}
                  showRepo={filters.repo === ''}
                  drafting={drafting === stage}
                  bar={narrow ? <>{ticketTools}<span className="ab-grow" />{newButton}</> : undefined}
                  onNew={() => newTask(stage)} />
              ))}
            </Zone>
          </div>
        )}

      {alertItem !== undefined && alerts !== undefined && (
        <AlertDetail key={alertItem.id} face={alerts} issue={alertItem} narrow={narrow} onClose={() => setSelected(undefined)}
          pulls={issuePulls.get(alertItem.id)} onPull={(key) => openPull(key, alertItem.id)} />
      )}
      {reviewItem !== undefined && review !== undefined && (
        <ReviewDetail key={reviewItem.key} face={review} item={reviewItem} narrow={narrow} onClose={() => setSelected(undefined)} onOpen={select} />
      )}
      {card !== undefined && (
        <Detail key={card.key} card={card} store={store} narrow={narrow} repos={repoKeys} candidates={cardActions.candidates(card)}
          pulls={snapshot.pulls.get(card.key)} project={card.project === undefined ? undefined : projects.get(card.project)}
          projectActive={card.project !== undefined && filters.project === card.project} onProject={setProject}
          starting={starting.has(card.key)} openWorkspace={props.openWorkspace} onClose={() => setSelected(undefined)} />
      )}
      {drafting !== undefined && (
        <NewTicket store={store} stage={drafting} repos={repoKeys} repo={shown} accounts={data?.accounts} bots={data?.bots ?? []} narrow={narrow}
          onClose={() => setDrafting(undefined)}
          onCreated={(key) => {
            setDrafting(undefined)
            // Its detail, once the board has it (a Linear ticket assigned to someone else is not under 我的).
            setSelected(key)
          }} />
      )}
    </div>
  )
}

function Column(props: {
  stage: Stage
  cards: Card[]
  store: BoardStore
  narrow: boolean
  folded: boolean
  onFold(open: boolean): void
  selected: string | undefined
  onSelect(key: string): void
  actions: CardActions
  pulls: BoardSnapshot['pulls']
  showRepo: boolean
  /** A new ticket is being written for this column. */
  drafting: boolean
  /** Narrow: the zone's filters and 新建, atop the column. */
  bar?: ReactNode
  onNew(): void
}): ReactNode {
  const { stage, cards, store } = props
  const [drop, setDrop] = useState(false)
  const accepts = (): boolean => dragging !== undefined && dragging.stage !== stage
  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDrop(false)
    const card = dragging
    dragging = undefined
    if (card !== undefined && card.stage !== stage) void store.move(card, stage)
  }
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!accepts()) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDrop(true)
    },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(false) },
    onDrop,
  }
  if (props.folded) {
    return (
      <section className="ab-col" data-stage={stage} data-folded="" data-drop={drop ? '' : undefined} aria-label={stageName(stage)} {...dropProps}>
        <button type="button" className="ab-col-folded" title={`${isEnglish() ? 'Show' : '展开'} ${stageName(stage)}`} aria-label={`${isEnglish() ? 'Show' : '展开'} ${stageName(stage)} · ${cards.length}`} onClick={() => props.onFold(true)}>
          <span className="ab-dot" aria-hidden="true" />
          <span className="ab-col-folded-name">{stageName(stage)}</span>
          <span className="ab-count">{cards.length}</span>
        </button>
      </section>
    )
  }
  return (
    <section className="ab-col" data-stage={stage} data-drop={drop ? '' : undefined} aria-label={stageName(stage)} {...dropProps}>
      {!props.narrow && (
        <header className="ab-col-head">
          <span className="ab-dot" aria-hidden="true" />
          <h3>{stageName(stage)}</h3>
          <span className="ab-count">{cards.length}</span>
          <span className="ab-grow" />
          {(stage === 'completed' || stage === 'canceled') && (
            <button type="button" className="ah-icon-btn ah-icon-sm" title={`${isEnglish() ? 'Collapse' : '折叠'} ${stageName(stage)}`} aria-label={`${isEnglish() ? 'Collapse' : '折叠'} ${stageName(stage)}`} onClick={() => props.onFold(false)}>
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
            </button>
          )}
          <button type="button" className="ah-icon-btn ah-icon-sm" title={t('newTaskIn', { stage: stageName(stage) })} aria-label={t('newTaskIn', { stage: stageName(stage) })}
            aria-pressed={props.drafting} onClick={props.onNew}>
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M6 2v8M2 6h8" /></svg>
          </button>
        </header>
      )}
      <div className="ab-col-body">
        {props.bar !== undefined && <div className="ab-lane-bar">{props.bar}</div>}
        {cards.map((card) => (
          <CardView key={card.key} card={card} selected={props.selected === card.key} showRepo={props.showRepo} actions={props.actions}
            pulls={props.pulls.get(card.key) ?? NO_PULLS} onOpen={() => props.onSelect(card.key)} />
        ))}
        {cards.length === 0 && <p className="ab-empty">{drop ? t('emptyDrop') : t('empty')}</p>}
      </div>
    </section>
  )
}

/** What a card can do besides opening its detail. */
interface CardActions {
  starting: ReadonlySet<string>
  /** The repositories a card can be started in. */
  candidates(card: Card): string[]
  start(card: Card, repo: string): void
  /** Go to a workspace; absent without workspace navigation. */
  open?: (workspaceId: string) => void
  /** Linear's projects by name, the one the board shows (empty: all), and showing only one (again: all). */
  projects: ReadonlyMap<string, ProjectInfo>
  project: string
  onProject(name: string): void
}

/** Keeps a click or key press on a card's own controls from opening the card. */
const own = {
  onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
  onKeyDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
}

function TreeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="3" cy="2.5" r="1.3" /><circle cx="3" cy="9.5" r="1.3" /><circle cx="9" cy="4" r="1.3" /><path d="M3 3.8v4.4M9 5.3c0 2-2.5 2.2-6 3" />
    </svg>
  )
}

/** A card's pull requests: one is a link to it; several show their count and open the detail. */
function PullChip(props: { pulls: readonly PullRequest[] }): ReactNode {
  const { pulls } = props
  if (pulls.length === 1) {
    const pr = pulls[0]!
    return (
      <a className="ab-chip" data-pr="" href={pr.url} target="_blank" rel="noopener noreferrer" draggable={false}
        title={t('prHint', { label: pr.title === undefined ? pr.label : `${pr.label} ${pr.title}` })} {...own}>
        <PullIcon />{prName(pr)}
      </a>
    )
  }
  return <span className="ab-chip" data-pr="" title={t('prsHint', { labels: pulls.map((pr) => pr.label).join(', ') })}><PullIcon />{t('prCount', { n: pulls.length })}</span>
}

/** The tail of a branch, for a chip: `vi/eng-123-fix-login` → `eng-123-fix-login`. */
const branchTail = (branch: string): string => branch.split('/').pop() || branch

/** "开始" on a card: straight away when one repository fits, else a menu of them (a bottom sheet when narrow). */
function StartButton(props: { card: Card; candidates: string[]; onStart(repo: string): void }): ReactNode {
  const { candidates } = props
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => { if (!wrap.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  const many = candidates.length > 1
  const label = many ? t('start') : t('startInRepo', { repo: repoName(candidates[0]!) })
  return (
    <div className="ab-go-wrap" ref={wrap} {...own} draggable onDragStart={(event) => { event.preventDefault(); event.stopPropagation() }}>
      <button type="button" className="ab-go" title={`${label} · ${t('startHint')}`} aria-label={`${label}: ${props.card.title}`}
        aria-haspopup={many ? 'menu' : undefined} aria-expanded={many ? open : undefined}
        onClick={() => (many ? setOpen(!open) : props.onStart(candidates[0]!))}>
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M2.5 1.5v7l6-3.5z" fill="currentColor" /></svg>
        {t('start')}
      </button>
      {open && (
        <div className="ab-menu" role="menu" aria-label={t('startIn')}>
          <span className="ab-menu-title">{t('startIn')}</span>
          {candidates.map((repo) => (
            <button key={repo} type="button" role="menuitem" title={repo} onClick={() => { setOpen(false); props.onStart(repo) }}>{repoName(repo)}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function CardView(props: { card: Card; selected: boolean; showRepo: boolean; actions: CardActions; pulls: readonly PullRequest[]; onOpen(): void }): ReactNode {
  const { card, actions } = props
  const extraState = card.source === 'linear' && card.state !== undefined && !PLAIN_STATES.has(card.state.toLowerCase())
  const repo = props.showRepo && card.source === 'local' ? repoName(card.repos[0] ?? '') : undefined
  const busy = actions.starting.has(card.key)
  const tree = busy ? undefined : card.workspace
  // Finished work is not started from its card; the detail still can.
  const candidates = tree !== undefined || busy || card.stage === 'completed' || card.stage === 'canceled' ? [] : actions.candidates(card)
  const open = actions.open
  return (
    <article className="ab-card" data-source={card.source} data-selected={props.selected ? '' : undefined}
      data-link={card.source === 'linear' ? pairLink('linear', card.id) : undefined}
      tabIndex={0} role="button" aria-label={`${card.source === 'linear' ? card.id : t('local')} ${card.title}`} title={t('dragHint')}
      draggable
      onDragStart={(event) => {
        dragging = card
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', card.source === 'linear' ? `${card.id} ${card.title}` : card.title)
      }}
      onDragEnd={() => { dragging = undefined }}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}>
      <div className="ab-card-top">
        {card.source === 'linear'
          ? <span className="ab-id"><LinearMark />{card.id}</span>
          : <span className="ab-id" data-local="" title={t('localHint')}>{t('local')}</span>}
        <span className="ab-grow" />
        {card.priority !== undefined && card.priority > 0 && <PriorityMark priority={card.priority} />}
      </div>
      <p className="ab-card-title">{card.title}</p>
      {(extraState || tree !== undefined || busy || repo !== undefined || card.assignee !== undefined || candidates.length > 0
        || card.project !== undefined || props.pulls.length > 0) && (
        <div className="ab-card-meta">
          {extraState && <span className="ab-chip">{card.state}</span>}
          {props.pulls.length > 0 && <PullChip pulls={props.pulls} />}
          {card.project !== undefined && (
            <button type="button" className="ab-chip" data-project="" data-muted="" aria-pressed={actions.project === card.project}
              title={t(actions.project === card.project ? 'projectChipOn' : 'projectChipHint', { project: card.project })}
              onKeyDown={own.onKeyDown} onClick={(event) => { event.stopPropagation(); actions.onProject(card.project!) }}>
              <ProjectDot name={card.project} project={actions.projects.get(card.project)} /><span className="ab-chip-text">{card.project}</span>
            </button>
          )}
          {busy && <span className="ab-chip" data-busy="" role="status">{t('creating')}</span>}
          {tree !== undefined && (open === undefined
            ? <span className="ab-chip" data-tree="" title={tree.branch}><TreeIcon />{branchTail(tree.branch)}</span>
            : (
              <button type="button" className="ab-chip" data-tree="" title={t('openTreeHint', { branch: tree.branch })}
                onKeyDown={own.onKeyDown} onClick={(event) => { event.stopPropagation(); open(tree.id) }}>
                <TreeIcon />{branchTail(tree.branch)}
              </button>
            ))}
          {repo !== undefined && repo !== '' && <span className="ab-chip" data-muted="">{repo}</span>}
          <span className="ab-grow" />
          {card.assignee !== undefined && <span className="ab-avatar" title={card.assignee}>{card.assignee.slice(0, 1).toUpperCase()}</span>}
          {candidates.length > 0 && <StartButton card={card} candidates={candidates} onStart={(where) => actions.start(card, where)} />}
        </div>
      )}
    </article>
  )
}

function StatePicker(props: { card: Card; store: BoardStore }): ReactNode {
  const { card, store } = props
  const [states, setStates] = useState<IssueState[] | undefined>(card.source === 'local' ? [] : undefined)
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    if (card.source === 'local') return
    let live = true
    store.states(card).then((value) => { if (live) setStates(value) }, (failure: unknown) => { if (live) setError(message(failure)) })
    return () => { live = false }
  }, [store, card.source, card.connector, card.team])
  if (card.source === 'local') {
    return (
      <select className="ab-select" data-stage={card.stage} aria-label={t('state')} value={card.stage}
        onChange={(event) => void store.move(card, event.target.value as Stage)}>
        {STAGES.map((stage) => <option key={stage} value={stage}>{stageName(stage)}</option>)}
      </select>
    )
  }
  if (states === undefined || states.length === 0) {
    return <span className="ab-muted">{error ?? (states === undefined ? t('stateLoading') : card.state ?? stageName(card.stage))}</span>
  }
  const current = states.find((state) => state.name === card.state)
  return (
    <select className="ab-select" data-stage={card.stage} aria-label={t('state')} value={current?.id ?? ''}
      onChange={(event) => {
        const state = states.find((item) => item.id === event.target.value)
        if (state !== undefined) void store.move(card, stageOf(state.type), state)
      }}>
      {current === undefined && <option value="">{card.state ?? stageName(card.stage)}</option>}
      {STAGES.map((stage) => {
        const group = states.filter((state) => stageOf(state.type) === stage)
        return group.length === 0 ? null : (
          <optgroup key={stage} label={stageName(stage)}>
            {group.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}
          </optgroup>
        )
      })}
    </select>
  )
}

function Detail(props: {
  card: Card
  store: BoardStore
  narrow: boolean
  repos: string[]
  /** The repositories it can be started in. */
  candidates: string[]
  starting: boolean
  /** Its pull requests as the card shows them, until the detail's own read lands. */
  pulls: readonly PullRequest[] | undefined
  /** Its project as Linear describes it, and whether the board shows only that project. */
  project: ProjectInfo | undefined
  projectActive: boolean
  onProject(project: string): void
  openWorkspace: BoardFace['openWorkspace']
  onClose(): void
}): ReactNode {
  const { card, store, onClose, candidates, starting } = props
  const [confirming, setConfirming] = useState(false)
  const [where, setWhere] = useState(candidates[0] ?? '')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    panel.current?.focus()
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = props.openWorkspace
  const start = async (): Promise<void> => {
    if (where === '' || starting) return
    if (await startCard(store, card, where, open) && open !== undefined) onClose()
  }

  return (
    <>
      <div className="ab-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="ab-detail" ref={panel} tabIndex={-1} role="dialog" aria-modal={props.narrow} aria-label={card.title} data-source={card.source}>
        <header className="ab-detail-head">
          {card.source === 'linear'
            ? <span className="ab-id"><LinearMark />{card.id}</span>
            : <span className="ab-id" data-local="" title={t('localHint')}>{t('local')}</span>}
          <span className="ab-grow" />
          {card.url !== undefined && <>
            <CopyButton className="ab-copy" text={card.url} label={t('copyLink')} copied={t('copied')} hotkey={COPY_LINK_KEY} icon={<LinkIcon />} />
            <a className="ab-link" href={card.url} target="_blank" rel="noopener noreferrer">{t('openLinear')} ↗</a>
          </>}
          <button type="button" className="ah-icon-btn" aria-label={t('close')} title={t('close')} onClick={onClose}>
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" /></svg>
          </button>
        </header>
        <div className="ab-detail-body">
          {card.source === 'local'
            ? (
              <textarea className="ab-title-input" rows={2} defaultValue={card.title} aria-label={t('taskTitle')} maxLength={300}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim()
                  if (next !== '' && next !== card.title) void store.update(card, { title: next })
                }} />
            )
            : <h3 className="ab-detail-title">{card.title}</h3>}
          <dl className="ab-props">
            <dt>{t('state')}</dt>
            <dd><StatePicker card={card} store={store} /></dd>
            <dt>{t('repo')}</dt>
            <dd>
              {card.source === 'local' && props.repos.length > 0
                ? (
                  <select className="ab-select" aria-label={t('repo')} value={card.repos[0] ?? ''}
                    onChange={(event) => void store.update(card, { repo: event.target.value })}>
                    {!props.repos.some((key) => samePath(key, card.repos[0] ?? '')) && <option value={card.repos[0] ?? ''}>{repoName(card.repos[0] ?? '')}</option>}
                    {props.repos.map((key) => <option key={key} value={key}>{repoName(key)}</option>)}
                  </select>
                )
                : <span>{card.repos.length === 0 ? t('unlinkedRepos') : card.repos.map(repoName).join(', ')}</span>}
            </dd>
            {card.project !== undefined && (
              <><dt className="ab-dt-top">{t('project')}</dt><dd>
                <ProjectDetail name={card.project} project={props.project} active={props.projectActive}
                  onFilter={(on) => props.onProject(on ? card.project! : '')} />
              </dd></>
            )}
            {card.assignee !== undefined && <><dt>{t('assignee')}</dt><dd>{card.assignee}</dd></>}
            {card.source === 'local'
              ? (
                <><dt>{t('priority')}</dt><dd className="ab-prio-cell">
                  <PriorityMark priority={card.priority ?? 0} />
                  <select className="ab-select" aria-label={t('priority')} value={card.priority ?? 0}
                    onChange={(event) => void store.update(card, { priority: Number(event.target.value) })}>
                    {PRIORITIES.map((value) => <option key={value} value={value}>{t(`priority.${value}` as BoardKey)}</option>)}
                  </select>
                </dd></>
              )
              : card.priority !== undefined && card.priority > 0 && <><dt>{t('priority')}</dt><dd className="ab-prio-cell"><PriorityMark priority={card.priority} />{t(`priority.${card.priority}` as BoardKey)}</dd></>}
            {card.branch !== undefined && <><dt>{t('branch')}</dt><dd><code className="ab-code">{card.branch}</code></dd></>}
          </dl>
          {card.source === 'linear' && <TicketActivity card={card} store={store} pulls={props.pulls} />}
          {card.source === 'local' && (
            <label className="ab-field">
              <span>{t('taskNote')}</span>
              <textarea className="ab-input" rows={5} defaultValue={card.note ?? ''} placeholder={t('taskNotePlaceholder')}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim()
                  if (next !== (card.note ?? '')) void store.update(card, { note: next })
                }} />
            </label>
          )}
        </div>
        <footer className="ab-detail-foot">
          {card.source === 'local' && (
            <button type="button" className="ah-btn" data-variant={confirming ? 'danger' : undefined}
              onClick={() => {
                if (!confirming) return setConfirming(true)
                void store.remove(card)
                onClose()
              }}
              onBlur={() => setConfirming(false)}>
              {confirming ? t('deleteConfirm') : t('delete')}
            </button>
          )}
          <span className="ab-grow" />
          {open !== undefined && (card.workspace !== undefined
            ? (
              <button type="button" className="ah-btn" data-variant="primary" title={t('openTreeHint', { branch: card.workspace.branch })}
                onClick={() => {
                  open(card.workspace!.id)
                  onClose()
                }}>
                {t('openTree')}
              </button>
            )
            : candidates.length === 0
              ? <span className="ab-hint">{t('noRepo')}</span>
              : (
                <div className="ab-start">
                  {candidates.length > 1 && (
                    <select className="ab-select" aria-label={t('startIn')} title={t('startIn')} value={where} onChange={(event) => setWhere(event.target.value)}>
                      {candidates.map((key) => <option key={key} value={key}>{repoName(key)}</option>)}
                    </select>
                  )}
                  <button type="button" className="ah-btn" data-variant="primary" title={t('startHint')} disabled={starting} onClick={() => void start()}>
                    {starting ? t('starting') : t('start')}
                  </button>
                </div>
              ))}
        </footer>
      </aside>
    </>
  )
}

/** A Linear ticket's milestone and labels, pull requests, description and activity, read when its detail opens. */
function TicketActivity(props: { card: Card; store: BoardStore; pulls: readonly PullRequest[] | undefined }): ReactNode {
  const { card, store } = props
  const [detail, setDetail] = useState<IssueDetail | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const latest = useRef(card)
  latest.current = card
  /** The newest read wins; unmounting drops them all. */
  const ticket = useRef(0)
  const read = useCallback((fresh: boolean) => {
    const mine = ++ticket.current
    setLoading(true)
    store.detail(latest.current, fresh).then(
      (value) => { if (ticket.current === mine) { setDetail(value); setError(undefined); setLoading(false) } },
      (failure: unknown) => { if (ticket.current === mine) { setError(message(failure)); setLoading(false) } },
    )
  }, [store])
  // Read again when the ticket changes (the board saw a newer version).
  useEffect(() => {
    read(false)
    return () => { ++ticket.current }
  }, [read, card.updatedAt])

  const pulls = detail?.pullRequests ?? props.pulls
  const description = detail?.description === undefined ? undefined : plainMentions(detail.description).trim()
  const long = description !== undefined && (description.length > 600 || description.split('\n').length > 8)
  return (
    <>
      {detail !== undefined && (detail.milestone !== undefined || detail.labels.length > 0) && (
        <dl className="ab-props">
          {detail.milestone !== undefined && <><dt>{t('milestone')}</dt><dd>{detail.milestone}</dd></>}
          {detail.labels.length > 0 && (
            <><dt>{t('labels')}</dt><dd className="ab-labels">{detail.labels.map((label) => <span key={label} className="ab-chip">{label}</span>)}</dd></>
          )}
        </dl>
      )}
      <section className="ab-section" aria-label={t('pullRequests')}>
        <div className="ab-section-head"><h4>{t('pullRequests')}</h4></div>
        {pulls === undefined
          ? <span className="ab-muted">{t('activityLoading')}</span>
          : pulls.length === 0
            ? <span className="ab-muted">{t('noPullRequests')}</span>
            : (
              <ul className="ab-prs">
                {pulls.map((pr) => (
                  <li key={pr.url}>
                    <a href={pr.url} target="_blank" rel="noopener noreferrer" title={t('prHint', { label: pr.label })}>
                      <span className="ab-pr-label"><PullIcon /> {pr.label}</span>
                      {pr.title !== undefined && <span className="ab-pr-title">{pr.title}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            )}
      </section>
      {description !== undefined && description !== '' && (
        <section className="ab-section" aria-label={t('description')}>
          <div className="ab-section-head">
            <h4>{t('description')}</h4>
            <span className="ab-grow" />
            {long && <button type="button" className="ab-link" onClick={() => setExpanded(!expanded)}>{expanded ? t('showLess') : t('showMore')}</button>}
          </div>
          <p className="ab-text" data-clamped={long && !expanded ? '' : undefined}>{description}</p>
        </section>
      )}
      <section className="ab-section" aria-label={t('activity')} aria-busy={loading}>
        <div className="ab-section-head">
          <h4>{t('activity')}</h4>
          <span className="ab-grow" />
          <button type="button" className="ah-icon-btn ah-icon-sm" aria-label={t('refreshActivity')} title={t('refreshActivity')}
            data-busy={loading ? '' : undefined} onClick={() => { read(true) }}>
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
            </svg>
          </button>
        </div>
        {error !== undefined && <span className="ab-muted" role="alert">{t('activityFailed', { message: error })}</span>}
        {detail === undefined
          ? error === undefined && <span className="ab-muted">{t('activityLoading')}</span>
          : detail.activity.length === 0
            ? <span className="ab-muted">{t('noActivity')}</span>
            : <ol className="ab-timeline">{detail.activity.map((entry, index) => <ActivityEntry key={index} entry={entry} />)}</ol>}
      </section>
    </>
  )
}

function ActivityEntry(props: { entry: Activity }): ReactNode {
  const { entry } = props
  const actor = (entry.kind === 'state' ? undefined : entry.actor) ?? t('someone')
  return (
    <li className="ab-event" data-kind={entry.kind} data-stage={entry.kind === 'state' ? stageOf(entry.stateType) : undefined}
      data-reply={entry.kind === 'comment' && entry.reply ? '' : undefined}>
      <span className="ab-dot" aria-hidden="true" />
      <div className="ab-event-line">
        {entry.kind === 'created' && <span>{t('activity.created', { actor })}</span>}
        {entry.kind === 'state' && <span>{t('activity.state')} <strong>{entry.state}</strong></span>}
        {entry.kind === 'comment' && <span>{t(entry.reply ? 'activity.reply' : 'activity.comment', { actor })}</span>}
        <time className="ab-event-time" dateTime={entry.at} title={entry.at}>{when(entry.at)}</time>
      </div>
      {entry.kind === 'comment' && <p className="ab-text ab-comment">{plainMentions(entry.body)}</p>}
    </li>
  )
}
