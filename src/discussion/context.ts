/**
 * What a discussion about a document gives its model, by level: the selection alone, the section
 * of the document it sits in (from its heading to the next one of the same or a higher level), or
 * the whole document. Pure, so the page shows the same size the host will send.
 */

export type DiscussionScope = 'selection' | 'section' | 'article'
export const SCOPES: readonly DiscussionScope[] = ['selection', 'section', 'article']
/** A longer document is cut: the model's context stays bounded. */
export const MAX_DOCUMENT = 120_000

/** A discussion kept with a reader article rather than a session: `doc:` and the article's key. */
export const DOC_OWNER = /^doc:[a-f0-9]{16}$/
export const isDocOwner = (owner: string): boolean => DOC_OWNER.test(owner)

/** Markdown reduced to the text a page shows, whitespace collapsed: what a selection is matched in. */
export function flatText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, '')
}

interface Heading { line: number; level: number }

function headings(lines: readonly string[]): Heading[] {
  const out: Heading[] = []
  let fence = false
  lines.forEach((line, index) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    const match = /^\s{0,3}(#{1,6})\s/.exec(line)
    if (match !== null) out.push({ line: index, level: match[1]!.length })
  })
  return out
}

/** The section holding `quote`; the whole document when it cannot be told (no headings, no match). */
export function sectionOf(markdown: string, quote: string): string {
  const lines = markdown.split('\n')
  const marks = headings(lines)
  const needle = flatText(quote).slice(0, 60)
  if (marks.length === 0 || needle === '') return markdown
  const bounds = [0, ...marks.map((mark) => mark.line), lines.length]
  for (let index = 0; index < bounds.length - 1; index++) {
    if (!flatText(lines.slice(bounds[index], bounds[index + 1]).join('\n')).includes(needle)) continue
    const own = marks.find((mark) => mark.line === bounds[index])
    // Before the first heading: the text up to it.
    if (own === undefined) return lines.slice(0, bounds[index + 1]).join('\n').trim()
    // The heading's section, its subsections included; a small one widens to its parent, but never
    // to a top-level heading, which is usually the whole document.
    const at = (level: number): string => {
      const start = [...marks].reverse().find((mark) => mark.line <= own.line && mark.level <= level)?.line ?? own.line
      const end = marks.find((mark) => mark.line > own.line && mark.level <= level)?.line ?? lines.length
      return lines.slice(start, end).join('\n').trim()
    }
    let level = own.level
    let section = at(level)
    while (section.length < 600 && level > 2) section = at(--level)
    return section
  }
  return markdown
}

/** The text a level adds beside the selection, as the model gets it. */
export function scopeText(markdown: string, quote: string, scope: DiscussionScope): string {
  if (scope === 'selection') return ''
  const text = scope === 'section' && quote !== '' ? sectionOf(markdown, quote) : markdown
  return text.length > MAX_DOCUMENT ? `${text.slice(0, MAX_DOCUMENT)}\n\n…` : text
}
