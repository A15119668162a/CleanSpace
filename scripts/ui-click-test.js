/** 模拟 UI 点击扫描并查进度/错误/汇总 */
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const p = spawn(path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe'), ['--remote-debugging-port=19366'], { stdio: 'ignore', env })

const getWs = () => new Promise((res, rej) => {
  const t = setInterval(() => {
    const q = http.get({ host: '127.0.0.1', port: 19366, path: '/json/list', timeout: 800 }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { const pg = JSON.parse(d).find((x) => x.type === 'page'); if (pg) { clearInterval(t); res(pg.webSocketDebuggerUrl) } } catch { } })
    })
    q.on('error', () => { })
    q.on('timeout', () => q.destroy())
  }, 400)
  setTimeout(() => { clearInterval(t); rej(new Error('cdp timeout')) }, 15000)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const w = new WebSocket(await getWs())
  await sleep(2500)
  await new Promise((res, rej) => { w.onopen = res; w.onerror = () => rej(new Error('ws fail')) })
  let rpcId = 0
  const send = (expr, ms = 60000) => new Promise((resolve) => {
    const id = ++rpcId
    const on = (e) => { const x = JSON.parse(e.data); if (x.id === id) { w.removeEventListener('message', on); resolve(x.result.result) } }
    w.addEventListener('message', on)
    w.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { w.removeEventListener('message', on); resolve({ value: 'RPC_TIMEOUT' }) }, ms)
  })

  await send('(()=>{const b=[...document.querySelectorAll(".nav-item")].find(x=>x.textContent.includes("透视"));if(b)b.click();return 1})()')
  await sleep(1200)
  const click = await send('(()=>{const i=document.querySelector(".custom-row input");if(!i)return "no-input";i.value="C:/Users/Administrator/Downloads";i.dispatchEvent(new Event("input"));const btn=document.querySelector(".custom-row .cs-btn.primary");if(!btn)return "no-btn";if(btn.disabled)return "disabled";btn.click();return "clicked"})()', 10000)
  console.log('点击:', click.value)
  for (let round = 0; round < 12; round++) {
    await sleep(3000)
    const prog = await send('(()=>{const p=document.querySelector(".prog");return p?p.textContent.trim().slice(0,100):"no-prog"})()', 8000)
    console.log(`[${round * 3}s] 进度:`, prog.value)
    const sum = await send('(()=>{const s=[...document.querySelectorAll(".s-num")].map(x=>x.textContent);return s.length?JSON.stringify(s):"no-result"})()', 8000)
    if (sum.value !== 'no-result') { console.log('汇总:', sum.value); break }
  }
  p.kill()
  process.exit(0)
})().catch((e) => { console.error('FAIL', e.message); p.kill(); process.exit(1) })
