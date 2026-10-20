/**
 * Settings sync on 设置 → 同步与更新: one button runs the host's merge. What only one side changed
 * is taken without asking; only settings both machines changed differently come back here, each
 * waiting for a choice. The last run says what it did, what did not take effect, and can be undone.
 * Folded away below it, either side can overwrite the other outright, each after a confirmation.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SyncChange, SyncChangeGroup, SyncConflict, SyncOutcome, SyncStatus, SyncVersion } from '../../sync/types.ts'
import type { SyncStore } from '../sync/api.ts'
import { t } from './i18n.ts'

type Side = 'local' | 'remote'

const time = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

const short = (commit: string): string => commit.slice(0, 7)

const count = (groups: readonly SyncChangeGroup[]): number => groups.reduce((sum, group) => sum + group.changes.length, 0)

function stateText(status: SyncStatus): { text: string; tone?: 'ok' | 'attention' } {
  if (!status.configured) return { text: t('sync.state.localOnly') }
  if (status.busy !== null) return { text: t(`sync.state.busy.${status.busy}`) }
  if (status.conflicts !== undefined) return { text: t('sync.state.conflicts', { n: status.conflicts.items.length }), tone: 'attention' }
  if (status.remoteEmpty) return { text: t('sync.state.remoteEmpty'), tone: 'attention' }
  if (status.incoming !== 0 || status.outgoing !== 0) return { text: t('sync.state.changes'), tone: 'attention' }
  return { text: t('sync.state.synced'), tone: 'ok' }
}

export function SyncPanel(props: { store: SyncStore; disabled: boolean }): ReactNode {
  const { store } = props
  const { status, sending, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [history, setHistory] = useState<SyncVersion[] | null>(null)
  const [choices, setChoices] = useState<Record<string, Side>>({})
  const [message, setMessage] = useState('')
  const [showMessage, setShowMessage] = useState(false)
  const [showForce, setShowForce] = useState(false)
  useEffect(() => { void store.load() }, [store])
  // Choices count for the conflicts they were made for; a new set starts unchosen.
  const conflictKey = `${status?.conflicts?.remote ?? ''}:${status?.conflicts?.items.map((item) => item.key).join(',') ?? ''}`
  useEffect(() => setChoices({}), [conflictKey])
  // A restore adds a version: an open history reads it again.
  const head = status?.head
  useEffect(() => {
    if (history !== null) void store.log().then((log) => setHistory(log.versions), () => {})
  }, [head])

  if (status === undefined) return <div className="ac-row" data-wide=""><p className="ac-muted">{error ?? t('sync.loading')}</p></div>
  if (!status.available) return <div className="ac-row" data-wide=""><p className="ac-notice">{t('sync.unavailable')}</p></div>

  const locked = props.disabled || sending || status.busy !== null
  const state = stateText(status)
  const conflicts = status.conflicts
  const unresolved = conflicts?.items.filter((item) => choices[item.key] === undefined).length ?? 0
  const failure = status.error ?? error ?? undefined
  const run = (request: Parameters<SyncStore['run']>[0]): void => void store.run(request).then(() => {
    if (request.op === 'sync' || request.op === 'overwrite') setMessage('')
  })
  const sync = (): void => run({
    op: 'sync',
    ...(conflicts === undefined ? {} : { remote: conflicts.remote, choices }),
    ...(message.trim() === '' ? {} : { message: message.trim() }),
  })
  const toggleHistory = (): void => {
    if (history !== null) return setHistory(null)
    void store.log().then((log) => setHistory(log.versions), () => setHistory([]))
  }
  const restore = (commit: string, confirm: string): void => {
    if (window.confirm(confirm)) run({ op: 'restore', commit })
  }

  return (
    <div className="ac-row ac-sync" data-wide="">
      <div className="ac-sync-bar">
        <div className="ac-sync-bar-text" role="status" aria-live="polite">
          <span className="ac-sync-state" data-tone={state.tone}>{state.text}</span>
          {status.configured && !status.remoteEmpty && (
            <span className="ac-sync-counts" title={t('sync.counts', { in: status.incoming, out: status.outgoing })}>
              <span aria-hidden="true">↓{status.incoming} ↑{status.outgoing}</span>
              <span className="ac-visually-hidden">{t('sync.counts', { in: status.incoming, out: status.outgoing })}</span>
            </span>
          )}
          <span className="ac-muted">{status.fetchedAt === undefined ? t('sync.never') : t('sync.fetchedAt', { time: time(status.fetchedAt) })}</span>
        </div>
        {conflicts === undefined && (
          <button type="button" className="ah-btn ac-sync-fetch" data-variant="primary" disabled={locked || !status.configured}
            aria-busy={status.busy === 'sync' || undefined} onClick={sync}>
            <SyncIcon />
            {t('sync.now')}
          </button>
        )}
      </div>
      {status.configured && (
        <div className="ac-sync-message">
          <button type="button" className="ac-link" aria-expanded={showMessage} disabled={locked} onClick={() => setShowMessage((value) => !value)}>{t('sync.message.toggle')}</button>
          {showMessage && <input className="ac-input" type="text" aria-label={t('sync.message')} value={message} placeholder={t('sync.message.placeholder')} onChange={(event) => setMessage(event.target.value)} />}
        </div>
      )}
      {status.pluginsReadOnly && <p className="ac-notice">{t('sync.plugins.readOnly')}</p>}
      {failure !== undefined && (
        <div className="ac-notice ac-sync-alert" data-tone="bad" role="alert"><p>{t('sync.error', { message: failure })}</p></div>
      )}

      {conflicts !== undefined && (
        <Conflicts items={conflicts.items} choices={choices} locked={locked}
          onChoose={(key, choice) => setChoices((current) => ({ ...current, [key]: choice }))}
          onAll={(choice) => setChoices(Object.fromEntries(conflicts.items.map((item) => [item.key, choice])))}>
          <p className="ac-muted" role="status">{unresolved > 0 ? t('sync.conflicts.left', { n: unresolved }) : t('sync.conflicts.ready')}</p>
          <div className="ac-sync-confirm-actions">
            <button type="button" className="ah-btn" disabled={locked} onClick={() => run({ op: 'discard' })}>{t('sync.conflicts.later')}</button>
            <button type="button" className="ah-btn" data-variant="primary" disabled={locked || unresolved > 0}
              aria-busy={status.busy === 'sync' || undefined} onClick={sync}>{t('sync.conflicts.apply')}</button>
          </div>
        </Conflicts>
      )}

      {status.progress !== undefined && (status.busy !== null || status.progress.stage === 'failed') && <Progress status={status} />}
      {status.last !== undefined && <Outcome outcome={status.last} locked={locked} onUndo={(commit) => restore(commit, t('sync.last.undoConfirm'))} />}
      <div className="ac-sync-more">
        <button type="button" className="ac-link" aria-expanded={history !== null} onClick={toggleHistory}>{t(history === null ? 'sync.history' : 'sync.history.hide')}</button>
        {status.configured && <button type="button" className="ac-link" aria-expanded={showForce} aria-controls="ac-sync-force" onClick={() => setShowForce((value) => !value)}>{t(showForce ? 'sync.force.hide' : 'sync.force.toggle')}</button>}
      </div>
      {status.configured && showForce && (
        <Overwrite status={status} locked={locked}
          onRun={(source) => run({ op: 'overwrite', source, ...(source === 'local' && message.trim() !== '' ? { message: message.trim() } : {}) })} />
      )}
      {history !== null && <History versions={history} locked={locked} onRestore={(commit) => restore(commit, t('sync.restore.confirm', { version: short(commit) }))} />}
    </div>
  )
}

function SyncIcon(): ReactNode {
  return (
    <svg className="ac-sync-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" />
    </svg>
  )
}

function SideIcon(props: { side: Side }): ReactNode {
  return (
    <svg className="ac-sync-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.side === 'local'
        ? <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></>
        : <path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 7 19z" />}
    </svg>
  )
}

const OVERWRITES = [
  { source: 'local', target: 'remote', key: 'toRemote', busy: 'overwriteRemote' },
  { source: 'remote', target: 'local', key: 'toLocal', busy: 'overwriteLocal' },
] as const

/**
 * Either side overwrites the other. Each option shows which way it goes and what it would replace
 * as of the last fetch; its button asks once more in place, the safe choice focused, before it runs.
 */
function Overwrite(props: { status: SyncStatus; locked: boolean; onRun(source: Side): void }): ReactNode {
  const { status } = props
  const [pending, setPending] = useState<Side | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (pending !== null) cancelRef.current?.focus() }, [pending])
  // Another run, or this one starting, ends the question.
  useEffect(() => { if (props.locked) setPending(null) }, [props.locked])
  const conflicts = status.conflicts?.items.length ?? status.conflicting ?? 0
  const known = status.fetchedAt !== undefined
  const name = (side: Side): string => t(side === 'local' ? 'sync.force.local' : 'sync.force.remote')
  return (
    <section id="ac-sync-force" className="ac-sync-force" aria-labelledby="ac-sync-force-title">
      <h4 id="ac-sync-force-title">{t('sync.force.title')}</h4>
      <p className="ac-muted">{t('sync.force.hint')}</p>
      <div className="ac-sync-force-options">
        {OVERWRITES.map((option) => {
          // What the overwritten side has that the other lacks: its own changes and the conflicts.
          const lost = (option.source === 'local' ? status.incoming : status.outgoing) + conflicts
          const empty = option.source === 'remote' && status.remoteEmpty
          const impact = empty ? t('sync.force.toLocal.empty')
            : status.remoteEmpty ? t('sync.force.toRemote.first')
            : !known ? t('sync.force.unknown')
            : lost === 0 ? t('sync.force.same')
            : t(`sync.force.${option.key}.impact`, { n: lost })
          const risky = known && !status.remoteEmpty && lost > 0
          const asking = pending === option.source
          const running = status.busy === option.busy
          const titleId = `ac-sync-force-${option.source}`
          return (
            <div key={option.source} className="ac-sync-force-option" data-asking={asking || undefined} role="group" aria-labelledby={titleId}
              onKeyDown={(event) => { if (asking && event.key === 'Escape') { event.stopPropagation(); setPending(null) } }}>
              <div className="ac-sync-force-route" role="img" aria-label={t('sync.force.route', { from: name(option.source), to: name(option.target) })}>
                <span className="ac-sync-force-end"><SideIcon side={option.source} />{name(option.source)}</span>
                <svg className="ac-sync-force-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
                <span className="ac-sync-force-end" data-target=""><SideIcon side={option.target} />{name(option.target)}</span>
              </div>
              <h5 id={titleId}>{t(`sync.force.${option.key}.title`)}</h5>
              <p className="ac-muted">{t(`sync.force.${option.key}.desc`)}</p>
              <p className="ac-sync-force-impact" data-tone={risky ? 'attention' : undefined} role={asking ? 'alert' : undefined}>
                {impact}{risky && <span className="ac-muted"> · {t('sync.force.asOf')}</span>}
              </p>
              <div className="ac-sync-force-actions">
                {asking ? <>
                  <button ref={cancelRef} type="button" className="ah-btn" onClick={() => setPending(null)}>{t('sync.force.cancel')}</button>
                  <button type="button" className="ah-btn" data-variant="danger" disabled={props.locked} onClick={() => { setPending(null); props.onRun(option.source) }}>
                    {t(`sync.force.${option.key}.confirm`)}
                  </button>
                </> : (
                  <button type="button" className="ah-btn" disabled={props.locked || empty} aria-busy={running || undefined} onClick={() => setPending(option.source)}>
                    {running && <SyncIcon />}
                    {t(`sync.force.${option.key}.action`)}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Each collection's file (sync/collection.ts) and its name on the page. */
const COLLECTIONS: Record<string, 'sync.diff.pins' | 'sync.diff.feeds' | 'sync.diff.favorites'> = {
  'pins.json': 'sync.diff.pins',
  'reader-feeds.json': 'sync.diff.feeds',
  'reader-favorites.json': 'sync.diff.favorites',
}

/** A setting's name as the page shows it: the entry and its path, or what the plugin selection holds. */
function settingName(kind: SyncChangeGroup['kind'], id: string, path: readonly string[]): string {
  if (kind === 'bundles') return path.length === 0 ? t('sync.diff.order') : `${t('sync.diff.bundles')} · ${path.join('.')}`
  if (kind === 'dependencies') return `${t('sync.diff.dependencies')} · ${path.join('.')}`
  if (kind === 'collection') return `${t(COLLECTIONS[id] ?? 'sync.diff.pins')} · ${path.join('.')}`
  return [id, ...path].join('.')
}

/** A side's value; a bundle is on or off, a clipboard text pinned or not, rather than set or absent. */
function Value(props: { kind?: SyncChangeGroup['kind']; id?: string; path?: readonly string[]; value: string | undefined }): ReactNode {
  if (props.kind === 'bundles' && (props.path?.length ?? 0) > 0) return <span className="ac-sync-value">{t(props.value === undefined ? 'sync.diff.disabled' : 'sync.diff.enabled')}</span>
  if (props.kind === 'collection' && (props.value === undefined || props.value === 'on')) {
    const pins = props.id === 'pins.json'
    return <span className="ac-sync-value">{t(props.value === undefined ? (pins ? 'sync.diff.unpinned' : 'sync.diff.missing') : (pins ? 'sync.diff.pinned' : 'sync.diff.present'))}</span>
  }
  return props.value === undefined ? <span className="ac-sync-value" data-absent="">{t('sync.diff.absent')}</span> : <code className="ac-sync-value">{props.value}</code>
}

function Conflicts(props: { items: SyncConflict[]; choices: Record<string, Side>; locked: boolean; onChoose(key: string, side: Side): void; onAll(side: Side): void; children: ReactNode }): ReactNode {
  return (
    <section className="ac-sync-choice" aria-labelledby="ac-sync-conflicts">
      <div className="ac-sync-choice-head">
        <h4 id="ac-sync-conflicts">{t('sync.conflicts.title', { n: props.items.length })}</h4>
        <div className="ac-sync-bulk">
          <button type="button" className="ac-link" disabled={props.locked} onClick={() => props.onAll('local')}>{t('sync.conflicts.allLocal')}</button>
          <button type="button" className="ac-link" disabled={props.locked} onClick={() => props.onAll('remote')}>{t('sync.conflicts.allRemote')}</button>
        </div>
      </div>
      <p className="ac-muted">{t('sync.conflicts.hint')}</p>
      <ul className="ac-sync-conflicts">
        {props.items.map((item) => (
          <li key={item.key} className="ac-sync-conflict">
            <code className="ac-sync-conflict-name">{item.setting ?? settingName(item.kind, item.id, item.path)}</code>
            <div className="ac-sync-sides" role="radiogroup" aria-label={item.setting ?? settingName(item.kind, item.id, item.path)}>
              {(['local', 'remote'] as const).map((side) => (
                <button key={side} type="button" role="radio" className="ac-sync-side-pick" aria-checked={props.choices[item.key] === side}
                  disabled={props.locked} onClick={() => props.onChoose(item.key, side)}>
                  <span className="ac-sync-side-label">{t(side === 'local' ? 'sync.conflicts.local' : 'sync.conflicts.remote')}</span>
                  <Value kind={item.kind} id={item.id} path={item.path} value={item[side]} />
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {props.children}
    </section>
  )
}

function Outcome(props: { outcome: SyncOutcome; locked: boolean; onUndo(commit: string): void }): ReactNode {
  const { outcome } = props
  const applied = count(outcome.applied)
  const vars = { time: time(outcome.at), in: applied, out: outcome.pushed }
  const summary = applied === 0 && outcome.pushed === 0 ? t('sync.last.none', vars)
    : t(`sync.last.${outcome.kind}`, vars)
  const failed = count(outcome.unapplied)
  return (
    <div className="ac-notice ac-sync-outcome" data-tone={failed > 0 ? 'bad' : undefined}>
      <div className="ac-sync-outcome-head">
        <p>{summary}</p>
        {outcome.undo !== undefined && applied > 0 && <button type="button" className="ac-link" disabled={props.locked} onClick={() => props.onUndo(outcome.undo!)}>{t('sync.last.undo')}</button>}
      </div>
      {outcome.scheduled.length > 0 && <p>{t('sync.last.scheduled', { list: outcome.scheduled.join(', ') })}</p>}
      {failed > 0 && <><p>{t('sync.last.unapplied', { n: failed })}</p><Changes groups={outcome.unapplied} /></>}
      {applied > 0 && <details><summary>{t('sync.last.view')}</summary><Changes groups={outcome.applied} /></details>}
    </div>
  )
}

function Changes(props: { groups: SyncChangeGroup[] }): ReactNode {
  const row = (group: SyncChangeGroup, change: SyncChange): ReactNode => (
    <li key={`${group.kind}:${group.id}:${change.path.join('.')}`}>
      <code>{settingName(group.kind, group.id, change.path)}</code>
      <span><Value kind={group.kind} id={group.id} path={change.path} value={change.local} /> → <Value kind={group.kind} id={group.id} path={change.path} value={change.remote} /></span>
    </li>
  )
  return <ul className="ac-sync-changelist">{props.groups.flatMap((group) => group.changes.map((change) => row(group, change)))}</ul>
}

function Progress(props: { status: SyncStatus }): ReactNode {
  const progress = props.status.progress!
  const vars = { name: progress.name, spec: progress.spec, result: progress.result ?? progress.spec }
  const title = progress.stage === 'done' ? t(`sync.progress.done.${progress.op}`, vars) : progress.stage === 'failed' ? t('sync.progress.failed', vars) : progress.stage === 'applying' ? t('sync.progress.applying', vars) : t(`sync.progress.${progress.op}`, vars)
  return (
    <div className="ac-notice ac-sync-progress" data-stage={progress.stage} data-tone={progress.stage === 'failed' ? 'bad' : progress.stage === 'done' ? 'ok' : undefined} role="status">
      <p className="ac-sync-progress-head">{title}</p>
      {progress.stage === 'failed' && progress.result !== undefined && <p className="ac-sync-progress-result">{progress.result}</p>}
      {progress.lines.length > 0 && <details className="ac-sync-progress-log"><summary>{t('sync.progress.log', { n: progress.lines.length })}</summary><pre>{progress.lines.join('\n')}</pre></details>}
    </div>
  )
}

function History(props: { versions: SyncVersion[]; locked: boolean; onRestore(commit: string): void }): ReactNode {
  return <ol className="ac-sync-history">
    {props.versions.length === 0 && <li className="ac-muted">{t('sync.history.empty')}</li>}
    {props.versions.map((version, index) => <li key={version.commit}><code>{short(version.commit)}</code><span className="ac-sync-subject">{version.subject}</span><span className="ac-muted">{version.author} · {time(version.date)}</span>{index === 0 ? <span className="ac-tag">{t('sync.history.current')}</span> : <button type="button" className="ac-link" disabled={props.locked} onClick={() => props.onRestore(version.commit)}>{t('sync.restore')}</button>}</li>)}
  </ol>
}
