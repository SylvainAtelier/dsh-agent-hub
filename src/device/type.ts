/** Lazy, bounded JSON-lines bridge to the isolated native dictation helper. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type TypeWay = 'auto' | 'unicode' | 'paste'
const IDLE_MS = 5 * 60_000
const REPLY_MS = 15_000
const MAX_PENDING = 8
const MAX_REPLY = 32 * 1024

export function typerPath(base = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const file = join(base, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'dsh-type.exe' : 'dsh-type')
  return existsSync(file) ? file : undefined
}

export class Typer {
  private child?: ChildProcessWithoutNullStreams
  private next = 1
  private waiting = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private idle?: NodeJS.Timeout
  private disposed = false

  private readonly path: string | undefined
  private readonly log: (message: string) => void
  private readonly launch: typeof spawn

  constructor(path: string | undefined, log: (message: string) => void, launch: typeof spawn = spawn) {
    this.path = path
    this.log = log
    this.launch = launch
  }

  get available(): boolean { return this.path !== undefined && !this.disposed }

  async front(): Promise<string | undefined> {
    const reply = await this.call({ op: 'front' }).catch(() => undefined)
    if (reply === undefined || typeof reply.app !== 'string' || reply.app === '') return undefined
    return typeof reply.title === 'string' && reply.title !== '' ? `${reply.app} · ${reply.title}` : reply.app
  }

  async type(text: string, way: TypeWay): Promise<void> {
    if (text === '' || [...text].length > 4000) throw new Error('text is empty or too long')
    const reply = await this.call({ op: 'type', text, way })
    if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : 'typing failed')
  }

  async permission(): Promise<boolean | undefined> {
    if (process.platform !== 'darwin') return undefined
    const reply = await this.call({ op: 'perm' }).catch(() => undefined)
    return reply?.accessibility === true
  }

  async openPermission(): Promise<void> {
    const reply = await this.call({ op: 'open-perm' })
    if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : 'cannot open permissions')
  }

  dispose(): void {
    this.disposed = true
    this.stop(new Error('dsh-type disposed'))
  }

  private stop(error: Error): void {
    clearTimeout(this.idle)
    this.idle = undefined
    const child = this.child
    this.child = undefined
    for (const entry of this.waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.waiting.clear()
    child?.kill()
  }

  private rest(): void {
    if (this.waiting.size !== 0 || this.child === undefined) return
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(new Error('dsh-type idle')), IDLE_MS)
    this.idle.unref()
  }

  private async call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error('dsh-type disposed')
    if (this.waiting.size >= MAX_PENDING) throw new Error('dsh-type is busy')
    const child = this.start()
    const id = this.next++
    clearTimeout(this.idle)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Never allow a timed-out typing request to execute later in a stale process.
        this.stop(new Error('dsh-type did not answer'))
      }, REPLY_MS)
      timer.unref()
      this.waiting.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
        if (error && this.child === child) this.stop(error)
      })
    })
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child
    if (this.path === undefined) throw new Error('dsh-type is not built for this system')
    const child = this.launch(this.path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams
    this.child = child
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffered += chunk
      if (Buffer.byteLength(buffered) > MAX_REPLY) return this.stop(new Error('dsh-type reply too large'))
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        let reply: Record<string, unknown>
        try {
          const value: unknown = JSON.parse(line)
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid reply')
          reply = value as Record<string, unknown>
        } catch { return this.stop(new Error('invalid dsh-type reply')) }
        const entry = this.waiting.get(reply.id as number)
        if (entry === undefined) continue
        clearTimeout(entry.timer)
        this.waiting.delete(reply.id as number)
        entry.resolve(reply)
      }
      this.rest()
    })
    child.stderr.on('data', (data: Buffer) => this.log(`dsh-type: ${data.toString().trim().slice(0, 1024)}`))
    const gone = (reason: string): void => {
      if (this.child === child) this.stop(new Error(reason))
    }
    child.stdin.on('error', (error) => gone(`dsh-type input failed: ${error.message}`))
    child.on('error', (error) => gone(`dsh-type failed to start: ${error.message}`))
    child.on('exit', (code) => gone(`dsh-type exited (${code ?? 'signal'})`))
    return child
  }
}
