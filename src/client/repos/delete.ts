/**
 * DSH's 删除工作区 dialog, told what deleting a worktree's workspace now does: the host
 * removes its folder too (see `GitService.dropWorktree`), while its sessions still move to
 * 未分组. DSH's own description says the folder is kept, so for a linked worktree it is
 * rewritten in place; any other workspace keeps DSH's words, which stay true for it.
 */

import type { ReposStore } from './api.ts'

const ZH = /^将把“(.+)”从工作区列表中移除。文件夹与会话记录会保留/
const EN = /^This removes “(.+)” from the workspace list\. The folder and session logs will be kept/

const zh = (name: string): string =>
  `将把“${name}”从工作区列表中移除，并删除它的 worktree 文件夹（未提交的改动会丢失，分支保留）。会话记录会保留，显示在“未分组”下。`
const en = (name: string): string =>
  `This removes “${name}” from the workspace list and deletes its worktree folder (uncommitted changes are lost; the branch is kept). Its session logs are kept and appear under Ungrouped.`

/** Rewrite the description of an open delete dialog whose workspace is a linked worktree. */
export function rewriteDeleteNotice(root: ParentNode, isWorktree: (title: string) => boolean): void {
  const scope = root.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')
  for (const dialog of scope.length > 0 ? scope : [root]) {
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.nodeValue ?? ''
      const match = ZH.exec(text) ?? EN.exec(text)
      if (match === null || !isWorktree(match[1]!)) continue
      node.nodeValue = (match[0].startsWith('将') ? zh : en)(match[1]!)
    }
  }
}

export function noticeWorktreeDelete(store: ReposStore): () => void {
  /** A title names a worktree when every registered workspace by that title is one. */
  const isWorktree = (title: string): boolean => {
    const members = (store.getSnapshot().repos ?? []).flatMap((group) => group.members).filter((member) => member.title === title)
    return members.length > 0 && members.every((member) => !member.main)
  }
  let frame = 0
  const apply = (): void => {
    frame = 0
    rewriteDeleteNotice(document.body, isWorktree)
  }
  // Dialogs come and go in portals anywhere under body; one check per frame at most.
  const observer = new MutationObserver(() => {
    if (frame === 0) frame = requestAnimationFrame(apply)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  }
}
