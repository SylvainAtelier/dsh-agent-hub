/**
 * How a repository's tickets were last filed (`board.tickets`) and the bot
 * last picked for a draft (`board.ticketBot`), kept in the profile through the
 * settings form, so they sync with it to every machine. Attached where DSH's
 * configuration forms exist; without them the board still creates tickets, it
 * just starts from its own defaults each time.
 */

import type { TicketDefaults } from '../../board/types.ts'
import { samePath } from '../../repos/types.ts'
import type { ConfigScope } from '../config/form.ts'

let scope: ConfigScope | undefined
const FIELDS = ['linear', 'team', 'project', 'channel', 'channelName', 'notify'] as const

export function attachTicketDefaults(next: ConfigScope): () => void {
  scope = next
  return () => { if (scope === next) scope = undefined }
}

const board = (): Record<string, unknown> | undefined => {
  const snapshot = scope?.getSnapshot()
  return snapshot?.status === 'ready' ? snapshot.value?.board : undefined
}

const entries = (): TicketDefaults[] => {
  const list = board()?.tickets
  return Array.isArray(list) ? list.filter((item): item is TicketDefaults => typeof (item as TicketDefaults | null)?.repo === 'string') : []
}

export const ticketDefaults = (repo: string): TicketDefaults | undefined => entries().find((item) => samePath(item.repo, repo))

export const ticketBot = (): string => {
  const id = board()?.ticketBot
  return typeof id === 'string' ? id : ''
}

/** Save what changed, in one revision-fenced write; false when it could not be kept. */
async function save(key: string, value: unknown): Promise<boolean> {
  const snapshot = scope?.getSnapshot()
  if (scope === undefined || snapshot?.status !== 'ready' || !snapshot.writable) return false
  return scope.mutate([{ op: 'set', path: ['board', key], value }], snapshot.revision).catch(() => false)
}

/** Remember how a repository's ticket was filed; nothing is written when nothing changed. */
export function rememberTicket(next: TicketDefaults): Promise<boolean> {
  const list = entries()
  const index = list.findIndex((item) => samePath(item.repo, next.repo))
  const clean = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== '')) as unknown as TicketDefaults
  const kept = list[index]
  if (kept !== undefined && FIELDS.every((key) => (kept[key] ?? '') === (clean[key] ?? ''))) return Promise.resolve(true)
  return save('tickets', index < 0 ? [...list, clean] : list.map((item, i) => (i === index ? clean : item)))
}

export function rememberBot(id: string): Promise<boolean> {
  return id === ticketBot() ? Promise.resolve(true) : save('ticketBot', id)
}
