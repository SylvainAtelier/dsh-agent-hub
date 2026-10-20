/** Claude Code owns every credential. This registry stores only display names and CLI configuration-directory ids. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { localized } from '../locale.ts'
import { jsonWriter } from '../persistence.ts'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const ACCOUNTS_METHOD = 'agent-hub/claude-accounts'
export const DEFAULT_ACCOUNT = 'default'
/** The default account's name until the user renames it. */
export const DEFAULT_NAME = { zh: '默认账号', en: 'Default account' }
/** `renamed` marks a default account whose name the user chose, so clients stop localizing it. */
export interface ClaudeAccount { id: string; name: string; renamed?: boolean; account?: string; signedIn?: boolean; loginCommand?: string }
export interface AccountList { active: string; accounts: ClaudeAccount[] }
interface Saved { active: string; defaultName?: string; accounts: Array<{ id: string; name: string; account?: string }> }

export class ClaudeAccounts {
  private active = DEFAULT_ACCOUNT
  private accounts: Saved['accounts'] = []
  private defaultName?: string
  readonly ready: Promise<void>
  private readonly file: string
  private readonly write: (value: Saved) => Promise<void>
  constructor(file: string) {
    this.file = file
    this.write = jsonWriter(file)
    this.ready = readFile(file, 'utf8').then((text) => {
      const saved = JSON.parse(text) as Saved
      if (!Array.isArray(saved.accounts)) return
      this.accounts = saved.accounts.filter((item) => typeof item.id === 'string' && /^[0-9a-f-]{36}$/.test(item.id) && typeof item.name === 'string')
      if (typeof saved.defaultName === 'string' && saved.defaultName.trim()) this.defaultName = saved.defaultName
      if (saved.active === DEFAULT_ACCOUNT || this.accounts.some((item) => item.id === saved.active)) this.active = saved.active
    }).catch(() => {})
  }
  get selected(): string { return this.active }
  has(id: string): boolean { return id === DEFAULT_ACCOUNT || this.accounts.some((item) => item.id === id) }
  /** No user-supplied paths can reach the SDK. */
  dir(id: string): string | undefined {
    if (id === DEFAULT_ACCOUNT) return undefined
    if (!this.has(id)) throw new Error('Unknown Claude account')
    return join(dirname(this.file), 'claude-accounts', id)
  }
  list(): AccountList {
    const present = [{ id: DEFAULT_ACCOUNT, name: this.defaultName ?? localized(DEFAULT_NAME), ...(this.defaultName ? { renamed: true } : {}) }, ...this.accounts]
    return { active: this.active, accounts: present.map((item) => ({ ...item, ...(this.dir(item.id) ? { loginCommand: this.loginCommand(item.id) } : { loginCommand: 'claude' }) })) }
  }
  private loginCommand(id: string): string {
    const dir = this.dir(id)
    if (!dir) return 'claude'
    return process.platform === 'win32'
      ? `$env:CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "''")}'; claude`
      : `CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "'\\''")}' claude`
  }
  private save(): Promise<void> {
    return this.write({ active: this.active, ...(this.defaultName ? { defaultName: this.defaultName } : {}), accounts: this.accounts.map((item) => ({ ...item })) })
  }
  async add(name: string): Promise<AccountList> {
    await this.ready
    const label = this.validName(name.trim() || localized({ zh: `账号 ${this.accounts.length + 2}`, en: `Account ${this.accounts.length + 2}` }))
    const id = randomUUID()
    await mkdir(join(dirname(this.file), 'claude-accounts', id), { recursive: true, mode: 0o700 })
    this.accounts.push({ id, name: label })
    await this.save()
    return this.list()
  }
  /** Display name only; the id and CLI directory never change. An empty default name restores the localized label. */
  async rename(id: string, name: string): Promise<AccountList> {
    await this.ready
    if (!this.has(id)) throw new Error('Unknown Claude account')
    const label = name.trim()
    if (id === DEFAULT_ACCOUNT) this.defaultName = label ? this.validName(label, id) : undefined
    else {
      const entry = this.accounts.find((item) => item.id === id)!
      entry.name = this.validName(label, id)
    }
    await this.save()
    return this.list()
  }
  private validName(label: string, self?: string): string {
    if (!label || label.length > 64 || /[\r\n]/.test(label)) throw new Error('Account name must be 1–64 characters')
    if (this.list().accounts.some((item) => item.id !== self && item.name === label)) throw new Error('Account name already exists')
    return label
  }
  async select(id: string): Promise<AccountList> {
    await this.ready
    if (!this.has(id)) throw new Error('Unknown Claude account')
    this.active = id
    await this.save()
    return this.list()
  }
  async remove(id: string): Promise<AccountList> {
    await this.ready
    if (id === DEFAULT_ACCOUNT || !this.has(id)) throw new Error('Cannot remove this account')
    this.accounts = this.accounts.filter((item) => item.id !== id)
    if (this.active === id) this.active = DEFAULT_ACCOUNT
    // Do not delete Claude's settings, transcripts, or credentials; unlink only.
    await this.save()
    return this.list()
  }
  async record(id: string, email: string | undefined): Promise<void> {
    await this.ready
    const entry = this.accounts.find((item) => item.id === id)
    if (entry && email && entry.account !== email) { entry.account = email; await this.save() }
  }
}
