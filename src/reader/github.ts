/**
 * GitHub through the signed-in `gh` (as reviews read it): one GraphQL request lists a page of an
 * account's stars (100, newest first) with each repository's newest release, and older pages follow
 * its cursor; a repository's README and a release's notes are read when opened; a repository a session
 * works in is a shallow clone kept under the reader's folder.
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { exec, type Exec } from '../exec.ts'

const ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '', GIT_TERMINAL_PROMPT: '0' }
/** owner/name as GitHub allows them. */
export const REPO_NAME = /^[\w.-]+\/[\w.-]+$/

export interface Star {
  name: string
  url: string
  description?: string
  stars: number
  language?: string
  starredAt: number
  release?: { tag: string; title: string; url: string; publishedAt: number }
}

const STARS = `query($login: String!, $after: String) {
  user(login: $login) { login starredRepositories(first: 100, after: $after, orderBy: { field: STARRED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } edges { starredAt node {
    nameWithOwner url description stargazerCount primaryLanguage { name } latestRelease { tagName name url publishedAt }
  } } } }
}`

interface StarsReply {
  data?: { user?: { login: string; starredRepositories: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ starredAt: string; node: {
    nameWithOwner: string; url: string; description: string | null; stargazerCount: number
    primaryLanguage: { name: string } | null; latestRelease: { tagName: string; name: string | null; url: string; publishedAt: string } | null
  } }> } } | null }
  errors?: Array<{ message: string }>
}

export class GitHubSource {
  private readonly run: Exec

  constructor(run: Exec = exec) {
    this.run = run
  }

  private async gh(args: readonly string[], timeoutMs = 60_000): Promise<string> {
    const result = await this.run('gh', args, { cwd: homedir(), env: ENV, timeoutMs, maxBytes: 16 << 20 })
    if (result.missing) throw new Error('GitHub CLI (gh) is not installed: install it and run `gh auth login`')
    if (result.timedOut) throw new Error('GitHub did not answer in time')
    if (result.code !== 0) {
      const text = (result.stderr || result.stdout).trim()
      if (/gh auth login|not logged in|authentication|HTTP 401/i.test(text)) throw new Error('GitHub CLI is not signed in: run `gh auth login`')
      throw new Error(text.split('\n').slice(0, 2).join(' ') || `gh exited with ${result.code}`)
    }
    return result.stdout
  }

  /** The signed-in account. */
  async viewer(): Promise<string> {
    return (await this.gh(['api', 'user', '--jq', '.login'])).trim()
  }

  /** A page of an account's stars, newest first; `next` is the cursor of the page after it, when there is one. */
  async stars(login: string, after?: string): Promise<{ stars: Star[]; next?: string }> {
    const reply = JSON.parse(await this.gh(['api', 'graphql', '-f', `query=${STARS}`, '-f', `login=${login}`, ...(after === undefined ? [] : ['-f', `after=${after}`])])) as StarsReply
    const user = reply.data?.user
    if (user === undefined || user === null) throw new Error(reply.errors?.[0]?.message ?? `GitHub has no account "${login}"`)
    const { pageInfo } = user.starredRepositories
    const stars = user.starredRepositories.edges.map(({ starredAt, node }): Star => ({
      name: node.nameWithOwner,
      url: node.url,
      ...(node.description ? { description: node.description } : {}),
      stars: node.stargazerCount,
      ...(node.primaryLanguage ? { language: node.primaryLanguage.name } : {}),
      starredAt: Date.parse(starredAt) || 0,
      ...(node.latestRelease ? {
        release: { tag: node.latestRelease.tagName, title: node.latestRelease.name || node.latestRelease.tagName, url: node.latestRelease.url, publishedAt: Date.parse(node.latestRelease.publishedAt) || 0 },
      } : {}),
    }))
    return { stars, ...(pageInfo.hasNextPage && pageInfo.endCursor ? { next: pageInfo.endCursor } : {}) }
  }

  async readme(name: string): Promise<string> {
    if (!REPO_NAME.test(name)) throw new Error('Not a repository name')
    try {
      return await this.gh(['api', `repos/${name}/readme`, '-H', 'Accept: application/vnd.github.raw'])
    } catch (error) {
      if (/404|Not Found/i.test((error as Error).message)) return ''
      throw error
    }
  }

  async release(name: string, tag: string): Promise<string> {
    if (!REPO_NAME.test(name)) throw new Error('Not a repository name')
    return (await this.gh(['api', `repos/${name}/releases/tags/${encodeURIComponent(tag)}`, '--jq', '.body // ""'])).trim()
  }

  /** A shallow clone of the repository's default branch at `dir`, brought to its latest commit. */
  async clone(name: string, dir: string): Promise<void> {
    if (!REPO_NAME.test(name)) throw new Error('Not a repository name')
    const git = async (args: readonly string[], cwd: string): Promise<void> => {
      const result = await this.run('git', args, { cwd, env: ENV, timeoutMs: 300_000, maxBytes: 1 << 20 })
      if (result.missing) throw new Error('git is not installed')
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ') || `git ${args[0]} failed`)
    }
    if (existsSync(`${dir}/.git`)) {
      await git(['fetch', '-q', '--depth', '1', 'origin', 'HEAD'], dir)
      await git(['reset', '-q', '--hard', 'FETCH_HEAD'], dir)
      return
    }
    await mkdir(dirname(dir), { recursive: true })
    await git(['clone', '-q', '--depth', '1', '--single-branch', `https://github.com/${name}.git`, dir], dirname(dir))
  }
}
