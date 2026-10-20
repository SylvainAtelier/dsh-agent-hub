/**
 * The board's 待我审 lane: the pull requests waiting for my review, first among the columns. Its
 * cards are not dragged (review is not a ticket stage); a card opens its review sheet in the
 * board's detail, and 打开会话 goes to the session that analysed it, the sheet beside it.
 *
 * Three lists, a switch in its head: 待我审 (asked of me), 我的 (the ones I opened, answered with a
 * response sheet, never in a batch) and 全部 (every open pull request of the repositories set for
 * review). 我的 and 全部 are read only once asked for. In 全部, mine to review lead, each with a mark;
 * the rest follow under a divider.
 *
 * Answering one of mine asks where to work only when no worktree is on its branch: a new worktree,
 * or another tree without changes switched to it. A pull request whose branch names a Linear
 * ticket on the board carries the ticket's chip (its state as a dot), and one whose branch or title
 * names a Sentry issue on the board the issue's chip (its phase as a dot); hovering a card marks those
 * linked to it across the columns (Board.tsx).
 *
 * Each card has its actions in a menu: right-click (with a detail open too), long-press, the
 * context-menu key, or its ⋯ button. A run shows on its card as it goes, and step by step in the detail.
 * The detail's head copies the pull request's link (⌘⇧, as in Linear); one of mine is merged from
 * its detail (Merge.tsx).
 *
 * Stacked pull requests share one rail, the ones the list leaves out as slim rows beside its cards;
 * the detail shows the stack too, and a review picks there what its analysis reads (Stack.tsx).
 *
 * A review I sent sinks to the list's end; once its pull request is merged or closed it sinks below
 * those, marked so, and leaves the days set in 设置 → 审核 later (the host drops it). New commits or
 * comments after it raise it again, amber, with what came and 重新分析 at hand, until analysed again
 * or marked seen; how my comments were answered shows on it as 回应 n/m.
 *
 * Long lists stay smooth: cards are memoized (a poll re-renders only the cards that changed), they
 * mount a page at a time as the list scrolls, and the browser skips laying out the ones off screen.
 */

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactNode, type RefObject, type TouchEvent as ReactTouchEvent } from 'react'
import { issueInBranch } from '../../connectors/types.ts'
import { samePath } from '../../repos/types.ts'
import type { Card } from '../../board/types.ts'
import { issuesInPull, type SentryIssue } from '../../alerts/types.ts'
import {
  followed, landed, REVIEW_SCOPES, reviewRank, runEnded, stalled, type FollowUp, type ReviewBot, type ReviewItem, type ReviewRun, type ReviewScope, type TreeChoice, type TreePlaces,
} from '../../review/types.ts'
import { Menu, type MenuAnchor, type MenuEntry } from '../git/kit.tsx'
import { injectGitStyle } from '../git/style.ts'
import type { ReviewSnapshot, ReviewStore } from './api.ts'
import type { ReviewNav } from './index.tsx'
import { t } from './i18n.ts'
import { diffStamp, DiffPane, showFinding, useFindings, useView, ViewSwitch, type Reveal } from './Diff.tsx'
import { ActivityStrip, RunLine, RunTimeline, StopButton, StopIcon, stepLabel } from './Progress.tsx'
import { Branches, followText, PhaseChip, ReviewSheet, StandIcon } from './Sheet.tsx'
import { Zone, ZoneHead } from '../board/zone.tsx'
import { pairLink, SentryMark } from '../board/marks.tsx'
import { ALERT_PREFIX } from '../alerts/Lane.tsx'
import { phaseName } from '../alerts/title.ts'
import { MergeStrip } from './Merge.tsx'
import { laneEntries, stackIndex, StackPanel, StackRail, type LaneEntry } from './Stack.tsx'
import { COPY_LINK_KEY, CopyButton, LinkIcon } from '../copy.tsx'
import { ago, dateTime } from '../i18n.ts'

export interface ReviewFace {
  store: ReviewStore
  nav: ReviewNav
}

/** Selection keys of review cards on the board. */
export const REVIEW_PREFIX = 'review:'

const NONE: ReviewSnapshot = { state: undefined, loading: false, error: null, notice: null }
const noop = (): (() => void) => () => {}

export function useReview(face: ReviewFace | undefined): ReviewSnapshot {
  return useSyncExternalStore(face?.store.subscribe ?? noop, face?.store.getSnapshot ?? (() => NONE))
}

const selectKey = (key: string): string => REVIEW_PREFIX + key

const repoName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The review items in the board's repository filter (its search is the board's: Board.tsx). */
export function visibleItems(items: readonly ReviewItem[], repo: string): readonly ReviewItem[] {
  return repo === '' ? items : items.filter((item) => samePath(item.repo, repo))
}

/** A pull request the board's search (lower-cased, trimmed) finds by itself: by title, number or author. */
export const itemMatches = (item: ReviewItem, text: string): boolean =>
  item.title.toLowerCase().includes(text) || `#${item.number}`.includes(text) || item.author.toLowerCase().includes(text)

/** Each pull request's Linear card among the board's, by the pull request's key: the ticket its branch names. */
export function ticketsOf(items: readonly ReviewItem[], cards: readonly Card[]): Map<string, Card> {
  const byId = new Map<string, Card>()
  for (const card of cards) if (card.source === 'linear') byId.set(card.id.toUpperCase(), card)
  const out = new Map<string, Card>()
  const keys = [...new Set([...byId.keys()].map((id) => id.split('-')[0]!))]
  if (keys.length === 0) return out
  for (const item of items) {
    const id = item.branch === '' ? undefined : issueInBranch(item.branch, keys)
    const card = id === undefined ? undefined : byId.get(id)
    if (card !== undefined) out.set(item.key, card)
  }
  return out
}

/** Each pull request's Sentry issues among the board's, by the pull request's key: those its branch or title names. */
export function alertsOf(items: readonly ReviewItem[], issues: readonly SentryIssue[]): Map<string, SentryIssue[]> {
  const out = new Map<string, SentryIssue[]>()
  if (issues.length === 0) return out
  for (const item of items) {
    const found = issuesInPull(item, issues)
    if (found.length > 0) out.set(item.key, found)
  }
  return out
}

/** A pull request's links ({@link pairLink}): its ticket's and its issues'. */
const linksOf = (ticket: Card | undefined, alerts: readonly SentryIssue[] | undefined): string[] =>
  [...ticket === undefined ? [] : [pairLink('linear', ticket.id)], ...(alerts ?? []).map((issue) => pairLink('sentry', issue.id))]

/** Brings the pull request linked to a ticket or an issue (by its {@link pairLink}) into view in the lane: a card rested on asks it (Board.tsx). */
export type RevealPull = (link: string) => void

const scrollBehavior = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')

/** Bring a ticket's or an issue's own card into view, beside the one its chip was clicked on. */
function revealLinked(link: string): void {
  const card = document.querySelector(`.ab-card:not(.rv-card)[data-link~="${CSS.escape(link)}"]`)
  card?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() })
}

function LinearMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" className="rv-tmark">
      <path fill="currentColor" d="M1.2 9.6 6.4 14.8A7 7 0 0 1 1.2 9.6Zm-.2-2.1 7.5 7.5a7 7 0 0 0 1.9-.5L1.5 5.6a7 7 0 0 0-.5 1.9Zm1.2-3 9.3 9.3a7 7 0 0 0 1.3-1L3.2 3.2a7 7 0 0 0-1 1.3Zm2-2.1A7 7 0 1 1 13.6 11.8L4.2 2.4Z" />
    </svg>
  )
}

/** The Linear ticket a pull request works on: its mark, id and state as a dot; it opens the ticket. */
function TicketChip(props: { ticket: Card; onOpen(key: string): void }): ReactNode {
  const { ticket } = props
  const state = ticket.state ?? ticket.stage
  return (
    <button type="button" className="ab-chip rv-ticket" title={t('ticketHint', { id: ticket.id, state })} aria-label={t('ticketHint', { id: ticket.id, state })}
      onKeyDown={own.onKeyDown}
      onClick={(event) => {
        event.stopPropagation()
        props.onOpen(ticket.key)
        revealLinked(pairLink('linear', ticket.id))
      }}>
      <LinearMark />{ticket.id}<span className="rv-tdot" data-stage={ticket.stage} aria-hidden="true" />
    </button>
  )
}

/** A Sentry issue a pull request fixes: its mark, id and phase as a dot; it opens the issue. */
function AlertChip(props: { issue: SentryIssue; onOpen(key: string): void }): ReactNode {
  const { issue } = props
  const phase = issue.phase ?? 'unanalysed'
  const hint = t('alertHint', { id: issue.id, phase: phaseName(phase) })
  return (
    <button type="button" className="ab-chip rv-alert" title={hint} aria-label={hint} onKeyDown={own.onKeyDown}
      onClick={(event) => {
        event.stopPropagation()
        props.onOpen(ALERT_PREFIX + issue.id)
        revealLinked(pairLink('sentry', issue.id))
      }}>
      <SentryMark />{issue.id}<span className="rv-adot" data-phase={phase} aria-hidden="true" />
    </button>
  )
}

/** The issues' chips past this many fold into a count. */
const ALERT_CHIPS = 2

/** Same issues, standing the same: the host sends new ones each poll, mostly unchanged. */
const sameAlerts = (a: readonly SentryIssue[] | undefined, b: readonly SentryIssue[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((issue, index) => issue.id === b[index]!.id && issue.phase === b[index]!.phase))

/** Cards mounted at first, and added each time the list's end comes near. */
const PAGE = 40

/** Same fields, same values: the host sends a new object each poll, mostly unchanged. */
function sameItem(a: ReviewItem, b: ReviewItem): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof ReviewItem>
  return keys.length === Object.keys(b).length
    && keys.every((key) => a[key] === b[key] || (key === 'follow' && JSON.stringify(a.follow) === JSON.stringify(b.follow)))
}

const own = {
  onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
  onKeyDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
}

/** The runs by pull request. */
export function runsOf(snapshot: ReviewSnapshot): Map<string, ReviewRun> {
  return new Map((snapshot.progress?.runs ?? []).map((run) => [run.key, run]))
}

/** Busy: queued, starting, or its session answering. Nothing may start it again then. */
const busy = (item: ReviewItem, run: ReviewRun | undefined): boolean =>
  item.queued === true || item.running === true || (run !== undefined && !runEnded(run.step))

/** What starting it again is called: the first analysis, a retry after a failure, or another look. */
function againLabel(item: ReviewItem, run: ReviewRun | undefined): string {
  if (run?.step === 'failed' || item.error !== undefined || stalled(item) || item.phase === 'invalid') return t('retry')
  if (item.own === true) return t('respond')
  return item.phase === 'new' ? t('analyze') : t('reanalyze')
}

type MenuAction = 'again' | 'chooseBot' | 'fresh' | 'fix' | 'seen' | 'cancel' | 'open' | 'session' | 'workspace' | 'github' | 'copy' | 'copyBranch'

const icon = (d: string): ReactNode => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)

function menuEntries(item: ReviewItem, run: ReviewRun | undefined, hasBots: boolean): MenuEntry[] {
  const working = busy(item, run)
  // A fork's branch is not worked on here, nor a merged or closed one: only reading it stays.
  const blocked = working || item.cross === true || landed(item)
  const mine = item.own === true
  const entries: MenuEntry[] = [
    { id: 'again', label: againLabel(item, run), disabled: blocked, icon: icon('M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3') },
    { id: 'chooseBot', label: t(mine ? 'menu.chooseBotRespond' : 'menu.chooseBot'), hint: t('menu.chooseBotHint'), disabled: blocked || !hasBots, icon: icon('M3 12.5v-1.2c0-1.5 1.5-2.6 3.4-2.6h3.2c1.9 0 3.4 1.1 3.4 2.6v1.2M8 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 5') },
  ]
  if (item.session !== undefined && item.phase !== 'new') {
    entries.push(mine
      ? { id: 'fresh', label: t('menu.freshRespond'), hint: t('menu.freshRespondHint'), disabled: blocked, icon: icon('M8 3v10M3 8h10') }
      : { id: 'fresh', label: t('menu.fresh'), hint: t('menu.freshHint'), disabled: working || landed(item), icon: icon('M8 3v10M3 8h10') })
  }
  if (!mine && followed(item)) entries.push({ id: 'seen', label: t('menu.seen'), hint: t('follow.seenHint'), icon: icon('M3.5 8.5l3 3 6-7') })
  if (mine && (item.phase === 'ready' || item.phase === 'fixed') && item.must > 0) {
    entries.push({ id: 'fix', label: t(item.phase === 'fixed' ? 'menu.refix' : 'menu.fix'), disabled: working, icon: icon('M10.5 2.5l3 3-7.5 7.5H3v-3z') })
  }
  if (working) {
    entries.push(run?.step === 'queued'
      ? { id: 'cancel', label: t('menu.cancel'), icon: icon('M4 4l8 8M12 4l-8 8') }
      : { id: 'cancel', label: t('menu.stop'), icon: icon('M4.5 4.5h7v7h-7z') })
  }
  entries.push(
    { separator: true },
    { id: 'open', label: t('menu.open'), icon: icon('M2.5 4.5h11M2.5 8h11M2.5 11.5h7') },
  )
  if (item.session !== undefined) entries.push({ id: 'session', label: t('openSession'), icon: icon('M3 3.5h10v7H7l-3 2.5v-2.5H3z') })
  if (mine && item.tree !== undefined) entries.push({ id: 'workspace', label: t('menu.workspace'), hint: repoName(item.tree), icon: icon('M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z') })
  entries.push(
    { id: 'github', label: t('menu.github'), icon: icon('M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5') },
    { id: 'copy', label: t('menu.copy'), icon: icon('M5.5 5.5h7v7h-7zM3.5 10.5v-7h7') },
  )
  if (item.branch !== '') entries.push({ id: 'copyBranch', label: t('menu.copyBranch'), hint: item.branch, icon: icon('M5 3v6.5M5 9.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 6.5c0 2-2 3-6 3') })
  return entries
}

/** Long-press on touch opens the menu (iOS fires no contextmenu); the click that follows is swallowed. */
function useLongPress(open: (anchor: MenuAnchor) => void): {
  handlers: { onTouchStart(event: ReactTouchEvent): void; onTouchEnd(): void; onTouchMove(): void; onTouchCancel(): void }
  swallow(): boolean
} {
  const state = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false })
  useEffect(() => () => clearTimeout(state.current.timer), [])
  const stop = (): void => clearTimeout(state.current.timer)
  return {
    handlers: {
      onTouchStart(event) {
        const touch = event.touches[0]
        if (touch === undefined || event.touches.length > 1) return
        const { clientX: x, clientY: y } = touch
        state.current.fired = false
        stop()
        state.current.timer = setTimeout(() => {
          state.current.fired = true
          navigator.vibrate?.(10)
          open({ x, y })
        }, 480)
      },
      onTouchEnd: stop,
      onTouchMove: stop,
      onTouchCancel: stop,
    },
    swallow() {
      const fired = state.current.fired
      state.current.fired = false
      return fired
    },
  }
}

interface CardProps {
  item: ReviewItem
  run: ReviewRun | undefined
  skew: number | undefined
  selected: boolean
  menuOpen: boolean
  flash: string | undefined
  showRepo: boolean
  /** In 全部: a pull request asked of me, marked apart from the rest. */
  mine: boolean
  /** In 全部: mark my own pull requests with a chip. */
  showOwnChip: boolean
  ticket?: Card | undefined
  /** The Sentry issues it fixes, by its branch or title. */
  alerts?: readonly SentryIssue[] | undefined
  store: ReviewStore
  onOpen(key: string): void
  /** Open a ticket's or an issue's detail, by its selection key. */
  onTicket(key: string): void
  onMenu(key: string, anchor: MenuAnchor, card: HTMLElement): void
  /** Mine: answer its review, asking where to work when needed. */
  onRespond(key: string, anchor: MenuAnchor): void
}

const sameCard = (a: CardProps, b: CardProps): boolean =>
  sameItem(a.item, b.item) && a.run === b.run && a.skew === b.skew && a.selected === b.selected && a.menuOpen === b.menuOpen
  && a.flash === b.flash && a.showRepo === b.showRepo && a.mine === b.mine && a.showOwnChip === b.showOwnChip && a.ticket === b.ticket && sameAlerts(a.alerts, b.alerts) && a.store === b.store
  && a.onOpen === b.onOpen && a.onTicket === b.onTicket && a.onMenu === b.onMenu && a.onRespond === b.onRespond

/** Below an element, aligned to its end: where a menu it opens goes. */
const below = (element: Element): MenuAnchor => {
  const rect = element.getBoundingClientRect()
  return { x: rect.right, y: rect.bottom, rect, align: 'end' }
}

/**
 * What followed a review I sent, on its card: new commits and comments (since I last caught up),
 * and how many of my comments were answered; each with its glyph, the whole in words for a reader.
 */
function FollowChips(props: { follow: FollowUp }): ReactNode {
  const { follow } = props
  const { replied, resolved, outdated, open } = follow.mine
  const total = replied + resolved + outdated + open
  const news = follow.commits + follow.comments > 0
  return (
    <>
      {news && (
        <span className="ab-chip rv-follow" role="img" aria-label={t('follow.summary', { parts: followText(follow) })} title={t('follow.summary', { parts: followText(follow) })}>
          {follow.commits > 0 && <span><StandIcon stand="commits" />{follow.commits}</span>}
          {follow.comments > 0 && <span><StandIcon stand="replied" />{follow.comments}</span>}
        </span>
      )}
      {total > 0 && (
        <span className="ab-chip rv-answered" data-muted={replied + resolved + outdated === 0 ? '' : undefined}
          title={t('follow.mineHint', { total, replied, resolved, outdated, open })} aria-label={t('follow.mineHint', { total, replied, resolved, outdated, open })}>
          {t('follow.mine', { n: replied + resolved + outdated, total })}
        </span>
      )}
    </>
  )
}

const ReviewCard = memo(function ReviewCard(props: CardProps): ReactNode {
  const { item, run } = props
  const analysed = item.phase !== 'new' && item.phase !== 'invalid'
  const card = useRef<HTMLElement>(null)
  const openMenu = (anchor: MenuAnchor): void => { if (card.current !== null) props.onMenu(item.key, anchor, card.current) }
  const press = useLongPress(openMenu)
  const onContextMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    event.preventDefault()
    // The context-menu key and Shift+F10 give no pointer: open at the card.
    if (event.button !== 2 && event.clientX === 0 && event.clientY === 0) openMenu({ x: 0, y: 0, rect: event.currentTarget.getBoundingClientRect() })
    else openMenu({ x: event.clientX, y: event.clientY })
  }
  const live = run !== undefined && !runEnded(run.step)
  return (
    <article ref={card} className="ab-card rv-card" data-selected={props.selected ? '' : undefined} data-menu={props.menuOpen ? '' : undefined}
      data-live={live ? '' : undefined} data-phase={item.phase} data-again={item.rerequested === true || followed(item) ? '' : undefined} data-link={linksOf(props.ticket, props.alerts).join(' ') || undefined} tabIndex={0} role="button" aria-haspopup="menu"
      aria-label={`${props.mine ? `${t('requested')} · ` : item.picked === true ? `${t('picked')} · ` : ''}#${item.number} ${item.title}`} onContextMenu={onContextMenu} {...press.handlers}
      onClick={() => { if (!press.swallow()) props.onOpen(item.key) }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen(item.key)
        }
      }}>
      <div className="ab-card-top">
        <span className="rv-card-number">#{item.number}</span>
        {props.showRepo && <span className="ab-chip" data-muted="">{repoName(item.repo)}</span>}
        {props.flash !== undefined ? <span className="rv-chip rv-flash" role="status">{props.flash}</span> : <PhaseChip item={item} />}
        <button type="button" className="rv-more" aria-label={t('more')} title={t('more')} aria-haspopup="menu" aria-expanded={props.menuOpen}
          onKeyDown={own.onKeyDown} onTouchStart={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            openMenu({ x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), align: 'end' })
          }}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
        </button>
      </div>
      <p className="ab-card-title">{item.title}</p>
      <div className="ab-card-meta">
        {props.ticket !== undefined && <TicketChip ticket={props.ticket} onOpen={props.onTicket} />}
        {props.alerts?.slice(0, ALERT_CHIPS).map((issue) => <AlertChip key={issue.id} issue={issue} onOpen={props.onTicket} />)}
        {(props.alerts?.length ?? 0) > ALERT_CHIPS && (
          <span className="ab-chip rv-alert" data-muted="" role="img" title={t('alertsMore', { ids: props.alerts!.slice(ALERT_CHIPS).map((issue) => issue.id).join(', ') })}
            aria-label={t('alertsMore', { ids: props.alerts!.slice(ALERT_CHIPS).map((issue) => issue.id).join(', ') })}>+{props.alerts!.length - ALERT_CHIPS}</span>
        )}
        {props.mine && <span className="ab-chip rv-mine-chip">{t('requested')}</span>}
        {item.picked === true && <span className="ab-chip rv-mine-chip" title={t('pickedHint')}>{t('picked')}</span>}
        {item.own === true && props.showOwnChip && <span className="ab-chip rv-own-chip">{t('mineChip')}</span>}
        {item.own === true
          ? (
            <>
              {item.reviewDecision !== undefined && <span className="ab-chip rv-rd" data-rd={item.reviewDecision}>{t(`rd.${item.reviewDecision}`)}</span>}
              {item.pending !== undefined && item.pending > 0 && <span className="ab-chip rv-pending">{t('own.pending', { n: item.pending })}</span>}
              {item.cross === true && <span className="ab-chip" data-muted="" title={t('own.forkHint')}>{t('own.fork')}</span>}
              {analysed && item.must + item.nice > 0 && <span className="ab-chip" data-muted="">{t('own.counts', { fix: item.must, reply: item.nice })}</span>}
            </>
          )
          : (
            <>
              {item.author !== '' && <span className="ab-chip" data-muted="">@{item.author}</span>}
              {analysed && item.must + item.nice > 0 && <span className="ab-chip">{t('counts', { must: item.must, nice: item.nice })}</span>}
            </>
          )}
        {item.follow !== undefined && <FollowChips follow={item.follow} />}
        {item.draft && <span className="ab-chip" data-muted="">{t('draft')}</span>}
        {landed(item) && (
          <time className="ab-chip" data-muted="" dateTime={new Date(item.updatedAt).toISOString()} title={t(`landed.${item.phase as 'merged' | 'closed'}`, { when: dateTime(item.updatedAt) })}>
            {ago(item.updatedAt, Date.now())}
          </time>
        )}
        <span className="ab-grow" />
        {busy(item, run)
          ? (
            <div className="ab-go-wrap" {...own}>
              <StopButton className="ab-go rv-go-stop" queued={run?.step === 'queued'} onStop={() => void props.store.cancel(item.key)} />
            </div>
          )
          : (item.phase === 'new' || item.phase === 'stale' || followed(item)) && run?.step !== 'failed' && item.cross !== true && (
            <div className="ab-go-wrap" {...own}>
              {item.own === true
                ? <button type="button" className="ab-go" onClick={(event) => props.onRespond(item.key, below(event.currentTarget))}>{t('respond')}</button>
                : <button type="button" className="ab-go" data-again={followed(item) ? '' : undefined} onClick={() => void props.store.analyze(item.key)}>{item.phase === 'new' ? t('analyze') : t('reanalyze')}</button>}
            </div>
          )}
      </div>
      {run !== undefined && (
        <RunLine run={run} item={item} skew={props.skew}
          onRetry={() => (run.mode === 'fix' ? void props.store.fix(item.path) : item.own === true && card.current !== null ? props.onRespond(item.key, below(card.current)) : void props.store.analyze(item.key))} />
      )}
    </article>
  )
}, sameCard)

/** 待我审 | 全部, each with its count (全部's once read): a switch of what the lane lists. */
function ScopeSwitch(props: { scope: ReviewScope; counts: { mine: number; own?: number; all?: number } | undefined; wide?: boolean; onChange(scope: ReviewScope): void }): ReactNode {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (from: number, by: number): void => {
    const next = REVIEW_SCOPES[(from + by + REVIEW_SCOPES.length) % REVIEW_SCOPES.length]!
    props.onChange(next)
    refs.current[REVIEW_SCOPES.indexOf(next)]?.focus()
  }
  return (
    <div className="ah-seg rv-scope" role="radiogroup" aria-label={t('scope.label')} data-wide={props.wide ? '' : undefined}>
      {REVIEW_SCOPES.map((scope, index) => {
        const count = props.counts?.[scope]
        const on = props.scope === scope
        return (
          <button key={scope} ref={(element) => { refs.current[index] = element }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
            data-scope={scope} title={t(`scope.${scope}Hint`)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1) }
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1) }
            }}
            onClick={() => props.onChange(scope)}>
            {t(`scope.${scope}`)}
            {count !== undefined && <span className="rv-scope-n">{count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Mounts `PAGE` more cards whenever its marker nears the visible part of the list (or is clicked). */
function useReveal(total: number, reset: unknown): { limit: number; marker: (element: HTMLElement | null) => void; more(): void; reach(index: number): void } {
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [reset])
  const more = useCallback(() => setLimit((current) => current + PAGE), [])
  /** Mount through the page holding this entry. */
  const reach = useCallback((index: number) => setLimit((current) => (index < current ? current : (Math.floor(index / PAGE) + 1) * PAGE)), [])
  const observer = useRef<IntersectionObserver | undefined>(undefined)
  useEffect(() => () => observer.current?.disconnect(), [])
  const marker = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = undefined
    if (element === null || typeof IntersectionObserver === 'undefined') return
    // A viewport root: the lane's own scrolling clips it, so this fires as the lane's end nears.
    observer.current = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) more() }, { rootMargin: '800px 0px' })
    observer.current.observe(element)
    // A new marker each page: a fresh observation fires at once if the end is still near.
  }, [more, limit])
  return { limit: Math.min(limit, total), marker, more, reach }
}

/**
 * Scroll the lane (itself only: the board's columns stay put) so a link's first card shows,
 * centred, unless it already does; its page is mounted first when it is not yet. A smooth scroll
 * over cards not laid out yet may land a little off: once it ends, it is put right.
 */
function useRevealPull(body: RefObject<HTMLElement | null>, entries: readonly LaneEntry[], linked: (item: ReviewItem) => string[],
  reveal: { limit: number; reach(index: number): void }): RevealPull {
  const now = useRef({ entries, linked, limit: reveal.limit })
  now.current = { entries, linked, limit: reveal.limit }
  const waiting = useRef<string | undefined>(undefined)
  const scroll = useCallback((link: string, behavior: ScrollBehavior): void => {
    const lane = body.current
    const card = lane?.querySelector<HTMLElement>(`.rv-card[data-link~="${CSS.escape(link)}"]`)
    if (lane === null || lane === undefined || card === null || card === undefined) return
    const box = lane.getBoundingClientRect()
    const at = card.getBoundingClientRect()
    if (at.top >= box.top && at.bottom <= box.bottom) return
    lane.scrollTo({ top: lane.scrollTop + at.top - box.top - (box.height - at.height) / 2, behavior })
    if (behavior === 'smooth') lane.addEventListener('scrollend', () => scroll(link, 'auto'), { once: true })
  }, [body])
  useLayoutEffect(() => {
    const link = waiting.current
    waiting.current = undefined
    if (link !== undefined) scroll(link, scrollBehavior())
  }, [reveal.limit, scroll])
  const { reach } = reveal
  return useCallback((link: string) => {
    const { entries: list, linked: linksOfItem, limit } = now.current
    const named = (item: ReviewItem): boolean => linksOfItem(item).includes(link)
    const index = list.findIndex((entry) => (entry.kind === 'card' ? named(entry.item) : entry.rows.some((row) => row.shown && named(row.item))))
    if (index < 0) return
    if (index < limit) scroll(link, scrollBehavior())
    else {
      waiting.current = link
      reach(index)
    }
  }, [scroll, reach])
}

/** Where an entry sorts: a stack where its first card does. */
const entryRank = (entry: LaneEntry): number =>
  entry.kind === 'card' ? reviewRank(entry.item) : Math.min(...entry.rows.filter((row) => row.shown).map((row) => reviewRank(row.item)))

export function ReviewColumn(props: {
  face: ReviewFace
  snapshot: ReviewSnapshot
  items: readonly ReviewItem[]
  /** Each pull request's Linear card, by its key. */
  tickets: ReadonlyMap<string, Card>
  /** Each pull request's Sentry issues, by its key. */
  alerts: ReadonlyMap<string, readonly SentryIssue[]>
  /** Filled, while the lane shows beside the tickets, with what brings a ticket's or an issue's pull request into view. */
  revealRef?: MutableRefObject<RevealPull | undefined>
  narrow: boolean
  showRepo: boolean
  selected: string | undefined
  onSelect(key: string): void
  /** Go to a working tree's workspace, by its path. */
  onWorkspace?: (path: string) => void
}): ReactNode {
  const { face, snapshot } = props
  // Typing in the board's search filters a long list: the cards follow a moment behind the field.
  const items = useDeferredValue(props.items)
  const state = snapshot.state
  const scope = snapshot.scope ?? 'mine'
  const all = scope === 'all'
  // 我的 is answered one at a time: no batch analysis there.
  const ownScope = scope === 'own'
  const laneName = t(all ? 'laneAll' : ownScope ? 'laneOwn' : 'lane')
  const respond = useRespond(face.store)
  const syncing = state?.syncing === true
  // The list of the other scope still showing while this one is read for the first time.
  const reading = state === undefined || (state.scope ?? 'mine') !== scope || (items.length === 0 && state.syncedAt === undefined && snapshot.loading)
  const runs = useMemo(() => runsOf(snapshot), [snapshot.progress])
  const { tickets, alerts, revealRef } = props
  const linked = useCallback((item: ReviewItem) => linksOf(tickets.get(item.key), alerts.get(item.key)), [tickets, alerts])
  // Stacked pull requests come as one entry, where the first of them would be.
  const stacks = useMemo(() => stackIndex(state), [state])
  const entries = useMemo(() => laneEntries(items, stacks), [items, stacks])
  const reveal = useReveal(entries.length, `${scope}|${props.items.length === 0}`)
  const shown = entries.slice(0, reveal.limit)
  // In 全部, where mine (asked of me or picked) end and the rest begin.
  const lead = (item: ReviewItem): boolean => item.requested || item.picked === true
  const split = all ? entries.findIndex((entry) => (entry.kind === 'card' ? !lead(entry.item) : !entry.rows.some((row) => row.shown && lead(row.item)))) : -1
  const rest = split < 0 ? 0 : items.filter((item) => !lead(item)).length
  // Where the sent ones begin in each part of the list, and how many: they sink to its end (我的 keeps its
  // order), those merged or closed since below the rest.
  const sent = useMemo(() => {
    const out = new Map<number, { rank: number; n: number; closed: boolean }>()
    if (ownScope) return out
    let head = -1
    let rank = -1
    entries.forEach((entry, index) => {
      const at = entryRank(entry)
      if (at < 2) {
        head = -1
        return
      }
      if (head < 0 || index === split || at !== rank) head = index
      rank = at
      const rows = entry.kind === 'card' ? [entry.item] : entry.rows.filter((row) => row.shown).map((row) => row.item)
      const group = out.get(head) ?? { rank: at, n: 0, closed: false }
      out.set(head, { rank: at, n: group.n + rows.length, closed: group.closed || rows.some((item) => item.phase === 'closed') })
    })
    return out
  }, [entries, ownScope, split])
  const keepDays = state?.keepMerged
  const body = useRef<HTMLDivElement>(null)
  const revealPull = useRevealPull(body, entries, linked, reveal)
  useLayoutEffect(() => {
    if (revealRef === undefined || props.narrow) return
    revealRef.current = revealPull
    return () => { if (revealRef.current === revealPull) revealRef.current = undefined }
  }, [revealRef, revealPull, props.narrow])
  // Not analysed at the current head: what 全部分析 would queue (drafts only on their own).
  const pending = items.some((item) => item.requested && !item.draft && !busy(item, runs.get(item.key))
    && (item.phase === 'new' || item.phase === 'stale' || stalled(item) || (item.phase === 'submitted' && (item.follow?.commits ?? 0) > 0)))
  // What 全部终止 would stop: every busy one, the filters' hidden ones too (the host stops them all).
  const stoppable = (state?.items ?? []).filter((item) => busy(item, runs.get(item.key))).length
  const [menu, setMenu] = useState<{ key: string; anchor: MenuAnchor; card: HTMLElement } | undefined>()
  const [flash, setFlash] = useState<{ key: string; text: string } | undefined>()
  useEffect(() => {
    if (flash === undefined) return
    const timer = setTimeout(() => setFlash(undefined), 1400)
    return () => clearTimeout(timer)
  }, [flash])
  const menuItem = menu === undefined ? undefined : items.find((item) => item.key === menu.key)
  const { onSelect } = props
  const onOpen = useCallback((key: string) => onSelect(REVIEW_PREFIX + key), [onSelect])
  const onMenu = useCallback((key: string, anchor: MenuAnchor, card: HTMLElement) => setMenu({ key, anchor, card }), [])
  const itemsNow = useRef(items)
  itemsNow.current = items
  const { start } = respond
  const onRespond = useCallback((key: string, anchor: MenuAnchor, options?: { fresh?: boolean; bot?: string }) => {
    const item = itemsNow.current.find((entry) => entry.key === key)
    if (item !== undefined) start(item, anchor, options)
  }, [start])
  const card = (item: ReviewItem): ReactNode => (
    <ReviewCard item={item} run={runs.get(item.key)} skew={snapshot.skew} selected={props.selected === REVIEW_PREFIX + item.key}
      menuOpen={menu?.key === item.key} flash={flash?.key === item.key ? flash.text : undefined} showRepo={props.showRepo} store={face.store}
      mine={all && item.requested} showOwnChip={all} ticket={tickets.get(item.key)} alerts={alerts.get(item.key)} onOpen={onOpen} onTicket={onSelect} onMenu={onMenu} onRespond={onRespond} />
  )
  const closeMenu = (refocus: boolean): void => {
    const card = menu?.card
    setMenu(undefined)
    // Back to the card it was opened from, unless a click put the focus elsewhere.
    if (refocus && card?.isConnected === true) card.focus({ preventScroll: true })
  }
  const choose = (item: ReviewItem, action: MenuAction, anchor: MenuAnchor): void => {
    closeMenu(action !== 'open' && action !== 'session' && action !== 'github' && action !== 'workspace')
    if (item.own === true && (action === 'again' || action === 'fresh')) onRespond(item.key, anchor, { fresh: action === 'fresh' })
    else if (action === 'again') void face.store.analyze(item.key)
    else if (action === 'fresh') void face.store.analyze(item.key, true)
    else if (action === 'fix') void face.store.fix(item.path)
    else if (action === 'seen') void face.store.seen(item.key)
    else if (action === 'workspace' && item.tree !== undefined) props.onWorkspace?.(item.tree)
    else if (action === 'cancel') void face.store.cancel(item.key)
    else if (action === 'open') props.onSelect(REVIEW_PREFIX + item.key)
    else if (action === 'session' && item.session !== undefined) face.nav.openReview(item.session, item.path)
    else if (action === 'github') window.open(item.url, '_blank', 'noopener,noreferrer')
    else if (action === 'copy') {
      void navigator.clipboard?.writeText(item.url).then(() => setFlash({ key: item.key, text: t('copied') }), () => {})
    } else if (action === 'copyBranch') {
      void navigator.clipboard?.writeText(item.branch).then(() => setFlash({ key: item.key, text: t('copied') }), () => {})
    }
  }
  const sync = (): void => void face.store.sync()
  const syncHint = t(all ? 'syncAllHint' : ownScope ? 'syncOwnHint' : 'syncHint')
  // The lane's own read of GitHub: in its zone's head, before what acts on its pull requests.
  const syncButton = (
    <button type="button" className="ah-icon-btn ah-icon-sm rv-sync" title={syncHint} aria-label={t('sync')} data-busy={syncing ? '' : undefined}
      disabled={syncing} onClick={sync}>
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
      </svg>
    </button>
  )
  const analyzeAll = ownScope ? null : (
    <button type="button" className="ah-icon-btn ah-icon-sm" title={t('analyzeAllHint')} aria-label={t('analyzeAll')}
      disabled={!pending} onClick={() => void face.store.analyzeAll()}>
      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M4.5 3v10l8.5-5z" /></svg>
    </button>
  )
  const head = props.narrow ? undefined : (
    <ZoneHead zone="review" title={t('zone')}
      actions={<>{syncButton}{analyzeAll}<StopAll count={stoppable} compact onStop={() => void face.store.cancelAll()} /></>}
      tools={<ScopeSwitch scope={scope} counts={state?.counts} wide onChange={(next) => face.store.setScope(next)} />} />
  )
  return (
    <Zone zone="review" head={head}>
    <section className="ab-col" data-stage="review" aria-label={laneName}>
      <div ref={body} className="ab-col-body rv-col-body" data-scope={scope}>
        {props.narrow && (
          // Atop the list, not past its end: reachable however long the list.
          <div className="rv-lane-bar">
            <ScopeSwitch scope={scope} counts={state?.counts} wide onChange={(next) => face.store.setScope(next)} />
            <div className="rv-lane-actions">
              <button type="button" className="ah-btn" title={syncHint} disabled={syncing} onClick={sync}>{syncing ? t('syncing') : t('sync')}</button>
              {!ownScope && <button type="button" className="ah-btn" title={t('analyzeAllHint')} disabled={!pending} onClick={() => void face.store.analyzeAll()}>{t('analyzeAll')}</button>}
              <StopAll count={stoppable} onStop={() => void face.store.cancelAll()} />
            </div>
          </div>
        )}
        <ActivityStrip progress={snapshot.progress} skew={snapshot.skew} />
        {state?.error !== undefined && <p className="ab-hint" role="alert">{t('laneError', { message: state.error })}</p>}
        {reading
          ? (
            <div className="rv-skeleton" role="status" aria-label={t(all ? 'loadingAll' : ownScope ? 'loadingOwn' : 'loadingMine')}>
              {[0, 1, 2].map((index) => <div key={index} className="rv-skeleton-card" />)}
              <p className="ab-hint">{t(all ? 'loadingAll' : ownScope ? 'loadingOwn' : 'loadingMine')}</p>
            </div>
          )
          : shown.map((entry: LaneEntry, index) => (
            <div key={entry.kind === 'card' ? entry.item.key : `stack:${entry.root}`} className="rv-slot">
              {index === split && split > 0 && <div className="rv-divider" role="separator"><span>{t('others', { n: rest })}</span></div>}
              {sent.has(index) && <SentDivider group={sent.get(index)!} keepDays={keepDays} />}
              {entry.kind === 'card'
                ? card(entry.item)
                : <StackRail entry={entry} selected={props.selected} selectKey={selectKey} card={card} onOpen={onOpen} />}
            </div>
          ))}
        {!reading && shown.length < entries.length && (
          <button type="button" ref={reveal.marker} className="rv-reveal" onClick={reveal.more}>{t('showMore', { n: entries.length - shown.length })}</button>
        )}
        {menu !== undefined && menuItem !== undefined && (
          <CardMenu item={menuItem} run={runs.get(menuItem.key)} anchor={menu.anchor}
            bots={state?.bots ?? []} defaultBot={state?.defaultBot ?? ''}
            onAnalyze={(bot) => {
              closeMenu(true)
              if (menuItem.own === true) onRespond(menuItem.key, menu.anchor, { bot })
              else void face.store.analyze(menuItem.key, true, bot)
            }}
            onSelect={(action) => choose(menuItem, action, menu.anchor)} onClose={() => closeMenu(true)} />
        )}
        {respond.picker}
        {!reading && items.length === 0 && <p className="ab-empty">{t(all ? 'allEmpty' : ownScope ? 'ownEmpty' : 'laneEmpty')}</p>}
      </div>
      {state?.syncedAt !== undefined && <div className="rv-lane-foot">{syncing ? t('syncing') : t('syncedAt', { time: time(state.syncedAt) })}</div>}
    </section>
    </Zone>
  )
}

/** Where the sent ones begin, and where those merged or closed since do: how many, and how long they stay. */
function SentDivider(props: { group: { rank: number; n: number; closed: boolean }; keepDays: number | undefined }): ReactNode {
  const { group, keepDays } = props
  if (group.rank !== 3) return <div className="rv-divider" role="separator"><span>{t('doneGroup', { n: group.n })}</span></div>
  return (
    <div className="rv-divider" role="separator" data-landed="">
      <span>{t(group.closed ? 'endedGroup' : 'landedGroup', { n: group.n })}</span>
      {keepDays !== undefined && keepDays > 0 && <span className="rv-divider-note" title={t('landedKeepHint', { n: keepDays })}>{t('landedKeep', { n: keepDays })}</span>}
    </div>
  )
}

/**
 * Answering one of my pull requests: at once when a tree is on its branch (the sheet's, or one the
 * host finds), else a menu of where to work: a new worktree first, then the other trees, the ones
 * with uncommitted changes shown but not offered.
 */
function useRespond(store: ReviewStore): { start(item: ReviewItem, anchor: MenuAnchor, options?: { fresh?: boolean; bot?: string }): void; picker: ReactNode } {
  const [asking, setAsking] = useState<{ item: ReviewItem; anchor: MenuAnchor; fresh?: boolean; bot?: string; places?: TreePlaces; error?: string } | undefined>()
  const start = useCallback((item: ReviewItem, anchor: MenuAnchor, options: { fresh?: boolean; bot?: string } = {}) => {
    const go = (tree?: TreeChoice): void => void store.analyze(item.key, options.fresh === true, options.bot, tree)
    // The sheet's tree goes on, unless the last start failed (that tree may be gone or on another branch now).
    if (item.tree !== undefined && item.error === undefined) {
      go()
      return
    }
    setAsking({ item, anchor, ...options })
    const same = (current: typeof asking): boolean => current?.item.key === item.key
    store.places(item.key).then((places) => {
      if (places.existing !== undefined) {
        setAsking((current) => (same(current) ? undefined : current))
        go()
        return
      }
      setAsking((current) => (same(current) ? { ...current!, places } : current))
    }, (error: unknown) => setAsking((current) => (same(current) ? { ...current!, error: message(error) } : current)))
  }, [store])
  useEffect(injectGitStyle, [])
  if (asking === undefined) return { start, picker: null }
  const { item, places } = asking
  const entries: MenuEntry[] = asking.error !== undefined
    ? [{ heading: t('tree.failed', { message: asking.error }) }]
    : places === undefined
      ? [{ heading: t('tree.loading') }]
      : places.cross === true
        ? [{ heading: t('own.forkHint') }]
        : [
          { heading: t('tree.heading', { branch: places.branch }) },
          { id: 'new', label: t('tree.new'), hint: `.worktrees/${places.branch}`, icon: icon('M8 3v10M3 8h10') },
          ...(places.options.length === 0 ? [] : [{ separator: true } as const]),
          ...places.options.map((option): MenuEntry => ({
            id: `path:${option.path}`,
            label: option.main ? t('tree.main', { name: repoName(option.path) }) : option.branch ?? repoName(option.path),
            hint: option.dirty ? t('tree.dirty') : option.branch === undefined ? t('tree.detached') : t('tree.on', { branch: option.branch }),
            disabled: option.dirty,
            icon: icon('M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z'),
          })),
        ]
  const picker = (
    <Menu anchor={asking.anchor} entries={entries} label={t('tree.label', { branch: item.branch })} className="rv-menu"
      onClose={() => setAsking(undefined)}
      onSelect={(id) => {
        setAsking(undefined)
        const tree: TreeChoice | undefined = id === 'new' ? { kind: 'new' } : id.startsWith('path:') ? { kind: 'path', path: id.slice(5) } : undefined
        if (tree !== undefined) void store.analyze(item.key, asking.fresh === true, asking.bot, tree)
      }} />
  )
  return { start, picker }
}

/** How long 全部终止 waits for its second click. */
const CONFIRM_MS = 3000

/**
 * Stop every analysis: an icon in the lane's head (`compact`), a button atop a narrow lane. Always
 * there, so the buttons beside it never move; disabled with nothing to stop. Stopping more than one
 * asks once more in place: the button turns into 终止 N 个？ until a second click, Esc, or a moment.
 */
function StopAll(props: { count: number; compact?: boolean; onStop(): void }): ReactNode {
  const [asking, setAsking] = useState(false)
  const confirming = asking && props.count > 1
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setAsking(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])
  useEffect(() => { if (props.count === 0) setAsking(false) }, [props.count])
  const click = (): void => {
    if (props.count > 1 && !confirming) {
      setAsking(true)
      return
    }
    setAsking(false)
    props.onStop()
  }
  const label = confirming ? t('stopAllConfirm', { n: props.count }) : t('stopAll')
  const hint = confirming ? t('stopAllConfirmHint', { n: props.count }) : t('stopAllHint')
  return (
    <button type="button" className={props.compact ? 'ah-icon-btn ah-icon-sm rv-stop-all' : 'ah-btn rv-stop-all'} data-confirm={confirming ? '' : undefined}
      title={hint} aria-label={props.compact ? label : undefined} aria-live="polite" disabled={props.count === 0}
      onBlur={() => setAsking(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirming) {
          event.stopPropagation()
          setAsking(false)
        }
      }}
      onClick={click}>
      <StopIcon />
      {(!props.compact || confirming) && <span>{label}</span>}
    </button>
  )
}

/** A card's menu, in the git pane's style (a bottom sheet on touch). */
function CardMenu(props: {
  item: ReviewItem
  run: ReviewRun | undefined
  anchor: MenuAnchor
  bots: readonly ReviewBot[]
  defaultBot: string
  onAnalyze(bot: string): void
  onSelect(action: MenuAction): void
  onClose(): void
}): ReactNode {
  useEffect(injectGitStyle, [])
  const [pickingBot, setPickingBot] = useState(false)
  // The entries follow the run as it moves on while the menu is open.
  const entries = useMemo<MenuEntry[]>(() => {
    if (!pickingBot) return menuEntries(props.item, props.run, props.bots.length > 0)
    const bots = [...props.bots].sort((a, b) => Number(b.id === props.defaultBot) - Number(a.id === props.defaultBot))
    return [
      { id: 'back', label: t('menu.back'), icon: <span aria-hidden="true">←</span> },
      { heading: t('menu.botHeading') },
      ...bots.map((bot) => ({
        id: `bot:${bot.id}`,
        label: bot.id,
        hint: bot.id === props.defaultBot
          ? `${t('menu.defaultBot')}${bot.description === undefined ? '' : ` · ${bot.description}`}`
          : bot.description,
        checked: bot.id === props.defaultBot,
      })),
    ]
  }, [pickingBot, props.item, props.run, props.bots, props.defaultBot])
  const select = (id: string): void => {
    if (id === 'chooseBot') {
      setPickingBot(true)
      return
    }
    if (id === 'back') {
      setPickingBot(false)
      return
    }
    if (id.startsWith('bot:')) {
      props.onAnalyze(id.slice(4))
      return
    }
    props.onSelect(id as MenuAction)
  }
  return (
    <Menu anchor={props.anchor} entries={entries} label={pickingBot ? t('menu.botLabel', { n: props.item.number }) : t('menu.label', { n: props.item.number })}
      className="rv-menu" onSelect={select} onClose={props.onClose} />
  )
}

/** Below this much board, the detail shows the sheet or the changes; above it, both side by side. */
const WIDE_MIN = 960

/** The width of the element's parent (the board), followed. */
function useRoom(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (parent === null || parent === undefined) return
    setWidth(parent.clientWidth)
    const observer = new ResizeObserver(() => setWidth(parent.clientWidth))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * A right-click on the clear scrim beside the detail goes to the review card beneath it, so a card's
 * menu opens with the detail still in view. Elsewhere the scrim keeps the browser's own menu.
 */
function contextThrough(event: ReactMouseEvent<HTMLElement>): void {
  const { clientX, clientY } = event
  const card = document.elementsFromPoint(clientX, clientY).find((element) => element !== event.currentTarget)?.closest('.rv-card')
  if (card === null || card === undefined) return
  event.preventDefault()
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY, button: 2 }))
}

/**
 * A review card's detail: its sheet (or, not analysed yet, what it is and 分析) and the pull
 * request's changes. A wide board shows both side by side; a narrow one switches between them.
 */
export function ReviewDetail(props: { face: ReviewFace; item: ReviewItem; narrow: boolean; onClose(): void; onOpen?: (key: string) => void }): ReactNode {
  const { face, item, onClose } = props
  const respond = useRespond(face.store)
  /** Where the tree picker opens from the detail: below what was pressed, else atop the sheet. */
  const answer = (from?: Element): void => {
    const rect = aside.current?.getBoundingClientRect()
    respond.start(item, from !== undefined ? below(from) : { x: (rect?.left ?? 0) + 24, y: (rect?.top ?? 0) + 72 })
  }
  const analysed = item.phase !== 'new'
  const snapshot = useReview(face)
  const run = snapshot.progress?.runs.find((entry) => entry.key === item.key)
  const aside = useRef<HTMLElement>(null)
  const room = useRoom(aside)
  const wide = !props.narrow && room >= WIDE_MIN
  const [view, setView] = useView()
  const both = wide && view === 'diff'
  const [reveal, setReveal] = useState<Reveal | undefined>()
  const findings = useFindings(face.store, analysed ? item.path : undefined)
  const stamp = diffStamp(item)
  // Read as the detail opens, so the changes are there when asked for.
  const [files, setFiles] = useState<number | undefined>(() => face.store.diffNow(item.key, stamp)?.files.length)
  useEffect(() => {
    let live = true
    face.store.diff(item.key, stamp).then((diff) => { if (live) setFiles(diff.files.length) }, () => {})
    return () => { live = false }
  }, [face.store, item.key, stamp])
  // The changes mount the first time they are shown, and stay: switching back keeps their place.
  const [seen, setSeen] = useState(view === 'diff')
  useEffect(() => { if (view === 'diff') setSeen(true) }, [view])
  const timeline = run === undefined ? null : (
    <RunTimeline key={run.startedAt} run={run} item={item} skew={snapshot.skew}
      onRetry={() => (run.mode === 'fix' ? void face.store.fix(item.path) : item.own === true ? answer() : void face.store.analyze(item.key))}
      {...(analysed ? { onStop: () => void face.store.cancel(item.key) } : {})} />
  )
  const showLine = (path: string, line?: number, start?: number, thread?: string): void => {
    setView('diff')
    setReveal({ path, ...(line === undefined ? {} : { line }), ...(start === undefined ? {} : { start }), ...(thread === undefined ? {} : { thread }), nonce: Date.now() })
  }
  const onFinding = (id: string): void => {
    if (!both) setView('sheet')
    showFinding(aside.current, id)
  }
  const merge = item.own === true ? <MergeStrip store={face.store} item={item} /> : null
  const stacks = useMemo(() => stackIndex(snapshot.state), [snapshot.state])
  const stack = props.onOpen === undefined ? null
    : <StackPanel store={face.store} item={item} index={stacks} narrow={props.narrow} onOpen={(key) => props.onOpen?.(REVIEW_PREFIX + key)} />
  return (
    <>
      <div className="ab-scrim" onClick={onClose} onContextMenu={props.narrow ? undefined : contextThrough} aria-hidden="true" />
      <aside ref={aside} className="ab-detail rv-detail" tabIndex={-1} role="dialog" aria-modal={props.narrow} aria-label={item.title}
        data-wide={both ? '' : undefined}>
        <header className="ab-detail-head">
          <span className="ab-id">#{item.number} · {repoName(item.repo)}</span>
          <ViewSwitch view={view} files={files} onChange={setView} />
          <span className="ab-grow" />
          <CopyButton className="ab-copy" text={item.url} label={t('copyLink')} copied={t('copied')} hotkey={COPY_LINK_KEY} icon={<LinkIcon />} />
          <a className="ab-link" href={item.url} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          <button type="button" className="ah-icon-btn" aria-label={t('close')} title={t('close')} onClick={onClose}>
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" /></svg>
          </button>
        </header>
        <div className="rv-panes" data-both={both ? '' : undefined}>
          <div className="ab-detail-body rv-pane" data-off={!both && view !== 'sheet' ? '' : undefined}>
            {analysed && timeline}
            {analysed
              ? (
                <ReviewSheet store={face.store} path={item.path} repo={item.repo} item={item} actions={{
                  openSession: (sessionId, path) => {
                    face.nav.openReview(sessionId, path)
                    onClose()
                  },
                  ...(item.session === undefined ? {} : {
                    openSource: (path: string) => {
                      face.nav.openSource(item.session, path)
                      onClose()
                    },
                  }),
                  showLine,
                  respond: () => answer(),
                  close: onClose,
                }} below={<>{stack}{merge}</>} />
              )
              : (
                <div className="rv-sheet">
                  <h3 className="ab-detail-title">{item.title}</h3>
                  <div className="rv-meta">
                    {item.own !== true && item.author !== '' && <span>@{item.author}</span>}
                    <PhaseChip item={item} />
                    {item.own === true && item.reviewDecision !== undefined && <span className="rv-chip rv-rd" data-rd={item.reviewDecision}>{t(`rd.${item.reviewDecision}`)}</span>}
                    {item.own === true && item.pending !== undefined && item.pending > 0 && <span className="rv-chip rv-pending">{t('own.pending', { n: item.pending })}</span>}
                  </div>
                  <Branches head={item.branch} base={item.base} />
                  {stack}
                  {merge}
                  {item.cross === true && <p className="rv-banner">{t('own.forkHint')}</p>}
                  {timeline}
                  {item.error !== undefined && run?.step !== 'failed' && <p className="rv-banner" role="alert">{t('startFailed', { message: item.error })}</p>}
                  <div className="rv-foot">
                    {busy(item, run) && <StopButton className="ah-btn rv-btn-stop" queued={run?.step === 'queued'} onStop={() => void face.store.cancel(item.key)} />}
                    <span className="rv-grow" />
                    <button type="button" className="ah-btn" data-variant="primary" disabled={busy(item, run) || item.cross === true}
                      onClick={(event) => (item.own === true ? answer(event.currentTarget) : void face.store.analyze(item.key))}>
                      {busy(item, run) ? (run !== undefined && !runEnded(run.step) ? stepLabel(run.step, run.mode) : t('phase.queued')) : againLabel(item, run)}
                    </button>
                  </div>
                </div>
              )}
          </div>
          <div className="rv-pane rv-pane-diff" data-off={!both && view !== 'diff' ? '' : undefined}>
            {(seen || both) && <DiffPane store={face.store} item={item} findings={findings} {...(reveal === undefined ? {} : { reveal })} onFinding={onFinding} />}
          </div>
        </div>
      </aside>
      {respond.picker}
    </>
  )
}
