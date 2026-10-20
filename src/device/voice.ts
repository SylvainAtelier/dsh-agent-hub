/**
 * Voice from the device: it streams raw 16 kHz 16-bit mono PCM while G0 is
 * held; on release the host wraps it as WAV and hands it to a speech
 * recognizer. MiniMax's `asr-1.0` uses the key DSH already keeps for its
 * MiniMax routes; any OpenAI-compatible `/audio/transcriptions` service
 * (OpenAI, a SenseVoice or whisper server on this machine) is the other
 * choice. The device never holds a key.
 *
 * Spoken file names come back as words ("view 点 ts"); names that exist in
 * the session's workspace are put back together (`view.ts`).
 */

import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SttProvider } from './types.ts'

export const RATE = 16_000
/** The longest recording kept: two minutes (3.84 MB). */
export const MAX_PCM = RATE * 2 * 120

export function wav(pcm: Buffer | readonly Buffer[], rate = RATE): Buffer {
  const chunks = Buffer.isBuffer(pcm) ? [pcm] : pcm
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const header = Buffer.allocUnsafe(44 + length)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(length, 40)
  let at = 44
  for (const chunk of chunks) { chunk.copy(header, at); at += chunk.length }
  return header
}

export interface SttSettings {
  stt: SttProvider
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://127.0.0.1:8000/v1. */
  sttUrl?: string
  sttModel?: string
  /** BCP-47 language; blank detects it (mixed Chinese and English). */
  language?: string
}

export interface SttKey {
  key?: string
  /** MiniMax's API host for the key (api.minimaxi.com or api.minimax.io). */
  host?: string
}

export async function transcribe(audio: Buffer, settings: SttSettings, credential: SttKey, hints: readonly string[], signal?: AbortSignal): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'voice.wav')
  const headers: Record<string, string> = {}
  if (credential.key) headers.authorization = `Bearer ${credential.key}`
  let url: string
  if (settings.stt === 'minimax') {
    if (!credential.key) throw new Error('No MiniMax API key in DSH: sign in to a MiniMax model first')
    url = `https://${credential.host ?? 'api.minimaxi.com'}/v1/speech_to_text`
    form.append('model', 'asr-1.0')
    if (settings.language) headers.language = settings.language
  } else {
    const base = settings.sttUrl?.trim().replace(/\/+$/, '')
    if (!base) throw new Error('Set the speech recognition URL first')
    url = `${base}/audio/transcriptions`
    form.append('model', settings.sttModel?.trim() || 'whisper-1')
    if (settings.language) form.append('language', settings.language)
    // Whisper-style services bias their spelling toward the prompt's words.
    if (hints.length > 0) form.append('prompt', hints.slice(0, 60).join(', '))
  }
  const response = await fetch(url, { method: 'POST', body: form, headers, signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  const body = await readReply(response) as { text?: unknown; error?: { message?: unknown }; base_resp?: { status_msg?: unknown } } | undefined
  if (!response.ok) {
    const reason = body?.error?.message ?? body?.base_resp?.status_msg ?? response.statusText
    throw new Error(`Speech recognition failed (${response.status}): ${String(reason)}`)
  }
  if (typeof body?.text !== 'string') throw new Error('Speech recognition returned an invalid response')
  const text = body.text.trim()
  if ([...text].length > 4000) throw new Error('Speech recognition returned too much text')
  return text
}

async function readReply(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 64 * 1024) throw new Error('Speech recognition response too large')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown } catch { return undefined }
}

/** "view 点 ts", "view dot ts", "view.TS" → `view.ts`, when that name exists in the workspace. */
export function correct(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return text
  return text.replace(/([A-Za-z0-9_\-]+)\s*(?:\.|。|点|dot)\s*([A-Za-z0-9]{1,8})\b/gi, (whole, stem: string, ext: string) => {
    const name = `${stem}.${ext}`.toLowerCase()
    return names.has(name) ? `${stem}.${ext.toLowerCase()}` : whole
  })
}

const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'lib', '.next', '.venv', '__pycache__'])
const vocabularies = new Map<string, { at: number; names: Promise<Set<string>> }>()

/** File names in a workspace, three levels deep, lower-cased; cached for a minute. */
export function vocabulary(cwd: string): Promise<Set<string>> {
  if (cwd === '') return Promise.resolve(new Set())
  const cached = vocabularies.get(cwd)
  if (cached !== undefined && Date.now() - cached.at < 60_000) {
    vocabularies.delete(cwd)
    vocabularies.set(cwd, cached)
    return cached.names
  }
  // LRU cap prevents visiting many worktrees from retaining names forever.
  vocabularies.delete(cwd)
  while (vocabularies.size >= 8) vocabularies.delete(vocabularies.keys().next().value!)
  const names = (async () => {
    const found = new Set<string>()
    let directories = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || found.size >= 3000 || directories++ >= 128) return
      try {
        // Stream directory entries instead of materializing a potentially huge folder.
        for await (const entry of await opendir(dir)) {
          if (found.size >= 3000) break
          if (entry.name.startsWith('.') && entry.name !== '.github') continue
          if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) await walk(join(dir, entry.name), depth + 1)
          } else if (entry.isFile()) found.add(entry.name.toLowerCase())
        }
      } catch {
        // A disappearing or unreadable directory cannot fail dictation.
      }
    }
    await walk(cwd, 0)
    return found
  })()
  vocabularies.set(cwd, { at: Date.now(), names })
  return names
}
