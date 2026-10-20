/** The composer's glasses bell; copy follows the host document language. */
const zh = {
  label: '完成后通知眼镜',
  on: '这一轮结束后通知眼镜 · 再点一次取消',
  offline: '眼镜那边暂时没有可用的会话（工作区未在线，或这台电脑上还没有过眼镜会话）：通知会先保留，等能送达时补发',
  armed: '已开启：这一轮结束时通知眼镜',
  armedOffline: '已开启：眼镜那边暂时没有可用的会话，能送达时补发',
  opener: '用眼镜派一个任务，或在网页新建一个',
  disarmed: '已取消通知',
  failed: '没能设置通知，请重试',
} as const
const en: Record<keyof typeof zh, string> = {
  label: 'Notify the glasses when done',
  on: 'The glasses are told when this turn ends · click again to cancel',
  offline: 'No glasses session to reach right now (no workspace online, or none on this computer yet): notifications wait until one can take them',
  armed: 'On: the glasses are told when this turn ends',
  armedOffline: 'On: no glasses session to reach right now; it goes once one can take it',
  opener: 'Send a task from the glasses, or open one on the web',
  disarmed: 'Notification cancelled',
  failed: 'Could not set the notification; try again',
}
export function t(key: keyof typeof zh): string {
  return (document.documentElement.lang.toLowerCase().startsWith('en') ? en : zh)[key]
}
