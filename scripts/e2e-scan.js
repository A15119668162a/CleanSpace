/**
 * E2E 实扫验证：启动打包版 → CDP 依次验证 桥 → 扫描 → 缓存 → 白名单
 * 用法：E2E_TARGET="C:/some/dir" node scripts/e2e-scan.js
 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe')
const target = (process.env.E2E_TARGET || 'C:/Users/Administrator/Downloads').replace(/\/+$/, '')
const PORT = Number(process.env.E2E_PORT || 19226)

function getWs() {
  return new Promise((resolve, reject) => {
    let tries = 0
    const t = setInterval(() => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1000 }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            const pg = JSON.parse(d).find((x) => x.type === 'page')
            if (pg) { clearInterval(t); resolve(pg.webSocketDebuggerUrl) }
          } catch { /* retry */ }
        })
      }).on('error', () => {})
    }, 500)
    if (++tries > 40) { clearInterval(t); reject(new Error('CDP timeout')) }
  })
}

function makeRpc(w) {
  let id = 0
  return (expr, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      const on = (e) => {
        try {
          const m = JSON.parse(e.data)
          if (m.id === mid) {
            w.removeEventListener('message', on)
            if (m.error) reject(new Error(JSON.stringify(m.error)))
            else resolve(m.result.result)
          }
        } catch { /* ignore */ }
      }
      w.addEventListener('message', on)
      w.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
      setTimeout(() => { w.removeEventListener('message', on); reject(new Error('eval timeout')) }, timeoutMs)
    })
}

;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_ENV
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })
  console.log('[e2e] pid', child.pid, '| target:', target)
  try {
    const wsUrl = await getWs()
    await new Promise((r) => setTimeout(r, 2000))
    const w = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      w.onopen = resolve
      w.onerror = () => reject(new Error('ws fail'))
      setTimeout(() => reject(new Error('ws open timeout')), 8000)
    })
    const rpc = makeRpc(w)

    // 1) 桥探针
    const probe = await rpc('!!window.cs && !!window.cs.scanStart', 8000)
    if (!probe.value) throw new Error('bridge unavailable')
    console.log('[e2e] bridge: OK')

    // 2) 首扫（force）
    const t0 = Date.now()
    const exprScan = `window.cs.scanStart(${JSON.stringify(target)}, true)` +
      `.then(r => JSON.stringify({size: r.root.size, files: r.stats.totalFiles, dirs: r.stats.totalDirs, top: r.topFiles.length, cached: r.cached, ms: r.stats.durationMs, types: Object.keys(r.stats.typeBytes).length}))` +
      `.catch(e => 'ERR:' + e.message)`
    const r1 = await rpc(exprScan, 300000)
    console.log('[e2e] 首扫:', r1.value, `| 墙钟 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    if (typeof r1.value === 'string' && r1.value.startsWith('ERR')) throw new Error(r1.value)
    const a = JSON.parse(r1.value)

    // 3) 二扫（缓存）
    const t1 = Date.now()
    const exprCache = `window.cs.scanStart(${JSON.stringify(target)}, false)` +
      `.then(r => JSON.stringify({size: r.root.size, files: r.stats.totalFiles, cached: r.cached}))` +
      `.catch(e => 'ERR:' + e.message)`
    const r2 = await rpc(exprCache, 60000)
    console.log('[e2e] 二扫:', r2.value, `| 墙钟 ${((Date.now() - t1) / 1000).toFixed(2)}s`)
    const b = JSON.parse(r2.value)

    // 4) 白名单判定
    const r3 = await rpc(`window.cs.whitelistCheck(['C:\\\\Windows\\\\notepad.exe','${target.replace(/'/g, "\\'")}/x.tmp']).then(f => JSON.stringify(f))`, 15000)
    console.log('[e2e] 白名单:', r3.value)
    const prot = JSON.parse(r3.value)

    const okScan = a.size > 0 && a.files > 0 && a.top > 0 && a.cached === false && a.types >= 3
    const okCache = b.cached === true && b.size === a.size && b.files === a.files
    const okProt = prot[0] === true && prot[1] === false
    console.log(`[e2e] 结果: 首扫=${okScan ? 'PASS' : 'FAIL'} 缓存=${okCache ? 'PASS' : 'FAIL'} 白名单=${okProt ? 'PASS' : 'FAIL'}`)
    process.exit(okScan && okCache && okProt ? 0 : 1)
  } catch (e) {
    console.error('[e2e] FAIL:', e.message)
    process.exit(1)
  } finally {
    child.kill()
  }
})()
