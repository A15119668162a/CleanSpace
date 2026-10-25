/**
 * UI 全流程 E2E：启动 → 切透视页 → 点磁盘卡 → 等结果渲染 → DOM 断言 + 截图
 * 用法：E2E_DISK="C" node scripts/e2e-ui.js
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')

const exe = process.env.E2E_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe')
const disk = process.env.E2E_DISK || 'C'
const custom = process.env.E2E_CUSTOM || ''
const shot = process.env.E2E_SHOT || path.join(__dirname, '..', 'build', 'shot-e2e-insight.png')
const PORT = Number(process.env.E2E_PORT || 19290)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })

function getWs() {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 800 }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            const pg = JSON.parse(d).find((x) => x.type === 'page')
            if (pg) { clearInterval(t); resolve(pg.webSocketDebuggerUrl) }
          } catch { /* */ }
        })
      }).on('error', () => {})
    }, 400)
    setTimeout(() => { clearInterval(t); reject(new Error('cdp timeout')) }, 15000)
  })
}

let rpcId = 0
function rpc(w, expr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const mid = ++rpcId
    const on = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (m.id === mid) { w.removeEventListener('message', on); resolve(m.result.result) }
      } catch { /* */ }
    }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); reject(new Error('rpc timeout')) }, timeoutMs)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const ws = await getWs()
  await sleep(2500)
  const w = new WebSocket(ws)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = () => rej(new Error('ws fail')) })

  // 切透视页
  await rpc(w, `(()=>{const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('透视'));if(b)b.click();return !!b})()`)
  await sleep(1000)

  // 触发扫描：自定义路径 或 点磁盘卡
  if (custom) {
    await rpc(w, `(()=>{const i=document.querySelector('.custom-row input');i.value='${custom}';i.dispatchEvent(new Event('input'));document.querySelector('.custom-row .cs-btn.primary').click();return 'started'})()`)
  } else {
    await rpc(w, `(()=>{const cards=[...document.querySelectorAll('.disk')];const c=cards.find(x=>x.textContent.includes('${disk}:'));if(c){c.click();return 'clicked'}return 'no-card'})()`)
  }

  // 轮询等待结果区出现（最多 10 分钟）
  let done = null
  for (let i = 0; i < 120; i++) {
    await sleep(5000)
    const r = await rpc(w, `(()=>{const s=[...document.querySelectorAll('.s-num')].map(x=>x.textContent);return s.length?JSON.stringify(s):''})()`, 10000)
    if (r.value) { done = JSON.parse(r.value); break }
  }
  if (!done) throw new Error('扫描超时未渲染结果')
  console.log('[e2e-ui] 汇总卡:', done.join(' | '))

  // DOM 断言
  const dom = await rpc(w, `JSON.stringify({
    tabs: document.querySelectorAll('.tab').length,
    chartCanvas: !!document.querySelector('.chart-host canvas'),
    crumb: document.querySelector('.crumb')?.textContent || '',
    topRows: document.querySelectorAll('.tbl-row').length,
    typeRows: document.querySelectorAll('.type-row').length,
    err: document.querySelector('.prog.err')?.textContent || ''
  })`)
  console.log('[e2e-ui] DOM:', dom.value)
  const d = JSON.parse(dom.value)

  // 切换各 tab 截图
  await rpc(w, `document.querySelectorAll('.tab')[1].click()`)
  await sleep(800)
  await rpc(w, `document.querySelectorAll('.tab')[0].click()`)
  await sleep(800)

  // 截图（旭日图）
  const cap = await rpc(w, `new Promise(res=>{if(window.__canvasReady!==undefined)res(1);else res(2)})`).catch(() => null)
  void cap
  const shotExpr = 'null' // 截图走 Page.captureScreenshot
  void shotExpr

  const ok = d.tabs === 4 && d.chartCanvas && !d.err
  console.log('[e2e-ui] 判定:', ok ? 'PASS' : 'FAIL')

  // 截图
  const mid = ++rpcId
  const shotResult = await new Promise((resolve, reject) => {
    const on = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (m.id === mid) { w.removeEventListener('message', on); resolve(m.result) }
      } catch { /* */ }
    }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id: mid, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    setTimeout(() => { w.removeEventListener('message', on); reject(new Error('shot timeout')) }, 15000)
  })
  fs.mkdirSync(path.dirname(shot), { recursive: true })
  fs.writeFileSync(shot, Buffer.from(shotResult.data, 'base64'))
  console.log('[e2e-ui] 截图:', shot)

  child.kill()
  process.exit(ok ? 0 : 1)
})().catch((e) => {
  console.error('[e2e-ui] FAIL:', e.message)
  child.kill()
  process.exit(1)
})
