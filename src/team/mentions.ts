/**
 * The group chat's wording. `@name` in a message to the Team Lead addresses a
 * member (or a bot, which then joins). Only roster names and bot ids count
 * (so e-mail addresses and stray `@` stay text), a mention must start the
 * text or follow whitespace, and `@all` addresses every member.
 *
 * What the group says is kept once, in the Lead's session: a member hears
 * what it missed when it is next addressed (`digest`), and a member's reply
 * to the user is shown there as a relayed assistant message (`relayText`).
 */

export const ALL = ['all', '全员', '所有人'] as const

/** Source of the note the Lead gets after an @mention; Claude Agent reads it too (claude/translate.ts). */
export const TEAM_NOTE = { kind: 'plugin:dsh-agent-hub/team' } as const

/** The names a message addresses, in `names` order; `@all` stands for `everyone`. */
export function mentioned(text: string, names: readonly string[], everyone: readonly string[] = names): string[] {
  const found = new Set<string>()
  const byKey = new Map(names.map((name) => [name.toLowerCase(), name]))
  for (const match of text.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)) {
    const key = match[1]!.toLowerCase()
    if ((ALL as readonly string[]).includes(key)) {
      for (const name of everyone) found.add(name)
      continue
    }
    const name = byKey.get(key) ?? longestPrefix(key, byKey)
    if (name !== undefined) found.add(name)
  }
  return names.filter((name) => found.has(name))
}

/** `@reviewer，看下` in CJK text has no space after the name; take the longest name the token starts with. */
function longestPrefix(token: string, byKey: ReadonlyMap<string, string>): string | undefined {
  let best: string | undefined
  for (const [key, name] of byKey) {
    if (token.startsWith(key) && !/[a-z0-9_-]/.test(token[key.length] ?? '') && key.length > (best?.length ?? 0)) best = name
  }
  return best
}

/** The team runtime's own opening for a new teammate (`spawn_teammate`). */
export function teammateReminder(name: string): string {
  return `<system-reminder>
You are teammate "${name}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`
}

/** What a member receives: what it missed, then the user's words, marked as theirs. */
export function deliveredText(text: string, digest = ''): string {
  const missed = digest === '' ? '' : `<group-chat>\nSaid in the group chat since you last heard from it, oldest first:\n\n${digest}\n</group-chat>\n\n`
  return `${missed}[Message from the user, addressed to you with @ in the group chat. Reply with send_message to "lead": the user sees that message as yours.]\n\n${text}`
}

/** What the Lead is told when it runs anyway (the message arrived mid-turn): the members have it. */
export function leadNote(names: readonly string[]): string {
  const list = names.map((name) => `@${name}`).join(', ')
  return `[agent-hub] The user's message above was already delivered to ${list} directly. Do not forward it again or do that work yourself. Unless the user also asked you something, reply with one short line at most.`
}

/** The Lead's reply to a message only for members: where it went. */
export function receipt(names: readonly string[]): string {
  return `→ ${names.map((name) => `@${name}`).join(' ')}`
}

/** A member's reply, shown to the user as the Lead's reply in its place. */
export function relayText(name: string, text: string): string {
  return `**@${name}**\n\n${text}`
}

/** What stays of the member's message in the Lead's history: the text itself is in the relay that follows. */
export function relayStub(name: string): string {
  return `[agent-hub] ${name} replied to the user; the reply is relayed verbatim in the assistant message that follows.`
}

const RELAY = /\*\*@([a-z][a-z0-9-]*)\*\*\n\n([\s\S]*?)(?=\n\n\*\*@[a-z][a-z0-9-]*\*\*\n\n|$)/g

/** One thing said in the group: by the user, the Lead (`lead`) or a member. */
export interface Line {
  from: string
  text: string
}

interface Event {
  type?: string
  data?: { role?: string; content?: unknown; source?: { kind?: string }; message?: { content?: unknown } }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n').trim()
}

/** The group chat in a Lead's session log: what the user typed, what the Lead said, and the relayed replies. */
export function groupLines(events: readonly unknown[]): Line[] {
  const lines: Line[] = []
  for (const event of events as readonly Event[]) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textOf(event.data.content)
      if (text !== '') lines.push({ from: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text === '') continue
      if (!text.startsWith('→ @') && !text.startsWith('**@')) {
        lines.push({ from: 'lead', text })
        continue
      }
      for (const match of text.matchAll(RELAY)) lines.push({ from: match[1]!, text: match[2]!.trim() })
    }
  }
  return lines
}

/** The newest lines `name` did not say, oldest first, within `limit` lines and `budget` characters. */
export function digest(lines: readonly Line[], name: string, limit = Infinity, budget = 6000): string {
  const out: string[] = []
  let left = budget
  for (let index = lines.length - 1; index >= 0 && out.length < limit; index--) {
    const line = lines[index]!
    if (line.from === name) continue
    const text = `${line.from}: ${line.text}`
    if (text.length > left) {
      if (out.length === 0) out.push(`${text.slice(0, left - 1)}…`)
      break
    }
    left -= text.length
    out.push(text)
  }
  return out.reverse().join('\n\n')
}
