/**
 * The local Tailscale client, driven through its CLI. Only two things are
 * read (this node's tailnet identity, and the serve rule on one port of its
 * name) and one thing is written: that port's `tailscale serve` rule.
 */

import { exec } from '../exec.ts'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const BINARY = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
const INSTALLED: Partial<Record<NodeJS.Platform, string>> = {
  win32: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
  darwin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
}

/** The `tailscale` CLI: PATH first, then the installer's location. */
export function findTailscale(): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  return [...dirs.map((dir) => join(dir, BINARY)), INSTALLED[process.platform]]
    .find((file): file is string => file !== undefined && existsSync(file))
}

async function run(file: string, args: readonly string[]): Promise<string> {
  const result = await exec(file, args, { timeoutMs: 15_000, maxBytes: 1 << 20 })
  if (result.code === 0 && !result.timedOut) return result.stdout
  throw new Error((result.stderr || result.stdout || (result.timedOut ? 'tailscale timed out' : `tailscale exited with ${result.code}`)).trim())
}

/** This node on its tailnet. */
export interface Node {
  /** MagicDNS name, without the trailing dot. */
  dnsName: string
  /** Login of the account that owns this node: the only person let in. */
  login: string
  /** Whether the tailnet issues HTTPS certificates for `dnsName`. */
  https: boolean
}

interface Status {
  BackendState?: string
  Self?: { DNSName?: string; UserID?: number }
  User?: Record<string, { LoginName?: string }>
  CertDomains?: string[] | null
}

/** This node, or undefined while Tailscale is stopped or signed out. */
export function parseStatus(status: Status): Node | undefined {
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName
  if (status.BackendState !== 'Running' || !dnsName || !login) return undefined
  return { dnsName, login, https: status.CertDomains?.includes(dnsName) === true }
}

export async function node(file: string): Promise<Node | undefined> {
  try {
    return parseStatus(JSON.parse(await run(file, ['status', '--json'])) as Status)
  } catch {
    return undefined
  }
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

/**
 * What this node serves on `port` under `host`: the proxied URL, `other` for
 * anything else, undefined when free. A rule left under a former name of the
 * node (it was renamed) does not answer for `host`, so it reads as free.
 */
export function parseServe(config: ServeConfig, port: number, host: string): string | undefined {
  const tcp = config.TCP?.[String(port)]
  if (tcp === undefined) return undefined
  if (tcp.HTTPS !== true && tcp.HTTP !== true) return 'other'
  const site = Object.entries(config.Web ?? {}).find(([authority]) => authority.toLowerCase() === `${host}:${port}`.toLowerCase())?.[1]
  if (site === undefined) return undefined
  const handlers = Object.entries(site.Handlers ?? {})
  return handlers.length === 1 && handlers[0][0] === '/' && handlers[0][1].Proxy !== undefined ? handlers[0][1].Proxy : 'other'
}

export async function served(file: string, port: number, host: string): Promise<string | undefined> {
  return parseServe(JSON.parse(await run(file, ['serve', 'status', '--json']) || '{}') as ServeConfig, port, host)
}

export type Scheme = 'https' | 'http'

/** Serve `target` on `port` to this tailnet, over HTTPS or plain HTTP; the rule persists until removed. */
export async function serve(file: string, port: number, target: string, scheme: Scheme = 'https'): Promise<void> {
  await run(file, ['serve', '--bg', '--yes', `--${scheme}=${port}`, target])
}

export async function unserve(file: string, port: number, scheme: Scheme = 'https'): Promise<void> {
  await run(file, ['serve', `--${scheme}=${port}`, 'off'])
}
