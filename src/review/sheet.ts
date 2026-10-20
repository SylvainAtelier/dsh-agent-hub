/**
 * The review sheet's file format: a small, line-based Markdown an agent writes reliably and a
 * person can still edit by hand. Front matter holds the fields; fixed sections hold the overview,
 * the findings, the rules and the notes:
 *
 *   ---
 *   pr: owner/repo#123
 *   head: 3f9c2ab
 *   status: ready
 *   decision: request-changes
 *   summary: Nice work on the retry flow, a couple of things first.
 *   ---
 *   ## Must fix
 *   - [x] F1 `src/webhook.ts:88` 重试没有幂等键…
 *     > EN: Retry logic looks good. One thing though, …
 *
 * A response sheet (`role: author`, my own pull request) has `## Fix` and `## Reply` for the two
 * finding sections, items `C1, C2, …`, and under each the thread it answers: `thread: PRRT_… @alice`.
 *
 * Comments I wrote on the diff myself are `## Mine`, items `M1, M2, …`, written only once there is one.
 *
 * `context: owner/repo#12 owner/repo#14` names the pull requests of its stack the analysis reads beside it.
 *
 * A submitted review keeps `read: <ISO time>` and `seen: <sha>` once I caught up with what followed it.
 *
 * Reading is lenient (Chinese headings, `F1:` or `**F1**`, `path#L88`); writing is canonical, and
 * sections the format does not know are kept as they were.
 */

import { DECISIONS, isMine, VERDICTS, type Decision, type Finding, type Severity, type Sheet, type SheetOp, type SheetStatus } from './types.ts'

const PR = /^[\w.-]+\/[\w.-]+#\d+$/
const STATUSES: readonly SheetStatus[] = ['analyzing', 'ready', 'fixing', 'fixed', 'submitted']

type Part = 'overview' | 'must' | 'nice' | 'mine' | 'rules' | 'notes'

/** A response sheet's sections are Fix and Reply: read as must and nice. */
const HEADINGS: ReadonlyArray<[Part, RegExp]> = [
  ['overview', /^(overview|变更说明|改动说明|变更概述|概述)/i],
  ['must', /^(must[ -]?fix|fix\b|必须修改|必改|必须|修改)/i],
  ['nice', /^(nice[ -]?to[ -]?have|optional|reply|可以优化|可优化|建议|仅回复|回复)/i],
  ['mine', /^(mine|我的)/i],
  ['rules', /^(rules|附加规则|规则)/i],
  ['notes', /^(notes|备注|深挖|笔记)/i],
]

const TITLES: Record<Part, string> = { overview: 'Overview', must: 'Must fix', nice: 'Nice to have', mine: 'Mine', rules: 'Rules', notes: 'Notes' }
const AUTHOR_TITLES: Record<Part, string> = { ...TITLES, must: 'Fix', nice: 'Reply' }

const FINDING = /^[-*]\s+\[( |x|X)\]\s*(.*)$/
const ID = /^(?:\*\*)?([FCM]\d+)(?:\*\*)?\s*[:.：]?\s*/i
/** A response item's thread and who wrote the comment: `thread: PRRT_… @alice`, `-` for none. */
const THREAD = /^thread\s*[:：]\s*(\S+)(?:\s+@(\S+))?\s*$/i

/** `src/a.ts:88`, `src/a.ts:80-88`, `src/a.ts#L80-L88`, or a bare path. */
export function parseLocation(text: string): { path: string; line?: number; start?: number } | undefined {
  const value = text.trim()
  if (value === '' || /\s/.test(value)) return undefined
  const match = /^(.+?)(?::|#L)L?(\d+)(?:\s*-\s*L?(\d+))?$/.exec(value)
  if (match === null) return { path: value }
  const first = Number(match[2])
  const last = match[3] === undefined ? undefined : Number(match[3])
  if (last === undefined || last === first) return { path: match[1]!, line: first }
  return { path: match[1]!, start: Math.min(first, last), line: Math.max(first, last) }
}

export function formatLocation(finding: Pick<Finding, 'path' | 'line' | 'start'>): string | undefined {
  if (finding.path === undefined) return undefined
  if (finding.line === undefined) return finding.path
  return finding.start === undefined ? `${finding.path}:${finding.line}` : `${finding.path}:${finding.start}-${finding.line}`
}

const unquote = (value: string): string => {
  const trimmed = value.trim()
  return /^(["'])[\s\S]*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

const oneLine = (value: string): string => value.replace(/\s*\r?\n\s*/g, ' ').trim()

/** Read a sheet; the error names what is missing. */
export function parseSheet(text: string): { sheet: Sheet } | { error: string } {
  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const front = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source)
  if (front === null) return { error: 'missing front matter (--- … ---)' }
  const fields = new Map<string, string>()
  for (const line of front[1]!.split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s?(.*)$/.exec(line)
    if (match !== null) fields.set(match[1]!.toLowerCase(), unquote(match[2]!))
  }
  const pr = fields.get('pr') ?? ''
  if (!PR.test(pr)) return { error: 'front matter needs `pr: owner/repo#<number>`' }
  const head = fields.get('head') ?? ''
  if (!/^[0-9a-f]{7,64}$/i.test(head)) return { error: 'front matter needs `head: <commit sha>`' }

  const parts: Record<Part, string[]> = { overview: [], must: [], nice: [], mine: [], rules: [], notes: [] }
  const extra: string[] = []
  let current: string[] = extra
  for (const line of source.slice(front[0].length).split('\n')) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      const part = HEADINGS.find(([, pattern]) => pattern.test(heading[1]!))?.[0]
      if (part !== undefined) {
        current = parts[part]
        continue
      }
      current = extra
    }
    current.push(line)
  }

  const role = fields.get('role') === 'author' ? 'author' as const : undefined
  const findings: Finding[] = []
  const used = new Set<string>()
  for (const severity of ['must', 'nice'] as const) findings.push(...parseFindings(parts[severity], severity, used, role === undefined ? 'F' : 'C'))
  findings.push(...parseFindings(parts.mine, 'nice', used, 'M'))
  const decision = fields.get('decision') as Decision | undefined
  const status = fields.get('status') as SheetStatus | undefined
  const round = Number(fields.get('round'))
  const context = contextOf(fields.get('context'))
  const sheet: Sheet = {
    pr,
    title: fields.get('title') ?? '',
    author: fields.get('author') ?? '',
    ...(fields.get('url') ? { url: fields.get('url')! } : {}),
    base: fields.get('base') ?? '',
    head,
    round: Number.isInteger(round) && round > 0 ? round : 1,
    status: status !== undefined && STATUSES.includes(status) ? status : 'ready',
    decision: decision !== undefined && DECISIONS.includes(decision) ? decision : role === 'author' ? 'comment' : findings.some((item) => item.severity === 'must') ? 'request-changes' : 'approve',
    summary: fields.get('summary') ?? '',
    ...(fields.get('session') ? { session: fields.get('session')! } : {}),
    ...(fields.get('review') ? { review: fields.get('review')! } : {}),
    ...(fields.get('submitted') ? { submitted: fields.get('submitted')! } : {}),
    overview: block(parts.overview),
    findings,
    rules: block(parts.rules),
    notes: block(parts.notes),
    extra: block(extra),
    ...(role === undefined ? {} : { role }),
    ...(fields.get('branch') ? { branch: fields.get('branch')! } : {}),
    ...(fields.get('tree') ? { tree: fields.get('tree')! } : {}),
    ...(fields.get('read') ? { read: fields.get('read')! } : {}),
    ...(fields.get('seen') ? { seen: fields.get('seen')! } : {}),
    ...(fields.get('fixed') ? { fixed: fields.get('fixed')! } : {}),
    ...(context.length === 0 ? {} : { context }),
  }
  return { sheet }
}

/** The stack's pull requests picked as context: `owner/repo#12 owner/repo#14`, each once. */
const contextOf = (value: string | undefined): string[] => [...new Set((value ?? '').split(/[\s,]+/).filter((key) => PR.test(key)))]

/** A section's text without its surrounding blank lines. */
const block = (lines: readonly string[]): string => lines.join('\n').replace(/^\s*\n/, '').trimEnd()

function parseFindings(lines: readonly string[], severity: Severity, used: Set<string>, prefix: 'F' | 'C' | 'M'): Finding[] {
  const out: Finding[] = []
  let open: { finding: Finding; text: string[]; en: string[] } | undefined
  const close = (): void => {
    if (open === undefined) return
    open.finding.text = open.text.join('\n').trim()
    open.finding.en = open.en.join('\n').trim()
    out.push(open.finding)
    open = undefined
  }
  for (const line of lines) {
    const match = FINDING.exec(line.trim())
    if (match !== null && !/^\s{2,}/.test(line)) {
      close()
      let rest = match[2]!
      let id = ID.exec(rest)?.[1]?.toUpperCase()
      if (id !== undefined) rest = rest.replace(ID, '')
      // Mine are M and only mine: an id from the other sections is renumbered either way.
      if (id !== undefined && (prefix === 'M') !== id.startsWith('M')) id = undefined
      if (id === undefined || used.has(id)) {
        let n = used.size + 1
        while (used.has(`${prefix}${n}`)) n++
        id = `${prefix}${n}`
      }
      used.add(id)
      const finding: Finding = { id, severity, checked: match[1] !== ' ', text: '', en: '' }
      const located = /^`([^`]+)`\s*[:：]?\s*(.*)$/.exec(rest)
      if (located !== null) {
        const where = parseLocation(located[1]!)
        if (where !== undefined) {
          Object.assign(finding, where)
          rest = located[2]!
        }
      }
      open = { finding, text: rest.trim() === '' ? [] : [rest.trim()], en: [] }
      continue
    }
    if (open === undefined) continue
    const trimmed = line.trim()
    if (trimmed === '') continue
    const thread = THREAD.exec(trimmed)
    if (thread !== null) {
      if (thread[1] !== '-') open.finding.thread = thread[1]!
      if (thread[2] !== undefined) open.finding.reviewer = thread[2]
    } else if (trimmed.startsWith('>')) {
      const quoted = trimmed.replace(/^>\s?/, '')
      open.en.push(open.en.length === 0 ? quoted.replace(/^(?:\*\*)?EN(?:\*\*)?\s*[:：]\s*/i, '') : quoted)
    } else open.text.push(trimmed)
  }
  close()
  return out
}

/** Write a sheet in the canonical form. */
export function serializeSheet(sheet: Sheet): string {
  const front: Array<[string, string | number | undefined]> = [
    ['pr', sheet.pr],
    ['title', oneLine(sheet.title)],
    ['author', sheet.author],
    ['url', sheet.url],
    ['base', sheet.base],
    ['head', sheet.head],
    ['round', sheet.round],
    ['status', sheet.status],
    ['decision', sheet.decision],
    ['summary', oneLine(sheet.summary)],
    ['session', sheet.session],
    ['review', sheet.review],
    ['submitted', sheet.submitted],
    ['role', sheet.role],
    ['branch', sheet.branch],
    ['tree', sheet.tree],
    ['read', sheet.read],
    ['seen', sheet.seen],
    ['fixed', sheet.fixed],
    ['context', sheet.context === undefined || sheet.context.length === 0 ? undefined : sheet.context.join(' ')],
  ]
  const lines = ['---', ...front.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`), '---', '']
  const titles = sheet.role === 'author' ? AUTHOR_TITLES : TITLES
  const section = (part: Part, body: string): void => {
    lines.push(`## ${titles[part]}`, '')
    if (body.trim() !== '') lines.push(body.trimEnd(), '')
  }
  section('overview', sheet.overview)
  const theirs = sheet.findings.filter((item) => !isMine(item))
  section('must', theirs.filter((item) => item.severity === 'must').map(serializeFinding).join('\n'))
  section('nice', theirs.filter((item) => item.severity === 'nice').map(serializeFinding).join('\n'))
  const mine = sheet.findings.filter(isMine)
  if (mine.length > 0) section('mine', mine.map(serializeFinding).join('\n'))
  section('rules', sheet.rules)
  section('notes', sheet.notes)
  if (sheet.extra.trim() !== '') lines.push(sheet.extra.trimEnd(), '')
  return lines.join('\n')
}

function serializeFinding(finding: Finding): string {
  const where = formatLocation(finding)
  // A line of the text that reads as a quote would be taken for the comment: escaped, it renders the same.
  const [first = '', ...more] = finding.text.split('\n').map((line) => line.trim().replace(/^>/, '\\>'))
  const lines = [`- [${finding.checked ? 'x' : ' '}] ${finding.id}${where === undefined ? '' : ` \`${where}\``}${first === '' ? '' : ` ${first}`}`]
  for (const line of more) if (line !== '') lines.push(`  ${line}`)
  if (finding.thread !== undefined || finding.reviewer !== undefined) lines.push(`  thread: ${finding.thread ?? '-'}${finding.reviewer === undefined ? '' : ` @${finding.reviewer}`}`)
  // The comment keeps its indentation (code, suggestions) and its paragraphs: a blank line is a bare `>`.
  const en = finding.en.trim().split('\n').map((line) => line.trimEnd())
  if (en.length === 1 && en[0] === '') return lines.join('\n')
  en.forEach((line, index) => lines.push(line === '' ? '  >' : `  > ${index === 0 ? 'EN: ' : ''}${line}`))
  return lines.join('\n')
}

/** The sheet after the UI's edits; an unknown finding is refused. */
export function applyOps(sheet: Sheet, ops: readonly SheetOp[]): Sheet {
  let next: Sheet = { ...sheet, findings: [...sheet.findings] }
  const finding = (id: string, patch: Partial<Finding>): void => {
    const index = next.findings.findIndex((item) => item.id === id)
    if (index < 0) throw new Error(`no finding ${id} in the sheet`)
    next.findings[index] = { ...next.findings[index]!, ...patch }
  }
  for (const op of ops) {
    switch (op.op) {
      case 'check': finding(op.id, { checked: op.checked }); break
      case 'en': finding(op.id, { en: op.text.trim() }); break
      case 'decision':
        if (!DECISIONS.includes(op.value)) throw new Error(`unknown decision ${String(op.value)}`)
        next = { ...next, decision: op.value }
        break
      case 'summary': next = { ...next, summary: oneLine(op.value) }; break
      case 'rules': next = { ...next, rules: op.value.replace(/\r\n?/g, '\n').trim() }; break
      // A response item's 修改 / 仅回复 / 忽略: which section it sits in, and whether it is picked.
      case 'verdict':
        if (!VERDICTS.includes(op.value)) throw new Error(`unknown verdict ${String(op.value)}`)
        finding(op.id, op.value === 'skip' ? { checked: false } : { checked: true, severity: op.value === 'fix' ? 'must' : 'nice' })
        break
      case 'add': {
        const en = op.en.replace(/\r\n?/g, '\n').trim()
        if (en === '') throw new Error('The comment is empty')
        if (typeof op.path !== 'string' || op.path === '' || !Number.isInteger(op.line) || op.line < 1 || (op.start !== undefined && (!Number.isInteger(op.start) || op.start < 1))) throw new Error('A comment needs the lines it is on')
        const n = Math.max(0, ...next.findings.filter(isMine).map((item) => Number(item.id.slice(1)))) + 1
        const text = op.text.replace(/\r\n?/g, '\n').trim()
        const start = op.start === undefined || op.start >= op.line ? undefined : op.start
        next.findings.push({
          id: `M${n}`, severity: 'nice', checked: true, path: op.path, line: op.line, ...(start === undefined ? {} : { start }),
          // The text is kept only when a bot made the comment out of it.
          text: text === en ? '' : text, en,
        })
        break
      }
      case 'remove':
        if (!isMine({ id: op.id })) throw new Error(`${op.id} is not a comment of yours`)
        next.findings = next.findings.filter((item) => item.id !== op.id)
        break
      case 'context': {
        if (!Array.isArray(op.keys)) throw new Error('The context needs pull requests')
        const { context: _old, ...rest } = next
        const keys = contextOf(op.keys.join(' '))
        next = keys.length === 0 ? rest : { ...rest, context: keys }
        break
      }
      default: throw new Error('unknown sheet edit')
    }
  }
  return next
}

/** A sheet just opened for analysis: the pull request's facts, nothing found yet. */
export function blankSheet(input: Pick<Sheet, 'pr' | 'title' | 'author' | 'base' | 'head' | 'round'> & Partial<Pick<Sheet, 'role' | 'branch' | 'tree' | 'read' | 'context'>> & { url?: string; session?: string; rules?: string; findings?: Finding[]; status?: SheetStatus }): Sheet {
  return {
    pr: input.pr,
    title: input.title,
    author: input.author,
    ...(input.url === undefined ? {} : { url: input.url }),
    base: input.base,
    head: input.head,
    round: input.round,
    status: input.status ?? 'analyzing',
    decision: 'comment',
    summary: '',
    ...(input.session === undefined ? {} : { session: input.session }),
    overview: '',
    findings: input.findings ?? [],
    rules: input.rules ?? '',
    notes: '',
    extra: '',
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.tree === undefined ? {} : { tree: input.tree }),
    ...(input.read === undefined ? {} : { read: input.read }),
    ...(input.context === undefined || input.context.length === 0 ? {} : { context: input.context }),
  }
}
