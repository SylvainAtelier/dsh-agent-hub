/**
 * Changed files as a folder tree. Single-child folder chains are compacted
 * into one row (`src/client/git`), folders sort before files, and the tree
 * flattens to rows so it renders through the same fixed-row virtual list.
 */

export interface TreeDir<T> {
  kind: 'dir'
  /** Display name, possibly compacted (`a/b/c`). */
  name: string
  /** Full repo-relative path of the folder. */
  path: string
  dirs: TreeDir<T>[]
  files: TreeFile<T>[]
  /** Files anywhere below. */
  count: number
}

export interface TreeFile<T> {
  kind: 'file'
  name: string
  path: string
  item: T
}

interface Building<T> {
  dirs: Map<string, Building<T>>
  files: TreeFile<T>[]
}

export function buildTree<T>(items: readonly T[], pathOf: (item: T) => string): TreeDir<T> {
  const root: Building<T> = { dirs: new Map(), files: [] }
  for (const item of items) {
    const path = pathOf(item)
    const parts = path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!
      let next = node.dirs.get(part)
      if (next === undefined) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push({ kind: 'file', name: parts[parts.length - 1]!, path, item })
  }
  const finish = (node: Building<T>, name: string, path: string): TreeDir<T> => {
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([part, child]) => {
        let label = part
        let full = path === '' ? part : `${path}/${part}`
        let current = child
        // Compact a folder that holds exactly one folder and nothing else.
        while (current.files.length === 0 && current.dirs.size === 1) {
          const [[nextPart, nextChild]] = [...current.dirs.entries()] as [[string, Building<T>]]
          label = `${label}/${nextPart}`
          full = `${full}/${nextPart}`
          current = nextChild
        }
        return finish(current, label, full)
      })
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name))
    return { kind: 'dir', name, path, dirs, files, count: files.length + dirs.reduce((sum, dir) => sum + dir.count, 0) }
  }
  return finish(root, '', '')
}

export type TreeRow<T> =
  | { kind: 'dir'; dir: TreeDir<T>; depth: number; open: boolean }
  | { kind: 'file'; file: TreeFile<T>; depth: number }

/**
 * Rows in display order. `closed` holds folder paths the reader collapsed;
 * the root itself is never a row.
 */
export function flattenTree<T>(root: TreeDir<T>, closed: ReadonlySet<string>, depth = 0, out: TreeRow<T>[] = []): TreeRow<T>[] {
  for (const dir of root.dirs) {
    const open = !closed.has(dir.path)
    out.push({ kind: 'dir', dir, depth, open })
    if (open) flattenTree(dir, closed, depth + 1, out)
  }
  for (const file of root.files) out.push({ kind: 'file', file, depth })
  return out
}

/** Every item below a folder, in display order. */
export function itemsOf<T>(dir: TreeDir<T>, out: T[] = []): T[] {
  for (const child of dir.dirs) itemsOf(child, out)
  for (const file of dir.files) out.push(file.item)
  return out
}

/** Items in tree display order (folders first), ignoring collapse: the prev/next order of the diff panel. */
export function treeOrder<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
  return itemsOf(buildTree(items, pathOf))
}

const KEY = 'dsh-agent-hub.git.tree'

/** The reader's list/tree choice, shared by every pane; tree until they pick list. */
export const treeMode = {
  get(): boolean {
    try {
      return localStorage.getItem(KEY) !== '0'
    } catch {
      return true
    }
  },
  set(value: boolean): void {
    try {
      localStorage.setItem(KEY, value ? '1' : '0')
    } catch {
      // Private mode: the choice just doesn't persist.
    }
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

const listeners = new Set<() => void>()
