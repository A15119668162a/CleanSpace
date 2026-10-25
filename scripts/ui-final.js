/**
 * 完整 UI 验证：启动 → 透视页 → 触发 Downloads 扫描 → 等结果 → DOM 断言 + 截图
 * 基于 shot.js 的稳健模式（全链路超时保护）
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')

const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe')
const shotOut = path.join(__dirname, '..', 'build', 'shot-p1-final.png')
const PORT = 19350

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })

function getWs() {
  return new Promise((resolve, reject) => {
    let tries = 0
    const t = setInterval(() => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 800 }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => { try { const pg = JSON.parse(d).find((x) => x.type === 'page'); if (pg) { clearInterval(t); resolve(pg.webSocketDebuggerUrl) } } catch { } })
      }).on('error', () => { })
    }, 500)
    if (++tries > 24) { clearInterval(t); reject(new Error('cdp timeout')) }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let rpcId = 0

;(async () => {
  const wsUrl = await getWs()
  await sleep(2500)
  const w = new WebSocket(wsUrl)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = () => rej(new Error('ws fail')); setTimeout(() => rej(new Error('ws open timeout')), 8000) })

  const send = (expr, ms = 20000) => new Promise((resolve, reject) => {
    const id = ++rpcId
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === id) { w.removeEventListener('message', on); resolve(x.result.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); reject(new Error('rpc timeout')) }, ms)
  })

  // 1) 切透视
  await send('(()=>{const b=[...document.querySelectorAll(".nav-item")].find(x=>x.textContent.includes("透视"));if(b)b.click();return 1})()')
  // 等 disks 加载（打包版 PowerShell 首次调用可能 10s+）
  for (let i = 0; i < 12; i++) {
    await sleep(2000)
    const n = await send('document.querySelectorAll(".disk").length', 8000)
    if (Number(n.value) > 0) break
  }
  console.log('[ui] 磁盘卡:', (await send('document.querySelectorAll(".disk").length', 8000)).value)
  // 3) 触发扫描（Downloads，有缓存秒回）
  await send('(()=>{const i=document.querySelector(".custom-row input");i.value="C:/Users/Administrator/Downloads";i.dispatchEvent(new Event("input"));document.querySelector(".custom-row .cs-btn.primary").click();return 1})()')
  // 4) 轮询结果（最多 120s）
  let summary = null
  for (let i = 0; i < 24; i++) {
    await sleep(5000)
    const r = await send('(()=>{const s=[...document.querySelectorAll(".s-num")].map(x=>x.textContent);return s.length?JSON.stringify(s):""})()', 10000)
    if (r.value) { summary = r.value; break }
  }
  if (!summary) throw new Error('结果未渲染')
  console.log('[ui] 汇总:', summary)
  // 5) DOM 断言 + 切 tab
  const dom = await send(`JSON.stringify({
    tabs: document.querySelectorAll('.tab').length,
    canvas: !!document.querySelector('.chart-host canvas'),
    rows: document.querySelectorAll('.tbl-row').length,
    types: document.querySelectorAll('.type-row').length,
    err: document.querySelector('.prog.err')?.textContent || ''
  })`, 10000)
  console.log('[ui] DOM:', dom.value)
  // 6) 切到 TOP50 tab 再回旭日图，等渲染稳定
  await send('document.querySelectorAll(".tab")[1].click()')
  await sleep(700)
  await send('document.querySelectorAll(".tab")[0].click()')
  await sleep(900)
  // 7) 截图
  const capId = ++rpcId
  const shot = await new Promise((resolve, reject) => {
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === capId) { w.removeEventListener('message', on); resolve(x.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id: capId, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    setTimeout(() => { w.removeEventListener('message', on); reject(new Error('shot timeout')) }, 15000)
  })
  fs.mkdirSync(path.dirname(shotOut), { recursive: true })
  fs.writeFileSync(shotOut, Buffer.from(shot.data, 'base64'))
  console.log('[ui] 截图:', shotOut)

  const d = JSON.parse(dom.value)
  const ok = d.tabs === 4 && d.canvas && !d.err
  console.log('[ui] 判定:', ok ? 'PASS' : 'FAIL')
  child.kill()
  process.exit(ok ? 0 : 1)
})().catch((e) => {
  console.error('[ui] FAIL:', e.message)
  child.kill()
  process.exit(1)
})
