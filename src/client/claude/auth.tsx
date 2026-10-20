/**
 * Re-sign-in prompt for Claude Agent. The host reports each turn that failed
 * because the local Claude CLI is signed out; this long-polls those reports
 * and opens one dialog with the exact steps, a button that opens a terminal
 * in the right sidebar, and a re-check that exercises the login for real.
 */

import { useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { injectGitStyle } from '../git/style.ts'

export const AUTH_METHOD = 'agent-hub/claude-auth'

interface AuthState {
  boot: string
  epoch: number
  last?: { at: number; detail: string; account?: string }
}

interface SignInCheck {
  installed: boolean
  signedIn: boolean
  account?: string
  detail?: string
}

type Call = (payload: object) => Promise<unknown>

const english = (): boolean => document.documentElement.lang.toLowerCase().startsWith('en')

const COPY = {
  zh: {
    title: 'Claude 需要重新登录',
    lead: '刚才这一轮没有发送：本机 Claude Code 的登录已失效或尚未登录。登录后重新发送即可，会话内容不会丢失。',
    step1: '打开终端',
    openTerminal: '在侧栏打开终端',
    step2: '运行',
    step3: '在 Claude 里输入',
    step3b: '，按提示在浏览器中完成登录',
    step4: '回到这里点「重新检测」，通过后重新发送刚才的消息',
    copy: '复制',
    copied: '已复制',
    close: '关闭',
    check: '重新检测',
    checking: '检测中…',
    ok: '已登录{account}，可以重新发送了。',
    still: '仍未登录：{detail}',
    stillPlain: '仍未登录，请按上面的步骤完成登录。',
    missing: '没有找到 claude 命令。请先安装 Claude Code（npm install -g @anthropic-ai/claude-code），再按上面的步骤登录。',
    done: '完成',
    detail: '错误详情',
  },
  en: {
    title: 'Sign in to Claude again',
    lead: 'The last turn was not sent: Claude Code on this computer is signed out or its login expired. Sign in, then send again — nothing in the session is lost.',
    step1: 'Open a terminal',
    openTerminal: 'Open terminal in sidebar',
    step2: 'Run',
    step3: 'In Claude, enter',
    step3b: ' and finish signing in in your browser',
    step4: 'Come back and press Check again, then resend your message',
    copy: 'Copy',
    copied: 'Copied',
    close: 'Close',
    check: 'Check again',
    checking: 'Checking…',
    ok: 'Signed in{account}. You can send again.',
    still: 'Still signed out: {detail}',
    stillPlain: 'Still signed out. Follow the steps above to sign in.',
    missing: 'The claude command was not found. Install Claude Code (npm install -g @anthropic-ai/claude-code), then sign in as above.',
    done: 'Done',
    detail: 'Error details',
  },
}

type CopyKey = keyof typeof COPY.zh
const tr = (key: CopyKey, params: Record<string, string> = {}): string =>
  (english() ? COPY.en : COPY.zh)[key].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')

function CopyCode(props: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <span className="ca-code">
      <code>{props.text}</code>
      <button type="button" className="gp-text-btn" onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}>{copied ? tr('copied') : tr('copy')}</button>
    </span>
  )
}

function Prompt(props: { detail: string; accountId: string; name?: string; command?: string; call: Call; openTerminal?: () => void; onClose: () => void }): ReactNode {
  const [check, setCheck] = useState<{ phase: 'idle' } | { phase: 'checking' } | { phase: 'done'; result: SignInCheck } | { phase: 'error'; message: string }>({ phase: 'idle' })
  const signedIn = check.phase === 'done' && check.result.signedIn
  const run = async (): Promise<void> => {
    setCheck({ phase: 'checking' })
    try {
      const result = await props.call({ op: 'check', id: props.accountId }) as SignInCheck
      setCheck({ phase: 'done', result })
    } catch (error) {
      setCheck({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  let status: ReactNode = null
  if (check.phase === 'done') {
    const { result } = check
    status = (
      <p className="ca-status" data-ok={result.signedIn ? '' : undefined}>
        {!result.installed ? tr('missing')
          : result.signedIn ? tr('ok', { account: result.account ? `（${result.account}）` : '' })
            : result.detail ? tr('still', { detail: result.detail }) : tr('stillPlain')}
      </p>
    )
  } else if (check.phase === 'error') {
    status = <p className="ca-status">{tr('still', { detail: check.message })}</p>
  }
  return (
    <div className="gp-dialog-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="gp-dialog ca-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ca-title"
        onKeyDown={(event) => { if (event.key === 'Escape') props.onClose() }}>
        <div className="ca-head">
          <span className="ca-icon" aria-hidden="true">!</span>
          <div className="gp-dialog-title" id="ca-title">{tr('title')}{props.name ? ` · ${props.name}` : ''}</div>
        </div>
        <p className="gp-dialog-body">{tr('lead')}</p>
        <ol className="ca-steps">
          <li>
            <span>{tr('step1')}</span>
            {props.openTerminal !== undefined && (
              <button type="button" className="ah-btn ah-btn-sm" onClick={props.openTerminal}>{tr('openTerminal')}</button>
            )}
          </li>
          <li><span>{tr('step2')}</span>{props.command || props.accountId === 'default'
            ? <CopyCode text={props.command ?? 'claude'} />
            : <span>{english() ? 'Account removed; add it again before signing in.' : '账号已移除，请重新添加后登录。'}</span>}</li>
          <li><span>{tr('step3')}</span><CopyCode text="/login" /><span>{tr('step3b')}</span></li>
          <li><span>{tr('step4')}</span></li>
        </ol>
        {props.detail !== '' && (
          <details className="ca-detail">
            <summary>{tr('detail')}</summary>
            <pre>{props.detail}</pre>
          </details>
        )}
        {status}
        <div className="gp-dialog-actions">
          <button type="button" className="ah-btn" onClick={props.onClose}>{signedIn ? tr('done') : tr('close')}</button>
          {!signedIn && (
            <button type="button" className="ah-btn" data-variant="primary" disabled={check.phase === 'checking'} onClick={() => void run()} autoFocus>
              {check.phase === 'checking' ? tr('checking') : tr('check')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const CSS = `
.ca-dialog { width: min(460px, 100%); }
.ca-head { display: flex; align-items: center; gap: 10px; }
.ca-icon {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%;
  background: color-mix(in srgb, var(--ah-warn) 18%, transparent); color: var(--ah-warn-ink); font-weight: 700; font-size: 13px;
}
.ca-steps { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 10px; line-height: 1.5; }
.ca-steps li { padding-left: 2px; }
.ca-steps li > * { vertical-align: middle; }
.ca-steps li > span + .ah-btn, .ca-steps li > span + .ca-code { margin-left: 8px; }
.ca-code { display: inline-flex; align-items: center; gap: 2px; margin: 0 4px; padding: 1px 2px 1px 8px; border-radius: var(--ah-radius-sm);
  background: color-mix(in srgb, currentColor 8%, transparent); }
.ca-code code { font-family: var(--ah-mono); font-size: 12px; }
.ca-detail summary { cursor: pointer; font-size: 12px; color: var(--ah-fg3); }
.ca-detail pre { margin: 6px 0 0; max-height: 120px; overflow: auto; white-space: pre-wrap; font-family: var(--ah-mono); font-size: 12px; color: var(--ah-fg2); }
.ca-status { margin: 0; padding: 8px 10px; border-radius: var(--ah-radius); font-size: 13px; line-height: 1.5;
  background: color-mix(in srgb, var(--ah-danger) 10%, transparent); color: var(--ah-fg); }
.ca-status[data-ok] { background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
`

export interface AuthWatchOptions {
  call: Call
  openTerminal?: () => void
}

/** Start watching for sign-in failures; returns the disposer. */
export function watchClaudeAuth(options: AuthWatchOptions): () => void {
  let stopped = false
  let root: Root | undefined
  let host: HTMLDivElement | undefined
  let style: HTMLStyleElement | undefined
  let releaseStyle: (() => void) | undefined
  let cursor: { boot?: string; since?: number } = {}

  const close = (): void => {
    root?.unmount()
    host?.remove()
    style?.remove()
    releaseStyle?.()
    root = undefined
    host = undefined
    style = undefined
    releaseStyle = undefined
  }

  const show = async (detail: string, accountId: string): Promise<void> => {
    if (root !== undefined) return
    const account = await options.call({ op: 'account', id: accountId }).catch(() => undefined) as { name?: string; loginCommand?: string } | undefined
    if (stopped || root !== undefined) return
    releaseStyle = injectGitStyle()
    style = document.createElement('style')
    style.dataset.plugin = 'dsh-agent-hub'
    style.textContent = CSS
    document.head.appendChild(style)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<Prompt detail={detail} accountId={accountId} name={account?.name} command={account?.loginCommand} call={options.call} {...(options.openTerminal ? { openTerminal: () => { options.openTerminal!(); close() } } : {})} onClose={close} />)
  }

  const loop = async (): Promise<void> => {
    let failures = 0
    while (!stopped) {
      try {
        const state = await options.call({ op: 'wait', ...(cursor.boot ? { boot: cursor.boot, since: cursor.since } : {}) }) as AuthState
        failures = 0
        // A first answer, or one from a restarted host, only sets the cursor: old failures are not news.
        const fresh = cursor.boot === state.boot && cursor.since !== undefined && state.epoch > cursor.since
        cursor = { boot: state.boot, since: state.epoch }
        if (fresh && !stopped) void show(state.last?.detail ?? '', state.last?.account ?? 'default')
      } catch {
        failures++
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2000 * 2 ** failures)))
      }
    }
  }
  void loop()
  return () => {
    stopped = true
    close()
  }
}
