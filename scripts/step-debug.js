/**
 * 分步 UI 排查：启动 → 点导航 → 输入路径扫描 → 检查 DOM
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const p = spawn(path.join('dist', 'win-unpacked', '净澈 CleanSpace.exe'), ['--remote-debugging-port=19344'], { stdio: 'ignore', env })

const getWs = () => new Promise((res, rej) => {
  const t = setInterval(() => {
    http.get({ host: '127.0.0.1', port: 19344, path: '/json/list', timeout: 800 }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { const pg = JSON.parse(d).find((x) => x.type === 'page'); if (pg) { clearInterval(t); res(pg.webSocketDebuggerUrl) } } catch { } })
    }).on('error', () => { })
  }, 400)
  setTimeout(() => { clearInterval(t); rej(new Error('cdp timeout')) }, 12000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const w = new WebSocket(await getWs())
  await sleep(2000)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej })
  let rpcId = 0
  const send = (expr, ms = 15000) => new Promise((resolve) => {
    const id = ++rpcId
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === id) { w.removeEventListener('message', on); resolve(x.result.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); resolve({ value: 'RPC_TIMEOUT' }) }, ms)
  })

  console.log('nav:', (await send('(()=>{const b=[...document.querySelectorAll(".nav-item")].find(x=>x.textContent.includes("透视"));if(b)b.click();return !!b})()')).value)
  await sleep(1000)
  console.log('input:', (await send('(()=>{const i=document.querySelector(".custom-row input");if(!i)return "no-input";i.value="C:/Users/Administrator/Downloads";i.dispatchEvent(new Event("input"));const btn=document.querySelector(".custom-row .cs-btn.primary");btn.click();return "clicked"})()')).value)
  await sleep(5000)
  console.log('汇总卡:', (await send('(()=>{const s=[...document.querySelectorAll(".s-num")].map(x=>x.textContent);return s.length?JSON.stringify(s):"no-result"})()', 10000)).value)
  console.log('进度条:', (await send('document.querySelector(".prog")?.textContent.trim().slice(0,80)||"none"', 10000)).value)
  console.log('错误:', (await send('document.querySelector(".prog.err")?.textContent.trim().slice(0,120)||"none"', 10000)).value)
  p.kill()
  process.exit(0)
})().catch((e) => { console.error('FAIL', e.message); p.kill(); process.exit(1) })
