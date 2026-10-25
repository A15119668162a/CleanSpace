/**
 * C 盘整盘实测（打包版）：性能 + 权限降级验证
 * 后台运行：node scripts/c-drive-test.js
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const exe = (process.env.CS_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe'))
const outFile = path.join(__dirname, '..', 'build', 'c-drive-result.json')
try { fs.unlinkSync(outFile) } catch { /* */ }

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
env.CS_CDRIVE_TEST = '1'
env.CS_SELFTEST_OUT = outFile

const child = spawn(exe, [], { stdio: 'ignore', env })
console.log('[c-test] pid', child.pid, '— 扫描 C:\\ 全盘（无管理员权限，预期部分系统目录 skipped）')

const t0 = Date.now()
const timer = setInterval(() => {
  if (fs.existsSync(outFile)) {
    clearInterval(timer)
    console.log('[c-test]', fs.readFileSync(outFile, 'utf8'))
    try { child.kill() } catch { /* */ }
    process.exit(0)
  }
  const el = Math.round((Date.now() - t0) / 1000)
  if (el % 60 === 0 && el > 0) console.log(`[c-test] ... ${el}s`)
  if (el > 900) { // 15 分钟上限
    clearInterval(timer)
    console.error('[c-test] TIMEOUT 900s')
    try { child.kill() } catch { /* */ }
    process.exit(2)
  }
}, 1000)
