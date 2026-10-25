/**
 * CDP 截图工具：启动打包版 → 等就绪 → 截图 → 关闭
 * 用法：node scripts/shot.js <输出.png> [点击的导航标签文字]
 */
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

const exe = process.argv[3] || process.env.CS_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe')
const outPng = process.argv[2] || 'shot.png'
const navLabel = process.argv[4] || ''
const PORT = 19222

function getWsUrl() {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            const page = JSON.parse(d).find((x) => x.type === 'page')
            page ? resolve(page.webSocketDebuggerUrl) : retry()
          } catch {
            retry()
          }
        })
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    let tries = 0
    const retry = () => {
      if (++tries > 20) return reject(new Error('CDP not reachable'))
      setTimeout(tryOnce, 500)
    }
    tryOnce()
  })
}

function rpc(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(wsUrl)
    const id = Math.floor(Math.random() * 1e6)
    w.onopen = () => w.send(JSON.stringify({ id, method, params }))
    w.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id === id) {
        w.close()
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    }
    w.onerror = reject
    setTimeout(() => reject(new Error('rpc timeout: ' + method)), 8000)
  })
}

;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_ENV
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })
  console.log('[shot] pid', child.pid)
  try {
    const wsUrl = await getWsUrl()
    await new Promise((r) => setTimeout(r, 2500)) // 等渲染稳定

    if (navLabel) {
      await rpc(wsUrl, 'Runtime.evaluate', {
        expression: `(()=>{const btns=[...document.querySelectorAll('.nav-item')];const b=btns.find(x=>x.textContent.includes('${navLabel}'));if(b)b.click();return !!b})()`
      })
      await new Promise((r) => setTimeout(r, 1200))
    }

    const cap = await rpc(wsUrl, 'Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(outPng, Buffer.from(cap.data, 'base64'))
    console.log('[shot] saved:', outPng)
  } catch (e) {
    console.error('[shot] FAIL:', e.message)
    process.exitCode = 1
  } finally {
    child.kill()
  }
})()
