/**
 * The `dsh` command: a small script run with the host's own runtime (like the
 * worktree hooks), launchers on PATH for the Qoder daemons' shells (Git Bash
 * on Windows runs the extensionless one; cmd and PowerShell the `.cmd`), and
 * the Qoder skill that tells the glasses' agent when and how to use it.
 *
 * The script finds DSH through `bridge.json` beside it (server.ts writes the
 * loopback address and this run's token there), so a daemon started before a
 * plugin reload still reaches the new bridge.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { localized } from '../locale.ts'

export const BRIDGE_FILE = 'bridge.json'
const SCRIPT_NAME = 'dsh.cjs'

/** What the command prints in its own words; written into the script in the UI language of the install. */
const CLI_TEXT = {
  zh: { phase: { running: '进行中', approval: '等待审批', done: '完成', failed: '失败', stopped: '已停止', idle: '空闲' }, session: '会话 ', fallback: '（默认）', defaultRoute: 'DSH 默认：', quiet: 'DSH 启动以来还没有会话活动' },
  en: { phase: { running: 'running', approval: 'awaiting approval', done: 'done', failed: 'failed', stopped: 'stopped', idle: 'idle' }, session: 'session ', fallback: ' (default)', defaultRoute: 'DSH default: ', quiet: 'No session activity since DSH started' },
}

/**
 * The command itself, run as `node dsh.cjs <command> …`. Plain CommonJS: no build step, no dependencies.
 * Its words follow the UI language when it is written (each daemon start).
 */
export function cliScript(): string {
  return `'use strict'
// Written by dsh-agent-hub (src/bridge/cli.ts): the \`dsh\` command, DSH from a shell.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const USAGE = [
  'dsh: DSH from a shell (the glasses\\' Qoder tasks use it)',
  '',
  '  dsh agents                          agents and models a task can go to',
  '  dsh projects                        DSH projects a task can go to',
  '  dsh ask [--agent A] [--model M] [--project P] [--no-wait] <task…>',
  '                                      a new DSH session; waits for its next stop',
  '  dsh reply [--session S] <text…>     tell a session more (by default the latest);',
  '                                      waits for its next stop',
  '  dsh approve [session]               answer the approval a session waits for;',
  '  dsh deny [session]                  waits for its next stop',
  '  dsh stop [session]                  stop a session\\'s turn',
  '  dsh wait [session]                  wait for a session\\'s next stop',
  '  dsh status [session]                recent sessions, or one',
  '  dsh notify <text…>                  tell the glasses (in their latest Qoder session)',
  '',
  'A session is its id or a part of it (a note\\'s last characters); left out, the one the glasses',
  'follow that fits. A stop: the turn ends, or it asks for approval.',
  'A task of "-" is read from stdin. Exit codes: 0 done, 2 choose (ambiguous or unknown name),',
  '3 the turn failed or stopped, 4 still running or waiting for approval, 1 other errors.',
].join('\\n')

const TEXT = ${JSON.stringify(localized(CLI_TEXT))}

function fail(message, code) {
  process.stderr.write(message + '\\n')
  process.exit(code)
}

function connection() {
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(BRIDGE_FILE)}), 'utf8'))
  } catch {
    fail('DSH is not running (no bridge.json): start DSH on this computer first', 1)
  }
  const url = new URL(process.env.DSH_BRIDGE_URL || saved.url)
  return { url, token: saved.token }
}

function call(method, route, body) {
  const { url, token } = connection()
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname, port: url.port, method, path: '/v1/' + route,
      headers: { authorization: 'Bearer ' + token, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, (response) => {
      response.setEncoding('utf8')
      let text = ''
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
      response.on('error', reject)
    })
    request.on('error', (error) => reject(error.code === 'ECONNREFUSED' ? new Error('DSH is not running: start DSH on this computer first') : error))
    if (payload) request.write(payload)
    request.end()
  })
}

async function rpc(route, body) {
  const { status, text } = await call('POST', route, { cwd: process.cwd(), ...body })
  let reply
  try { reply = JSON.parse(text) } catch { fail('DSH answered ' + status + ': ' + text.slice(0, 300), 1) }
  if (!reply.ok) fail(reply.error, reply.code === 'choose' ? 2 : 1)
  return reply.value
}

function report(entry, full) {
  const head = '[' + (TEXT.phase[entry.phase] || entry.phase) + '] ' + entry.title
  const meta = TEXT.session + entry.session + (entry.model ? ' · ' + entry.model : '') + (entry.cwd ? ' · ' + entry.cwd : '') + (entry.tool ? ' · ' + entry.tool : '')
  const text = entry.text ? (full ? '\\n\\n' + entry.text : '\\n  ' + entry.text) : ''
  return head + '\\n' + (full ? '' : '  ') + meta + text
}

const exitFor = (phase) => (phase === 'done' || phase === 'idle' ? 0 : phase === 'running' || phase === 'approval' ? 4 : 3)

function parse(args) {
  const flags = {}
  const rest = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const flag = /^--?(agent|model|project|session|a|m|p|s)$/.exec(arg)
    if (flag) flags[{ a: 'agent', m: 'model', p: 'project', s: 'session' }[flag[1]] || flag[1]] = args[++index]
    else if (arg === '--no-wait') flags.noWait = true
    else if (arg === '--') rest.push(...args.slice(index + 1)), index = args.length
    else rest.push(arg)
  }
  return { flags, text: rest.join(' ') }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'agents': {
      const value = await rpc('agents', {})
      const lines = value.groups.map((group) => {
        const fallback = value.fallback && value.fallback.provider === group.provider ? value.fallback.model : undefined
        const models = group.models.slice(0, 12).map((model) => model.id === fallback ? model.id + TEXT.fallback : model.id)
        return group.name + ' [' + group.provider + ']: ' + models.join(', ') + (group.models.length > 12 ? ' …' : '')
      })
      for (const bot of value.bots) lines.push('bot:' + bot.id + (bot.description ? ' — ' + bot.description : ''))
      if (value.fallback) lines.push(TEXT.defaultRoute + value.fallback.provider + ' / ' + value.fallback.model)
      process.stdout.write(lines.join('\\n') + '\\n')
      return
    }
    case 'projects': {
      const value = await rpc('projects', {})
      process.stdout.write(value.map((entry) => entry.title + '  ' + entry.path).join('\\n') + '\\n')
      return
    }
    case 'ask': {
      const { flags, text } = parse(args)
      const task = text === '-' ? fs.readFileSync(0, 'utf8') : text
      const value = await rpc('ask', { agent: flags.agent, model: flags.model, project: flags.project, text: task, wait: !flags.noWait })
      process.stdout.write(report(value, true) + '\\n')
      process.exit(exitFor(value.phase))
    }
    case 'reply': {
      const { flags, text } = parse(args)
      const value = await rpc('reply', { session: flags.session, text: text === '-' ? fs.readFileSync(0, 'utf8') : text })
      process.stdout.write(report(value, true) + '\\n')
      process.exit(exitFor(value.phase))
    }
    case 'approve': case 'deny': case 'stop': case 'wait': {
      const value = await rpc(command, { session: args[0] })
      process.stdout.write(report(value, true) + '\\n')
      process.exit(exitFor(value.phase))
    }
    case 'status': {
      const value = await rpc('status', { session: args[0] })
      process.stdout.write((value.length === 0 ? TEXT.quiet : value.map((entry) => report(entry, Boolean(args[0]))).join('\\n')) + '\\n')
      return
    }
    case 'notify': {
      const text = args.join(' ')
      await rpc('notify', { text: text === '-' ? fs.readFileSync(0, 'utf8') : text })
      return
    }
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(USAGE + '\\n')
      return
    default:
      fail('Unknown command: ' + command + '\\n\\n' + USAGE, 1)
  }
}

main().catch((error) => fail(String(error && error.message || error), 1))
`
}

/** The Qoder skill: when the glasses' agent reaches for \`dsh\`, and how (background runs; DSH's own messages). */
export const SKILL = `---
name: dsh
description: 把任务转交给这台电脑上 DSH 里的 Claude Code、Codex、Cursor、Hermes 或 Bot 并取回结果；接着给 DSH 会话补充要求、批准或拒绝它等待的操作、停止它；查看 DSH 会话进度；给眼镜发一条通知；收到"【DSH 通知】"开头的消息时转告用户。用户提到 Claude、Codex、Cursor、DSH、某个项目，说"让…去做/交给…"、"接着改…"、"批准/拒绝"、"停下"、"DSH 那边怎么样了"时使用。
---

# DSH 桥接（\`dsh\` 命令）

这台电脑的 shell 里有 \`dsh\` 命令（写入方：dsh-agent-hub）。眼镜屏幕很小：回复用一两句话，不贴长输出。

## 停顿点：所有要等的 dsh 命令都一样
\`dsh ask\`、\`dsh reply\`、\`dsh approve\`、\`dsh deny\`、\`dsh stop\`、\`dsh wait\` 都用 Bash 工具、**run_in_background: true** 运行。它们会在 DSH 会话的下一个停顿点结束：这一轮完成、失败、停止，或者在等审批。启动后马上回复一句话（如"已交给 Claude，完成后告诉你"）并结束这一轮，不要等待，也不要轮询；命令结束时你会被唤醒，读它的输出，用一两句话告诉用户。
- 退出码 0：完成。3：失败或已停止，说原因。2：名字或会话有歧义、不存在，输出里列了候选，问用户选哪个再重新运行。
- 退出码 4 且输出是"[等待审批]"：用一句话告诉用户它要做什么（输出里的工具），问用户批准还是拒绝，然后结束这一轮。
- 会话可以不写（默认是眼镜跟着的那个），也可以写会话 ID 或它的一部分（通知括号里的编号就是）。

## 转交新任务
1. 不确定时先看可选项：\`dsh agents\`（agent 与模型）、\`dsh projects\`（项目）。
2. \`dsh ask --agent claude --project <项目名> "<任务：用户原话，补全必要上下文>"\`
   - \`--agent\`：claude、codex、cursor、qoder、hermes 或 bot:<id>；不写就用 DSH 的默认模型。
   - \`--model\`：模型名或 id 的一部分（如 opus、gpt-5）；不写用这个 agent 的默认模型。
   - \`--project\`：项目名或绝对路径；不写就在当前目录。
- 每次 \`dsh ask\` 都开一个新的 DSH 会话；接着同一件事说，用 \`dsh reply\`。

## 接着说、审批、停止
- \`dsh reply [--session <会话>] "<补充的要求>"\`：发给已有的 DSH 会话，上下文都在。
- \`dsh approve [会话]\` / \`dsh deny [会话]\`：**只有用户亲口说了"批准/同意/可以"或"拒绝/不行"才运行，绝不自己替用户决定。**拿不准用户的意思就再问一句。
  - 失败并说只能在电脑上批准：如实转告，让用户到电脑上处理。
- \`dsh stop [会话]\`：用户说"停下/别做了"时运行。

## 查看进度
- \`dsh status\`：最近的 DSH 会话；\`dsh status <会话>\`：某一个的完整回答（不用后台运行）。
- \`dsh wait [会话]\`：等它的下一个停顿点。

## DSH 通知
- DSH 的通知（会话完成、等待审批等）会作为以"【DSH 通知】"开头的消息直接发进眼镜最近的会话：收到时用一两句话转告用户，不做别的操作，括号里的会话编号不用念。之后用户要批准、拒绝、接着说或问详情，就用上面的命令并带上那个编号。不需要、也不要去"开启通知"。
- \`dsh notify "<一句话>"\`：你也可以这样推一条消息给眼镜。
`

/** {@link SKILL} for an English UI. */
export const SKILL_EN = `---
name: dsh
description: Hand a task to Claude Code, Codex, Cursor, Hermes or a Bot in DSH on this computer and get the result back; tell a DSH session more, approve or deny what it waits for, stop it; check on DSH sessions; send the glasses a notice; relay messages starting with "[DSH notice]" to the user. Use when the user mentions Claude, Codex, Cursor, DSH or a project, or says "have … do it / hand it to …", "go on with …", "approve / deny", "stop", "how is DSH doing".
---

# DSH bridge (the \`dsh\` command)

The shell on this computer has a \`dsh\` command (written by dsh-agent-hub). The glasses' screen is small: answer in a sentence or two, never paste long output.

## Stops: the same for every dsh command that waits
Run \`dsh ask\`, \`dsh reply\`, \`dsh approve\`, \`dsh deny\`, \`dsh stop\` and \`dsh wait\` with the Bash tool and **run_in_background: true**. Each ends at the DSH session's next stop: the turn is done, failed or stopped, or it waits for approval. Right after starting one, answer in one sentence (e.g. "Handed to Claude, I'll tell you when it's done") and end your turn: do not wait or poll. You are woken when the command ends; read its output and tell the user in a sentence or two.
- Exit code 0: done. 3: failed or stopped, say why. 2: a name or session is ambiguous or unknown; the output lists the candidates: ask the user which one, then run it again.
- Exit code 4 with "[awaiting approval]" in the output: say in one sentence what it wants to do (the tool in the output), ask the user to approve or deny, then end your turn.
- The session can be left out (the one the glasses follow), or be a session id or part of it (the id in a notice's brackets).

## Hand over a new task
1. When unsure, look at the choices first: \`dsh agents\` (agents and models), \`dsh projects\` (projects).
2. \`dsh ask --agent claude --project <project name> "<the task: the user's words, with the context it needs>"\`
   - \`--agent\`: claude, codex, cursor, qoder, hermes or bot:<id>; left out, DSH's default model.
   - \`--model\`: part of a model name or id (e.g. opus, gpt-5); left out, the agent's default model.
   - \`--project\`: a project name or absolute path; left out, the current folder.
- Every \`dsh ask\` opens a new DSH session; to go on with the same thing, use \`dsh reply\`.

## Tell more, approve, stop
- \`dsh reply [--session <session>] "<what to add>"\`: goes to an existing DSH session, with all its context.
- \`dsh approve [session]\` / \`dsh deny [session]\`: **run only when the user said so themselves ("approve / yes / go ahead" or "deny / no"); never decide for the user.** If unsure what the user meant, ask again.
  - If it fails saying it can only be approved on the computer: say so, and have the user handle it there.
- \`dsh stop [session]\`: when the user says "stop / don't do it".

## Check progress
- \`dsh status\`: recent DSH sessions; \`dsh status <session>\`: one session's full answer (no need to run it in the background).
- \`dsh wait [session]\`: wait for its next stop.

## DSH notices
- DSH's notices (a session is done, waits for approval, …) arrive straight in the glasses' latest session as messages starting with "[DSH notice]": relay them to the user in a sentence or two and do nothing else; do not read out the session ids in brackets. If the user then wants to approve, deny, say more or hear details, use the commands above with that id. There is no need to "turn on notices", and do not try.
- \`dsh notify "<one sentence>"\`: you can push a message to the glasses this way too.
`

export interface InstallOptions {
  /** The runtime that runs the script: the host's own. */
  node: string
  /** \`$DSH_HOME/dsh-agent-hub\`: the script and \`bridge.json\` go here, the launchers in \`bin/\`. */
  dir: string
  /** Where Qoder CLI CN keeps user skills; the skill is written to \`<skills>/dsh/SKILL.md\`. */
  skills?: string
  platform?: NodeJS.Platform
}

const write = async (file: string, text: string, mode?: number): Promise<void> => {
  await mkdir(dirname(file), { recursive: true })
  if (await readFile(file, 'utf8').catch(() => '') !== text) await writeFile(file, text)
  if (mode !== undefined) await chmod(file, mode).catch(() => {})
}

/**
 * Write the script, its launchers and the Qoder skill (each only when it changed) and return the
 * folder to put on PATH. Idempotent; run before each daemon start (the host's runtime may have moved, the UI language changed).
 */
export async function installCli(options: InstallOptions): Promise<string> {
  const platform = options.platform ?? process.platform
  const script = join(options.dir, SCRIPT_NAME)
  const bin = join(options.dir, 'bin')
  await write(script, cliScript())
  const slash = (path: string): string => (platform === 'win32' ? path.replaceAll('\\', '/') : path)
  const quoted = (path: string): string => `"${path.replace(/(["\\$`])/g, '\\$1')}"`
  await write(join(bin, 'dsh'), `#!/bin/sh\n# Written by dsh-agent-hub: the dsh command (${SCRIPT_NAME}).\nELECTRON_RUN_AS_NODE=1 exec ${quoted(slash(options.node))} ${quoted(slash(script))} "$@"\n`, 0o755)
  if (platform === 'win32') await write(join(bin, 'dsh.cmd'), `@echo off\r\nrem Written by dsh-agent-hub: the dsh command (${SCRIPT_NAME}).\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${options.node}" "${script}" %*\r\n`)
  await write(join(options.skills ?? join(homedir(), '.qoder-cn', 'skills'), 'dsh', 'SKILL.md'), localized({ zh: SKILL, en: SKILL_EN }))
  return bin
}

/** `env`'s PATH with `bin` in front, under the spelling `env` already uses (Windows: often `Path`). */
export function withPath(bin: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[key] ?? ''
  const parts = current.split(delimiter)
  return { [key]: parts.includes(bin) ? current : [bin, ...parts.filter((part) => part !== '')].join(delimiter) }
}
