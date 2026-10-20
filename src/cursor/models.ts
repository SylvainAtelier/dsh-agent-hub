/**
 * Cursor's models and their reasoning levels, in DSH's vocabulary.
 *
 * Over ACP each model lists its knobs as config options. The reasoning ones
 * carry the `thought_level` category but differ by model: an effort menu
 * (`effort`, `reasoning`, `reasoning_effort`; values low…max, sometimes
 * `none`), a thinking switch (`thinking`: false/true), or both. DSH has one
 * reasoning picker per model, so they fold into one list on DSH's effort
 * ladder (efforts.ts): `off` turns thinking off (or picks `none`), the menu's
 * own levels follow; a model with only the switch offers `off` and `low`,
 * shown as "On", so a shared effort of low or above keeps thinking on.
 * Speed and context knobs (`fast`, `context`, Auto's `optimize_for`) keep the
 * CLI's defaults.
 */

import { readFile } from 'node:fs/promises'
import { jsonWriter } from '../persistence.ts'
import type { ConfigOption } from './acp.ts'

export const THOUGHT = 'thought_level'
const OFF = 'off'
/** A switch-only model's "thinking on": the lowest rung that is not off. */
const ON = 'low'

/** One model's reasoning knobs. */
export interface ThoughtSpec {
  /** The effort menu's option id and its values (`none` already read as `off`). */
  menu?: { id: string; values: string[]; names: Record<string, string> }
  /** The thinking switch's option id. */
  toggle?: string
  /** The level the model starts at in a fresh session. */
  defaultEffort?: string
}

const isSwitch = (option: ConfigOption): boolean => {
  const values = (option.options ?? []).map((entry) => entry.value).sort()
  return values.length === 2 && values[0] === 'false' && values[1] === 'true'
}

const level = (value: string): string => (value === 'none' ? OFF : value)

/** The reasoning knobs among a session's config options; undefined when the model has none. */
export function thoughtSpec(options: readonly ConfigOption[]): ThoughtSpec | undefined {
  const thought = options.filter((option) => option.category === THOUGHT && (option.options?.length ?? 0) > 0)
  const toggle = thought.find(isSwitch)
  const menu = thought.find((option) => !isSwitch(option))
  if (toggle === undefined && menu === undefined) return undefined
  const spec: ThoughtSpec = {}
  if (menu !== undefined) {
    const values = menu.options!.map((entry) => level(entry.value))
    const names = Object.fromEntries(menu.options!.map((entry) => [level(entry.value), entry.value === 'none' ? 'Off' : entry.name ?? entry.value]))
    spec.menu = { id: menu.id, values: [...new Set(values)], names }
  }
  if (toggle !== undefined) spec.toggle = toggle.id
  const thinking = toggle === undefined ? true : toggle.currentValue !== 'false'
  spec.defaultEffort = !thinking ? OFF : menu?.currentValue !== undefined ? level(menu.currentValue) : ON
  return spec
}

/** The levels DSH's picker offers for a model, least thinking first. */
export function effortsOf(spec: ThoughtSpec): Array<{ id: string; name: string }> {
  const levels: Array<{ id: string; name: string }> = []
  const menu = spec.menu
  if (spec.toggle !== undefined || menu?.values.includes(OFF)) levels.push({ id: OFF, name: 'Off' })
  if (menu === undefined) levels.push({ id: ON, name: 'On' })
  else for (const value of menu.values) if (value !== OFF) levels.push({ id: value, name: menu.names[value] ?? value })
  return levels
}

/** The option changes that put a session on `effort`, given its current options; empty when nothing changes. */
export function effortChanges(spec: ThoughtSpec, effort: string, current: readonly ConfigOption[]): Array<[string, string]> {
  const value = (id: string): string | undefined => current.find((option) => option.id === id)?.currentValue
  const wanted: Array<[string, string]> = []
  if (effort === OFF) {
    if (spec.toggle !== undefined) wanted.push([spec.toggle, 'false'])
    else if (spec.menu?.values.includes(OFF)) {
      // The menu calls it none.
      const raw = current.find((option) => option.id === spec.menu!.id)?.options?.some((entry) => entry.value === 'none') ? 'none' : OFF
      wanted.push([spec.menu.id, raw])
    }
  } else {
    if (spec.toggle !== undefined) wanted.push([spec.toggle, 'true'])
    if (spec.menu?.values.includes(effort)) wanted.push([spec.menu.id, effort])
  }
  return wanted.filter(([id, next]) => value(id) !== next)
}

export interface CatalogModel {
  id: string
  name: string
}

/** What persists: the model list and, per model, its reasoning knobs (null: it has none). */
export interface CatalogSnapshot {
  at: number
  models: CatalogModel[]
  thought: Record<string, ThoughtSpec | null>
}

/** The model list from a session's `model` option. */
export function modelsOf(options: readonly ConfigOption[]): CatalogModel[] {
  const model = options.find((option) => option.id === 'model' || option.category === 'model')
  return (model?.options ?? []).map((entry) => ({ id: entry.value, name: entry.name ?? entry.value }))
}

/** Reads the catalog from a short-lived probe session (no prompt, no usage). */
export interface Prober {
  /** Open the probe session and return the model list. */
  open(): Promise<CatalogModel[]>
  /** One model's config options in the probe session. */
  options(model: string): Promise<ConfigOption[]>
  close(): Promise<void>
}

const TTL_MS = 12 * 60 * 60_000
const RETRY_MS = 60_000
/** How long a model picker waits for a model's levels before showing it without them. */
const WAIT_MS = 8_000

/**
 * The catalog, stale-while-revalidate like Claude Agent's: once any snapshot
 * is known (persisted across restarts) lookups answer at once. A refresh
 * reads the list, then each model's knobs one by one (each switch takes the
 * CLI about 1.5 s); a model someone is picking right now jumps the queue.
 */
export class CursorCatalog {
  private snapshot: CatalogSnapshot | undefined
  private refreshing: Promise<void> | undefined
  /** Settles once the refresh in flight has the model list (its knobs keep coming in the background). */
  private listed: Promise<void> | undefined
  private failedAt = 0
  private urgent: string[] = []
  private waiters = new Map<string, Array<() => void>>()
  private restored: Promise<void>

  private readonly prober: () => Prober
  private readonly file: string | undefined
  private readonly write: ((value: unknown) => Promise<void>) | undefined
  private readonly log: (message: string) => void

  constructor(prober: () => Prober, file?: string, log: (message: string) => void = () => {}) {
    this.prober = prober
    this.file = file
    this.write = file === undefined ? undefined : jsonWriter(file)
    this.log = log
    this.restored = this.restore()
  }

  async models(): Promise<CatalogModel[]> {
    await this.restored
    this.revalidate()
    if (this.snapshot !== undefined) return this.snapshot.models
    await this.listed
    // Set by the refresh just awaited.
    return (this.snapshot as CatalogSnapshot | undefined)?.models ?? []
  }

  /** A model's reasoning knobs; waits a little for an unread model, then answers without. */
  async thought(model: string): Promise<ThoughtSpec | undefined> {
    await this.restored
    const known = this.snapshot?.thought[model]
    if (known !== undefined) return known ?? undefined
    this.urgent.unshift(model)
    this.revalidate(true)
    // Nothing is reading the catalog (the CLI just failed): answer without levels rather than wait.
    if (this.refreshing === undefined) return undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, WAIT_MS)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.waiters.set(model, [...(this.waiters.get(model) ?? []), done])
    })
    return this.snapshot?.thought[model] ?? undefined
  }

  /** Learn a model's knobs from a live session (any session lists them after its model is set). */
  learn(model: string, options: readonly ConfigOption[]): void {
    if (this.snapshot === undefined || !options.some((option) => option.id === 'model' && option.currentValue === model)) return
    const spec = thoughtSpec(options) ?? null
    if (JSON.stringify(this.snapshot.thought[model]) === JSON.stringify(spec)) return
    this.snapshot.thought[model] = spec
    this.save()
  }

  private revalidate(force = false): void {
    if (this.refreshing !== undefined) return
    const now = Date.now()
    const stale = this.snapshot === undefined || now - this.snapshot.at >= TTL_MS
      || (force && this.urgent.some((model) => this.snapshot!.thought[model] === undefined))
    if (!stale || now - this.failedAt < RETRY_MS) return
    let listed!: () => void
    this.listed = new Promise<void>((resolve) => { listed = resolve })
    this.refreshing = this.refresh(listed).catch((error: unknown) => {
      this.failedAt = Date.now()
      this.log(`Cursor model catalog unavailable: ${(error as Error).message}`)
    }).finally(() => {
      this.refreshing = undefined
      listed()
      for (const list of this.waiters.values()) for (const wake of list) wake()
      this.waiters.clear()
    })
  }

  private async refresh(listed: () => void): Promise<void> {
    const probe = this.prober()
    try {
      const models = await probe.open()
      if (models.length === 0) throw new Error('the CLI listed no models')
      const previous = this.snapshot
      const fresh = previous === undefined || Date.now() - previous.at >= TTL_MS
      // A full refresh rereads every model; an urgent one only reads what is missing.
      const thought: Record<string, ThoughtSpec | null> = fresh ? {} : { ...previous.thought }
      this.snapshot = { at: fresh ? Date.now() : previous.at, models, thought: { ...(previous?.thought ?? {}), ...thought } }
      listed()
      const queue = models.map((model) => model.id).filter((id) => fresh || thought[id] === undefined)
      const done = new Set<string>()
      while (queue.length > 0 || this.urgent.length > 0) {
        const id = this.urgent.shift() ?? queue.shift()!
        if (done.has(id) || !models.some((model) => model.id === id)) {
          this.wake(id)
          continue
        }
        done.add(id)
        this.snapshot.thought[id] = thoughtSpec(await probe.options(id)) ?? null
        this.wake(id)
      }
      // Drop the knobs of models no longer listed.
      this.snapshot.thought = Object.fromEntries(Object.entries(this.snapshot.thought).filter(([id]) => models.some((model) => model.id === id)))
      this.save()
    } finally {
      await probe.close().catch(() => {})
    }
  }

  private wake(model: string): void {
    for (const wake of this.waiters.get(model) ?? []) wake()
    this.waiters.delete(model)
  }

  private async restore(): Promise<void> {
    if (this.file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<CatalogSnapshot>
      if (typeof saved.at !== 'number' || !Array.isArray(saved.models) || saved.models.length === 0) return
      this.snapshot = { at: saved.at, models: saved.models, thought: typeof saved.thought === 'object' && saved.thought !== null ? saved.thought : {} }
    } catch {
      // Nothing saved yet: the first lookup reads it live.
    }
  }

  private save(): void {
    if (this.snapshot === undefined) return
    this.write?.(this.snapshot).catch((error: unknown) => this.log(`Cursor model catalog save failed: ${(error as Error).message}`))
  }
}
