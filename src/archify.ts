/**
 * The Archify skill (github.com/tt-a1i/archify), installed by this plugin while
 * 设置 → Agent Hub → Archify 结构图 is on, so every model draws its structural
 * diagrams with it (prompt.ts names the installed folder).
 *
 * One pinned release: its `archify.zip` is downloaded once, checked against the
 * SHA-256 below, unpacked beside the plugin's data (`<root>/<version>`) and
 * kept when the switch goes off. A new pin replaces the old folder. Archify
 * itself needs no `npm install`: its CLI runs on Node's built-ins, with a local
 * Chrome or Edge for its browser check.
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const ARCHIFY_RELEASE = {
  version: '3.2.0',
  url: 'https://github.com/tt-a1i/archify/releases/download/v3.2.0/archify.zip',
  sha256: '70e210265c59f24dcbdf2a502ff671104b5454e7ee7d3554aecd86bad32384f5',
}
type Release = typeof ARCHIFY_RELEASE

const DOWNLOAD_MS = 120_000
const MAX_BYTES = 32 * 1024 * 1024
/** Written last: a folder without it is an interrupted install. */
const MARKER = '.agent-hub-installed'

/** What the settings page shows under the switch. */
export interface ArchifyStatus {
  phase: 'off' | 'installing' | 'ready' | 'failed'
  version: string
  error?: string
  /** What its CLI needs and this machine seems to lack (a hint: the models' shell may find more). */
  missing?: Array<'node' | 'browser'>
}

export interface ArchifyOptions {
  fetch?: typeof fetch
  /** Unpacks the zip into a folder. */
  extract?: (zip: string, into: string) => Promise<void>
  /** What the CLI needs, checked after each install. */
  probe?: () => Promise<Array<'node' | 'browser'>>
  log?: (message: string) => void
  release?: Release
}

export class Archify {
  private phase: ArchifyStatus['phase'] = 'off'
  private error: string | undefined
  private missing: Array<'node' | 'browser'> = []
  private running: Promise<void> | undefined
  private readonly release: Release
  private readonly root: string
  private readonly options: ArchifyOptions

  constructor(root: string, options: ArchifyOptions = {}) {
    this.root = root
    this.options = options
    this.release = options.release ?? ARCHIFY_RELEASE
    if (this.installed()) this.phase = 'ready'
  }

  private get folder(): string {
    return join(this.root, this.release.version)
  }

  private installed(): boolean {
    return existsSync(join(this.folder, MARKER)) && existsSync(join(this.folder, 'SKILL.md'))
  }

  /** The installed skill folder, or undefined until it is ready. */
  get dir(): string | undefined {
    return this.phase === 'ready' ? this.folder : undefined
  }

  status(on: boolean): ArchifyStatus {
    const phase = !on && this.phase !== 'installing' ? 'off' : this.phase
    return {
      phase,
      version: this.release.version,
      ...(phase === 'failed' && this.error !== undefined ? { error: this.error } : {}),
      ...(phase === 'ready' && this.missing.length > 0 ? { missing: [...this.missing] } : {}),
    }
  }

  /** Install unless installed; one run at a time, a failed one tried again on the next call. */
  ensure(): Promise<void> {
    if (this.installed()) {
      this.phase = 'ready'
      if (this.running === undefined) this.running = this.check().finally(() => { this.running = undefined })
      return this.running
    }
    this.running ??= this.install().finally(() => { this.running = undefined })
    return this.running
  }

  private async check(): Promise<void> {
    this.missing = await (this.options.probe ?? probe)().catch(() => [])
  }

  private async install(): Promise<void> {
    this.phase = 'installing'
    this.error = undefined
    const temp = join(this.root, `.download-${randomUUID()}`)
    try {
      await mkdir(temp, { recursive: true })
      const zip = join(temp, 'archify.zip')
      await writeFile(zip, await this.download())
      await (this.options.extract ?? extract)(zip, temp)
      const unpacked = join(temp, 'archify')
      const manifest = JSON.parse(await readFile(join(unpacked, 'skill-release.json'), 'utf8')) as { version?: unknown }
      if (manifest.version !== this.release.version) throw new Error(`the archive holds Archify ${String(manifest.version)}, not ${this.release.version}`)
      if (!existsSync(join(unpacked, 'SKILL.md'))) throw new Error('the archive has no SKILL.md')
      await writeFile(join(unpacked, MARKER), `${this.release.sha256}\n`)
      await rm(this.folder, { recursive: true, force: true })
      await rename(unpacked, this.folder)
      await this.prune()
      this.phase = 'ready'
      this.options.log?.(`Archify ${this.release.version} installed in ${this.folder}`)
      await this.check()
    } catch (error) {
      this.phase = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.options.log?.(`Archify install failed: ${this.error}`)
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async download(): Promise<Buffer> {
    const response = await (this.options.fetch ?? fetch)(this.release.url, { signal: AbortSignal.timeout(DOWNLOAD_MS) })
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > MAX_BYTES) throw new Error('download too large')
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== this.release.sha256) throw new Error(`checksum mismatch (${digest.slice(0, 12)}…)`)
    return body
  }

  /** Earlier versions and interrupted downloads. */
  private async prune(): Promise<void> {
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (name !== this.release.version) await rm(join(this.root, name), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** bsdtar reads zips (macOS, Windows 10+; its own copy, not Git's GNU tar); elsewhere unzip. */
async function extract(zip: string, into: string): Promise<void> {
  if (process.platform === 'win32') await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', into])
  else if (process.platform === 'darwin') await run('/usr/bin/tar', ['-xf', zip, '-C', into])
  else await run('unzip', ['-q', zip, '-d', into])
}

const BROWSERS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ],
  win32: [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData\\Local'), 'Google\\Chrome\\Application\\chrome.exe'),
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
}

async function probe(): Promise<Array<'node' | 'browser'>> {
  const missing: Array<'node' | 'browser'> = []
  const node = await run('node', ['--version'], { timeout: 5000 }).then(({ stdout }) => Number(/^v(\d+)/.exec(stdout.trim())?.[1] ?? 0), () => 0)
  if (node < 18) missing.push('node')
  const browsers = [process.env.CHROME_PATH, ...(BROWSERS[process.platform] ?? [])].filter((path): path is string => path !== undefined && path !== '')
  if (!browsers.some((path) => existsSync(path))) missing.push('browser')
  return missing
}
