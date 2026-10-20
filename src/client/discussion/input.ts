/** Use the host's revision-checked reference insertion event, never intercept Send. */
import { discussionReferences, discussionToken, type Discussion } from '../../discussion/types.ts'
import { t } from './i18n.ts'
export const DISCUSSION_SOURCE = 'agent-hub.discussion'
export interface InputSnapshot {
  draft: string
  phase?: string
  occurrences?: ReadonlyArray<{ ref: string; offset: number; length: number }>
}
export interface InputBridge {
  actions: { captureInsertion(): { start: number; end: number; draftRev?: number; [key: string]: unknown } }
  snapshot(): InputSnapshot
}
export interface InputScope { bail(subject: InputScope, event: string, payload: unknown): unknown }
export function referenceSpan(bridge: InputBridge, sessionId: string, id: string): ReturnType<InputBridge['actions']['captureInsertion']> {
  const span = bridge.actions.captureInsertion()
  const snapshot = bridge.snapshot()
  const existing = discussionReferences(snapshot.draft).find((ref) => ref.sessionId === sessionId && ref.id === id)
  if (existing === undefined) return { ...span, start: span.end, end: span.end }
  const offset = snapshot.draft.indexOf(existing.token)
  const end = offset + existing.token.length
  const occurrences = snapshot.occurrences ?? []
  const detect = (position: number): number => position - occurrences.filter((o) => o.offset < position).reduce((sum, o) => sum + Math.min(o.length, position - o.offset) - 1, 0)
  return { ...span, start: detect(offset), end: detect(end) }
}
export function insertDiscussion(scope: InputScope | undefined, bridge: InputBridge | undefined, sessionId: string, thread: Discussion): boolean {
  if (scope === undefined || bridge === undefined || !thread.confirmed) return false
  const ref = discussionToken(sessionId, thread.id, thread.confirmed)
  if (bridge.snapshot().draft.includes(ref)) return true
  return scope.bail(scope, 'slash/input-insert-reference', {
    reference: { source: DISCUSSION_SOURCE, ref, label: `${t('title')} · ${thread.confirmed} ${t('count')}`, clipboardText: ref },
    span: referenceSpan(bridge, sessionId, thread.id),
  }) === true
}
