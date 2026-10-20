import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogChange, CursorSkills, PROJECT_RANK, readEntry, slug, USER_RANK } from '../src/cursor/commands.ts'

async function fixture(): Promise<{ base: string; home: string; repo: string }> {
  const base = await mkdtemp(join(tmpdir(), 'cursor-commands-'))
  const home = join(base, 'home')
  const repo = join(base, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(join(repo, 'src', 'deep'), { recursive: true })
  await mkdir(join(repo, '.cursor', 'commands'), { recursive: true })
  await mkdir(join(repo, '.cursor', 'skills', 'deploy'), { recursive: true })
  await mkdir(join(home, '.cursor', 'commands'), { recursive: true })
  await mkdir(join(home, '.cursor', 'skills', 'style'), { recursive: true })
  await mkdir(join(home, '.cursor', 'skills-cursor', 'canvas'), { recursive: true })
  await writeFile(join(repo, '.cursor', 'commands', 'Fix_Lint.md'), '# Fix lint errors\n\nRun the linter and fix what it reports.\n')
  await writeFile(join(repo, '.cursor', 'commands', 'notes.txt'), 'not a command')
  await writeFile(join(repo, '.cursor', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship the app\n---\nSteps.\n')
  await writeFile(join(home, '.cursor', 'commands', 'review.md'), '---\ndescription: Review the diff\n---\nReview it.\n')
  await writeFile(join(home, '.cursor', 'skills', 'style', 'SKILL.md'), '---\nname: style\ndescription: House style\ndisable-model-invocation: true\n---\nBe brief.\n')
  await writeFile(join(home, '.cursor', 'skills-cursor', 'canvas', 'SKILL.md'), '---\nname: canvas\ndescription: Cursor only\n---\n')
  return { base, home, repo }
}

const control = (): { signal: AbortSignal; invalidate(): void; count: number; abort(): void } => {
  const lifecycle = new AbortController()
  const box = { signal: lifecycle.signal, count: 0, invalidate() { box.count += 1 }, abort: () => lifecycle.abort() }
  return box
}

test('cursor commands: names follow the frontmatter, else the file name in kebab-case', () => {
  assert.equal(slug('Fix_Lint Now'), 'fix-lint-now')
  assert.equal(readEntry('# Title\nbody', '/x/commands/My Cmd.md', 'commands')?.name, 'my-cmd')
  assert.equal(readEntry('---\nname: Bad Name\n---\nhi', '/x/skills/good/SKILL.md', 'skills')?.name, 'good')
  assert.equal(readEntry('---\nname: own\n---\nhi', '/x/skills/dir/SKILL.md', 'skills')?.name, 'own')
})

test('cursor commands: a command is described by its first line and offered to the user only', () => {
  const entry = readEntry('\n## Fix lint errors\n\nbody', '/x/commands/fix.md', 'commands')
  assert.equal(entry?.description, 'Fix lint errors')
  assert.deepEqual(entry?.invocation, { modelInvocable: false, userInvocable: true })
  assert.equal(entry?.content, '\n## Fix lint errors\n\nbody')
  const skill = readEntry('---\ndescription: d\ndisable-model-invocation: "yes"\n---\nbody', '/x/skills/s/SKILL.md', 'skills')
  assert.deepEqual(skill?.invocation, { modelInvocable: false, userInvocable: true })
  assert.equal(skill?.content, 'body')
})

test('cursor commands: the project and user folders are listed, Cursor built-ins left out', async () => {
  const { base, home, repo } = await fixture()
  const box = control()
  const provider = new CursorSkills(box, home)
  try {
    const listed = await provider.list({ cwd: join(repo, 'src', 'deep') })
    assert.deepEqual(listed.map((entry) => [entry.name, entry.source, entry.rank]), [
      ['deploy', 'project-cursor', PROJECT_RANK],
      ['fix-lint', 'project-cursor', PROJECT_RANK],
      ['style', 'user-cursor', USER_RANK],
      ['review', 'user-cursor', USER_RANK],
    ])
    const style = listed.find((entry) => entry.name === 'style')!
    assert.deepEqual(style.invocation, { modelInvocable: false, userInvocable: true })
    assert.equal(style.resourceBase.path, join(home, '.cursor', 'skills', 'style'))
    const fix = await provider.get(listed.find((entry) => entry.name === 'fix-lint')!)
    assert.equal(fix?.content, '# Fix lint errors\n\nRun the linter and fix what it reports.\n')
    assert.equal(fix?.provider, 'cursor')
    // Without a session folder only the user's are listed.
    assert.deepEqual((await provider.list({})).map((entry) => entry.name), ['style', 'review'])
  } finally {
    box.abort()
    await rm(base, { recursive: true, force: true })
  }
})

test('cursor commands: a new command invalidates the catalog', async () => {
  const { base, home, repo } = await fixture()
  const box = control()
  const provider = new CursorSkills(box, home)
  try {
    await provider.list({ cwd: repo })
    await new Promise((done) => setTimeout(done, 200))
    const before = box.count
    await writeFile(join(repo, '.cursor', 'commands', 'added.md'), 'Added\n')
    for (let i = 0; i < 40 && box.count === before; i++) await new Promise((done) => setTimeout(done, 50))
    assert.ok(box.count > before)
    assert.ok((await provider.list({ cwd: repo })).some((entry) => entry.name === 'added'))
  } finally {
    box.abort()
    await rm(base, { recursive: true, force: true })
  }
})

test('cursor commands: only top-level entries and bundle SKILL.md change the catalog', () => {
  assert.ok(catalogChange('commands', 'x.md'))
  assert.ok(catalogChange('skills', 'bundle'))
  assert.ok(catalogChange('skills', 'bundle/SKILL.md'))
  assert.ok(!catalogChange('skills', 'bundle/data/x.csv'))
  assert.ok(!catalogChange('skills', 'bundle/README.md'))
})
