/**
 * Which repository each registered workspace belongs to. Git answers once per
 * folder (`--git-common-dir`: every worktree of a repository shares it); the
 * branch is read from the worktree's own HEAD file on every listing, which
 * costs no git process.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathKey, runGit, type Runner, type Workspaces } from '../git/service.ts'
import type { RepoGroup, RepoMember, ReposRequest } from './types.ts'

interface Where {
  /** The main working tree. */
  main: string
  /** This tree's own git dir (its HEAD lives there). */
  gitDir: string
}

/** A folder that is not in a repository is asked again after this long (it may have been `git init`ed). */
const MISS_TTL_MS = 60_000
/** A repository's layout rarely changes; still re-read now and then (a folder moved, a repo re-cloned). */
const HIT_TTL_MS = 10 * 60_000

/** The registry slice the index reads. */
export type RepoWorkspaces = Pick<Workspaces, 'list'>

export class RepoIndex {
  private readonly run: Runner
  private readonly workspaces: () => RepoWorkspaces | undefined
  /** `settled`: the last answer for the folder, kept while a fresh lookup runs. */
  private readonly found = new Map<string, { at: number; ttl: number; where: Promise<Where | undefined>; settled?: { where: Where | undefined } }>()

  constructor(workspaces: () => RepoWorkspaces | undefined, run: Runner = runGit) {
    this.workspaces = workspaces
    this.run = run
  }

  /** The repository a folder is in, cached; undefined outside git. */
  where(dir: string): Promise<Where | undefined> {
    const hit = this.found.get(pathKey(dir))
    if (hit !== undefined && Date.now() - hit.at < hit.ttl) return hit.where
    return this.lookup(dir)
  }

  private lookup(dir: string): Promise<Where | undefined> {
    const where = this.run(['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir'], dir, { read: true, timeoutMs: 15_000 })
      .then((result) => {
        if (result.code !== 0) return undefined
        const [common, gitDir] = result.stdout.trim().split(/\r?\n/)
        if (!common || !gitDir) return undefined
        const shared = resolve(common)
        // A bare repository's worktrees share the bare folder itself.
        return { main: basename(shared).toLowerCase() === '.git' ? dirname(shared) : shared, gitDir: resolve(gitDir) }
      }, () => undefined)
    const key = pathKey(dir)
    const settled = this.found.get(key)?.settled
    const entry: { at: number; ttl: number; where: Promise<Where | undefined>; settled?: { where: Where | undefined } } = { at: Date.now(), ttl: MISS_TTL_MS, where, ...(settled === undefined ? {} : { settled }) }
    this.found.set(key, entry)
    void where.then((found) => {
      entry.settled = { where: found }
      if (found !== undefined) entry.ttl = HIT_TTL_MS
    })
    return where
  }

  /**
   * The repository a folder is in as far as is known now, without waiting: the last answer (a
   * stale one is asked again in the background), or undefined while git has not answered yet.
   */
  known(dir: string): { repo: string | undefined } | undefined {
    const key = pathKey(dir)
    const hit = this.found.get(key)
    if (hit === undefined || Date.now() - hit.at >= hit.ttl) void this.lookup(dir)
    const settled = this.found.get(key)?.settled
    return settled === undefined ? undefined : { repo: settled.where?.main }
  }

  /** The main working tree of the repository a folder is in. */
  async repoOf(dir: string): Promise<string | undefined> {
    return (await this.where(dir))?.main
  }

  /** Every registered workspace that is in a git repository, grouped by repository. */
  async list(): Promise<RepoGroup[]> {
    const registered = this.workspaces()?.list() ?? []
    const groups = new Map<string, RepoGroup>()
    await Promise.all(registered.map(async (workspace) => {
      const where = await this.where(workspace.path)
      if (where === undefined) return
      const branch = await readFile(join(where.gitDir, 'HEAD'), 'utf8')
        .then((text) => /^ref:\s*refs\/heads\/(.+)$/m.exec(text.trim())?.[1], () => undefined)
      const member: RepoMember = {
        workspaceId: workspace.id,
        path: workspace.path,
        title: workspace.title,
        ...(branch === undefined ? {} : { branch }),
        main: pathKey(workspace.path) === pathKey(where.main),
      }
      const key = pathKey(where.main)
      let group = groups.get(key)
      if (group === undefined) {
        group = { key: where.main, name: basename(where.main), members: [] }
        groups.set(key, group)
      }
      group.members.push(member)
    }))
    const order = registered.map((workspace) => workspace.id)
    const at = (member: RepoMember): number => order.indexOf(member.workspaceId)
    const out = [...groups.values()]
    for (const group of out) group.members.sort((a, b) => Number(b.main) - Number(a.main) || at(a) - at(b))
    // Repositories in the order their first workspace appears.
    const first = (group: RepoGroup): number => Math.min(...group.members.map(at))
    return out.sort((a, b) => first(a) - first(b))
  }

  handle(_request: ReposRequest): Promise<unknown> {
    return this.list()
  }
}
