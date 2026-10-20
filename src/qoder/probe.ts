/**
 * What the Qoder processes cost: memory, CPU time and start of every
 * `qoderclicn*` process, read every few seconds by one long-lived helper
 * (spawning one per read costs PowerShell two seconds; `tasklist /V`, forty).
 * Run only while the panel is shown.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { lineReader } from './daemon.ts'

export interface ProcSample {
  /** Resident memory (the working set on Windows), in bytes. */
  rss: number
  /** CPU time used so far, in ms. */
  cpuMs: number
  startedAt?: number
}

/** Start sampling; each read hands over every Qoder process by pid. Returns the stop. */
export type Probe = (read: (samples: Map<number, ProcSample>) => void) => () => void

const EVERY_S = 3

const WINDOWS = `$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  foreach ($p in Get-Process -Name 'qoderclicn*') {
    [Console]::Out.WriteLine(('{0} {1} {2} {3}' -f $p.Id, $p.WorkingSet64, [long]$p.TotalProcessorTime.TotalMilliseconds, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()))
  }
  [Console]::Out.WriteLine('@')
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${EVERY_S}
}`

const POSIX = `while :; do ps -A -o pid=,rss=,time=,etime=,comm= | grep qoderclicn; echo @; sleep ${EVERY_S}; done`

/** `1-02:03:04`, `02:03:04`, `03:04`, `0:01.25` → ms. */
export function clock(text: string): number {
  const [days, rest] = text.includes('-') ? text.split('-') as [string, string] : ['0', text]
  const parts = rest.split(':').map(Number)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return Math.round((Number(days) * 86_400 + seconds) * 1000)
}

/** One line of either helper; undefined for anything else. */
export function parseSample(line: string, windows: boolean, now = Date.now()): [number, ProcSample] | undefined {
  const fields = line.trim().split(/\s+/)
  if (windows) {
    const [pid, rss, cpu, start] = fields.map(Number)
    if (fields.length !== 4 || !Number.isFinite(pid) || !Number.isFinite(rss)) return undefined
    return [pid!, { rss: rss!, cpuMs: cpu ?? 0, ...(start! > 0 ? { startedAt: start } : {}) }]
  }
  if (fields.length < 5) return undefined
  const pid = Number(fields[0])
  const rss = Number(fields[1])
  if (!Number.isFinite(pid) || !Number.isFinite(rss)) return undefined
  return [pid, { rss: rss * 1024, cpuMs: clock(fields[2]!), startedAt: now - clock(fields[3]!) }]
}

export const probeQoder: Probe = (read) => {
  const windows = process.platform === 'win32'
  let child: ChildProcess
  try {
    child = windows
      ? spawn(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS, 'utf16le').toString('base64')],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      : spawn('/bin/sh', ['-c', POSIX], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return () => {}
  }
  child.on('error', () => {})
  let batch = new Map<number, ProcSample>()
  child.stdout?.setEncoding('utf8')
  const reader = lineReader((line) => {
    if (line.trim() === '@') {
      read(batch)
      batch = new Map()
      return
    }
    const sample = parseSample(line, windows)
    if (sample !== undefined) batch.set(sample[0], sample[1])
  })
  child.stdout?.on('data', (data: string) => reader(data))
  return () => { child.kill() }
}
