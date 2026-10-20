/**
 * What a review session is told. The fixed part (read-only rules, how to read the pull request,
 * the sheet's format, the comment style) is a system prompt section of every review session, so
 * compaction never drops it; the pull request's own facts are its first message. The analysis
 * itself — what to look for, how to sort it — is the review bot's persona (设置 → Agent Hub →
 * Bots), or {@link defaultAnalysis} when that bot is missing.
 */

import { localized } from '../locale.ts'
import type { Thread } from './github.ts'
import { findingOfThread, reviewRef, REVIEW_DIR, sheetName, standOf, type Finding, type PullRemark, type PullThread } from './types.ts'

/** The system prompt section review sessions carry. */
export const REVIEW_SECTION = 'agent-hub:review'

const ANALYSIS = {
  zh: `针对这个 PR 找出修改并进行深入分析，进行全面代码审阅：先解释这次变更具体实现了什么，再针对所做的修改进行详细的 review，给出建设性的建议。
如果之前是 bugbot 提出的并且已经 resolve 了的，则过滤掉不再列出来。
分为 2 类：
- 必须进行修改的地方，否则会有风险；如果没有则跳过这部分，不要为了提出而提出
- 可以进行优化的地方，但不紧急
使用中文说明。`,
  en: `Find what this PR changes and analyse it in depth for a thorough code review: first explain what the change actually implements, then review the changes in detail and give constructive suggestions.
Leave out anything bugbot raised earlier that has since been resolved.
Sort the findings into 2 kinds:
- What must change, or it is a risk; if there is nothing, skip this part rather than raise something for its own sake
- What could be improved, but is not urgent
Write the explanations in English.`,
}

/** The analysis prompt when the review bot is missing, in the UI language. */
export function defaultAnalysis(): string {
  return localized(ANALYSIS)
}

/** The comment style's Chinese default: the Config's default too, so a style equal to it reads as unset. */
export const DEFAULT_STYLE = `评论使用英文。
每条评论先肯定代码的实现，再说问题或建议。
用词尽可能简短、简单、直接、精炼、自然，避免 bot 味道，尽可能口语化。
不要使用破折号（— 或 –）。`

const STYLE_EN = `Write comments in English.
Open each comment by acknowledging what the code does well, then give the problem or suggestion.
Keep the wording short, simple, direct, tight and natural, conversational, with no bot tone.
Do not use dashes (— or –).`

/** The comment style to apply: `style` as set, or the default in the UI language when blank or left at the default. */
export function commentStyle(style: string): string {
  const own = style.trim()
  return own === '' || own === DEFAULT_STYLE ? localized({ zh: DEFAULT_STYLE, en: STYLE_EN }) : own
}

const FORMAT = `---
pr: owner/repo#123        # keep every field you are not told to set exactly as written
status: ready             # analyzing while you work; ready when the sheet is complete
decision: request-changes # your recommendation: request-changes when anything is under Must fix, else approve
summary: <one line: the review's overall comment, in the comment style>
---

## Overview

<what the change does and how, in the user's language: short paragraphs or bullets>

## Must fix

- [x] F1 \`src/payments/webhook.ts:88\` <what is wrong and why it is a risk, in the user's language>
  <more lines of explanation, indented two spaces>
  > EN: <the comment to post on that line, in the comment style>

## Nice to have

- [ ] F2 \`src/payments/webhook.ts:120-131\` <the suggestion and why>
  > EN: <the comment>

## Rules

<the user's rules for this pull request: keep as written>

## Notes

<keep what is there; add short notes when asked>`

/** The fixed instructions of every review session: read-only, reading by ref, the sheet, the comment style. */
export function reviewSection(style: string): string {
  return `# Pull request review session

This session reviews one GitHub pull request and keeps the result in a review sheet, a Markdown file in \`${REVIEW_DIR}/\` of the repository. The user reads the sheet in a form, picks what to post and confirms; the host then posts the review. Treat the session as read-only:

- Never switch branches, check out, reset, stash, commit, or edit tracked files. The working tree is checked out on some other branch: it is NOT the pull request's code, so do not read the changed files from it.
- Read the pull request from its refs only: \`git diff <base>...<head>\` for the change, \`git show <head>:<path>\` for a file as the pull request has it, \`git grep -n <pattern> <head>\` to search it, \`git log <base>..<head>\` for its commits.
- Write the review sheet; other files only in folders git does not track (build output, caches, scratch, \`node_modules\`) or outside the repository. Never in a folder holding tracked files, never under \`.git\`.
- Never post to GitHub yourself: no \`gh pr review\`, \`gh pr comment\` or \`gh api\` writes. The host posts after the user confirms.

## The review sheet

Edit the sheet file in place and keep this format exactly; the form is generated from it:

\`\`\`markdown
${FORMAT}
\`\`\`

- Finding ids are F1, F2, … unique across both sections. Must fix items start checked \`[x]\`, Nice to have items unchecked \`[ ]\`.
- A location is the repository-relative path and the line (or \`start-end\` range) on the pull request's head side, on lines the diff changes or shows, so the comment can be placed there. Leave the location out for a remark about the whole change.
- Leave a section empty rather than inventing findings; an empty Must fix is a good outcome.
- When the user later asks you to change the sheet (a finding, a comment, the decision) or adds rules, edit the file the same way.
- A \`## Mine\` section (items M1, M2, …) holds the user's own comments: keep it exactly as written, and do not review, repeat or count them.

## Comment style (the EN lines and the summary)

${commentStyle(style)}`
}

export interface Brief {
  slug: string
  number: number
  title: string
  url: string
  author: string
  base: string
  /** The remote-tracking ref of the base branch, and the pull request's own ref. */
  baseRef: string
  head: string
  round: number
  stat: string
  threads: readonly Thread[]
  rules: string
  /** The bot's persona carries the analysis prompt; without the bot, the default goes here. */
  analysis?: string
  /** Round 2 and later: the head the last round read, and where its sheet was kept. */
  previous?: { head: string; sheet: string }
  /** Its stack, from {@link stackSection}; empty or absent: none. */
  stack?: string
  /** After a review of mine was submitted: what followed it, from {@link followSection}. */
  followed?: string
}

/** A pull request of the same stack; `range` when it was fetched to be read as context. */
export interface StackPull {
  number: number
  title: string
  author: string
  range?: string
}

/** The stack a pull request is in: what it builds on (nearest first), what is built on it, and how to read the ones picked. */
export function stackSection(stack: { below: readonly StackPull[]; above: readonly StackPull[] }): string {
  const line = (place: string) => (pull: StackPull): string =>
    `- ${place} #${pull.number} "${clip(pull.title, 120)}"${pull.author === '' ? '' : ` @${pull.author}`}${pull.range === undefined ? '' : `: \`git diff ${pull.range}\``}`
  const lines = [
    'This pull request is part of a stack (open pull requests based on one another\'s branches):',
    ...stack.below.map(line('below, it builds on')),
    ...stack.above.map(line('above, built on it')),
  ]
  if ([...stack.below, ...stack.above].some((pull) => pull.range !== undefined)) {
    lines.push('Read the ones given with a command as context only (read-only, like this one): what this change builds on, or whether a concern is handled further up the stack; then say so rather than flag it. Findings stay on this pull request\'s own diff.')
  }
  return lines.join('\n')
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)
const flat = (text: string, max: number): string => clip(text.replace(/\s+/g, ' ').trim(), max)

/**
 * What followed the last review I submitted, for the round after it: each thread I started, where
 * it stands and what was said after my comment, then what others said outside the threads since.
 */
export function followSection(input: {
  submitted: string
  viewer: string
  /** The threads I started. */
  threads: ReadonlyArray<Pick<PullThread, 'path' | 'line' | 'resolved' | 'outdated' | 'comments'>>
  remarks: readonly PullRemark[]
  /** The last round's, to name the comments by. */
  findings: ReadonlyArray<Pick<Finding, 'id' | 'path' | 'en'>>
}): string {
  if (input.threads.length === 0 && input.remarks.length === 0) return ''
  const me = input.viewer.toLowerCase()
  const lines = [`Since your last review (submitted ${input.submitted}):`]
  if (input.threads.length > 0) lines.push('', 'The comments you posted, and how each was answered:')
  for (const thread of input.threads.slice(0, 30)) {
    const [first, ...after] = thread.comments
    const finding = findingOfThread(thread, input.findings)
    const last = thread.comments.at(-1)
    const stand = standOf({ resolved: thread.resolved, outdated: thread.outdated, replied: last !== undefined && last.author.toLowerCase() !== me })
    lines.push(`- ${finding === undefined ? '' : `${finding.id} `}\`${thread.path}${thread.line === undefined ? '' : `:${thread.line}`}\` (${stand}): ${flat(first?.body ?? '', 300)}`)
    for (const reply of after.slice(-5)) lines.push(`  - @${reply.author || 'someone'}: ${flat(reply.body, 400)}`)
  }
  if (input.remarks.length > 0) {
    lines.push('', 'Said elsewhere on the pull request:')
    for (const remark of input.remarks.slice(-20)) lines.push(`- @${remark.author || 'someone'}${remark.state === undefined ? '' : ` (review, ${remark.state.toLowerCase()})`}: ${flat(remark.body, 400)}`)
  }
  lines.push('', 'Check each against the code now: say which earlier findings are addressed, which were answered with a reason that holds, and which still stand. A finding still standing goes on the sheet again.')
  return lines.join('\n')
}

/** The first message of a review session: the pull request, where to read it, what to write. */
export function firstMessage(brief: Brief): string {
  const ref = reviewRef(brief.number)
  const lines = [
    `Review pull request ${brief.slug}#${brief.number}: ${brief.title}`,
    `${brief.url} · by @${brief.author} · base \`${brief.base}\` · head \`${brief.head.slice(0, 12)}\` · round ${brief.round}`,
    '',
    'Already fetched (read-only):',
    `- base: \`${brief.baseRef}\`, head: \`${ref}\``,
    `- the change: \`git diff ${brief.baseRef}...${ref}\``,
  ]
  if (brief.previous !== undefined) {
    lines.push(`- new since the last review: \`git diff ${brief.previous.head}..${ref}\`; the last round's sheet is \`${brief.previous.sheet}\`. Focus on what changed, and say which earlier findings are now addressed.`)
  }
  if (brief.stat.trim() !== '') lines.push('', 'Changed files:', '```', clip(brief.stat.trim(), 6000), '```')
  if (brief.threads.length > 0) {
    lines.push('', 'Open review threads (unresolved; do not repeat them as findings):')
    for (const thread of brief.threads.slice(0, 30)) {
      lines.push(`- \`${thread.path}${thread.line === undefined ? '' : `:${thread.line}`}\` @${thread.author}${thread.outdated ? ' (outdated)' : ''}: ${clip(thread.body.replace(/\s+/g, ' '), 300)}`)
    }
  }
  if (brief.followed !== undefined && brief.followed.trim() !== '') lines.push('', brief.followed.trim())
  if (brief.stack !== undefined && brief.stack.trim() !== '') lines.push('', brief.stack.trim())
  if (brief.rules.trim() !== '') lines.push('', 'Rules for this review:', brief.rules.trim())
  if (brief.analysis !== undefined) lines.push('', 'How to review:', brief.analysis.trim())
  lines.push(
    '',
    `Write the review sheet \`${REVIEW_DIR}/${sheetName(brief.number)}\`: it exists with the front matter filled in. Fill in Overview, Must fix and Nice to have, set decision and summary, then set \`status: ready\`. Finally reply with a short summary of the review.`,
  )
  return lines.join('\n')
}

/** The helper model's brief for a question about one finding. */
export function askPrompt(input: { finding: Finding; question: string; hunk: string; file: string; path?: string }): { system: string; user: string } {
  const where = input.finding.path === undefined ? '' : ` at \`${input.finding.path}${input.finding.line === undefined ? '' : `:${input.finding.line}`}\``
  return {
    system: 'You help a code reviewer understand one finding of a pull request review. Answer the question directly and concisely, in the language the question is asked in. '
      + 'Ground the answer in the code shown; cite `path:line`. If the code shown is not enough to be sure, say what would settle it.',
    user: [
      `Finding ${input.finding.id}${where}:`,
      input.finding.text,
      ...(input.hunk.trim() === '' ? [] : ['', 'The change to this file:', '```diff', input.hunk.trim(), '```']),
      ...(input.file.trim() === '' ? [] : ['', `The file as the pull request has it${input.path === undefined ? '' : ` (${input.path})`}:`, '```', input.file.trimEnd(), '```']),
      '',
      `Question: ${input.question.trim()}`,
    ].join('\n'),
  }
}

/** The helper model's brief for rewriting a finding's comment in the configured style. */
export function rewritePrompt(input: { finding: Finding; style: string; hint?: string }): { system: string; user: string } {
  return {
    system: `You write one code review comment for a GitHub pull request. Reply with the comment text only: no preamble, no quotes.\n\nStyle:\n${commentStyle(input.style)}`,
    user: [
      `What the reviewer found${input.finding.path === undefined ? '' : ` at \`${input.finding.path}${input.finding.line === undefined ? '' : `:${input.finding.line}`}\``}:`,
      input.finding.text,
      ...(input.finding.en.trim() === '' ? [] : ['', 'The current comment:', input.finding.en.trim()]),
      ...(input.hint === undefined || input.hint.trim() === '' ? [] : ['', `What to change: ${input.hint.trim()}`]),
    ].join('\n'),
  }
}

/**
 * A bot's brief for a comment I wrote myself: make it the comment to post, its meaning untouched.
 * The bot's persona says how (translate, polish); the comment style applies as to any comment.
 */
export function composePrompt(input: { persona: string; style: string; text: string; path?: string; start?: number; end?: number; diff?: string }): { system: string; user: string } {
  const lines = input.start === undefined ? '' : input.end === undefined || input.end === input.start ? `:${input.start}` : `:${input.start}-${input.end}`
  return {
    system: `${input.persona}\n\n`
      + 'You turn a reviewer\'s own note into the comment posted on those lines of a GitHub pull request. Reply with the comment text only: no preamble, no quotes. '
      + 'Keep its meaning and every point it makes; add no finding, judgement or claim of your own. Keep code, identifiers, links and Markdown (code blocks, suggestion blocks) exactly as written.'
      + `\n\nStyle:\n${commentStyle(input.style)}`,
    user: [
      ...(input.path === undefined ? [] : [`The lines it is on, \`${input.path}${lines}\`:`, '```diff', (input.diff ?? '').trim().slice(0, 12_000), '```', '']),
      'The note:',
      input.text.trim(),
    ].join('\n'),
  }
}

const EXPLAIN_PARTS = {
  zh: { lang: 'Chinese', parts: ['**目的**', '**作用**', '**如何生效**', '**注意**'] },
  en: { lang: 'English', parts: ['**Purpose**', '**Effect**', '**How it takes effect**', '**Watch out**'] },
} as const

/** How a change is explained when 设置 → 审核 leaves it blank: its parts, titled in the reader's language. */
export function explainGuide(lang: 'zh' | 'en'): string {
  const { parts } = EXPLAIN_PARTS[lang]
  return [
    `Explain this change in these parts, each one to three short sentences or bullets:`,
    `${parts[0]}: why it is changed, the problem or need behind it.`,
    `${parts[1]}: what behaves differently once it is in.`,
    `${parts[2]}: how it comes into play: who calls it, where it is registered, configured or wired in.`,
    `Add ${parts[3]} only for a real risk the change brings.`,
  ].join('\n')
}

/**
 * The helper model's brief for explaining part of a pull request's diff; follow-ups continue the same
 * conversation. `guide` (设置 → 审核) says how to explain; what is explained is always laid out here.
 */
export function explainPrompt(input: {
  lang: 'zh' | 'en'
  title: string
  overview: string
  path: string
  label: string
  diff: string
  excerpt: string
  uses: string
  guide?: string
}): { system: string; user: string } {
  const { lang } = EXPLAIN_PARTS[input.lang]
  return {
    system: `You explain a change in a pull request to the reviewer reading it. Be concrete and brief, plain words, no filler. `
      + `Ground every claim in the code shown and cite \`path:line\` where it helps. If what is shown is not enough to be sure, say so and what would settle it. `
      + `Answer in ${lang}.`,
    user: [
      `Pull request: ${input.title}`,
      ...(input.overview.trim() === '' ? [] : ['', 'What the reviewer was told the pull request does:', input.overview.trim()]),
      '',
      `The change to explain, ${input.label}:`,
      '```diff', input.diff.trim(), '```',
      ...(input.excerpt.trim() === '' ? [] : ['', `\`${input.path}\` as the pull request has it, around the change:`, '```', input.excerpt.trimEnd(), '```']),
      ...(input.uses.trim() === '' ? [] : ['', 'Where the names it touches are used, at the pull request\'s head:', '```', input.uses.trimEnd(), '```']),
      '',
      input.guide?.trim() || explainGuide(input.lang),
    ].join('\n'),
  }
}
