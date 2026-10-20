import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

export const ACCOUNTS_METHOD = 'agent-hub/claude-accounts'

export interface ClaudeAccount {
  id: string
  name: string
  renamed?: boolean
  account?: string
  signedIn?: boolean
  loginCommand?: string
}
export interface AccountsState { active: string; accounts: ClaudeAccount[] }
export interface AccountCheck { installed: boolean; signedIn: boolean; account?: string; detail?: string }
type Operation = { op: 'list' | 'add' | 'select' | 'rename' | 'remove' | 'check'; id?: string; name?: string }
export interface AccountApi { call(payload: Operation): Promise<AccountsState | AccountCheck>; openTerminal(): void }
interface Snapshot { state?: AccountsState; loading: boolean; busy: boolean; error?: string; newId?: string; loginCommand?: string; check?: { id: string; result: AccountCheck } }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Shared by the sidebar and settings, so a switch updates both immediately. */
export class AccountStore {
  private snapshot: Snapshot = { loading: false, busy: false }
  private listeners = new Set<() => void>()
  private generation = 0
  private pending?: Promise<void>
  constructor(readonly api: AccountApi, private readonly changed?: () => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): Snapshot => this.snapshot
  private set(next: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }
  load = (): Promise<void> => {
    if (this.snapshot.busy) return Promise.resolve()
    if (this.pending) return this.pending
    const token = ++this.generation
    this.set({ loading: true, error: undefined })
    const task = this.api.call({ op: 'list' }).then((result) => {
      if (token === this.generation) this.set({ state: result as AccountsState, error: undefined })
    }, (error: unknown) => { if (token === this.generation) this.set({ error: message(error) }) })
      .finally(() => { if (token === this.generation) this.set({ loading: false }); this.pending = undefined })
    this.pending = task
    return task
  }
  action = async (op: 'add' | 'select' | 'rename' | 'remove', id?: string, name?: string): Promise<boolean> => {
    if (this.snapshot.busy || !this.snapshot.state) return false
    const token = ++this.generation
    this.set({ busy: true, error: undefined, check: undefined })
    try {
      const previous = new Set(this.snapshot.state?.accounts.map((account) => account.id) ?? [])
      const state = await this.api.call({ op, ...(id ? { id } : {}), ...(name !== undefined ? { name } : {}) }) as AccountsState
      if (token !== this.generation) return false
      const newId = op === 'add' ? state.accounts.find((account) => !previous.has(account.id))?.id : undefined
      this.set({ state, newId: op === 'add' ? newId : op === 'remove' && id === this.snapshot.newId ? undefined : this.snapshot.newId,
        loginCommand: op === 'add' ? state.accounts.find((account) => account.id === newId)?.loginCommand : this.snapshot.loginCommand })
      this.changed?.()
      return true
    } catch (error) { if (token === this.generation) this.set({ error: message(error) }); return false }
    finally { if (token === this.generation) this.set({ busy: false }) }
  }
  check = async (id: string): Promise<void> => {
    if (this.snapshot.busy) return
    this.set({ busy: true, error: undefined, check: undefined })
    try {
      const result = await this.api.call({ op: 'check', id }) as AccountCheck
      const state = this.snapshot.state
      this.set({ check: { id, result }, state: state && {
        ...state, accounts: state.accounts.map((account) => account.id === id
          ? { ...account, signedIn: result.signedIn, ...(result.account ? { account: result.account } : {}) } : account),
      } })
    } catch (error) { this.set({ error: message(error) }) }
    finally { this.set({ busy: false }) }
  }
}

const en = (): boolean => document.documentElement.lang.toLowerCase().startsWith('en')
const labels = {
  en: { title: 'Claude accounts', active: 'Active', default: 'Default', add: 'Add account', name: 'Account name (optional)', switch: 'Switch', rename: 'Rename', save: 'Save', cancel: 'Cancel', renameHint: 'Leave empty to restore the default name', remove: 'Remove', check: 'Check login', signedIn: 'Signed in', signedOut: 'Not signed in', loading: 'Loading accounts…', retry: 'Retry', run: 'Run this command in a terminal, then complete Claude login:', copy: 'Copy command', copied: 'Copied', terminal: 'Open terminal', missing: 'Claude Code is not installed', detail: 'Login status', fallback: 'Use the existing Claude sign-in flow in a terminal: run claude, then /login.', missingCommand: 'No login command was provided for this account. Refresh or try again.', confirm: 'Remove this Claude account from the list? Claude files stay on disk.', next: 'Applies to the next turn; the current reply keeps its account.' },
  zh: { title: 'Claude 账号', active: '当前', default: '默认账号', add: '添加账号', name: '账号名称（选填）', switch: '切换', rename: '重命名', save: '保存', cancel: '取消', renameHint: '留空恢复默认名称', remove: '移除', check: '检测登录', signedIn: '已登录', signedOut: '未登录', loading: '加载账号中…', retry: '重试', run: '在终端运行此命令，然后完成 Claude 登录：', copy: '复制命令', copied: '已复制', terminal: '打开终端', missing: '未安装 Claude Code', detail: '登录状态', fallback: '在终端使用原有 Claude 登录流程：运行 claude，然后输入 /login。', missingCommand: '此账号没有提供登录命令。请刷新或重试。', confirm: '从列表移除此 Claude 账号？Claude 文件不会删除。', next: '切换后下一轮生效，当前回复不受影响。' },
}
const text = (key: keyof typeof labels.en): string => labels[en() ? 'en' : 'zh'][key]
/** The default account keeps its localized label until the user names it. */
export const accountName = (account: ClaudeAccount): string => account.id === 'default' && !account.renamed ? text('default') : account.name

/** A standalone control: never nested in the sidebar glance button. */
export function Accounts(props: { store: AccountStore }): ReactNode {
  const { store } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [name, setName] = useState('')
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState<{ id: string; draft: string }>()
  useEffect(() => { void store.load() }, [store])
  const accounts = snapshot.state?.accounts ?? []
  const recent = accounts.find((account) => account.id === snapshot.newId)
  const checked = accounts.find((account) => account.id === snapshot.check?.id)
  const command = recent?.loginCommand ?? snapshot.loginCommand
  const defaultLogin = !recent && (snapshot.check?.id === 'default' && !snapshot.check.result.signedIn
    || accounts.find((account) => account.id === 'default')?.signedIn === false)
  const copy = async (): Promise<void> => {
    if (!command) return
    try { await navigator.clipboard.writeText(command); setCopied(true) }
    catch (error) { /* Copy is optional; the selectable command remains visible. */ }
  }
  return <div className="ca-accounts" aria-busy={snapshot.loading || snapshot.busy}>
    <div className="ca-accounts-heading"><strong>{text('title')}</strong><button type="button" className="ah-btn ah-btn-sm" data-variant="quiet" disabled={snapshot.loading || snapshot.busy} onClick={() => void store.load()}>{text('retry')}</button></div>
    {snapshot.loading && !snapshot.state && <p role="status">{text('loading')}</p>}
    {snapshot.error && <p className="ca-account-error" role="alert">{snapshot.error}</p>}
    <div className="ca-account-list">
      {accounts.map((account) => editing?.id === account.id ? <form key={account.id} className="ca-account-item ca-account-rename"
        onSubmit={(event) => { event.preventDefault(); void store.action('rename', account.id, editing.draft.trim()).then((ok) => { if (ok) setEditing(undefined) }) }}>
        <input autoFocus value={editing.draft} maxLength={64} disabled={snapshot.busy} aria-label={text('rename')}
          placeholder={account.id === 'default' ? text('renameHint') : undefined}
          onChange={(event) => setEditing({ id: account.id, draft: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(undefined) } }} />
        <div className="ca-account-actions">
          <button type="submit" className="ah-btn ah-btn-sm" disabled={snapshot.busy || (account.id !== 'default' && !editing.draft.trim())}>{text('save')}</button>
          <button type="button" className="ah-btn ah-btn-sm" data-variant="quiet" onClick={() => setEditing(undefined)}>{text('cancel')}</button>
        </div>
      </form> : <div key={account.id} className="ca-account-item">
        <div className="ca-account-info"><span className="ca-account-name">{accountName(account)}</span>
          {snapshot.state?.active === account.id && <span className="ca-account-current">{text('active')}</span>}
          <span className="ca-account-sub">{account.account ?? (account.signedIn === true ? text('signedIn') : account.signedIn === false ? text('signedOut') : '')}</span>
        </div>
        <div className="ca-account-actions">
          {snapshot.state?.active !== account.id && <button type="button" className="ah-btn ah-btn-sm" disabled={snapshot.busy} onClick={() => void store.action('select', account.id)}>{text('switch')}</button>}
          <button type="button" className="ah-btn ah-btn-sm" disabled={snapshot.busy} onClick={() => setEditing({ id: account.id, draft: account.id === 'default' && !account.renamed ? '' : account.name })}>{text('rename')}</button>
          <button type="button" className="ah-btn ah-btn-sm" disabled={snapshot.busy} onClick={() => void store.check(account.id)}>{text('check')}</button>
          {account.id !== 'default' && <button type="button" className="ah-btn ah-btn-sm" disabled={snapshot.busy} onClick={() => { if (window.confirm(text('confirm'))) void store.action('remove', account.id) }}>{text('remove')}</button>}
        </div>
      </div>)}
    </div>
    <small className="ca-account-note">{text('next')}</small>
    {snapshot.check && <p className="ca-account-status" role="status">{text('detail')} ({checked ? accountName(checked) : snapshot.check.id}): {!snapshot.check.result.installed ? text('missing') : snapshot.check.result.signedIn ? `${text('signedIn')}${snapshot.check.result.account ? ` · ${snapshot.check.result.account}` : ''}` : `${text('signedOut')}${snapshot.check.result.detail ? ` · ${snapshot.check.result.detail}` : ''}`}</p>}
    {((recent && !(snapshot.check?.id === recent.id && snapshot.check.result.signedIn)) || defaultLogin) && <div className="ca-account-login" role="status"><span>{recent ? command ? text('run') : text('missingCommand') : text('fallback')}</span>
      {command && <><code className="ca-account-code">{command}</code><button type="button" className="ah-btn ah-btn-sm" onClick={() => void copy()}>{copied ? text('copied') : text('copy')}</button></>}
      <button type="button" className="ah-btn ah-btn-sm" onClick={store.api.openTerminal}>{text('terminal')}</button>
    </div>}
    <form className="ca-account-add" onSubmit={(event) => { event.preventDefault(); void store.action('add', undefined, name.trim()).then((ok) => { if (ok) setName('') }) }}>
      <input value={name} disabled={snapshot.busy} onChange={(event) => setName(event.target.value)} placeholder={text('name')} aria-label={text('name')} />
      <button type="submit" className="ah-btn ah-btn-sm" disabled={snapshot.busy || snapshot.loading || !snapshot.state}>{snapshot.busy ? '…' : `＋ ${text('add')}`}</button>
    </form>
  </div>
}

const CSS = `
.ca-accounts { min-width:0; display:grid; gap:10px; font-size:12px; color:inherit; }
.ca-accounts-heading,.ca-account-item,.ca-account-add { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
.ca-account-list { display:grid; gap:6px; }
.ca-account-item { padding:8px; border-radius:var(--ah-radius); background:color-mix(in srgb,currentColor 5%,transparent); flex-wrap:wrap; }
.ca-account-info { display:flex; flex:1 1 120px; align-items:center; gap:6px; min-width:0; flex-wrap:wrap; }
.ca-account-name,.ca-account-sub { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
.ca-account-name { font-weight:600; } .ca-account-sub { color:var(--ah-fg2); } .ca-account-current { color:var(--ah-ok-ink); }
.ca-account-actions { display:flex; gap:4px; flex-wrap:wrap; }
.ca-accounts input:focus-visible { outline:2px solid var(--ah-focus); outline-offset:1px; }
.ca-account-add { flex-wrap:wrap; justify-content:flex-start; }
.ca-account-add input,.ca-account-rename input { min-width:0; flex:1 1 130px; background:transparent; color:inherit; border:1px solid var(--ah-line-strong); border-radius:var(--ah-radius-sm); padding:6px 8px; font:inherit; }
.ca-account-login { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px; border-radius:var(--ah-radius); background:color-mix(in srgb,#d97757 12%,transparent); }
.ca-account-login > span { flex:1 0 100%; } .ca-account-code { min-width:0; flex:1 1 100%; overflow-wrap:anywhere; user-select:all; white-space:pre-wrap; }
.ca-account-note { color:var(--ah-fg2); line-height:1.45; } .ca-account-error { color:var(--ah-danger-ink); overflow-wrap:anywhere; } .ca-account-status { overflow-wrap:anywhere; }
@media (pointer:coarse) { .ca-account-add input,.ca-account-rename input { min-height:36px; } }
`
export function injectAccountStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub-accounts'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
