// Optional offline Chrome smoke test. No server, profile, model credentials, or new dependencies.
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const executable = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const dir = await mkdtemp(join(tmpdir(), 'agent-hub-discussion-browser-'))
const profile = join(dir, 'profile')
const bundle = await build({ entryPoints: ['test/fixtures/discussion-ui.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, define: { 'process.env.NODE_ENV': '"production"' } })
const html = join(dir, 'fixture.html')
await writeFile(html, `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discussion browser fixture</title><style>html{color-scheme:light dark}body{font:16px system-ui;background:Canvas;color:CanvasText}button{font:inherit}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`)
const chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
let socket
let stderr = ''
let exited = false
chrome.once('exit', () => { exited = true })
try {
  const endpoint = await new Promise((resolve, reject) => {
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
  const errors = []
  socket.addEventListener('message', (event) => {
    const item = JSON.parse(event.data)
    if (item.method === 'Runtime.exceptionThrown') errors.push(item.params.exceptionDetails)
    if (pending.has(item.id)) { const waiter = pending.get(item.id); pending.delete(item.id); clearTimeout(waiter.timer); item.error ? waiter.reject(new Error(JSON.stringify(item.error))) : waiter.resolve(item.result) }
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
  const waitFor = (selector) => evaluate(`new Promise((resolve,reject)=>{const ready=()=>document.querySelector(${JSON.stringify(selector)});if(ready()){resolve(true);return}const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(timer);resolve(true)}});observer.observe(document,{childList:true,subtree:true});const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Missing ${selector}'))},3000)})`)
  for (const mobile of [false, true]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: mobile ? 375 : 1280, height: mobile ? 812 : 900, deviceScaleFactor: 1, mobile })
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: mobile ? 'dark' : 'light' }] })
    await cdp('Page.navigate', { url: pathToFileURL(html).href })
    await waitFor('#quote')
    await evaluate('window.ready')
    await evaluate(`(()=>{const node=document.querySelector('#quote').firstChild;const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'))})()`)
    await waitFor('.sd-trigger')
    await evaluate(`document.querySelector('.sd-trigger').click()`)
    await waitFor('.sd-panel textarea')
    assert.equal(await evaluate(`document.querySelector('.sd-panel').getAttribute('aria-modal')`), mobile ? 'true' : null)
    assert.equal(await evaluate('window.fixture.calls.includes("ask")'), false)
    await evaluate(`document.querySelector('#sd-question').focus()`)
    await cdp('Input.insertText', { text: 'Explain this selection' })
    await evaluate(`document.querySelector('#sd-question').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`)
    assert.equal(await evaluate('window.fixture.calls.includes("ask")'), false, 'IME confirmation must not send a question')
    await evaluate(`document.querySelector('.sd-primary').click()`)
    await waitFor('.sd-panel textarea[readonly]')
    assert.equal(await evaluate(`document.querySelector('.sd-history select')?.disabled`), true, 'Thread cannot change while an admission response is pending')
    await waitFor('.sd-stage button:not(:disabled)')
    assert.equal(await evaluate('window.fixture.state.threads[0].quote'), 'This is the selected conversation text.')
    assert.equal(await evaluate(`document.querySelectorAll('.sd-answer img').length`), 0)
    await evaluate(`document.querySelector('.sd-stage button').click()`)
    await waitFor('.sd-add')
    assert.match(await evaluate('window.fixture.draft'), /\[\[discussion:session:/)
    assert.equal(await evaluate('window.fixture.mainSends'), 0)
    assert.equal(await evaluate('window.fixture.state.threads[0].confirmed'), 1)
    const stagedDraft = await evaluate('window.fixture.draft')
    await evaluate(`document.querySelector('#sd-question').focus()`)
    await cdp('Input.insertText', { text: 'A follow-up that is not yet confirmed' })
    await evaluate(`document.querySelector('.sd-primary').click()`)
    await waitFor('.sd-round:nth-of-type(2) .sd-answer:not(.sd-stream)')
    await waitFor('.sd-stage button:not(:disabled)')
    assert.equal(await evaluate('window.fixture.state.threads[0].confirmed'), 1, 'Follow-up does not implicitly expand confirmation')
    assert.equal(await evaluate('window.fixture.draft'), stagedDraft)
    await evaluate(`document.querySelector('.sd-stage button').click()`)
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert.equal(await evaluate('window.fixture.state.threads[0].confirmed'), 2)
    assert.equal((await evaluate('window.fixture.draft')).match(/\[\[discussion:/g)?.length, 1, 'Updating replaces the old reference instead of duplicating it')
    assert.match(await evaluate('window.fixture.draft'), /:2\]\]/)
    const dimensions = await evaluate(`(()=>{const panel=document.querySelector('.sd-panel').getBoundingClientRect();return {left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom,width:innerWidth,height:innerHeight}})()`)
    assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.width + 1 && dimensions.top >= 0 && dimensions.bottom <= dimensions.height + 1, JSON.stringify(dimensions))
    if (mobile) {
      assert.equal(await evaluate(`document.querySelector('#root').inert`), true)
      assert.ok(await evaluate(`document.querySelector('.sd-primary').getBoundingClientRect().height >= 44`))
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#sd-question')).fontSize`), '16px')
      await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 430, screenHeight: 812, deviceScaleFactor: 1, mobile: true })
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const bottom = await evaluate(`document.querySelector('.sd-panel').getBoundingClientRect().bottom`)
      assert.ok(bottom <= 431, `Keyboard viewport bottom: ${bottom}`)
      assert.ok(await evaluate(`(()=>{const input=document.querySelector('#sd-question').getBoundingClientRect();const send=document.querySelector('.sd-primary').getBoundingClientRect();return input.top>=0&&send.bottom<=430&&input.bottom<=430})()`), 'Input and send remain visible above the keyboard')
    }
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' })
    const image = join(dir, mobile ? 'mobile.png' : 'desktop.png')
    await writeFile(image, Buffer.from(screenshot.data, 'base64'))
    console.log(`${mobile ? 'Mobile' : 'Desktop'} smoke passed: ${image}`)
    await evaluate(`document.querySelector('#sd-question').focus()`)
    await cdp('Input.insertText', { text: 'Unsent draft survives collapse' })
    await evaluate(`document.querySelector('.sd-icon').click()`)
    assert.equal(await evaluate(`document.querySelector('.sd-panel') === null`), true)
    if (mobile) assert.equal(await evaluate(`document.querySelector('#root').inert`), false)
    await evaluate(`Array.from(document.querySelectorAll('.sd-dock button')).find(button=>button.textContent.startsWith('临时讨论')).click()`)
    await waitFor('.sd-panel textarea')
    assert.equal(await evaluate(`document.querySelector('#sd-question').value`), 'Unsent draft survives collapse')
    if (!mobile) {
      // Non-modal: Escape pressed in another focused control (a menu, the editor) is that control's, not the panel's.
      await evaluate(`(()=>{const main=document.querySelector('#main-composer');main.focus();main.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()`)
      assert.equal(await evaluate(`document.querySelector('.sd-panel') !== null`), true, 'Escape outside the desktop panel leaves it open')
    }
    await evaluate(`document.querySelector('.sd-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    assert.equal(await evaluate(`document.querySelector('.sd-panel') === null`), true)
  }
  assert.deepEqual(errors, [], 'No uncaught browser errors')
  await call('Browser.close').catch(() => {})
  console.log('Browser checks passed without network/model calls.')
} finally {
  socket?.close()
  if (!exited && chrome.pid) {
    try { process.kill(-chrome.pid, 'SIGTERM') } catch { /* Browser already exited. */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { /* Already gone. */ } resolve() }, 3000)
      chrome.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  assert.equal(dirname(profile), dir)
  assert.ok(dir.startsWith(join(tmpdir(), 'agent-hub-discussion-browser-')))
  await rm(profile, { recursive: true, force: true })
}
