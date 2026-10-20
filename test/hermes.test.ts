import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findHermes, HERMES_PROVIDER, hermesProfile, hermesRoot, listPersonas, personaHome } from '../src/hermes/route.ts'

/** A Hermes root with a configured default persona and profiles. */
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-root-'))
  writeFileSync(join(dir, 'config.yaml'), 'model:\n  default: gpt-5.6-terra\n  provider: openai-codex\n')
  writeFileSync(join(dir, 'profile.yaml'), 'description: winClaw\n')
  const profile = (name: string, config: string, description?: string): void => {
    mkdirSync(join(dir, 'profiles', name), { recursive: true })
    writeFileSync(join(dir, 'profiles', name, 'config.yaml'), config)
    if (description !== undefined) writeFileSync(join(dir, 'profiles', name, 'profile.yaml'), `description: ${description}\n`)
  }
  profile('qweno', 'model:\n  default: gpt-5.6-sol\n', '"\\u72EC\\u7ACB\\u7684 Telegram Bot,\\n  using Codex"')
  profile('minima', 'model: MiniMax-M3\n')
  profile('bare', 'fallback_providers: []\n')
  mkdirSync(join(dir, 'profiles', 'no-config'))
  mkdirSync(join(dir, 'profiles', '.deleted'))
  return dir
}

test('hermes: the root is HERMES_HOME (a profile\'s root when it names one), else the platform\'s home', () => {
  assert.equal(hermesRoot({ HERMES_HOME: join('/h', 'profiles', 'minima') }, 'linux', '/u'), join('/h'))
  assert.equal(hermesRoot({ HERMES_HOME: '/srv/hermes' }, 'linux', '/u'), '/srv/hermes')
  assert.equal(hermesRoot({}, 'linux', '/u'), join('/u', '.hermes'))
  assert.equal(hermesRoot({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\u'), join('C:\\L', 'hermes'))
})

test('hermes: the ACP server is in the installer\'s bin, else ~/.local/bin, else on PATH', () => {
  const exe = process.platform === 'win32' ? 'hermes-acp.exe' : 'hermes-acp'
  const found = (files: string[]) => findHermes({ PATH: '/p' }, (file) => files.includes(file), '/r', '/u')
  assert.equal(found([join('/r', 'bin', exe), join('/p', exe)]), join('/r', 'bin', exe))
  assert.equal(found([join('/u', '.local', 'bin', exe), join('/p', exe)]), join('/u', '.local', 'bin', exe))
  assert.equal(found([join('/p', exe)]), join('/p', exe))
  assert.equal(found([]), undefined)
})

test('hermes: personas are default and each configured profile, named with their model and described by their profile', () => {
  const dir = root()
  assert.deepEqual(listPersonas(dir), [
    { id: 'default', name: 'default · gpt-5.6-terra', description: 'winClaw' },
    { id: 'bare', name: 'bare' },
    { id: 'minima', name: 'minima · MiniMax-M3' },
    { id: 'qweno', name: 'qweno · gpt-5.6-sol', description: '独立的 Telegram Bot, using Codex' },
  ])
  assert.deepEqual(listPersonas(join(dir, 'missing')), [])
})

test('hermes: a persona runs pinned to its own home, default included; an unknown one has no process', async () => {
  const dir = root()
  const profile = hermesProfile(() => '/bin/hermes-acp', () => dir)
  assert.equal(profile.provider, HERMES_PROVIDER)
  assert.deepEqual((await profile.models!()).map((model) => model.id), ['default', 'bare', 'minima', 'qweno'])
  const qweno = profile.process('qweno')!
  assert.deepEqual([qweno.key, qweno.command, qweno.args, qweno.env.HERMES_HOME], ['qweno', '/bin/hermes-acp', [], personaHome(dir, 'qweno')])
  assert.equal(profile.process('default')!.env.HERMES_HOME, dir)
  assert.equal(profile.process('gone'), undefined)
  assert.equal(profile.process('../escape'), undefined)
  assert.equal(hermesProfile(() => undefined, () => dir).process('qweno'), undefined)
  assert.equal(profile.agentModel!('qweno'), undefined, 'each persona keeps its own model')
})
