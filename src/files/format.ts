/**
 * Format a file with the formatter the project itself uses, so the result
 * matches what its CI and its agents produce: the project's own Biome or
 * Prettier first (found from the file's folder up), then the usual command
 * line formatters on PATH (ruff/black, gofmt, rustfmt, clang-format, …), and
 * for the web languages this plugin's own Prettier last. Every formatter
 * reads the text on stdin and is told the file's path, so `.prettierrc`,
 * `.editorconfig`, `pyproject.toml` and ignore files apply as on the command
 * line. A formatter that is not installed is skipped; one that rejects the
 * text (a syntax error) reports its own message.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join } from 'node:path'
import type { Exec } from '../exec.ts'

export interface FormatInput {
  /** Absolute path of the file being formatted. */
  file: string
  text: string
  /** The workspace folder: the search for project formatters stops here. */
  root: string
}

export class FormatError extends Error {
  readonly code: 'unavailable' | 'failed' | 'timeout'
  constructor(code: 'unavailable' | 'failed' | 'timeout', message: string) {
    super(message)
    this.code = code
  }
}

interface Command {
  name: string
  command: string
  args: string[]
}

const PRETTIER = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'json5', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'md', 'markdown', 'mdx', 'yaml', 'yml', 'graphql', 'gql', 'hbs', 'handlebars',
])
const BIOME = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'css', 'graphql', 'gql'])
const CLANG = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm', 'java', 'proto', 'cs'])

/** Folders from the file's up to and including the workspace root. */
function folders(file: string, root: string): string[] {
  const list: string[] = []
  let dir = dirname(file)
  const stop = root.toLowerCase()
  for (let i = 0; i < 64; i++) {
    list.push(dir)
    if (dir.toLowerCase() === stop) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return list
}

/** The project's own copy of a package: the nearest `node_modules/<name>`, as Node looks it up. */
function projectPackage(file: string, name: string): string | undefined {
  let dir = dirname(file)
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** This plugin's own Prettier CLI, when its dependency is installed. */
export function ownPrettier(): string | undefined {
  try {
    const bin = join(dirname(createRequire(import.meta.url).resolve('prettier/package.json')), 'bin', 'prettier.cjs')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

function hasBiomeConfig(file: string, root: string): boolean {
  return folders(file, root).some((dir) => existsSync(join(dir, 'biome.json')) || existsSync(join(dir, 'biome.jsonc')))
}

/** The formatters to try for a file, in order. `ownPrettier` is this plugin's Prettier CLI. */
export function formatters(input: FormatInput, ownPrettier: string | undefined, node = process.execPath): Command[] {
  const ext = extname(input.file).slice(1).toLowerCase()
  const name = basename(input.file)
  const list: Command[] = []
  if (BIOME.has(ext) && hasBiomeConfig(input.file, input.root)) {
    const biome = projectPackage(input.file, '@biomejs/biome')
    if (biome !== undefined) list.push({ name: 'biome', command: node, args: [join(biome, 'bin', 'biome'), 'format', `--stdin-file-path=${input.file}`] })
  }
  if (PRETTIER.has(ext)) {
    const prettier = projectPackage(input.file, 'prettier')
    if (prettier !== undefined) {
      const bin = ['bin/prettier.cjs', 'bin-prettier.js', 'bin/prettier.js'].map((rel) => join(prettier, rel)).find((path) => existsSync(path))
      if (bin !== undefined) list.push({ name: 'prettier', command: node, args: [bin, '--stdin-filepath', input.file] })
    }
    if (ownPrettier !== undefined) list.push({ name: 'prettier', command: node, args: [ownPrettier, '--stdin-filepath', input.file] })
  }
  if (ext === 'py' || ext === 'pyi') {
    list.push({ name: 'ruff', command: 'ruff', args: ['format', '--stdin-filename', input.file, '-'] })
    list.push({ name: 'black', command: 'black', args: ['-q', '--stdin-filename', input.file, '-'] })
  }
  if (ext === 'go') list.push({ name: 'gofmt', command: 'gofmt', args: [] })
  if (ext === 'rs') list.push({ name: 'rustfmt', command: 'rustfmt', args: ['--edition', '2021', '--emit', 'stdout'] })
  if (CLANG.has(ext)) list.push({ name: 'clang-format', command: 'clang-format', args: [`--assume-filename=${input.file}`] })
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') list.push({ name: 'shfmt', command: 'shfmt', args: ['-'] })
  if (ext === 'lua') list.push({ name: 'stylua', command: 'stylua', args: ['--stdin-filepath', input.file, '-'] })
  if (ext === 'toml') list.push({ name: 'taplo', command: 'taplo', args: ['fmt', '-'] })
  if (ext === 'dart') list.push({ name: 'dart', command: 'dart', args: ['format', '--output=show', '--stdin-name', name] })
  if (ext === 'tf' || ext === 'hcl') list.push({ name: 'terraform', command: 'terraform', args: ['fmt', '-'] })
  return list
}

export async function format(exec: Exec, input: FormatInput, ownPrettier: string | undefined): Promise<{ text: string; formatter: string }> {
  const list = formatters(input, ownPrettier)
  if (list.length === 0) throw new FormatError('unavailable', 'no formatter for this file type')
  for (const candidate of list) {
    const result = await exec(candidate.command, candidate.args, {
      cwd: dirname(input.file),
      input: input.text,
      timeoutMs: 20_000,
      maxBytes: 64 << 20,
      // A Node formatter under DSH's desktop runtime: run the binary as plain Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    if (result.missing) continue
    if (result.timedOut) throw new FormatError('timeout', `${candidate.name} timed out`)
    if (result.code !== 0) {
      const message = result.stderr.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? `exit code ${result.code}`
      throw new FormatError('failed', `${candidate.name}: ${message}`)
    }
    return { text: result.stdout, formatter: candidate.name }
  }
  throw new FormatError('unavailable', `no formatter is installed (${[...new Set(list.map((item) => item.name))].join(', ')})`)
}
