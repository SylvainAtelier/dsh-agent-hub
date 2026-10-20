import { english } from '../locale.ts'
import { runEnded, type ReviewRun, type SyncRun } from './types.ts'

export interface ScheduledReport {
  title: string
  summary: string
}

/** Render facts, not model guesses: queued work is never called completed. */
export function scheduledReport(sync: SyncRun, runs: readonly ReviewRun[], endedAt: number): ScheduledReport {
  const completed = runs.filter((run) => run.step === 'done').length
  const failed = runs.filter((run) => run.step === 'failed' || run.step === 'cancelled').length
  const pending = runs.filter((run) => !runEnded(run.step)).length
  const seconds = Math.max(0, Math.round((endedAt - sync.startedAt) / 1000))
  if (english()) {
    const state = sync.step === 'failed' ? 'Sync failed' : pending > 0 ? 'Analysis running' : failed > 0 ? completed > 0 ? 'Partly failed' : 'Analysis failed' : runs.length === 0 ? 'No new PRs to analyze' : 'Done'
    const result = sync.step === 'failed' ? 'Last sync failed' : pending > 0 ? `Last run: ${completed} analyzed, ${pending} running` : failed > 0 ? `Last run: ${completed} analyzed, ${failed} failed` : runs.length === 0 ? 'Last run: no new PRs to analyze' : `Last run: ${completed} analyzed`
    const lines = [
      `## Board review · ${state}`,
      '',
      `Started: ${new Date(sync.startedAt).toISOString()} · took ${seconds}s`,
      '',
      `Found ${sync.found ?? 0} PRs waiting for my review, queued ${runs.length} this run; ${completed} analyzed, ${failed} failed or cancelled, ${pending} still analyzing.`,
    ]
    if (sync.error !== undefined) lines.push('', `The sync did not finish: ${plain(sync.error)}. Check the GitHub sign-in, the network and repository access, then sync again from the board.`)
    if (runs.length === 0 && sync.step !== 'failed') lines.push('', 'Nothing new to analyze this run; existing tasks, drafts and PRs with no update are not analyzed again.')
    if (runs.length > 0) {
      lines.push('', '### This run')
      for (const run of runs) {
        const outcome = run.step === 'done' ? 'review sheet written' : run.step === 'failed' ? `failed: ${plain(run.error ?? 'analysis did not finish')}` : run.step === 'cancelled' ? 'cancelled' : 'still analyzing (progress on the board)'
        lines.push(`- ${plain(run.key)}: ${outcome}`)
      }
    }
    if (failed > 0) lines.push('', 'Failed items can be retried from the board.')
    if (pending > 0) lines.push('', 'This is a snapshot taken when the wait limit was reached or the wait was stopped, not a sign that every review is done; see the board for later results.')
    return { title: `Board review · ${result}`, summary: lines.join('\n') }
  }
  const state = sync.step === 'failed' ? '同步失败' : pending > 0 ? '分析进行中' : failed > 0 ? completed > 0 ? '部分失败' : '分析失败' : runs.length === 0 ? '无新增待分析 PR' : '已完成'
  const result = sync.step === 'failed' ? '上次同步失败' : pending > 0 ? `上次 ${completed} 个已分析，${pending} 个进行中` : failed > 0 ? `上次 ${completed} 个已分析，${failed} 个失败` : runs.length === 0 ? '上次无新增待分析 PR' : `上次 ${completed} 个已分析`
  const lines = [
    `## 看板审核 · ${state}`,
    '',
    `开始：${new Date(sync.startedAt).toISOString()} · 耗时 ${seconds} 秒`,
    '',
    `发现 ${sync.found ?? 0} 个待我审 PR，本次排队 ${runs.length} 个；已分析 ${completed} 个，失败或取消 ${failed} 个，仍在分析 ${pending} 个。`,
  ]
  if (sync.error !== undefined) lines.push('', `同步未完整完成：${plain(sync.error)}。请检查 GitHub 登录、网络及仓库权限，在看板中手动同步重试。`)
  if (runs.length === 0 && sync.step !== 'failed') lines.push('', '本次没有新增待分析项；已有任务、草稿和无需更新的 PR 不会重复分析。')
  if (runs.length > 0) {
    lines.push('', '### 本次分析')
    for (const run of runs) {
      const outcome = run.step === 'done' ? '已生成审核单' : run.step === 'failed' ? `失败：${plain(run.error ?? '分析未完成')}` : run.step === 'cancelled' ? '已取消' : '仍在分析（可在看板查看进度）'
      lines.push(`- ${plain(run.key)}：${outcome}`)
    }
  }
  if (failed > 0) lines.push('', '失败项可在看板中重试。')
  if (pending > 0) lines.push('', '这是等待上限到达或本轮等待被停止时的快照，不代表全部审核已完成；后续结果请在看板查看。')
  return { title: `看板审核 · ${result}`, summary: lines.join('\n') }
}

/** Repository names and errors are data, never Markdown instructions. */
function plain(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').slice(0, 1000)
}
