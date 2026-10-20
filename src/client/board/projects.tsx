/**
 * Linear projects on the board: a colour per project (Linear's own, else one
 * worked out from its name) on cards, the filter and the detail; the filter in
 * the bar, which is also the list of every project; a ticket's project in its
 * detail. A card knows its project by name, so that is the key throughout.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { stageOf, type Card, type ProjectInfo } from '../../board/types.ts'
import { isEnglish, t } from './i18n.ts'
import { ProjectIcon } from './marks.tsx'
import { Picker, type Option } from './NewTicket.tsx'

/** Linear's default project colour: every project left uncoloured has it, so it tells none apart. */
const DEFAULT_COLOR = '#bec2c8'
/** A project status as the board's stage dots draw it. */
const STATUS_STAGE: Record<string, string> = { backlog: 'backlog', planned: 'unstarted', started: 'started', paused: 'backlog', completed: 'completed', canceled: 'canceled' }
const over = (project: ProjectInfo | undefined): boolean => project?.statusType === 'completed' || project?.statusType === 'canceled'

/** A project's colour: Linear's, unless it is the default; else a steady hue from its name. */
export function projectColor(name: string, project: ProjectInfo | undefined): string {
  const own = project?.color
  if (own !== undefined && own.toLowerCase() !== DEFAULT_COLOR) return own
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return `hsl(${hash % 360} 58% 52%)`
}

export function ProjectDot(props: { name: string; project: ProjectInfo | undefined }): ReactNode {
  return <span className="ab-pdot" style={{ '--ab-pc': projectColor(props.name, props.project) } as CSSProperties} aria-hidden="true" />
}

/**
 * Linear's list of projects for the team most of the cards are in, from a card's address
 * (`linear.app/<workspace>/issue/ENG-1/…` → `linear.app/<workspace>/team/ENG/projects/all`).
 */
export function projectsUrl(cards: readonly Card[]): string | undefined {
  const teams = new Map<string, { workspace: string; n: number }>()
  for (const card of cards) {
    const match = card.source === 'linear' && card.url !== undefined ? /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*)-\d+/.exec(card.url) : null
    if (match === null) continue
    const key = match[2]!.toUpperCase()
    teams.set(key, { workspace: match[1]!, n: (teams.get(key)?.n ?? 0) + 1 })
  }
  const [key, top] = [...teams].sort((a, b) => b[1].n - a[1].n)[0] ?? []
  return key === undefined ? undefined : `https://linear.app/${top!.workspace}/team/${key}/projects/all`
}

/** A date-only day (2026-11-30) as the page's language writes it, the year only when it is not this one. */
const day = (value: string): string => {
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(isEnglish() ? 'en' : 'zh-CN', {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...(date.getUTCFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
}

function Progress(props: { value: number }): ReactNode {
  const percent = Math.round(props.value * 100)
  return (
    <span className="ab-progress" role="img" aria-label={t('projectProgress', { n: percent })} title={t('projectProgress', { n: percent })}>
      <span className="ab-progress-bar"><span style={{ width: `${percent}%` }} /></span>{percent}%
    </span>
  )
}

/**
 * The project filter in the bar, and the list of every project: those with cards on the board
 * first (most cards first), then the projects under way that have none. Picking one shows all its
 * tickets (the board reads them from Linear), whoever they are assigned to.
 */
export function ProjectFilter(props: {
  /** The cards the other filters let through: what each project counts. */
  cards: readonly Card[]
  projects: ReadonlyMap<string, ProjectInfo>
  value: string
  /** Linear's own list of projects. */
  url: string | undefined
  onChange(project: string): void
}): ReactNode {
  const { cards, projects, value } = props
  const options = useMemo<Option[]>(() => {
    const counts = new Map<string, number>()
    for (const card of cards) if (card.project !== undefined) counts.set(card.project, (counts.get(card.project) ?? 0) + 1)
    const onBoard = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const idle = [...projects.values()].filter((project) => !counts.has(project.name) && !over(project)).sort((a, b) => a.name.localeCompare(b.name))
    const describe = (project: ProjectInfo | undefined): string | undefined =>
      [project?.status, project?.progress === undefined ? undefined : t('projectProgress', { n: Math.round(project.progress * 100) })].filter(Boolean).join(' · ') || undefined
    const total = cards.filter((card) => card.project !== undefined).length
    return [
      { id: '', name: t('allProjects'), icon: <ProjectIcon />, hint: <span className="ab-count">{total}</span> },
      ...onBoard.map(([name, n]): Option => {
        const project = projects.get(name)
        const title = describe(project)
        return {
          id: name, name, group: t('projectsOnBoard'), icon: <ProjectDot name={name} project={project} />,
          ...(title === undefined ? {} : { title }),
          hint: <>{project?.progress !== undefined && <span className="ab-progress-bar" aria-hidden="true"><span style={{ width: `${Math.round(project.progress * 100)}%` }} /></span>}<span className="ab-count">{n}</span></>,
        }
      }),
      ...idle.map((project): Option => {
        const title = describe(project)
        return {
          id: project.name, name: project.name, group: t('projectsIdle'), icon: <ProjectDot name={project.name} project={project} />,
          ...(title === undefined ? {} : { title }),
        }
      }),
    ]
  }, [cards, projects])
  const active = value !== ''
  return (
    <div className="ab-pfilter" data-active={active ? '' : undefined}>
      <Picker label={active ? t('projectFiltered', { project: value }) : t('projectFilter')} empty={!active} options={options} selected={[value]}
        icon={active ? <ProjectDot name={value} project={projects.get(value)} /> : <ProjectIcon />}
        value={<span className="ab-pfilter-text">{active ? value : t('allProjects')}</span>}
        searchHint={t('searchProjects')}
        footer={props.url === undefined ? undefined : (
          <a className="ab-pick-foot" href={props.url} target="_blank" rel="noopener noreferrer">{t('projectsInLinear')} ↗</a>
        )}
        onPick={(id) => props.onChange(id)} />
      {active && (
        <button type="button" className="ah-icon-btn ah-icon-sm ab-pfilter-clear" aria-label={t('clearProject')} title={t('clearProject')} onClick={() => props.onChange('')}>
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" /></svg>
        </button>
      )}
    </div>
  )
}

/** A ticket's project in its detail: name (a link to it in Linear), status, progress, lead, target date, summary. */
export function ProjectDetail(props: { name: string; project: ProjectInfo | undefined; active: boolean; onFilter(on: boolean): void }): ReactNode {
  const { name, project } = props
  const stage = project?.statusType === undefined ? undefined : STATUS_STAGE[project.statusType] ?? stageOf(project.statusType)
  const meta = project !== undefined && (project.status !== undefined || project.progress !== undefined || project.lead !== undefined || project.targetDate !== undefined)
  return (
    <div className="ab-project">
      <div className="ab-project-line">
        <ProjectDot name={name} project={project} />
        {project?.url === undefined
          ? <span className="ab-project-name">{name}</span>
          : <a className="ab-project-name" href={project.url} target="_blank" rel="noopener noreferrer" title={t('openProject')}>{name} <span aria-hidden="true">↗</span></a>}
        <span className="ab-grow" />
        <button type="button" className="ab-link" aria-pressed={props.active} onClick={() => props.onFilter(!props.active)}>
          {props.active ? t('allProjectsBack') : t('onlyProject')}
        </button>
      </div>
      {meta && project !== undefined && (
        <div className="ab-project-meta">
          {project.status !== undefined && <span className="ab-project-status">{stage !== undefined && <span className="ab-dot" data-stage={stage} aria-hidden="true" />}{project.status}</span>}
          {project.progress !== undefined && <Progress value={project.progress} />}
          {project.lead !== undefined && <span>{t('projectLead', { name: project.lead })}</span>}
          {project.targetDate !== undefined && <span>{t('projectDue', { date: day(project.targetDate) })}</span>}
        </div>
      )}
      {project?.summary !== undefined && <p className="ab-project-summary" title={project.summary}>{project.summary}</p>}
    </div>
  )
}
