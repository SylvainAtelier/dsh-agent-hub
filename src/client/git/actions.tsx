/**
 * Commit and ref menus, shared by the graph rows, ref badges and the commit
 * panel. Destructive or history-rewriting actions always pass through a dialog
 * that names exactly what will happen; reversible ones run straight away.
 */

import type { ReactNode } from 'react'
import type { Commit, Ref, Worktree } from '../../git/types.ts'
import { ownUpstream, short, tracksOwn, type PaneApi } from './context.ts'
import { t } from './i18n.ts'
import { IconBot, IconBranch, IconCloudUp, IconCopy, IconDown, IconFilter, IconForce, IconTag, IconUndo, IconUp, IconWorktree } from './icons.tsx'
import type { MenuAnchor, MenuEntry, Suggestion } from './kit.tsx'
import { issueBranch, type Issue } from '../../connectors/types.ts'
import { tipHandlers } from './tip.ts'

/** Rough mirror of git's check-ref-format: rejected names fail on the host anyway. */
export const validRefName = (name: string): boolean =>
  name.trim() !== '' && /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*[/.]$)[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(name.trim())

function currentBranch(pane: PaneApi): string | undefined {
  return pane.repo.getSnapshot().status?.branch
}

/** The remote branch the checked-out branch tracks: "checking it out" means pulling it. */
export function isUpstream(pane: PaneApi, ref: Ref): boolean {
  const status = pane.repo.getSnapshot().status
  return ref.kind === 'remote' && status?.branch !== undefined && ref.name === status.upstream
}

/** The local branch a branch ref stands for: a remote branch's name without its remote. */
export function localName(ref: Ref): string {
  return ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name
}

/**
 * A workspace for a branch in one step: the tree it is already checked out in, or a new tree named after it.
 * A remote branch gets a local branch tracking it (the existing local one when there is one).
 */
export async function treeForBranch(pane: PaneApi, ref: Ref): Promise<void> {
  const { repo } = pane
  const name = localName(ref)
  if (repo.getSnapshot().trees?.list === undefined) await repo.loadTrees()
  const existing = treeOf(pane, name)
  if (existing !== undefined) return openTree(pane, existing)
  if (name === currentBranch(pane)) return repo.toast('error', t('treeIsCurrent', { name }))
  const reply = await repo.run({ op: 'worktree-add', branch: name, ...(ref.kind === 'remote' ? { base: ref.name } : {}) },
    { done: 'done.tree', doneParams: { name } })
  if (!reply.ok) return
  if (reply.value.workspaceId !== undefined && pane.openWorkspace !== undefined) pane.openWorkspace(reply.value.workspaceId)
  else repo.toast('ok', t('treeNoNav', { name }))
}

export function pullCurrent(pane: PaneApi): void {
  void pane.repo.run({ op: 'pull' }, { done: 'done.pull' })
}

/** The other working tree a local branch is checked out in (git refuses to check it out here too). */
export function treeOf(pane: PaneApi, branch: string): Worktree | undefined {
  return pane.repo.getSnapshot().trees?.list?.worktrees.find((tree) => !tree.current && tree.branch === branch)
}

/** A tree's name for people: its branch, else its detached commit, else its folder. */
export function treeName(tree: Worktree): string {
  if (tree.branch !== undefined) return tree.branch
  if (tree.head !== undefined) return t('treeDetached', { hash: short(tree.head) })
  return tree.path.split(/[\\/]/).pop() ?? tree.path
}

/** Start a session in a tree, registering it as a workspace first when it is not one. */
export async function openTree(pane: PaneApi, tree: Worktree): Promise<void> {
  let id = tree.workspace?.id
  if (id === undefined) {
    const reply = await pane.repo.run({ op: 'worktree-open', path: tree.path })
    if (!reply.ok) return
    id = reply.value.workspaceId
  }
  if (id !== undefined && pane.openWorkspace !== undefined) pane.openWorkspace(id)
  else pane.repo.toast('ok', t('treeNoNav', { name: tree.workspace?.title ?? treeName(tree) }))
}

/** A new tree at `<home>/<branch>`; the dialog shows the exact folder as the name is typed. */
export function createTree(pane: PaneApi, branch = ''): void {
  const { repo } = pane
  const snapshot = repo.getSnapshot()
  if (snapshot.trees === undefined) void repo.loadTrees()
  const current = snapshot.status?.branch ?? 'HEAD'
  const where = (name: string): string | undefined => {
    const home = repo.getSnapshot().trees?.list?.home
    if (home === undefined) return undefined
    const sep = home.includes('\\') ? '\\' : '/'
    return t('treeWhere', { path: `${home}${sep}${name.trim() === '' ? `<${t('treeBranch')}>` : name.trim().replace(/\//g, sep)}` })
  }
  // With Linear connected, the branch field also finds tickets: picking one names the branch after it
  // (Linear's own suggestion), and the new session opens with the ticket in its composer.
  const tickets = pane.tickets?.getSnapshot().issues === true ? pane.tickets : undefined
  const picked = new Map<string, Issue>()
  const suggest = tickets === undefined ? undefined : async (query: string): Promise<{ title?: string; items: Suggestion[] }> => {
    const issues = await tickets.issues(query, repo.cwd)
    for (const issue of issues) picked.set(issue.identifier, issue)
    return {
      title: query === '' ? t('issuesMine') : t('issuesFound'),
      items: issues.slice(0, 20).map((issue) => ({
        key: issue.identifier,
        value: issue.branch ?? issueBranch(issue),
        tag: issue.identifier,
        label: issue.title,
        ...(issue.state === undefined ? {} : { detail: issue.state }),
        ...(issue.stateType === undefined ? {} : { tone: issue.stateType }),
      })),
    }
  }
  pane.dialog({
    title: t('newTreeTitle'),
    body: t('treeExisting'),
    fields: [
      suggest === undefined
        ? { id: 'branch', label: t('treeBranch'), kind: 'text', value: branch, validate: validRefName }
        : { id: 'branch', label: t('treeBranchOrIssue'), kind: 'combo', value: branch, validate: validRefName, placeholder: t('treeBranchPlaceholder'), suggest },
      { id: 'base', label: t('treeBaseCurrent', { name: current }), kind: 'text', validate: (value) => value.trim() === '' || validRefName(value) },
      ...(pane.openWorkspace === undefined ? [] : [{ id: 'open', label: t('treeOpenAfter'), kind: 'check' as const, value: true }]),
    ],
    note: (values) => where(String(values.branch ?? '')),
    confirm: t('treeCreate'),
    onConfirm: async (values) => {
      const name = String(values.branch).trim()
      const base = String(values.base ?? '').trim()
      const issue = typeof values['branch:pick'] === 'string' ? picked.get(values['branch:pick']) : undefined
      // A picked ticket whose branch was kept starts work on it, as the board does: the worktree
      // (or the one already on its branch), then the ticket moves to in progress and is taken.
      if (issue !== undefined && pane.startIssue !== undefined && name === (issue.branch ?? issueBranch(issue))) {
        const reply = await pane.startIssue(issue, repo.cwd, base)
        if (!reply.ok) return repo.toast('error', reply.error)
        const started = reply.value
        if (started.warning !== undefined) repo.toast('error', started.warning)
        else repo.toast('ok', t(started.created ? 'done.tree' : 'done.treeFound', { name: started.branch }))
        void repo.loadTrees()
        if (values.open === true && started.workspaceId !== undefined) {
          pane.openWorkspace?.(started.workspaceId, started.created ? t('issueDraft', { id: issue.identifier, title: issue.title, url: issue.url ?? '' }).trim() : undefined)
        }
        return
      }
      const reply = await repo.run({ op: 'worktree-add', branch: name, ...(base === '' ? {} : { base }) }, { done: 'done.tree', doneParams: { name } })
      if (reply.ok && values.open === true && reply.value.workspaceId !== undefined) {
        pane.openWorkspace?.(reply.value.workspaceId, issue === undefined ? undefined : t('issueDraft', { id: issue.identifier, title: issue.title, url: issue.url ?? '' }).trim())
      }
    },
  })
}

/** Removing names everything that goes with the folder: its sessions, its changes, optionally its branch. */
export function removeTree(pane: PaneApi, tree: Worktree): void {
  const { repo } = pane
  const sessions = tree.workspace?.sessions ?? 0
  const changes = tree.changes ?? 0
  const body = [
    t('treeRemoveBody', { path: tree.path }),
    sessions > 0 ? t('treeRemoveSessions', { n: sessions }) : '',
    changes > 0 ? t('treeRemoveDirty', { n: changes }) : '',
    tree.locked !== undefined ? t('treeRemoveLocked') : '',
  ].filter(Boolean).join('\n')
  pane.dialog({
    title: t('treeRemoveTitle', { name: treeName(tree) }),
    body,
    danger: true,
    confirm: t('treeRemove').replace(/…$/, ''),
    fields: tree.branch === undefined ? [] : [{ id: 'branch', label: t('treeDeleteBranch', { name: tree.branch }), kind: 'check' }],
    onConfirm: async (values) => {
      const reply = await repo.run({
        op: 'worktree-remove', path: tree.path, force: changes > 0 || tree.locked !== undefined, deleteBranch: values.branch === true,
      }, { done: 'done.treeRemoved', quiet: true })
      if (!reply.ok) {
        if (reply.error.code === 'busy') repo.toast('error', t('treeBusy'), reply.error.message)
        else repo.toast('error', reply.error.message.split('\n').find((line) => line.trim() !== '')?.replace(/^(error|fatal):\s*/i, '') ?? t('failed'), reply.error.message)
      }
    },
  })
}

export function treeEntries(pane: PaneApi, tree: Worktree): MenuEntry[] {
  const gone = tree.prunable !== undefined
  const entries: MenuEntry[] = []
  if (!tree.current && !gone) entries.push({ id: 'open', label: t('treeOpenTip'), icon: <IconWorktree size={14} /> })
  if (gone) entries.push({ id: 'prune', label: t('treePrune') })
  entries.push({ id: 'copy', label: t('treeCopyPath'), icon: <IconCopy size={14} /> })
  if (!tree.main && !gone) entries.push(tree.locked === undefined ? { id: 'lock', label: t('treeLock') } : { id: 'unlock', label: t('treeUnlock') })
  if (!tree.main) entries.push({ separator: true }, { id: 'remove', label: t('treeRemove'), danger: true, disabled: tree.current })
  return entries
}

export function runTreeAction(id: string, tree: Worktree, pane: PaneApi): void {
  const { repo } = pane
  switch (id) {
    case 'open': void openTree(pane, tree); break
    case 'prune': void repo.run({ op: 'worktree-prune' }, { done: 'done' }); break
    case 'copy': void navigator.clipboard?.writeText(tree.path).then(() => repo.toast('ok', t('copied'))); break
    case 'lock': void repo.run({ op: 'worktree-lock', path: tree.path }, { done: 'done' }); break
    case 'unlock': void repo.run({ op: 'worktree-unlock', path: tree.path }, { done: 'done' }); break
    case 'remove': removeTree(pane, tree); break
  }
}

export function openTreeMenu(pane: PaneApi, tree: Worktree, anchor: MenuAnchor): void {
  pane.menu({ anchor, entries: treeEntries(pane, tree), onSelect: (id) => runTreeAction(id, tree, pane), label: treeName(tree) })
}

/**
 * Push entries for local branches: plain push, --force-with-lease and --force.
 * Ids are `push:<branch>`, `lease:<branch>`, `force:<branch>`; with several
 * branches each group names its branch.
 */
/**
 * Push entries for local branches. One already on a remote under its name (tracked or not) pushes there;
 * any other publishes, and can't be force-pushed.
 */
export function pushEntries(branches: readonly Ref[], pane: PaneApi): MenuEntry[] {
  const entries: MenuEntry[] = []
  const remote = new Set((pane.repo.getSnapshot().log?.refs ?? []).filter((ref) => ref.kind === 'remote').map(localName))
  for (const { name, upstream } of branches) {
    const own = tracksOwn(name, upstream) || remote.has(name)
    entries.push(
      own
        ? { id: `push:${name}`, label: t('pushBranch', { name }), icon: <IconUp size={14} /> }
        : { id: `push:${name}`, label: t('publishBranch', { name }), icon: <IconCloudUp size={14} /> },
      { id: `lease:${name}`, label: t('forceLease'), icon: <IconForce size={14} />, disabled: !own, ...(branches.length > 1 ? { hint: name } : {}) },
      { id: `force:${name}`, label: t('forcePush'), danger: true, disabled: !own, ...(branches.length > 1 ? { hint: name } : {}) },
    )
  }
  return entries
}

/** Run a push entry; both force modes confirm first, saying what each one risks. */
export function runPush(id: string, pane: PaneApi): boolean {
  const match = /^(push|lease|force):(.+)$/.exec(id)
  if (match === null) return false
  const [, mode, name] = match as unknown as [string, 'push' | 'lease' | 'force', string]
  const { repo } = pane
  const status = repo.getSnapshot().status
  const setUpstream = name === status?.branch && !ownUpstream(status)
  if (mode === 'push') {
    void repo.run({ op: 'push', branch: name, ...(setUpstream ? { setUpstream } : {}) }, { done: 'done.push' })
  } else {
    pane.dialog({
      title: t(mode === 'lease' ? 'forceLeaseTitle' : 'forceTitle', { name }),
      body: t(mode === 'lease' ? 'forceLeaseBody' : 'forceBody'),
      danger: mode === 'force',
      confirm: t(mode === 'lease' ? 'forceLease' : 'forcePush'),
      onConfirm: () => repo.run({ op: 'push', branch: name, force: mode, ...(setUpstream ? { setUpstream } : {}) }, { done: 'done.forcePush' }),
    })
  }
  return true
}

export function createBranch(pane: PaneApi, at?: string, label?: string): void {
  pane.dialog({
    title: label === undefined ? t('newBranch').replace(/…$/, '') : `${t('newBranch').replace(/…$/, '')} · ${label}`,
    fields: [
      { id: 'name', label: t('branchName'), kind: 'text', validate: validRefName },
      { id: 'checkout', label: t('checkoutAfter'), kind: 'check', value: true },
    ],
    onConfirm: (values) => pane.repo.run(
      { op: 'branch-create', name: String(values.name).trim(), ...(at === undefined ? {} : { at }), checkout: values.checkout === true },
      values.checkout === true ? { done: 'done.checkout', doneParams: { name: String(values.name).trim() } } : { done: 'done' },
    ),
  })
}

export function commitEntries(commit: Commit, refs: readonly Ref[], pane: PaneApi): MenuEntry[] {
  const branch = currentBranch(pane)
  const entries: MenuEntry[] = []
  const heads = refs.filter((ref) => ref.kind === 'head' && ref.name !== branch)
  for (const ref of heads) entries.push({ id: `checkout:${ref.name}`, label: `${t('checkout')} ${ref.name}`, icon: <IconBranch size={14} /> })
  const local = refs.filter((ref) => ref.kind === 'head')
    .sort((a, b) => Number(b.name === branch) - Number(a.name === branch))
  entries.push(
    { id: 'checkout-detached', label: t('checkoutDetached') },
    { id: 'branch', label: t('branchHere'), icon: <IconBranch size={14} /> },
    { id: 'tag', label: t('tagHere'), icon: <IconTag size={14} /> },
    { separator: true },
    { id: 'cherry-pick', label: t('cherryPick'), disabled: branch === undefined },
    { id: 'revert', label: t('revert'), icon: <IconUndo size={14} /> },
    { id: 'reset', label: t('resetHere'), danger: true, disabled: branch === undefined },
  )
  if (local.length > 0) entries.push({ separator: true }, ...pushEntries(local, pane))
  entries.push(
    { separator: true },
    { id: 'copy-hash', label: t('copyHash'), icon: <IconCopy size={14} />, hint: short(commit.hash) },
    { id: 'copy-subject', label: t('copySubject') },
  )
  return entries
}

export function runCommitAction(id: string, commit: Commit, pane: PaneApi): void {
  const { repo } = pane
  const branch = currentBranch(pane) ?? 'HEAD'
  if (runPush(id, pane)) return
  if (id.startsWith('checkout:')) {
    const name = id.slice(9)
    void repo.run({ op: 'checkout', ref: name, kind: 'branch' }, { done: 'done.checkout', doneParams: { name } })
    return
  }
  switch (id) {
    case 'checkout-detached':
      void repo.run({ op: 'checkout', ref: commit.hash, kind: 'commit' }, { done: 'done.checkout', doneParams: { name: short(commit.hash) } })
      break
    case 'branch':
      createBranch(pane, commit.hash, short(commit.hash))
      break
    case 'tag':
      pane.dialog({
        title: `${t('tagHere').replace(/…$/, '')} · ${short(commit.hash)}`,
        fields: [
          { id: 'name', label: t('tagName'), kind: 'text', validate: validRefName },
          { id: 'message', label: t('tagMessage'), kind: 'textarea' },
        ],
        onConfirm: (values) => repo.run({ op: 'tag-create', name: String(values.name).trim(), at: commit.hash, message: String(values.message) }, { done: 'done' }),
      })
      break
    case 'cherry-pick':
      pane.dialog({
        title: t('cherryTitle', { hash: short(commit.hash), branch }),
        body: commit.subject,
        onConfirm: () => repo.run({ op: 'cherry-pick', hash: commit.hash }, { done: 'done' }),
      })
      break
    case 'revert':
      pane.dialog({
        title: t('revertTitle', { hash: short(commit.hash) }),
        body: `${commit.subject}\n\n${t('revertBody')}`,
        onConfirm: () => repo.run({ op: 'revert', hash: commit.hash }, { done: 'done' }),
      })
      break
    case 'reset':
      pane.dialog({
        title: t('resetTitle', { hash: short(commit.hash) }),
        body: commit.subject,
        danger: true,
        fields: [{
          id: 'mode', label: t('resetHere'), kind: 'radio', value: 'mixed', options: [
            { value: 'soft', label: t('reset.soft') },
            { value: 'mixed', label: t('reset.mixed') },
            { value: 'hard', label: t('reset.hard'), danger: true },
          ],
        }],
        onConfirm: (values) => repo.run({ op: 'reset', hash: commit.hash, mode: values.mode as 'soft' | 'mixed' | 'hard' }, { done: 'done' }),
      })
      break
    case 'copy-hash':
      void navigator.clipboard?.writeText(commit.hash).then(() => repo.toast('ok', t('copied')))
      break
    case 'copy-subject':
      void navigator.clipboard?.writeText(commit.subject).then(() => repo.toast('ok', t('copied')))
      break
  }
}

export function refEntries(ref: Ref, pane: PaneApi): MenuEntry[] {
  const branch = currentBranch(pane)
  const current = ref.kind === 'head' && ref.name === branch
  const entries: MenuEntry[] = []
  // A remote branch whose local branch is checked out in another tree opens that tree too.
  const elsewhere = ref.kind === 'tag' ? undefined : treeOf(pane, localName(ref))
  if (elsewhere !== undefined) entries.push({ id: 'open-tree', label: t('openTree'), icon: <IconWorktree size={14} />, hint: t('inTree') })
  else if (isUpstream(pane, ref)) entries.push({ id: 'pull', label: t('pull'), icon: <IconDown size={14} /> })
  else if (ref.kind !== 'tag' && !current) {
    entries.push({ id: 'checkout', label: t('checkout'), icon: <IconBranch size={14} /> })
    // The current branch can't be checked out in a second tree.
    if (localName(ref) !== branch) entries.push({ id: 'tree', label: t('treeHere'), icon: <IconWorktree size={14} />, ...(ref.kind === 'remote' ? { hint: localName(ref) } : {}) })
  }
  if (!current && branch !== undefined) {
    entries.push({ id: 'merge', label: t('mergeInto') }, { id: 'rebase', label: t('rebaseOnto') }, { id: 'rebase-bot', label: t('rebaseByBot'), icon: <IconBot size={14} /> })
  }
  if (ref.kind === 'head') {
    entries.push({ separator: true }, ...pushEntries([ref], pane))
    entries.push({ separator: true }, { id: 'branch', label: t('newBranch') }, { id: 'rename', label: t('renameBranch') })
    if (!current && elsewhere === undefined) entries.push({ id: 'delete', label: t('deleteBranch'), danger: true })
  } else if (ref.kind === 'tag') {
    entries.push({ separator: true }, { id: 'delete-tag', label: t('deleteTag'), danger: true })
  } else {
    entries.push({ separator: true }, { id: 'branch', label: t('newBranch') })
  }
  const scoped = pane.repo.getSnapshot().log?.scope === ref.name
  entries.push({ separator: true }, { id: scoped ? 'scope-all' : 'scope', label: t(scoped ? 'scopeClear' : 'scopeOnly'), icon: <IconFilter size={14} /> })
  entries.push({ id: 'copy', label: t('copy'), icon: <IconCopy size={14} />, hint: ref.name })
  return entries
}

/** A rebase cannot start mid-operation or over uncommitted changes: say so (a toast) instead of letting it fail. */
function rebaseReady(pane: PaneApi): boolean {
  const status = pane.repo.getSnapshot().status
  if (status?.operation !== undefined) pane.repo.toast('error', t('rebaseBlockedOp', { op: t(`op.${status.operation}`) }))
  else if (status !== undefined && status.staged.length + status.unstaged.length + status.conflicts.length > 0) pane.repo.toast('error', t('rebaseBlockedDirty'))
  else return true
  return false
}

const BOT_KEY = 'agent-hub.git.rebaseBot'
const rememberedBot = (): string | undefined => {
  try { return localStorage.getItem(BOT_KEY) ?? undefined } catch { return undefined }
}

/**
 * Hand the current branch's rebase onto `onto` to a bot: the picker lists the bots (the last one
 * used first and preselected), confirming opens a session on it in this tree that does the rebase.
 */
async function rebaseWithBot(pane: PaneApi, onto: string): Promise<void> {
  const { repo } = pane
  const listed = await repo.request({ op: 'bots' })
  if (!listed.ok) return repo.toast('error', listed.error.message)
  const last = rememberedBot()
  const bots = [...listed.value].sort((a, b) => Number(b.id === last) - Number(a.id === last))
  if (bots.length === 0) return repo.toast('error', t('rebaseBotNone'))
  const branch = currentBranch(pane) ?? 'HEAD'
  pane.dialog({
    title: t('rebaseBotTitle', { branch }),
    body: t('rebaseBotBody', { branch, ref: onto }),
    confirm: t('rebaseBotGo', { bot: bots[0]!.id }),
    fields: [
      {
        id: 'bot', label: t('rebaseBotPick'), kind: 'radio', value: bots[0]!.id,
        options: bots.map((bot) => ({ value: bot.id, label: bot.id, ...(bot.description === undefined ? {} : { detail: bot.description }) })),
      },
      ...(pane.openWorkspace === undefined ? [] : [{ id: 'open', label: t('rebaseBotOpen'), kind: 'check' as const, value: true }]),
    ],
    onConfirm: async (values) => {
      const bot = String(values.bot)
      try { localStorage.setItem(BOT_KEY, bot) } catch { /* private mode: the pick is just not remembered */ }
      const reply = await repo.run({ op: 'rebase-bot', ref: onto, bot })
      if (!reply.ok) return
      repo.toast('ok', t('rebaseBotStarted', { bot, branch: reply.value.branch }))
      if (values.open === true && reply.value.workspaceId !== undefined) pane.openWorkspace?.(reply.value.workspaceId)
    },
  })
}

export function runRefAction(id: string, ref: Ref, pane: PaneApi): void {
  const { repo } = pane
  if (runPush(id, pane)) return
  const branch = currentBranch(pane) ?? 'HEAD'
  switch (id) {
    case 'open-tree': {
      const tree = treeOf(pane, localName(ref))
      if (tree !== undefined) void openTree(pane, tree)
      break
    }
    case 'tree':
      void treeForBranch(pane, ref)
      break
    case 'pull':
      pullCurrent(pane)
      break
    case 'checkout': {
      if (isUpstream(pane, ref)) {
        pullCurrent(pane)
        break
      }
      const name = ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name
      void repo.run({ op: 'checkout', ref: ref.name, kind: ref.kind === 'remote' ? 'remote' : 'branch' }, { done: 'done.checkout', doneParams: { name } })
      break
    }
    case 'merge':
      pane.dialog({
        title: t('mergeTitle', { ref: ref.name, branch }),
        onConfirm: () => repo.run({ op: 'merge', ref: ref.name }, { done: 'done' }),
      })
      break
    case 'rebase': {
      // No confirm dialog: refuse up front what git would refuse, and git's own errors toast via run().
      if (!rebaseReady(pane)) break
      void repo.run({ op: 'rebase', ref: ref.name }, { done: 'done' })
      break
    }
    case 'rebase-bot':
      if (rebaseReady(pane)) void rebaseWithBot(pane, ref.name)
      break
    case 'branch':
      createBranch(pane, ref.name, ref.name)
      break
    case 'rename':
      pane.dialog({
        title: t('renameBranch').replace(/…$/, ''),
        fields: [{ id: 'name', label: t('branchName'), kind: 'text', value: ref.name, validate: validRefName }],
        onConfirm: (values) => repo.run({ op: 'branch-rename', from: ref.name, to: String(values.name).trim() }, { done: 'done' }),
      })
      break
    case 'delete':
      pane.dialog({
        title: t('deleteBranchTitle', { name: ref.name }),
        danger: true,
        confirm: t('deleteBranch'),
        fields: [{ id: 'force', label: t('forceDelete'), kind: 'check' }],
        onConfirm: (values) => repo.run({ op: 'branch-delete', name: ref.name, force: values.force === true }, { done: 'done' }),
      })
      break
    case 'delete-tag':
      pane.dialog({
        title: t('deleteTagTitle', { name: ref.name }),
        danger: true,
        confirm: t('deleteTag'),
        onConfirm: () => repo.run({ op: 'tag-delete', name: ref.name }, { done: 'done' }),
      })
      break
    case 'scope':
    case 'scope-all':
      pane.setView('graph')
      void repo.setScope(id === 'scope' ? ref.name : undefined)
      break
    case 'copy':
      void navigator.clipboard?.writeText(ref.name).then(() => repo.toast('ok', t('copied')))
      break
  }
}

export function openCommitMenu(pane: PaneApi, commit: Commit, refs: readonly Ref[], anchor: MenuAnchor): void {
  pane.menu({ anchor, entries: commitEntries(commit, refs, pane), onSelect: (id) => runCommitAction(id, commit, pane), label: short(commit.hash) })
}

export function openRefMenu(pane: PaneApi, ref: Ref, anchor: MenuAnchor): void {
  pane.menu({ anchor, entries: refEntries(ref, pane), onSelect: (id) => runRefAction(id, ref, pane), label: ref.name })
}

/** Ref badges for one commit: local branches merge with their same-commit upstream. */
export interface Badge {
  ref: Ref
  /** Upstream at the same commit, folded into this badge. */
  synced?: boolean
  current?: boolean
  /** The current branch's upstream: double-click pulls it. */
  upstream?: boolean
}

export function badgesFor(refs: readonly Ref[], branch: string | undefined, upstream?: string): Badge[] {
  const badges: Badge[] = []
  const folded = new Set<string>()
  for (const ref of refs) {
    if (ref.kind !== 'head') continue
    // `refs` all point at one commit, so a remote branch of the same name is in sync even when no upstream is configured
    // (pushed without -u, or set up by another tool).
    const twins = refs.filter((other) => other.kind === 'remote'
      && (ref.upstream !== undefined ? other.name === ref.upstream : other.name.slice(other.name.indexOf('/') + 1) === ref.name))
    for (const twin of twins) folded.add(twin.name)
    badges.push({ ref, ...(twins.length > 0 ? { synced: true } : {}), ...(ref.name === branch ? { current: true } : {}) })
  }
  for (const ref of refs) {
    if (ref.kind === 'remote' && !folded.has(ref.name)) badges.push({ ref, ...(branch !== undefined && ref.name === upstream ? { upstream: true } : {}) })
  }
  for (const ref of refs) if (ref.kind === 'tag') badges.push({ ref })
  return badges.sort((a, b) => Number(b.current === true) - Number(a.current === true))
}

export function BadgeView(props: { badge: Badge; color?: string; onMenu: (anchor: MenuAnchor) => void; onActivate?: () => void; clickMenu?: boolean }): ReactNode {
  const { badge } = props
  const { ref } = badge
  return (
    <button type="button" className="gp-badge" data-kind={ref.kind} data-current={badge.current ? '' : undefined}
      style={props.color === undefined ? undefined : { ['--gp-lane' as string]: props.color }}
      // Empty, so the row's own title stays away: the quick tip below names the ref.
      title=""
      {...tipHandlers(() => ({
        name: ref.name, color: props.color,
        meta: [t(ref.kind === 'tag' ? 'tags' : ref.kind === 'remote' ? 'remotes' : 'branches'), badge.current ? t('tipCurrent') : undefined,
          badge.synced ? t('tipSynced') : undefined, props.clickMenu === false && ref.kind !== 'tag' ? t(badge.upstream ? 'dblPullHint' : ref.kind === 'remote' ? 'dblRemoteHint' : 'dblHint') : undefined]
          .filter((part) => part !== undefined).join(' · '),
      }))}
      onClick={(event) => {
        if (props.clickMenu === false) return
        event.stopPropagation()
        props.onMenu({ x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect() })
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        props.onActivate?.()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onMenu({ x: event.clientX, y: event.clientY })
      }}>
      {ref.kind === 'tag' ? <IconTag size={11} /> : ref.kind === 'remote' ? null : <IconBranch size={11} />}
      <span className="gp-badge-name">{ref.name}</span>
      {badge.synced && <span className="gp-badge-sync" aria-hidden="true">⇅</span>}
    </button>
  )
}
