import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { workspaceGate } from '../src/git/service.ts'
import { decode, encode, eolOf, FilesService } from '../src/files/service.ts'
import { distance, preview, queryRegExp } from '../src/files/search.ts'
import { formatters, ownPrettier } from '../src/files/format.ts'
import type { BaseText, FileText, FilesReply, Formatted, Location, Placed, SearchResult, Written } from '../src/files/types.ts'

function workspace(): { dir: string; outside: string; service: FilesService; gitService: FilesService; done: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-files-')))
  const dir = join(root, 'ws')
  const outside = join(root, 'elsewhere')
  mkdirSync(dir)
  mkdirSync(outside)
  const gate = workspaceGate(() => [dir])
  return {
    dir,
    outside,
    service: new FilesService(gate, { ripgrep: async () => rgPath, prettier: ownPrettier }),
    gitService: new FilesService(gate),
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}

function value<T>(reply: FilesReply<unknown>): T {
  if (!reply.ok) assert.fail(`${reply.error.code}: ${reply.error.message}`)
  return reply.value as T
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

test('encoding: line endings and byte order marks survive a round trip', () => {
  assert.equal(eolOf('a\nb\n'), 'lf')
  assert.equal(eolOf('a\r\nb\r\n'), 'crlf')
  assert.equal(eolOf('a\r\nb\nc\n'), 'lf')
  assert.deepEqual(encode('a\nb', 'crlf', true), Buffer.from('﻿a\r\nb', 'utf8'))
  assert.deepEqual(decode(Buffer.from('﻿hi', 'utf8')), { text: 'hi', bom: true })
  assert.throws(() => decode(Buffer.from([0x61, 0, 0x62])), /binary/)
  assert.throws(() => decode(Buffer.from([0xc3, 0x28])), /not UTF-8/)
})

test('read and write: a write names its base and keeps the file\'s format', async () => {
  const { dir, service, done } = workspace()
  try {
    writeFileSync(join(dir, 'a.txt'), '﻿one\r\ntwo\r\n')
    const file = value<FileText>(await service.handle({ op: 'read', cwd: dir, path: 'a.txt' }))
    assert.equal(file.path, 'a.txt')
    assert.equal(file.text, 'one\r\ntwo\r\n')
    assert.equal(file.eol, 'crlf')
    assert.equal(file.bom, true)
    const written = value<Written>(await service.handle({ op: 'write', cwd: dir, path: 'a.txt', text: 'one\nthree\n', base: file.hash, eol: file.eol, bom: file.bom }))
    assert.deepEqual(readFileSync(join(dir, 'a.txt')), Buffer.from('﻿one\r\nthree\r\n', 'utf8'))
    // An agent edits the file: a write from the old base is refused, with what is on disk now.
    writeFileSync(join(dir, 'a.txt'), 'agent\n')
    const stale = await service.handle({ op: 'write', cwd: dir, path: 'a.txt', text: 'mine\n', base: written.hash, eol: 'lf', bom: false })
    assert.equal(stale.ok, false)
    assert.equal(!stale.ok && stale.error.code, 'conflict')
    assert.equal(!stale.ok && stale.error.current?.text, 'agent\n')
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'agent\n')
    // Deleted meanwhile: only a write expecting absence recreates it.
    unlinkSync(join(dir, 'a.txt'))
    const gone = await service.handle({ op: 'write', cwd: dir, path: 'a.txt', text: 'x', base: written.hash, eol: 'lf', bom: false })
    assert.equal(!gone.ok && gone.error.code, 'conflict')
    value(await service.handle({ op: 'write', cwd: dir, path: 'a.txt', text: 'back', base: null, eol: 'lf', bom: false }))
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'back')
  } finally {
    done()
  }
})

test('paths: nothing outside the registered workspaces', async () => {
  const { dir, outside, service, done } = workspace()
  try {
    writeFileSync(join(outside, 'secret.txt'), 'no')
    for (const path of [join(outside, 'secret.txt'), '../elsewhere/secret.txt']) {
      const reply = await service.handle({ op: 'read', cwd: dir, path })
      assert.equal(!reply.ok && reply.error.code, 'denied')
      const write = await service.handle({ op: 'write', cwd: dir, path, text: 'x', base: null, eol: 'lf', bom: false })
      assert.equal(!write.ok && write.error.code, 'denied')
    }
    const cwd = await service.handle({ op: 'read', cwd: outside, path: 'secret.txt' })
    assert.equal(!cwd.ok && cwd.error.code, 'denied')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2]))
    const binary = await service.handle({ op: 'read', cwd: dir, path: 'bin.dat' })
    assert.equal(!binary.ok && binary.error.code, 'binary')
    const missing = await service.handle({ op: 'read', cwd: dir, path: 'nope.txt' })
    assert.equal(!missing.ok && missing.error.code, 'not-found')
  } finally {
    done()
  }
})

test('search: ripgrep and the git grep stand-in agree, honouring .gitignore', async () => {
  const { dir, service, gitService, done } = workspace()
  try {
    git(dir, 'init', '-q')
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, '.gitignore'), 'dist/\n')
    writeFileSync(join(dir, 'src', 'a.ts'), 'const Hello = 1\nhello world\nhelloWorld()\n')
    writeFileSync(join(dir, 'src', 'b.md'), '# Hello 你好 hello\n')
    writeFileSync(join(dir, 'dist', 'out.js'), 'hello\n')
    for (const engine of [service, gitService]) {
      const all = value<SearchResult>(await engine.handle({ op: 'search', cwd: dir, query: 'hello' }))
      assert.deepEqual(all.files.map((file) => file.path).sort(), ['src/a.ts', 'src/b.md'])
      assert.equal(all.count, 4)
      const md = all.files.find((file) => file.path === 'src/b.md')!
      assert.deepEqual(md.matches[0]!.ranges, [[2, 7], [11, 16]])
      const word = value<SearchResult>(await engine.handle({ op: 'search', cwd: dir, query: 'hello', word: true, caseSensitive: true, include: '*.ts' }))
      assert.deepEqual(word.files.map((file) => [file.path, file.matches.map((match) => match.line)]), [['src/a.ts', [2]]])
      const capped = value<SearchResult>(await engine.handle({ op: 'search', cwd: dir, query: 'hello', limit: 2 }))
      assert.equal(capped.count, 2)
      assert.equal(capped.truncated, true)
    }
    const bad = await service.handle({ op: 'search', cwd: dir, query: '(', regex: true })
    assert.equal(!bad.ok && bad.error.code, 'invalid')
  } finally {
    done()
  }
})

test('definitions: declarations by search, nearest first, uses left out', async () => {
  const { dir, service, done } = workspace()
  try {
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'test'))
    writeFileSync(join(dir, 'src', 'main.ts'), 'import { render } from "./deep/view"\nconst value = render(1)\nreturn render(2)\n')
    writeFileSync(join(dir, 'src', 'deep', 'view.ts'), 'export function render(n: number) {\n  return n\n}\nclass Box {\n  size: number = 1\n  grow(by: number): void {\n  }\n}\n')
    writeFileSync(join(dir, 'test', 'view.test.ts'), 'function render() {}\n')
    writeFileSync(join(dir, 'tool.py'), 'def render():\n    pass\n')
    const found = value<Location[]>(await service.handle({ op: 'definition', cwd: dir, path: 'src/main.ts', word: 'render' }))
    assert.deepEqual(found.map((location) => [location.path, location.line, location.column]), [['src/deep/view.ts', 1, 17], ['test/view.test.ts', 1, 10]])
    const method = value<Location[]>(await service.handle({ op: 'definition', cwd: dir, path: 'src/main.ts', word: 'grow' }))
    assert.deepEqual(method.map((location) => [location.path, location.line]), [['src/deep/view.ts', 6]])
    const field = value<Location[]>(await service.handle({ op: 'definition', cwd: dir, path: 'src/deep/view.ts', word: 'size' }))
    assert.deepEqual(field.map((location) => location.line), [5])
    const python = value<Location[]>(await service.handle({ op: 'definition', cwd: dir, path: 'tool.py', word: 'render' }))
    assert.deepEqual(python.map((location) => location.path), ['tool.py'])
    const invalid = await service.handle({ op: 'definition', cwd: dir, path: 'tool.py', word: 'a b' })
    assert.equal(!invalid.ok && invalid.error.code, 'invalid')
  } finally {
    done()
  }
})

test('base: HEAD for tracked files, empty for new ones, nothing for ignored ones', async () => {
  const { dir, outside, service, done } = workspace()
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 'a@b.c')
    git(dir, 'config', 'user.name', 'a')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'tracked.ts'), 'one\n')
    writeFileSync(join(dir, '.gitignore'), '*.log\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
    writeFileSync(join(dir, 'sub', 'tracked.ts'), 'two\n')
    writeFileSync(join(dir, 'new.ts'), 'x\n')
    writeFileSync(join(dir, 'run.log'), 'x\n')
    assert.deepEqual(value<BaseText>(await service.handle({ op: 'base', cwd: dir, path: 'sub/tracked.ts' })), { text: 'one\n' })
    assert.deepEqual(value<BaseText>(await service.handle({ op: 'base', cwd: dir, path: 'new.ts' })), { text: '' })
    assert.deepEqual(value<BaseText>(await service.handle({ op: 'base', cwd: dir, path: 'run.log' })), {})
    void outside
  } finally {
    done()
  }
})

test('format: the plugin\'s own prettier stands in for a project without one', async () => {
  const { dir, service, done } = workspace()
  try {
    writeFileSync(join(dir, 'a.ts'), '')
    const formatted = value<Formatted>(await service.handle({ op: 'format', cwd: dir, path: 'a.ts', text: 'const a = {b:1}' }))
    assert.deepEqual(formatted, { text: 'const a = { b: 1 };\n', formatter: 'prettier' })
    writeFileSync(join(dir, '.prettierrc'), '{ "semi": false, "singleQuote": true }')
    const configured = value<Formatted>(await service.handle({ op: 'format', cwd: dir, path: 'a.ts', text: 'const a = "x";' }))
    assert.equal(configured.text, "const a = 'x'\n")
    const broken = await service.handle({ op: 'format', cwd: dir, path: 'a.ts', text: 'const = ;' })
    assert.equal(!broken.ok && broken.error.code, 'failed')
    writeFileSync(join(dir, 'a.unknownext'), '')
    const none = await service.handle({ op: 'format', cwd: dir, path: 'a.unknownext', text: 'x' })
    assert.equal(!none.ok && none.error.code, 'unavailable')
    assert.deepEqual(formatters({ file: join(dir, 'm.py'), text: '', root: dir }, undefined).map((item) => item.name), ['ruff', 'black'])
  } finally {
    done()
  }
})

test('search helpers: previews, word patterns, path distance', () => {
  const long = `${' '.repeat(8)}${'x'.repeat(300)}needle${'y'.repeat(50)}`
  const cut = preview(long, [[308, 314]])
  assert.ok(cut.preview.length <= 240)
  assert.equal(cut.preview.slice(cut.ranges[0]![0], cut.ranges[0]![1]), 'needle')
  assert.deepEqual(preview('    indented', [[4, 8]]), { preview: 'indented', ranges: [[0, 4]] })
  const word = queryRegExp({ query: 'a.b', word: true })!
  assert.equal('xa.b a.b'.match(word)?.length, 1)
  assert.equal(distance('a/b.ts', 'a/b.ts'), 0)
  assert.equal(distance('a/b.ts', 'a/c.ts'), 1)
  assert.ok(distance('a/b.ts', 'a/x/c.ts') < distance('a/b.ts', 'z/y/c.ts'))
})

test('tree menu: paste copies or moves under a free name, never overwriting', async () => {
  const { dir, service, done } = workspace()
  try {
    mkdirSync(join(dir, 'src/lib'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'a')
    writeFileSync(join(dir, 'src/lib/b.ts'), 'b')
    // Copied beside itself: "a copy.ts", then "a copy 2.ts".
    const first = value<Placed>(await service.handle({ op: 'paste', cwd: dir, path: 'src/a.ts', into: 'src', cut: false }))
    assert.equal(first.absolutePath, join(dir, 'src/a copy.ts'))
    const second = value<Placed>(await service.handle({ op: 'paste', cwd: dir, path: join(dir, 'src/a.ts'), into: join(dir, 'src'), cut: false }))
    assert.equal(second.absolutePath, join(dir, 'src/a copy 2.ts'))
    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'a')
    // A folder copies whole.
    value<Placed>(await service.handle({ op: 'paste', cwd: dir, path: 'src/lib', into: '.', cut: false }))
    assert.equal(readFileSync(join(dir, 'lib/b.ts'), 'utf8'), 'b')
    // Cut: moved, the original gone; cut into where it is changes nothing.
    const moved = value<Placed>(await service.handle({ op: 'paste', cwd: dir, path: 'src/a.ts', into: 'src/lib', cut: true }))
    assert.equal(moved.absolutePath, join(dir, 'src/lib/a.ts'))
    assert.equal(existsSync(join(dir, 'src/a.ts')), false)
    assert.equal(value<Placed>(await service.handle({ op: 'paste', cwd: dir, path: 'src/lib/a.ts', into: 'src/lib', cut: true })).absolutePath, join(dir, 'src/lib/a.ts'))
    // Cut onto a taken name: a free one instead of the file there.
    writeFileSync(join(dir, 'a.ts'), 'root')
    assert.equal(value<Placed>(await service.handle({ op: 'paste', cwd: dir, path: 'src/lib/a.ts', into: '.', cut: true })).absolutePath, join(dir, 'a copy.ts'))
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'root')
    // A folder never goes inside itself.
    const into = await service.handle({ op: 'paste', cwd: dir, path: 'src', into: 'src/lib', cut: true })
    assert.equal(!into.ok && into.error.code, 'invalid')
  } finally {
    done()
  }
})

test('tree menu: rename refuses taken names, delete removes the entry itself', async () => {
  const { dir, outside, service, done } = workspace()
  try {
    mkdirSync(join(dir, 'd'))
    writeFileSync(join(dir, 'd/x.txt'), 'x')
    writeFileSync(join(dir, 'y.txt'), 'y')
    assert.equal(value<Placed>(await service.handle({ op: 'rename', cwd: dir, path: 'y.txt', name: 'z.txt' })).absolutePath, join(dir, 'z.txt'))
    const taken = await service.handle({ op: 'rename', cwd: dir, path: 'z.txt', name: 'd' })
    assert.equal(!taken.ok && taken.error.code, 'conflict')
    for (const name of ['', '..', 'a/b']) {
      const bad = await service.handle({ op: 'rename', cwd: dir, path: 'z.txt', name })
      assert.equal(!bad.ok && bad.error.code, 'invalid', name)
    }
    // A symlink is deleted, not what it points to.
    writeFileSync(join(outside, 'kept.txt'), 'kept')
    symlinkSync(join(outside, 'kept.txt'), join(dir, 'link'))
    value(await service.handle({ op: 'delete', cwd: dir, path: 'link' }))
    assert.equal(readFileSync(join(outside, 'kept.txt'), 'utf8'), 'kept')
    value(await service.handle({ op: 'delete', cwd: dir, path: 'd' }))
    assert.equal(existsSync(join(dir, 'd')), false)
    // Never the session folder, a workspace root, or anything outside.
    for (const path of ['.', dir, join(outside, 'kept.txt'), '../elsewhere']) {
      const refused = await service.handle({ op: 'delete', cwd: dir, path })
      assert.equal(!refused.ok && refused.error.code, 'denied', path)
    }
    const away = await service.handle({ op: 'paste', cwd: dir, path: 'z.txt', into: outside, cut: true })
    assert.equal(!away.ok && away.error.code, 'denied')
    assert.equal(existsSync(join(dir, 'z.txt')), true)
  } finally {
    done()
  }
})

test('tree menu: create makes empty files and folders, the folders on the way too', async () => {
  const { dir, outside, service, done } = workspace()
  try {
    const file = value<Placed>(await service.handle({ op: 'create', cwd: dir, into: '.', name: 'a.ts', kind: 'file' }))
    assert.equal(file.absolutePath, join(dir, 'a.ts'))
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), '')
    const taken = await service.handle({ op: 'create', cwd: dir, into: dir, name: 'a.ts', kind: 'directory' })
    assert.equal(!taken.ok && taken.error.code, 'conflict')
    // Nested names make their folders; an existing one is reused.
    value<Placed>(await service.handle({ op: 'create', cwd: dir, into: '.', name: 'src/lib/b.ts', kind: 'file' }))
    value<Placed>(await service.handle({ op: 'create', cwd: dir, into: 'src', name: ' lib / deep ', kind: 'directory' }))
    assert.equal(existsSync(join(dir, 'src/lib/b.ts')), true)
    assert.equal(existsSync(join(dir, 'src/lib/deep')), true)
    const through = await service.handle({ op: 'create', cwd: dir, into: '.', name: 'a.ts/c.ts', kind: 'file' })
    assert.equal(!through.ok && through.error.code, 'conflict')
    for (const name of ['', ' / ', '..', 'x/../y']) {
      const bad = await service.handle({ op: 'create', cwd: dir, into: '.', name, kind: 'file' })
      assert.equal(!bad.ok && bad.error.code, 'invalid', name)
    }
    // Never outside a workspace, not even through a symlinked folder.
    const away = await service.handle({ op: 'create', cwd: dir, into: outside, name: 'x', kind: 'file' })
    assert.equal(!away.ok && away.error.code, 'denied')
    symlinkSync(outside, join(dir, 'out'))
    const linked = await service.handle({ op: 'create', cwd: dir, into: '.', name: 'out/x', kind: 'file' })
    assert.equal(!linked.ok && linked.error.code, 'denied')
    assert.equal(existsSync(join(outside, 'x')), false)
  } finally {
    done()
  }
})
