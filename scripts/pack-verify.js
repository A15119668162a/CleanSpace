/** 打包版全链路单步：disks → 扫描(缓存) → DOM */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const p = spawn(path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe'), ['--remote-debugging-port=19360'], { stdio: ['ignore', 'pipe', 'pipe'], env })
let stderr = ''
p.stderr.on('data', (d) => (stderr += d))

const getWs = () => new Promise((res, rej) => {
  let n = 0
  const t = setInterval(() => {
    const req = http.get({ host: '127.0.0.1', port: 19360, path: '/json/list', timeout: 800 }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { const pg = JSON.parse(d).find((x) => x.type === 'page'); if (pg) { clearInterval(t); res(pg.webSocketDebuggerUrl) } } catch { } })
    })
    req.on('error', () => { })
    req.on('timeout', () => req.destroy())
  }, 500)
  setTimeout(() => { clearInterval(t); rej(new Error('cdp timeout')) }, 20000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const w = new WebSocket(await getWs())
  await sleep(2500)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = () => rej(new Error('ws fail')) })
  let rpcId = 0
  const send = (expr, ms = 30000) => new Promise((resolve, reject) => {
    const id = ++rpcId
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === id) { w.removeEventListener('message', on); resolve(x.result.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); reject(new Error('rpc timeout: ' + expr.slice(0, 40))) }, ms)
  })

  // 直接 IPC 层验证（绕过 UI 时序）
  const t0 = Date.now()
  const r1 = await send('window.cs.scanStart("C:/Users/Administrator/Downloads", false).then(r => "cached=" + r.cached + " files=" + r.stats.totalFiles).catch(e => "ERR:" + e.message)', 90000)
  console.log('打包版缓存扫描:', r1.value, ((Date.now() - t0) / 1000).toFixed(1) + 's')

  // UI 层
  await send('(()=>{const b=[...document.querySelectorAll(".nav-item")].find(x=>x.textContent.includes("透视"));if(b)b.click();return 1})()')
  await sleep(1500)
  const disksN = await send('document.querySelectorAll(".disk").length', 8000)
  console.log('磁盘卡(等1.5s):', disksN.value)
  await sleep(8000)
  const disksN2 = await send('document.querySelectorAll(".disk").length', 8000)
  console.log('磁盘卡(再等8s):', disksN2.value)
  p.kill()
  process.exit(0)
})().catch((e) => {
  console.error('FAIL:', e.message)
  console.error('stderr tail:', stderr.slice(-300))
  p.kill()
  process.exit(1)
})
