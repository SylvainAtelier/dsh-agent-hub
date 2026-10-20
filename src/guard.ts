/**
 * Blocked commands: shell commands refused before they run, for every model.
 *
 * - Built-in scans: `find` rooted at the whole filesystem or a whole drive. In
 *   Git Bash such a scan walks every drive mount and /proc (the registry
 *   included) for hours; when a tool timeout then stops the shell, Windows does
 *   not end its children, so `find.exe` and the `head.exe` it pipes into are
 *   left running with no parent.
 * - Custom commands: written as typed in a shell. A command is refused when it
 *   runs the same program with the pattern's words in the same order, other
 *   words between them allowed; `*` matches any run of characters in a word.
 *
 * Where it applies:
 * - DSH models: a guard on DSH's tool registry (`tools.guard`, index.ts) for the `bash` and `pwsh` tools.
 * - Claude Agent: a `PreToolUse` hook on Claude Code's `Bash` and `PowerShell` tools
 *   (claude/conversation.ts), which also runs in full-access mode, where no permission check is asked.
 */

import { localized } from './locale.ts'

/** The start paths each built-in rule refuses, by rule id (`Config.prompt.blockedScans`). */
const RULES = {
  /** The filesystem root. */
  root: /^\/+$/,
  /** A Git Bash drive mount: /c, /d/. */
  mount: /^\/[a-zA-Z]\/*$/,
  /** A Windows drive root: C:, C:/, C:\. */
  drive: /^[a-zA-Z]:[\\/]*$/,
  /** /proc and below, /proc/registry included. */
  proc: /^\/proc(\/|$)/,
} as const

export type ScanRule = keyof typeof RULES

/** Every built-in rule, in display order; all are on by default. */
export const SCAN_RULES = Object.keys(RULES) as ScanRule[]

/** The plugin settings the guard reads (`Config.prompt`). */
export interface GuardSettings {
  blockedScans?: readonly string[]
  blockedCommands?: readonly string[]
}

/** Programs that run the command after them; the guard looks past them (and their flags). */
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'env', 'xargs', 'timeout'])

/**
 * The simple commands of a shell line, each as its words with quotes removed.
 * Separators (`; & | ( )` and newlines) split commands only outside quotes, so a
 * quoted "find /" stays one word of another command. Backslashes stay literal:
 * the line may be PowerShell, where `C:\` is a path.
 */
function split(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let quoted = false
  let quote = ''
  const endWord = (): void => {
    if (word !== '' || quoted) words.push(word)
    word = ''
    quoted = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quote !== '') {
      if (char === quote) quote = ''
      else if (quote === '"' && char === '\\' && line[i + 1] === '"') word += line[++i]
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      quoted = true
    } else if (';&|()\n'.includes(char)) {
      endCommand()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word += char
    }
  }
  endCommand()
  return commands
}

/** Every simple command a line runs, command substitutions (`$(…)`, backticks) included. */
export function simpleCommands(line: string): string[][] {
  const inner = [...line.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].flatMap((match) => simpleCommands(match[1] ?? match[2] ?? ''))
  return [...split(line), ...inner]
}

/** A program's name as typed or as a path: /usr/bin/find, find.exe and FIND are all `find`. */
export const programName = (word: string): string => word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

/** The command a line runs past leading variable assignments and wrappers such as `timeout 20s` or `sudo`. */
export function unwrap(words: readonly string[]): readonly string[] {
  let i = 0
  while (i < words.length) {
    if (/^[A-Za-z_]\w*=/.test(words[i]!)) {
      i++
      continue
    }
    const name = programName(words[i]!)
    if (!WRAPPERS.has(name)) break
    i++
    while (i < words.length && words[i]!.startsWith('-')) i++
    if (name === 'timeout' && i < words.length) i++ // its duration
  }
  return words.slice(i)
}

/** The start path of a `find` call a built-in rule refuses: the arguments before its first expression. */
function scannedPath(words: readonly string[], rules: readonly string[]): string | undefined {
  if (words.length === 0 || programName(words[0]!) !== 'find') return undefined
  for (const word of words.slice(1)) {
    if (/^(-[HLP]|-O\d)$/.test(word)) continue
    if (/^[-(!]/.test(word)) return undefined
    if (rules.some((rule) => RULES[rule as ScanRule]?.test(word))) return word
  }
  return undefined
}

const glob = (word: string): RegExp => new RegExp(`^${word.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

/**
 * A custom entry's words: one command as typed, its program first. Undefined
 * when there is nothing to match or the text holds more than one command.
 */
export function commandPattern(text: string): string[] | undefined {
  const commands = split(text)
  return commands.length === 1 ? commands[0] : undefined
}

/** Whether a command runs the pattern's program with its words in order. */
function runs(words: readonly string[], pattern: readonly string[]): boolean {
  if (words.length === 0 || !glob(programName(pattern[0]!)).test(programName(words[0]!))) return false
  let i = 1
  for (const part of pattern.slice(1)) {
    const word = glob(part)
    while (i < words.length && !word.test(words[i]!)) i++
    if (i === words.length) return false
    i++
  }
  return true
}

/** Why the command is refused, or undefined when no enabled rule or custom entry matches it. */
export function blockedReason(command: unknown, settings: GuardSettings | undefined): string | undefined {
  if (typeof command !== 'string' || settings === undefined) return undefined
  const scans = settings.blockedScans ?? []
  const custom = (settings.blockedCommands ?? []).flatMap((text) => {
    const pattern = commandPattern(text)
    return pattern === undefined ? [] : [{ text: text.trim(), pattern }]
  })
  if (scans.length === 0 && custom.length === 0) return undefined
  for (const words of simpleCommands(command)) {
    const bare = unwrap(words)
    const path = scannedPath(bare, scans)
    if (path !== undefined) {
      return `Blocked: \`find ${path}\` scans the whole filesystem or drive and outlives the tool timeout as an orphan process. `
        + 'Search known roots instead (npm root -g, $APPDATA/npm/node_modules, $LOCALAPPDATA, ~/.dsh), prefer the Glob/Grep tools, '
        + 'and wrap a shell find in `timeout 20s`.'
    }
    const hit = custom.find((entry) => runs(words, entry.pattern) || runs(bare, entry.pattern))
    if (hit !== undefined) {
      return `Blocked: \`${hit.text}\` is on the user's list of blocked commands (${localized({ zh: '设置', en: 'Settings' })} → Agent Hub). `
        + 'Do not run it another way; if it is really needed, tell the user and let them run it.'
    }
  }
  return undefined
}
