/**
 * A comment of mine on lines of a pull request's changes, under the diff where an explanation
 * shows. What is in the field is what gets posted, with the review, after its preview: nothing
 * analyses it. A bot (picked here, remembered; 设置 → 审核 gives the first one) processes it only
 * when asked, the result back in the field to read, edit or undo. A draft outlives closing the panel.
 *
 * The same field answers a review thread instead (on my own pull request, or one I reviewed): the
 * thread is shown above it, a bot processes the note in the reply style, and the reply is posted on GitHub at once.
 */

import { useRef, useState, type ReactNode } from 'react'
import { DASHES, type ExplainTarget, type PullThread, type ReviewBot } from '../../review/types.ts'
import { IconClose, IconDown, IconUp } from '../git/icons.tsx'
import type { ReviewStore } from './api.ts'
import { t, uiLang } from './i18n.ts'
import { Markdown } from './Markdown.tsx'

/** Lines of one file a comment goes on: new side, `start..line`, with their diff for a bot to read. */
export interface CommentTarget {
  path: string
  line: number
  start?: number
  diff: string
  label: string
}

const BOT_KEY = 'dsh-agent-hub.review.commentBot'
const SPARK = '✦'

/** Drafts by pull request and lines, while the board is open. */
const drafts = new Map<string, { text: string; source?: string }>()
const draftKey = (key: string, target: CommentTarget, thread?: PullThread): string =>
  thread === undefined ? `${key}|${target.path}:${target.start ?? target.line}-${target.line}` : `${key}|thread:${thread.id}`
/** When a comment was left: month, day and time. */
const when = (at: string): string => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(uiLang() === 'en' ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The threads on one place of the diff, the one being answered among them. */
export interface ThreadPick {
  thread: PullThread
  at: number
  total: number
  go(step: 1 | -1): void
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The bot picked last; never picked, the one set in 设置 (blank: none). */
function useBot(bots: readonly ReviewBot[], fallback: string): [string, (id: string) => void] {
  const [picked, setPicked] = useState<string>(() => localStorage.getItem(BOT_KEY) ?? fallback)
  const id = bots.some((bot) => bot.id === picked) ? picked : ''
  return [id, (next) => {
    localStorage.setItem(BOT_KEY, next)
    setPicked(next)
  }]
}

export function Composer(props: {
  store: ReviewStore
  /** The card's pull request, and its sheet's path. */
  pr: string
  sheet: string
  target: CommentTarget
  bots: readonly ReviewBot[]
  defaultBot: string
  /** Answer this review thread, posted at once, instead of adding a comment to the review. */
  reply?: ThreadPick
  onClose(): void
  onReveal(): void
  onAdded(): void
}): ReactNode {
  const { store, target } = props
  const thread = props.reply?.thread
  const slot = draftKey(props.pr, target, thread)
  const [text, setTextState] = useState(() => drafts.get(slot)?.text ?? '')
  // What I wrote before a bot processed it: undo goes back to it, and the sheet keeps it.
  const [source, setSourceState] = useState<string | undefined>(() => drafts.get(slot)?.source)
  const [busy, setBusy] = useState<'process' | 'add' | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [bot, setBot] = useBot(props.bots, props.defaultBot)
  const field = useRef<HTMLTextAreaElement>(null)
  const keep = (next: string, from: string | undefined): void => {
    if (next.trim() === '' && from === undefined) drafts.delete(slot)
    else drafts.set(slot, { text: next, ...(from === undefined ? {} : { source: from }) })
  }
  const setText = (next: string): void => {
    setTextState(next)
    keep(next, source)
  }
  const setSource = (next: string | undefined, value: string): void => {
    setSourceState(next)
    keep(value, next)
  }

  const process = async (): Promise<void> => {
    if (bot === '' || text.trim() === '' || busy !== undefined) return
    setBusy('process')
    setError(undefined)
    try {
      const diff: ExplainTarget = { path: target.path, kind: 'lines', diff: target.diff, end: target.line, ...(target.start === undefined ? {} : { start: target.start }) }
      const result = await store.compose(props.pr, bot, text, diff, thread?.id)
      setTextState(result)
      setSource(source ?? text, result)
    } catch (failure) {
      setError(message(failure))
    }
    setBusy(undefined)
    // Back in the field once it is enabled again.
    setTimeout(() => field.current?.focus(), 0)
  }
  const undo = (): void => {
    if (source === undefined) return
    setTextState(source)
    setSource(undefined, source)
    field.current?.focus()
  }
  const add = async (): Promise<void> => {
    const en = text.trim()
    if (en === '' || busy !== undefined) return
    setBusy('add')
    setError(undefined)
    try {
      if (thread !== undefined) await store.reply(props.pr, thread.id, en)
      else {
        await store.comment(props.sheet, props.pr, {
          op: 'add', path: target.path, line: target.line, ...(target.start === undefined ? {} : { start: target.start }), text: source ?? en, en,
        })
      }
      drafts.delete(slot)
      // A reply stays in view under its thread, the field cleared for another.
      if (thread !== undefined) {
        setTextState('')
        setSourceState(undefined)
        setBusy(undefined)
      }
      props.onAdded()
    } catch (failure) {
      setError(message(failure))
      setBusy(undefined)
      setTimeout(() => field.current?.focus(), 0)
    }
  }

  const botName = props.bots.find((entry) => entry.id === bot)?.id
  const dashed = DASHES.test(text)
  return (
    <section className="rv-explain rv-compose" data-thread={thread === undefined ? undefined : ''} aria-label={t(thread === undefined ? 'compose.title' : 'thread.title')}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose() } }}>
      <header className="rv-explain-head">
        <span className="rv-compose-mark" aria-hidden="true">{thread === undefined ? '+' : '↩'}</span>
        <button type="button" className="rv-explain-where" title={t('explain.reveal')} onClick={props.onReveal}>{target.label}</button>
        {thread?.outdated === true && <span className="rv-chip">{t('thread.outdated')}</span>}
        {thread?.resolved === true && <span className="rv-chip" data-phase="submitted">{t('thread.resolved')}</span>}
        <span className="gp-grow" />
        {props.reply !== undefined && props.reply.total > 1 && (
          <span className="rv-thread-nav">
            <button type="button" className="ah-icon-btn" disabled={props.reply.at <= 0} aria-label={t('diff.prevFile')} onClick={() => props.reply?.go(-1)}><IconUp size={13} /></button>
            <span className="rv-thread-at">{props.reply.at + 1}/{props.reply.total}</span>
            <button type="button" className="ah-icon-btn" disabled={props.reply.at >= props.reply.total - 1} aria-label={t('diff.nextFile')} onClick={() => props.reply?.go(1)}><IconDown size={13} /></button>
          </span>
        )}
        {thread?.comments[0]?.url !== undefined && <a className="rv-link" href={thread.comments[0].url} target="_blank" rel="noopener noreferrer">{t('thread.open')} ↗</a>}
        <button type="button" className="ah-icon-btn" aria-label={t('close')} title={`${t('close')} (Esc)`} onClick={props.onClose}><IconClose size={13} /></button>
      </header>
      <div className="rv-compose-body">
        {thread !== undefined && (
          <ol className="rv-thread">
            {thread.comments.map((comment) => (
              <li key={comment.id} className="rv-thread-item">
                <span className="rv-thread-head">
                  <strong>@{comment.author || '?'}</strong>
                  <time dateTime={comment.at} title={comment.at}>{when(comment.at)}</time>
                </span>
                <Markdown className="rv-thread-body" text={comment.body} />
              </li>
            ))}
          </ol>
        )}
        <textarea ref={field} className="rv-input rv-compose-text" autoFocus rows={3} value={text} disabled={busy !== undefined}
          placeholder={t(thread === undefined ? 'compose.placeholder' : 'thread.placeholder')} aria-label={t(thread === undefined ? 'compose.title' : 'thread.title')} data-warn={dashed ? '' : undefined}
          onChange={(event) => { setText(event.target.value); setError(undefined) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void add() } }} />
        {(error !== undefined || dashed) && (
          <p className="rv-compose-note" role={error === undefined ? undefined : 'alert'}>
            <span className="rv-warn">{error ?? t('dashWarn')}</span>
          </p>
        )}
      </div>
      <footer className="rv-compose-foot">
        <span className="rv-compose-bot">
          <select className="rv-input rv-compose-pick" value={bot} disabled={busy !== undefined} aria-label={t('compose.bot')} title={t('compose.bot')}
            onChange={(event) => setBot(event.target.value)}>
            <option value="">{t('compose.noBot')}</option>
            {props.bots.map((entry) => <option key={entry.id} value={entry.id}>{entry.description === undefined ? entry.id : `${entry.id} · ${entry.description}`}</option>)}
          </select>
          <button type="button" className="ah-btn rv-compose-go" disabled={bot === '' || text.trim() === '' || busy !== undefined}
            title={bot === '' ? t('compose.pickBot') : t(thread === undefined ? 'compose.processHint' : 'thread.processHint', { bot: botName ?? bot })} onClick={() => void process()}>
            {busy === 'process' ? <><span className="rv-spin" aria-hidden="true" /> {t('compose.processing')}</> : <>{SPARK} {t('compose.process')}</>}
          </button>
          {source !== undefined && busy === undefined && <button type="button" className="rv-link" onClick={undo}>{t('compose.undo')}</button>}
        </span>
        <span className="gp-grow" />
        <button type="button" className="ah-btn" onClick={props.onClose}>{t('cancel')}</button>
        <button type="button" className="ah-btn" data-variant="primary" disabled={text.trim() === '' || busy !== undefined} title={t(thread === undefined ? 'compose.addHint' : 'thread.replyHint')}
          onClick={() => void add()}>
          {thread === undefined ? (busy === 'add' ? t('compose.adding') : t('compose.add')) : busy === 'add' ? t('thread.replying') : t('thread.reply')}
        </button>
      </footer>
    </section>
  )
}
