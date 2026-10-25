/**
 * 应用内自测：Electron 启动即跑（环境变量 CS_SELFTEST=1），完成 DOM+IPC 验证后写结果文件并退出
 * 结果输出到 build/selftest-result.json
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const exe = (process.env.CS_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe'))
const outFile = path.join(__dirname, '..', 'build', 'selftest-result.json')
try { fs.unlinkSync(outFile) } catch { /* */ }

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
env.CS_SELFTEST = '1'
env.CS_SELFTEST_OUT = outFile

const child = spawn(exe, [], { stdio: 'ignore', env })
console.log('[selftest] pid', child.pid)

// 最多等 150 秒
const t0 = Date.now()
const timer = setInterval(() => {
  if (fs.existsSync(outFile)) {
    clearInterval(timer)
    const r = fs.readFileSync(outFile, 'utf8')
    console.log('[selftest] result:', r)
    try { child.kill() } catch { /* */ }
    const j = JSON.parse(r)
    process.exit(j.pass ? 0 : 1)
  }
  if (Date.now() - t0 > 150000) {
    clearInterval(timer)
    console.error('[selftest] TIMEOUT')
    try { child.kill() } catch { /* */ }
    process.exit(2)
  }
}, 1000)
