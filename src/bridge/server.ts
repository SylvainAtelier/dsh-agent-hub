/**
 * The `dsh` command's way in: a loopback HTTP server of the plugin's own.
 * DSH's /api needs a browser session, which a shell has none of; this answers
 * only requests that carry this run's token (in `bridge.json`, readable by
 * this user alone), name the loopback address as Host, and come from no web
 * page (no Origin), so a site in a browser cannot reach it.
 *
 * `POST /v1/<op>` takes and answers JSON (`{ ok, value | error, code }`); a
 * hand-off's answer may take long, so its headers go out at once and the body
 * when the turn ends.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { statSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { atomicWriteJson } from '../persistence.ts'
import { ChooseError, type Bridge } from './service.ts'

const MAX_BODY = 256 << 10

export interface BridgeServer {
  url: string
  close(): Promise<void>
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('request too large')
    chunks.push(chunk as Buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
  return value as Record<string, unknown>
}

/** Start the server and write `file` (its address and token); `close` stops it and removes the file if still ours. */
export async function startBridgeServer(bridge: Bridge, file: string, log: (message: string) => void): Promise<BridgeServer> {
  const token = randomBytes(24).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  let port = 0
  const sockets = new Set<import('node:net').Socket>()

  const allowed = (request: IncomingMessage): boolean => {
    const auth = Buffer.from(request.headers.authorization ?? '')
    return auth.length === expected.length && timingSafeEqual(auth, expected)
      && request.headers.origin === undefined
      && (request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`)
  }

  const json = (response: ServerResponse, value: unknown): void => {
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!allowed(request)) {
      response.writeHead(403).end('forbidden')
      return
    }
    // The client going away (a background run killed) stops the wait, not the DSH session.
    const abort = new AbortController()
    response.on('close', () => abort.abort())

    if (request.method !== 'POST' || !url.pathname.startsWith('/v1/')) {
      response.writeHead(404).end('not found')
      return
    }
    let input: Record<string, unknown>
    try {
      input = await body(request)
    } catch (error) {
      response.writeHead(400).end((error as Error).message)
      return
    }
    const cwd = str(input.cwd) ?? ''
    try {
      const op = url.pathname.slice('/v1/'.length)
      switch (op) {
        case 'agents': return json(response, { ok: true, value: await bridge.agents() })
        case 'projects': return json(response, { ok: true, value: bridge.projects() })
        case 'status': return json(response, { ok: true, value: bridge.status(str(input.session)) })
        case 'notify':
          bridge.notify(str(input.text) ?? '')
          return json(response, { ok: true, value: null })
        // Each answers at the session's next stop (service.ts).
        case 'ask':
        case 'reply':
        case 'approve':
        case 'deny':
        case 'stop':
        case 'wait': {
          const release = bridge.hold(cwd)
          try {
            const wait = op !== 'ask' || input.wait !== false
            const session = str(input.session)
            const running = op === 'ask' ? bridge.ask({ agent: str(input.agent), model: str(input.model), project: str(input.project), cwd, text: str(input.text) ?? '', wait }, abort.signal)
              : op === 'reply' ? bridge.reply({ session, text: str(input.text) ?? '' }, abort.signal)
                : op === 'stop' ? bridge.stop(session, abort.signal)
                  : op === 'wait' ? bridge.wait(session, abort.signal)
                    : bridge.decide({ session, allow: op === 'approve' }, abort.signal)
            if (wait) {
              response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              response.flushHeaders()
            }
            return json(response, { ok: true, value: await running })
          } finally {
            release()
          }
        }
        default:
          response.writeHead(404).end('not found')
      }
    } catch (error) {
      json(response, { ok: false, code: error instanceof ChooseError ? 'choose' : 'failed', error: (error as Error).message || 'DSH could not do that' })
    }
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log(`bridge request failed: ${(error as Error).message}`)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  await atomicWriteJson(file, { url, token, pid: process.pid })

  return {
    url,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
      const saved = await readFile(file, 'utf8').catch(() => '')
      if (saved.includes(token)) await unlink(file).catch(() => {})
    },
  }
}
