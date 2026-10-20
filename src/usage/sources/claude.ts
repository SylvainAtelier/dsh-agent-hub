/**
 * Claude subscription quota through the Claude Code CLI.
 *
 * `claude -p /usage` runs the built-in usage command locally: no model turn,
 * no token cost, and the CLI keeps owning its OAuth refresh. Its output is
 * human text, parsed line by line:
 *
 *   Current session: 5% used · resets Oct 3, 3:29am (Europe/Budapest)
 *   Current week (all models): 38% used · resets Oct 3, 11:59am (Europe/Budapest)
 *   Current session: 55% used · resets Oct 11 at 9:59pm (Europe/Paris)
 */

import { exec } from '../../exec.ts'
import { claudeEnv, findClaudeExecutable, probeDir } from '../../claude/cli.ts'
import { ClaudeAccounts, DEFAULT_ACCOUNT, DEFAULT_NAME } from '../../claude/accounts.ts'
import { localized } from '../../locale.ts'
import { clampPercent, DAY, HOUR } from './http.ts'
import type { PlanQuota, QuotaWindow } from '../types.ts'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * Parse the CLI's reset text (`Oct 3, 3:29am`, `Oct 3 at 3:29am`, `3:29am`,
 * `Oct 10`) as host
 * local time — the CLI runs on this host and prints in its time zone.
 */
export function parseResetText(text: string, now: number): number | undefined {
  // Newer CLIs join date and time with "at" (`Oct 11 at 9:59pm`); a 24-hour
  // clock (`21:59`) carries no am/pm.
  const match = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s|$)\s*(?:at\s+)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)|(\d{1,2}):(\d{2})(?!\d))?/i.exec(text.trim())
  if (match === null || (match[1] === undefined && match[3] === undefined && match[6] === undefined)) return undefined
  const date = new Date(now)
  if (match[1] !== undefined) {
    const month = MONTHS.indexOf(match[1].toLowerCase())
    if (month < 0) return undefined
    date.setMonth(month, Number(match[2]))
  }
  let hour = 0
  let minute = 0
  if (match[3] !== undefined) {
    hour = Number(match[3]) % 12
    if (match[5]?.toLowerCase() === 'pm') hour += 12
    minute = Number(match[4] ?? 0)
  } else if (match[6] !== undefined) {
    hour = Number(match[6])
    minute = Number(match[7])
  }
  date.setHours(hour, minute, 0, 0)
  let at = date.getTime()
  // A reset is always in the future: roll a time-only value to tomorrow and
  // a month/day that already passed into next year.
  if (at < now - HOUR) {
    if (match[1] === undefined) at += DAY
    else {
      date.setFullYear(date.getFullYear() + 1)
      at = date.getTime()
    }
  }
  return at
}

/** Parse the `/usage` text into windows; unknown lines are ignored. */
export function parseUsageText(text: string, now: number): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*Current (session|week)(?:\s*\(([^)]+)\))?\s*:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+(.+?))?\s*(?:\([^)]*\))?\s*$/i.exec(line)
    if (match === null) continue
    const session = match[1].toLowerCase() === 'session'
    const scope = match[2]
    const resetsAt = match[4] === undefined ? undefined : parseResetText(match[4], now)
    windows.push({
      key: session ? '5h' : 'week',
      // "all models" is the plan's main weekly limit; per-model weeks are secondary.
      ...(scope !== undefined && !/all models/i.test(scope) ? { group: scope.replace(/\s+only$/i, '') } : {}),
      usedPercent: clampPercent(Number(match[3])),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      windowMs: session ? 5 * HOUR : 7 * DAY,
    })
  }
  return windows
}

/** Executable candidates: the native binary, then npm's shim. */
function candidates(): Array<{ file: string; shell: boolean }> {
  const native = findClaudeExecutable()
  return [
    ...(native === undefined ? [] : [{ file: native, shell: false }]),
    // npm global installs ship a .cmd shim that only a shell can launch; the
    // arguments are constants, so the shell sees no user input.
    ...(process.platform === 'win32' ? [{ file: 'claude.cmd', shell: true }] : [{ file: 'claude', shell: false }]),
  ]
}

class NotInstalled extends Error {}

/**
 * The local `/usage` command. `--strict-mcp-config` keeps the user's MCP
 * servers from starting for a command that never reaches the model, and the
 * auto-updater stays out of a process that lives for a few seconds.
 */
const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config']

async function runClaude(args: string[], configDir?: string): Promise<string> {
  for (const { file, shell } of candidates()) {
    const result = await exec(file, args, {
      cwd: probeDir(),
      shell,
      timeoutMs: 30_000,
      maxBytes: 1 << 20,
      partial: true,
      env: { ...claudeEnv(configDir), NO_COLOR: '1', DISABLE_AUTOUPDATER: '1' },
    })
    const failed = result.missing || result.timedOut || result.overflow || result.code !== 0
    // What it printed counts even when it then failed.
    if (!failed || result.stdout !== '') return result.stdout
    // Not found here: try the next candidate. A shell reports a missing
    // command through its exit status instead of ENOENT.
    if (result.missing || (shell && !result.timedOut && result.code !== null)) continue
    throw new Error(result.timedOut ? 'claude timed out' : result.stderr.trim() || `claude exited with ${result.code}`)
  }
  throw new NotInstalled('claude CLI not found')
}

type Account = Pick<PlanQuota, 'account' | 'plan'> & { loggedIn: boolean }

/** Plan and email rarely change: one `auth status` process per this long instead of one per usage read. */
const ACCOUNT_TTL_MS = 30 * 60_000
const accountCache = new Map<string, { at: number; value: Promise<Account> }>()

/** `claude auth status` → plan tier and email; best effort. `fresh` skips the cache. */
function readAccount(id = DEFAULT_ACCOUNT, configDir?: string, fresh = false): Promise<Account> {
  const cached = accountCache.get(id)
  if (!fresh && cached !== undefined && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.value
  const read = (async (): Promise<Account> => {
    const status = JSON.parse(await runClaude(['auth', 'status'], configDir)) as { loggedIn?: boolean; email?: string; subscriptionType?: string }
    return {
      loggedIn: status.loggedIn !== false,
      ...(status.email ? { account: status.email } : {}),
      ...(status.subscriptionType ? { plan: status.subscriptionType } : {}),
    }
  })()
  const value = read.catch((error: unknown): Account => {
    if (error instanceof NotInstalled) throw error
    return { loggedIn: true }
  })
  const entry = { at: Date.now(), value }
  accountCache.set(id, entry)
  // Only a confirmed sign-in is worth keeping; anything else is asked again next time.
  const drop = (): void => { if (accountCache.get(id) === entry) accountCache.delete(id) }
  read.then((account) => { if (!account.loggedIn) drop() }, drop)
  return value
}

/** Forget the cached account (a turn failed signed out, or the usage read did). */
export function forgetClaudeAccount(id?: string): void {
  if (id === undefined) { accountCache.clear(); usageCache.clear() }
  else { accountCache.delete(id); usageCache.delete(id) }
}

export interface SignInCheck {
  installed: boolean
  signedIn: boolean
  account?: string
  detail?: string
}

/**
 * Is the CLI signed in, for real? `auth status` only reads the stored login, so
 * the token is also exercised with the local `/usage` command (no model call,
 * no tokens), which fails the way a turn would when the login has expired.
 */
export async function checkClaudeSignIn(isAuthText: (text: string) => boolean, id = DEFAULT_ACCOUNT, configDir?: string): Promise<SignInCheck> {
  let account: Account
  try {
    account = await readAccount(id, configDir, true)
  } catch {
    return { installed: false, signedIn: false }
  }
  if (!account.loggedIn) return { installed: true, signedIn: false }
  let output = ''
  try {
    output = await runClaude(USAGE_ARGS, configDir)
  } catch (error) {
    output = error instanceof Error ? error.message : String(error)
  }
  let detail = output
  try {
    const parsed = JSON.parse(output) as { is_error?: boolean; result?: string }
    if (parsed.is_error !== true) return { installed: true, signedIn: true, ...(account.account ? { account: account.account } : {}) }
    detail = parsed.result ?? output
  } catch {
    // Not JSON: judge the raw text.
  }
  return isAuthText(detail)
    ? { installed: true, signedIn: false, detail: detail.trim().slice(0, 300) }
    : { installed: true, signedIn: true, ...(account.account ? { account: account.account } : {}) }
}

async function readOneClaude(id: string, configDir: string | undefined, active: boolean, name: string, now: () => number): Promise<PlanQuota> {
  const base = { id: id === DEFAULT_ACCOUNT ? 'claude' : `claude:${id}`, provider: 'claude' as const, account: name, active, windows: [], fetchedAt: 0 }
  try {
    const [{ loggedIn, ...account }, raw] = await Promise.all([
      readAccount(id, configDir),
      runClaude(USAGE_ARGS, configDir),
    ])
    if (!loggedIn) return { ...base, error: { code: 'not-signed-in' } }
    const result = JSON.parse(raw) as { is_error?: boolean; result?: string }
    if (result.is_error) forgetClaudeAccount(id)
    const text = result.result ?? ''
    const windows = parseUsageText(text, now())
    if (windows.length === 0) {
      // API-key logins and format changes both land here; keep the CLI's own
      // words so the card still says something true.
      const message = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim()
      return { ...base, ...account, error: { code: result.is_error ? 'failed' : 'incompatible', ...(message ? { message } : {}) } }
    }
    return { ...base, ...account, windows, fetchedAt: now() }
  } catch (error) {
    if (error instanceof NotInstalled) return { ...base, error: { code: 'not-installed' } }
    return { ...base, error: { code: 'failed', message: (error as Error).message } }
  }
}

/** Selection changes only relabel cached quotas; they do not cold-start every CLI again. */
const usageCache = new Map<string, { at: number; value: Promise<PlanQuota> }>()
export function forgetClaudeUsage(id: string): void { usageCache.delete(id) }
function cachedClaude(id: string, configDir: string | undefined, active: boolean, name: string, now: () => number, force: boolean): Promise<PlanQuota> {
  const cached = usageCache.get(id)
  if (!force && cached && Date.now() - cached.at < 300_000) {
    return cached.value.then((quota) => ({ ...quota, active, account: quota.account ?? name }))
  }
  const value = readOneClaude(id, configDir, active, name, now)
  const entry = { at: Date.now(), value }
  usageCache.set(id, entry)
  value.then((quota) => { if (quota.error && usageCache.get(id) === entry) usageCache.delete(id) }, () => {
    if (usageCache.get(id) === entry) usageCache.delete(id)
  })
  return value
}

/** Read each registered account on demand, with at most two CLI cold starts concurrently. */
export async function readClaude(now: () => number = Date.now, accounts?: ClaudeAccounts, force = false, selectedOnly = false): Promise<PlanQuota[]> {
  if (accounts === undefined) return [await cachedClaude(DEFAULT_ACCOUNT, undefined, true, localized(DEFAULT_NAME), now, force)]
  await accounts.ready
  const state = accounts.list()
  const entries = selectedOnly ? state.accounts.filter((entry) => entry.id === state.active) : state.accounts
  const result: PlanQuota[] = new Array(entries.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(2, result.length) }, async () => {
    while (next < result.length) {
      const index = next++
      const entry = entries[index]
      result[index] = await cachedClaude(entry.id, accounts.dir(entry.id), entry.id === state.active, entry.name, now, force)
    }
  }))
  // An account switch during a slow probe must not publish the old account as active.
  return selectedOnly ? result.map((item, index) => ({ ...item, active: entries[index].id === accounts.selected })) : result
}
