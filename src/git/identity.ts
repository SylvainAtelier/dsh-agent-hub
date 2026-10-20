/**
 * Commit identities. Git's own configuration is the only record of who commits
 * where: a repository is bound by `user.name` / `user.email` (and optionally
 * `user.signingkey`) in its own `.git/config`, which every worktree shares and
 * every committer honours alike: a terminal, the pane's commit button, an
 * agent's shell, another editor. The plugin's settings only keep presets
 * (`git.identities`, synced with the profile) to bind a repository from.
 *
 * Shared by the host and the browser: no Node imports here.
 */

export interface Identity {
  name: string
  email: string
  /** `user.signingkey`; blank or absent signs with nothing of its own. */
  signingKey?: string
}

/**
 * Where the identity a commit would get comes from. `local` and `include`
 * (a global `includeIf` file) are deliberate bindings; `global` / `system`
 * are inherited defaults; `env` is GIT_AUTHOR_* / GIT_COMMITTER_* (or `-c`),
 * which outrank every configuration file.
 */
export type IdentitySource = 'local' | 'include' | 'global' | 'system' | 'env'

export interface EffectiveIdentity {
  name: string
  email: string
  source: IdentitySource
}

/** What the pane's identity picker offers. */
export interface IdentityList {
  /** `git.identities`, in the settings' order. */
  presets: Identity[]
  /** The global identity strict mode set aside, until it is a preset of its own. */
  stashed?: Identity
  /** The email other repositories of the same remote owner are bound to most. */
  usual?: string
}

export interface IdentitySettings {
  identities?: readonly Identity[]
  /** Refuse commits in repositories without an identity of their own (global `user.useConfigOnly`, no global identity). */
  strict?: boolean
}

/** Is this repository bound on purpose (not just inheriting a default)? */
export const bound = (identity: EffectiveIdentity | undefined): boolean =>
  identity !== undefined && (identity.source === 'local' || identity.source === 'include' || identity.source === 'env')

export const sameEmail = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

// What git itself accepts in an ident line: no angle brackets or line breaks.
export const validName = (value: string): boolean => value.trim() !== '' && value.length <= 200 && !/[<>\n\r\0]/.test(value)
export const validEmail = (value: string): boolean => /^[^\s<>@]+@[^\s<>@]+$/.test(value.trim()) && value.length <= 254
export const validKey = (value: string): boolean => value.trim() === '' || /^[^\s\0]{1,200}$/.test(value.trim())

/** A well-formed identity, trimmed; undefined when it is not one. */
export function identityOf(value: unknown): Identity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { name, email, signingKey } = value as Record<string, unknown>
  if (typeof name !== 'string' || typeof email !== 'string' || !validName(name) || !validEmail(email)) return undefined
  if (signingKey !== undefined && (typeof signingKey !== 'string' || !validKey(signingKey))) return undefined
  const key = typeof signingKey === 'string' ? signingKey.trim() : ''
  return { name: name.trim(), email: email.trim(), ...(key === '' ? {} : { signingKey: key }) }
}

/** Presets a save may store: each well-formed, one per email. */
export function identitiesValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const emails = value.map((item) => identityOf(item)?.email.toLowerCase())
  return emails.every((email) => email !== undefined) && new Set(emails).size === emails.length
}

const RANK: Record<IdentitySource, number> = { local: 0, include: 1, system: 2, global: 3, env: 4 }

/**
 * The identity a commit would get, from `git config --show-scope --show-origin -z --get-regexp
 * '^user\.(name|email)$'` (each record `scope NUL origin NUL key LF value NUL`; the last one wins)
 * and the process environment. `mainGlobal` tells the user's own global file from one it includes.
 * The weaker source of name and email is reported, so a half-bound identity reads as inherited.
 */
export function parseIdentity(raw: string, env: Readonly<Record<string, string | undefined>>, mainGlobal: (origin: string) => boolean): EffectiveIdentity | undefined {
  const found: Partial<Record<'name' | 'email', { value: string; source: IdentitySource }>> = {}
  const parts = raw.split('\0')
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i]!
    const origin = parts[i + 1]!
    const record = parts[i + 2]!
    const cut = record.indexOf('\n')
    const key = (cut < 0 ? record : record.slice(0, cut)).toLowerCase()
    const value = cut < 0 ? '' : record.slice(cut + 1)
    const field = key === 'user.name' ? 'name' : key === 'user.email' ? 'email' : undefined
    if (field === undefined) continue
    const source: IdentitySource = scope === 'local' || scope === 'worktree' ? 'local'
      : scope === 'global' ? (mainGlobal(origin) ? 'global' : 'include')
        : scope === 'system' ? 'system'
          : 'env'
    found[field] = { value, source }
  }
  const fromEnv = (keys: string[]): string | undefined => keys.map((key) => env[key]).find((value) => value !== undefined && value !== '')
  const envName = fromEnv(['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME'])
  const envEmail = fromEnv(['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'])
  const name = envName ?? found.name?.value ?? ''
  const email = envEmail ?? found.email?.value ?? ''
  if (name.trim() === '' || email.trim() === '') return undefined
  const sources: IdentitySource[] = [
    envName !== undefined ? 'env' : found.name!.source,
    envEmail !== undefined ? 'env' : found.email!.source,
  ]
  const source = sources.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
  return { name, email, source }
}

/** The email of a `git var GIT_AUTHOR_IDENT` line: `Name <email> 1700000000 +0000`. */
export function identEmail(line: string): string | undefined {
  return /<([^>]*)>/.exec(line)?.[1]
}

/** `host/owner` of a remote URL (scp-like, ssh://, https://), lowercased; undefined for a local path. */
export function remoteOwner(url: string): string | undefined {
  const text = url.trim()
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)\/?([^/\s]+)\//.exec(text)
  if (scp !== null && !/^[a-z]+:\/\//i.test(text)) return `${scp[1]}/${scp[2]}`.toLowerCase()
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\//i.exec(text)
  return full === null ? undefined : `${full[1]}/${full[2]}`.toLowerCase()
}
