/**
 * A new ticket's draft as a bot rewrites it (translated, structured, polished):
 * the brief, and its answer read back into a title and a description. The bot
 * keeps what the draft says; it writes a title when the draft has none.
 */

import type { Draft } from './types.ts'

export function ticketPrompt(input: { persona: string; title: string; note: string; repo?: string }): { system: string; user: string } {
  return {
    system: `${input.persona}\n\n`
      + 'You turn a developer\'s draft into a ticket for an issue tracker. Keep its meaning and every point it makes; add no requirement, finding or claim of your own. '
      + 'Keep code, identifiers, paths, links and Markdown exactly as written. '
      + 'Reply in exactly this shape, nothing before or after:\n'
      + 'Title: <one line, under 80 characters, no trailing period>\n\n<the description in Markdown; empty when the draft has nothing more than its title>',
    user: [
      ...(input.repo === undefined || input.repo === '' ? [] : [`Repository: ${input.repo}`, '']),
      'Title:',
      input.title.trim() === '' ? '(none: write one from the description)' : input.title.trim(),
      '',
      'Description:',
      input.note.trim() === '' ? '(none)' : input.note.trim(),
    ].join('\n'),
  }
}

/** A bot's answer as a draft: `Title: …` then the description; an answer without the label is all description. */
export function draftOf(answer: string, before: Draft): Draft {
  const text = answer.replace(/^```\w*\n([\s\S]*?)\n```$/, '$1').trim()
  const match = /^(?:\*\*)?title(?:\*\*)?[ \t]*[:：](?:\*\*)?[ \t]*(.*)\n?([\s\S]*)$/i.exec(text)
  if (match === null) return { title: before.title, note: text }
  const title = match[1]!.replace(/^#+\s*/, '').replace(/^(["“'])(.*)(["”'])$/, '$2').trim()
  return { title: title === '' ? before.title : title.slice(0, 300), note: match[2]!.trim() }
}
