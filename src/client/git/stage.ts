/**
 * The diff stage: one file's changes shown over the middle (agent) column, the
 * way Git Graph opens a diff in the editor area. Panes publish what to show;
 * the stage host, mounted in DSH's shell overlay layer, renders it. The source
 * control pane itself never resizes or navigates for a diff.
 */

import type { DiffTarget } from './context.ts'
import type { RepoStore } from './store.ts'

export interface StageState {
  repo: RepoStore
  target: DiffTarget
  /** Prev/next order, as the list that opened it shows its files. */
  siblings?: DiffTarget[]
  /** One line of context: the commit (`abc1234 · subject`) or the change list. */
  context?: string
  openFile?: (absolutePath: string) => void
  insert?: (text: string) => boolean
  backToSession?: () => void
}

let state: StageState | undefined
let hosts = 0
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of listeners) listener() }

export const stage = {
  get: (): StageState | undefined => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** Whether a host is mounted; without one, panes fall back to their own diff panel. */
  available: (): boolean => hosts > 0,
  show(next: StageState): void {
    state = next
    emit()
  },
  /** Close; `repo` limits it to that repository's diff (a pane unmounting). */
  close(repo?: RepoStore): void {
    if (state === undefined || (repo !== undefined && state.repo !== repo)) return
    state = undefined
    emit()
  },
  mountHost(): () => void {
    hosts++
    emit()
    return () => {
      hosts--
      if (hosts === 0) state = undefined
      emit()
    }
  },
}
