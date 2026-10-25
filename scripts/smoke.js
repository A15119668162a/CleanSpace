/**
 * 冒烟测试：启动 Electron 应用，验证进程存活
 * 用法：node scripts/smoke.js
 */
const { spawn } = require('child_process')
const path = require('path')

const exe =
  process.env.SMOKE_ELECTRON_PATH || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
const appRoot = path.join(__dirname, '..')

console.log('[smoke] launching:', exe)
// 关键：清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 退化为纯 Node 运行时
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, [appRoot], { stdio: ['ignore', 'pipe', 'pipe'], detached: false, env })
let out = ''
let err = ''
child.stdout.on('data', (d) => {
  out += d
})
child.stderr.on('data', (d) => {
  err += d
})

const t = setTimeout(() => {
  if (child.exitCode === null) {
    console.log('[smoke] ALIVE after 8s — PASS')
    console.log('[smoke] stdout:', out.trim().slice(0, 500) || '(empty)')
    if (err.trim()) console.log('[smoke] stderr:', err.trim().slice(0, 500))
    child.kill()
    process.exit(0)
  }
}, 8000)

child.on('exit', (code) => {
  clearTimeout(t)
  console.log('[smoke] EXITED early, code =', code)
  console.log('[smoke] stdout:', out.trim().slice(0, 500) || '(empty)')
  console.log('[smoke] stderr:', err.trim().slice(0, 1000) || '(empty)')
  process.exit(1)
})
