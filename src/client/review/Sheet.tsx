/**
 * A review sheet as a form: the decision and summary, each finding with its checkbox and the
 * comment that would be posted, a question to the helper model or a rewrite per finding, the
 * rules for this pull request, the notes. Every edit saves at once (picks) or when the field is
 * left (text); posting goes through a preview of exactly what GitHub would get.
 *
 * Shown in two places: the board's detail of a 待我审 card, and a sidebar tab beside the review
 * session (any `.reviews/pr-<n>.md` link opens there).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { formatLocation } from '../../review/sheet.ts'
import {
  DASHES, DECISIONS, findingOfThread, followed, isMine, standOf, VERDICTS, verdictOf,
  type Decision, type Finding, type FollowUp, type PullRemark, type PullThread, type ResponsePosted, type ResponsePreview, type ReviewItem, type ReviewPreview, type Sheet, type ThreadStand, type Verdict,
} from '../../review/types.ts'
import type { ReviewStore, SubmitResult } from './api.ts'
import { t, uiLang, type ReviewKey } from './i18n.ts'
import { ago } from '../i18n.ts'
import { Markdown } from './Markdown.tsx'
import { IconClose } from '../git/icons.tsx'
import { CopyButton } from '../copy.tsx'
import { isMac } from '../editor/i18n.ts'

/** Ctrl+Enter (⌘+Enter too): a sheet goes on to its preview, a preview posts. */
function confirmKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing
}

function confirmLabel(): string {
  return isMac() ? '⌘↵' : 'Ctrl+Enter'
}

export interface SheetActions {
  /** Go to the review session, the sheet beside it. */
  openSession?: (sessionId: string, path: string) => void
  /** The sheet file in the code editor. */
  openSource?: (path: string) => void
  /** A finding's location in the pull request's changes; `thread`: that review thread opened there, to read and reply. */
  showLine?: (path: string, line?: number, start?: number, thread?: string) => void
  /** Mine: answer the review again (asking where to work when no tree is on the branch); else the host is asked as it is. */
  respond?: (key: string) => void
  /** Leave the whole detail (the board's): what closing does once the review is posted. */
  close?: () => void
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useSheet(store: ReviewStore, path: string) {
  // A new subscribe function on every render would make React resubscribe after each one: the
  // watch would be dropped and read again forever, the sheet never past 正在读取.
  const subscribe = useCallback((listener: () => void) => store.watch(path, listener), [store, path])
  return useSyncExternalStore(subscribe, () => store.sheet(path))
}

/** A text field that saves when it is left; the file's newer value shows unless it is being edited. */
function Draft(props: { value: string; multiline?: boolean; rows?: number; placeholder?: string; label: string; disabled?: boolean; dashed?: boolean; onSave(value: string): void }): ReactNode {
  const [text, setText] = useState(props.value)
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setText(props.value) }, [props.value])
  const save = (): void => {
    editing.current = false
    if (text.trim() !== props.value.trim()) props.onSave(text)
  }
  const common = {
    className: 'rv-input',
    value: text,
    disabled: props.disabled,
    placeholder: props.placeholder,
    'aria-label': props.label,
    'data-warn': props.dashed && DASHES.test(text) ? '' : undefined,
    onFocus: () => { editing.current = true },
    onBlur: save,
  }
  return props.multiline
    ? <textarea {...common} rows={props.rows ?? 3} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur() } }} />
    : <input {...common} type="text" onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
}

/** What followed a submitted review, in words: the commits pushed, and the comments with who wrote them. */
export function followText(follow: FollowUp): string {
  const parts: string[] = []
  if (follow.commits > 0) parts.push(t('follow.commitsPart', { n: follow.commits }))
  if (follow.comments > 0) {
    const names = follow.authors.slice(0, 3).map((name) => `@${name}`)
    const more = follow.authors.length > names.length
    const who = names.length === 0 ? '' : uiLang() === 'en' ? ` from ${names.join(', ')}${more ? '…' : ''}` : `${names.join('、')}${more ? ' 等' : ''} `
    parts.push(t('follow.commentsPart', { n: follow.comments, who }))
  }
  return parts.join(uiLang() === 'en' ? ', ' : '，')
}

export function PhaseChip(props: { item: Pick<ReviewItem, 'phase' | 'running' | 'queued' | 'own' | 'rerequested' | 'follow'> }): ReactNode {
  const { item } = props
  const news = followed(item)
  const key: ReviewKey = item.queued ? 'phase.queued' : item.phase === 'analyzing' && item.running !== true ? 'phase.stalled'
    : item.rerequested === true ? 'phase.again' : news ? (item.follow!.commits > 0 ? 'follow.commits' : 'follow.comments')
    : item.own === true ? `ownPhase.${item.phase}` : `phase.${item.phase}`
  return (
    <span className="rv-chip" data-phase={item.phase} data-again={item.rerequested === true || news ? '' : undefined} data-live={item.running || item.queued ? '' : undefined}
      title={news ? t('follow.summary', { parts: followText(item.follow!) }) : undefined}>
      {item.phase === 'merged' && <LandedIcon d="M6.5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM5 5v8.5M5 5c0 3 2.5 4.5 5 4.5M13 9.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />}
      {item.phase === 'closed' && <LandedIcon d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM4.2 4.2l7.6 7.6" />}
      {t(key)}
    </span>
  )
}

/** Merged or closed: a glyph besides the chip's colour, so it is not told by hue alone. */
function LandedIcon(props: { d: string }): ReactNode {
  return (
    <svg className="rv-chip-icon" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={props.d} />
    </svg>
  )
}

/** 修改 | 仅回复 | 忽略: what a response item comes to, one press. */
function VerdictSwitch(props: { finding: Finding; disabled: boolean; onChange(value: Verdict): void }): ReactNode {
  const current = verdictOf(props.finding)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (from: number, by: number): void => {
    const next = VERDICTS[(from + by + VERDICTS.length) % VERDICTS.length]!
    props.onChange(next)
    refs.current[VERDICTS.indexOf(next)]?.focus()
  }
  return (
    <div className="ah-seg rv-verdict" role="radiogroup" aria-label={t('verdict.label', { id: props.finding.id })}>
      {VERDICTS.map((value, index) => (
        <button key={value} ref={(element) => { refs.current[index] = element }} type="button" role="radio" aria-checked={current === value}
          tabIndex={current === value ? 0 : -1} data-verdict={value} disabled={props.disabled}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1) }
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1) }
          }}
          onClick={() => { if (current !== value) props.onChange(value) }}>{t(`verdict.${value}`)}</button>
      ))}
    </div>
  )
}

/**
 * A finding of a review, or (`respond`) an item of my response: what to do with a comment, and the
 * reply. A comment of mine is posted as I wrote it: no model is asked about it, and it can go.
 */
function FindingRow(props: { finding: Finding; disabled: boolean; store: ReviewStore; path: string; showLine?: SheetActions['showLine']; respond?: boolean }): ReactNode {
  const { finding, store, path, disabled, showLine, respond } = props
  const mine = isMine(finding)
  const [asking, setAsking] = useState(false)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState<'ask' | 'rewrite' | undefined>()
  const [open, setOpen] = useState(false)
  const where = formatLocation(finding)
  const long = finding.text.length > 280 || finding.text.split('\n').length > 4
  const run = async (kind: 'ask' | 'rewrite'): Promise<void> => {
    setBusy(kind)
    const done = kind === 'ask' ? await store.ask(path, finding.id, question) : await store.rewrite(path, finding.id)
    setBusy(undefined)
    if (done && kind === 'ask') {
      setQuestion('')
      setAsking(false)
    }
  }
  const location = where === undefined ? null : showLine === undefined
    ? <code className="rv-where" title={where}>{where}</code>
    : (
      // A button inside the label: clicking it shows the line, it does not toggle the pick.
      <button type="button" className="rv-where rv-where-go" title={`${t('diff.jump')}: ${where}`}
        onClick={() => showLine(finding.path!, finding.line, finding.start)}>{where}</button>
    )
  const skipped = respond === true && !finding.checked
  return (
    <li className="rv-finding" data-finding={finding.id} data-checked={finding.checked ? '' : undefined} data-verdict={respond ? verdictOf(finding) : undefined}>
      {respond
        ? (
          <div className="rv-finding-head rv-respond-head">
            <span className="rv-id">{finding.id}</span>
            {finding.reviewer !== undefined && <span className="rv-reviewer">@{finding.reviewer}</span>}
            {location}
            <span className="rv-grow" />
            <VerdictSwitch finding={finding} disabled={disabled} onChange={(value) => void store.patch(path, [{ op: 'verdict', id: finding.id, value }])} />
          </div>
        )
        : (
          <label className="rv-finding-head">
            <input type="checkbox" checked={finding.checked} disabled={disabled}
              onChange={(event) => void store.patch(path, [{ op: 'check', id: finding.id, checked: event.target.checked }])} />
            <span className="rv-id">{finding.id}</span>
            {location}
          </label>
        )}
      {finding.text !== '' && mine && <span className="rv-en-label rv-source-label">{t('mine.source')}</span>}
      {finding.text !== '' && (
        <Markdown className="rv-text" text={finding.text} clamped={long && !open}
          onClick={(event) => { if (long && (event.target as Element).closest('a') === null) setOpen(!open) }} />
      )}
      {/* An item left alone gets no reply: nothing to write. */}
      {!skipped && (
        <div className="rv-en">
          <span className="rv-en-label">EN</span>
          <Draft value={finding.en} multiline rows={2} disabled={disabled || busy === 'rewrite'} dashed label={t(respond ? 'own.reply' : 'comment', { id: finding.id })}
            placeholder={t(respond ? 'own.replyPlaceholder' : 'commentPlaceholder')} onSave={(text) => void store.patch(path, [{ op: 'en', id: finding.id, text }])} />
        </div>
      )}
      <div className="rv-finding-actions">
        {mine
          ? (
            <button type="button" className="rv-link" disabled={disabled} title={t('mine.removeHint')}
              onClick={() => void store.patch(path, [{ op: 'remove', id: finding.id }])}>{t('mine.remove')}</button>
          )
          : (
            <>
              <button type="button" className="rv-link" disabled={disabled || busy !== undefined} aria-expanded={asking} onClick={() => setAsking(!asking)}>{t('ask')}</button>
              <button type="button" className="rv-link" disabled={disabled || skipped || busy !== undefined} title={t('rewriteHint')} onClick={() => void run('rewrite')}>
                {busy === 'rewrite' ? t('rewriting') : t('rewrite')}
              </button>
            </>
          )}
        {DASHES.test(finding.en) && <span className="rv-warn">{t('dashWarn')}</span>}
      </div>
      {asking && (
        <form className="rv-ask" onSubmit={(event) => { event.preventDefault(); if (question.trim() !== '' && busy === undefined) void run('ask') }}>
          <input className="rv-input" autoFocus value={question} placeholder={t('askPlaceholder')} aria-label={t('ask')} disabled={busy !== undefined}
            onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setAsking(false) }} />
          <button type="submit" className="ah-btn" disabled={question.trim() === '' || busy !== undefined}>{busy === 'ask' ? t('asking') : t('send')}</button>
        </form>
      )}
    </li>
  )
}

function Findings(props: { title: string; findings: Finding[]; empty: string; disabled: boolean; store: ReviewStore; path: string; showLine?: SheetActions['showLine']; respond?: boolean }): ReactNode {
  const picked = props.findings.filter((finding) => finding.checked).length
  return (
    <section className="rv-section">
      <div className="rv-section-head">
        <h4>{props.title}</h4>
        <span className="rv-count">{props.findings.length === 0 ? '0' : `${picked}/${props.findings.length}`}</span>
      </div>
      {props.findings.length === 0
        ? <p className="rv-muted">{props.empty}</p>
        : (
          <ul className="rv-findings">
            {props.findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} disabled={props.disabled} store={props.store} path={props.path} respond={props.respond}
                {...(props.showLine === undefined ? {} : { showLine: props.showLine })} />
            ))}
          </ul>
        )}
    </section>
  )
}

/** Where a thread stands, most wanting first: answered, its code changed, resolved, untouched. */
const STANDS: readonly ThreadStand[] = ['replied', 'outdated', 'resolved', 'open']
const STAND_PATH: Record<ThreadStand, string> = {
  replied: 'M3 3.5h10v7H7l-3 2.5v-2.5H3z',
  outdated: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.5v4M8 10.5v4',
  resolved: 'M3.5 8.5l3 3 6-7',
  open: 'M8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3z',
}

/** A stand's glyph: told by shape as well as colour. */
export function StandIcon(props: { stand: ThreadStand | 'commits' }): ReactNode {
  return (
    <svg className="rv-stand-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={STAND_PATH[props.stand === 'commits' ? 'outdated' : props.stand]} />
    </svg>
  )
}

/** One line of a comment, its HTML comments (bots' markers) left out as GitHub leaves them out. */
const excerpt = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()

/**
 * After a review went out: each comment of mine on a line with where it stands and what was said
 * after it, then what others said outside the threads since. Read again as the card changes.
 */
function FollowTrack(props: { store: ReviewStore; item: ReviewItem; sheet: Sheet; showLine: SheetActions['showLine'] }): ReactNode {
  const { store, item, sheet } = props
  const [talk, setTalk] = useState<{ threads: PullThread[]; remarks: PullRemark[] } | { error: string } | undefined>()
  const follow = item.follow
  const stamp = `${item.updatedAt}|${follow?.comments ?? ''}|${follow?.mine.replied ?? ''}|${follow?.mine.resolved ?? ''}|${follow?.mine.outdated ?? ''}`
  useEffect(() => {
    let live = true
    Promise.all([store.threads(item.key), store.remarks(item.key)]).then(
      ([threads, remarks]) => { if (live) setTalk({ threads, remarks }) },
      (error: unknown) => { if (live) setTalk((old) => (old !== undefined && !('error' in old) ? old : { error: message(error) })) },
    )
    return () => { live = false }
  }, [store, item.key, stamp])
  // What came after I last caught up (or after the review went out) is marked new.
  const since = Date.parse(sheet.read ?? sheet.submitted ?? '') || 0
  const rows = talk === undefined || 'error' in talk ? [] : talk.threads.filter((thread) => thread.mine === true).map((thread) => {
    const me = thread.comments[0]?.author ?? ''
    const last = thread.comments.at(-1)
    const stand = standOf({ resolved: thread.resolved, outdated: thread.outdated, replied: last !== undefined && last.author !== me })
    return { thread, stand, finding: findingOfThread(thread, sheet.findings) }
  }).sort((a, b) => STANDS.indexOf(a.stand) - STANDS.indexOf(b.stand))
  const counts = STANDS.map((stand) => [stand, rows.filter((row) => row.stand === stand).length] as const).filter(([, n]) => n > 0)
  return (
    <section className="rv-section rv-track-section" aria-label={t('track.title')}>
      <div className="rv-section-head">
        <h4>{t('track.title')}</h4>
        <span className="rv-grow" />
        {counts.map(([stand, n]) => <span key={stand} className="rv-stand" data-stand={stand}><StandIcon stand={stand} />{n} {t(`stand.${stand}`)}</span>)}
      </div>
      {talk === undefined
        ? <p className="rv-muted" role="status">{t('track.loading')}</p>
        : 'error' in talk
          ? <p className="rv-muted" role="alert">{t('track.failed', { message: talk.error })}</p>
          : (
            <>
              {rows.length === 0 ? <p className="rv-muted">{t('track.none')}</p> : (
                <ul className="rv-track-list">
                  {rows.map((row) => <TrackRow key={row.thread.id} {...row} since={since} showLine={props.showLine} />)}
                </ul>
              )}
              {talk.remarks.length > 0 && (
                <>
                  <h5 className="rv-track-sub">{t('track.remarks')}</h5>
                  <ul className="rv-track-list">
                    {talk.remarks.map((remark, index) => <RemarkRow key={`${remark.at}:${index}`} remark={remark} fresh={Date.parse(remark.at) > since} />)}
                  </ul>
                </>
              )}
            </>
          )}
    </section>
  )
}

/** A comment of mine on a line: folded, where it stands and the last reply; open, the whole exchange and a way to answer it. */
function TrackRow(props: { thread: PullThread; stand: ThreadStand; finding: Finding | undefined; since: number; showLine: SheetActions['showLine'] }): ReactNode {
  const { thread, stand, finding } = props
  const [open, setOpen] = useState(false)
  const me = thread.comments[0]?.author ?? ''
  const replies = thread.comments.slice(1)
  const latest = replies.at(-1)
  const fresh = replies.some((comment) => comment.author !== me && Date.parse(comment.at) > props.since)
  const where = formatLocation({ path: thread.path, ...(thread.line === undefined ? {} : { line: thread.line }), ...(thread.start === undefined ? {} : { start: thread.start }) }) ?? thread.path
  const url = (latest ?? thread.comments[0])?.url
  return (
    <li className="rv-track" data-stand={stand} data-new={fresh ? '' : undefined}>
      <button type="button" className="rv-track-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rv-stand" data-stand={stand}><StandIcon stand={stand} />{t(`stand.${stand}`)}</span>
        {finding !== undefined && <span className="rv-id" data-severity={isMine(finding) ? 'mine' : finding.severity}>{finding.id}</span>}
        <span className="rv-where" title={where}>{where}</span>
        {fresh && <span className="rv-new">{t('track.new')}</span>}
      </button>
      {!open && latest !== undefined && (
        <p className="rv-track-last"><span className="rv-track-who">@{latest.author} · {ago(Date.parse(latest.at), Date.now())}</span> {excerpt(latest.body)}</p>
      )}
      {open && (
        <div className="rv-track-body">
          <Markdown className="rv-md rv-track-mine" text={thread.comments[0]?.body ?? ''} />
          {replies.length > 3 && <span className="rv-count">{t('track.more', { n: replies.length - 3 })}</span>}
          {replies.slice(-3).map((comment) => (
            <div key={comment.id} className="rv-track-reply" data-new={comment.author !== me && Date.parse(comment.at) > props.since ? '' : undefined}>
              <span className="rv-track-who">@{comment.author} · {ago(Date.parse(comment.at), Date.now())}</span>
              <Markdown className="rv-md" text={comment.body} />
            </div>
          ))}
          <div className="rv-finding-actions">
            {props.showLine !== undefined && (
              <button type="button" className="rv-link" onClick={() => props.showLine!(thread.path, thread.line, thread.start, thread.id)}>{t('track.reply')}</button>
            )}
            {url !== undefined && <a className="rv-link" href={url} target="_blank" rel="noopener noreferrer">{t('thread.open')}</a>}
          </div>
        </div>
      )}
    </li>
  )
}

/** Something said outside the threads since the review: folded to a few lines, opened on a click. */
function RemarkRow(props: { remark: PullRemark; fresh: boolean }): ReactNode {
  const { remark } = props
  const [open, setOpen] = useState(false)
  return (
    <li className="rv-track" data-new={props.fresh ? '' : undefined}>
      <div className="rv-track-who">
        @{remark.author} · {ago(Date.parse(remark.at), Date.now())}
        {remark.state !== undefined && remark.state !== 'COMMENTED' && <span className="rv-chip" data-event={remark.state === 'APPROVED' ? 'APPROVE' : remark.state === 'CHANGES_REQUESTED' ? 'REQUEST_CHANGES' : undefined}>{remark.state.toLowerCase().replace('_', ' ')}</span>}
        {props.fresh && <span className="rv-new">{t('track.new')}</span>}
        <span className="rv-grow" />
        {remark.url !== undefined && <a className="rv-link" href={remark.url} target="_blank" rel="noopener noreferrer">{t('thread.open')}</a>}
      </div>
      <div className="rv-text" data-clamped={open ? undefined : ''} role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open) } }}>
        <Markdown className="rv-md" text={remark.body} />
      </div>
    </li>
  )
}

function Collapsible(props: { title: string; text: string; open?: boolean }): ReactNode {
  const [open, setOpen] = useState(props.open ?? false)
  if (props.text.trim() === '') return null
  return (
    <section className="rv-section">
      <button type="button" className="rv-section-head rv-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rv-chevron" aria-hidden="true">›</span><h4>{props.title}</h4>
      </button>
      {open && <Markdown className="rv-prose" text={props.text} />}
    </section>
  )
}

type AnyPreview = ReviewPreview | ResponsePreview
const isResponse = (preview: AnyPreview): preview is ResponsePreview => 'role' in preview

const problemText = (preview: AnyPreview): string[] => preview.problems.map((problem) => {
  const ids = problem.ids?.join(', ') ?? ''
  return t(`problem.${problem.code}` as ReviewKey, { ids })
})

const warningText = (preview: AnyPreview): string[] => preview.warnings.map((warning) =>
  t(`warn.${warning.code}` as ReviewKey, isResponse(preview) ? {} : { head: preview.head.slice(0, 7), remote: preview.remoteHead?.slice(0, 7) ?? '' }))

/** What my response would do: the commits pushed, each thread's reply (and resolve), the conversation comment. */
function ResponseBody(props: { preview: ResponsePreview }): ReactNode {
  const { preview } = props
  return (
    <>
      <h5 className="rv-preview-label">{preview.commits.length === 0 ? t('own.noCommits') : t('own.commits', { branch: preview.branch, n: preview.commits.length })}</h5>
      {preview.commits.length > 0 && (
        <ul className="rv-commits">
          {preview.commits.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 7)}</code> {commit.subject}</li>)}
        </ul>
      )}
      <h5 className="rv-preview-label">{t('own.replies', { n: preview.replies.length })}</h5>
      {preview.replies.length === 0
        ? <p className="rv-muted">{t('own.noReplies')}</p>
        : (
          <ul className="rv-comments">
            {preview.replies.map((reply) => (
              <li key={reply.id}>
                <span className="rv-reply-head">
                  <span className="rv-id">{reply.id}</span>
                  {reply.reviewer !== undefined && <span className="rv-reviewer">@{reply.reviewer}</span>}
                  {reply.path !== undefined && <code className="rv-where">{reply.line === undefined ? reply.path : `${reply.path}:${reply.line}`}</code>}
                  {reply.resolve && <span className="rv-chip" data-phase="submitted">{t(reply.body === '' ? 'own.resolveOnly' : 'own.resolve')}</span>}
                </span>
                {reply.body !== '' && <Markdown className="rv-pre" text={reply.body} />}
              </li>
            ))}
          </ul>
        )}
      <h5 className="rv-preview-label">{t('own.comment')}</h5>
      {preview.comment === '' ? <p className="rv-muted">{t('own.noComment')}</p> : <Markdown className="rv-pre" text={preview.comment} />}
    </>
  )
}

function postedText(posted: ResponsePosted): string {
  return t('own.postedText', { pushed: posted.pushed?.slice(0, 7) ?? t('own.nothingPushed'), replies: posted.replies, resolved: posted.resolved })
}

/** Exactly what GitHub would get; posting waits for a confirmation here. */
function Preview(props: { store: ReviewStore; path: string; onClose(): void; onDone?: () => void }): ReactNode {
  const [preview, setPreview] = useState<AnyPreview | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [posting, setPosting] = useState(false)
  const [result, setResult] = useState<SubmitResult | undefined>()
  useEffect(() => {
    let live = true
    props.store.preview(props.path).then((value) => { if (live) setPreview(value) }, (failure: unknown) => { if (live) setError(message(failure)) })
    return () => { live = false }
  }, [props.store, props.path])
  const post = async (): Promise<void> => {
    setPosting(true)
    setError(undefined)
    try {
      const value = await props.store.submit(props.path)
      setResult(value)
      setPreview(value.preview)
    } catch (failure) {
      setError(message(failure))
    }
    setPosting(false)
  }
  const problems = preview === undefined ? [] : problemText(preview)
  const warnings = preview === undefined || result?.posted !== undefined ? [] : warningText(preview)
  const response = preview !== undefined && isResponse(preview)
  const posted = result?.posted
  // Posted: nothing is left to do here, so closing leaves the detail too where there is one.
  const close = posted !== undefined ? props.onDone ?? props.onClose : props.onClose
  const top = useRef<HTMLDivElement>(null)
  // Focused, so Ctrl+Enter reaches it at once.
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' })
    top.current?.focus({ preventScroll: true })
  }, [])
  const ready = result?.posted === undefined && preview !== undefined && problems.length === 0 && !posting
  return (
    <div className="rv-preview" ref={top} tabIndex={-1} role="dialog" aria-label={t(response ? 'own.preview' : 'preview')}
      onKeyDown={(event) => {
        if (!confirmKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        if (ready) void post()
      }}>
      <header className="rv-preview-head">
        <h4>{posted !== undefined ? t(response ? 'own.postedTitle' : 'posted') : t(response ? 'own.preview' : 'preview')}</h4>
        <span className="rv-grow" />
        <button type="button" className="ah-icon-btn" aria-label={t('close')} title={t('close')} onClick={close}><IconClose size={14} /></button>
      </header>
      <div className="rv-preview-body">
        {preview === undefined && error === undefined && <p className="rv-muted">{t('previewLoading')}</p>}
        {error !== undefined && <p className="rv-banner" role="alert">{error}</p>}
        {posted !== undefined && (
          <p className="rv-banner" data-tone="ok">
            {'replies' in posted ? postedText(posted) : t('postedText')}{' '}
            {posted.url !== undefined && <a className="rv-link" href={posted.url} target="_blank" rel="noopener noreferrer">{t(response ? 'openPr' : 'openReview')} ↗</a>}
          </p>
        )}
        {problems.length > 0 && <ul className="rv-problems" role="alert">{problems.map((text) => <li key={text}>{text}</li>)}</ul>}
        {warnings.length > 0 && <ul className="rv-warnings" role="status">{warnings.map((text) => <li key={text}>{text}</li>)}</ul>}
        {preview !== undefined && isResponse(preview) && <ResponseBody preview={preview} />}
        {preview !== undefined && !isResponse(preview) && (
          <>
            <dl className="rv-props">
              <dt>{t('event')}</dt><dd><span className="rv-chip" data-event={preview.event}>{t(`event.${preview.event}` as ReviewKey)}</span></dd>
              <dt>{t('commit')}</dt>
              <dd>
                <code>{preview.head.slice(0, 12)}</code>
                {preview.warnings.some((warning) => warning.code === 'stale') && <span className="rv-muted"> · {t('commitAnalysed')}</span>}
              </dd>
            </dl>
            <h5 className="rv-preview-label">{t('body')}</h5>
            {preview.body === '' ? <p className="rv-muted">{t('noBody')}</p> : <Markdown className="rv-pre" text={preview.body} />}
            <h5 className="rv-preview-label">{t('lineComments', { n: preview.comments.length })}</h5>
            {preview.comments.length === 0
              ? <p className="rv-muted">{t('noComments')}</p>
              : (
                <ul className="rv-comments">
                  {preview.comments.map((comment) => (
                    <li key={comment.id}>
                      <code className="rv-where">{comment.start === undefined ? `${comment.path}:${comment.line}` : `${comment.path}:${comment.start}-${comment.line}`}</code>
                      <Markdown className="rv-pre" text={comment.body} />
                    </li>
                  ))}
                </ul>
              )}
            {preview.folded.length > 0 && <p className="rv-muted">{t('folded', { ids: preview.folded.join(', ') })}</p>}
          </>
        )}
      </div>
      <footer className="rv-preview-foot">
        <span className="rv-grow" />
        <button type="button" className="ah-btn" data-variant={posted !== undefined ? 'primary' : undefined} onClick={close}>{posted !== undefined ? t('close') : t('cancel')}</button>
        {result?.posted === undefined && (
          <button type="button" className="ah-btn" data-variant="primary" disabled={!ready} title={confirmLabel()} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => void post()}>
            {posting ? t('posting') : response ? t('own.confirm') : warnings.length > 0 ? t('confirmPostAnyway') : t('confirmPost')}
          </button>
        )}
      </footer>
    </div>
  )
}

function Banners(props: { item: ReviewItem | undefined; sheet: Sheet | undefined; error: string | undefined; store: ReviewStore; path: string; actions: SheetActions }): ReactNode {
  const { item, sheet, store, path } = props
  const [fixing, setFixing] = useState(false)
  const out: ReactNode[] = []
  const again = (key: string): void => {
    if (props.actions.respond !== undefined && item?.own === true) props.actions.respond(key)
    else void store.analyze(key)
  }
  if (props.error !== undefined) {
    out.push(
      <p key="invalid" className="rv-banner" role="alert">
        {t('invalid', { message: props.error })}
        {item?.session !== undefined && (
          <button type="button" className="rv-link" disabled={fixing} onClick={() => {
            setFixing(true)
            void store.tell(path, t('fixPrompt', { error: props.error ?? '' })).finally(() => setFixing(false))
          }}>{t('askFix')}</button>
        )}
        {props.actions.openSource !== undefined && <button type="button" className="rv-link" onClick={() => props.actions.openSource!(path)}>{t('source')}</button>}
      </p>,
    )
  }
  if (item?.phase === 'stale') {
    out.push(
      <p key="stale" className="rv-banner">
        {item.own === true ? t('own.stale', { n: item.unseen ?? 0 }) : t('stale', { head: sheet?.head.slice(0, 7) ?? '' })}
        <button type="button" className="rv-link" disabled={item.queued === true} onClick={() => again(item.key)}>{t(item.own === true ? 'respond' : 'reanalyze')}</button>
      </p>,
    )
  }
  if (item !== undefined && item.own !== true && followed(item)) {
    out.push(
      <p key="follow" className="rv-banner">
        <span>{t('follow.banner', { when: sheet?.submitted?.slice(0, 16).replace('T', ' ') ?? '', parts: followText(item.follow!) })}</span>
        <button type="button" className="rv-link" disabled={item.queued === true || item.running === true} onClick={() => again(item.key)}>{t('reanalyze')}</button>
        <button type="button" className="rv-link" title={t('follow.seenHint')} onClick={() => void store.seen(item.key)}>{t('follow.seen')}</button>
      </p>,
    )
  }
  if (item?.phase === 'analyzing' && item.running !== true && item.queued !== true) {
    out.push(
      <p key="stalled" className="rv-banner">
        {t('stalled')}
        <button type="button" className="rv-link" onClick={() => again(item.key)}>{t(item.own === true ? 'respond' : 'reanalyze')}</button>
      </p>,
    )
  }
  // A fix turn that ended without the host hearing of it (a restart): ask for it again.
  if (item?.phase === 'fixing' && item.running !== true) {
    out.push(
      <p key="fixStalled" className="rv-banner">
        {t('own.fixStalled')}
        <button type="button" className="rv-link" onClick={() => void store.fix(path)}>{t('own.fixAgain')}</button>
      </p>,
    )
  }
  if (item?.error !== undefined && props.error === undefined) {
    out.push(
      <p key="failed" className="rv-banner" role="alert">
        {t('startFailed', { message: item.error })}
        <button type="button" className="rv-link" onClick={() => again(item.key)}>{t('retry')}</button>
      </p>,
    )
  }
  // A sheet opened for my own comments: the analysis is still to come, at hand here.
  if (sheet !== undefined && sheet.role === undefined && sheet.session === undefined && sheet.status === 'ready' && item !== undefined && item.own !== true) {
    out.push(
      <p key="unanalysed" className="rv-banner">
        {t('mine.unanalysed')}
        <button type="button" className="rv-link" disabled={item.queued === true || item.running === true} onClick={() => again(item.key)}>{t('analyze')}</button>
      </p>,
    )
  }
  if (item?.dirty === true) out.push(<p key="dirty" className="rv-banner" role="alert">{t('dirty')}</p>)
  return out.length === 0 ? null : <>{out}</>
}

/** The pull request's own branch and the one it merges into, each with a button copying its name. */
export function Branches(props: { head: string | undefined; base: string | undefined }): ReactNode {
  const head = props.head || undefined
  const base = props.base || undefined
  if (head === undefined && base === undefined) return null
  const row = (label: string, name: string, kind: 'head' | 'base'): ReactNode => (
    <div className="rv-branch" data-kind={kind}>
      <span className="rv-branch-label">{label}</span>
      <code className="rv-branch-name" title={name}>{name}</code>
      <CopyButton text={name} label={t('branch.copy', { name })} copied={t('copied')} />
    </div>
  )
  return (
    <div className="rv-branches" title={head !== undefined && base !== undefined ? t('branch.hint', { head, base }) : undefined}>
      {head !== undefined && row(t('branch.head'), head, 'head')}
      {base !== undefined && row(t('branch.base'), base, 'base')}
    </div>
  )
}

/** `below`: shown under the pull request's head (the board's detail puts merging there). */
export function ReviewSheet(props: { store: ReviewStore; path: string; repo: string; item?: ReviewItem; actions: SheetActions; compact?: boolean; below?: ReactNode }): ReactNode {
  const { store, path } = props
  const reply = useSheet(store, path)
  const [previewing, setPreviewing] = useState(false)
  const sheet = reply?.sheet
  const item = props.item ?? reply?.item
  const respond = sheet?.role === 'author'
  // A response is not edited while its fix runs: the session is acting on what it says.
  const disabled = sheet === undefined || sheet.status === 'submitted' || (respond && sheet.status === 'fixing')
  const session = sheet?.session ?? item?.session
  const must = sheet?.findings.filter((finding) => finding.severity === 'must' && !isMine(finding)) ?? []
  const nice = sheet?.findings.filter((finding) => finding.severity === 'nice' && !isMine(finding)) ?? []
  const mine = sheet?.findings.filter(isMine) ?? []
  const toFix = must.filter((finding) => finding.checked).length
  const busy = item?.running === true || item?.queued === true
  const canPreview = sheet !== undefined && sheet.status !== 'submitted' && sheet.status !== 'analyzing' && !(respond && sheet.status === 'fixing')

  if (reply === undefined) return <div className="rv-sheet"><p className="rv-muted" role="status">{t('loading')}</p></div>
  if (previewing) return <div className="rv-sheet"><Preview store={store} path={path} onClose={() => setPreviewing(false)} {...(props.actions.close === undefined ? {} : { onDone: props.actions.close })} /></div>
  return (
    // Focusable, so Ctrl+Enter is heard after a click on its blank parts too; a field's own form keeps the key.
    <div className="rv-sheet" tabIndex={-1} data-compact={props.compact ? '' : undefined}
      onKeyDown={(event) => {
        if (!confirmKey(event) || (event.target as Element).closest('form') !== null) return
        event.preventDefault()
        if (canPreview) setPreviewing(true)
      }}>
      {sheet !== undefined && (
        <header className="rv-head">
          <a className="rv-title" href={sheet.url ?? item?.url} target="_blank" rel="noopener noreferrer" title={t('openPr')}>
            <span className="rv-number">#{sheet.pr.slice(sheet.pr.lastIndexOf('#') + 1)}</span> {sheet.title}
          </a>
          <div className="rv-meta">
            {sheet.author !== '' && <span>@{sheet.author}</span>}
            <code title={sheet.head}>{sheet.head.slice(0, 7)}</code>
            {sheet.round > 1 && <span>{t('round', { n: sheet.round })}</span>}
            {item !== undefined && <PhaseChip item={item} />}
          </div>
          <Branches head={item?.branch ?? sheet.branch} base={sheet.base !== '' ? sheet.base : item?.base} />
        </header>
      )}
      {props.below}
      <Banners item={item} sheet={sheet} error={reply.error} store={store} path={path} actions={props.actions} />
      {sheet !== undefined && (
        <>
          {sheet.status === 'submitted' && (
            <p className="rv-banner" data-tone="ok">{t(respond ? 'own.posted' : 'submitted', { when: sheet.submitted?.slice(0, 16).replace('T', ' ') ?? '' })}</p>
          )}
          {sheet.status === 'submitted' && !respond && item !== undefined && item.own !== true && (
            <FollowTrack store={store} item={item} sheet={sheet} showLine={props.actions.showLine} />
          )}
          {respond && sheet.status === 'fixing' && item?.running === true && <p className="rv-banner" role="status">{t('own.fixingHint')}</p>}
          {respond && sheet.status === 'fixed' && <p className="rv-banner" data-tone="ok">{t('own.fixed', { sha: sheet.fixed?.slice(0, 7) ?? '' })}</p>}
          {!respond && (
            <div className="ah-seg rv-decision" role="radiogroup" aria-label={t('decision')}>
              {DECISIONS.map((decision: Decision) => (
                <button key={decision} type="button" role="radio" aria-checked={sheet.decision === decision} data-decision={decision} disabled={disabled}
                  onClick={() => void store.patch(path, [{ op: 'decision', value: decision }])}>{t(`decision.${decision}` as ReviewKey)}</button>
              ))}
            </div>
          )}
          <label className="rv-field">
            <span>{t(respond ? 'own.summary' : 'summary')}</span>
            <Draft value={sheet.summary} label={t(respond ? 'own.summary' : 'summary')} placeholder={t(respond ? 'own.summaryPlaceholder' : 'summaryPlaceholder')}
              disabled={disabled} dashed onSave={(value) => void store.patch(path, [{ op: 'summary', value }])} />
          </label>
          <Collapsible title={t('overview')} text={sheet.overview} open={!props.compact && sheet.overview.length < 600} />
          {sheet.status === 'analyzing' && must.length + nice.length === 0
            ? <p className="rv-muted" role="status">{t(respond ? 'own.analyzingHint' : 'analyzingHint')}</p>
            : (
              <>
                <Findings title={t(respond ? 'own.fixSection' : 'must')} findings={must} empty={t(respond ? 'own.fixEmpty' : 'mustEmpty')} disabled={disabled}
                  store={store} path={path} showLine={props.actions.showLine} respond={respond} />
                <Findings title={t(respond ? 'own.replySection' : 'nice')} findings={nice} empty={t(respond ? 'own.replyEmpty' : 'niceEmpty')} disabled={disabled}
                  store={store} path={path} showLine={props.actions.showLine} respond={respond} />
              </>
            )}
          {!respond && mine.length > 0 && (
            <Findings title={t('mine')} findings={mine} empty="" disabled={disabled} store={store} path={path} showLine={props.actions.showLine} />
          )}
          <section className="rv-section">
            <div className="rv-section-head"><h4>{t('rules')}</h4></div>
            <Draft value={sheet.rules} multiline rows={2} label={t('rules')} placeholder={t('rulesPlaceholder')} disabled={disabled}
              onSave={(value) => void store.patch(path, [{ op: 'rules', value }])} />
            {item !== undefined && !disabled && !respond && sheet.rules.trim() !== '' && (
              <button type="button" className="rv-link" disabled={item.queued === true || item.running === true} onClick={() => void store.analyze(item.key)}>{t('applyRules')}</button>
            )}
          </section>
          <Collapsible title={t('notes')} text={sheet.notes} open />
        </>
      )}
      <footer className="rv-foot">
        {session !== undefined && props.actions.openSession !== undefined && (
          <button type="button" className="ah-btn" onClick={() => props.actions.openSession!(session, path)}>{t('openSession')}</button>
        )}
        {props.actions.openSource !== undefined && sheet !== undefined && (
          <button type="button" className="ah-btn" onClick={() => props.actions.openSource!(path)}>{t('source')}</button>
        )}
        <span className="rv-grow" />
        {sheet !== undefined && !respond && sheet.status !== 'submitted' && (
          <button type="button" className="ah-btn" data-variant="primary" disabled={!canPreview} title={confirmLabel()} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => setPreviewing(true)}>{t('previewSubmit')}</button>
        )}
        {sheet !== undefined && respond && sheet.status !== 'submitted' && (
          // 按单修改 leads until the picked fixes are made; then the preview does, and fixing again stays at hand.
          <>
            {toFix > 0 && (
              <button type="button" className="ah-btn" data-variant={sheet.status === 'fixed' ? undefined : 'primary'} title={t('own.fixHint', { n: toFix })}
                disabled={(sheet.status !== 'ready' && sheet.status !== 'fixed') || busy} onClick={() => void store.fix(path)}>
                {sheet.status === 'fixing' ? t('own.fixing') : t(sheet.status === 'fixed' ? 'own.refixRun' : 'own.fixRun', { n: toFix })}
              </button>
            )}
            <button type="button" className="ah-btn" data-variant={toFix === 0 || sheet.status === 'fixed' ? 'primary' : undefined}
              disabled={!canPreview} title={confirmLabel()} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => setPreviewing(true)}>{t('own.previewPost')}</button>
          </>
        )}
      </footer>
    </div>
  )
}
