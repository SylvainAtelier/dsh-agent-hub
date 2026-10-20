/**
 * A commit's details, expanded in place under its row in the graph (Git
 * Graph's commit details view). Lanes keep running down its left edge; the
 * message and metadata sit on the left, the changed files on the right (one
 * column on narrow panes). Clicking a file opens its diff over the middle
 * column; the graph does not move. The uncommitted-changes row expands the
 * same way, listing the working tree's files.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { ChangeCode, CommitDetail, CommitFile, GitReply, GitStatus, Ref } from '../../git/types.ts'
import { BadgeView, badgesFor, openCommitMenu, openRefMenu } from './actions.tsx'
import { CodeMark } from './Changes.tsx'
import { sameTarget, short, splitPath, usePane, type DiffTarget } from './context.ts'
import { TreeToggle } from './Detail.tsx'
import { fullDate, t } from './i18n.ts'
import { IconCheck, IconChevron, IconClose, IconCopy, IconDown, IconFolder, IconMore } from './icons.tsx'
import { laneColor } from './Graph.tsx'
import type { LaneLine } from './lanes.ts'
import { buildTree, flattenTree, itemsOf, treeMode } from './tree.ts'

/** One file in the expanded list: a commit's file, or a working-tree change. */
interface Item {
  path: string
  from?: string
  code: ChangeCode
  added?: number
  deleted?: number
  binary?: boolean
  target: DiffTarget
  /** Working-tree group label (staged / changes / conflicts). */
  group?: string
}

const LANE_W = 14

/** The lanes that run past the expanded block: the bottom ends of the row above it. */
function PassLanes(props: { lines: readonly LaneLine[]; width: number }): ReactNode {
  const seen = new Map<number, LaneLine>()
  for (const line of props.lines) if (line.half === 'bottom' && !seen.has(line.to)) seen.set(line.to, line)
  return (
    <svg className="gi-lanes" width={props.width} aria-hidden="true" preserveAspectRatio="none">
      {[...seen.values()].map((line) => {
        const x = LANE_W / 2 + line.to * LANE_W + 2
        return <line key={line.to} x1={x} x2={x} y1="0" y2="100%" stroke={laneColor(line.color)} strokeWidth="1.6" strokeDasharray={line.dashed ? '2 3' : undefined} />
      })}
    </svg>
  )
}

function FileList(props: { items: Item[]; context: string; grouped?: boolean }): ReactNode {
  const pane = usePane()
  const tree = useSyncExternalStore(treeMode.subscribe, treeMode.get)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  // Prev/next in the diff follows what is on screen.
  const ordered = useMemo(() => {
    if (!tree) return props.items
    const out: Item[] = []
    for (const group of groupsOf(props.items)) out.push(...itemsOf(buildTree(group.items, (item) => item.path)))
    return out
  }, [props.items, tree])
  const targets = useMemo(() => ordered.map((item) => item.target), [ordered])
  const open = (item: Item): void => pane.showDiff(item.target, targets, props.context)
  const row = (item: Item, name: string, dir: string, indent?: number): ReactNode => (
    <div key={`${item.group ?? ''}:${item.path}`} role="button" tabIndex={0} className="gp-row gp-file gi-file"
      data-active={sameTarget(item.target, pane.activeDiff) ? '' : undefined}
      style={indent === undefined ? undefined : { paddingLeft: indent }}
      title={item.from ? `${item.from} → ${item.path}` : item.path}
      onClick={() => open(item)} onKeyDown={(event) => { if (event.key === 'Enter') open(item) }}>
      <span className="gp-file-name">{name}</span>
      <span className="gp-file-dir">{dir}</span>
      {item.added !== undefined && !item.binary && (
        <span className="gp-stat gp-stat-sm"><span data-k="add">+{item.added}</span><span data-k="del">−{item.deleted}</span></span>
      )}
      <CodeMark code={item.code} />
    </div>
  )
  return (
    <div className="gi-files-list" role="list">
      {groupsOf(props.items).map((group) => (
        <div key={group.label ?? ''}>
          {props.grouped && group.label !== undefined && <div className="gi-group">{group.label}<span className="gp-count">{group.items.length}</span></div>}
          {tree
            ? flattenTree(buildTree(group.items, (item) => item.path), closed).slice(0, 3000).map((entry) => {
              if (entry.kind === 'file') return row(entry.file.item, entry.file.name, '', 8 + entry.depth * 14 + 22)
              const key = `${group.label ?? ''}:${entry.dir.path}`
              return (
                <div key={`d:${key}`} role="button" tabIndex={0} className="gp-row gp-dir gi-file" aria-expanded={entry.open}
                  style={{ paddingLeft: 8 + entry.depth * 14 }} title={entry.dir.path}
                  onClick={() => setClosed((old) => {
                    const next = new Set(old)
                    if (next.has(entry.dir.path)) next.delete(entry.dir.path)
                    else next.add(entry.dir.path)
                    return next
                  })}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.click() }}>
                  <span className="gp-chevron" data-open={entry.open ? '' : undefined}><IconChevron size={12} /></span>
                  <span className="gp-file-icon"><IconFolder size={14} /></span>
                  <span className="gp-file-name">{entry.dir.name}</span>
                  <span className="gp-dir-count">{entry.dir.count}</span>
                </div>
              )
            })
            : group.items.slice(0, 2000).map((item) => {
              const { name, dir } = splitPath(item.path)
              return row(item, name, dir)
            })}
        </div>
      ))}
    </div>
  )
}

function groupsOf(items: Item[]): Array<{ label?: string; items: Item[] }> {
  const groups: Array<{ label?: string; items: Item[] }> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.label === item.group) last.items.push(item)
    else groups.push({ ...(item.group === undefined ? {} : { label: item.group }), items: [item] })
  }
  return groups
}

const commitItems = (detail: CommitDetail): Item[] => detail.files.map((file: CommitFile) => ({
  path: file.path,
  ...(file.from ? { from: file.from } : {}),
  code: file.code,
  added: file.added,
  deleted: file.deleted,
  binary: file.binary,
  target: { source: 'commit', hash: detail.hash, path: file.path, code: file.code, ...(file.from ? { from: file.from } : {}) },
}))

function worktreeItems(status: GitStatus): Item[] {
  const items: Item[] = []
  const push = (list: GitStatus['staged'], group: string, source: DiffTarget['source'] | ((code: ChangeCode) => DiffTarget['source'])): void => {
    for (const change of list) {
      const src = typeof source === 'function' ? source(change.code) : source
      items.push({
        path: change.path,
        ...(change.from ? { from: change.from } : {}),
        code: change.code,
        group,
        target: { source: src, path: change.path, code: change.code, ...(change.from ? { from: change.from } : {}) },
      })
    }
  }
  push(status.conflicts, t('conflicts'), 'conflict')
  push(status.staged, t('staged'), 'staged')
  push([...status.unstaged, ...status.untracked].sort((a, b) => a.path.localeCompare(b.path)), t('unstaged'), (code) => (code === '?' ? 'untracked' : 'unstaged'))
  return items
}

/** A hash chip that copies the full hash on click and briefly shows a check. */
function CopyHash(props: { hash: string; text: string }): ReactNode {
  const { repo } = usePane()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button type="button" className="gi-hash gp-mono" title={`${t('copyHash')} ${props.hash}`} data-copied={copied ? '' : undefined}
      onClick={() => {
        const write = navigator.clipboard?.writeText(props.hash)
        if (write === undefined) return repo.toast('error', t('copyFailed'))
        void write.then(() => { setCopied(true); repo.toast('ok', t('copied')) }, () => repo.toast('error', t('copyFailed')))
      }}>
      {props.text}{copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
    </button>
  )
}

export interface InlineProps {
  hash: string
  worktree: boolean
  status: GitStatus
  refs: readonly Ref[]
  lines: readonly LaneLine[]
  graphWidth: number
  style: CSSProperties
  onHeight: (height: number) => void
  onClose: () => void
  /** Jump to (and expand) another commit, e.g. a parent. */
  onSelect: (hash: string) => void
}

export function InlineDetails(props: InlineProps): ReactNode {
  const pane = usePane()
  const { repo } = pane
  const ref = useRef<HTMLDivElement>(null)
  const [reply, setReply] = useState<GitReply<CommitDetail> | undefined>()
  useEffect(() => {
    if (props.worktree) return
    let live = true
    setReply(undefined)
    void repo.show(props.hash).then((value) => { if (live) setReply(value) })
    return () => { live = false }
  }, [props.hash, props.worktree, repo])
  const onHeight = props.onHeight
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    onHeight(element.offsetHeight)
    const observer = new ResizeObserver(() => onHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeight])

  const detail = reply?.ok ? reply.value : undefined
  const items = useMemo(() => (props.worktree ? worktreeItems(props.status) : detail ? commitItems(detail) : []), [props.worktree, props.status, detail])
  const added = items.reduce((sum, item) => sum + (item.added ?? 0), 0)
  const deleted = items.reduce((sum, item) => sum + (item.deleted ?? 0), 0)
  const context = props.worktree ? t('uncommitted') : detail ? `${short(detail.hash)} · ${detail.subject}` : short(props.hash)

  let meta: ReactNode
  if (props.worktree) {
    meta = (
      <div className="gi-meta">
        <div className="gi-subject">{t('uncommitted')}</div>
        <dl className="gi-fields">
          <dt>{t('branchName')}</dt><dd>{props.status.branch ?? t('detached')}</dd>
          <dt>{t('files', { n: items.length })}</dt><dd>{t('staged')} {props.status.staged.length} · {t('unstaged')} {props.status.unstaged.length + props.status.untracked.length}</dd>
        </dl>
        <button type="button" className="ah-btn ah-btn-sm gi-action" onClick={() => pane.setView('changes')}>{t('goCommit')}</button>
      </div>
    )
  } else if (reply === undefined) {
    meta = <div className="gi-meta"><div className="gp-skeleton-row" style={{ width: '70%' }} /><div className="gp-skeleton-row" style={{ width: '45%', marginTop: 10 }} /></div>
  } else if (!reply.ok) {
    meta = <div className="gi-meta"><p className="gp-note">{t('loadFailed', { error: reply.error.message })}</p></div>
  } else {
    const d = reply.value
    const commitRefs = props.refs
    meta = (
      <div className="gi-meta">
        <div className="gi-ids">
          <span className="gi-id">
            <span className="gi-id-label">{t('commitLabel')}</span>
            <CopyHash hash={d.hash} text={d.hash.slice(0, 12)} />
          </span>
          {d.parents.length > 0 && (
            <span className="gi-id">
              <span className="gi-id-label">{t('parents')}</span>
              {d.parents.map((parent) => (
                <span key={parent} className="gi-parent">
                  <CopyHash hash={parent} text={short(parent)} />
                  <button type="button" className="gi-jump" aria-label={`${t('goToParent')} ${short(parent)}`} title={t('goToParent')}
                    onClick={() => props.onSelect(parent)}>
                    <IconDown size={12} />
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="gi-subject">{d.subject}</div>
        {d.body !== '' && <pre className="gi-body">{d.body}</pre>}
        {commitRefs.length > 0 && (
          <div className="gi-refs">
            {badgesFor(commitRefs, props.status.branch).map((badge) => (
              <BadgeView key={`${badge.ref.kind}:${badge.ref.name}`} badge={badge} onMenu={(anchor) => openRefMenu(pane, badge.ref, anchor)} />
            ))}
          </div>
        )}
        <dl className="gi-fields gi-foot">
          <dt>{t('author')}</dt><dd>{d.author} <span className="gp-muted">&lt;{d.email}&gt;</span></dd>
          {d.committer !== d.author && <><dt>{t('committer')}</dt><dd>{d.committer}</dd></>}
          <dt>{t('dateLabel')}</dt><dd>{fullDate(d.at)}</dd>
        </dl>
      </div>
    )
  }

  return (
    <div ref={ref} className="gi-wrap" style={props.style} data-gi="">
      <PassLanes lines={props.lines} width={props.graphWidth} />
      <div className="gi-card" style={{ marginLeft: props.graphWidth }} onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onClose()
        }
      }}>
        <div className="gi-tools">
          {!props.worktree && detail !== undefined && (
            <button type="button" className="ah-icon-btn" aria-label={t('more')} title={t('more')}
              onClick={(event) => openCommitMenu(pane, detail, props.refs, { x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), align: 'end' })}>
              <IconMore size={14} />
            </button>
          )}
          <button type="button" className="ah-icon-btn" aria-label={t('close')} title={`${t('close')} (Esc)`} onClick={props.onClose}><IconClose size={14} /></button>
        </div>
        {meta}
        <div className="gi-files">
          <div className="gi-files-head">
            <span>{t('files', { n: items.length })}</span>
            {added + deleted > 0 && <span className="gp-stat"><span data-k="add">+{added}</span><span data-k="del">−{deleted}</span></span>}
            <span className="gp-grow" />
            <TreeToggle />
          </div>
          {props.worktree || detail !== undefined
            ? <FileList items={items} context={context} grouped={props.worktree} />
            : <div className="gi-files-list"><div className="gp-skeleton-row" style={{ margin: '10px 8px', width: '60%' }} /></div>}
        </div>
      </div>
    </div>
  )
}
