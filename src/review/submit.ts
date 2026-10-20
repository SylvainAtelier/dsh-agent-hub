/**
 * A sheet as the review GitHub would get: the decision as the event, the summary as the body,
 * each picked finding as a comment on its line. A finding whose line is not part of the diff
 * (GitHub would refuse the whole review) joins the body instead. What cannot be posted as it is
 * is listed, never fixed silently: the preview shows it and the post is refused. New commits since
 * the analysis only warn: the review posts on the commit the analysis read, where its lines are.
 */

import { formatLocation } from './sheet.ts'
import { DASHES, type ReviewPreview, type ReviewProblem, type ReviewWarning, type Sheet } from './types.ts'
import type { ReviewPayload } from './github.ts'

const EVENTS = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' } as const

export interface BuildOptions {
  /** The diff's commentable new-side lines by file, at the analysed head; undefined while unknown (every finding then joins the body). */
  lines?: ReadonlyMap<string, ReadonlySet<number>>
  /** The signed-in account and the pull request's author: nobody approves their own. */
  viewer?: string
  author?: string
  /** The pull request's head now. */
  remoteHead?: string
}

export function buildReview(sheet: Sheet, options: BuildOptions = {}): ReviewPreview {
  const picked = sheet.findings.filter((finding) => finding.checked)
  const comments: ReviewPreview['comments'] = []
  const folded: string[] = []
  const foldedText: string[] = []
  for (const finding of picked) {
    const body = finding.en.trim()
    const lines = finding.path === undefined ? undefined : options.lines?.get(finding.path)
    const placed = finding.line !== undefined && lines?.has(finding.line) === true && (finding.start === undefined || lines.has(finding.start))
    if (placed) {
      comments.push({ id: finding.id, path: finding.path!, line: finding.line!, ...(finding.start === undefined ? {} : { start: finding.start }), body })
      continue
    }
    folded.push(finding.id)
    const where = formatLocation(finding)
    foldedText.push(where === undefined ? body : `**\`${where}\`** ${body}`)
  }
  const body = [sheet.summary.trim(), ...foldedText].filter((part) => part !== '').join('\n\n')

  const problems: ReviewProblem[] = []
  if (sheet.review !== undefined) problems.push({ code: 'submitted' })
  if (sheet.status === 'analyzing') problems.push({ code: 'analyzing' })
  const empty = picked.filter((finding) => finding.en.trim() === '').map((finding) => finding.id)
  if (empty.length > 0) problems.push({ code: 'empty', ids: empty })
  const dashed = [...(DASHES.test(sheet.summary) ? ['summary'] : []), ...picked.filter((finding) => DASHES.test(finding.en)).map((finding) => finding.id)]
  if (dashed.length > 0) problems.push({ code: 'dash', ids: dashed })
  if (sheet.decision === 'approve' && options.viewer !== undefined && options.author !== undefined && options.viewer !== ''
    && options.viewer.toLowerCase() === options.author.toLowerCase()) problems.push({ code: 'own' })
  if (sheet.decision === 'request-changes' && body === '') problems.push({ code: 'body' })
  if (sheet.decision === 'comment' && body === '' && comments.length === 0) problems.push({ code: 'nothing' })
  const warnings: ReviewWarning[] = []
  if (options.remoteHead !== undefined && !sameCommit(options.remoteHead, sheet.head)) warnings.push({ code: 'stale' })

  return {
    event: EVENTS[sheet.decision],
    body,
    comments,
    folded,
    problems,
    warnings,
    head: sheet.head,
    ...(options.remoteHead === undefined ? {} : { remoteHead: options.remoteHead }),
  }
}

/** A short and a full sha of the same commit compare equal. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x))
}

/** The request body GitHub takes; the head is the one the sheet was analysed at. */
export function reviewPayload(preview: ReviewPreview, commit: string): ReviewPayload {
  return {
    commit_id: commit,
    event: preview.event,
    body: preview.body,
    comments: preview.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: 'RIGHT' as const,
      ...(comment.start === undefined ? {} : { start_line: comment.start, start_side: 'RIGHT' as const }),
      body: comment.body,
    })),
  }
}
