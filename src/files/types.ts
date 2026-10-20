/**
 * Code editor wire types, shared by the host service and the browser editor.
 * One RPC method carries every operation; the payload's `op` picks it. Replies
 * are `{ ok }` unions so a conflict or a formatter's own error reaches the editor.
 *
 * Paths: requests name a file relative to the session's working directory or
 * absolutely; replies give workspace paths relative to `cwd`, `/`-separated.
 */

export const FILES_METHOD = 'agent-hub/files'

/** Line endings a file is written back with. */
export type Eol = 'lf' | 'crlf'

export type FilesRequest =
  | { op: 'read'; cwd: string; path: string }
  /** `base`: the hash the edit started from; `null` expects the file to be absent (it was deleted meanwhile). */
  | { op: 'write'; cwd: string; path: string; text: string; base: string | null; eol: Eol; bom: boolean }
  /** The file as of HEAD, for the change markers beside the line numbers. */
  | { op: 'base'; cwd: string; path: string }
  | { op: 'search'; cwd: string; query: string; regex?: boolean; caseSensitive?: boolean; word?: boolean; include?: string; exclude?: string; limit?: number }
  | { op: 'definition'; cwd: string; path: string; word: string }
  | { op: 'format'; cwd: string; path: string; text: string }
  /** The Files tree's menu. `paste` moves (`cut`) or copies an entry into a folder, under a free name; nothing is overwritten. */
  | { op: 'paste'; cwd: string; path: string; into: string; cut: boolean }
  | { op: 'rename'; cwd: string; path: string; name: string }
  | { op: 'delete'; cwd: string; path: string }
  /** A new empty file or folder in `into`, never over a taken name. `name` may hold `/`-separated folders, made as needed. */
  | { op: 'create'; cwd: string; into: string; name: string; kind: 'file' | 'directory' }

export type FilesErrorCode =
  | 'denied' | 'not-found' | 'not-file' | 'too-large' | 'binary' | 'not-utf8'
  | 'conflict' | 'unavailable' | 'invalid' | 'failed' | 'timeout'

export interface FilesError {
  code: FilesErrorCode
  message: string
  /** `conflict`: what is on disk now; absent when the file is gone or too large to send. */
  current?: FileText
  /** `conflict`: the file is gone from disk. */
  deleted?: boolean
}

export type FilesReply<T> = { ok: true; value: T } | { ok: false; error: FilesError }

export interface FileText {
  /** Absolute path on the host, as the file system spells it. */
  absolutePath: string
  /** Relative to the request's `cwd` (`/`-separated), or absolute when outside it. */
  path: string
  /** Contents without a byte order mark; line endings as on disk. */
  text: string
  /** Content hash of the bytes on disk; a write names it as its base. */
  hash: string
  eol: Eol
  bom: boolean
  size: number
}

export interface Written {
  hash: string
  size: number
}

/** `text` absent: no change markers (not in a repository, or ignored). `''`: a new file, every line added. */
export interface BaseText {
  text?: string
}

export interface SearchMatch {
  /** 1-based. */
  line: number
  /** 1-based UTF-16 column of the first match in the full line. */
  column: number
  /** The line, trimmed around the match when long. */
  preview: string
  /** Match ranges inside `preview`, UTF-16 `[start, end)`. */
  ranges: Array<[number, number]>
}

export interface SearchFile {
  path: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFile[]
  /** Matches returned. */
  count: number
  /** The match cap or the time limit cut the search short. */
  truncated: boolean
}

export interface Location {
  path: string
  line: number
  column: number
  preview: string
}

export interface Formatted {
  text: string
  /** Which formatter ran: `prettier`, `ruff`, `gofmt`… */
  formatter: string
}

/** Where a pasted, renamed or created entry now is: an absolute path on the host. */
export interface Placed {
  absolutePath: string
}
