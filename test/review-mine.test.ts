import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOps, blankSheet, parseSheet, serializeSheet } from '../src/review/sheet.ts'
import { buildReview } from '../src/review/submit.ts'
import { ReviewService } from '../src/review/index.ts'
import { composePrompt, reviewSection } from '../src/review/prompt.ts'
import type { GitHub } from '../src/review/github.ts'
import type { ReviewState, Sheet, SheetReply } from '../src/review/types.ts'

const SHA = 'a'.repeat(40)
const sheetOf = (text: string): Sheet => (parseSheet(text) as { sheet: Sheet }).sheet

test('review mine: comments of mine sit in their own section, keep their shape, and post as line comments', () => {
  const base = { ...blankSheet({ pr: 'a/b#1', title: 'T', author: 'x', base: 'main', head: SHA, round: 1 }), status: 'ready' as const }
  const theirs: Sheet = { ...base, findings: [{ id: 'F1', severity: 'nice', checked: true, path: 'a.ts', line: 3, text: '命名', en: 'Nit: name.' }] }
  assert.doesNotMatch(serializeSheet(theirs), /## Mine/, 'no section until there is a comment of mine')

  const code = 'Maybe this?\n\n```suggestion\n  const x = 1\n```'
  const sheet = applyOps(theirs, [
    { op: 'add', path: 'a.ts', line: 12, start: 10, text: '这里改成常量', en: code },
    { op: 'add', path: 'b.ts', line: 4, text: 'Same as written', en: ' Same as written ' },
  ])
  assert.deepEqual(sheet.findings.map((f) => [f.id, f.checked, f.path, f.start, f.line, f.text]), [
    ['F1', true, 'a.ts', undefined, 3, '命名'],
    ['M1', true, 'a.ts', 10, 12, '这里改成常量'],
    ['M2', true, 'b.ts', undefined, 4, ''],
  ])
  const written = serializeSheet(sheet)
  assert.match(written, /## Mine\n\n- \[x\] M1 `a.ts:10-12` 这里改成常量\n {2}> EN: Maybe this\?\n {2}>\n {2}> ```suggestion\n {2}> {3}const x = 1/)
  const read = sheetOf(written)
  assert.deepEqual(read.findings, sheet.findings, 'indentation and paragraphs survive')
  assert.equal(read.findings.filter((f) => f.severity === 'nice' && !f.id.startsWith('M')).length, 1, 'mine are not Nice to have')

  // Numbering goes on from the highest; only mine can go.
  const next = applyOps(read, [{ op: 'remove', id: 'M1' }, { op: 'add', path: 'c.ts', line: 1, text: 'x', en: 'x' }])
  assert.deepEqual(next.findings.map((f) => f.id), ['F1', 'M2', 'M3'])
  assert.throws(() => applyOps(read, [{ op: 'remove', id: 'F1' }]), /not a comment of yours/)
  assert.throws(() => applyOps(read, [{ op: 'add', path: 'a.ts', line: 0, text: 'x', en: 'x' }]), /lines/)
  assert.throws(() => applyOps(read, [{ op: 'add', path: 'a.ts', line: 2, text: 'x', en: '  ' }]), /empty/)

  // A text line reading as a quote stays text.
  const quoted = applyOps(theirs, [{ op: 'add', path: 'a.ts', line: 2, text: '> 引用\n第二行', en: 'Quote' }])
  assert.deepEqual(sheetOf(serializeSheet(quoted)).findings.at(-1)?.en, 'Quote')

  const preview = buildReview({ ...sheet, decision: 'comment', summary: '' }, { lines: new Map([['a.ts', new Set([3, 10, 11, 12])]]) })
  assert.deepEqual(preview.comments.map((c) => [c.id, c.start, c.line, c.body]), [['F1', undefined, 3, 'Nit: name.'], ['M1', 10, 12, code]])
  assert.deepEqual(preview.folded, ['M2'], 'a line outside the diff joins the body, as any finding')
  assert.deepEqual(preview.problems, [])
  assert.match(reviewSection(''), /## Mine.*keep it exactly as written/)
})

test('review mine: a bot rewrites a comment with its persona and the style, and nothing else changes', () => {
  const prompt = composePrompt({ persona: 'You are "en": translate.', style: 'Short.', text: '加个上限', path: 'a.ts', start: 3, end: 5, diff: '@@ -1 +3,3 @@\n+x' })
  assert.match(prompt.system, /^You are "en": translate\./)
  assert.match(prompt.system, /add no finding/)
  assert.match(prompt.system, /Style:\nShort\.$/)
  assert.match(prompt.user, /`a.ts:3-5`/)
  assert.match(prompt.user, /The note:\n加个上限$/)
})

test('review mine: a comment opens a sheet before any analysis, a bot processes text without writing, the analysis keeps mine', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-mine-')))
  try {
    const repo = join(root, 'app')
    const path = join(repo, '.reviews', 'pr-7.md')
    const calls: Array<{ provider: string; model: string; system: string }> = []
    let starts = 0
    const service = new ReviewService({
      settings: () => ({ repos: [repo], at: '09:00', bot: 'reviewer', commentBot: 'en', style: '', maxPerRun: 5 }),
      repos: async () => [{ key: repo, name: 'app', members: [] }],
      sessions: () => ({ start: async () => `s${++starts}`, send: async () => {}, cancel: async () => {}, archive: async () => {} }),
      bots: () => [{ id: 'en', description: 'translator', persona: 'Translate to English.', provider: 'claude-agent', model: 'opus' }],
      helper: async () => ({ provider: 'p', model: 'helper' }),
      botRoute: async (bot) => (bot.provider === 'claude-agent' ? { provider: 'p', model: 'helper' } : { provider: bot.provider!, model: bot.model! }),
      llm: () => ({
        async *stream(options: object) {
          calls.push(options as (typeof calls)[number])
          yield { type: 'text-delta', text: '"Cap the retries?"' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }) as never,
      stateFile: join(root, 'review.json'),
      log: () => {},
      github: {
        requested: async () => [{ slug: 'acme/app', number: 7, title: 'T7', url: 'u7', draft: false, head: SHA, branch: 'b', base: 'main', author: 'alice', updatedAt: 1 }],
        threads: async () => [],
      } as unknown as GitHub,
      git: async (args) => {
        if (args[0] === 'config') return { code: 0, stdout: 'remote.origin.url https://github.com/acme/app.git\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const call = async <T>(payload: Record<string, unknown>): Promise<T> => {
      const reply = await service.handle(payload)
      if (!reply.ok) throw new Error(reply.error)
      return reply.value as T
    }
    const state = await call<ReviewState>({ op: 'state' })
    assert.equal(state.commentBot, 'en')
    assert.equal(state.items[0]!.phase, 'new')

    // Processing answers the text only: the bot's persona on a model that answers one request.
    const text = await call<string>({ op: 'compose', key: 'acme/app#7', bot: 'en', text: '加个上限？', target: { path: 'hook.ts', kind: 'lines', start: 2, end: 2, diff: '+x' } })
    assert.equal(text, 'Cap the retries?')
    assert.deepEqual([calls[0]!.provider, calls[0]!.model], ['p', 'helper'])
    assert.match(calls[0]!.system, /You are "en": translator\.\n\nTranslate to English\./)
    assert.equal(existsSync(path), false, 'nothing written')
    await assert.rejects(call({ op: 'compose', key: 'acme/app#7', bot: 'gone', text: 'x' }), /unavailable/)

    // Without a key there is no sheet to add to; with one, a sheet opens at the head, ready.
    await assert.rejects(call({ op: 'patch', path, ops: [{ op: 'add', path: 'hook.ts', line: 2, text: '加个上限？', en: text }] }))
    const reply = await call<SheetReply>({ op: 'patch', path, key: 'acme/app#7', ops: [{ op: 'add', path: 'hook.ts', line: 2, text: '加个上限？', en: text }] })
    assert.deepEqual(reply.sheet?.findings.map((f) => [f.id, f.en]), [['M1', 'Cap the retries?']])
    assert.equal(readFileSync(join(repo, '.reviews', '.gitignore'), 'utf8'), '*\n')
    const item = (await call<ReviewState>({ op: 'state' })).items[0]!
    assert.deepEqual([item.phase, item.session, item.must, item.nice, item.checked], ['ready', undefined, 0, 0, 1])
    assert.equal(sheetOf(readFileSync(path, 'utf8')).head, SHA)

    // Still due for the analysis, which starts afresh and keeps my comment.
    const synced = await call<ReviewState>({ op: 'analyzeAll' })
    assert.equal(synced.items[0]!.queued, true)
    for (let i = 0; i < 200 && service.progress().runs[0]?.step !== 'analyzing'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    const analysing = sheetOf(readFileSync(path, 'utf8'))
    assert.deepEqual([analysing.status, analysing.session], ['analyzing', 's1'])
    assert.deepEqual(analysing.findings.map((f) => [f.id, f.text, f.en]), [['M1', '加个上限？', 'Cap the retries?']])
    // While it analyses, no comment is added under it.
    await assert.rejects(call({ op: 'patch', path, key: 'acme/app#7', ops: [{ op: 'add', path: 'hook.ts', line: 1, text: 'x', en: 'x' }] }), /analysis/)
    service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
