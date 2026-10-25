/**
 * 打包版深度诊断：IPC / worker 路径 / 扫描全链路
 * 用法：E2E_TARGET="C:/Program Files" node scripts/diag.js
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe')
const target = (process.env.E2E_TARGET || 'C:/Program Files').replace(/\/+$/, '')
const PORT = Number(process.env.E2E_PORT || 19240)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV

const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'], env })
let stderr = ''
child.stderr.on('data', (d) => (stderr += d))

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
          } catch { /* retry */ }
        })
      }).on('error', () => {})
    }, 400)
    setTimeout(() => { clearInterval(t); reject(new Error('cdp timeout')) }, 15000)
  })
}

let rpcId = 0
function rpc(w, expr, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const mid = ++rpcId
    const on = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (m.id === mid) {
          w.removeEventListener('message', on)
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result.result)
        }
      } catch { /* */ }
    }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); reject(new Error('timeout')) }, timeoutMs)
  })
}

;(async () => {
  const wsUrl = await getWs()
  await new Promise((r) => setTimeout(r, 1500))
  const w = new WebSocket(wsUrl)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = () => rej(new Error('ws fail')) })

  const tLog = (msg) => console.log('[diag]', msg)

  // 1) IPC 基础
  const db = await rpc(w, 'window.cs.dbStatus().then(s => "ok=" + s.ok + " tables=" + s.tables.length).catch(e => "ERR:" + e.message)', 10000)
  tLog('dbStatus: ' + db.value)

  // 2) 磁盘列表（PowerShell 链路）
  const disks = await rpc(w, 'window.cs.disks().then(d => d.length + " disks, first=" + (d[0] ? d[0].drive : "-")).catch(e => "ERR:" + e.message)', 30000)
  tLog('disks: ' + disks.value)

  // 3) 小目录扫描（worker 链路）
  const scanExpr = `window.cs.scanStart(${JSON.stringify(target)}, true)` +
    `.then(r => "OK files=" + r.stats.totalFiles + " size=" + r.root.size + " ms=" + r.stats.durationMs)` +
    `.catch(e => "ERR:" + e.message)`
  const scan = await rpc(w, scanExpr, 240000)
  tLog('scan(' + target + '): ' + scan.value)

  console.log('[diag] stderr tail:', stderr.slice(-400) || '(empty)')
  child.kill()
  process.exit(String(scan.value).startsWith('OK') ? 0 : 1)
})().catch((e) => {
  console.error('[diag] FAIL:', e.message)
  console.error('[diag] stderr:', stderr.slice(-800))
  child.kill()
  process.exit(1)
})
