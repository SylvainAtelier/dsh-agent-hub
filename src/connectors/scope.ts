/**
 * Which connectors a session may use. A connector linked to repositories
 * (`ConnectorEntry.repos`) serves only sessions working in one of them — its
 * main working tree or any of its worktrees — and is hidden from every other
 * model session: DSH models never see its tools in their prompt (index.ts,
 * `system-prompt/assemble`) and a call to one is refused (`tools.guard`), and
 * Claude Agent is not bridged its server. A connector linked to none serves
 * every session. Where the session's folder is unknown, a linked connector is
 * hidden: it stays closed rather than leaking into the wrong repository.
 */

import { pathKey, within } from '../git/service.ts'
import { CONNECTOR_ID, type ConnectorEntry } from './types.ts'

/** The repository lookups the scope reads (repos/index.ts). */
export interface RepoLookup {
  /** The main working tree of the repository a folder is in. */
  repoOf(dir: string): Promise<string | undefined>
  /** The same as far as is known now, without waiting; undefined while git has not answered. */
  known(dir: string): { repo: string | undefined } | undefined
}

const NONE: ReadonlySet<string> = new Set()
const TOOL = /^mcp__([a-z][a-z0-9-]{0,31})__./

/** The connector id a tool name belongs to (`mcp__<id>__<tool>`), if it has that shape. */
export function connectorOfTool(name: string): string | undefined {
  return name.startsWith('mcp__') ? TOOL.exec(name)?.[1] : undefined
}

/**
 * Whether a connector serves a session working in `cwd`, a folder of repository `repo` (its main
 * working tree; undefined when git knows none). Without a repository, a folder under a linked path
 * still counts, so a failed git lookup does not hide a connector from its own repository.
 */
export function serves(entry: Pick<ConnectorEntry, 'repos'>, cwd: string | undefined, repo: string | undefined): boolean {
  const repos = entry.repos ?? []
  if (repos.length === 0) return true
  if (cwd === undefined || cwd === '') return false
  if (repo !== undefined) {
    const key = pathKey(repo)
    return repos.some((path) => pathKey(path) === key)
  }
  return repos.some((path) => within(path, cwd))
}

export class ConnectorScope {
  private readonly entries: () => readonly ConnectorEntry[]
  private readonly repos: RepoLookup

  constructor(entries: () => readonly ConnectorEntry[], repos: RepoLookup) {
    this.entries = entries
    this.repos = repos
  }

  /** The connectors linked to some repository: only these are ever hidden. */
  private linked(): ConnectorEntry[] {
    return this.entries().filter((entry) => (entry.repos?.length ?? 0) > 0 && CONNECTOR_ID.test(entry.id))
  }

  /** The connectors hidden from a session working in `cwd`. Asks git only when a connector is linked (cached per folder). */
  async hidden(cwd: string | undefined): Promise<ReadonlySet<string>> {
    if (this.linked().length === 0) return NONE
    const repo = cwd === undefined || cwd === '' ? undefined : await this.repos.repoOf(cwd).catch(() => undefined)
    // Read the configuration again: it may have changed while git answered.
    return hiddenFrom(this.linked(), cwd, repo)
  }

  /**
   * The same, synchronously, for checks that cannot wait (a tool guard). A folder git has not
   * answered for yet hides every linked connector; the lookup it starts answers the next check.
   */
  hiddenNow(cwd: string | undefined): ReadonlySet<string> {
    const linked = this.linked()
    if (linked.length === 0) return NONE
    const known = cwd === undefined || cwd === '' ? undefined : this.repos.known(cwd)
    if (known === undefined) return new Set(linked.map((entry) => entry.id))
    return hiddenFrom(linked, cwd, known.repo)
  }
}

function hiddenFrom(linked: readonly ConnectorEntry[], cwd: string | undefined, repo: string | undefined): ReadonlySet<string> {
  const hidden = linked.filter((entry) => !serves(entry, cwd, repo)).map((entry) => entry.id)
  return hidden.length === 0 ? NONE : new Set(hidden)
}

/** The assembly's tools without those of hidden connectors; the same object when none is hidden. */
export function withoutHidden<T extends { tools: ReadonlyArray<{ name: string }> }>(assembly: T, hidden: ReadonlySet<string>): T {
  if (hidden.size === 0) return assembly
  const tools = assembly.tools.filter((tool) => {
    const id = connectorOfTool(tool.name)
    return id === undefined || !hidden.has(id)
  })
  return tools.length === assembly.tools.length ? assembly : { ...assembly, tools }
}
