/**
 * 打包产物冒烟：启动便携版 exe，验证进程存活
 * 用法：node scripts/pack-test.js <exe路径>（缺省自动找 dist/win-unpacked）
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const distDir = path.join(__dirname, '..', 'dist', 'win-unpacked')
const defaultExe = path.join(distDir, '净澈 CleanSpace.exe')
const exe = process.argv[2] || (fs.existsSync(defaultExe) ? defaultExe : null)

if (!exe || !fs.existsSync(exe)) {
  console.error('[pack-test] exe not found:', exe || '(none)')
  process.exit(2)
}

console.log('[pack-test] launching:', exe)
// 关键：清掉沙箱注入的变量（ELECTRON_RUN_AS_NODE / NODE_OPTIONS），否则打包版异常退出
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV

const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], env })
let out = ''
let err = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (err += d))

const t = setTimeout(() => {
  if (child.exitCode === null) {
    console.log('[pack-test] ALIVE after 10s — PASS')
    if (err.trim()) console.log('[pack-test] stderr:', err.trim().slice(0, 500))
    child.kill()
    process.exit(0)
  }
}, 10000)

child.on('exit', (code) => {
  clearTimeout(t)
  console.log('[pack-test] EXITED early, code =', code)
  console.log('[pack-test] stderr:', err.trim().slice(0, 1000) || '(empty)')
  process.exit(1)
})
