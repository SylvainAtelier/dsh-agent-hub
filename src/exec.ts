/**
 * One bounded child process, the only way the plugin runs a program: a time
 * limit, output caps, and a tree kill (git hooks, a formatter or a CLI may
 * start helpers of their own; on Windows ending the parent alone leaves them
 * running with no parent). `onLine` streams stdout line by line and may stop
 * the process early (ripgrep at the match cap) by returning `false`. A program
 * that is not installed reports `missing` instead of failing.
 *
 * The result settles on `close`, not on `exit`: descendants may still hold
 * the pipes. A process that exited while a background descendant keeps them
 * open has its pipes closed once the kill escalates.
 */

import { spawn, type ChildProcess } from 'node:child_process'

export interface ExecOptions {
  /** The host's own working directory when absent. */
  cwd?: string
  input?: string
  timeoutMs?: number
  /** Cancel before spawn or stop the running process tree. */
  signal?: AbortSignal
  /** Stdout cap; past it the process is stopped, unless `partial`. */
  maxBytes?: number
  /** Stderr cap; past it the rest is dropped (and `overflow` set), the process runs on. */
  maxStderrBytes?: number
  /** Keep the bounded prefix and let the process finish instead of stopping it at a cap. */
  partial?: boolean
  /** Stdout comes back base64-encoded (a blob). */
  base64?: boolean
  env?: NodeJS.ProcessEnv
  /** Run through the system shell (a `.cmd` launcher on Windows). */
  shell?: boolean
  /** Each complete stdout line, without its terminator; `false` stops the process. Lines are not kept in `stdout`. */
  onLine?: (line: string) => boolean | void
}

export interface ExecResult {
  code: number | null
  /** The actual signal; a code is never synthesized. */
  signal?: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** The program is not installed (spawn ENOENT). */
  missing: boolean
  timedOut: boolean
  /** Output passed a cap. */
  overflow: boolean
  /** Stdout passed its cap and the process was stopped for it, or `onLine` stopped it. */
  stopped: boolean
}

export type Exec = (command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>

const MAX_BYTES = 32 << 20
const MAX_STDERR_BYTES = 64 << 10
/** After a polite stop, the kill that cannot be refused. */
const ESCALATE_MS = 1_000

/**
 * End a process and its descendants: taskkill /T on Windows, the process group elsewhere (the
 * child must be spawned `detached` there to lead one). Escalates to SIGKILL after a second, unless
 * the returned cancel comes first (the process closed).
 */
export function killTree(child: ChildProcess, onEscalate?: () => void): () => void {
  const signalTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try { process.kill(-child.pid, signal); return } catch { /* Already gone, or no group: the child alone. */ }
    }
    child.kill(signal)
  }
  // Not spawnSync: the host's event loop keeps serving while taskkill walks the tree.
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => { child.kill('SIGKILL') })
      .on('exit', (code) => { if (code !== 0) child.kill('SIGKILL') })
  } else signalTree('SIGTERM')
  const escalation = setTimeout(() => {
    signalTree('SIGKILL')
    onEscalate?.()
  }, ESCALATE_MS)
  escalation.unref()
  return () => clearTimeout(escalation)
}

export const exec: Exec = (command, args, options) => new Promise((done, reject) => {
  options.signal?.throwIfAborted()
  let child: ChildProcess
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: options.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    done({ code: null, stdout: '', stderr: String(error), missing, timedOut: false, overflow: false, stopped: false })
    return
  }
  const out: Buffer[] = []
  const err: Buffer[] = []
  let size = 0
  let errSize = 0
  let pending = ''
  let missing = false
  let timedOut = false
  let overflow = false
  let stopped = false
  let escalated = false
  let cancelKill: (() => void) | undefined
  // An exited process can leave its pipes open in background descendants, and taskkill
  // cannot target an exited Windows PID: close them, or `close` never comes.
  const closePipes = (): void => {
    if (child.exitCode === null && child.signalCode === null) return
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.stdin?.destroy()
  }
  child.on('exit', () => { if (escalated) closePipes() })
  const kill = (): void => {
    cancelKill ??= killTree(child, () => {
      escalated = true
      closePipes()
    })
  }
  const stop = (): void => {
    stopped = true
    kill()
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, options.timeoutMs ?? 30_000)
  const abort = (): void => {
    clearTimeout(timer)
    stop()
  }
  /** Keep what fits under the cap; whether it overflowed. */
  const collect = (chunks: Buffer[], chunk: Buffer, used: number, limit: number): boolean => {
    const room = Math.max(0, limit - used)
    if (room > 0) chunks.push(chunk.subarray(0, room))
    if (chunk.length <= room) return false
    overflow = true
    return true
  }
  const decoder = new TextDecoder()
  child.stdout!.on('data', (chunk: Buffer) => {
    if (stopped) return
    if (options.onLine === undefined) {
      const cap = options.maxBytes ?? MAX_BYTES
      if (collect(out, chunk, size, cap) && !options.partial) stop()
      size = Math.min(cap, size + chunk.length)
      return
    }
    size += chunk.length
    if (size > (options.maxBytes ?? MAX_BYTES)) {
      overflow = true
      stop()
      return
    }
    pending += decoder.decode(chunk, { stream: true })
    let start = 0
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', start)) {
      const line = pending.slice(start, end > start && pending[end - 1] === '\r' ? end - 1 : end)
      start = end + 1
      if (options.onLine(line) === false) {
        stop()
        return
      }
    }
    pending = pending.slice(start)
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    const cap = options.maxStderrBytes ?? MAX_STDERR_BYTES
    collect(err, chunk, errSize, cap)
    errSize = Math.min(cap, errSize + chunk.length)
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') missing = true
    err.push(Buffer.from(error.message))
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    cancelKill?.()
    options.signal?.removeEventListener('abort', abort)
    if (options.signal?.aborted) {
      reject(options.signal.reason)
      return
    }
    if (!stopped && options.onLine !== undefined) {
      const rest = pending + decoder.decode()
      if (rest !== '') options.onLine(rest.replace(/\r$/, ''))
    }
    done({
      code, signal, missing, timedOut, overflow, stopped,
      stdout: Buffer.concat(out).toString(options.base64 ? 'base64' : 'utf8'),
      stderr: Buffer.concat(err).subarray(0, options.maxStderrBytes ?? MAX_STDERR_BYTES).toString('utf8'),
    })
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  // Also cover cancellation during spawn or listener setup.
  if (options.signal?.aborted) abort()
  if (options.input !== undefined) {
    child.stdin!.on('error', () => {}) // EPIPE is reflected in the close status.
    child.stdin!.end(options.input)
  }
})
