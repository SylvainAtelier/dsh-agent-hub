/**
 * The 工作树 tab: every working tree of the repository, this one marked. A
 * row names the tree by its branch and says what is in it (changes, sessions);
 * its main action opens a session there. Creating and removing say up front
 * where the folder goes and what leaves with it. With Linear connected, a
 * tree whose branch names a ticket shows it, and a new tree can start from one.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Worktree } from '../../git/types.ts'
import type { Issue, LinkedIssues } from '../../connectors/types.ts'
import type { ConnectorsStore } from '../connectors/api.ts'
import { createTree, openTree, openTreeMenu, runTreeAction, treeName } from './actions.tsx'
import { usePane, useRepo } from './context.ts'
import { t } from './i18n.ts'
import { IconBranch, IconMore, IconPlus, IconWorktree } from './icons.tsx'
import { pressHandlers } from './kit.tsx'

/** `.worktrees/feat/x` for trees in the hub's home (inside the main tree), the folder name for the main one, the full path otherwise. */
function shortPath(tree: Worktree, home: string): string {
  const sep = home.includes('\\') ? '\\' : '/'
  const lower = (value: string): string => (sep === '\\' ? value.toLowerCase() : value)
  const parent = home.slice(0, home.lastIndexOf(sep))
  if (lower(tree.path).startsWith(lower(home) + sep)) return tree.path.slice(parent.length + 1)
  if (tree.main) return tree.path.slice(tree.path.lastIndexOf(sep) + 1)
  return tree.path
}

const NO_TICKETS: ConnectorsStore['getSnapshot'] = () => ({ connectors: undefined, issues: false, error: null })
const noSubscribe = (): (() => void) => () => {}

/** The tickets the listed branches carry, read again whenever the branches change. */
function useLinked(tickets: ConnectorsStore | undefined, branches: string, cwd: string): LinkedIssues {
  const on = useSyncExternalStore(tickets?.subscribe ?? noSubscribe, tickets?.getSnapshot ?? NO_TICKETS).issues
  const [linked, setLinked] = useState<LinkedIssues>({})
  useEffect(() => { void tickets?.load() }, [tickets])
  useEffect(() => {
    if (tickets === undefined || !on || branches === '') return setLinked({})
    let live = true
    tickets.linked(branches.split('\n'), cwd).then((value) => { if (live) setLinked(value) }, () => {})
    return () => { live = false }
  }, [tickets, on, branches, cwd])
  return linked
}

export function WorktreesView(): ReactNode {
  const pane = usePane()
  const { repo } = pane
  const trees = useRepo(repo, (state) => state.trees)
  const busy = useRepo(repo, (state) => state.busy)
  const branches = (trees?.list?.worktrees ?? []).map((tree) => tree.branch).filter((branch): branch is string => branch !== undefined).join('\n')
  const linked = useLinked(pane.tickets, branches, repo.cwd)

  // Other trees change outside this pane (agents at work there): read again on open and on return to the page.
  useEffect(() => {
    void repo.loadTrees()
    const wake = (): void => { if (document.visibilityState === 'visible') void repo.loadTrees() }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [repo])

  const list = trees?.list
  if (list === undefined) {
    if (trees?.error !== undefined && !trees.loading) {
      return (
        <div className="gp-state">
          <p>{t('loadFailed', { error: trees.error })}</p>
          <button type="button" className="ah-btn" onClick={() => void repo.loadTrees()}>{t('retry')}</button>
        </div>
      )
    }
    return <div className="gp-skeleton-list" aria-busy="true">{Array.from({ length: 3 }, (_, i) => <div key={i} className="gp-skeleton-row" />)}</div>
  }

  const gone = list.worktrees.some((tree) => tree.prunable !== undefined)
  return (
    <div className="gp-list gw-list" data-gp-scroll="">
      <div className="gw-head">
        <span className="gp-section gp-section-title">{t('trees')}</span>
        <span className="gp-count">{list.worktrees.length}</span>
        <span className="gp-grow" />
        {gone && (
          <button type="button" className="gp-text-btn" disabled={busy !== undefined} onClick={() => void repo.run({ op: 'worktree-prune' }, { done: 'done' })}>
            {t('treePrune')}
          </button>
        )}
        {list.worktrees.length > 1 && (
          <button type="button" className="gp-text-btn" title={t('treeReclaimTip')} disabled={busy !== undefined} onClick={() => void reclaim(repo)}>
            {busy === 'worktree-reclaim' ? t('treeReclaiming') : t('treeReclaim')}
          </button>
        )}
        <button type="button" className="ah-btn ah-btn-sm" data-variant="primary" disabled={busy !== undefined || repo.getSnapshot().status?.head === undefined}
          onClick={() => createTree(pane)}>
          <IconPlus size={14} />{t('newTree').replace(/…$/, '')}
        </button>
      </div>
      <div role="list" aria-label={t('trees')}>
        {list.worktrees.map((tree) => <TreeRow key={tree.path} tree={tree} home={list.home} issue={tree.branch === undefined ? undefined : linked[tree.branch]} />)}
      </div>
      {list.worktrees.length === 1 && (
        <div className="gw-empty">
          <IconWorktree size={22} />
          <strong>{t('treesEmptyTitle')}</strong>
          <p>{t('treesEmptyBody')}</p>
        </div>
      )}
    </div>
  )
}

/** Share the other trees' packages with the main tree's, and say what that freed. */
async function reclaim(repo: ReturnType<typeof usePane>['repo']): Promise<void> {
  const reply = await repo.run({ op: 'worktree-reclaim' })
  if (!reply.ok) return
  const { trees, packages, freed = 0 } = reply.value
  const size = freed >= 1 << 30 ? `${(freed / 2 ** 30).toFixed(1)} GB` : `${Math.round(freed / 2 ** 20)} MB`
  repo.toast('ok', packages > 0 ? t('treeReclaimed', { trees, n: packages, size }) : t('treeReclaimNone'))
}

function TreeRow(props: { tree: Worktree; home: string; issue: Issue | undefined }): ReactNode {
  const pane = usePane()
  const { tree } = props
  const gone = tree.prunable !== undefined
  const openable = !tree.current && !gone
  const changes = tree.changes ?? 0
  const sessions = tree.workspace?.sessions ?? 0
  const menu = pressHandlers((anchor) => openTreeMenu(pane, tree, anchor))
  const facts = [
    gone ? t('treeGone') : tree.changes === undefined ? '' : changes > 0 ? t('treeChanges', { n: changes }) : t('treeClean'),
    sessions > 0 ? t('treeSessions', { n: sessions }) : '',
    !gone && tree.workspace === undefined ? t('treeUnregistered') : '',
  ].filter(Boolean)
  return (
    <div role="listitem" className="gw-row" tabIndex={0} data-current={tree.current ? '' : undefined} data-gone={gone ? '' : undefined}
      data-openable={openable ? '' : undefined} title={tree.path}
      onClick={() => { if (openable) void openTree(pane, tree) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && openable) void openTree(pane, tree)
        else if (event.key === 'Delete' && !tree.main && !tree.current) runTreeAction('remove', tree, pane)
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const sibling = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
          ;(sibling as HTMLElement | null)?.focus()
        } else return
        event.preventDefault()
      }}
      {...menu}>
      <span className="gw-icon" aria-hidden="true"><IconBranch size={15} /></span>
      <div className="gw-main">
        <div className="gw-line">
          <span className="gw-name">{treeName(tree)}</span>
          {props.issue !== undefined && <IssueTag issue={props.issue} />}
          {tree.current && <span className="gw-tag" data-kind="current">{t('treeCurrent')}</span>}
          {tree.main && <span className="gw-tag">{t('treeMain')}</span>}
          {tree.locked !== undefined && <span className="gw-tag" title={tree.locked || undefined}>{t('treeLocked')}</span>}
        </div>
        <div className="gw-sub">
          <span className="gw-path">{shortPath(tree, props.home)}</span>
          {facts.map((fact) => <span key={fact} className="gw-fact" data-dirty={fact === t('treeChanges', { n: changes }) ? '' : undefined}>{fact}</span>)}
        </div>
      </div>
      <div className="gw-actions">
        {openable && (
          <button type="button" className="ah-btn ah-btn-sm gw-open" title={t('treeOpenTip')}
            onClick={(event) => {
              event.stopPropagation()
              void openTree(pane, tree)
            }}>
            {t('treeOpen')}
          </button>
        )}
        <button type="button" className="ah-icon-btn" aria-label={t('more')} title={t('more')} aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation()
            openTreeMenu(pane, tree, { x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), align: 'end' })
          }}>
          <IconMore size={15} />
        </button>
      </div>
    </div>
  )
}

/** The ticket a tree works on: its identifier and state; opens it in Linear. */
function IssueTag(props: { issue: Issue }): ReactNode {
  const { issue } = props
  const label = t('issueOpen', { id: issue.identifier, title: issue.title })
  const body = (
    <>
      <span className="gp-pick-dot" aria-hidden="true" />
      <span className="gw-issue-id">{issue.identifier}</span>
      {issue.state !== undefined && <span className="gw-issue-state">{issue.state}</span>}
    </>
  )
  return issue.url === undefined
    ? <span className="gw-issue" data-tone={issue.stateType} title={issue.title}>{body}</span>
    : (
        <a className="gw-issue" data-tone={issue.stateType} href={issue.url} target="_blank" rel="noopener noreferrer" title={label} aria-label={label}
          onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          {body}
        </a>
      )
}
