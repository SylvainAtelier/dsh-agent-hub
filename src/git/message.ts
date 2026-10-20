/**
 * Commit message drafting for the git pane. The deployment names a model
 * route (provider + model) in the plugin config; without one, the default
 * model new agents get is used. The model sees the change about to be
 * committed (see GitService.suggestInput) and the repo's recent subjects, and
 * answers with the message text only.
 */

import type { Suggest } from './service.ts'
import type { SuggestInput } from './types.ts'

export interface Route {
  provider: string
  model: string
}

export interface MessageSettings {
  /** Explicit route; both or neither. */
  provider?: string
  model?: string
  /** Extra instructions appended to the system prompt (language, convention, ...). */
  instructions?: string
}

/** The slice of dsh-llm's stream this module reads. */
type Chunk =
  | { type: 'text-delta'; text: string }
  | { type: 'finish'; reason: { kind: string; failure?: { message?: string } } }
  | { type: string }

export interface Llm {
  stream(options: object): AsyncIterable<Chunk>
}

const TIMEOUT_MS = 90_000
const MAX_TOKENS = 4096

export function systemPrompt(instructions?: string): string {
  const lines = [
    'You write git commit messages for the change the user is about to commit.',
    'Reply with the commit message only: no preamble, no quotes, no Markdown code fences.',
    'First line: a summary of at most 72 characters, in the imperative mood, without a trailing period.',
    'For a change that is more than a one-liner, add a blank line and a short body (a few "- " bullets) saying what changed and why. Do not restate the diff line by line.',
    'Follow the language and convention (for example Conventional Commits prefixes like "feat:" or "fix:") of the recent commit subjects when they show one; otherwise write in English.',
  ]
  const extra = instructions?.trim()
  if (extra) lines.push('', 'Additional instructions from the repository owner:', extra)
  return lines.join('\n')
}

export function userPrompt(input: SuggestInput): string {
  const parts: string[] = []
  if (input.branch) parts.push(`Branch: ${input.branch}`)
  parts.push(input.scope === 'staged' ? 'Scope: staged changes only.' : 'Scope: every change in the work tree (nothing is staged, so all of it will be committed).')
  if (input.recent.length > 0) parts.push(`Recent commit subjects (newest first):\n${input.recent.map((subject) => `- ${subject}`).join('\n')}`)
  if (input.stat !== '') parts.push(`Summary:\n${input.stat}`)
  if (input.patch !== '') parts.push(`Diff:\n${input.patch}`)
  if (input.untracked.length > 0) {
    parts.push(`New files:\n${input.untracked.map((file) => file.text === undefined
      ? `--- ${file.path}`
      : `--- ${file.path}\n${file.text}`).join('\n')}`)
  }
  if (input.truncated) parts.push('(The change was too large to show in full; parts are omitted.)')
  return parts.join('\n\n')
}

/** Strip what models add despite being asked not to: fences, quotes, a "Commit message:" label. */
export function cleanMessage(text: string): string {
  let out = text.replace(/\r\n/g, '\n').trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(out)
  if (fenced) out = fenced[1]!.trim()
  out = out.replace(/^(commit message|提交信息)\s*[:：]\s*/i, '')
  if (/^(["'`“])[\s\S]*(["'`”])$/.test(out) && !out.slice(1, -1).includes('\n\n')) out = out.slice(1, -1).trim()
  return out
}

/**
 * A model's reply text, `onText` hearing it as it streams. A reply cut at the token cap is still
 * usable; any other stop with no text is the stream's failure.
 */
export async function replyText(chunks: AsyncIterable<Chunk>, onText?: (text: string) => void): Promise<string> {
  let text = ''
  let failure: string | undefined
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      const delta = (chunk as { text?: string }).text ?? ''
      text += delta
      if (delta !== '') onText?.(delta)
    } else if (chunk.type === 'finish') {
      const reason = (chunk as Extract<Chunk, { type: 'finish' }>).reason
      if (reason !== undefined && reason.kind !== 'stop' && reason.kind !== 'max-tokens') failure = reason.failure?.message ?? `model stopped: ${reason.kind}`
    }
  }
  if (failure !== undefined && text.trim() === '') throw new Error(failure)
  return text
}

/** `settings` is read per suggestion, so edits from the settings page apply to the next one. */
export function createSuggest(llm: () => Llm | undefined, route: () => Route | undefined, settings: () => MessageSettings): Suggest {
  return async (input) => {
    const service = llm()
    const target = route()
    if (service === undefined || target === undefined) {
      throw Object.assign(new Error('no commit message model is configured'), { code: 'unavailable' })
    }
    return cleanMessage(await replyText(service.stream({
      provider: target.provider,
      model: target.model,
      system: systemPrompt(settings().instructions),
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt(input) }] }],
      maxTokens: MAX_TOKENS,
      purpose: 'git-commit-message',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })))
  }
}

/** The configured route, else the deployment's default agent model. */
export function resolveRoute(settings: MessageSettings, fallback: () => Route | undefined): Route | undefined {
  const provider = settings.provider?.trim()
  const model = settings.model?.trim()
  if (provider && model) return { provider, model }
  return fallback()
}
