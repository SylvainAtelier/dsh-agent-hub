/**
 * Cursor's local commands and skills, offered as DSH skills: typing `/` in any
 * session lists them, whichever model answers.
 *
 * Cursor keeps them in `.cursor/` folders, the project's (nearest `.git`
 * ancestor of the session's folder) and the user's (`~/.cursor`):
 * - `commands/<name>.md`: a plain Markdown prompt, frontmatter optional. A
 *   command runs when the user types it, so the model is not offered it.
 * - `skills/<name>/SKILL.md` (or `skills/<name>.md`): DSH's own skill format,
 *   frontmatter `name` and `description`, `disable-model-invocation` and
 *   `user-invocable` honoured.
 * Cursor's own built-in skills (`~/.cursor/skills-cursor`) drive Cursor's
 * editor and are left out.
 *
 * DSH's skill registry caches each folder's catalog until its provider
 * invalidates it, so every scanned root is watched; a root that does not exist
 * yet is polled until it appears.
 */

import { watch, watchFile, unwatchFile, type FSWatcher } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

export const CURSOR_SKILL_PROVIDER = 'cursor'
/** After DSH's project roots (`.dsh` 100, `.agents` 200), so a same-named DSH skill wins. */
export const PROJECT_RANK = 210
/** After DSH's user roots (`~/.dsh` 400, `~/.agents` 500), before bundled skills (600). */
export const USER_RANK = 550
/** Projects whose `.cursor` folders stay watched; the least recently listed is dropped first. */
const MAX_PROJECTS = 16
const POLL_MS = 2000
const DESCRIPTION_MAX = 200
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type Kind = 'skills' | 'commands'

interface Root {
  path: string
  kind: Kind
  source: string
  rank: number
}

interface Invocation {
  modelInvocable: boolean
  userInvocable: boolean
}

/** What the registry lists; `file` and `kind` are this provider's own locator. */
export interface Candidate {
  name: string
  description: string
  invocation: Invocation
  provider: string
  source: string
  rank: number
  path: string
  resourceBase: { kind: 'directory'; path: string }
  file: string
  kind: Kind
}

export interface Definition extends Omit<Candidate, 'file' | 'kind' | 'rank'> {
  content: string
}

/** DSH's skill registry (`ctx.skills`), as far as a provider registers with it. */
export interface SkillRegistry {
  registerProvider(create: (control: { signal: AbortSignal; invalidate(): void }) => CursorSkills): () => void
}

/** A skill or command name in DSH's grammar: lower-case kebab-case. */
export function slug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function frontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (match === null) return { data: {}, body: raw }
  let data: unknown
  try {
    data = parse(match[1])
  } catch {
    data = undefined
  }
  const record = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : {}
  return { data: record, body: raw.slice(match[0].length) }
}

function flag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}

/** The body's first line of text, without Markdown heading or list marks. */
function firstLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, '').trim()
    if (text !== '') return text
  }
  return undefined
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX - 1)}…` : flat
}

/**
 * One file read as a skill. Its name is the frontmatter `name` when that is
 * valid, else the file's (a bundle's folder) name; a command with no
 * description is described by its first line.
 */
export function readEntry(raw: string, file: string, kind: Kind): { name: string; description: string; invocation: Invocation; content: string } | undefined {
  const { data, body } = frontmatter(raw)
  const own = typeof data.name === 'string' && SKILL_NAME.test(data.name) ? data.name : undefined
  const fallback = basename(file) === 'SKILL.md' ? basename(dirname(file)) : basename(file).replace(/\.md$/i, '')
  const name = own ?? slug(fallback)
  if (name === '') return undefined
  const described = typeof data.description === 'string' ? data.description : undefined
  const description = clip(described ?? firstLine(body) ?? `Cursor ${kind === 'commands' ? 'command' : 'skill'} ${name}`)
  if (description === '') return undefined
  const invocation = kind === 'commands'
    ? { modelInvocable: false, userInvocable: flag(data['user-invocable']) ?? true }
    : { modelInvocable: !(flag(data['disable-model-invocation']) ?? false), userInvocable: flag(data['user-invocable']) ?? true }
  return { name, description, invocation, content: body }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The nearest ancestor holding `.git`, else the folder itself. */
export async function projectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** The roots scanned for a session's folder: the project's first, then the user's. */
export async function cursorRoots(cwd: string | undefined, home = homedir()): Promise<Root[]> {
  const user = join(home, '.cursor')
  const roots: Root[] = []
  if (cwd !== undefined && cwd !== '') {
    const project = join(await projectRoot(cwd), '.cursor')
    if (project !== user) {
      roots.push({ path: join(project, 'skills'), kind: 'skills', source: 'project-cursor', rank: PROJECT_RANK })
      roots.push({ path: join(project, 'commands'), kind: 'commands', source: 'project-cursor', rank: PROJECT_RANK })
    }
  }
  roots.push({ path: join(user, 'skills'), kind: 'skills', source: 'user-cursor', rank: USER_RANK })
  roots.push({ path: join(user, 'commands'), kind: 'commands', source: 'user-cursor', rank: USER_RANK })
  return roots
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** One root's entries, sorted; a missing root is empty. */
async function scanRoot(root: Root): Promise<Candidate[]> {
  let names: string[]
  try {
    names = (await readdir(root.path)).sort()
  } catch {
    return []
  }
  const found: Candidate[] = []
  for (const entry of names) {
    if (entry.startsWith('.')) continue
    const full = join(root.path, entry)
    const bundle = root.kind === 'skills' && await isDirectory(full)
    const file = bundle ? join(full, 'SKILL.md') : full
    if (!bundle && !/\.md$/i.test(entry)) continue
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const read = readEntry(raw, file, root.kind)
    if (read === undefined) continue
    found.push({
      name: read.name,
      description: read.description,
      invocation: read.invocation,
      provider: CURSOR_SKILL_PROVIDER,
      source: root.source,
      rank: root.rank,
      path: file,
      resourceBase: { kind: 'directory', path: bundle ? full : root.path },
      file,
      kind: root.kind,
    })
  }
  return found
}

/**
 * Whether a change under a root can change its catalog: an entry added or
 * removed at the top, or a bundle's `SKILL.md`; a bundle's resources cannot.
 */
export function catalogChange(kind: Kind, relative: string | null): boolean {
  if (relative === null) return true
  const parts = relative.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return true
  return kind === 'skills' && parts.length === 2 && parts[1] === 'SKILL.md'
}

/** One watched root: a watcher while it exists, a poll while it does not. */
class RootWatch {
  private watcher: FSWatcher | undefined
  private polling = false
  private closed = false
  private readonly root: Root
  private readonly changed: () => void

  constructor(root: Root, changed: () => void) {
    this.root = root
    this.changed = changed
    void this.attach()
  }

  private async attach(): Promise<void> {
    if (this.closed) return
    if (!(await isDirectory(this.root.path))) return this.poll()
    if (this.closed) return
    try {
      // Bundles' SKILL.md sit one level down; commands are flat.
      this.watcher = watch(this.root.path, { recursive: this.root.kind === 'skills', persistent: false }, (_event, name) => {
        if (catalogChange(this.root.kind, typeof name === 'string' ? name : null)) this.changed()
      })
      this.watcher.on('error', () => this.detach())
    } catch {
      this.poll()
    }
  }

  /** The root went away (or could not be watched): drop the watcher and wait for it to come back. */
  private detach(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.changed()
    this.poll()
  }

  private poll(): void {
    if (this.closed || this.polling) return
    this.polling = true
    watchFile(this.root.path, { interval: POLL_MS, persistent: false }, (current) => {
      if (current.mtimeMs === 0 && current.nlink === 0) return
      unwatchFile(this.root.path)
      this.polling = false
      this.changed()
      void this.attach()
    })
  }

  close(): void {
    this.closed = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.polling) unwatchFile(this.root.path)
    this.polling = false
  }
}

/** DSH skill provider over Cursor's command and skill folders. */
export class CursorSkills {
  readonly name = CURSOR_SKILL_PROVIDER
  private readonly watches = new Map<string, RootWatch>()
  /** Project roots in least-recently-listed order, each with the paths it watches. */
  private readonly projects = new Map<string, string[]>()
  private pending = false
  private readonly control: { signal: AbortSignal; invalidate(): void }
  private readonly home: string

  constructor(control: { signal: AbortSignal; invalidate(): void }, home = homedir()) {
    this.control = control
    this.home = home
    control.signal.addEventListener('abort', () => this.dispose(), { once: true })
  }

  async list(options: { cwd?: string }): Promise<Candidate[]> {
    const roots = await cursorRoots(options.cwd, this.home)
    this.observe(roots)
    const candidates: Candidate[] = []
    for (const root of roots) candidates.push(...await scanRoot(root))
    return candidates
  }

  /** The candidate's file read again, so an edit since listing shows. */
  async get(candidate: Candidate): Promise<Definition | undefined> {
    let raw: string
    try {
      raw = await readFile(candidate.file, 'utf8')
    } catch {
      return undefined
    }
    const read = readEntry(raw, candidate.file, candidate.kind)
    if (read === undefined) return undefined
    return {
      name: read.name,
      description: read.description,
      invocation: read.invocation,
      provider: this.name,
      source: candidate.source,
      path: candidate.file,
      resourceBase: candidate.resourceBase,
      content: read.content,
    }
  }

  private observe(roots: Root[]): void {
    if (this.control.signal.aborted) return
    for (const root of roots) {
      if (this.watches.has(root.path)) continue
      this.watches.set(root.path, new RootWatch(root, () => this.changed()))
    }
    const project = roots.filter((root) => root.source === 'project-cursor')
    if (project.length === 0) return
    const key = dirname(project[0].path)
    this.projects.delete(key)
    this.projects.set(key, project.map((root) => root.path))
    while (this.projects.size > MAX_PROJECTS) {
      const [oldest, paths] = this.projects.entries().next().value as [string, string[]]
      this.projects.delete(oldest)
      for (const path of paths) {
        this.watches.get(path)?.close()
        this.watches.delete(path)
      }
    }
  }

  /** One invalidation per burst of file events. */
  private changed(): void {
    if (this.pending || this.control.signal.aborted) return
    this.pending = true
    setTimeout(() => {
      this.pending = false
      if (!this.control.signal.aborted) this.control.invalidate()
    }, 100).unref?.()
  }

  dispose(): void {
    for (const entry of this.watches.values()) entry.close()
    this.watches.clear()
    this.projects.clear()
  }
}
