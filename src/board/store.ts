/**
 * Local tasks, kept in one JSON file under DSH's home. Writes go through a
 * temporary file and a rename, one at a time, so a crash never leaves half a
 * file. A corrupt file is backed up before the board starts empty. Read or
 * backup failures are surfaced and never treated as permission to overwrite.
 */

import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { atomicWriteJson } from '../persistence.ts'
import { isPriority, isStage, type LocalTask, type Stage } from './types.ts'

const MAX_TITLE = 300
const MAX_NOTE = 20_000
const MAX_TASKS = 2_000

interface FileShape {
  version: 1
  tasks: LocalTask[]
}

function clean(value: unknown): LocalTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.repo !== 'string' || !isStage(raw.stage)) return undefined
  const now = Date.now()
  return {
    id: raw.id,
    title: raw.title.slice(0, MAX_TITLE),
    repo: raw.repo,
    stage: raw.stage,
    ...(typeof raw.note === 'string' && raw.note !== '' ? { note: raw.note.slice(0, MAX_NOTE) } : {}),
    ...(isPriority(raw.priority) && raw.priority > 0 ? { priority: raw.priority } : {}),
    ...(typeof raw.branch === 'string' && raw.branch !== '' ? { branch: raw.branch } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  }
}

export interface TaskPatch {
  title?: string
  note?: string
  stage?: Stage
  repo?: string
  branch?: string
  /** 0 clears it. */
  priority?: number
}

export class LocalTasks {
  private readonly file: string
  private tasks: Promise<LocalTask[]> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  async list(): Promise<LocalTask[]> {
    this.tasks ??= this.load()
    // Callers must not be able to mutate the persisted snapshot (including individual tasks).
    return (await this.tasks).map((task) => ({ ...task }))
  }

  private async load(): Promise<LocalTask[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed = JSON.parse(text) as Partial<FileShape> | null
      if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error('invalid task file')
      const tasks = parsed.tasks.map(clean)
      if (tasks.some((task) => task === undefined)) throw new Error('invalid task')
      return tasks as LocalTask[]
    } catch {
      // If backup fails, keep the rejection cached: no change may overwrite the original.
      await rename(this.file, `${this.file}.corrupt-${Date.now()}-${randomUUID()}`)
      return []
    }
  }

  /** Run one change against the current list and persist it; changes never interleave. */
  private change<T>(body: (tasks: LocalTask[]) => T): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      const tasks = [...await this.list()]
      const result = body(tasks)
      await atomicWriteJson(this.file, { version: 1, tasks } satisfies FileShape)
      this.tasks = Promise.resolve(tasks.map((task) => ({ ...task })))
      return result
    })
    this.queue = next
    return next
  }

  create(input: { title: string; repo: string; note?: string; stage?: Stage; priority?: number }): Promise<LocalTask> {
    const title = input.title.trim().slice(0, MAX_TITLE)
    if (title === '') return Promise.reject(new Error('a task needs a title'))
    return this.change((tasks) => {
      if (tasks.length >= MAX_TASKS) throw new Error('too many tasks')
      const now = Date.now()
      const note = input.note?.trim().slice(0, MAX_NOTE)
      const task: LocalTask = {
        id: randomUUID(), title, repo: input.repo, stage: input.stage ?? 'unstarted',
        ...(note ? { note } : {}), ...(input.priority ? { priority: input.priority } : {}), createdAt: now, updatedAt: now,
      }
      tasks.push(task)
      return task
    })
  }

  update(id: string, patch: TaskPatch): Promise<LocalTask> {
    return this.change((tasks) => {
      const index = tasks.findIndex((task) => task.id === id)
      if (index < 0) throw new Error('no such task')
      const current = tasks[index]!
      const title = patch.title === undefined ? current.title : patch.title.trim().slice(0, MAX_TITLE)
      if (title === '') throw new Error('a task needs a title')
      const note = patch.note === undefined ? current.note : patch.note.trim().slice(0, MAX_NOTE)
      const priority = patch.priority ?? current.priority
      const { note: _note, priority: _priority, ...rest } = current
      const next: LocalTask = {
        ...rest,
        title,
        ...(note ? { note } : {}),
        ...(priority ? { priority } : {}),
        ...(patch.stage === undefined ? {} : { stage: patch.stage }),
        ...(patch.repo === undefined ? {} : { repo: patch.repo }),
        ...(patch.branch === undefined ? {} : { branch: patch.branch }),
        updatedAt: Date.now(),
      }
      tasks[index] = next
      return next
    })
  }

  remove(id: string): Promise<void> {
    return this.change((tasks) => {
      const index = tasks.findIndex((task) => task.id === id)
      if (index >= 0) tasks.splice(index, 1)
    })
  }
}
