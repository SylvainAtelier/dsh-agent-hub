/** Host orchestration for the board's Sentry alerts lane. */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteText } from '../persistence.ts'
import { runGit, type Runner } from '../git/service.ts'
import type { Worktree, WorktreeOpened } from '../git/types.ts'
import type { AgentProfile } from '../team/profiles.ts'
import { BOT_ROUTE } from '../team/types.ts'
import type { SessionHost } from '../review/index.ts'
import type { SentryIssues } from '../connectors/sentry.ts'
import { parseSentryIssuesUrl } from '../connectors/sentry.ts'
import {
  SENTRY_REVIEW_PREFIX, isAlertOrder, isAlertPeriod, isAlertSort,
  type AlertOrder, type AlertPeriod, type AlertPhase, type AlertsReply, type AlertsRequest, type AlertsSettings, type AlertsState, type SentryIssue, type SentryIssueDetail,
} from './types.ts'

const REVIEW_DIR = '.reviews'
const MAX_ACTIVE = 2
/** A turn that never reports its end gives its slot back after this long. */
const SLOT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_PERIOD: AlertPeriod = '14d'
const DEFAULT_ORDER: AlertOrder = 'desc'
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

interface RecordData {
  issue: string
  tree?: string
  branch?: string
  session?: string
  bot?: string
  phase: AlertPhase
  verdict?: string
  lastSeen?: string
  events?: number
  fixedHead?: string
  /** HEAD when the fix turn started: the fix is the one commit after it. */
  fixBase?: string
  /** Only a worktree created by this workflow may be cleaned up after resolve. */
  generated?: boolean
  base?: string
  body: string
}

export interface AlertsHost {
  settings(): AlertsSettings
  sentry(): SentryIssues | undefined
  sessions(): SessionHost | undefined
  bots(): readonly AgentProfile[]
  trees: {
    list(cwd: string): Promise<Worktree[]>
    add(cwd: string, branch: string, base?: string): Promise<WorktreeOpened>
    open(cwd: string, path: string): Promise<WorktreeOpened>
  }
  git?: Runner
  log(message: string): void
}

const safeId = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9-]/g, '')
const issueSlug = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const sheetPath = (repo: string, id: string): string => join(repo, REVIEW_DIR, `${SENTRY_REVIEW_PREFIX}${safeId(id)}.md`)

function scalar(value: string | undefined): string {
  if (value === undefined) return ''
  return JSON.stringify(value)
}

function serializeRecord(record: RecordData): string {
  const lines = [
    '---',
    `issue: ${scalar(record.issue)}`,
    `phase: ${record.phase}`,
    ...(record.tree ? [`tree: ${scalar(record.tree)}`] : []),
    ...(record.branch ? [`branch: ${scalar(record.branch)}`] : []),
    ...(record.session ? [`session: ${scalar(record.session)}`] : []),
    ...(record.bot ? [`bot: ${scalar(record.bot)}`] : []),
    ...(record.verdict ? [`verdict: ${scalar(record.verdict)}`] : []),
    ...(record.lastSeen ? [`lastSeen: ${scalar(record.lastSeen)}`] : []),
    ...(record.events !== undefined ? [`events: ${record.events}`] : []),
    ...(record.fixedHead ? [`fixedHead: ${scalar(record.fixedHead)}`] : []),
    ...(record.fixBase ? [`fixBase: ${scalar(record.fixBase)}`] : []),
    ...(record.generated ? ['generated: true'] : []),
    ...(record.base ? [`base: ${scalar(record.base)}`] : []),
    '---', '', record.body.trim(), '',
  ]
  return lines.join('\n')
}

function unquote(value: string | undefined): string | undefined {
  if (!value) return undefined
  try { return JSON.parse(value) as string } catch { return value }
}

function parseRecord(value: string): RecordData | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(value)
  if (!match) return undefined
  const fields = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (entry) fields.set(entry[1]!, entry[2]!)
  }
  const issue = unquote(fields.get('issue'))
  const phase = fields.get('phase') as AlertPhase | undefined
  if (!issue || !phase || !['unanalysed', 'preparing', 'analysing', 'analysed', 'fixing', 'fixed', 'regression'].includes(phase)) return undefined
  const events = fields.get('events') && /^\d+$/.test(fields.get('events')!) ? Number(fields.get('events')) : undefined
  return {
    issue, phase, body: match[2] ?? '',
    ...(unquote(fields.get('tree')) ? { tree: unquote(fields.get('tree'))! } : {}),
    ...(unquote(fields.get('branch')) ? { branch: unquote(fields.get('branch'))! } : {}),
    ...(unquote(fields.get('session')) ? { session: unquote(fields.get('session'))! } : {}),
    ...(unquote(fields.get('bot')) ? { bot: unquote(fields.get('bot'))! } : {}),
    ...(unquote(fields.get('verdict')) ? { verdict: unquote(fields.get('verdict'))! } : {}),
    ...(unquote(fields.get('lastSeen')) ? { lastSeen: unquote(fields.get('lastSeen'))! } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(unquote(fields.get('fixedHead')) ? { fixedHead: unquote(fields.get('fixedHead'))! } : {}),
    ...(unquote(fields.get('fixBase')) ? { fixBase: unquote(fields.get('fixBase'))! } : {}),
    ...(fields.get('generated') === 'true' ? { generated: true } : {}),
    ...(unquote(fields.get('base')) ? { base: unquote(fields.get('base'))! } : {}),
  }
}

function initialBody(issue: SentryIssue): string {
  return `# ${issue.id}: ${issue.title}\n\n## Conclusion\n\nAnalysis in progress.\n\n## Root cause\n\nPending.\n\n## Evidence\n\n- Pending.\n\n## Fix plan\n\nPending.\n\n## Post-fix changes\n\nNone.`
}

function analysisPrompt(issue: SentryIssueDetail, path: string): string {
  return `Analyse Sentry issue ${issue.id} in this repository. You have full access in this worktree: run any commands, reproduce the issue, and use Sentry tools as needed. Write the analysis to the record at ${path}.\n\nUse the evidence below and inspect the local code. Update the record body with a one-line conclusion, root cause, concrete evidence using repository-relative path:line locations, and a minimal fix plan. Set front-matter phase to analysed and verdict to one of actionable, noise, external, or unknown. Keep the existing front-matter session, tree, branch, bot, lastSeen, and events values. Never paste the entire raw payload.\n\nSentry evidence (bounded):\n${issue.markdown}`
}

interface Tracked {
  /** The worktree the session works in. */
  repo: string
  path: string
  issue: string
  mode: 'analysis' | 'fix'
  fixHead?: string
  /** A turn was sent by this process: its end is a running → idle change, not just any idle report. */
  armed?: boolean
  /** The record this service last wrote, to restore its front matter when the model breaks it. */
  last?: RecordData
}

export class AlertsService {
  private readonly host: AlertsHost
  private readonly git: Runner
  /** Analyses and fixes being started, by issue. */
  private readonly starting = new Map<string, Promise<void>>()
  /** Why an issue's last analysis could not start, until it is tried again. */
  private readonly failures = new Map<string, string>()
  private readonly sessions = new Map<string, Tracked>()
  private readonly running = new Set<string>()
  private disposed = false
  private active = 0
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private readonly slots = new Set<() => void>()
  private readonly releases = new Map<string, () => void>()
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(host: AlertsHost) {
    this.host = host
    const git = host.git ?? runGit
    this.git = (...args) => this.step(() => git(...args))
  }

  /** Stop queued work and timers; operations already dispatched must not start their next step. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer)
    this.cleanupTimers.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Alerts service is disposed'))
    for (const release of this.releases.values()) release()
    this.releases.clear()
    for (const release of this.slots) release()
    this.sessions.clear()
    this.running.clear()
    this.failures.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Alerts service is disposed')
  }

  /** Check both sides of every external await before its continuation can cause another side effect. */
  private async step<T>(run: () => Promise<T>): Promise<T> {
    this.assertActive()
    const result = await run()
    this.assertActive()
    return result
  }

  private settings(): { settings: AlertsSettings; enabled: boolean } {
    this.assertActive()
    const settings = this.host.settings()
    return { settings, enabled: parseSentryIssuesUrl(settings.url) !== undefined && (settings.repo ?? '').trim() !== '' }
  }

  private async records(repo: string): Promise<Map<string, RecordData>> {
    const out = new Map<string, RecordData>()
    const dir = join(repo, REVIEW_DIR)
    const names = await this.step(() => readdir(dir).catch(() => []))
    await Promise.all(names.filter((name) => /^sentry-[A-Za-z0-9-]+\.md$/i.test(name)).map(async (name) => {
      const path = join(dir, name)
      const record = parseRecord(await this.step(() => readFile(path, 'utf8').catch(() => '')))
      this.assertActive()
      if (!record) return
      out.set(record.issue.toUpperCase(), record)
      // Only sessions this process does not track yet: a tracked one carries its turn's state.
      if (record.session && record.tree && !this.sessions.has(record.session)) {
        this.sessions.set(record.session, { repo: record.tree, path, issue: record.issue, mode: record.phase === 'fixing' ? 'fix' : 'analysis', ...(record.fixBase ? { fixHead: record.fixBase } : {}) })
      }
    }))
    return out
  }

  async warm(): Promise<void> {
    const { settings, enabled } = this.settings()
    if (enabled) await this.records(settings.repo).catch((error: unknown) => this.host.log(`could not index Sentry records: ${message(error)}`))
  }

  private decorate(issue: SentryIssue, record: RecordData | undefined): SentryIssue {
    const failure = this.failures.get(issue.id)
    // A record left `preparing` by a start that is no longer running (the host restarted) can be analysed again.
    if (!record || (record.phase === 'preparing' && !this.starting.has(issue.id))) return { ...issue, phase: 'unanalysed', ...(failure ? { error: failure } : {}) }
    // New events move Last Seen past the recorded one by more than the list's rounding.
    const seen = Date.parse(issue.lastSeen ?? '') - (issue.lastSeenSlackMs ?? 0)
    const regression = (record.phase === 'fixed' || record.phase === 'analysed') && seen > Date.parse(record.lastSeen ?? '')
    return { ...issue, phase: regression ? 'regression' : record.phase, ...(record.branch ? { branch: record.branch } : {}), ...(record.tree ? { tree: record.tree } : {}), ...(record.session ? { session: record.session } : {}), ...(record.bot ? { bot: record.bot } : {}), ...(record.verdict ? { verdict: record.verdict } : {}), ...(record.lastSeen ? { analysedLastSeen: record.lastSeen } : {}), ...(record.events !== undefined ? { analysedEvents: record.events } : {}), ...(record.fixedHead ? { fixedHead: record.fixedHead } : {}) }
  }

  async state(period: AlertPeriod = DEFAULT_PERIOD, sort: AlertsState['sort'] = 'lastSeen', order: AlertOrder = DEFAULT_ORDER, force = false): Promise<AlertsState> {
    const { settings, enabled } = this.settings()
    const bots = this.host.bots().filter((bot) => !/^seer$/i.test(bot.id)).map(({ id, description }) => ({ id, ...(description ? { description } : {}) }))
    const base = { period, sort, order, refreshedAt: Date.now(), bots, ...(settings.bot ? { defaultBot: settings.bot } : {}) }
    if (!enabled) return { enabled: false, issues: [], ...base }
    const bound = { ...base, repo: settings.repo }
    const sentry = this.host.sentry()
    if (!sentry) return { enabled: true, issues: [], ...bound, error: 'Sentry is not connected: connect it in Settings → Agent Hub → Connectors.' }
    const [listed, records] = await Promise.all([this.step(() => sentry.list(period, sort, order, force)).catch((error: unknown) => message(error)), this.records(settings.repo)])
    this.assertActive()
    // A failed read keeps the lane on screen with its reason.
    if (typeof listed === 'string') return { enabled: true, issues: [], ...bound, error: `Sentry: ${listed}` }
    return { enabled: true, issues: listed.issues.map((issue) => this.decorate(issue, records.get(issue.id.toUpperCase()))), ...bound, ...(listed.truncated ? { truncated: true } : {}) }
  }

  /** An unresolved prod issue: from any list already read, else from a fresh default list. */
  private async issue(id: string): Promise<SentryIssue> {
    this.assertActive()
    const sentry = this.host.sentry()
    if (!sentry) throw new Error('Sentry connector is not connected')
    const wanted = safeId(id)
    const cached = await this.step(() => sentry.cached(wanted))
    if (cached) return cached
    const listed = await this.step(() => sentry.list(DEFAULT_PERIOD, 'lastSeen', DEFAULT_ORDER))
    const issue = listed.issues.find((item) => item.id === wanted)
    if (!issue) throw new Error(`Sentry issue ${wanted} was not found among unresolved prod issues`)
    return issue
  }

  async detail(id: string, force = false): Promise<SentryIssueDetail> {
    const issue = await this.issue(id)
    const sentry = this.host.sentry()
    if (!sentry) throw new Error('Sentry connector is not connected')
    const { settings } = this.settings()
    const [detail, record] = await Promise.all([this.step(() => sentry.detail(issue, force)), readFile(sheetPath(settings.repo, issue.id), 'utf8').then(parseRecord).catch(() => undefined)])
    this.assertActive()
    return { ...detail, ...(record?.body.trim() ? { analysis: record.body.trim() } : {}) }
  }

  private async slot(): Promise<() => void> {
    this.assertActive()
    while (this.active >= MAX_ACTIVE) {
      await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }))
      this.assertActive()
    }
    this.assertActive()
    this.active++
    let held = true
    const release = (): void => {
      if (!held) return
      held = false
      this.slots.delete(release)
      this.active--
      if (!this.disposed) this.waiters.shift()?.resolve()
    }
    this.slots.add(release)
    return release
  }

  /** Keep a slot until the session's turn ends, or at most SLOT_TIMEOUT_MS. */
  private hold(session: string, release: () => void): void {
    this.assertActive()
    this.release(session)
    const done = (): void => { clearTimeout(timer); release() }
    const timer = setTimeout(() => { if (this.releases.get(session) === done) this.releases.delete(session); release() }, SLOT_TIMEOUT_MS)
    timer.unref?.()
    this.releases.set(session, done)
  }

  private release(session: string): void {
    const release = this.releases.get(session)
    this.releases.delete(session)
    release?.()
  }

  private async write(entry: { path: string; last?: RecordData }, record: RecordData): Promise<void> {
    await this.step(() => atomicWriteText(entry.path, serializeRecord(record)))
    this.assertActive()
    entry.last = record
  }

  private async tree(repo: string, issue: SentryIssue): Promise<{ path: string; workspaceId?: string; branch: string; generated?: boolean; base?: string }> {
    const needle = issueSlug(issue.id)
    const existing = (await this.step(() => this.host.trees.list(repo))).find((tree) => tree.branch?.toLowerCase().includes(needle))
    if (existing) {
      const opened = await this.step(() => this.host.trees.open(repo, existing.path))
      return { ...opened, branch: existing.branch! }
    }
    const remoteResult = await this.git(['remote'], repo, { read: true })
    const remote = remoteResult.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item === 'origin') ?? remoteResult.stdout.trim().split(/\s+/)[0]
    if (!remote) throw new Error('The repository has no Git remote')
    const fetch = await this.git(['fetch', '--no-tags', '--prune', remote], repo, { timeoutMs: 180_000 })
    if (fetch.code !== 0) throw new Error(fetch.stderr.trim() || 'Could not fetch the repository')
    let base = (await this.git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], repo, { read: true })).stdout.trim()
    if (!base) {
      const candidates = ['main', 'master']
      base = `${remote}/main`
      for (const name of candidates) {
        const found = await this.git(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], repo, { read: true })
        if (found.code === 0) { base = `${remote}/${name}`; break }
      }
    }
    const title = issue.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42).replace(/-+$/, '')
    const branch = `fix/${needle}${title ? `-${title}` : ''}`
    const opened = await this.step(() => this.host.trees.add(repo, branch, base))
    return { ...opened, branch, generated: true, base }
  }

  /**
   * Start analysing an issue. Resolves once the issue is marked `preparing` (a validation error rejects);
   * the fetch, worktree and session follow in the background, and a failure there is shown on the card.
   */
  async analyse(id: string, selectedBot?: string): Promise<void> {
    this.assertActive()
    const key = safeId(id)
    if (this.starting.has(key)) return
    let ready: () => void = () => {}
    const prepared = new Promise<void>((resolve) => { ready = resolve })
    const operation = this.runAnalysis(key, selectedBot, ready)
    const tracked = operation.then(
      () => { if (!this.disposed) this.failures.delete(key) },
      (error: unknown) => { if (this.disposed) return; this.failures.set(key, message(error)); this.host.log(`Sentry ${key} analysis did not start: ${message(error)}`) },
    ).finally(() => this.starting.delete(key))
    this.starting.set(key, tracked)
    // Whichever comes first: the issue is queued, or the start failed (then its error is the reply).
    await Promise.race([prepared, operation])
  }

  /** Analyses and fixes still starting. */
  async settled(): Promise<void> { await Promise.all([...this.starting.values()]) }

  private async runAnalysis(id: string, selectedBot: string | undefined, ready: () => void): Promise<void> {
    const { settings, enabled } = this.settings()
    if (!enabled) throw new Error('Sentry alerts are not configured')
    const issue = await this.issue(id)
    const path = sheetPath(settings.repo, issue.id)
    const old = parseRecord(await this.step(() => readFile(path, 'utf8').catch(() => '')))
    if (old?.session && ['analysing', 'analysed', 'fixing', 'fixed'].includes(old.phase)) { ready(); return }
    const botId = selectedBot?.trim() || settings.bot.trim()
    const bot = this.host.bots().find((item) => item.id === botId && !/^seer$/i.test(item.id))
    if (!bot) throw new Error(`The bot "${botId}" is unavailable`)
    const sessions = this.host.sessions()
    if (!sessions) throw new Error('Sessions are unavailable')
    this.failures.delete(issue.id)
    await this.step(() => mkdir(join(settings.repo, REVIEW_DIR), { recursive: true }))
    await this.step(() => writeFile(join(settings.repo, REVIEW_DIR, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {}))
    const entry: { path: string; last?: RecordData } = { path }
    // Queued: the card shows it at once, even while both slots are busy.
    await this.write(entry, { issue: issue.id, phase: 'preparing', bot: bot.id, body: initialBody(issue) })
    ready()
    const release = await this.slot()
    let handedOff = false
    try {
      this.assertActive()
      const detailPromise = this.detail(issue.id, true)
      detailPromise.catch(() => {})
      const tree = await this.tree(settings.repo, issue)
      const detail = await detailPromise
      // The detail's exact Last Seen beats the list's rounded one: later events are judged against it.
      const lastSeen = detail.lastSeen ?? issue.lastSeen
      const preparing: RecordData = { issue: issue.id, phase: 'preparing', tree: tree.path, branch: tree.branch, bot: bot.id, ...(tree.generated ? { generated: true } : {}), ...(tree.base ? { base: tree.base } : {}), ...(lastSeen ? { lastSeen } : {}), ...(issue.events !== undefined ? { events: issue.events } : {}), body: initialBody(issue) }
      await this.write(entry, preparing)
      const session = await this.step(() => sessions.start({ cwd: tree.path, ...(tree.workspaceId ? { workspaceId: tree.workspaceId } : {}), title: `Sentry ${issue.id} · ${issue.title}`.slice(0, 120), route: { provider: BOT_ROUTE, model: bot.id } }))
      const tracked: Tracked = { repo: tree.path, path, issue: issue.id, mode: 'analysis', armed: true }
      this.assertActive()
      this.sessions.set(session, tracked)
      await this.write(tracked, { ...preparing, session, phase: 'analysing' })
      this.hold(session, release)
      handedOff = true
      try {
        await this.step(() => sessions.send(session, analysisPrompt(detail, path), `sentry-analyse-${issue.id}-${lastSeen ?? randomUUID()}`))
      } catch (error) {
        tracked.armed = false
        this.release(session)
        throw error
      }
    } catch (error) {
      // Nothing reached a session: the queued record goes, so the card offers Analyse again.
      if (!handedOff && !this.disposed) await rm(path, { force: true }).catch(() => {})
      throw error
    } finally { if (!handedOff) release() }
  }

  async fix(id: string): Promise<void> {
    this.assertActive()
    const key = `fix:${safeId(id)}`
    if (this.starting.has(key)) return
    const operation = this.runFix(id)
    this.starting.set(key, operation.catch(() => {}))
    try { await operation } finally { this.starting.delete(key) }
  }

  private async runFix(id: string): Promise<void> {
    const { settings, enabled } = this.settings()
    if (!enabled) throw new Error('Sentry alerts are not configured')
    const path = sheetPath(settings.repo, id)
    const record = parseRecord(await this.step(() => readFile(path, 'utf8').catch(() => '')))
    if (!record?.session || !record.tree) throw new Error('Analyse this issue before fixing it')
    // A fixed issue that has new events can be fixed again.
    if (!['analysed', 'fixed'].includes(record.phase)) throw new Error('The analysis is not ready to fix')
    const sessions = this.host.sessions()
    if (!sessions) throw new Error('Sessions are unavailable')
    const fixHead = (await this.git(['rev-parse', 'HEAD'], record.tree, { read: true })).stdout.trim()
    // The events seen now are what this fix answers: only later ones mark the issue again.
    const current = await this.issue(record.issue).catch(() => undefined)
    const tracked: Tracked = { repo: record.tree, path, issue: record.issue, mode: 'fix', armed: true, ...(fixHead ? { fixHead } : {}) }
    await this.write(tracked, { ...record, phase: 'fixing', ...(fixHead ? { fixBase: fixHead } : {}), ...(current?.lastSeen ? { lastSeen: current.lastSeen } : {}), ...(current?.events !== undefined ? { events: current.events } : {}) })
    this.assertActive()
    this.sessions.set(record.session, tracked)
    try {
      await this.step(() => sessions.send(record.session!, `Implement the minimal fix from ${path} in this same worktree and context. You may edit tracked files now. Run focused tests. Make exactly one commit whose message includes "Fixes ${record.issue}". Update the record's Post-fix changes section. You have full access, including Git and Sentry operations.`, `sentry-fix-${record.issue}-${randomUUID()}`))
    } catch (error) {
      // The turn never started: back where it was, an analysis session again.
      tracked.mode = 'analysis'
      tracked.armed = false
      await this.write(tracked, record).catch(() => {})
      throw error
    }
  }

  async resolve(id: string, resolved: boolean): Promise<void> {
    this.assertActive()
    const sentry = this.host.sentry()
    if (!sentry) throw new Error('Sentry connector is not connected')
    const key = safeId(id)
    await this.step(() => sentry.resolve(key, resolved))
    clearTimeout(this.cleanupTimers.get(key))
    this.cleanupTimers.delete(key)
    this.assertActive()
    if (resolved) {
      const timer = setTimeout(() => {
        this.cleanupTimers.delete(key)
        if (this.disposed) return
        void this.cleanup(key).catch((error: unknown) => { if (!this.disposed) this.host.log(`Sentry ${key} worktree kept: ${message(error)}`) })
      }, 10_000)
      timer.unref?.()
      this.cleanupTimers.set(key, timer)
    }
  }

  /** Remove only a workflow-created tree that is still clean and has no commit beyond its fetched base. */
  private async cleanup(id: string): Promise<void> {
    const { settings, enabled } = this.settings()
    if (!enabled) return
    const record = parseRecord(await this.step(() => readFile(sheetPath(settings.repo, id), 'utf8').catch(() => '')))
    if (!record?.generated || !record.tree || !record.branch || !record.base) return
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all'], record.tree, { read: true })
    if (status.code !== 0 || status.stdout.trim() !== '') return
    const ahead = await this.git(['rev-list', '--count', `${record.base}..HEAD`], record.tree, { read: true })
    if (ahead.code !== 0 || ahead.stdout.trim() !== '0') return
    const removed = await this.git(['worktree', 'remove', '--', record.tree], settings.repo, { timeoutMs: 60_000 })
    if (removed.code !== 0) return
    await this.git(['branch', '-D', '--', record.branch], settings.repo, { timeoutMs: 30_000 })
  }

  sessionMode(sessionId: string | undefined): 'analysis' | 'fix' | undefined { return sessionId ? this.sessions.get(sessionId)?.mode : undefined }
  sessionRepo(sessionId: string | undefined): string | undefined { return sessionId ? this.sessions.get(sessionId)?.repo : undefined }
  section(sessionId: string | undefined): string | undefined {
    const entry = sessionId ? this.sessions.get(sessionId) : undefined
    return entry ? `This session handles Sentry issue ${entry.issue}. It has full access, including Git and Sentry operations.` : undefined
  }

  /** A session's turn ended: settle the record it worked on. */
  async status(sessionId: string, running: boolean): Promise<void> {
    if (this.disposed) return
    const entry = this.sessions.get(sessionId)
    if (running) {
      if (entry) this.running.add(sessionId)
      return
    }
    const wasRunning = this.running.delete(sessionId)
    if (!entry) return
    // An idle report before the sent turn ran (the session just started) is not its end.
    if (entry.armed && !wasRunning) return
    entry.armed = false
    this.release(sessionId)
    const text = await readFile(entry.path, 'utf8').catch(() => '')
    if (this.disposed) return
    // The model may have broken the front matter: its text stays as the body under ours.
    const record = parseRecord(text) ?? (entry.last && text.trim() ? { ...entry.last, body: text.replace(/^---[\s\S]*?---\r?\n?/, '') } : undefined)
    if (!record) return
    if (entry.mode === 'analysis' && (record.phase === 'analysing' || record.phase === 'analysed')) await this.write(entry, { ...record, phase: 'analysed' })
    if (entry.mode === 'fix' && record.phase === 'fixing') {
      const fixHead = entry.fixHead ?? record.fixBase
      const head = (await this.git(['rev-parse', 'HEAD'], entry.repo, { read: true })).stdout.trim()
      const commits = fixHead && head ? (await this.git(['rev-list', '--count', `${fixHead}..${head}`], entry.repo, { read: true })).stdout.trim() : ''
      const dirty = (await this.git(['status', '--porcelain=v1', '--untracked-files=no'], entry.repo, { read: true })).stdout.trim()
      const complete = head !== '' && commits === '1' && dirty === ''
      await this.write(entry, complete
        ? { ...record, phase: 'fixed', fixedHead: head }
        : { ...record, phase: 'analysed', verdict: 'fix-incomplete', body: `> Warning: the fix turn did not finish as exactly one clean commit. The worktree was preserved.\n\n${record.body}` })
      entry.mode = 'analysis'
    }
  }

  async handle(request: AlertsRequest): Promise<AlertsReply<unknown>> {
    try {
      this.assertActive()
      switch (request.op) {
        case 'list': return { ok: true, value: await this.state(isAlertPeriod(request.period) ? request.period : DEFAULT_PERIOD, isAlertSort(request.sort) ? request.sort : 'lastSeen', isAlertOrder(request.order) ? request.order : DEFAULT_ORDER, request.force === true) }
        case 'detail': return { ok: true, value: await this.detail(String(request.id), request.force === true) }
        case 'analyse': await this.analyse(String(request.id), request.bot); return { ok: true, value: null }
        case 'fix': await this.fix(String(request.id)); return { ok: true, value: null }
        case 'resolve': await this.resolve(String(request.id), true); return { ok: true, value: null }
        case 'unresolve': await this.resolve(String(request.id), false); return { ok: true, value: null }
      }
    } catch (error) {
      this.host.log(message(error))
      return { ok: false, error: message(error) }
    }
  }
}

export { parseRecord, serializeRecord, sheetPath }
