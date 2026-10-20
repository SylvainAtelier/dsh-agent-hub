/** Explicit script-definition mutations; the native manager owns all scheduling. */
import { AUTOMATION_METHOD, type AutomationReply, type ScriptTask, type TaskRun, type TaskStatus } from '../../automation/types.ts'
import { rpcValue, type Rpc } from '../rpc.ts'

export type AutomationAction = 'list' | 'preset' | 'upsert' | 'remove' | 'enable' | 'disable' | 'run' | 'cancel'
export interface AutomationSnapshot {
  reply?: AutomationReply
  busy?: AutomationAction
  error?: string
  uncertain?: boolean
}
export class AutomationStore {
  private snapshot: AutomationSnapshot = {}
  private listeners = new Set<() => void>()
  private pending: Promise<AutomationReply | undefined> | undefined
  private controller: AbortController | undefined
  private disposed = false
  private rpc: Rpc
  constructor(rpc: Rpc) { this.rpc = rpc }
  getSnapshot = (): AutomationSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  request(action: AutomationAction = 'list', payload: { id?: string; definition?: ScriptTask; expected?: ScriptTask | null } = {}): Promise<AutomationReply | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    if (this.pending) return Promise.resolve(undefined)
    // A lost mutation reply must be reconciled by a read, never blindly replayed.
    if (this.snapshot.uncertain && action !== 'list' && action !== 'preset' && action !== 'cancel') return Promise.resolve(undefined)
    this.set({ ...this.snapshot, busy: action, error: undefined })
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)])
    this.pending = (async () => {
      try {
        const reply = await rpcValue<AutomationReply>(this.rpc, AUTOMATION_METHOD, { action, ...payload }, 'Automation request failed', signal)
        if (!Array.isArray(reply?.tasks) || !Array.isArray(reply?.definitions)) throw new Error('Invalid automation response')
        if (!this.disposed) this.set({ reply: action === 'preset' ? this.snapshot.reply : reply, busy: undefined, uncertain: action === 'preset' ? this.snapshot.uncertain : false })
        return reply
      } catch (error) {
        if (!this.disposed) this.set({ ...this.snapshot, busy: undefined, error: error instanceof Error ? error.message : String(error), uncertain: this.snapshot.uncertain || (action !== 'list' && action !== 'preset') })
        return undefined
      } finally { this.pending = undefined; this.controller = undefined }
    })()
    return this.pending
  }
  /** Poll sparsely; while a manual run is in flight, follow it closely so its outcome appears promptly. */
  watch(): () => void {
    const running = (): boolean => this.snapshot.reply?.tasks.some((task) => task.manual?.status === 'running') === true
    const refresh = (): void => { if (document.visibilityState !== 'hidden') void this.request() }
    let fast = running()
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => { clearTimeout(timer); timer = setTimeout(() => { refresh(); schedule() }, fast ? 2_000 : 30_000) }
    const off = this.subscribe(() => { if (running() !== fast) { fast = !fast; schedule() } })
    refresh()
    schedule()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearTimeout(timer); off(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.listeners.clear() }
  private set(snapshot: AutomationSnapshot): void { this.snapshot = snapshot; for (const listener of this.listeners) listener() }
}

export const absolutePath = (value: string): boolean => /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(value)
/** Arguments are a JSON array, not a shell command line. No splitting or expansion. */
export function parseArguments(text: string): string[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error('Arguments must be a JSON array of strings')
  return value
}
export const EXTERNAL_AUTOMATION_PROVIDERS = ['claude-agent', 'cursor-agent', 'qoder-agent', 'hermes-agent'] as const
const boundedText = (value: string, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max && !value.includes('\0')
export function validDefinition(task: ScriptTask): boolean {
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(task.id) && boundedText(task.title, 120)
    && boundedText(task.command, 4096) && absolutePath(task.command) && boundedText(task.cwd, 4096) && absolutePath(task.cwd)
    && boundedText(task.provider, 200) && boundedText(task.model, 200) && !(EXTERNAL_AUTOMATION_PROVIDERS as readonly string[]).includes(task.provider)
    && Number.isSafeInteger(task.timeoutMs) && task.timeoutMs >= 1000 && task.timeoutMs <= 3_600_000
    && Array.isArray(task.args) && task.args.length <= 128 && task.args.every((arg) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'))
}

/** Whole minutes left, rounded up so the last minute never reads as "0"; undefined once due. */
export function remaining(target: number, now: number): { days: number; hours: number; minutes: number } | undefined {
  const left = Math.ceil((target - now) / 60_000)
  if (!Number.isFinite(left) || left <= 0) return undefined
  return { days: Math.floor(left / 1440), hours: Math.floor(left % 1440 / 60), minutes: left % 60 }
}

/** The run instant on this computer's clock, with today/tomorrow resolved against the local calendar. */
export function localClock(iso: string, now: number, zone?: string): { day: 'today' | 'tomorrow' | 'date'; date: string; time: string } | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const day = (value: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  const target = day(at)
  return { day: target === day(now) ? 'today' : target === day(now + 86_400_000) ? 'tomorrow' : 'date', date: target.slice(5).replace('-', '/'), time }
}

/** Native times arrive as "10:05:00.000"; people read "10:05". */
export const clockTime = (value: string): string => /^\d{1,2}:\d{2}/.exec(value)?.[0] ?? value

/** A readable zone name ("中国标准时间" / "China Standard Time"), falling back to the IANA id. */
export function zoneName(zone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'long' }).formatToParts(0).find((part) => part.type === 'timeZoneName')?.value ?? zone
  } catch { return zone }
}

/** When a run happened: its start, or the native delivery for a run that never started. */
export const runInstant = (run: TaskRun): string | undefined => run.startedAt ?? run.deliveredAt ?? run.finishedAt
export const runKind = (run: TaskRun): 'manual' | 'scheduled' => run.kind ?? (run.occurrence?.startsWith('manual:') ? 'manual' : 'scheduled')

/**
 * Every run the card knows about, newest first: the finished log plus the
 * in-flight scheduled and manual entries, each occurrence once.
 */
export function taskRuns(status: TaskStatus | undefined): TaskRun[] {
  if (!status) return []
  const seen = new Set<string>()
  const runs: TaskRun[] = []
  for (const run of [status.run, status.manual, ...(status.history ?? [])]) {
    if (!run) continue
    const key = run.occurrence ?? `${runKind(run)}:${runInstant(run) ?? runs.length}`
    if (seen.has(key)) continue
    seen.add(key); runs.push(run)
  }
  const at = (run: TaskRun): number => Date.parse(runInstant(run) ?? '') || 0
  return runs.sort((a, b) => at(b) - at(a))
}

/** Delivered with no admission for this long means the helper model never called the tool. */
export const STALLED_DELIVERY_MS = 10 * 60_000
export type RunTone = 'ok' | 'error' | 'unknown' | 'running' | 'pending' | 'stalled'
export function runTone(run: TaskRun, now: number): RunTone {
  switch (run.status) {
    case 'succeeded': return 'ok'
    case 'failed': return 'error'
    case 'running': return 'running'
    case 'delivered': {
      const at = Date.parse(run.deliveredAt ?? '')
      return Number.isFinite(at) && now - at > STALLED_DELIVERY_MS ? 'stalled' : 'pending'
    }
    default: return 'unknown'
  }
}

/** Wall-clock duration of a finished run, or undefined when either end is missing. */
export function runDuration(run: TaskRun): number | undefined {
  const start = Date.parse(run.startedAt ?? ''), end = Date.parse(run.finishedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
}

/** A past instant on this computer's clock, with today/yesterday resolved against the local calendar. */
export function pastClock(iso: string, now: number, zone?: string): { day: 'today' | 'yesterday' | 'date'; date: string; time: string } | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const day = (value: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  const target = day(at)
  const sameYear = target.slice(0, 4) === day(now).slice(0, 4)
  return { day: target === day(now) ? 'today' : target === day(now - 86_400_000) ? 'yesterday' : 'date', date: sameYear ? target.slice(5).replace('-', '/') : target.replaceAll('-', '/'), time }
}
