/**
 * Every readable text becomes Markdown: an article page through Readability (what Firefox's reader
 * view uses, so navigation, ads and comment boxes are left behind), a feed's own full text, a
 * README or release notes (Markdown with HTML in it, normalized the same way). On the way, links
 * and images become absolute, tracking pixels and `utm_*`-style parameters are dropped, and
 * nothing that runs (scripts, frames, forms) survives. The page renders it with one Markdown
 * renderer, and the same text is what a bot is given.
 */

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { Marked } from 'marked'
import TurndownService from 'turndown'

/** A longer text is cut: a bot's context and the page both stay bounded. */
export const MAX_MARKDOWN = 200_000
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|yclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok|spm|scm)$/i

export interface Bases {
  /** Relative links resolve against it. */
  link: string
  /** Relative images resolve against it; `link` when absent. */
  image?: string
}

export interface Clean {
  markdown: string
  /** Tracking pixels and parameters removed. */
  cleaned: number
}

function absolute(href: string | null | undefined, base: string): URL | undefined {
  if (href === null || href === undefined || href.trim() === '' || href.startsWith('#')) return undefined
  try {
    const url = new URL(href.trim(), base)
    return /^(https?|mailto):$/.test(url.protocol) ? url : undefined
  } catch {
    return undefined
  }
}

/** The address with its tracking parameters dropped; how many it had. */
function untrack(href: string | null | undefined, base: string): { url?: string; dropped: number } {
  const url = absolute(href, base)
  if (url === undefined) return { dropped: 0 }
  let dropped = 0
  for (const key of [...url.searchParams.keys()]) {
    if (!TRACKING.test(key)) continue
    url.searchParams.delete(key)
    dropped++
  }
  return { url: url.href, dropped }
}

/** An address without its tracking parameters; the address as given when it is not http(s). */
export function cleanUrl(href: string): string {
  return untrack(href, href).url ?? href
}

const bracket = (text: string): string => text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()
const cell = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')

type Element = { getAttribute(name: string): string | null; querySelectorAll(selector: string): ArrayLike<Element>; textContent: string | null; nodeName: string }

export function htmlToMarkdown(html: string, bases: Bases): Clean {
  let cleaned = 0
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' })
  service.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select', 'textarea', 'svg', 'canvas', 'object', 'embed', 'template'] as never)
  service.addRule('agentHubLink', {
    filter: (node) => node.nodeName === 'A',
    replacement(content, node) {
      const { url, dropped } = untrack((node as unknown as Element).getAttribute('href'), bases.link)
      cleaned += dropped
      const text = content.trim()
      if (url === undefined) return content
      return `[${text === '' ? url : text}](${url})`
    },
  })
  service.addRule('agentHubImage', {
    filter: 'img',
    replacement(_content, node) {
      const element = node as unknown as Element
      const width = Number(element.getAttribute('width'))
      const height = Number(element.getAttribute('height'))
      if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) {
        cleaned++
        return ''
      }
      // Lazy-loading pages keep the real address aside and a placeholder in src.
      const candidates = [element.getAttribute('data-src'), element.getAttribute('data-original'), element.getAttribute('src')]
      const src = candidates.find((value) => value !== null && value.trim() !== '' && !value.startsWith('data:'))
      const url = absolute(src, bases.image ?? bases.link)
      if (url === undefined || !/^https?:$/.test(url.protocol)) return ''
      return `![${bracket(element.getAttribute('alt') ?? '')}](${url.href})`
    },
  })
  service.addRule('agentHubTable', {
    filter: 'table',
    replacement(_content, node) {
      const rows = Array.from((node as unknown as Element).querySelectorAll('tr'))
        .map((row) => Array.from(row.querySelectorAll('th, td')).map((item) => cell(item.textContent ?? '')))
        .filter((row) => row.length > 0)
      if (rows.length === 0) return ''
      const width = Math.max(...rows.map((row) => row.length))
      const line = (row: string[]): string => `| ${[...row, ...Array<string>(width - row.length).fill('')].join(' | ')} |`
      return `\n\n${[line(rows[0]!), line(Array<string>(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`
    },
  })
  const markdown = service.turndown(html).replace(/\n{3,}/g, '\n\n').trim()
  return { markdown: markdown.length > MAX_MARKDOWN ? `${markdown.slice(0, MAX_MARKDOWN)}\n\n…` : markdown, cleaned }
}

export interface Readable {
  title?: string
  byline?: string
  html: string
}

/** Comment threads and reply forms: a long comment outscores an article made mostly of links and images. */
const COMMENTS = '#comments, #respond, #disqus_thread, .comments, .comments-area, .comment-list, .commentlist, .comment-respond, .wp-comments, .post-comments, [id^="comment-"]'
/** Where sites keep the article itself, most specific first; the page is read from here when Readability finds much less. */
const BODIES = ['[itemprop="articleBody"]', '.article-content', '.entry-content', '.post-content', '.post-body', '.article-body', '.single-content', '.markdown-body', 'article']
/** Less text than this is not an article. */
const MIN_TEXT = 120

const compact = (text: string | null | undefined): number => (text ?? '').replace(/\s+/g, '').length

/** The article in a page, or undefined when there is too little of one. */
export function readable(html: string): Readable | undefined {
  const { document } = parseHTML(html)
  for (const node of document.querySelectorAll(COMMENTS)) node.remove()
  // Before Readability, which takes the document apart as it reads.
  let body: { html: string; length: number } | undefined
  for (const selector of BODIES) {
    const node = document.querySelector(selector)
    const length = compact(node?.textContent)
    if (node !== null && length >= MIN_TEXT) {
      body = { html: node.innerHTML, length }
      break
    }
  }
  const title = document.querySelector('title')?.textContent?.trim()
  const article = new Readability(document as unknown as Document, { charThreshold: 300 }).parse()
  const found = article?.content ? { html: article.content, length: compact(article.textContent) } : undefined
  const pick = body !== undefined && (found === undefined || body.length > found.length * 1.5) ? body : found
  if (pick === undefined || pick.length < MIN_TEXT) return undefined
  const name = article?.title || title
  return {
    ...(name ? { title: name } : {}),
    ...(article?.byline ? { byline: article.byline } : {}),
    html: pick.html,
  }
}

/** How much text an HTML fragment holds: a feed's full text is used as it is past a few paragraphs. */
export function textLength(html: string): number {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`)
  return compact(document.body.textContent)
}

const marked = new Marked({ gfm: true, async: false })

/** Markdown written for GitHub (HTML inside, relative paths) as the page's own Markdown. */
export function normalizeMarkdown(markdown: string, bases: Bases): Clean {
  return htmlToMarkdown(marked.parse(markdown) as string, bases)
}
