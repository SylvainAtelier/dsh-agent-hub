/**
 * Merging my own pull request, from its detail: one strip saying where it stands (a dot, a line,
 * then the checks, the review and the base) and the one thing to do about it.
 *
 * - Ready (GitHub says clean, or only optional checks fail): the repository's method, "Squash and
 *   merge" first when allowed. It asks once more before merging: a second press within a few
 *   seconds merges, Esc or leaving the button lets it be.
 * - Not ready yet (checks running, review wanted, behind its base): 启用自动合并, which lands it by
 *   itself once the requirements are met; on, the strip says so and offers to turn it off.
 * - Conflicts, a draft, closed: the reason, nothing to press. Merged: when, into what.
 * - Open: 草稿 | 可审 beside the checks turns it into a draft or marks it ready for review, at once
 *   on screen, undone if GitHub refuses.
 *
 * The method is picked from ▾ when the repository allows more than one, and kept per repository.
 * GitHub is read when the detail opens, every few seconds while something is still to come
 * (checks, auto-merge, GitHub working out conflicts), and when the page comes back to view. A
 * merged card leaves the lane once the detail closes, not under the eyes that merged it.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { MERGE_METHODS, type MergeMethod, type MergeState, type ReviewItem } from '../../review/types.ts'
import { Menu, type MenuAnchor, type MenuEntry } from '../git/kit.tsx'
import { injectGitStyle } from '../git/style.ts'
import type { ReviewStore } from './api.ts'
import { t, type ReviewKey } from './i18n.ts'

/** How long the second press of 合并 is waited for. */
const CONFIRM_MS = 4000
/** While something is still to come, and otherwise. */
const HOT_MS = 8_000
const COOL_MS = 60_000
const METHOD_KEY = 'dsh-agent-hub.review.mergeMethod.'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'auto' | 'merged' | 'busy'

/** What the strip says and offers. `go`: merge now; `auto`: turn auto-merge on; `off`: turn it off. */
interface Verdict {
  tone: Tone
  title: string
  action?: 'go' | 'auto' | 'off'
  /** Why the action cannot be taken; the button shows, disabled. */
  blocked?: string
}

const slugOf = (key: string): string => key.slice(0, key.lastIndexOf('#'))

function readMethod(slug: string): MergeMethod | undefined {
  try {
    const value = globalThis.localStorage?.getItem(METHOD_KEY + slug)
    return MERGE_METHODS.find((method) => method === value)
  } catch {
    return undefined
  }
}

function saveMethod(slug: string, method: MergeMethod): void {
  try {
    globalThis.localStorage?.setItem(METHOD_KEY + slug, method)
  } catch { /* private mode: picked for this view only */ }
}

/** The kept pick, else squash (what this is mostly for), else what GitHub saw me use, else what the repository allows. */
function methodFor(state: MergeState, kept: MergeMethod | undefined): MergeMethod {
  const allowed = (method: MergeMethod | undefined): method is MergeMethod => method !== undefined && state.methods.includes(method)
  return [kept, 'SQUASH' as const, state.preferred].find(allowed) ?? state.methods[0] ?? 'SQUASH'
}

/** Why it is not ready: the first requirement still open. */
function waitingOn(state: MergeState): string {
  if (state.checks.failed > 0) return t('merge.checksFailed', { n: state.checks.failed })
  if (state.checks.pending > 0) return t('merge.checksRunning')
  if (state.decision === 'CHANGES_REQUESTED') return t('merge.changesRequested')
  if (state.decision === 'REVIEW_REQUIRED') return t('merge.reviewRequired')
  if (state.status === 'BEHIND') return t('merge.behind', { base: state.base })
  return t('merge.blocked')
}

function verdictOf(state: MergeState): Verdict {
  if (state.state === 'MERGED') return { tone: 'merged', title: t('merge.merged', { base: state.base }) }
  if (state.state === 'CLOSED') return { tone: 'muted', title: t('merge.closed') }
  if (state.draft) return { tone: 'muted', title: t('merge.draft') }
  if (state.auto !== undefined) return { tone: 'auto', title: t('merge.autoOn', { base: state.base }), action: 'off' }
  if (state.mergeable === 'CONFLICTING' || state.status === 'DIRTY') return { tone: 'danger', title: t('merge.conflicts', { base: state.base }), action: 'go', blocked: t('merge.conflictsHint') }
  if (state.methods.length === 0) return { tone: 'muted', title: t('merge.noMethod') }
  if (state.status === 'CLEAN' || state.status === 'HAS_HOOKS') return { tone: 'ok', title: t('merge.ready'), action: 'go' }
  if (state.status === 'UNSTABLE') return { tone: 'warn', title: t('merge.unstable'), action: 'go' }
  if (state.status === 'UNKNOWN' || state.mergeable === 'UNKNOWN') return { tone: 'busy', title: t('merge.checking') }
  const why = waitingOn(state)
  return state.canAuto
    ? { tone: state.checks.failed > 0 || state.decision === 'CHANGES_REQUESTED' ? 'danger' : 'warn', title: why, action: 'auto' }
    : { tone: state.checks.failed > 0 ? 'danger' : 'warn', title: why, action: 'go', blocked: t('merge.notYet') }
}

/** Whether something is still to come, so GitHub is read again soon. */
const moving = (state: MergeState | undefined): boolean =>
  state !== undefined && state.state === 'OPEN' && (state.checks.pending > 0 || state.auto !== undefined || state.status === 'UNKNOWN' || state.mergeable === 'UNKNOWN')

/** The checks as counts: passed of all, then what failed or runs. */
function Checks(props: { checks: MergeState['checks'] }): ReactNode {
  const { passed, failed, pending } = props.checks
  const total = passed + failed + pending
  if (total === 0) return <span>{t('merge.noChecks')}</span>
  return (
    <span className="rv-merge-checks" title={t('merge.checksHint', { passed, failed, pending })}>
      <span data-tone={failed > 0 ? 'danger' : pending > 0 ? 'warn' : 'ok'}>{t('merge.checks', { passed, total })}</span>
      {failed > 0 && <span data-tone="danger"> · {t('merge.failedN', { n: failed })}</span>}
      {pending > 0 && <span data-tone="warn"> · {t('merge.pendingN', { n: pending })}</span>}
    </span>
  )
}

function Chevron(): ReactNode {
  return <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>
}

function MergeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="8.5" r="1.5" />
      <path d="M4.5 5v6M4.5 5c0 2.5 2 3.5 5.5 3.5" />
    </svg>
  )
}

export function MergeStrip(props: { store: ReviewStore; item: ReviewItem }): ReactNode {
  const { store, item } = props
  const slug = slugOf(item.key)
  const [state, setState] = useState<MergeState | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<'go' | 'auto' | 'off' | 'draft' | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [kept, setKept] = useState<MergeMethod | undefined>(() => readMethod(slug))
  const [menu, setMenu] = useState<MenuAnchor | undefined>()
  const working = useRef(false)
  const merged = useRef(false)
  // The method menu is the git pane's.
  useEffect(injectGitStyle, [])

  const read = useCallback(async (): Promise<void> => {
    try {
      const next = await store.mergeState(item.key)
      // An action in flight answers with GitHub's word after it: a read from before must not cover it.
      if (working.current) return
      setState(next)
      setError(undefined)
    } catch (failure) {
      if (!working.current) setError(message(failure))
    }
  }, [store, item.key])

  useEffect(() => { void read() }, [read])
  // Again soon while something is still to come; seldom otherwise; at once when the page is back in view.
  useEffect(() => {
    if (state !== undefined && state.state !== 'OPEN') return
    const timer = setTimeout(() => { if (document.visibilityState === 'visible') void read() }, moving(state) ? HOT_MS : COOL_MS)
    return () => clearTimeout(timer)
  }, [state, read])
  useEffect(() => {
    const back = (): void => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [read])
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [confirming])
  // Merged here: the lane reads GitHub again once the detail closes, and the card leaves it then.
  useEffect(() => () => { if (merged.current) void store.load() }, [store])

  const act = async (action: 'go' | 'auto' | 'off', method: MergeMethod): Promise<void> => {
    working.current = true
    setBusy(action)
    setError(undefined)
    setConfirming(false)
    try {
      const next = action === 'off' ? await store.cancelAutoMerge(item.key) : await store.merge(item.key, method, action === 'auto', state?.head)
      setState(next)
      if (next.state === 'MERGED') merged.current = true
    } catch (failure) {
      setError(message(failure))
      // What failed may have moved it on (a new head, a check that ended): read it as it is now.
      working.current = false
      void read()
    }
    working.current = false
    setBusy(undefined)
  }

  const setDraft = async (draft: boolean): Promise<void> => {
    if (state === undefined || state.draft === draft || busy !== undefined) return
    const before = state
    working.current = true
    setBusy('draft')
    setError(undefined)
    setConfirming(false)
    setState({ ...state, draft })
    try {
      setState(await store.setDraft(item.key, draft))
      // The card's draft mark follows.
      void store.load()
    } catch (failure) {
      setState(before)
      setError(message(failure))
    }
    working.current = false
    setBusy(undefined)
  }

  if (state === undefined) {
    return (
      <section className="rv-merge" data-tone={error === undefined ? 'busy' : 'danger'} aria-label={t('merge.label')} aria-busy={error === undefined}>
        <div className="rv-merge-main">
          <span className="rv-merge-dot" aria-hidden="true" />
          <div className="rv-merge-text">
            <span className="rv-merge-title" role={error === undefined ? 'status' : 'alert'}>{error === undefined ? t('merge.loading') : t('merge.loadFailed', { message: error })}</span>
          </div>
          {error !== undefined && <button type="button" className="ah-btn ah-btn-sm" onClick={() => { setError(undefined); void read() }}>{t('retry')}</button>}
        </div>
      </section>
    )
  }

  const verdict = verdictOf(state)
  const method = methodFor(state, kept)
  const choose = state.methods.length > 1 && (verdict.action === 'go' || verdict.action === 'auto') && verdict.blocked === undefined
  const press = (): void => {
    if (verdict.action === undefined || busy !== undefined) return
    if (verdict.action === 'go' && !confirming) {
      setConfirming(true)
      return
    }
    void act(verdict.action, verdict.action === 'off' ? state.auto?.method ?? method : method)
  }
  const label = busy === 'go' ? t('merge.merging') : busy === 'auto' ? t('merge.enabling') : busy === 'off' ? t('merge.disabling')
    : verdict.action === 'off' ? t('merge.cancelAuto')
    : verdict.action === 'auto' ? t('merge.enableAuto', { method: t(`merge.short.${method}` as ReviewKey) })
    : confirming ? t('merge.confirm', { method: t(`merge.short.${method}` as ReviewKey) })
    : t(`merge.${method}` as ReviewKey)
  const hint = verdict.blocked ?? (verdict.action === 'go'
    ? (confirming ? t('merge.confirmHint') : t(`merge.hint.${method}` as ReviewKey, { base: state.base }))
    : verdict.action === 'auto' ? t('merge.autoHint', { base: state.base })
    : verdict.action === 'off' ? t('merge.cancelAutoHint') : undefined)
  const entries: MenuEntry[] = [
    { heading: t('merge.method') },
    ...state.methods.map((value): MenuEntry => ({
      id: value, label: t(`merge.${value}` as ReviewKey), hint: t(`merge.hint.${value}` as ReviewKey, { base: state.base }), checked: value === method,
    })),
  ]
  const when = state.mergedAt === undefined ? '' : new Date(state.mergedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <section className="rv-merge" data-tone={verdict.tone} aria-label={t('merge.label')}>
      <div className="rv-merge-main">
        <span className="rv-merge-dot" aria-hidden="true">{verdict.tone === 'merged' && <MergeIcon />}</span>
        <div className="rv-merge-text">
          <span className="rv-merge-title" role="status">{verdict.title}</span>
          <span className="rv-merge-meta">
            {state.state === 'MERGED'
              ? <span>{when}</span>
              : (
                <>
                  <Checks checks={state.checks} />
                  {state.decision !== undefined && <span data-rd={state.decision}>{t(`rd.${state.decision}` as ReviewKey)}</span>}
                  {state.auto !== undefined && <span>{t(`merge.short.${state.auto.method}` as ReviewKey)}{state.auto.by !== '' && ` · @${state.auto.by}`}</span>}
                </>
              )}
            <span className="rv-merge-base">→ <code>{state.base}</code></span>
            {state.state === 'OPEN' && (
              <span className="ah-seg rv-draft" role="radiogroup" aria-label={t('draft.label')} aria-busy={busy === 'draft'}>
                {[true, false].map((draft) => (
                  <button key={String(draft)} type="button" role="radio" aria-checked={state.draft === draft}
                    title={t(draft ? 'draft.toDraftHint' : 'draft.readyHint')} disabled={busy !== undefined && busy !== 'draft'}
                    onClick={() => void setDraft(draft)}>
                    {t(draft ? 'draft.draft' : 'draft.ready')}
                  </button>
                ))}
              </span>
            )}
          </span>
        </div>
        {verdict.action !== undefined && (
          <div className="rv-merge-actions" data-split={choose ? '' : undefined}>
            <button type="button" className="ah-btn rv-merge-go" data-action={verdict.action} data-confirm={confirming ? '' : undefined}
              data-variant={verdict.action === 'off' ? undefined : 'primary'} aria-live="polite" title={hint}
              disabled={busy !== undefined || verdict.blocked !== undefined} aria-busy={busy !== undefined}
              onBlur={() => setConfirming(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && confirming) {
                  event.stopPropagation()
                  setConfirming(false)
                }
              }}
              onClick={press}>
              {busy !== undefined ? <span className="rv-spin" aria-hidden="true" /> : verdict.action !== 'off' && <MergeIcon />}
              <span>{label}</span>
            </button>
            {choose && (
              <button type="button" className="ah-btn rv-merge-pick" data-variant="primary" aria-haspopup="menu" aria-expanded={menu !== undefined}
                aria-label={t('merge.method')} title={t('merge.method')} disabled={busy !== undefined}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setMenu({ x: rect.right, y: rect.bottom, rect, align: 'end' })
                }}>
                <Chevron />
              </button>
            )}
          </div>
        )}
      </div>
      {confirming && <p className="rv-merge-note">{t('merge.confirmNote', { method: t(`merge.short.${method}` as ReviewKey), base: state.base })}</p>}
      {error !== undefined && <p className="rv-merge-note" role="alert" data-tone="danger">{error}</p>}
      {menu !== undefined && (
        <Menu anchor={menu} entries={entries} label={t('merge.method')} className="rv-menu"
          onSelect={(id) => {
            const value = MERGE_METHODS.find((entry) => entry === id)
            if (value !== undefined) {
              setKept(value)
              saveMethod(slug, value)
              setConfirming(false)
            }
            setMenu(undefined)
          }}
          onClose={() => setMenu(undefined)} />
      )}
    </section>
  )
}
