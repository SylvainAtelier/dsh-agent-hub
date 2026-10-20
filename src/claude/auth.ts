/**
 * Sign-in failures of the local Claude CLI, surfaced to the browser.
 *
 * DSH's chat renders the shared `AUTH` failure code as a fixed "invalid API
 * key" line and drops the message, which is wrong for a CLI login. So the
 * adapter reports these failures with its own code and a message that says
 * what to do, and records them here; the browser long-polls this hub and opens
 * a re-sign-in prompt the moment one happens.
 */

import { randomUUID } from 'node:crypto'
import { localized } from '../locale.ts'

export const AUTH_METHOD = 'agent-hub/claude-auth'
/** dsh-llm failure code for a Claude CLI sign-in failure. Outside the retryable set on purpose. */
export const AUTH_CODE = 'CLAUDE_AUTH'

export interface AuthFailure {
  at: number
  detail: string
  account?: string
}

export interface AuthState {
  /** Changes when the host restarts; the browser resets its cursor then. */
  boot: string
  epoch: number
  last?: AuthFailure
}

/** Claude Code's error wording for a missing, expired or revoked login. */
const AUTH_TEXT = /authentication|unauthori[sz]ed|invalid api key|please run \/login|not logged in|log ?in again|oauth token|token (has )?expired|401\b/i

export function isAuthText(text: string): boolean {
  return AUTH_TEXT.test(text)
}

/** The chat line for a sign-in failure: what happened and the one command that fixes it. */
export function authMessage(detail: string, account = 'default'): string {
  const reason = detail.replace(/^Claude Code:\s*/, '').trim()
  if (account !== 'default') return localized({
    zh: `Claude 当前账号登录已失效或未登录，本轮没有发送。请在 Agent Hub 的账号管理中查看该账号的专用登录命令，完成 /login 后再发送。${reason ? `（${reason}）` : ''}`,
    en: `This Claude account is signed out. Open Agent Hub account management for its own login command, complete /login, then resend.${reason ? ` (${reason})` : ''}`,
  })
  return localized({
    zh: `Claude 登录已失效或未登录，本轮没有发送。请在终端运行 claude，输入 /login 重新登录后再发送。${reason ? `（${reason}）` : ''}`,
    en: `Claude sign-in is missing or expired, so this turn was not sent. Run claude in a terminal, enter /login, then send again.${reason ? ` (${reason})` : ''}`,
  })
}

export class AuthNotices {
  private state: AuthState = { boot: randomUUID(), epoch: 0 }
  private readonly waiters = new Set<() => void>()

  report(detail: string, account?: string): void {
    this.state = { ...this.state, epoch: this.state.epoch + 1, last: { at: Date.now(), detail, account } }
    for (const wake of this.waiters) wake()
  }

  snapshot(): AuthState {
    return this.state
  }

  /**
   * Resolve at once if anything happened after `since` (or the host restarted), else at the next failure or after `timeoutMs`.
   * Kept well under the Desktop update lock, which drains in-flight requests for at most 10s before giving up.
   */
  wait(boot: unknown, since: unknown, timeoutMs = 5_000): Promise<AuthState> {
    if (boot !== this.state.boot || typeof since !== 'number' || since < this.state.epoch) return Promise.resolve(this.state)
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(this.state)
      }
      const timer = setTimeout(wake, timeoutMs)
      this.waiters.add(wake)
    })
  }

  dispose(): void {
    for (const wake of [...this.waiters]) wake()
  }
}
