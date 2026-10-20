/** Atomic replacement, and one file's writes in order; callers own validation and recovery policy. */
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Windows refuses a rename over a file another process (an indexer, an antivirus scan) holds open for a moment. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_TRIES = 5

async function replace(temporary: string, file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temporary, file)
      return
    } catch (error) {
      if (attempt >= RENAME_TRIES || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

export async function atomicWriteText(file: string, text: string, mode?: number): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(temporary, text, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) })
    await replace(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, JSON.stringify(value), 0o600)
}

/**
 * One JSON file's writes, one at a time and in call order. A failed write does not block the next,
 * and a value the file already holds (as this writer last wrote it) is not written again. Each call
 * returns its own write; callers that cannot wait pass a `.catch`.
 */
export function jsonWriter(file: string, write: (file: string, value: unknown) => Promise<void> = atomicWriteJson): (value: unknown) => Promise<void> {
  let queue: Promise<void> = Promise.resolve()
  let written: string | undefined
  return (value) => {
    const text = JSON.stringify(value)
    // Written as it was when asked for: the caller may change the object before its turn comes.
    const next = queue.catch(() => {}).then(async () => {
      if (text === written) return
      await write(file, JSON.parse(text))
      written = text
    })
    queue = next
    return next
  }
}
