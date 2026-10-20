/**
 * Read-only sheet text (the overview, the notes, a finding, what GitHub would get) as rendered
 * Markdown. Pull request bodies come from anyone: raw HTML is shown as text (HTML comments, bots'
 * markers, hidden as GitHub hides them), and only http(s) and mailto links and http(s) images survive.
 */

import { Marked, Renderer, type Tokens } from 'marked'
import { useMemo, type MouseEventHandler, type ReactNode } from 'react'

const SAFE_LINK = /^(?:https?:|mailto:)/i
const SAFE_IMAGE = /^https?:/i

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return /^\s*<!--[\s\S]*?-->\s*$/.test(text) ? '' : escape(text)
    },
    link(this: Renderer, token: Tokens.Link): string {
      if (!SAFE_LINK.test(token.href.trim())) return this.parser.parseInline(token.tokens)
      return Renderer.prototype.link.call(this, token).replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ')
    },
    image(this: Renderer, token: Tokens.Image): string {
      if (!SAFE_IMAGE.test(token.href.trim())) return escape(token.text)
      return Renderer.prototype.image.call(this, token)
    },
  },
})

export function Markdown(props: { text: string; className?: string; clamped?: boolean; onClick?: MouseEventHandler<HTMLDivElement> }): ReactNode {
  const html = useMemo(() => marked.parse(props.text) as string, [props.text])
  return (
    <div className={props.className === undefined ? 'rv-md' : `rv-md ${props.className}`} data-clamped={props.clamped ? '' : undefined}
      onClick={props.onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
