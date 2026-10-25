/** Electron 环境下诊断 junk 扫描为何 files=0 */
const { exec } = require('child_process')

const port = 19400
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const { spawn } = require('child_process')
const p = spawn(require('path').join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${port}`], { stdio: 'ignore', env, cwd: require('path').join(__dirname, '..') })

const getWs = () => new Promise((res, rej) => {
  const t = setInterval(() => {
    const q = require('http').get({ host: '127.0.0.1', port, path: '/json/list', timeout: 800 }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { const pg = JSON.parse(d).find((x) => x.type === 'page'); if (pg) { clearInterval(t); res(pg.webSocketDebuggerUrl) } } catch { } })
    })
    q.on('error', () => { })
  }, 400)
  setTimeout(() => { clearInterval(t); rej(new Error('cdp timeout')) }, 20000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const w = new WebSocket(await getWs())
  await sleep(2000)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej })
  let id = 0
  const send = (expr, ms = 30000) => new Promise((resolve) => {
    const i = ++id
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === i) { w.removeEventListener('message', on); resolve(x.result.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); resolve({ value: 'TIMEOUT' }) }, ms)
  })

  // dev 版有 CS_DIAG 通道吗？直接用 window.cs.junkScan
  const r = await send(`window.cs.junkScan().then(r => JSON.stringify({groups: r.groups.map(g => [g.ruleId, g.files.length, g.note||'']), total: r.totalFiles}))`)
  console.log('[diag] junkScan:', r.value)

  // 手动走一遍 walkFiles 逻辑（渲染进程无 fs，改从 preload？不行。用主进程日志）
  // 检查各目标 existsSync —— 通过 junk:scan 的 note
  p.kill()
  process.exit(0)
})().catch((e) => { console.error('FAIL', e.message); p.kill(); process.exit(1) })
