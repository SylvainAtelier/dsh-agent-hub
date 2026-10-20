/**
 * My own pull requests, answered with a response sheet: the deterministic parts, without a model.
 *
 * - What waits on me: unresolved threads whose last word is not mine, and review summaries and
 *   conversation comments left since the last round read them. An item I chose to leave (unchecked)
 *   stays left until someone adds to its thread.
 * - What the session is told: a fixed system prompt section (triage into the sheet, then do what
 *   I ask), the round's first message (the branch, its diff, every comment in full with the code
 *   it was left on), and the fix message when I fix from the sheet.
 * - What posting does, shown first: the branch's new commits pushed, a reply on each picked
 *   thread (resolved when it was fixed; a picked thread with no reply is only resolved), one
 *   conversation comment for the rest.
 * - Where a card stands, from the sheet and the threads waiting on me.
 */

import { DASHES, type ReviewPhase, type ReviewProblem, type ReviewWarning, type ResponsePreview, type Sheet } from './types.ts'
import type { Conversation, FullThread, Remark } from './github.ts'
import { localized } from '../locale.ts'

const RESPONSE = {
  zh: `逐条判断每个评论：评审人说得对吗？需要改代码吗？
- 需要改代码的放进 Fix：说明评审人指出的问题，以及准备怎么改
- 不需要改的（误解、有意为之、只是提问）放进 Reply：说明理由
- bot 的评论同样认真看待；明显误报放进 Reply 简短说明，或者不勾选
使用中文说明。`,
  en: `Judge each comment in turn: is the reviewer right? Does the code need to change?
- What needs a code change goes under Fix: say what the reviewer points out and how you plan to change it
- What needs none (a misunderstanding, a deliberate choice, just a question) goes under Reply: say why
- Take bot comments just as seriously; put a clear false positive under Reply with a short note, or leave it unchecked
Write the explanations in English.`,
}

const REPLY_STYLE = {
  zh: `回复使用英文。
简短、直接、友好，口语化，避免 bot 味道。
已修改的一句话说明改了什么；不修改的礼貌说明理由。
不要使用破折号（— 或 –）。`,
  en: `Write replies in English.
Short, direct, friendly and conversational, with no bot tone.
For a fix, say in one sentence what changed; for no change, politely give the reason.
Do not use dashes (— or –).`,
}

/** How the comments are sorted into the response sheet, in the UI language. */
export function defaultResponse(): string {
  return localized(RESPONSE)
}

/** How replies on the threads are written, in the UI language. */
export function replyStyle(): string {
  return localized(REPLY_STYLE)
}

const FORMAT = `---
pr: owner/repo#123   # keep every field you are not told to set exactly as written
role: author
status: ready        # analyzing while you work; ready when the sheet is complete; fixed once its Fix items are committed
summary: <optional: one overall comment for the pull request's conversation, in the reply style; empty for none>
---

## Overview

<what the reviewers ask for overall, in the user's language: short paragraphs or bullets>

## Fix

- [x] C1 \`src/payments/webhook.ts:88\` <what the reviewer asks, whether they are right, how you will change it, in the user's language>
  thread: PRRT_kwDOAbc123 @alice
  > EN: <the reply to post on the thread once fixed, in the reply style>

## Reply

- [x] C2 \`src/payments/webhook.ts:120\` <why no code change is needed>
  thread: PRRT_kwDOAbc456 @bob
  > EN: <the reply>
- [ ] C3 <a comment that needs no answer>
  thread: - @ci-bot

## Rules

<the user's rules for this pull request: keep as written>

## Notes

<keep what is there; add short notes when asked>`

/** The fixed instructions of every response session. */
export function respondSection(): string {
  return `# Responding to the review of the user's pull request

This session answers the review of one of the user's own GitHub pull requests. It runs in a working tree checked out on the pull request's branch (the current directory), so the code there is the pull request's.

The first message of each round lists the comments waiting on the user: read the change and every comment, decide what to do about each, and write the response sheet. After that, do what the user asks, in whatever words: fix items, change other code, rework replies, answer questions.

When you change code for items under Fix:
- Keep each change to what its comment asks, in the style of the code around it, run the quick checks that cover it, and commit with a message saying which review feedback it addresses.
- Under each fixed item, add a line on what you changed, and adjust its EN reply to say it is done.
- Once every checked item under Fix is fixed and committed, set \`status: fixed\` in the sheet, unless the message says the host sets it.

The host pushes the branch, replies on the threads and resolves them when the user posts the response from the sheet, so leave pushing and posting to GitHub to it unless the user asks otherwise. The sheet's path is given in full; edit it in place and keep its format exactly.

## The response sheet

\`\`\`markdown
${FORMAT}
\`\`\`

- One item per comment the message lists, ids C1, C2, … unique across both sections. Keep each item's \`thread:\` line exactly as given; a review summary or a conversation comment has \`thread: - @name\`.
- Fix: the reviewer is right and the code should change. Reply: no code change, say why (a misunderstanding, a deliberate choice, an answer to a question). Both start checked \`[x]\`.
- Leave an item unchecked \`[ ]\` when it needs no answer at all (noise, or already answered).
- A location is the repository-relative path and line on the branch, as the thread gives it.
- The EN line is the reply posted on the thread. Write a Fix item's as it should read once fixed; after fixing, adjust it to say briefly what changed.

## Reply style

${replyStyle()}`
}

/** What waits on me in a round: the threads, review summaries and comments the session answers. */
export interface Waiting {
  threads: FullThread[]
  reviews: Array<Remark & { state: string }>
  comments: Remark[]
}

/** Review summaries and conversation comments a round reads at most. */
const REMARKS_MAX = 20

const after = (at: string, since: number): boolean => (Date.parse(at) || 0) > since

/**
 * What waits on me now. `previous`: the last round's sheet; summaries and comments it read are not
 * read again, and a thread it chose to leave stays left until someone adds to it.
 */
export function waiting(conversation: Conversation, previous?: Pick<Sheet, 'read' | 'findings'>): Waiting {
  const me = conversation.viewer.toLowerCase()
  const since = previous?.read === undefined ? 0 : Date.parse(previous.read) || 0
  const left = new Set((previous?.findings ?? []).filter((item) => !item.checked && item.thread !== undefined).map((item) => item.thread!))
  const others = (remark: Remark): boolean => remark.author.toLowerCase() !== me && remark.body.trim() !== ''
  return {
    threads: conversation.threads.filter((thread) => {
      const last = thread.comments.at(-1)
      if (thread.resolved || last === undefined || last.author.toLowerCase() === me) return false
      return !left.has(thread.id) || after(last.at, since)
    }),
    reviews: conversation.reviews.filter((review) => others(review) && after(review.at, since)).slice(-REMARKS_MAX),
    comments: conversation.comments.filter((comment) => others(comment) && after(comment.at, since)).slice(-REMARKS_MAX),
  }
}

export const waitingCount = (items: Waiting): number => items.threads.length + items.reviews.length + items.comments.length

export interface RespondBrief {
  slug: string
  number: number
  title: string
  url: string
  branch: string
  base: string
  /** The base branch as this clone has it from the remote: `origin/main`. */
  baseRef: string
  head: string
  round: number
  /** The sheet's full path. */
  sheet: string
  stat: string
  /** The change, unified, cut at a size. */
  diff: string
  waiting: Waiting
  rules: string
  /** The bot's persona carries the analysis prompt; without the bot, the default goes here. */
  analysis?: string
  /** The last round's sheet, kept beside the new one. */
  previous?: string
  /** The branch and its remote disagree in a way the host did not settle. */
  note?: string
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)
const DIFF_CHARS = 60_000
const HUNK_LINES = 24
const day = (at: string): string => at.slice(0, 10)

/** The last lines of a thread's hunk: the code its comment is on. */
const hunkTail = (hunk: string): string => hunk.split('\n').slice(-HUNK_LINES).join('\n')

/** The first message of a round: the branch, its change, every comment waiting on me in full. */
export function respondMessage(brief: RespondBrief): string {
  const lines = [
    `Respond to the review of my pull request ${brief.slug}#${brief.number}: ${brief.title}`,
    `${brief.url} · branch \`${brief.branch}\` → \`${brief.base}\` · head \`${brief.head.slice(0, 12)}\` · round ${brief.round}`,
    '',
    `The working tree (current directory) is on \`${brief.branch}\`. The change: \`git diff ${brief.baseRef}...HEAD\`.`,
  ]
  if (brief.note !== undefined) lines.push(`Note: ${brief.note}`)
  if (brief.previous !== undefined) lines.push(`The last round's sheet is \`${brief.previous}\`: what it decided and answered still holds unless a comment below says otherwise.`)
  if (brief.stat.trim() !== '') lines.push('', 'Changed files:', '```', clip(brief.stat.trim(), 6000), '```')
  if (brief.diff.trim() !== '') {
    const cut = brief.diff.length > DIFF_CHARS
    lines.push('', `The change${cut ? ' (cut; read the rest with git)' : ''}:`, '```diff', clip(brief.diff.trimEnd(), DIFF_CHARS), '```')
  }
  const { threads, reviews, comments } = brief.waiting
  if (threads.length > 0) {
    lines.push('', 'Review threads waiting on me (unresolved, the last word not mine):')
    for (const thread of threads) {
      const where = `${thread.path}${thread.line === undefined ? '' : `:${thread.start === undefined ? '' : `${thread.start}-`}${thread.line}`}`
      lines.push('', `### thread: ${thread.id} · \`${where}\`${thread.outdated ? ' (outdated: the code moved since)' : ''}`)
      if (thread.hunk.trim() !== '') lines.push('```diff', hunkTail(thread.hunk.trimEnd()), '```')
      for (const comment of thread.comments) lines.push(`- @${comment.author} (${day(comment.at)}): ${clip(comment.body.trim(), 4000)}`)
    }
  }
  if (reviews.length > 0) {
    lines.push('', 'Review summaries:')
    for (const review of reviews) lines.push(`- @${review.author} ${review.state.toLowerCase().replace(/_/g, ' ')} (${day(review.at)}): ${clip(review.body.trim(), 4000)}`)
  }
  if (comments.length > 0) {
    lines.push('', 'Conversation comments:')
    for (const comment of comments) lines.push(`- @${comment.author} (${day(comment.at)}): ${clip(comment.body.trim(), 4000)}`)
  }
  if (waitingCount(brief.waiting) === 0) lines.push('', 'No comment waits on me now: write the sheet with empty Fix and Reply sections.')
  if (brief.rules.trim() !== '') lines.push('', 'Rules:', brief.rules.trim())
  if (brief.analysis !== undefined) lines.push('', 'How to respond:', brief.analysis.trim())
  lines.push(
    '',
    `Write the response sheet \`${brief.sheet}\`: it exists with the front matter filled in. Add one item per thread, summary and comment above, fill in Overview and summary, then set \`status: ready\`. Do not change any code yet: the user picks what to fix first. Finally reply with a short summary.`,
  )
  return lines.join('\n')
}

/** The message that starts the fix turn: the items to fix, and how to leave the branch. */
export function fixMessage(sheet: Pick<Sheet, 'findings' | 'status'>, path: string): string {
  const ids = sheet.findings.filter((item) => item.checked && item.severity === 'must').map((item) => item.id)
  return [
    `Fix the checked items under Fix in \`${path}\`: ${ids.join(', ')}. Items under Reply and unchecked ones need no code change.`,
    ...(sheet.status === 'fixed' ? ['- Some may be fixed already by an earlier turn: check the branch and the sheet, and change only what is still missing or what the sheet now asks differently.'] : []),
    '- Keep each change to what its comment asks, in the style of the code around it.',
    '- Run the quick checks that cover what you changed (type check, the affected tests) when the repository has them.',
    '- Commit once with `git commit`, a message saying which review feedback it addresses. Do not push.',
    '- In the sheet, add a line under each fixed item on what you changed, and adjust its EN reply to say it is done. Leave `status` as it is: the host sets it when this turn ends.',
    'Then reply with a short summary of the changes.',
  ].join('\n')
}

/** Where a card of mine stands, and how many threads waiting on me its sheet has not seen. */
export function ownPhase(sheet: Sheet | undefined, error: string | undefined, pending: readonly string[] | undefined): { phase: ReviewPhase; unseen?: number } {
  if (error !== undefined) return { phase: 'invalid' }
  if (sheet === undefined) return { phase: 'new' }
  const seen = new Set(sheet.findings.flatMap((item) => (item.thread === undefined ? [] : [item.thread])))
  // Once posted, each thread it answered ends with my reply: one waiting on me again has news.
  const unseen = pending === undefined ? undefined : sheet.status === 'submitted' ? pending.length : pending.filter((id) => !seen.has(id)).length
  const extra = unseen === undefined ? {} : { unseen }
  // Fixes not posted yet stay in front: new comments show as a count beside them.
  if (sheet.status === 'analyzing' || sheet.status === 'fixing' || sheet.status === 'fixed') return { phase: sheet.status, ...extra }
  return { phase: unseen !== undefined && unseen > 0 ? 'stale' : sheet.status, ...extra }
}

export interface ResponseFacts {
  /** Commits on the branch the remote lacks. */
  commits: Array<{ sha: string; subject: string }>
  /** Commits on the remote branch this one lacks. */
  behind: number
  /** Tracked changes not committed. */
  dirty: boolean
}

/** What posting the response would do, and why it cannot yet. */
export function buildResponse(sheet: Sheet, facts: ResponseFacts): ResponsePreview {
  const picked = sheet.findings.filter((item) => item.checked)
  const replies: ResponsePreview['replies'] = picked.filter((item) => item.thread !== undefined).map((item) => ({
    id: item.id,
    thread: item.thread!,
    ...(item.path === undefined ? {} : { path: item.path }),
    ...(item.line === undefined ? {} : { line: item.line }),
    ...(item.reviewer === undefined ? {} : { reviewer: item.reviewer }),
    body: item.en.trim(),
    // A reply left empty posts nothing: the thread is only resolved.
    resolve: item.severity === 'must' || item.en.trim() === '',
  }))
  const loose = picked.filter((item) => item.thread === undefined && item.en.trim() !== '')
    .map((item) => (item.reviewer === undefined ? item.en.trim() : `@${item.reviewer} ${item.en.trim()}`))
  const comment = [sheet.summary.trim(), ...loose].filter((part) => part !== '').join('\n\n')

  const problems: ReviewProblem[] = []
  if (sheet.status === 'submitted') problems.push({ code: 'submitted' })
  if (sheet.status === 'analyzing') problems.push({ code: 'analyzing' })
  if (sheet.status === 'fixing') problems.push({ code: 'fixing' })
  const unfixed = picked.filter((item) => item.severity === 'must').map((item) => item.id)
  if (sheet.status === 'ready' && unfixed.length > 0) problems.push({ code: 'unfixed', ids: unfixed })
  const dashed = [...(DASHES.test(sheet.summary) ? ['summary'] : []), ...picked.filter((item) => DASHES.test(item.en)).map((item) => item.id)]
  if (dashed.length > 0) problems.push({ code: 'dash', ids: dashed })
  if (facts.commits.length > 0 && facts.behind > 0) problems.push({ code: 'behind' })
  if (facts.commits.length === 0 && replies.length === 0 && comment === '') problems.push({ code: 'nothing' })
  const warnings: ReviewWarning[] = facts.dirty ? [{ code: 'dirty' }] : []
  return { role: 'author', branch: sheet.branch ?? '', commits: facts.commits, replies, comment, problems, warnings }
}

/** The helper model's brief for rewriting a reply in the reply style. */
export function replyPrompt(input: { text: string; en: string; hint?: string }): { system: string; user: string } {
  return {
    system: `You write one reply to a review comment on the user's own GitHub pull request. Reply with the reply text only: no preamble, no quotes.\n\nStyle:\n${replyStyle()}`,
    user: [
      'The comment and what the user decided about it:',
      input.text,
      ...(input.en.trim() === '' ? [] : ['', 'The current reply:', input.en.trim()]),
      ...(input.hint === undefined || input.hint.trim() === '' ? [] : ['', `What to change: ${input.hint.trim()}`]),
    ].join('\n'),
  }
}

/**
 * A bot's brief for turning my own note into a reply on a review thread: of my pull request
 * (`author`), or of one I reviewed. The thread so far and the lines it is on for context; the meaning stays mine.
 */
export function threadReplyPrompt(input: {
  persona: string; text: string; thread: ReadonlyArray<{ author: string; body: string }>; path?: string; diff?: string; author?: boolean
}): { system: string; user: string } {
  const who = input.author === false ? 'The reviewer' : 'The author'
  return {
    system: `${input.persona}\n\n`
      + (input.author === false
        ? 'You turn the reviewer\'s own note into their reply on a review thread they take part in on someone else\'s GitHub pull request. Reply with the reply text only: no preamble, no quotes. '
        : 'You turn the author\'s own note into their reply on a review thread of their own GitHub pull request. Reply with the reply text only: no preamble, no quotes. ')
      + 'Keep its meaning and every point it makes; add no promise, judgement or claim of your own. Keep code, identifiers, links and Markdown exactly as written.'
      + `\n\nStyle:\n${replyStyle()}`,
    user: [
      ...(input.path === undefined || input.diff === undefined ? [] : [`The lines the thread is on, \`${input.path}\`:`, '```diff', input.diff.trim().slice(0, 12_000), '```', '']),
      'The thread so far:',
      ...input.thread.map((comment) => `@${comment.author || 'someone'}: ${comment.body.trim()}`),
      '',
      `${who}'s note:`,
      input.text.trim(),
    ].join('\n'),
  }
}
