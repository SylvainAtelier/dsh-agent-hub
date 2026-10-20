/**
 * Workspace search and search-based code navigation, the way VS Code searches:
 * ripgrep (`@vscode/ripgrep`, the binary VS Code and DSH's own grep tool ship),
 * honouring .gitignore, hidden files included, `.git` excluded. Without it,
 * `git grep` over tracked and untracked files stands in.
 *
 * Definitions are found by search, not by a language server: the identifier
 * under the caret, matched against each language's declaration shapes
 * (`function X`, `class X`, `def X`, `fn X`, `X = …`). Every language works
 * and nothing is indexed; a name declared twice gives two candidates, which
 * the editor lets the person choose between. Results are ranked by nearness
 * to the file asking: the same file, then the same folder, then the shortest
 * path between them.
 */

import { extname, isAbsolute, relative, sep } from 'node:path'
import type { Exec } from '../exec.ts'
import type { Location, SearchFile, SearchMatch, SearchResult } from './types.ts'

export interface SearchQuery {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  word?: boolean
  include?: string
  exclude?: string
  limit?: number
}

/** Thrown for a query the engine rejects (an invalid regular expression). */
export class QueryError extends Error {}

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 10_000
const PREVIEW = 240
const TIMEOUT_MS = 20_000

/** `/`-separated, relative to the search root. */
function cleanPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Comma-separated globs, as VS Code's include/exclude boxes take them. */
function globs(list: string | undefined): string[] {
  return (list ?? '').split(',').map((glob) => glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean)
}

/** The line around its first match, at most PREVIEW characters, with match ranges shifted to it. */
export function preview(line: string, ranges: Array<[number, number]>): { preview: string; ranges: Array<[number, number]> } {
  const text = line.replace(/\s+$/, '')
  const first = ranges[0]?.[0] ?? 0
  let start = 0
  if (text.length > PREVIEW && first > 40) start = Math.min(first - 40, text.length - PREVIEW)
  // Leading indentation carries nothing in a result row.
  if (start === 0) start = Math.min(text.length - text.trimStart().length, first)
  const end = Math.min(text.length, start + PREVIEW)
  return {
    preview: text.slice(start, end),
    ranges: ranges.filter(([a]) => a < end).map(([a, b]) => [Math.max(0, a - start), Math.min(end, b) - start]),
  }
}

interface RgMatch {
  type: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: Array<{ start: number; end: number }>
  }
}

/** UTF-8 byte offsets into a line → UTF-16 offsets. */
function utf16(line: string, offsets: number[]): number[] {
  if (!/[^\x00-\x7f]/.test(line)) return offsets
  const bytes = Buffer.from(line, 'utf8')
  return offsets.map((offset) => bytes.subarray(0, offset).toString('utf8').length)
}

function collect(files: Map<string, SearchFile>, path: string, match: SearchMatch): void {
  let file = files.get(path)
  if (file === undefined) {
    file = { path, matches: [] }
    files.set(path, file)
  }
  file.matches.push(match)
}

export async function ripgrep(exec: Exec, rg: string, root: string, query: SearchQuery, signal?: AbortSignal): Promise<SearchResult> {
  signal?.throwIfAborted()
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT))
  const args = ['--json', '--no-config', '--hidden', '--max-columns', '2000', '--max-filesize', '4M', '-g', '!.git']
  args.push(query.caseSensitive ? '-s' : '-i')
  if (query.word) args.push('-w')
  if (!query.regex) args.push('-F')
  for (const glob of globs(query.include)) args.push('-g', glob)
  for (const glob of globs(query.exclude)) args.push('-g', `!${glob}`)
  args.push('-e', query.query, '--', '.')
  const files = new Map<string, SearchFile>()
  let count = 0
  const result = await exec(rg, args, {
    cwd: root,
    signal,
    timeoutMs: TIMEOUT_MS,
    maxBytes: 256 << 20,
    onLine: (line) => {
      if (!line.startsWith('{"type":"match"')) return
      let event: RgMatch
      try {
        event = JSON.parse(line) as RgMatch
      } catch {
        return
      }
      const data = event.data
      const path = data?.path?.text
      const text = data?.lines?.text
      if (path === undefined || text === undefined || data?.line_number === undefined) return
      const body = text.replace(/\r?\n$/, '')
      const bounds = utf16(body, (data.submatches ?? []).flatMap((sub) => [sub.start, sub.end]))
      const ranges: Array<[number, number]> = []
      for (let i = 0; i + 1 < bounds.length; i += 2) ranges.push([bounds[i]!, bounds[i + 1]!])
      collect(files, cleanPath(path), { line: data.line_number, column: (ranges[0]?.[0] ?? 0) + 1, ...preview(body, ranges) })
      return ++count < limit
    },
  })
  signal?.throwIfAborted()
  if (result.missing) throw new Error('ripgrep is not installed')
  // 1: nothing matched. 2: an error — a bad pattern, or an unreadable file among good results.
  if (result.code === 2 && count === 0 && !result.timedOut) {
    throw new QueryError(result.stderr.split('\n').find((line) => line.trim() !== '')?.replace(/^rg: /, '') ?? 'search failed')
  }
  return { files: [...files.values()], count, truncated: result.stopped || result.timedOut }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The JS equivalent of a query, for match ranges where the engine gives only a column. */
export function queryRegExp(query: SearchQuery): RegExp | undefined {
  const body = query.regex ? query.query : escapeRegExp(query.query)
  try {
    return new RegExp(query.word ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, `gu${query.caseSensitive ? '' : 'i'}`)
  } catch {
    return undefined
  }
}

function rangesIn(line: string, pattern: RegExp | undefined, column: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  if (pattern !== undefined) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(line); match !== null && ranges.length < 50; match = pattern.exec(line)) {
      if (match[0] === '') {
        pattern.lastIndex++
        continue
      }
      ranges.push([match.index, match.index + match[0].length])
    }
  }
  if (ranges.length === 0) ranges.push([Math.max(0, column - 1), Math.max(0, column - 1)])
  return ranges
}

/** `git grep` over tracked and untracked (not ignored) files: the stand-in when ripgrep is unavailable. */
export async function gitGrep(exec: Exec, root: string, query: SearchQuery, perl = false, signal?: AbortSignal): Promise<SearchResult> {
  signal?.throwIfAborted()
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT))
  const args = ['-c', 'core.quotepath=false', 'grep', '-n', '--column', '-z', '-I', '--untracked', '--exclude-standard', '--no-color']
  if (!query.caseSensitive) args.push('-i')
  if (query.word) args.push('-w')
  args.push(query.regex ? (perl ? '-P' : '-E') : '-F', '-e', query.query, '--')
  const include = globs(query.include)
  for (const glob of include) args.push(`:(glob)**/${glob}`, `:(glob)**/${glob}/**`)
  if (include.length === 0) args.push('.')
  for (const glob of globs(query.exclude)) args.push(`:(exclude,glob)**/${glob}`, `:(exclude,glob)**/${glob}/**`)
  const pattern = queryRegExp(query)
  const files = new Map<string, SearchFile>()
  let count = 0
  const result = await exec('git', args, {
    cwd: root,
    signal,
    timeoutMs: TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    onLine: (line) => {
      const [path, lineNumber, column, ...rest] = line.split('\0')
      if (path === undefined || lineNumber === undefined || column === undefined) return
      const body = rest.join('\0')
      collect(files, cleanPath(path), { line: Number(lineNumber), column: Number(column), ...preview(body, rangesIn(body, pattern, Number(column))) })
      return ++count < limit
    },
  })
  signal?.throwIfAborted()
  if (result.missing) throw new Error('git is not installed')
  if (result.code !== 0 && result.code !== 1 && count === 0 && !result.timedOut && !result.stopped) {
    throw new QueryError(result.stderr.split('\n').find((line) => line.trim() !== '')?.replace(/^fatal: /, '') ?? 'search failed')
  }
  return { files: [...files.values()], count, truncated: result.stopped || result.timedOut }
}

/** An identifier the editor may ask about: letters, digits, `_`, `$`, and `-` (CSS). */
const WORD = /^[\p{L}\p{N}_$][\p{L}\p{N}_$-]{0,127}$/u

export function isWord(word: unknown): word is string {
  return typeof word === 'string' && WORD.test(word)
}

/** Declaration shapes per language family; `W` is the escaped name, `E` the end of a name. */
interface Family {
  globs: string[]
  shapes: string[]
}

const E = '(?:[^\\w$]|$)'
const KEYWORDS = '\\b(?:function|class|def|fn|func|struct|interface|type|enum|trait|const|let|var|val|module|namespace|object|protocol)\\s+W' + E

const FAMILIES: Record<string, Family> = {
  js: {
    globs: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro'],
    shapes: [
      '\\b(?:function\\*?|class|interface|type|enum|namespace|module)\\s+W' + E,
      '\\b(?:const|let|var)\\s+W' + E,
      '^\\s*(?:(?:export|public|private|protected|static|readonly|async|override|abstract|declare|get|set)\\s+)*\\*?#?W\\s*(?:<.*>)?\\(.*\\)\\s*(?::.*)?\\{\\s*$',
      '^\\s*(?:(?:public|private|protected|static|readonly|declare|override|abstract)\\s+)*#?W\\s*[?!]?\\s*[:=][^=]',
    ],
  },
  py: {
    globs: ['py', 'pyi'],
    shapes: ['\\b(?:def|class)\\s+W' + E, '^\\s*W\\s*(?::[^=]*)?=[^=]'],
  },
  go: {
    globs: ['go'],
    shapes: [
      '\\bfunc\\s+(?:\\([^)]*\\)\\s*)?W' + E,
      '\\b(?:type|var|const)\\s+W' + E,
      '^\\s*W\\s+[\\w*.\\[\\]]+(?:\\s+`.*`)?\\s*$',
      '^\\s*W(?:\\s*,\\s*\\w+)*\\s*(?:[\\w*.\\[\\]]+\\s*)?=[^=]',
    ],
  },
  rs: {
    globs: ['rs'],
    shapes: [
      '\\b(?:fn|struct|enum|trait|type|mod|const|static|union)\\s+W' + E,
      'macro_rules!\\s*W' + E,
      '\\blet\\s+(?:mut\\s+)?W' + E,
      '^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?W\\s*:[^:]',
    ],
  },
  c: {
    globs: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm', 'java', 'kt', 'kts', 'cs', 'swift', 'scala', 'dart', 'groovy'],
    shapes: [
      '\\b(?:class|struct|union|enum|interface|record|trait|object|protocol|extension|typedef|namespace|typealias|fun|func|def|val|var|let)\\s+W' + E,
      '#\\s*define\\s+W' + E,
      '^[\\w\\s:*&<>,\\[\\]~@]*[\\w>*&\\]]\\s+[*&]*W\\s*\\([^;]*$',
    ],
  },
  php: {
    globs: ['php'],
    shapes: ['\\b(?:function|class|interface|trait|enum|const)\\s+W' + E, '\\$W\\s*=[^=]'],
  },
  rb: {
    globs: ['rb', 'rake', 'gemspec'],
    shapes: ['\\b(?:def|class|module)\\s+(?:self\\.)?W' + E, '^\\s*W\\s*=[^=]'],
  },
  sh: {
    globs: ['sh', 'bash', 'zsh'],
    shapes: ['^\\s*(?:function\\s+)?W\\s*\\(\\)', '^\\s*function\\s+W' + E, '^\\s*(?:export\\s+|local\\s+|readonly\\s+|declare\\s+)?W='],
  },
  lua: {
    globs: ['lua'],
    shapes: ['\\bfunction\\s+(?:[\\w.:]+[.:])?W' + E, '\\blocal\\s+W' + E, '^\\s*(?:[\\w.]+\\.)?W\\s*=[^=]'],
  },
  css: {
    globs: ['css', 'scss', 'sass', 'less'],
    shapes: ['^\\s*--W\\s*:', '^\\s*[$@]W\\s*:', '@mixin\\s+W' + E, '^[^{]*[.#]W(?:[^\\w-]|$)[^{]*\\{?\\s*$'],
  },
}

const FAMILY_OF = new Map<string, string>()
for (const [name, family] of Object.entries(FAMILIES)) for (const ext of family.globs) FAMILY_OF.set(ext, name)

export function familyOf(path: string): Family | undefined {
  const name = FAMILY_OF.get(extname(path).slice(1).toLowerCase())
  return name === undefined ? undefined : FAMILIES[name]
}

/** How far apart two workspace paths are: 0 the same file, 1 the same folder, then folder steps between them. */
export function distance(from: string, to: string): number {
  if (from === to) return 0
  const a = from.split('/').slice(0, -1)
  const b = to.split('/').slice(0, -1)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return 1 + (a.length - common) + (b.length - common)
}

/** Text before a name that makes it a use (`x = W(…)`, `return W(…)`), not its declaration. */
const USE = /(?:[=(,]|\b(?:return|new|await|yield|throw|else|case|in|of|typeof|delete|void|extends|implements))\s*$/

const TESTISH = /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?)\/|\.(test|spec)\.\w+$/

/**
 * The places `word` is declared, nearest first. `path` is the asking file, relative to `root`.
 * `search` runs one regular-expression search over the given globs.
 */
export async function definitions(
  search: (query: SearchQuery, globs: string[]) => Promise<SearchResult>,
  path: string,
  word: string,
  signal?: AbortSignal,
): Promise<Location[]> {
  signal?.throwIfAborted()
  const family = familyOf(path)
  const name = escapeRegExp(word)
  const shapes = (family?.shapes ?? [KEYWORDS]).map((shape) => shape.replaceAll('W', () => name))
  const query: SearchQuery = { query: shapes.map((shape) => `(?:${shape})`).join('|'), regex: true, caseSensitive: true, limit: 300 }
  const result = await search(query, (family?.globs ?? []).map((ext) => `*.${ext}`))
  signal?.throwIfAborted()
  const found: Location[] = []
  const exact = new RegExp(`(?<![\\p{L}\\p{N}_$])${name}(?![\\p{L}\\p{N}_$])`, 'u')
  for (const file of result.files) {
    for (const match of file.matches) {
      // The name inside the declaration that matched, not an earlier mention on the line.
      const from = match.ranges[0]?.[0] ?? 0
      const at = exact.exec(match.preview.slice(from))
      if (at === null) continue
      if (USE.test(match.preview.slice(0, from + at.index))) continue
      found.push({ path: file.path, line: match.line, column: match.column + at.index, preview: match.preview.trim() })
    }
  }
  const rank = (location: Location): number => distance(path, location.path) * 2 + (TESTISH.test(location.path) ? 8 : 0)
  return found.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line).slice(0, 40)
}

/** `path` relative to `root`, `/`-separated; absolute when it lies outside. */
export function relativeTo(root: string, path: string): string {
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path.split(sep).join('/')
  return rel.split(sep).join('/')
}
