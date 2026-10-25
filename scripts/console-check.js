/** 收集渲染进程 console / 异常 + disks 探测 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const p = spawn(path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe'), ['--remote-debugging-port=19354'], { stdio: 'ignore', env })

const getWs = () => new Promise((res, rej) => {
  let n = 0
  const t = setInterval(() => {
    http.get({ host: '127.0.0.1', port: 19354, path: '/json/list', timeout: 800 }, (r) => {
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
  w.addEventListener('message', (e) => {
    const x = JSON.parse(e.data)
    if (x.method === 'Runtime.consoleAPICalled' && (x.params.type === 'error' || x.params.type === 'warning')) {
      console.log('[console.' + x.params.type + ']', JSON.stringify((x.params.args || []).map((a) => a.value || a.description).join(' ')).slice(0, 250))
    }
    if (x.method === 'Runtime.exceptionThrown') console.log('[exception]', JSON.stringify(x.params.exceptionDetails.exception?.description || x.params.exceptionDetails.text).slice(0, 350))
  })
  w.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
  let rpcId = 10
  const send = (expr, ms = 20000) => new Promise((resolve) => {
    const id = ++rpcId
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === id) { w.removeEventListener('message', on); resolve(x.result.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); resolve({ value: 'RPC_TIMEOUT' }) }, ms)
  })

  const r = await send('window.cs.disks().then(d => "disks=" + d.length).catch(e => "ERR:" + e.message)')
  console.log('disks:', r.value)
  // 切透视页看磁盘卡
  await send('(()=>{const b=[...document.querySelectorAll(".nav-item")].find(x=>x.textContent.includes("透视"));if(b)b.click();return 1})()')
  await sleep(1500)
  const cards = await send('document.querySelectorAll(".disk").length')
  console.log('磁盘卡:', cards.value)
  const htmlLen = await send('document.querySelector(".page-body").innerHTML.length')
  console.log('透视HTML长度:', htmlLen.value)
  p.kill()
  process.exit(0)
})().catch((e) => { console.error('FAIL', e.message); p.kill(); process.exit(1) })
