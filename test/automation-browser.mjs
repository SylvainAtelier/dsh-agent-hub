// Offline Chromium smoke: no credentials, server, real model or script execution.
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const executable = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const dir = await mkdtemp(join(tmpdir(), 'agent-hub-automation-browser-'))
const profile = join(dir, 'profile')
const output = await build({ entryPoints: ['test/fixtures/automation-ui.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, define: { 'process.env.NODE_ENV': '"production"' } })
const html = join(dir, 'fixture.html')
await writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline automation fixture</title><style>html{color-scheme:light dark}body{margin:16px;font:14px system-ui;background:Canvas;color:CanvasText}#root{max-width:900px;margin:auto}</style></head><body><div id="root"></div><script>${output.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`)
const chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
let exited = false
chrome.once('exit', () => { exited = true })
try {
  const endpoint = await new Promise((done, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderr}`)), 15000)
    chrome.once('error', (error) => { clearTimeout(timer); reject(error) })
    chrome.stderr.on('data', (data) => {
      stderr += data.toString()
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timer); done(match[1]) }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  socket.addEventListener('message', (event) => {
    const item = JSON.parse(event.data)
    if (item.method === 'Runtime.exceptionThrown') exceptions.push(item.params.exceptionDetails)
    const waiter = pending.get(item.id)
    if (waiter) { pending.delete(item.id); clearTimeout(waiter.timer); item.error ? waiter.reject(new Error(JSON.stringify(item.error))) : waiter.done(item.result) }
  })
  const call = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
    pending.set(id, { done, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => call(method, params, sessionId)
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = (expression) => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${expression})resolve(true);else if(Date.now()-start>4000)reject(new Error('Condition timed out: '+${JSON.stringify(expression)}));else requestAnimationFrame(check)};check()})`)
  const click = (label) => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`)
  const writes = () => evaluate(`window.fixture.calls.filter(call=>!['list','preset'].includes(call.action))`)
  for (const [width, theme] of [[375, 'dark'], [1280, 'light']]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 375 })
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }] })
    await cdp('Page.navigate', { url: pathToFileURL(html).href })
    await until(`window.fixture && Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='填入 Qoder 中国版检查预设'&&!button.disabled)`)
    assert.deepEqual(await writes(), [])
    await click('填入 Qoder 中国版检查预设')
    await until(`document.querySelector('form')`)
    assert.deepEqual(await writes(), [])
    assert.equal(await evaluate(`document.querySelectorAll('select optgroup[label="External agent"]').length`), 0)
    await evaluate(`const select=document.querySelector('select');select.value=JSON.stringify(['bots','helper']);select.dispatchEvent(new Event('change',{bubbles:true}))`)
    assert.deepEqual(await writes(), [])
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Draft fits viewport')
    await click('保存配置（不运行）')
    await until(`!document.querySelector('form')&&document.querySelector('article')`)
    assert.deepEqual((await writes()).map((call) => call.action), ['upsert'])
    await click('启用每日调度')
    await until(`document.querySelector('.ac-review-confirm')`)
    assert.equal(await evaluate(`document.activeElement.textContent`), '取消')
    await click('取消')
    await until(`!document.querySelector('.ac-review-confirm')`)
    assert.deepEqual((await writes()).map((call) => call.action), ['upsert'])
    await click('启用每日调度')
    await until(`document.querySelector('.ac-review-confirm')`)
    await click('了解风险，启用每日调度')
    await until(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='停用'&&!button.disabled)`)
    await click('打开原生任务管理')
    assert.deepEqual(await evaluate('window.fixture.opened'), [['native-session', 'native-task']])
    await click('停用')
    await until(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='启用每日调度'&&!button.disabled)`)
    await click('启用每日调度')
    await until(`document.querySelector('.ac-review-confirm')`)
    const before = await evaluate(`document.querySelector('.ac-automation-preview').textContent`)
    await evaluate('window.fixture.changeDefinition()')
    assert.equal(await evaluate(`document.querySelector('.ac-automation-preview').textContent`), before)
    assert.equal(before.includes('unexpected.exe'), false)
    await click('了解风险，启用每日调度')
    await until(`document.querySelector('[role="alert"]')`)
    const lastEnable = await evaluate(`window.fixture.calls.filter(call=>call.action==='enable').at(-1)`)
    assert.equal(lastEnable.expected.command, 'C:\\tools\\offline-check.exe')
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Confirmation and error fit viewport')
    if (width === 375) assert.ok(await evaluate(`Array.from(document.querySelectorAll('.ac-automation button')).every(button=>button.getBoundingClientRect().height>=44)`), 'Mobile controls reach 44px')
    await writeFile(join(dir, `${width}-${theme}.png`), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    console.log(`${width}px ${theme}: passed; ${join(dir, `${width}-${theme}.png`)}`)
  }
  assert.deepEqual(exceptions, [])
  await call('Browser.close')
  console.log('Offline automation browser smoke passed; no real scripts or host calls.')
} finally {
  socket?.close()
  if (!exited && chrome.pid) {
    await new Promise((done) => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32') {
          const kill = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
          kill.once('exit', done)
        } else { chrome.kill('SIGKILL'); done() }
      }, 1000)
      chrome.once('exit', () => { clearTimeout(timer); done() })
    })
  }
  assert.equal(resolve(profile), resolve(dir, 'profile'))
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'agent-hub-automation-browser-')))
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  console.log(`Dedicated Chrome ${chrome.pid} exited; temporary profile removed.`)
}
