/** The window's words, Chinese and English. */

export const MESSAGES = {
  zh: {
    tabClip: '剪贴板', tabTranslate: '翻译', search: '搜索剪贴板…', source: '原文', sourcePlaceholder: '输入或粘贴要翻译的文字',
    pinned: '置顶', recent: '最近', pin: '置顶', unpin: '取消置顶', delete: '删除', deleted: '已删除', undo: '撤销',
    now: '刚刚', minutes: '{n} 分钟前', hours: '{n} 小时前', chars: '{n} 字',
    emptyAll: '复制的文字和图片会出现在这里',
    image: '图片', imageTitle: '图片 {w}×{h}', left: '{t}后清除', leftHours: '{n} 小时', leftMinutes: '{n} 分钟',
    noPinImage: '图片不能置顶，{n} 小时内未再使用会自动清除', hintPaste: '粘贴', hintLook: '大图',
    edit: '编辑', editing: '编辑 · {meta}', save: '保存', cancel: '取消', hintEdit: '编辑', hintSave: '保存', loading: '正在读取全文…',
    noEditImage: '图片不能编辑', editEmpty: '内容不能为空', editLong: '超过 64 KB，无法保存', editDiscarded: '已放弃修改', editKept: '有未保存的修改', editResume: '继续编辑', editFailed: '保存失败：{error}', noTranslateImage: '图片不能翻译', emptyFound: '没有匹配的记录',
    emptyPins: '常用的内容按 {mod} P 置顶，之后 {mod} 1–9 直接输入', emptyPinsFound: '置顶里没有匹配',
    added: '新复制：{text}',
    target: '输入到：{app}', noTarget: '没有可输入的窗口', close: '关闭',
    hintType: '输入', hintCopy: '复制', hintPin: '置顶', hintDelete: '删除', hintQuick: '输入置顶项', hintColumn: '切换栏',
    hintTranslate: '翻译 / 输入', hintTranslateType: '翻译并输入', hintLang: '语言', hintLangNext: '下一种语言',
    lang_en: 'EN', lang_zh: '中', lang_fr: 'FR', name_en: 'English', name_zh: '中文', name_fr: 'Français',
    bot: '翻译用的 bot', defaultBot: '默认模型', translate: '翻译', translating: '翻译中…', typeInto: '输入到 {app}', copy: '复制',
    trHint: '译文显示在这里。默认译成英文；原文已是目标语言时改得更地道。', failed: '翻译失败', openPerm: '打开系统设置',
    history: '历史', searchHistory: '搜索翻译历史…', emptyHistory: '翻译过的内容会出现在这里', emptyHistoryFound: '没有匹配的翻译',
  },
  en: {
    tabClip: 'Clipboard', tabTranslate: 'Translate', search: 'Search the clipboard…', source: 'Source text', sourcePlaceholder: 'Type or paste text to translate',
    pinned: 'Pinned', recent: 'Recent', pin: 'Pin', unpin: 'Unpin', delete: 'Delete', deleted: 'Deleted', undo: 'Undo',
    now: 'just now', minutes: '{n} min ago', hours: '{n} h ago', chars: '{n} chars',
    emptyAll: 'Text and images you copy appear here',
    image: 'Image', imageTitle: 'Image {w}×{h}', left: 'cleared in {t}', leftHours: '{n} h', leftMinutes: '{n} min',
    noPinImage: 'Images cannot be pinned; one unused for {n} hours is cleared', hintPaste: 'Paste', hintLook: 'Large view',
    edit: 'Edit', editing: 'Editing · {meta}', save: 'Save', cancel: 'Cancel', hintEdit: 'Edit', hintSave: 'Save', loading: 'Reading the whole text…',
    noEditImage: 'Images cannot be edited', editEmpty: 'The text cannot be empty', editLong: 'Over 64 KB: cannot be saved', editDiscarded: 'Changes discarded', editKept: 'You have unsaved changes', editResume: 'Keep editing', editFailed: 'Not saved: {error}', noTranslateImage: 'Images cannot be translated', emptyFound: 'Nothing matches',
    emptyPins: 'Pin what you use often with {mod} P, then type it with {mod} 1–9', emptyPinsFound: 'No pinned entry matches',
    added: 'New copy: {text}',
    target: 'Types into: {app}', noTarget: 'No window to type into', close: 'Close',
    hintType: 'Type', hintCopy: 'Copy', hintPin: 'Pin', hintDelete: 'Delete', hintQuick: 'Type a pinned entry', hintColumn: 'Switch column',
    hintTranslate: 'Translate / type', hintTranslateType: 'Translate & type', hintLang: 'Language', hintLangNext: 'Next language',
    lang_en: 'EN', lang_zh: '中', lang_fr: 'FR', name_en: 'English', name_zh: '中文', name_fr: 'Français',
    bot: 'Bot used to translate', defaultBot: 'Default model', translate: 'Translate', translating: 'Translating…', typeInto: 'Type into {app}', copy: 'Copy',
    trHint: 'The translation appears here. English by default; text already in the target language is polished.', failed: 'Translation failed', openPerm: 'Open System Settings',
    history: 'History', searchHistory: 'Search translations…', emptyHistory: 'Translations you make appear here', emptyHistoryFound: 'No translation matches',
  },
} as const

export type Key = keyof (typeof MESSAGES)['zh']
