/**
 * Phone access: DSH served to this node's own tailnet account over HTTPS.
 *
 * `tailscale serve` terminates TLS on the node's MagicDNS name and proxies to
 * a loopback hop (proxy.ts), which hands the request to DSH's web server;
 * plain `http://` on port 80 goes to a second hop that only redirects to HTTPS.
 * Rules are read under the node's current MagicDNS name, so after a rename
 * they are set again rather than left answering for the old one.
 * Turning it on is remembered (in `file`) and restored at the next start;
 * shutting down removes the serve rule, so the name never points at a port
 * something else may take.
 */

import { readFile } from 'node:fs/promises'
import { atomicWriteJson } from '../persistence.ts'
import { startProxy, startRedirect, type Proxy, type ProxyOptions } from './proxy.ts'
import { findTailscale, node, serve, served, unserve, type Node } from './tailscale.ts'
import type { RemoteResult, RemoteView } from './types.ts'

/** Where browsers go for a bare `http://` name. */
const HTTP_PORT = 80

export interface RemoteOptions {
  /** Where the on/off choice is kept. */
  file: string
  /** HTTPS port on the tailnet name; 443 gives a bare URL. */
  httpsPort: number
  /** Also answer `http://` on port 80, sending it on to the HTTPS URL. */
  http: boolean
  upstream: ProxyOptions['upstream']
  signIn: ProxyOptions['signIn']
  log: (message: string) => void
}

interface Saved {
  enabled: boolean
  /** The serve target this plugin set, so a rule it did not set is never replaced. */
  target?: string
  /** Likewise for the plain-HTTP rule on port 80. */
  redirect?: string
}

/** The loopback hops serving one tailnet name. */
interface Hops {
  proxy: Proxy
  redirect?: Proxy
  /** The MagicDNS name the serve rules were set under. */
  host: string
  authority: string
  owner: string
}

/** Rules a stopped instance still has to remove: their name and targets. */
interface Owned {
  host: string
  https?: string
  http?: string
}

export interface Remote {
  run(action: 'status' | 'enable' | 'disable'): Promise<RemoteResult>
  /** Restore phone access if it was on. */
  resume(): void
  dispose(): Promise<void>
}

const loopback = (port: number): string => `http://127.0.0.1:${port}`
const TARGET = /^http:\/\/127\.0\.0\.1:\d+$/

/** Start on the port a serve rule left behind may still point at, else any free one. */
function reuse(saved: string | undefined, start: (port?: number) => Promise<Proxy>): Promise<Proxy> {
  return saved === undefined ? start() : start(Number(new URL(saved).port)).catch(() => start())
}

export function createRemote(options: RemoteOptions): Remote {
  let hops: Hops | undefined
  let disposed = false
  let closing: Promise<void> | undefined
  let cleanup: Owned | undefined
  const active = (): void => { if (disposed) throw new Error('phone access is shutting down') }
  // CLI calls and state changes run one at a time.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => {})
    return next
  }
  const wantsHttp = options.http && options.httpsPort !== HTTP_PORT

  const load = async (): Promise<Saved> => {
    try {
      const saved = JSON.parse(await readFile(options.file, 'utf8')) as Saved
      if (typeof saved.enabled !== 'boolean' || [saved.target, saved.redirect].some((value) => value !== undefined && !TARGET.test(value))) throw new Error('invalid phone access state')
      return saved
    } catch {
      return { enabled: false }
    }
  }
  const save = (saved: Saved): Promise<void> => atomicWriteJson(options.file, saved)

  const url = (dnsName: string): string => `https://${dnsName}${options.httpsPort === 443 ? '' : `:${options.httpsPort}`}`
  const authority = (dnsName: string): string => `${dnsName}${options.httpsPort === 443 ? '' : `:${options.httpsPort}`}`.toLowerCase()

  const view = async (): Promise<{ view: RemoteView; file?: string; node?: Node }> => {
    const file = findTailscale()
    if (file === undefined) return { view: { state: 'missing' } }
    const self = await node(file)
    if (self === undefined) return { view: { state: 'offline' }, file }
    if (!self.https) return { view: { state: 'no-https' }, file, node: self }
    const on = hops !== undefined && (await load()).enabled
    return { view: { state: on ? 'on' : 'off', url: url(self.dnsName), login: self.login }, file, node: self }
  }

  const owned = (current: Hops | undefined): Owned | undefined => current === undefined ? undefined : {
    host: current.host,
    https: loopback(current.proxy.port),
    http: current.redirect === undefined ? undefined : loopback(current.redirect.port),
  }

  const stopRedirect = (current: Hops): void => {
    current.redirect?.close()
    current.redirect = undefined
  }
  const stopHops = (): void => {
    if (hops !== undefined) stopRedirect(hops)
    hops?.proxy.close()
    hops = undefined
  }

  /** Remove the rules `rules` names, each only while it still points at this plugin's hop. */
  const release = async (file: string, rules: Owned): Promise<void> => {
    if (rules.https !== undefined && await served(file, options.httpsPort, rules.host) === rules.https) await unserve(file, options.httpsPort)
    if (rules.http !== undefined && await served(file, HTTP_PORT, rules.host) === rules.http) await unserve(file, HTTP_PORT, 'http')
  }

  /**
   * The port-80 rule: set to the redirect hop when wanted, removed when not.
   * A rule there that is not this plugin's is left alone. Failing here never
   * undoes HTTPS access; the URL the page shows is the HTTPS one.
   */
  const plain = async (file: string, current: Hops, saved: Saved): Promise<string | undefined> => {
    // An earlier, hand-made rule pointing at the HTTPS hop counts as this plugin's too.
    const mine = [saved.redirect, saved.target, loopback(current.proxy.port)]
    try {
      const existing = await served(file, HTTP_PORT, current.host)
      active()
      if (!wantsHttp) {
        stopRedirect(current)
        if (existing !== undefined && mine.includes(existing)) await unserve(file, HTTP_PORT, 'http')
        return undefined
      }
      if (existing !== undefined && !mine.includes(existing) && (current.redirect === undefined || existing !== loopback(current.redirect.port))) {
        stopRedirect(current)
        options.log(`port ${HTTP_PORT} on ${current.host} already serves something else; http:// is left to it`)
        return undefined
      }
      if (current.redirect === undefined) {
        const started = await reuse(saved.redirect, (port) => startRedirect({ authority: current.authority, port }))
        if (disposed) { started.close(); active() }
        current.redirect = started
      }
      const target = loopback(current.redirect.port)
      if (existing !== target) await serve(file, HTTP_PORT, target, 'http')
      return target
    } catch (error) {
      if (disposed) throw error
      stopRedirect(current)
      options.log(`http:// on port ${HTTP_PORT} not served: ${(error as Error).message}`)
      return undefined
    }
  }

  const enable = async (): Promise<RemoteResult> => {
    active()
    const current = await view()
    active()
    if (current.file === undefined || current.node === undefined || !current.node.https) return { view: current.view, error: 'Tailscale is not ready' }
    const { file, node: self } = current
    const saved = await load()
    active()
    const wanted = { host: self.dnsName, authority: authority(self.dnsName), owner: self.login }
    // The node was renamed or changed hands: start over under the new name.
    if (hops !== undefined && (hops.host !== wanted.host || hops.authority !== wanted.authority || hops.owner !== wanted.owner)) stopHops()
    if (hops === undefined) {
      const started = await reuse(saved.target, (port) => startProxy({ ...wanted, upstream: options.upstream, signIn: options.signIn, port }))
      if (disposed) { started.close(); active() }
      hops = { proxy: started, ...wanted }
    }
    const target = loopback(hops.proxy.port)
    const existing = await served(file, options.httpsPort, self.dnsName)
    active()
    if (existing !== undefined && existing !== target && existing !== saved.target) {
      stopHops()
      return { view: (await view()).view, error: `Tailscale already serves something else on port ${options.httpsPort}` }
    }
    if (existing !== target) await serve(file, options.httpsPort, target)
    active()
    const redirect = await plain(file, hops, saved)
    active()
    await save({ enabled: true, target, ...(redirect === undefined ? {} : { redirect }) })
    return { view: (await view()).view }
  }

  /** The status, after quietly re-serving a rule that went missing (the node was renamed, or serve was reset). */
  const status = async (): Promise<RemoteResult> => {
    const current = await view()
    if (current.view.state !== 'on' || current.file === undefined || current.node === undefined || hops === undefined) return { view: current.view }
    const intact = hops.host === current.node.dnsName && await served(current.file, options.httpsPort, current.node.dnsName) === loopback(hops.proxy.port)
    return intact ? { view: current.view } : enable()
  }

  const disable = async (): Promise<RemoteResult> => {
    const saved = await load()
    const file = findTailscale()
    const host = hops?.host ?? (file === undefined ? undefined : (await node(file))?.dnsName)
    if (file !== undefined && host !== undefined) {
      await release(file, { host, https: saved.target, http: saved.redirect }).catch((error: Error) => options.log(`phone access rule not removed: ${error.message}`))
    }
    stopHops()
    await save({ enabled: false })
    return { view: (await view()).view }
  }

  const fail = async (error: unknown): Promise<RemoteResult> => ({ view: (await view()).view, error: (error as Error).message })

  return {
    run(action) {
      return serial(async () => {
        if (disposed) throw new Error('phone access is shutting down')
        try {
          if (action === 'enable') return await enable()
          if (action === 'disable') return await disable()
          return await status()
        } catch (error) {
          return fail(error)
        }
      })
    },
    resume() {
      serial(async () => {
        active()
        if (!(await load()).enabled) return
        active()
        const result = await enable()
        if (result.error !== undefined) options.log(`phone access not restored: ${result.error}`)
      }).catch((error: Error) => options.log(`phone access not restored: ${error.message}`))
    },
    dispose() {
      disposed = true
      // Drain operations before releasing ownership; a replacement must await this promise.
      if (closing !== undefined) return closing
      const attempt = serial(async () => {
        cleanup ??= owned(hops)
        const file = findTailscale()
        try {
          if (cleanup !== undefined) {
            if (file === undefined) throw new Error('Tailscale CLI unavailable during cleanup')
            await release(file, cleanup)
          }
          cleanup = undefined
        } finally {
          stopHops()
        }
      })
      closing = attempt
      // Retry transient CLI failures without losing ownership of the old rules.
      void attempt.catch(() => { if (closing === attempt) closing = undefined })
      return attempt
    },
  }
}
