/**
 * DSH's registered models for the commit-message picker, read from the host
 * when the settings page opens (sign-ins and new providers change it, so it is
 * not cached across visits).
 */

import type { ModelGroup } from '../../models.ts'

export interface DirectoryState {
  groups: ModelGroup[] | null
  loading: boolean
  error: string | null
}

export class ModelDirectory {
  private state: DirectoryState = { groups: null, loading: false, error: null }
  private listeners = new Set<() => void>()
  private generation = 0
  private fetchGroups: () => Promise<ModelGroup[]>

  constructor(fetchGroups: () => Promise<ModelGroup[]>) {
    this.fetchGroups = fetchGroups
  }

  getSnapshot = (): DirectoryState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.state, loading: true, error: null })
    try {
      const groups = await this.fetchGroups()
      if (generation === this.generation) this.set({ groups, loading: false, error: null })
    } catch (error) {
      // Keep the last list on a failed refresh.
      if (generation === this.generation) this.set({ ...this.state, loading: false, error: (error as Error).message })
    }
  }

  private set(state: DirectoryState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
