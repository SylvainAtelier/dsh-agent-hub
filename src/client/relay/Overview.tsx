/**
 * 接力's overview, the detail column before a thread is picked: each
 * workspace open to the glasses (one Qoder remote-control daemon each, run by
 * the host while DSH runs), whether the glasses reach it, what its processes
 * cost and when its idle workers are reclaimed; and a task sent to a Qoder
 * cloud session. The tasks themselves are threads in the list.
 */

import { useId, useState, type FormEvent, type ReactNode } from 'react'
import type { DaemonPhase, ProcView, TaskPhase, TaskView, WorkspaceView } from '../../qoder/types.ts'
import { newTaskUrl } from '../../qoder/types.ts'
import type { RelayStatus, ThreadPhase } from '../../relay/types.ts'
import type { RelayStore } from './api.ts'
import { ago, bytes, percent, procLine, span } from './format.ts'
import { IconBack, IconChevron, IconExternal, OriginIcon, PhaseMark } from './icons.tsx'
import { t } from './i18n.ts'

const TASK_PHASE: Record<TaskPhase, ThreadPhase> = { starting: 'running', running: 'running', idle: 'idle', dormant: 'idle', failed: 'failed', closed: 'ended' }

const PHASE_KEY: Record<DaemonPhase, 'ws.online' | 'ws.starting' | 'ws.retrying' | 'ws.stopped'> = {
  online: 'ws.online', starting: 'ws.starting', retrying: 'ws.retrying', stopped: 'ws.stopped',
}

export function Overview(props: { store: RelayStore; status: RelayStatus | undefined; pending: ReadonlySet<string>; openSettings(): void; onBack(): void }): ReactNode {
  const qoder = props.status?.qoder
  const workspaces = qoder?.workspaces ?? []
  return (
    <div className="rl-ov">
      <header className="rl-d-head">
        <button type="button" className="ah-icon-btn rl-back" aria-label={t('back')} title={t('back')} onClick={props.onBack}><IconBack /></button>
        <span className="rl-d-mark" aria-hidden="true"><OriginIcon origin="glasses" /></span>
        <div className="rl-d-id">
          <h2 className="rl-d-title" tabIndex={-1} data-focus-target="">{t('overview')}</h2>
          <p className="rl-d-lead">{t('lead')}</p>
        </div>
      </header>
      <div className="rl-ov-body">
        {qoder !== undefined && !qoder.installed && (
          <div className="rl-empty-card">
            <p className="rl-empty-title">{t('notInstalled')}</p>
            <p className="rl-empty-hint"><code>{t('installHint')}</code></p>
          </div>
        )}

        {qoder?.installed === true && workspaces.length === 0 && (
          <div className="rl-empty-card">
            <p className="rl-empty-title">{t('noWorkspace')}</p>
            <p className="rl-empty-hint">{t('noWorkspaceHint')}</p>
            <button type="button" className="ah-btn" data-variant="primary" onClick={props.openSettings}>{t('addWorkspace')}</button>
          </div>
        )}

        {workspaces.map((workspace) => (
          <Workspace key={workspace.path} workspace={workspace} busy={props.pending.has(workspace.path)}
            onToggle={(op) => void props.store.toggle(workspace.path, op)} onPick={(id) => props.store.select(`qoder:${id}`)} />
        ))}

        {qoder?.installed === true && workspaces.length > 0 && <Cloud store={props.store} workspaces={workspaces} />}

        {workspaces.length > 0 && <p className="rl-note">{t('autoMode')}</p>}
        {workspaces.length > 0 && <p className="rl-note">{t('stat.sampling')}</p>}
      </div>
    </div>
  )
}

function Workspace(props: { workspace: WorkspaceView; busy: boolean; onToggle(op: 'start' | 'stop' | 'reap'): void; onPick(id: string): void }): ReactNode {
  const { workspace } = props
  const now = Date.now()
  const stopped = workspace.phase === 'stopped'
  const workers = workspace.tasks.flatMap((task) => (task.worker === undefined ? [] : [task.worker]))
  const procs = workspace.daemon === undefined ? workers : [workspace.daemon, ...workers]
  const sum = (pick: (proc: ProcView) => number | undefined): number | undefined =>
    procs.some((proc) => pick(proc) !== undefined) ? procs.reduce((total, proc) => total + (pick(proc) ?? 0), 0) : undefined
  const memory = sum((proc) => proc.rss)
  const cpu = sum((proc) => proc.cpu)
  const running = workspace.tasks.filter((task) => task.phase === 'starting' || task.phase === 'running').length
  const idle = workspace.tasks.filter((task) => task.worker !== undefined && (task.phase === 'idle' || task.phase === 'failed')).length
  const reap = workspace.idleMinutes === 0 ? t('reapOff')
    : workspace.unreapable === true ? t('reapLocked')
    : running > 0 ? t('reapBusy')
      : workspace.held === true ? t('reapHeld')
      : workspace.reapAt === undefined || idle === 0 ? t('reapNone')
        : workspace.reapAt <= now ? t('reapDue', { n: idle })
          : t('reapAt', { n: idle, time: span(workspace.reapAt - now) })
  const { reaped } = workspace
  // What holds the workspace's processes: the tasks at work or with a worker kept (the rest are threads in the list only).
  const held = workspace.tasks.filter((task) => task.worker !== undefined || task.phase === 'starting' || task.phase === 'running')
  return (
    <section className="rl-ws" aria-label={workspace.name}>
      <div className="rl-ws-head">
        <span className="rl-state" data-phase={workspace.phase}>
          <span className="rl-dot" aria-hidden="true" />
          {t(PHASE_KEY[workspace.phase])}
        </span>
        <div className="rl-ws-id">
          <span className="rl-ws-name">{workspace.name}</span>
          <span className="rl-ws-path" title={workspace.path}>{workspace.path}</span>
        </div>
        <div className="rl-ws-actions">
          {workspace.phase === 'online' && running === 0 && idle > 0 && workspace.unreapable !== true && (
            <button type="button" className="ah-btn" data-variant="quiet" disabled={props.busy} title={t('reapNowHint')}
              onClick={() => props.onToggle('reap')}>{t('reapNow')}</button>
          )}
          {workspace.env !== undefined && workspace.phase === 'online' && (
            <a className="ah-btn" data-variant="quiet" href={newTaskUrl(workspace.env)} target="_blank" rel="noopener noreferrer">{t('newTask')} <IconExternal /></a>
          )}
          <button type="button" className="ah-btn" disabled={props.busy} aria-busy={props.busy}
            onClick={() => props.onToggle(stopped ? 'start' : 'stop')}>{stopped ? t('start') : t('stop')}</button>
        </div>
      </div>

      <dl className="rl-stats">
        <Stat label={t('stat.tasks')} value={t('stat.tasksValue', { n: workspace.tasks.length, r: running })} />
        {!stopped && <Stat label={t('stat.procs')} value={t('stat.procsValue', { n: procs.length, w: workers.length })} />}
        {!stopped && <Stat label={t('stat.memory')} value={memory === undefined ? t('unknown') : bytes(memory)} />}
        {!stopped && <Stat label={t('stat.cpu')} value={cpu === undefined ? t('unknown') : percent(cpu)} />}
        {workspace.daemon !== undefined && <Stat label={t('stat.daemon')} value={procLine(workspace.daemon, now)} />}
        <Stat label={t('stat.reap')} value={reap} />
        <Stat label={t('stat.reaped')} value={reaped.workers === 0 ? t('reapedNone')
          : t('reapedValue', { n: reaped.workers, mem: bytes(reaped.bytes), ago: reaped.at === undefined ? t('unknown') : ago(reaped.at, now) })} />
        {workspace.env !== undefined && <Stat label={t('stat.env')} value={workspace.env} mono />}
      </dl>
      {workspace.error !== undefined && <p className="rl-alert" data-tone={stopped ? 'warn' : 'danger'}>{workspace.error}</p>}
      {held.length > 0 && (
        <ul className="rl-ws-tasks" aria-label={t('ws.held')}>
          {held.map((task) => <HeldTask key={task.id} task={task} now={now} onPick={() => props.onPick(task.id)} />)}
        </ul>
      )}
    </section>
  )
}

/** A task holding a worker, with what that worker costs; picking it opens its thread. */
function HeldTask(props: { task: TaskView; now: number; onPick(): void }): ReactNode {
  const { task } = props
  const phase = TASK_PHASE[task.phase]
  const proc = task.worker === undefined ? undefined
    : [procLine(task.worker, props.now), ...(task.restored === undefined ? [] : [t('restored', { n: task.restored })])].join(' · ')
  return (
    <li>
      <button type="button" className="rl-ws-task" onClick={props.onPick}>
        <span className="rl-phase" data-phase={phase} title={t(`phase.${phase}`)}><PhaseMark phase={phase} /></span>
        <span className="rl-row-main">
          <span className="rl-row-title">{task.prompt ?? task.id}</span>
          <span className="rl-row-sub">{[t(`phase.${phase}`), ...(proc === undefined ? [] : [proc]), ago(task.updatedAt, props.now)].join(' · ')}</span>
        </span>
        <span className="rl-row-chevron" aria-hidden="true"><IconChevron /></span>
      </button>
    </li>
  )
}

function Stat(props: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="rl-stat">
      <dt>{props.label}</dt>
      <dd data-mono={props.mono} title={props.value}>{props.value}</dd>
    </div>
  )
}

/** A task for a Qoder cloud session, from one of the workspaces. */
function Cloud(props: { store: RelayStore; workspaces: readonly WorkspaceView[] }): ReactNode {
  const id = useId()
  const [path, setPath] = useState(props.workspaces[0]!.path)
  const [task, setTask] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: string; pending?: boolean }>({})
  const chosen = props.workspaces.some((workspace) => workspace.path === path) ? path : props.workspaces[0]!.path
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (task.trim() === '' || state.busy) return
    setState({ busy: true })
    props.store.cloud(chosen, task).then((result) => {
      setTask('')
      setState('pending' in result ? { pending: true } : { done: result.url })
    }, (error: unknown) => setState({ error: (error as Error).message }))
  }
  return (
    <form className="rl-ws rl-cloud" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <div className="rl-cloud-head">
        <span className="rl-d-mark" aria-hidden="true"><OriginIcon origin="cloud" /></span>
        <div>
          <h3 id={`${id}-title`} className="rl-cloud-title">{t('cloudTitle')}</h3>
          <p className="rl-cloud-lead">{t('cloudLead')}</p>
        </div>
      </div>
      {props.workspaces.length > 1 && (
        <label className="rl-field">
          <span className="rl-field-label">{t('cloudWorkspace')}</span>
          <select className="rl-input" value={chosen} onChange={(event) => setPath(event.target.value)}>
            {props.workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.name}</option>)}
          </select>
        </label>
      )}
      <label className="rl-field">
        <span className="rl-field-label">{t('cloudTask')}</span>
        <textarea className="rl-input" rows={3} value={task} placeholder={t('cloudPlaceholder')} aria-describedby={`${id}-state`}
          onChange={(event) => setTask(event.target.value)} />
      </label>
      <div className="rl-cloud-foot">
        <p id={`${id}-state`} className="rl-hint" role="status" data-tone={state.error !== undefined ? 'danger' : undefined}>
          {state.busy ? t('cloudSending') : state.error ?? (state.done !== undefined ? t('cloudDone') : state.pending ? t('cloudPending') : '')}
          {state.done !== undefined && <> · <a href={state.done} target="_blank" rel="noopener noreferrer">{t('cloudOpen')}</a></>}
        </p>
        <button type="submit" className="ah-btn" disabled={task.trim() === '' || state.busy === true} aria-busy={state.busy === true}>{t('cloudSend')}</button>
      </div>
    </form>
  )
}
