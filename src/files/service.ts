/**
 * Host half of the code editor: read and write workspace files, the HEAD
 * version for change markers, workspace search, definitions, formatting.
 *
 * Every request names the session's working directory, which must sit inside
 * a registered workspace (the git module's gate), and every file it touches
 * must too, after symlinks are resolved: the browser can never read or write
 * outside the folders DSH was given.
 *
 * Agents edit the same files while a person reads them, so a write never
 * overwrites what it has not seen: it carries the hash of the text the edit
 * started from, and when the file on disk is no longer that text the write is
 * refused as a conflict, with what is on disk now. Writes keep the file's own
 * line endings and byte order mark, and run one at a time per file.
 *
 * The Files tree's menu pastes, renames and deletes entries. An entry is the
 * name itself (a symlink, not what it points to), and its folder must sit inside
 * a workspace, so a workspace root is never moved or deleted. Nothing is
 * overwritten: a paste takes a free name, a rename onto a taken one is refused.
 * It also creates empty files and folders, the folders on the way as needed.
 */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { within, type Gate } from '../git/service.ts'
import { looksBinary } from '../git/parse.ts'
import { exec as defaultExec, type Exec } from '../exec.ts'
import { format, FormatError } from './format.ts'
import { definitions, gitGrep, isWord, QueryError, relativeTo, ripgrep, type SearchQuery } from './search.ts'
import type { BaseText, Eol, FilesError, FilesReply, FilesRequest, FileText, Formatted, Location, Placed, SearchResult, Written } from './types.ts'

/** Largest file the editor opens; bigger ones stay with DSH's paged preview. */
export const FILE_LIMIT = 10 << 20

class Failure extends Error {
  readonly code: FilesError['code']
  readonly detail: Pick<FilesError, 'current' | 'deleted'>
  constructor(code: FilesError['code'], message: string, detail: Pick<FilesError, 'current' | 'deleted'> = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

const fail = (code: FilesError['code'], message: string, detail?: Pick<FilesError, 'current' | 'deleted'>): never => { throw new Failure(code, message, detail) }

const caseless = process.platform === 'win32' || process.platform === 'darwin'
const samePath = (a: string, b: string): boolean => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b)

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false
  throw error
})

/** `name copy.ext`, `name copy 2.ext`… the first free one in `folder` (`name.ext` itself when free). */
export async function freeName(folder: string, name: string): Promise<string> {
  if (!await exists(join(folder, name))) return name
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`
    if (!await exists(join(folder, candidate))) return candidate
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const utf8 = new TextDecoder('utf-8', { fatal: true })

export function hashOf(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex')
}

/** Windows files are mostly CRLF; a file with any lone LF keeps LF. */
export function eolOf(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  if (crlf === 0) return 'lf'
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf >= lf ? 'crlf' : 'lf'
}

/** Editor text (any line endings) → the bytes written for a file with these settings. */
export function encode(text: string, eol: Eol, bom: boolean): Buffer {
  const normal = text.replace(/\r\n?/g, '\n')
  const body = Buffer.from(eol === 'crlf' ? normal.replace(/\n/g, '\r\n') : normal, 'utf8')
  return bom ? Buffer.concat([BOM, body]) : body
}

/** Bytes → editor text, or why the editor cannot open them. */
export function decode(bytes: Buffer): { text: string; bom: boolean } {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) fail('not-utf8', 'UTF-16 text is not supported')
  if (looksBinary(bytes)) fail('binary', 'binary file')
  const bom = bytes.subarray(0, 3).equals(BOM)
  try {
    return { text: utf8.decode(bom ? bytes.subarray(3) : bytes), bom }
  } catch {
    return fail('not-utf8', 'the file is not UTF-8 text')
  }
}

/** A single file name: no separators, not `.` or `..`, nothing the file systems refuse. */
export function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && name.length <= 255 && !/[/\\\0]/.test(name)
    && !(process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)))
}

export interface FilesServiceOptions {
  exec?: Exec
  /** The ripgrep binary; undefined (or failing) falls back to git grep. */
  ripgrep?: () => Promise<string | undefined>
  /** This plugin's Prettier CLI, the formatter of last resort. */
  prettier?: () => string | undefined
}

export class FilesService {
  private readonly gate: Gate
  private readonly exec: Exec
  private readonly rg: () => Promise<string | undefined>
  private readonly prettier: () => string | undefined
  private readonly writes = new Map<string, Promise<unknown>>()

  constructor(gate: Gate, options: FilesServiceOptions = {}) {
    this.gate = gate
    this.exec = options.exec ?? defaultExec
    this.rg = options.ripgrep ?? (async () => undefined)
    this.prettier = options.prettier ?? (() => undefined)
  }

  async handle(payload: Record<string, unknown>, signal?: AbortSignal): Promise<FilesReply<unknown>> {
    try {
      const cwd = await this.gate(payload.cwd as string)
      if (cwd === undefined) return { ok: false, error: { code: 'denied', message: 'directory is not inside a workspace' } }
      const request = payload as unknown as FilesRequest
      switch (request.op) {
        case 'read': return { ok: true, value: await this.read(cwd, await this.file(cwd, request.path)) }
        case 'write': return { ok: true, value: await this.write(cwd, request) }
        case 'base': return { ok: true, value: await this.base(await this.file(cwd, request.path)) }
        case 'search': return { ok: true, value: await this.search(cwd, request, signal) }
        case 'definition': return { ok: true, value: await this.definition(cwd, request, signal) }
        case 'format': return { ok: true, value: await this.format(cwd, request) }
        case 'paste': return { ok: true, value: await this.paste(cwd, request) }
        case 'rename': return { ok: true, value: await this.rename(cwd, request) }
        case 'create': return { ok: true, value: await this.create(cwd, request) }
        case 'delete': await rm(await this.entry(cwd, request.path), { recursive: true }); return { ok: true, value: {} }
        default: return { ok: false, error: { code: 'invalid', message: 'unknown operation' } }
      }
    } catch (error) {
      if (error instanceof Failure) {
        return { ok: false, error: { code: error.code, message: error.message, ...error.detail } }
      }
      if (error instanceof QueryError) return { ok: false, error: { code: 'invalid', message: error.message } }
      if (error instanceof FormatError) return { ok: false, error: { code: error.code, message: error.message } }
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return { ok: false, error: { code: 'not-found', message: 'file not found' } }
      return { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /**
   * The absolute path a request names, admitted only inside a workspace. A missing file
   * is checked through its folder, so a write may recreate a file deleted meanwhile.
   */
  private async file(cwd: string, path: unknown): Promise<string> {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) fail('invalid', 'invalid path')
    const absolute = resolve(cwd, path as string)
    let real: string
    try {
      real = await realpath(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const folder = await this.gate(dirname(absolute))
      if (folder === undefined) fail('denied', 'the file is not inside a workspace')
      return resolve(folder!, basename(absolute))
    }
    if (await this.gate(real) === undefined) fail('denied', 'the file is not inside a workspace')
    return real
  }

  /** An existing entry the tree names, itself (not a symlink's target), in a folder inside a workspace; never the session folder or above it. */
  private async entry(cwd: string, path: unknown): Promise<string> {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) fail('invalid', 'invalid path')
    const absolute = resolve(cwd, path as string)
    const folder = await this.gate(dirname(absolute))
    if (folder === undefined || samePath(absolute, dirname(absolute))) fail('denied', 'the entry is not inside a workspace')
    const entry = join(folder!, basename(absolute))
    await lstat(entry)
    if (within(entry, cwd)) fail('denied', 'the session folder itself cannot be changed')
    return entry
  }

  private async paste(cwd: string, request: Extract<FilesRequest, { op: 'paste' }>): Promise<Placed> {
    const source = await this.entry(cwd, request.path)
    if (typeof request.into !== 'string' || request.into === '') fail('invalid', 'invalid folder')
    const folder = await this.gate(resolve(cwd, request.into))
    if (folder === undefined) fail('denied', 'the folder is not inside a workspace')
    if (!(await stat(folder!)).isDirectory()) fail('invalid', 'not a folder')
    if ((await lstat(source)).isDirectory() && within(source, folder!)) fail('invalid', 'a folder cannot go inside itself')
    // Cut and pasted where it already is: nothing to do.
    if (request.cut && samePath(dirname(source), folder!)) return { absolutePath: source }
    const target = join(folder!, await freeName(folder!, basename(source)))
    if (!request.cut) {
      await cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true })
    } else {
      await rename(source, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EXDEV') throw error
        // Another volume: copy, then remove the original.
        await cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true })
        await rm(source, { recursive: true })
      })
    }
    return { absolutePath: target }
  }

  private async rename(cwd: string, request: Extract<FilesRequest, { op: 'rename' }>): Promise<Placed> {
    const source = await this.entry(cwd, request.path)
    const name = typeof request.name === 'string' ? request.name.trim() : ''
    if (!validName(name)) fail('invalid', 'invalid name')
    const target = join(dirname(source), name)
    if (target === source) return { absolutePath: source }
    // Taken, unless by the entry itself (a change of case on a case-insensitive disk).
    if (await exists(target)) {
      const [a, b] = await Promise.all([lstat(source), lstat(target)])
      if (a.ino !== b.ino || a.dev !== b.dev) fail('conflict', `“${name}” already exists`)
    }
    await rename(source, target)
    return { absolutePath: target }
  }

  private async create(cwd: string, request: Extract<FilesRequest, { op: 'create' }>): Promise<Placed> {
    if (typeof request.into !== 'string' || request.into === '') fail('invalid', 'invalid folder')
    let folder = await this.gate(resolve(cwd, request.into))
    if (folder === undefined) fail('denied', 'the folder is not inside a workspace')
    if (!(await stat(folder!)).isDirectory()) fail('invalid', 'not a folder')
    const parts = typeof request.name === 'string' ? request.name.split('/').map((part) => part.trim()).filter((part) => part !== '') : []
    if (parts.length === 0 || !parts.every(validName)) fail('invalid', 'invalid name')
    for (const part of parts.slice(0, -1)) {
      const next = join(folder!, part)
      await mkdir(next).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      if (!(await stat(next)).isDirectory()) fail('conflict', `“${part}” is not a folder`)
      // Through a symlink, the next folder may be outside every workspace.
      folder = await this.gate(next)
      if (folder === undefined) fail('denied', 'the folder is not inside a workspace')
    }
    const name = parts.at(-1)!
    const target = join(folder!, name)
    try {
      if (request.kind === 'directory') await mkdir(target)
      else await writeFile(target, '', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('conflict', `“${name}” already exists`)
      throw error
    }
    return { absolutePath: target }
  }

  private async load(cwd: string, file: string): Promise<{ bytes: Buffer; text: FileText }> {
    const info = await stat(file)
    if (!info.isFile()) fail('not-file', 'not a regular file')
    if (info.size > FILE_LIMIT) fail('too-large', `the file is larger than ${FILE_LIMIT >> 20} MB`)
    const bytes = await readFile(file)
    const { text, bom } = decode(bytes)
    return { bytes, text: { absolutePath: file, path: relativeTo(cwd, file), text, hash: hashOf(bytes), eol: eolOf(text), bom, size: bytes.length } }
  }

  private async read(cwd: string, file: string): Promise<FileText> {
    return (await this.load(cwd, file)).text
  }

  private async write(cwd: string, request: Extract<FilesRequest, { op: 'write' }>): Promise<Written> {
    if (typeof request.text !== 'string') fail('invalid', 'invalid text')
    if (request.base !== null && typeof request.base !== 'string') fail('invalid', 'invalid base')
    const eol: Eol = request.eol === 'crlf' ? 'crlf' : 'lf'
    const bytes = encode(request.text, eol, request.bom === true)
    if (bytes.length > FILE_LIMIT) fail('too-large', `the file would be larger than ${FILE_LIMIT >> 20} MB`)
    const file = await this.file(cwd, request.path)
    return this.serial(file, async () => {
      let current: { bytes: Buffer; text: FileText } | undefined
      try {
        current = await this.load(cwd, file)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | Failure).code
        if (code === 'ENOENT') current = undefined
        else if (error instanceof Failure && (code === 'too-large' || code === 'binary' || code === 'not-utf8')) {
          // Replaced meanwhile by something the editor cannot show: still a conflict.
          fail('conflict', 'the file changed on disk')
        } else throw error
      }
      const onDisk = current === undefined ? null : current.text.hash
      if (onDisk !== request.base) fail('conflict', current === undefined ? 'the file was deleted' : 'the file changed on disk', current === undefined ? { deleted: true } : { current: current.text })
      if (current !== undefined && current.bytes.equals(bytes)) return { hash: current.text.hash, size: bytes.length }
      await writeFile(file, bytes)
      return { hash: hashOf(bytes), size: bytes.length }
    })
  }

  private serial<T>(key: string, body: () => Promise<T>): Promise<T> {
    const id = process.platform === 'win32' || process.platform === 'darwin' ? key.toLowerCase() : key
    const previous = this.writes.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(body)
    this.writes.set(id, next)
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id) }).catch(() => {})
    return next
  }

  /** The file as of HEAD; `''` for a file git does not track yet; nothing outside a repository or for an ignored file. */
  private async base(file: string): Promise<BaseText> {
    const dir = dirname(file)
    const name = basename(file)
    const git = (args: string[]) => this.exec('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: dir, timeoutMs: 15_000, maxBytes: FILE_LIMIT + 1, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    })
    const inside = await git(['rev-parse', '--is-inside-work-tree'])
    if (inside.missing || inside.code !== 0 || inside.stdout.trim() !== 'true') return {}
    const shown = await git(['show', `HEAD:./${name}`])
    if (shown.code === 0 && !shown.stopped) {
      const bytes = Buffer.from(shown.stdout, 'utf8')
      if (looksBinary(bytes)) return {}
      return { text: shown.stdout.replace(/^﻿/, '') }
    }
    const ignored = await git(['check-ignore', '-q', '--', name])
    return ignored.code === 0 ? {} : { text: '' }
  }

  private async engine(signal?: AbortSignal): Promise<(root: string, query: SearchQuery) => Promise<SearchResult>> {
    signal?.throwIfAborted()
    const rg = await this.rg().catch(() => undefined)
    signal?.throwIfAborted()
    if (rg !== undefined) return (root, query) => ripgrep(this.exec, rg, root, query, signal)
    return (root, query) => gitGrep(this.exec, root, query, false, signal)
  }

  private async search(cwd: string, request: Extract<FilesRequest, { op: 'search' }>, signal?: AbortSignal): Promise<SearchResult> {
    if (typeof request.query !== 'string' || request.query === '' || request.query.length > 1000) fail('invalid', 'invalid query')
    const search = await this.engine(signal)
    signal?.throwIfAborted()
    return search(cwd, {
      query: request.query,
      regex: request.regex === true,
      caseSensitive: request.caseSensitive === true,
      word: request.word === true,
      ...(typeof request.include === 'string' ? { include: request.include } : {}),
      ...(typeof request.exclude === 'string' ? { exclude: request.exclude } : {}),
      ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
    })
  }

  private async definition(cwd: string, request: Extract<FilesRequest, { op: 'definition' }>, signal?: AbortSignal): Promise<Location[]> {
    signal?.throwIfAborted()
    if (!isWord(request.word)) fail('invalid', 'not an identifier')
    const file = await this.file(cwd, request.path)
    signal?.throwIfAborted()
    const search = await this.engine(signal)
    signal?.throwIfAborted()
    return definitions((query, globs) => search(cwd, { ...query, ...(globs.length > 0 ? { include: globs.join(',') } : {}) }), relativeTo(cwd, file), request.word, signal)
  }

  private async format(cwd: string, request: Extract<FilesRequest, { op: 'format' }>): Promise<Formatted> {
    if (typeof request.text !== 'string' || request.text.length > FILE_LIMIT) fail('invalid', 'invalid text')
    const file = await this.file(cwd, request.path)
    if (!isAbsolute(file)) fail('invalid', 'invalid path')
    return format(this.exec, { file, text: request.text, root: cwd }, this.prettier())
  }
}
