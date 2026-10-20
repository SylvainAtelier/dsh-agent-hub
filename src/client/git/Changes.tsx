/**
 * The changes view: commit box on top, then conflicts / staged / changes /
 * stashes as one virtualized list, so a tree with thousands of edits scrolls
 * as smoothly as one with three. Rows are keyboard-navigable (↑↓, Enter opens
 * the diff, Space stages or unstages, Delete discards).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { FileChange, GitStatus, Stash } from '../../git/types.ts'
import { absolute, ownUpstream, sameTarget, splitPath, usePane, useRepo, type DiffTarget, type PaneApi } from './context.ts'
import { ago, primaryKey, t } from './i18n.ts'
import { IconCheck, IconChevron, IconChevronDown, IconCloudUp, IconDown, IconForce, IconUp, IconMinus, IconOpen, IconPlus, IconSparkle, IconStash, IconUndo, IconWarn, IconFolder } from './icons.tsx'
import { runPush } from './actions.tsx'
import { VirtualList, type MenuEntry } from './kit.tsx'
import { anchorOf, IdentityRow, openIdentityPicker, type AmendAuthor } from './Identity.tsx'
import { bound, sameEmail } from '../../git/identity.ts'
import type { RepoStore } from './store.ts'
import { buildTree, flattenTree, itemsOf, treeMode, type TreeDir } from './tree.ts'

type SectionId = 'conflicts' | 'staged' | 'changes' | 'stashes'

type FileSection = Exclude<SectionId, 'stashes'>

type Row =
  | { kind: 'section'; id: SectionId; count: number }
  | { kind: 'dir'; section: FileSection; dir: TreeDir<FileChange>; depth: number; open: boolean }
  | { kind: 'file'; section: FileSection; change: FileChange; target: DiffTarget; depth: number }
  | { kind: 'stash'; stash: Stash }

const collapsedBy = new Map<string, Set<SectionId>>()
/** Collapsed folders per repository, keyed `section:path`. */
const closedBy = new Map<string, Set<string>>()
const drafts = new Map<string, string>()

function targetOf(section: FileSection, change: FileChange): DiffTarget {
  const source = section === 'staged' ? 'staged' : section === 'conflicts' ? 'conflict' : change.code === '?' ? 'untracked' : 'unstaged'
  return { source, path: change.path, code: change.code, ...(change.from === undefined ? {} : { from: change.from }) }
}

const pathOf = (change: FileChange): string => change.path

export function buildRows(status: GitStatus, collapsed: ReadonlySet<SectionId>, tree = false, closed: ReadonlySet<string> = new Set()): { rows: Row[]; targets: DiffTarget[] } {
  const rows: Row[] = []
  const targets: DiffTarget[] = []
  const changes = status.unstaged.concat(status.untracked).sort((a, b) => a.path.localeCompare(b.path))
  const sections: [FileSection, FileChange[]][] = [
    ['conflicts', status.conflicts],
    ['staged', status.staged],
    ['changes', changes],
  ]
  for (const [id, list] of sections) {
    if (list.length === 0) continue
    rows.push({ kind: 'section', id, count: list.length })
    if (!tree) {
      for (const change of list) {
        const target = targetOf(id, change)
        targets.push(target)
        if (!collapsed.has(id)) rows.push({ kind: 'file', section: id, change, target, depth: 0 })
      }
      continue
    }
    const root = buildTree(list, pathOf)
    // Diff prev/next follows the tree's order, folders first.
    for (const change of itemsOf(root)) targets.push(targetOf(id, change))
    if (collapsed.has(id)) continue
    const prefix = `${id}:`
    const sectionClosed = new Set([...closed].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)))
    for (const row of flattenTree(root, sectionClosed)) {
      if (row.kind === 'dir') rows.push({ kind: 'dir', section: id, dir: row.dir, depth: row.depth, open: row.open })
      else rows.push({ kind: 'file', section: id, change: row.file.item, target: targetOf(id, row.file.item), depth: row.depth })
    }
  }
  if (status.stashes.length > 0) {
    rows.push({ kind: 'section', id: 'stashes', count: status.stashes.length })
    if (!collapsed.has('stashes')) for (const stash of status.stashes) rows.push({ kind: 'stash', stash })
  }
  return { rows, targets }
}

export function discardFiles(pane: PaneApi, changes: FileChange[]): void {
  if (changes.length === 0) return
  const untracked = changes.filter((change) => change.code === '?').map((change) => change.path)
  const tracked = changes.filter((change) => change.code !== '?').map((change) => change.path)
  const body = [
    changes.length === 1 ? t('discardOne', { name: splitPath(changes[0]!.path).name }) : t('discardMany', { n: changes.length }),
    untracked.length > 0 && changes.length > 1 ? t('discardUntracked', { n: untracked.length }) : '',
  ].filter(Boolean).join(' ')
  pane.dialog({
    title: t('discardTitle'),
    body,
    danger: true,
    confirm: t('discard'),
    onConfirm: () => pane.repo.run({ op: 'discard', paths: tracked, untracked }),
  })
}

function CommitBox(props: { repo: RepoStore; status: GitStatus }): ReactNode {
  const { repo, status } = props
  const pane = usePane()
  const busy = useRepo(repo, (state) => state.busy)
  // A repository without remote branches has nowhere to publish to (unknown until the graph loads).
  const remote = useRepo(repo, (state) => state.log === undefined || state.log.refs.some((ref) => ref.kind === 'remote'))
  const [message, setMessage] = useState(() => drafts.get(repo.cwd) ?? '')
  const [amend, setAmend] = useState(false)
  /** The author an amend would keep, and whether the amend takes the current identity instead. */
  const [original, setOriginal] = useState<{ name: string; email: string } | undefined>()
  const [resetAuthor, setResetAuthor] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const identityButton = useRef<HTMLButtonElement>(null)
  const identity = status.identity
  useEffect(() => { drafts.set(repo.cwd, message) }, [message, repo.cwd])
  useEffect(() => {
    const element = area.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [message])
  const total = status.staged.length + status.unstaged.length + status.untracked.length
  const staged = status.staged.length
  const all = staged === 0 && total > 0
  // An AI commit in flight (on the store, so it survives this pane): no git command may run while its message is written.
  const ai = useRepo(repo, (state) => state.ai)
  const auto = ai !== undefined
  const can = busy === undefined && !auto && status.conflicts.length === 0 && (amend || (message.trim() !== '' && total > 0))
  const commit = (push = false): void => {
    if (!can) {
      area.current?.focus()
      return
    }
    // An identity merely inherited (or none at all) is confirmed, and bound, before the first commit here.
    if (identity === undefined || !bound(identity)) {
      void openIdentityPicker(pane, repo, status, anchorOf(identityButton.current), (email) => void commitAs(email, push))
      return
    }
    void commitAs(identity.email, push)
  }
  const commitAs = async (email: string, push: boolean): Promise<void> => {
    const reset = amend && resetAuthor && original !== undefined
    const reply = await repo.run({ op: 'commit', message, amend, all: all && !amend, as: email, ...(reset ? { resetAuthor: true } : {}) },
      { done: 'done.commit', errors: { identity: 'ident.changed' } })
    if (!reply.ok) return
    setMessage('')
    setAmend(false)
    setOriginal(undefined)
    setResetAuthor(false)
    if (push) {
      const current = repo.getSnapshot().status
      await repo.run({ op: 'push', setUpstream: current === undefined || !ownUpstream(current) }, { done: 'done.push' })
    }
  }
  const toggleAmend = async (): Promise<void> => {
    if (amend) {
      setAmend(false)
      setOriginal(undefined)
      setResetAuthor(false)
      return
    }
    setAmend(true)
    const [text, head] = await Promise.all([
      message.trim() === '' ? repo.request({ op: 'head-message' }) : undefined,
      repo.request({ op: 'log', ref: 'HEAD', limit: 1 }),
    ])
    if (text?.ok) setMessage(text.value)
    const author = head.ok ? head.value.commits[0] : undefined
    if (author !== undefined) setOriginal({ name: author.author, email: author.email })
  }
  // The original author shows only when it is someone other than who commits now.
  const amendAuthor: AmendAuthor | undefined = amend && original !== undefined && !sameEmail(original.email, identity?.email)
    ? { ...original, reset: resetAuthor, toggle: () => setResetAuthor((on) => !on) }
    : undefined
  const [drafting, setDrafting] = useState(false)
  const latest = useRef(message)
  latest.current = message
  const canDraft = !drafting && !auto && !amend && total > 0 && status.conflicts.length === 0
  const draft = async (): Promise<void> => {
    if (!canDraft) return
    const before = latest.current
    setDrafting(true)
    const reply = await repo.request({ op: 'suggest-message' })
    setDrafting(false)
    if (!reply.ok) {
      repo.toast('error', reply.error.code === 'unavailable' ? t('suggestUnavailable') : t('suggestFailed', { error: reply.error.message }))
      return
    }
    // Typing while the model works wins over its draft.
    if (latest.current !== before) return
    setMessage(reply.value)
    requestAnimationFrame(() => area.current?.focus())
  }
  // Stage everything, let the model write the message, commit — the typed draft stays as it is.
  const canAuto = busy === undefined && !auto && !drafting && !amend && total > 0 && status.conflicts.length === 0
  const autoCommit = (): void => {
    if (!canAuto) return
    if (identity === undefined || !bound(identity)) {
      void openIdentityPicker(pane, repo, status, anchorOf(identityButton.current), (email) => void autoCommitAs(email))
      return
    }
    void autoCommitAs(identity.email)
  }
  const autoCommitAs = (email: string): void => { void repo.autoCommit(email) }
  const label = amend ? t('amend') : all ? t('commitAll') : staged > 0 ? t('commitN', { n: staged }) : t('commit')
  // Nothing to commit: the button syncs instead. Remote commits come in first (a diverged
  // branch can't push), then local ones go out, or the branch is published.
  // A rebased (amended, reset) branch is behind only by its own old commits: it force-pushes, with a lease, instead of pulling them back.
  const sync: 'pull' | 'push' | 'force' | 'publish' | undefined = amend || total > 0 || status.conflicts.length > 0 || status.branch === undefined || status.head === undefined ? undefined
    : !ownUpstream(status) ? (remote ? 'publish' : undefined)
      : status.behind > 0 ? (status.rewritten === true && status.ahead > 0 ? 'force' : 'pull')
        : status.ahead > 0 ? 'push'
          : undefined
  const runSync = (): void => {
    if (sync === 'pull') void repo.run({ op: 'pull' }, { done: 'done.pull' })
    else if (sync === 'force') runPush(`lease:${status.branch}`, pane)
    else if (sync !== undefined) void repo.run({ op: 'push', ...(sync === 'publish' ? { setUpstream: true } : {}) }, { done: 'done.push' })
  }
  const menu: MenuEntry[] = [
    { id: 'push', label: t('commitPush'), disabled: !can },
    { id: 'amend', label: t('amend'), checked: amend },
    { separator: true },
    { id: 'suggest', label: t('suggest'), icon: <IconSparkle size={14} />, disabled: !canDraft },
  ]
  const narrow = pane.width > 0 && pane.width < 300
  return (
    <div className="gp-commit">
      <div className="gp-message-wrap">
        <textarea ref={area} className="gp-input gp-message" rows={1} value={message} spellCheck={false}
          placeholder={drafting ? t('suggesting') : amend ? t('amendHint') : t('messageHint', { key: primaryKey() })} aria-label={t('message')}
          aria-busy={drafting || undefined}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              commit()
            }
          }} />
        <button type="button" className="ah-icon-btn gp-suggest" disabled={!canDraft} data-busy={drafting ? '' : undefined}
          title={drafting ? t('suggesting') : t('suggest')} aria-label={t('suggest')} onClick={() => void draft()}>
          <IconSparkle size={14} className={drafting ? 'gp-pulse' : undefined} />
        </button>
      </div>
      <IdentityRow status={status} narrow={narrow} anchor={identityButton}
        onOpen={() => void openIdentityPicker(pane, repo, status, anchorOf(identityButton.current))}
        {...(amendAuthor === undefined ? {} : { amend: amendAuthor })} />
      <div className="gp-commit-actions">
        <div className="gp-split">
          {sync === undefined
            ? (
              <button type="button" className="ah-btn gp-split-main" data-variant="primary" disabled={!can}
                title={total === 0 && !amend ? t('nothing') : undefined} onClick={() => commit()}>
                <IconCheck size={14} />
                <span>{label}</span>
              </button>
            )
            : (
              <button type="button" className="ah-btn gp-split-main" data-variant="primary" disabled={busy !== undefined || auto}
                title={sync === 'publish' ? t('publish') : sync === 'force' ? t('rewrittenTip', { ahead: status.ahead, behind: status.behind }) : t('syncTip', { ahead: status.ahead, behind: status.behind })}
              onClick={runSync}>
                {sync === 'pull' ? <IconDown size={14} /> : sync === 'push' ? <IconUp size={14} /> : sync === 'force' ? <IconForce size={14} /> : <IconCloudUp size={14} />}
                <span>{sync === 'pull' ? t('pullN', { n: status.behind }) : sync === 'push' ? t('pushN', { n: status.ahead }) : sync === 'force' ? t('forcePushN', { n: status.ahead }) : t('publish')}</span>
              </button>
            )}
          <button type="button" className="ah-btn gp-split-more" data-variant="primary" aria-label={t('more')} aria-haspopup="menu"
            disabled={busy !== undefined || auto}
            onClick={(event) => pane.menu({
              anchor: { x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), align: 'end' },
              entries: menu,
              onSelect: (id) => { if (id === 'push') commit(true); else if (id === 'suggest') void draft(); else void toggleAmend() },
            })}>
            <IconChevronDown size={14} />
          </button>
        </div>
        <button type="button" className="ah-btn gp-ai-commit" disabled={!canAuto} aria-busy={auto || undefined}
          data-icon-only={narrow ? '' : undefined} title={ai === undefined ? t('aiCommitTip') : t(`ai.${ai}`)}
          aria-label={ai === undefined ? t('aiCommitTip') : t(`ai.${ai}`)} onClick={autoCommit}>
          {auto ? <span className="gp-ai-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
          {!narrow && <span className="gp-ai-label">{ai === undefined ? t('aiCommit') : t(`ai.${ai}`)}</span>}
          {auto && <span className="gp-ai-track" aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

function OperationBanner(props: { repo: RepoStore; status: GitStatus }): ReactNode {
  const { repo, status } = props
  const busy = useRepo(repo, (state) => state.busy)
  if (status.operation === undefined) return null
  return (
    <div className="gp-banner" role="status">
      <IconWarn size={15} />
      <div className="gp-banner-text">
        <strong>{t(`op.${status.operation}`)}</strong>
        <span>{t('opHint')}</span>
      </div>
      <div className="gp-banner-actions">
        <button type="button" className="ah-btn" disabled={busy !== undefined} onClick={() => void repo.run({ op: 'abort' })}>{t('abort')}</button>
        <button type="button" className="ah-btn" data-variant="primary" disabled={busy !== undefined || status.conflicts.length > 0}
          onClick={() => void repo.run({ op: 'continue' }, { done: 'done' })}>{t('continue')}</button>
      </div>
    </div>
  )
}

const CODE_CLASS: Record<string, string> = { M: 'mod', T: 'mod', A: 'add', '?': 'add', D: 'del', R: 'ren', C: 'ren', U: 'con' }

export function CodeMark(props: { code: string }): ReactNode {
  const letter = props.code === '?' ? 'U' : props.code === 'U' ? '!' : props.code
  return <span className="gp-code" data-c={CODE_CLASS[props.code] ?? 'mod'} title={t(`code.${props.code}` as never)}>{letter}</span>
}

interface RowProps {
  row: Row
  index: number
  style: CSSProperties
  active: boolean
  cursor: boolean
  collapsed: boolean
  tree: boolean
  onAction: (row: Row, action: string, event?: React.MouseEvent) => void
}

/** Left padding for a tree row at a depth; files also clear the folder chevron's width. */
const indent = (depth: number, file: boolean): number => 10 + depth * 14 + (file ? 22 : 0)

const RowView = memo(function RowView(props: RowProps): ReactNode {
  const { row, index, style, onAction } = props
  if (row.kind === 'section') {
    const label = t(row.id === 'changes' ? 'unstaged' : row.id)
    return (
      <div style={style} className="gp-row gp-section" data-row={index} data-cursor={props.cursor ? '' : undefined} tabIndex={props.cursor ? 0 : -1}
        role="button" aria-expanded={!props.collapsed} onClick={() => onAction(row, 'toggle')}>
        <span className="gp-chevron" data-open={props.collapsed ? undefined : ''}><IconChevron size={12} /></span>
        <span className="gp-section-title">{label}</span>
        <span className="gp-count">{row.count}</span>
        <span className="gp-row-actions" onClick={(event) => event.stopPropagation()}>
          {row.id === 'staged' && (
            <button type="button" className="ah-icon-btn" title={t('unstageAll')} aria-label={t('unstageAll')} onClick={() => onAction(row, 'unstage-all')}><IconMinus size={15} /></button>
          )}
          {row.id === 'changes' && <>
            <button type="button" className="ah-icon-btn" title={t('discardAll')} aria-label={t('discardAll')} onClick={() => onAction(row, 'discard-all')}><IconUndo size={15} /></button>
            <button type="button" className="ah-icon-btn" title={t('stageAll')} aria-label={t('stageAll')} onClick={() => onAction(row, 'stage-all')}><IconPlus size={15} /></button>
          </>}
          {row.id === 'stashes' && (
            <button type="button" className="ah-icon-btn" title={t('stashPush')} aria-label={t('stashPush')} onClick={() => onAction(row, 'stash')}><IconStash size={15} /></button>
          )}
        </span>
      </div>
    )
  }
  if (row.kind === 'dir') {
    const { dir } = row
    return (
      <div style={{ ...style, paddingLeft: indent(row.depth, false) }} className="gp-row gp-dir" data-row={index}
        data-cursor={props.cursor ? '' : undefined} tabIndex={props.cursor ? 0 : -1} role="button" aria-expanded={row.open} title={dir.path}
        onClick={() => onAction(row, 'toggle')}
        onContextMenu={(event) => { event.preventDefault(); onAction(row, 'menu', event) }}>
        <span className="gp-chevron" data-open={row.open ? '' : undefined}><IconChevron size={12} /></span>
        <span className="gp-file-icon"><IconFolder size={14} /></span>
        <span className="gp-file-name">{dir.name}</span>
        <span className="gp-dir-count">{dir.count}</span>
        <span className="gp-row-actions" onClick={(event) => event.stopPropagation()}>
          {row.section === 'staged' && (
            <button type="button" className="ah-icon-btn" title={t('unstage')} aria-label={t('unstage')} onClick={() => onAction(row, 'unstage')}><IconMinus size={15} /></button>
          )}
          {row.section === 'changes' && <>
            <button type="button" className="ah-icon-btn" title={t('discard')} aria-label={t('discard')} onClick={() => onAction(row, 'discard')}><IconUndo size={15} /></button>
            <button type="button" className="ah-icon-btn" title={t('stage')} aria-label={t('stage')} onClick={() => onAction(row, 'stage')}><IconPlus size={15} /></button>
          </>}
        </span>
      </div>
    )
  }
  if (row.kind === 'stash') {
    return (
      <div style={style} className="gp-row gp-file" data-row={index} data-cursor={props.cursor ? '' : undefined} tabIndex={props.cursor ? 0 : -1}>
        <span className="gp-file-icon"><IconStash size={14} /></span>
        <span className="gp-file-name">{row.stash.message}</span>
        <span className="gp-file-dir">{ago(row.stash.at)}</span>
        <span className="gp-row-actions">
          <button type="button" className="gp-text-btn" onClick={() => onAction(row, 'stash-apply')}>{t('stashApply')}</button>
          <button type="button" className="gp-text-btn" onClick={() => onAction(row, 'stash-pop')}>{t('stashPop')}</button>
          <button type="button" className="ah-icon-btn" title={t('stashDrop')} aria-label={t('stashDrop')} onClick={() => onAction(row, 'stash-drop')}><IconMinus size={15} /></button>
        </span>
      </div>
    )
  }
  const { name, dir } = splitPath(row.change.path)
  return (
    <div style={props.tree ? { ...style, paddingLeft: indent(row.depth, true) } : style} className="gp-row gp-file" data-row={index} data-active={props.active ? '' : undefined}
      data-cursor={props.cursor ? '' : undefined} data-deleted={row.change.code === 'D' ? '' : undefined}
      tabIndex={props.cursor ? 0 : -1} role="button" title={row.change.from ? `${row.change.from} → ${row.change.path}` : row.change.path}
      onClick={() => onAction(row, 'open')}
      onContextMenu={(event) => { event.preventDefault(); onAction(row, 'menu', event) }}>
      <span className="gp-file-name">{name}</span>
      <span className="gp-file-dir">{props.tree ? '' : dir}</span>
      <span className="gp-row-actions" onClick={(event) => event.stopPropagation()}>
        {row.change.code !== 'D' && (
          <button type="button" className="ah-icon-btn" title={t('openFile')} aria-label={t('openFile')} onClick={() => onAction(row, 'file')}><IconOpen size={14} /></button>
        )}
        {row.section === 'staged' && (
          <button type="button" className="ah-icon-btn" title={t('unstage')} aria-label={t('unstage')} onClick={() => onAction(row, 'unstage')}><IconMinus size={15} /></button>
        )}
        {row.section === 'changes' && <>
          <button type="button" className="ah-icon-btn" title={t('discard')} aria-label={t('discard')} onClick={() => onAction(row, 'discard')}><IconUndo size={15} /></button>
          <button type="button" className="ah-icon-btn" title={t('stage')} aria-label={t('stage')} onClick={() => onAction(row, 'stage')}><IconPlus size={15} /></button>
        </>}
        {row.section === 'conflicts' && (
          <button type="button" className="ah-icon-btn" title={t('resolve')} aria-label={t('resolve')} onClick={() => onAction(row, 'resolve')}><IconCheck size={15} /></button>
        )}
      </span>
      <CodeMark code={row.change.code} />
    </div>
  )
})

export function ChangesView(props: { status: GitStatus }): ReactNode {
  const { status } = props
  const pane = usePane()
  const { repo } = pane
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionId>>(() => collapsedBy.get(repo.cwd) ?? new Set(['stashes']))
  useEffect(() => { collapsedBy.set(repo.cwd, new Set(collapsed)) }, [collapsed, repo.cwd])
  const tree = useSyncExternalStore(treeMode.subscribe, treeMode.get)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => closedBy.get(repo.cwd) ?? new Set())
  useEffect(() => { closedBy.set(repo.cwd, new Set(closed)) }, [closed, repo.cwd])
  const { rows, targets } = useMemo(() => buildRows(status, collapsed, tree, closed), [status, collapsed, tree, closed])
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const rowHeight = pane.coarse ? 36 : 26
  const activeTarget = pane.activeDiff

  const onAction = useCallback((row: Row, action: string, event?: React.MouseEvent) => {
    if (row.kind === 'section') {
      const lists = { conflicts: status.conflicts, staged: status.staged, changes: status.unstaged.concat(status.untracked), stashes: [] }
      switch (action) {
        case 'toggle':
          setCollapsed((old) => {
            const next = new Set(old)
            if (next.has(row.id)) next.delete(row.id)
            else next.add(row.id)
            return next
          })
          break
        case 'stage-all': void repo.run({ op: 'stage' }); break
        case 'unstage-all': void repo.run({ op: 'unstage' }); break
        case 'discard-all': discardFiles(pane, lists.changes); break
        case 'stash': stashDialog(pane); break
      }
      return
    }
    if (row.kind === 'dir') {
      const files = itemsOf(row.dir)
      const paths = files.map((change) => change.path)
      const key = `${row.section}:${row.dir.path}`
      switch (action) {
        case 'toggle':
          setClosed((old) => {
            const next = new Set(old)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
          break
        case 'stage': void repo.run({ op: 'stage', paths }); break
        case 'unstage': void repo.run({ op: 'unstage', paths }); break
        case 'discard': discardFiles(pane, files); break
        case 'menu': {
          const entries: MenuEntry[] = []
          if (row.section === 'changes') entries.push({ id: 'stage', label: t('stage'), icon: <IconPlus size={14} /> }, { id: 'discard', label: t('discard'), danger: true })
          if (row.section === 'staged') entries.push({ id: 'unstage', label: t('unstage'), icon: <IconMinus size={14} /> })
          if (entries.length > 0) entries.push({ separator: true })
          entries.push({ id: 'copy', label: t('copy'), hint: row.dir.path })
          pane.menu({
            anchor: { x: event?.clientX ?? 0, y: event?.clientY ?? 0 },
            entries,
            onSelect: (id) => {
              if (id === 'copy') void navigator.clipboard?.writeText(row.dir.path)
              else onAction(row, id)
            },
          })
          break
        }
      }
      return
    }
    if (row.kind === 'stash') {
      const index = row.stash.index
      if (action === 'stash-drop') {
        pane.dialog({ title: `${t('stashDrop')} stash@{${index}}`, body: row.stash.message, danger: true, confirm: t('stashDrop'),
          onConfirm: () => repo.run({ op: 'stash-drop', index }) })
      } else {
        void repo.run({ op: action as 'stash-apply' | 'stash-pop', index }, { done: 'done' })
      }
      return
    }
    const path = row.change.path
    switch (action) {
      case 'open': pane.showDiff(row.target, targets, t(row.section === 'staged' ? 'staged' : row.section === 'conflicts' ? 'conflicts' : 'unstaged')); break
      case 'file': if (status.root) pane.openFile?.(absolute(status.root, path)); break
      case 'stage': void repo.run({ op: 'stage', paths: [path] }); break
      case 'unstage': void repo.run({ op: 'unstage', paths: [path] }); break
      case 'discard': discardFiles(pane, [row.change]); break
      case 'resolve': void repo.run({ op: 'resolve', path }); break
      case 'menu': {
        const entries: MenuEntry[] = [{ id: 'open', label: t('viewDetails') }]
        if (row.change.code !== 'D') entries.push({ id: 'file', label: t('openFile'), icon: <IconOpen size={14} /> })
        if (row.section === 'changes') entries.push({ id: 'stage', label: t('stage'), icon: <IconPlus size={14} /> }, { id: 'discard', label: t('discard'), danger: true })
        if (row.section === 'staged') entries.push({ id: 'unstage', label: t('unstage'), icon: <IconMinus size={14} /> })
        if (row.section === 'conflicts') entries.push({ id: 'ours', label: t('takeOurs') }, { id: 'theirs', label: t('takeTheirs') }, { id: 'resolve', label: t('resolve') })
        entries.push({ separator: true }, { id: 'copy', label: t('copy'), hint: path })
        pane.menu({
          anchor: { x: event?.clientX ?? 0, y: event?.clientY ?? 0 },
          entries,
          onSelect: (id) => {
            if (id === 'ours' || id === 'theirs') void repo.run({ op: 'resolve', path, side: id })
            else if (id === 'copy') void navigator.clipboard?.writeText(path)
            else onAction(row, id)
          },
        })
        break
      }
    }
  }, [status, targets, pane, repo])

  // Keep the cursor inside the list as rows come and go.
  useEffect(() => { if (cursor >= rows.length) setCursor(Math.max(0, rows.length - 1)) }, [rows.length, cursor])

  const focusRow = (index: number): void => {
    setCursor(index)
    const list = listRef.current
    if (list === null) return
    const header = list.querySelector<HTMLElement>('[data-gp-vheader]')?.offsetHeight ?? 0
    const y = header + index * rowHeight
    if (y < list.scrollTop) list.scrollTop = y
    else if (y + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = y + rowHeight - list.clientHeight
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-row="${index}"]`)?.focus({ preventScroll: true }))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
    const row = rows[cursor]
    if (event.key === 'ArrowDown') focusRow(Math.min(rows.length - 1, cursor + 1))
    else if (event.key === 'ArrowUp') focusRow(Math.max(0, cursor - 1))
    else if (event.key === 'Home') focusRow(0)
    else if (event.key === 'End') focusRow(rows.length - 1)
    else if (event.key === 'Enter' && row !== undefined) onAction(row, row.kind === 'section' || row.kind === 'dir' ? 'toggle' : 'open')
    else if (event.key === ' ' && row?.kind === 'file') onAction(row, row.section === 'staged' ? 'unstage' : row.section === 'changes' ? 'stage' : 'resolve')
    else if ((event.key === 'Delete' || event.key === 'Backspace') && row?.kind === 'file' && row.section === 'changes') onAction(row, 'discard')
    else if (event.key === 'ArrowLeft' && row?.kind === 'section' && !collapsed.has(row.id)) onAction(row, 'toggle')
    else if (event.key === 'ArrowRight' && row?.kind === 'section' && collapsed.has(row.id)) onAction(row, 'toggle')
    else if (event.key === 'ArrowLeft' && row?.kind === 'dir' && row.open) onAction(row, 'toggle')
    else if (event.key === 'ArrowRight' && row?.kind === 'dir' && !row.open) onAction(row, 'toggle')
    else return
    event.preventDefault()
  }

  const empty = rows.length === 0
  const header = (
    <div data-gp-header="">
      <CommitBox repo={repo} status={status} />
      <OperationBanner repo={repo} status={status} />
      {status.truncated && <p className="gp-note">{t('truncated')}</p>}
      {empty && (
        <div className="gp-empty">
          <IconCheck size={22} />
          <strong>{t('clean')}</strong>
          <span>{t('cleanHint')}</span>
        </div>
      )}
    </div>
  )
  return (
    <VirtualList listRef={listRef} className="gp-list" count={rows.length} rowHeight={rowHeight} header={header}
      onKeyDown={onKeyDown} role="list" label={t('changes')}
      render={(index, style) => {
        const row = rows[index]!
        return (
          <RowView key={row.kind === 'file' ? `${row.section}:${row.change.path}` : row.kind === 'dir' ? `d:${row.section}:${row.dir.path}` : row.kind === 'stash' ? `st${row.stash.index}` : `s:${row.id}`}
            row={row} index={index} style={style} cursor={index === cursor} tree={tree}
            active={row.kind === 'file' && sameTarget(row.target, activeTarget)}
            collapsed={row.kind === 'section' && collapsed.has(row.id)} onAction={onAction} />
        )
      }} />
  )
}

export function stashDialog(pane: PaneApi): void {
  pane.dialog({
    title: t('stashPush').replace(/…$/, ''),
    fields: [{ id: 'message', label: t('stashMessage'), kind: 'text' }],
    onConfirm: (values) => pane.repo.run({ op: 'stash-push', message: String(values.message) }, { done: 'done.stash' }),
  })
}
