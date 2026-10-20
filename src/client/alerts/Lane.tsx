import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AlertOrder, AlertPeriod, AlertSort, SentryIssue } from '../../alerts/types.ts'
import type { ReviewItem } from '../../review/types.ts'
import { isEnglish } from '../board/i18n.ts'
import type { AlertsSnapshot, AlertsStore } from './api.ts'
import type { ReviewNav } from '../review/index.tsx'
import { COPY_LINK_KEY, CopyButton, LinkIcon } from '../copy.tsx'
import { Markdown } from '../review/Markdown.tsx'
import { phaseName, splitTitle, tidyTitle } from './title.ts'
export { issueMatches } from './title.ts'
import { pairLink, PullIcon, ZoneMark } from '../board/marks.tsx'
import { Zone, ZoneHead, ZoneSkeleton } from '../board/zone.tsx'

export const ALERT_PREFIX = 'alert:'
const BOT_KEY = 'dsh-agent-hub.alerts.bot'
const tx = (zh: string, en: string): string => isEnglish() ? en : zh
const formatCount = (value: number | undefined): string => value === undefined ? '—' : Intl.NumberFormat(isEnglish() ? 'en' : 'zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value)
const relative = (value: string | undefined): string => {
  if (!value) return '—'
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  const seconds = Math.round((time - Date.now()) / 1000)
  const unit: Intl.RelativeTimeFormatUnit = Math.abs(seconds) < 3600 ? 'minute' : Math.abs(seconds) < 86400 ? 'hour' : 'day'
  const divisor = unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400
  return new Intl.RelativeTimeFormat(isEnglish() ? 'en' : 'zh-CN', { numeric: 'auto' }).format(Math.round(seconds / divisor), unit)
}

const LONG_TITLE = 140

function IssueTitle(props: { title: string; as: 'h2' | 'h4' }): ReactNode {
  const { kind, message } = splitTitle(props.title)
  const [open, setOpen] = useState(false)
  const Heading = props.as
  const tidy = tidyTitle(message)
  // The detail can always show what the tidy one left out.
  const long = props.as === 'h2' && (tidy !== message || props.title.length > LONG_TITLE)
  return <div className="aa-title" data-open={open ? '' : undefined}>
    {kind && <span className="aa-kind">{kind}</span>}
    <Heading title={props.title}>{props.as === 'h4' || (long && !open) ? tidy : message}</Heading>
    {long && <button type="button" className="aa-title-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? tx('收起', 'Less') : tx('完整标题', 'Full title')}</button>}
  </div>
}

/** The pull requests fixing an issue (their branch or title names it), each opening its review. */
export type IssuePulls = ReadonlyMap<string, readonly ReviewItem[]>

const pullsHint = (pulls: readonly ReviewItem[]): string => pulls.map((pull) => `#${pull.number} ${pull.title}`).join('\n')

/** An issue's pull requests: one by its number, several by their count; it opens the first. */
function PullChip(props: { pulls: readonly ReviewItem[]; onOpen(key: string): void }): ReactNode {
  const { pulls } = props
  const label = pulls.length === 1 ? `#${pulls[0]!.number}` : tx(`${pulls.length} 个 PR`, `${pulls.length} PRs`)
  const hint = tx(`修复它的 PR：${pullsHint(pulls)}`, `Fixed in: ${pullsHint(pulls)}`)
  return <button type="button" className="ab-chip aa-pull" title={hint} aria-label={hint}
    onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onOpen(pulls[0]!.key) }}>
    <PullIcon />{label}
  </button>
}

/** Sentry's evidence is Markdown; a JSON fallback is fenced so it keeps its shape. */
const evidenceMarkdown = (text: string): string => /^\s*[[{]/.test(text) ? `\`\`\`json\n${text}\n\`\`\`` : text

export interface AlertsFace { store: AlertsStore; nav?: ReviewNav }
const EMPTY_ALERTS: AlertsSnapshot = { loading: false, notice: null, details: new Map(), resolving: new Set(), pending: new Set() }
const noSubscribe = (): (() => void) => () => {}
const emptySnapshot = (): AlertsSnapshot => EMPTY_ALERTS
export function useAlerts(face: AlertsFace | undefined): AlertsSnapshot {
  return useSyncExternalStore(face?.store.subscribe ?? noSubscribe, face?.store.getSnapshot ?? emptySnapshot)
}

function readBot(snapshot: AlertsSnapshot): string {
  try {
    const remembered = localStorage.getItem(BOT_KEY)
    if (remembered && snapshot.state?.bots.some((bot) => bot.id === remembered)) return remembered
  } catch { /* unavailable */ }
  return snapshot.state?.defaultBot ?? snapshot.state?.bots[0]?.id ?? ''
}

function Phase(props: { issue: SentryIssue }): ReactNode {
  const phase = props.issue.phase ?? 'unanalysed'
  return <span className="aa-phase" data-phase={phase}>{phaseName(phase)}</span>
}

function SortButton(props: { value: AlertSort; current: AlertSort; order: AlertOrder; onSort(value: AlertSort, order: AlertOrder): void; children: ReactNode }): ReactNode {
  const active = props.current === props.value
  return <button type="button" className="aa-sort" aria-pressed={active} onClick={() => props.onSort(props.value, active && props.order === 'desc' ? 'asc' : 'desc')}>
    {props.children}{active && <span aria-hidden="true">{props.order === 'desc' ? '↓' : '↑'}</span>}
  </button>
}

export function AlertsColumn(props: {
  face: AlertsFace
  snapshot: AlertsSnapshot
  /** What the board's search leaves of the issues. */
  issues: readonly SentryIssue[]
  /** The board's search, as typed; empty for none. */
  query: string
  onClearQuery(): void
  selected?: string
  onSelect(key: string | undefined): void
  narrow: boolean
  folded: boolean
  onFold(open: boolean): void
  /** The pull requests fixing each issue, by its id. */
  pulls: IssuePulls
  /** Open a pull request's review, by its key, and bring its card into view. */
  onPull(key: string, issue: string): void
}): ReactNode {
  const { state } = props.snapshot
  const [bot, setBot] = useState(() => readBot(props.snapshot))
  useEffect(() => { if (!bot && state) setBot(readBot(props.snapshot)) }, [bot, state, props.snapshot])
  const setSelectedBot = (value: string): void => { setBot(value); try { localStorage.setItem(BOT_KEY, value) } catch { /* unavailable */ } }
  const label = tx('Sentry 告警', 'Sentry alerts')
  const title = tx('告警', 'Alerts')
  // Not read yet: the zone holds its place (the board expects it from the binding it last saw).
  if (state === undefined) {
    return <Zone zone="alerts" head={!props.narrow && <ZoneHead zone="alerts" title={title} tools={<span className="ab-skeleton-bar" />} />}>
      <section className="ab-col aa-col" aria-label={label} aria-busy="true"><div className="ab-col-body"><ZoneSkeleton label={tx('正在读取 Sentry…', 'Reading Sentry…')} /></div></section>
    </Zone>
  }
  if (!state.enabled) return null
  const { issues } = props
  const hidden = state.issues.length - issues.length
  // The buttons follow the click at once; the list catches up when Sentry answers.
  const view = props.snapshot.query ?? state
  const switching = props.snapshot.loading && props.snapshot.query !== undefined
  const stale = switching && (view.period !== state.period || view.sort !== state.sort || view.order !== state.order)
  const update = (period: AlertPeriod, sort: AlertSort, order: AlertOrder): void => { void props.face.store.load(false, { period, sort, order }) }
  if (props.folded && !props.narrow) return <Zone zone="alerts" folded head={<header className="ab-zone-head"><div className="ab-zone-title"><ZoneMark zone="alerts" /></div><div className="ab-zone-tools" /></header>}>
    <section className="ab-col aa-col" data-folded="" aria-label={label}>
      <button type="button" className="ab-col-folded" onClick={() => props.onFold(true)} aria-label={tx(`展开 Sentry 告警，${issues.length} 条`, `Show Sentry alerts, ${issues.length}`)}>
        <span className="ab-col-folded-name">{title}</span><span className="ab-count">{issues.length}</span>
      </button>
    </section>
  </Zone>
  const period = <div className="ah-seg" role="radiogroup" aria-label={tx('时间范围', 'Period')}>
    {(['7d', '14d'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={view.period === value} onClick={() => update(value, view.sort, view.order)}>{value}</button>)}
  </div>
  const botPick = <select className="ab-select aa-bot" value={bot} aria-label={tx('分析机器人', 'Analysis bot')} title={tx('分析用的机器人', 'The bot that analyses')} onChange={(event) => setSelectedBot(event.target.value)}>
    {state.bots.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
  </select>
  const sorts = <div className="aa-sort-row" role="group" aria-label={tx('排序', 'Sort')}>
    <SortButton value="lastSeen" current={view.sort} order={view.order} onSort={(sort, order) => update(view.period, sort, order)}>{tx('最近', 'Last')}</SortButton>
    <SortButton value="age" current={view.sort} order={view.order} onSort={(sort, order) => update(view.period, sort, order)}>{tx('年龄', 'Age')}</SortButton>
    <SortButton value="events" current={view.sort} order={view.order} onSort={(sort, order) => update(view.period, sort, order)}>{tx('事件', 'Events')}</SortButton>
  </div>
  const fold = <button type="button" className="ah-icon-btn ah-icon-sm" title={tx('折叠告警', 'Collapse alerts')} aria-label={tx('折叠告警', 'Collapse alerts')} onClick={() => props.onFold(false)}>
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
  </button>
  const head = props.narrow ? undefined : <ZoneHead zone="alerts" title={title} count={issues.length} actions={<>{botPick}{fold}</>}
    tools={<div className="aa-tools" data-busy={switching ? '' : undefined}>{period}{sorts}<span className="aa-progress" aria-hidden="true" /></div>} />
  return <Zone zone="alerts" head={head}>
    <section className="ab-col aa-col" aria-label={label}>
      {props.narrow && <div className="ab-lane-bar"><div className="aa-tools" data-busy={switching ? '' : undefined}>{period}{botPick}{sorts}<span className="aa-progress" aria-hidden="true" /></div></div>}
      <p className="aa-sr" role="status">{switching ? tx('正在读取 Sentry…', 'Reading Sentry…') : ''}</p>
      {state.error && <p className="aa-note aa-error" role="alert">{state.error}</p>}
      {state.truncated && <p className="aa-note">{tx('仅显示前 100 条；升序仅在完整结果时本地反转。', 'Showing the first 100; ascending is only reversed for complete results.')}</p>}
      <div className="ab-col-body aa-list" aria-busy={switching} data-stale={stale ? '' : undefined}>
        {issues.map((issue) => <AlertCard key={issue.id} issue={issue} bot={bot} pending={props.snapshot.pending.has(issue.id)} store={props.face.store} nav={props.face.nav} selected={props.selected === ALERT_PREFIX + issue.id} onOpen={() => props.onSelect(ALERT_PREFIX + issue.id)}
          pulls={props.pulls.get(issue.id)} onPull={(key) => props.onPull(key, issue.id)} />)}
        {issues.length === 0 && hidden > 0 && <div className="ab-empty aa-nomatch" role="status">
          <p>{tx(`没有匹配「${props.query.trim()}」的告警`, `No alerts match “${props.query.trim()}”`)}</p>
          <p className="aa-nomatch-sub">{tx(`当前筛选下共 ${state.issues.length} 条`, `${state.issues.length} under the current filters`)}</p>
          <button type="button" className="ah-btn ah-btn-sm" onClick={props.onClearQuery}>{tx('清除搜索', 'Clear search')}</button>
        </div>}
        {state.issues.length === 0 && !state.error && <p className="ab-empty">{props.snapshot.loading ? tx('正在读取 Sentry…', 'Reading Sentry…') : tx('暂无未解决的 prod 告警', 'No unresolved prod alerts')}</p>}
      </div>
    </section>
  </Zone>
}

function AlertCard(props: { issue: SentryIssue; bot: string; pending: boolean; store: AlertsStore; nav?: ReviewNav; selected: boolean; onOpen(): void; pulls: readonly ReviewItem[] | undefined; onPull(key: string): void }): ReactNode {
  const { issue } = props
  const busy = props.pending || issue.phase === 'preparing' || issue.phase === 'analysing' || issue.phase === 'fixing'
  const primary = issue.phase === 'analysed' || issue.phase === 'regression' ? tx('修复', 'Fix') : issue.phase === 'fixed' ? tx('查看', 'View') : issue.phase === 'unanalysed' || issue.phase === undefined ? tx('分析', 'Analyse') : tx('查看', 'View')
  const act = (): void => {
    if (issue.phase === 'analysed' || issue.phase === 'regression') void props.store.fix(issue.id)
    else if (issue.phase === 'unanalysed' || issue.phase === undefined) void props.store.analyse(issue.id, props.bot)
    else props.onOpen()
  }
  return <article className="ab-card aa-card" data-phase={issue.phase ?? 'unanalysed'} data-selected={props.selected ? '' : undefined} data-link={props.pulls === undefined ? undefined : pairLink('sentry', issue.id)} tabIndex={0} role="button" onClick={props.onOpen} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onOpen() } }}>
    <div className="aa-card-top"><strong>{issue.id}</strong>{props.pulls !== undefined && <PullChip pulls={props.pulls} onOpen={props.onPull} />}<Phase issue={issue} /></div>
    <IssueTitle title={issue.title} as="h4" />
    {(issue.subtitle || issue.culprit) && <p className="aa-preview">{issue.subtitle ?? issue.culprit}</p>}
    {issue.error && <p className="aa-preview aa-error" role="status">{tx('上次未能开始分析：', 'Analysis did not start: ')}{issue.error}</p>}
    {issue.location && (issue.session && issue.tree && props.nav
      ? <button type="button" className="aa-source aa-source-link" onClick={(event) => { event.stopPropagation(); props.nav?.openSource(issue.session, issue.location!.path, issue.location!.line) }}>{issue.location.path}{issue.location.line ? `:${issue.location.line}` : ''}</button>
      : <code className="aa-source">{issue.location.path}{issue.location.line ? `:${issue.location.line}` : ''}</code>)}
    <dl className="aa-metrics"><div><dt>{tx('最近', 'Last')}</dt><dd>{relative(issue.lastSeen)}</dd></div><div><dt>{tx('年龄', 'Age')}</dt><dd>{relative(issue.firstSeen)}</dd></div><div><dt>{tx('事件', 'Events')}</dt><dd>{formatCount(issue.events)}</dd></div></dl>
    <div className="aa-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <button type="button" className="ah-btn aa-act" data-variant="primary" disabled={busy || (!props.bot && primary === tx('分析', 'Analyse'))} onClick={act}>{busy ? tx('处理中…', 'Working…') : primary}</button>
      <details className="aa-more"><summary aria-label={tx('更多操作', 'More actions')}>⋯</summary><div><button type="button" onClick={() => void props.store.resolve(issue)}>{tx('解决', 'Resolve')}</button>{issue.url && <a href={issue.url} target="_blank" rel="noreferrer">Sentry ↗</a>}</div></details>
    </div>
  </article>
}

export function AlertDetail(props: { face: AlertsFace; issue: SentryIssue; narrow: boolean; onClose(): void; pulls: readonly ReviewItem[] | undefined; onPull(key: string): void }): ReactNode {
  const snapshot = useAlerts(props.face)
  const detail = snapshot.details.get(props.issue.id)
  useEffect(() => { void props.face.store.detail(props.issue.id) }, [props.face.store, props.issue.id])
  const evidence = detail?.markdown ?? props.issue.raw
  return <aside className="ab-detail aa-detail" data-narrow={props.narrow ? '' : undefined} role="dialog" aria-modal="true" aria-label={`${props.issue.id}: ${props.issue.title}`}>
    <header className="ab-detail-head"><div className="aa-head-text"><span className="aa-id">{props.issue.id}</span><IssueTitle key={props.issue.id} title={props.issue.title} as="h2" /></div><span className="ab-grow" />
      {props.issue.url && <>
        <CopyButton className="aa-copy" text={props.issue.url} label={tx('复制 Sentry issue 链接', 'Copy Sentry issue link')} copied={tx('已复制', 'Copied')} hotkey={COPY_LINK_KEY} icon={<LinkIcon />} />
        <a className="ab-link aa-open" href={props.issue.url} target="_blank" rel="noreferrer">Sentry ↗</a>
      </>}
      <button type="button" className="ah-icon-btn" aria-label={tx('关闭', 'Close')} onClick={props.onClose}>×</button></header>
    <div className="ab-detail-body">
      <div className="aa-status" data-phase={props.issue.phase ?? 'unanalysed'}>
        <Phase issue={props.issue} />
        {props.issue.session && props.face.nav && <button type="button" className="ah-btn ah-btn-sm aa-session" onClick={() => props.face.nav?.openSession(props.issue.session!)}>{tx('打开关联会话', 'Open related session')} <span aria-hidden="true">↗</span></button>}
        {props.pulls?.map((pull) => <button key={pull.key} type="button" className="ah-btn ah-btn-sm aa-session" title={`#${pull.number} ${pull.title}`} onClick={() => props.onPull(pull.key)}><PullIcon />PR #{pull.number}</button>)}
      </div>
      {detail?.analysis && <section className="aa-evidence"><h3>{tx('分析结论', 'Conclusion')}</h3><Markdown className="aa-md" text={detail.analysis} /></section>}
      {(detail?.location ?? props.issue.location) && <section className="aa-evidence"><h3>{tx('可能来源', 'Likely source')}</h3>{props.issue.session && props.issue.tree && props.face.nav
        ? <button type="button" className="aa-open-source" onClick={() => props.face.nav?.openSource(props.issue.session, (detail?.location ?? props.issue.location)!.path, (detail?.location ?? props.issue.location)!.line)}>{(detail?.location ?? props.issue.location)!.path}{(detail?.location ?? props.issue.location)!.line ? `:${(detail?.location ?? props.issue.location)!.line}` : ''}</button>
        : <code>{(detail?.location ?? props.issue.location)!.path}{(detail?.location ?? props.issue.location)!.line ? `:${(detail?.location ?? props.issue.location)!.line}` : ''}</code>}</section>}
      {detail?.exception && <section className="aa-evidence"><h3>{tx('异常链', 'Exception chain')}</h3><p>{detail.exception}</p></section>}
      <section className="aa-evidence"><h3>{tx('事件与元数据', 'Evidence and metadata')}</h3>{evidence ? <Markdown className="aa-md aa-md-evidence" text={evidenceMarkdown(evidence)} /> : <p className="ab-muted">{tx('正在获取事件证据…', 'Fetching event evidence…')}</p>}</section>
    </div>
  </aside>
}
