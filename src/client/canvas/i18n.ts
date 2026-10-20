/** Canvas panel copy. English when the page language is English, Chinese otherwise. */

import { isEnglish } from '../board/i18n.ts'

export const zh = {
  panel: '画布',
  title: '画布',
  refresh: '刷新',
  copyPath: '复制路径',
  copied: '已复制',
  remove: '删除',
  confirmRemove: '确认删除',
  cancel: '取消',
  showList: '显示画布列表',
  hideList: '收起画布列表',
  backToCanvas: '返回画布',
  source: '来源会话',
  openSource: '打开生成此画布的会话',
  openSourceTitled: '打开生成此画布的会话：{title}',
  focus: '全屏查看',
  exitFocus: '退出全屏',
  empty: '还没有画布。让模型把图表、表格或仪表盘做成画布，它们会出现在这里。',
  folder: '文件夹：{dir}',
  pick: '选择左侧的画布查看',
  loading: '正在读取…',
  failed: '读取失败：{message}',
  references: '会话引用快照',
  referencesHint: '@ 引用的会话太大、无法直接交给 Claude Code 或 Cursor 时，快照保存在这里，由它们按需读取',
  referenceFolder: '快照文件夹：{dir}',
}

export type CanvasKey = keyof typeof zh

export const en: Record<CanvasKey, string> = {
  panel: 'Canvases',
  title: 'Canvases',
  refresh: 'Refresh',
  copyPath: 'Copy path',
  copied: 'Copied',
  remove: 'Delete',
  confirmRemove: 'Confirm delete',
  cancel: 'Cancel',
  showList: 'Show canvas list',
  hideList: 'Hide canvas list',
  backToCanvas: 'Back to canvas',
  source: 'Session',
  openSource: 'Open the session that made this canvas',
  openSourceTitled: 'Open the session that made this canvas: {title}',
  focus: 'Full screen',
  exitFocus: 'Exit full screen',
  empty: 'No canvases yet. Ask a model to turn a chart, table or dashboard into a canvas and it will show up here.',
  folder: 'Folder: {dir}',
  pick: 'Pick a canvas on the left',
  loading: 'Reading…',
  failed: 'Could not read: {message}',
  references: 'Session snapshots',
  referencesHint: 'An @-referenced session too large to hand Claude Code or Cursor inline is saved here, and they read it when needed',
  referenceFolder: 'Snapshots folder: {dir}',
}

export function t(key: CanvasKey, params?: Record<string, string | number>): string {
  let text = (isEnglish() ? en : zh)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}
