// Optional offline Chromium smoke test; no host writes, credentials, models or external network.
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const executable = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const dir = await mkdtemp(join(tmpdir(), 'agent-hub-review-browser-'))
const profile = join(dir, 'profile')
const output = await build({ entryPoints: ['test/fixtures/review-schedule-ui.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, define: { 'process.env.NODE_ENV': '"production"' } })
const html = join(dir, 'fixture.html')
await writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review automation fixture</title><style>html{color-scheme:light dark}body{margin:16px;font:14px system-ui;background:Canvas;color:CanvasText}#root{max-width:900px;margin:auto}</style></head><body><div id="root"></div><script>${output.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`)
const chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
let exited = false
chrome.once('exit', () => { exited = true })
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderr}`)), 15_000)
    chrome.once('error', (error) => { clearTimeout(timer); reject(error) })
    chrome.stderr.on('data', (data) => {
      stderr += data.toString()
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const pending = new Map()
  const exceptions = []
  socket.addEventListener('message', (event) => {
    const item = JSON.parse(event.data)
    if (item.method === 'Runtime.exceptionThrown') exceptions.push(item.params.exceptionDetails)
    const waiter = pending.get(item.id)
    if (waiter) { pending.delete(item.id); clearTimeout(waiter.timer); item.error ? waiter.reject(new Error(JSON.stringify(item.error))) : waiter.resolve(item.result) }
  })
  function call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
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
  const until = (expression) => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${expression})resolve(true);else if(Date.now()-start>3000)reject(new Error('Condition timed out'));else requestAnimationFrame(check)};check()})`)
  for (const width of [375, 1280]) for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 375 })
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }] })
    await cdp('Page.navigate', { url: pathToFileURL(html).href })
    await until(`document.querySelector('[role="switch"]:not(:disabled)')`)
    assert.equal(await evaluate('window.fixture.calls.includes("enable")'), false)
    await evaluate(`document.querySelector('[role="switch"]').focus()`)
    assert.equal(await evaluate(`document.activeElement.getAttribute('role')`), 'switch')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await until(`document.querySelector('.ac-review-confirm')`)
    assert.equal(await evaluate('window.fixture.calls.includes("enable")'), false)
    assert.equal(await evaluate(`document.activeElement.textContent`), '取消')
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('.ac-review-confirm')`)
    assert.equal(await evaluate(`document.activeElement.getAttribute('role')`), 'switch')
    await evaluate(`document.querySelector('[role="switch"]').click()`)
    await until(`document.querySelector('.ac-review-confirm')`)
    await evaluate(`document.querySelector('.ac-review-confirm [data-variant="primary"]').click()`)
    await until(`document.querySelector('[role="switch"][aria-checked="true"]:not(:disabled)')`)
    assert.equal(await evaluate(`window.fixture.calls.filter(action=>action==='enable').length`), 1)
    assert.equal(await evaluate(`document.querySelector('.ac-review-task-summary').open`), false)
    assert.equal(await evaluate(`document.querySelectorAll('input,textarea,select').length`), 0)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'No horizontal overflow while summary is collapsed')
    await evaluate(`document.querySelector('.ac-review-task-summary summary').click()`)
    assert.ok(await evaluate(`document.querySelector('.ac-review-task-summary').open`))
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Long report wraps without horizontal overflow')
    await evaluate(`document.querySelector('.ac-review-task-summary summary').click()`)
    if (width === 375) {
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('.ac-review-schedule-actions .ah-btn')).every(button=>button.getBoundingClientRect().height>=44)`))
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('.ac-review-schedule .ac-label,.ac-review-schedule .ac-hint,.ac-review-schedule dd,.ac-review-schedule details summary,.ac-review-schedule details pre,.ac-review-schedule .ah-btn')).every(node=>{const style=getComputedStyle(node);return parseFloat(style.fontSize)>=16&&parseFloat(style.lineHeight)>=parseFloat(style.fontSize)*1.5})`), 'Mobile review text is at least 16px with 1.5 line height')
    }
    await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='管理任务').click()`)
    assert.deepEqual(await evaluate('window.fixture.opened'), [['native-session', 'native-task']])
    await evaluate(`document.querySelector('[role="switch"]').click()`)
    await until(`document.querySelector('[role="switch"][aria-checked="false"]:not(:disabled)')`)
    await evaluate(`window.fixture.fail(true);window.fixture.refresh()`)
    await until(`document.querySelector('[role="alert"]')`)
    assert.equal(await evaluate(`document.querySelector('[role="switch"]').disabled`), true)
    await evaluate(`window.fixture.fail(false);Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='刷新状态').click()`)
    await until(`!document.querySelector('[role="alert"]') && !document.querySelector('[role="switch"]').disabled`)
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' })
    const image = join(dir, `${width}-${theme}.png`)
    await writeFile(image, Buffer.from(screenshot.data, 'base64'))
    console.log(`${width}px ${theme}: passed; ${image}`)
  }
  assert.deepEqual(exceptions, [])
  await call('Browser.close')
  console.log('Review automation browser smoke passed without real model or host calls.')
} finally {
  socket?.close()
  if (!exited && chrome.pid) {
    await new Promise((done) => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32') {
          const kill = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
          kill.once('exit', done)
        } else { chrome.kill('SIGKILL'); done() }
      }, 2000)
      chrome.once('exit', () => { clearTimeout(timer); done() })
    })
  }
  // Only the dedicated Chromium profile is removed; HTML/screenshots remain for inspection.
  assert.equal(resolve(profile), resolve(dir, 'profile'))
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'agent-hub-review-browser-')))
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
