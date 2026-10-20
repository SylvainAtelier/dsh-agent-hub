/** The first release deliberately accepts only lossless plain-text drafts. */
export interface InputSnapshot {
  draft: string
  draftRev: number
  phase: string
  attachmentIds: readonly string[]
  occurrences: readonly unknown[]
}
export interface InputActions {
  insertText(text: string, span: { start: number; end: number; draftRev: number }): boolean
}
export function draftIssue(input: InputSnapshot | undefined): 'empty' | 'attachments' | 'references' | 'command' | 'busy' | undefined {
  if (input === undefined || input.phase !== 'plain') return 'busy'
  if (input.attachmentIds.length > 0) return 'attachments'
  if (input.occurrences.length > 0) return 'references'
  if (input.draft.trimStart().startsWith('/')) return 'command'
  if (input.draft.trim() === '') return 'empty'
  return undefined
}
/** Never clear a newer edit or attachments added while the request was pending. */
export function clearSubmittedDraft(actions: InputActions, submitted: InputSnapshot, current: InputSnapshot | undefined): boolean {
  if (draftIssue(current) !== undefined || current!.draftRev !== submitted.draftRev || current!.draft !== submitted.draft) return false
  return actions.insertText('', { start: 0, end: submitted.draft.length, draftRev: submitted.draftRev })
}

/** Local wall-clock inputs must survive round-trip, including DST gaps and overlaps. */
export function localInstant(date: string, time: string, now = Date.now()): { at: string } | { error: 'invalid-time' | 'ambiguous-time' | 'not-future' } {
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) return { error: 'invalid-time' }
  const expected = `${date}T${time}`
  const value = new Date(`${expected}:00`)
  const matches = (d: Date): boolean => localFields(d).date + 'T' + localFields(d).time === expected
  if (!Number.isFinite(value.getTime()) || !matches(value)) return { error: 'invalid-time' }
  // Current IANA backward clock transitions are at most a few hours (including half-hour shifts).
  for (const minutes of [30, 60, 90, 120, 180]) {
    if (matches(new Date(value.getTime() - minutes * 60_000)) || matches(new Date(value.getTime() + minutes * 60_000))) return { error: 'ambiguous-time' }
  }
  return value.getTime() <= now ? { error: 'not-future' } : { at: value.toISOString() }
}
export function localFields(date: Date): { date: string; time: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` }
}
