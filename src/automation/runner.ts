import { posix, win32 } from 'node:path'
import { exec, type Exec } from '../exec.ts'

export function validateScriptTask(value: unknown): ScriptTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid automation definition')
  const task = value as Record<string, unknown>
  const string = (key: string, max: number): string => {
    const value = task[key]
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid automation ${key}`)
    return value
  }
  const id = string('id', 120)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid automation id')
  const title = string('title', 120)
  const command = string('command', 4096)
  const cwd = string('cwd', 4096)
  if (![command, cwd].every((path) => posix.isAbsolute(path) || win32.isAbsolute(path))) throw new Error('Automation command and cwd must be absolute paths')
  const provider = string('provider', 200)
  const model = string('model', 200)
  if (!Array.isArray(task.args) || task.args.length > 128 || task.args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('Invalid automation arguments')
  if (typeof task.timeoutMs !== 'number' || !Number.isInteger(task.timeoutMs) || task.timeoutMs < 1000 || task.timeoutMs > 3_600_000) throw new Error('Invalid automation timeout')
  return { id, title, command, args: [...task.args] as string[], cwd, provider, model, timeoutMs: task.timeoutMs }
}
import type { RunResult, ScriptTask } from './types.ts'

/** Only the configured executable/argv are accepted; never invoke a shell or expose raw process output. */
export type Diagnose = (info: Record<string, unknown>) => void
const tail = (text: string, max = 6000): string => text.length > max ? `…${text.slice(-max)}` : text

export async function runScriptTask(def: ScriptTask, signal: AbortSignal, runId?: string, execute: Exec = exec, diagnose?: Diagnose): Promise<RunResult> {
  try {
    def = validateScriptTask(def)
    signal.throwIfAborted()
    const result = await execute(def.command, def.args, {
      cwd: def.cwd, timeoutMs: def.timeoutMs, signal, shell: false,
      maxBytes: 64 << 10, maxStderrBytes: 16 << 10,
      ...(runId ? { env: { ...process.env, AUTOMATION_RUN_ID: runId } } : {}),
    })
    // Local diagnostics only: never part of the result the model or UI receives.
    try { diagnose?.({ code: result.code, signal: result.signal ?? null, timedOut: result.timedOut, stopped: result.stopped, missing: result.missing, overflow: result.overflow, stdoutBytes: result.stdout.length, stdout: tail(result.stdout, 1500), stderr: tail(result.stderr) }) } catch { /* diagnostics are best effort */ }
    if (signal.aborted || result.timedOut || result.signal || result.stopped) return { status: 'unknown', summary: 'Execution interrupted; outcome is unknown.' }
    if (result.missing) return { status: 'error', summary: 'Configured executable is unavailable.' }
    if (result.overflow) return { status: 'error', summary: 'Script output exceeded the allowed limit.' }
    let value: unknown
    try { value = JSON.parse(result.stdout) } catch { return { status: 'error', summary: 'Script did not return a valid result.' } }
    if (!value || typeof value !== 'object') return { status: 'error', summary: 'Script returned an invalid result.' }
    const record = value as Record<string, unknown>
    if (!['ok', 'error', 'unknown'].includes(String(record.status)) || typeof record.summary !== 'string' || !record.summary.trim() || record.summary.length > 8000 || Object.keys(record).some((key) => !['status', 'summary'].includes(key))) return { status: 'error', summary: 'Script returned an invalid result.' }
    if (result.code === null) return { status: 'unknown', summary: 'Script reported no confirmed exit status.' }
    if (result.code !== 0 && record.status === 'ok') return { status: 'error', summary: 'Script exited unsuccessfully.', code: result.code }
    return { status: record.status as RunResult['status'], summary: record.summary, ...(result.code === 0 ? {} : { code: result.code }) }
  } catch (error) {
    try { diagnose?.({ failed: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }) } catch { /* best effort */ }
    return signal.aborted ? { status: 'unknown', summary: 'Execution cancelled; outcome is unknown.' } : { status: 'unknown', summary: 'Execution failed to report a confirmed outcome.' }
  }
}
