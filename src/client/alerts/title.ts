import type { AlertPhase, SentryIssue } from '../../alerts/types.ts'
import { isEnglish } from '../board/i18n.ts'

/**
 * Sentry titles at a glance: the error type apart from the message, and the
 * noise in the message (object reprs, uuids, addresses, long URLs) cut down.
 * The full title stays one click (or a hover) away.
 */

/** A Sentry title as its error type and message ("TypeError: x is undefined"), whitespace folded. */
export function splitTitle(title: string): { kind?: string; message: string } {
  const flat = title.replace(/\s+/g, ' ').trim()
  const match = /^([A-Z_$][\w$.]{1,63}):\s+(\S.*)$/.exec(flat)
  return match ? { kind: match[1]!, message: match[2]! } : { message: flat }
}

/** Long unbroken runs (URLs, paths, ids) cut in the middle, so a card's two lines carry words, not one token. */
function shortenTokens(text: string, max = 44): string {
  return text.replace(/\S+/g, (token) => token.length <= max ? token : `${token.slice(0, max - 15)}…${token.slice(-14)}`)
}

/** Noise that says little at a glance: object reprs down to their class, ids and addresses to a stub, a dangling colon. */
export function tidyTitle(text: string): string {
  return shortenTokens(text
    .replace(/<(?:[\w$]+\.)*([\w$]+) object at 0x[\da-f]+>/gi, '<$1>')
    .replace(/\b([\da-f]{8})-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, '$1…')
    .replace(/\b0x[\da-f]{8,}\b/gi, '0x…')
    .replace(/\s*[:,;]\s*$/, ''))
}

/** An issue the board's search (lower-cased, trimmed) finds: by id, title, message, culprit, project or source. */
export const issueMatches = (issue: SentryIssue, text: string): boolean =>
  [issue.id, issue.title, issue.subtitle, issue.culprit, issue.project, issue.location?.path]
    .some((field) => field?.toLowerCase().includes(text) ?? false)

const PHASES: Record<AlertPhase, [zh: string, en: string]> = {
  unanalysed: ['未分析', 'Not analysed'], preparing: ['准备中', 'Preparing'], analysing: ['分析中', 'Analysing'], analysed: ['已分析', 'Analysed'],
  fixing: ['修复中', 'Fixing'], fixed: ['已修复', 'Fixed'], regression: ['有新事件', 'New events'],
}

/** An issue's phase in words, on its card and on the chips of the pull requests fixing it. */
export const phaseName = (phase: AlertPhase): string => PHASES[phase][isEnglish() ? 1 : 0]
