/**
 * Collections: small lists of records that travel with the settings, each in a JSON file of
 * its own (the clipboard's pinned texts, the reader's feeds and favorites). A record's identity
 * is its content (`parse` derives `id`), so the same thing added on two machines is one record;
 * a record is there or not, and a record edited on both sides to different contents is the only
 * conflict. Its time (`at`) is the earlier of the two, so every machine ends with the same order.
 *
 * A collection is merged against the version this machine's records last matched (an anchor of
 * its own, `dsh.<key>`), not where the commits met: records a machine never received are not
 * mistaken for ones it removed. A machine that cannot tell its records (the store answers
 * undefined, as the clipboard window does while it is off) leaves them as the other side has them.
 */

export interface CollectionRecord {
  id: string
  at: number
}

export interface Collection<T extends CollectionRecord = CollectionRecord> {
  /** The file in the sync repository. */
  file: string
  /** The list's key inside the file; also names the anchor (`dsh.<key>`), so letters only. */
  key: string
  /** The setting 不参与同步 lists to keep these records on this machine. */
  setting: string
  /** A stored or live record as kept, its `id` derived from its content; undefined drops it. */
  parse(raw: unknown): T | undefined
  /** The record's name where the settings page lists what differs. */
  name(record: T): string
}

/** Where one machine keeps a collection's records. */
export interface CollectionStore {
  /** The records; undefined while they cannot be told (their keeper is not running). */
  get(): Promise<readonly unknown[] | undefined>
  /** Makes these the records; false when the keeper did not take them. */
  set(records: CollectionRecord[]): Promise<boolean>
}

export const anchorOf = (collection: Collection): string => `dsh.${collection.key}`

const record = (raw: unknown): Record<string, unknown> | undefined =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined

/** What the merge compares: the record without its time. */
export function contentOf(item: CollectionRecord): string {
  const { at: _at, ...rest } = item
  return JSON.stringify(rest)
}

/** The records, one per id at its earliest time, oldest first: equal sets are equal files. */
export function normalize<T extends CollectionRecord>(collection: Collection<T>, items: readonly unknown[]): T[] {
  const byId = new Map<string, T>()
  for (const raw of items) {
    const item = collection.parse(raw)
    if (item === undefined) continue
    const known = byId.get(item.id)
    if (known === undefined) byId.set(item.id, item)
    else if (item.at < known.at) byId.set(item.id, { ...known, at: item.at })
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function serializeCollection(collection: Collection, items: readonly unknown[]): string {
  return `${JSON.stringify({ [collection.key]: normalize(collection, items) }, null, 2)}\n`
}

/** The stored records; undefined when the file is missing or unreadable. */
export function parseCollection<T extends CollectionRecord>(collection: Collection<T>, text: string | undefined): T[] | undefined {
  if (text === undefined) return undefined
  try {
    const list = record(JSON.parse(text))?.[collection.key]
    return normalize(collection, Array.isArray(list) ? list : [])
  } catch {
    return undefined
  }
}

/** A record time read from anything: a finite number, else 0. */
export const timeOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
