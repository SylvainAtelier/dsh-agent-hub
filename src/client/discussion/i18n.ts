/** Compact copy follows the host document language without introducing another locale service. */
const zh = {
  ask: '问一下', title: '临时讨论', close: '收起讨论', quote: '所选文字', context: '仅使用所选文字和本次讨论，不读取整个主会话。',
  question: '你的问题', placeholder: '就这段文字问一个问题…', followup: '继续追问…', send: '发送', stop: '停止',
  stage: '暂存到主会话', update: '更新暂存', staged: '已暂存', attached: '已添加到输入框，随下一条主消息提交',
  add: '添加到主输入框', sent: '已提交', pending: '待提交', history: '讨论历史', empty: '输入问题后才会请求模型。',
  retry: '重试', reconnect: '重新连接', disconnected: '实时连接已断开，回答仍可能在后台继续。', loading: '正在读取讨论…',
  chars: '{n} 字', unavailable: '当前输入框暂时无法接收引用。快照已保存，请稍后点击“添加到主输入框”。',
  busy: '正在回答…', failed: '操作失败', start: '新讨论', stopped: '回答未完成；再次发送会重试最后一轮。',
  remaining: '暂存仅包含你确认时的已完成轮次，后续追问需再次确认。', settings: '模型设置',
  privacy: '点发送会将所选文字发送给上方模型。', count: '轮',
  scope: '上下文', scopeSelection: '选区', scopeSection: '本节', scopeArticle: '全文',
  docContext: '发送给模型的内容：{what}，约 {n} 字。', whatSelection: '所选文字', whatSection: '所选文字和它所在的小节', whatArticle: '整篇文章',
  analyze: '分析全文', articlePlaceholder: '就整篇文章提问，比如“概括要点并指出薄弱之处”…', answerBy: '回答者', defaultModel: '默认模型',
  keepAnswer: '收藏回答', kept: '已收藏', keepQuote: '收藏', continueSession: '在会话中继续', opening: '正在打开会话…',
  docPrivacy: '点发送会把上面所示内容发送给所选模型。',
} as const
const en: Record<keyof typeof zh, string> = {
  ask: 'Ask about this', title: 'Temporary discussion', close: 'Collapse discussion', quote: 'Selected text', context: 'Uses only the selection and this discussion, not the whole session.',
  question: 'Your question', placeholder: 'Ask about this selection…', followup: 'Ask a follow-up…', send: 'Send', stop: 'Stop',
  stage: 'Stage for main session', update: 'Update staged snapshot', staged: 'Staged', attached: 'Added to composer; sent with your next main message',
  add: 'Add to main composer', sent: 'Submitted', pending: 'Pending', history: 'Discussion history', empty: 'The model is called only after you send a question.',
  retry: 'Retry', reconnect: 'Reconnect', disconnected: 'Live connection lost. The answer may still be running on the host.', loading: 'Loading discussion…',
  chars: '{n} chars', unavailable: 'The composer cannot accept a reference right now. Your snapshot is saved; use “Add to main composer” later.',
  busy: 'Answering…', failed: 'Operation failed', start: 'New discussion', stopped: 'Incomplete answer; sending again retries the last round.',
  remaining: 'Staging includes completed rounds you confirmed, not later follow-ups.', settings: 'Model settings',
  privacy: 'Sending shares the selection with the model shown above.', count: 'rounds',
  scope: 'Context', scopeSelection: 'Selection', scopeSection: 'Section', scopeArticle: 'Article',
  docContext: 'The model gets {what}, about {n} chars.', whatSelection: 'the selected text', whatSection: 'the selection and its section', whatArticle: 'the whole article',
  analyze: 'Analyze article', articlePlaceholder: 'Ask about the whole article, e.g. “Sum up the key points and where it is weak”…', answerBy: 'Answered by', defaultModel: 'Default model',
  keepAnswer: 'Keep answer', kept: 'Kept', keepQuote: 'Keep', continueSession: 'Continue in a session', opening: 'Opening a session…',
  docPrivacy: 'Sending shares the content shown above with the chosen model.',
}
export const t = (key: keyof typeof zh): string => (typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('en') ? en : zh)[key]
