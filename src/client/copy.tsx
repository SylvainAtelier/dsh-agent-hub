import { useEffect, useRef, useState, type ReactNode } from 'react'
import { copyText } from './editor/shared.ts'
import { isMac } from './editor/i18n.ts'

/**
 * Linear's "copy URL": ⌘⇧, (Ctrl+Shift+, elsewhere). Matched by the key's place, so a layout or Shift
 * turning `,` into `<` still counts.
 */
export const COPY_LINK_KEY = {
  match: (event: KeyboardEvent): boolean =>
    event.shiftKey && !event.altKey && (isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && event.code === 'Comma',
  label: (): string => (isMac() ? '⌘⇧,' : 'Ctrl+Shift+,'),
}

/**
 * A small icon button that copies `text`, a check standing in for a moment once it is copied.
 * With `hotkey`, that key copies too while the button is on the page, and its tooltip names it;
 * `icon` stands in for the two pages (a link's chain).
 */
export function CopyButton(props: { text: string; label: string; copied: string; className?: string; hotkey?: typeof COPY_LINK_KEY; icon?: ReactNode }): ReactNode {
  const [done, setDone] = useState(false)
  const text = useRef(props.text)
  text.current = props.text
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), 1200)
    return () => clearTimeout(timer)
  }, [done])
  const copy = (): void => { void copyText(text.current).then(() => setDone(true), () => {}) }
  const { hotkey } = props
  useEffect(() => {
    if (hotkey === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || !hotkey.match(event)) return
      event.preventDefault()
      copy()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkey])
  const title = done ? props.copied : hotkey === undefined ? props.label : `${props.label} (${hotkey.label()})`
  return (
    <button type="button" className={`ah-icon-btn ah-icon-sm${props.className === undefined ? '' : ` ${props.className}`}`} aria-label={done ? props.copied : props.label} title={title}
      aria-keyshortcuts={hotkey === undefined ? undefined : isMac() ? 'Meta+Shift+Comma' : 'Control+Shift+Comma'}
      data-copied={done ? '' : undefined}
      onClick={(event) => {
        event.stopPropagation()
        copy()
      }}>
      {done
        ? <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
        : props.icon ?? <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5" /></svg>}
    </button>
  )
}

/** A link icon for "copy link" buttons: the chain Linear and Sentry use, so it reads as the link and not the text. */
export function LinkIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" /><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
    </svg>
  )
}
