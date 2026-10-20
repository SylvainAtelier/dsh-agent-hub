/**
 * The canvases folder and the `@session` snapshots folder: listing, reading and removing the
 * files in them, by file name only; and saving a snapshot an external agent reads instead of
 * having it inline.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { findSource } from './source.ts'
import type { CanvasItem, CanvasKind, CanvasList, CanvasRequest, CanvasSource } from './types.ts'
import type { ReferenceSpill } from '../claude/translate.ts'

/** A canvas is read whole into the browser; larger files are refused. */
const MAX_BYTES = 16 * 1024 * 1024
/** How much of a file is searched for its title. */
const HEAD_BYTES = 16 * 1024
/** A page no log names yet may be named soon (Claude Agent's reply comes after its write): asked again after this. */
const UNKNOWN_TTL_MS = 30_000

/** A plain file name with this extension: no folders, nothing hidden. */
const plainName = (name: unknown, extension: RegExp): name is string =>
  typeof name === 'string' && extension.test(name) && !/[\\/\0]/.test(name) && !name.startsWith('.')

export const isCanvasName = (name: unknown): name is string => plainName(name, /\.html$/i)
const isReferenceName = (name: unknown): name is string => plainName(name, /\.md$/i)

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** A page's `<title>`, a snapshot's first `# ` heading. */
async function titleOf(path: string, kind: CanvasKind, fallback: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const head = buffer.toString('utf8', 0, bytesRead)
    const title = kind === 'canvas'
      ? /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]!).trim()
      : /^# (.+)$/m.exec(head)?.[1]?.trim()
    return title === undefined || title === '' ? fallback : title
  } finally {
    await handle.close()
  }
}

export interface SourceOptions {
  /** DSH's session log root (`<DSH_HOME>/sessions`). */
  sessions: string
  /** An archived session is not offered. */
  archived?(sessionId: string): boolean
}

export class Canvases implements ReferenceSpill {
  readonly dir: string
  /** Where oversized `@session` snapshots are saved (ReferenceSpill's `dir`). */
  readonly referenceDir: string
  private readonly sources: SourceOptions | undefined
  /** Per canvas, the answer for its mtime; an unknown one expires. */
  private readonly found = new Map<string, { mtime: number; at: number; source: Promise<CanvasSource | null> }>()

  constructor(dir: string, referenceDir: string, sources?: SourceOptions) {
    this.dir = dir
    this.referenceDir = referenceDir
    this.sources = sources
  }

  async list(): Promise<CanvasList> {
    const [items, references] = await Promise.all([this.files('canvas'), this.files('reference')])
    return { dir: this.dir, items, referenceDir: this.referenceDir, references }
  }

  private async files(kind: CanvasKind): Promise<CanvasItem[]> {
    const dir = kind === 'canvas' ? this.dir : this.referenceDir
    await mkdir(dir, { recursive: true })
    const names = (await readdir(dir)).filter(kind === 'canvas' ? isCanvasName : isReferenceName)
    const items = await Promise.all(names.map(async (name): Promise<CanvasItem | undefined> => {
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (!info.isFile()) return undefined
        return { kind, name, path, title: await titleOf(path, kind, name.replace(/\.(html|md)$/i, '')), size: info.size, mtime: info.mtimeMs }
      } catch {
        return undefined
      }
    }))
    return items.filter((item): item is CanvasItem => item !== undefined).sort((a, b) => b.mtime - a.mtime)
  }

  private file(name: unknown, kind: CanvasKind = 'canvas'): string {
    if (kind === 'reference') {
      if (!isReferenceName(name)) throw new Error('invalid snapshot name')
      return join(this.referenceDir, name)
    }
    if (!isCanvasName(name)) throw new Error('invalid canvas name')
    return join(this.dir, name)
  }

  async read(name: unknown, kind?: CanvasKind): Promise<string> {
    const path = this.file(name, kind)
    if ((await stat(path)).size > MAX_BYTES) throw new Error('canvas too large')
    return readFile(path, 'utf8')
  }

  /** Removes a file; a canvas takes the `.delivery.json` receipt Archify writes beside it along (prompt.ts). */
  async remove(name: unknown, kind?: CanvasKind): Promise<void> {
    const path = this.file(name, kind)
    await rm(path, { force: true })
    if (kind !== 'reference') await rm(path.replace(/\.html$/i, '.delivery.json'), { force: true })
  }

  /** The session that wrote a canvas, or null when no session log names it. */
  async source(name: unknown): Promise<CanvasSource | null> {
    const path = this.file(name)
    const options = this.sources
    if (options === undefined) return null
    const { mtimeMs } = await stat(path)
    const known = this.found.get(path)
    if (known !== undefined && known.mtime === mtimeMs) {
      const source = await known.source
      if (source !== null || Date.now() - known.at < UNKNOWN_TTL_MS) return source
    }
    const source = findSource(options.sessions, path, mtimeMs, options.archived).then((found) => found ?? null)
    this.found.set(path, { mtime: mtimeMs, at: Date.now(), source })
    source.catch(() => this.found.delete(path))
    return source
  }

  /**
   * Save a snapshot an external agent reads instead of having it inline; returns its path. Named
   * by its content, so the same snapshot handed over again (a later turn's history) is one file.
   * Synchronous: it runs while a turn's prompt is put together.
   */
  save(text: string, labels: readonly string[]): string {
    const path = join(this.referenceDir, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.md`)
    if (existsSync(path)) return path
    mkdirSync(this.referenceDir, { recursive: true })
    const heading = labels.length === 0 ? 'Referenced sessions' : labels.map((label) => `@${label}`).join(', ')
    writeFileSync(path, `# ${heading.replace(/\s+/g, ' ')}\n\n${text}\n`, { mode: 0o600 })
    return path
  }

  handle(request: CanvasRequest): Promise<unknown> {
    switch (request.op) {
      case 'list': return this.list()
      case 'read': return this.read(request.name, request.kind)
      case 'source': return this.source(request.name)
      case 'remove': return this.remove(request.name, request.kind).then(() => this.list())
      default: return Promise.reject(new Error('unknown canvas request'))
    }
  }
}
