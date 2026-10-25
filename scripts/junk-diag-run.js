/** junk 诊断：跑打包版 CS_JUNK_DIAG，捕获 stdout */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const exe = (process.env.CS_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', '净澈 CleanSpace.exe'))
const out = path.join(__dirname, '..', 'build', 'junk-diag.json')
try { fs.unlinkSync(out) } catch { /* */ }

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
env.CS_JUNK_DIAG = '1'
env.CS_SELFTEST_OUT = out

const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], env })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => { stdout += d })
child.stderr.on('data', (d) => { stderr += d })

const t0 = Date.now()
const timer = setInterval(() => {
  if (child.exitCode !== null || fs.existsSync(out)) {
    clearInterval(timer)
    console.log(stdout || '(无 stdout)')
    if (stderr) console.error('STDERR:', stderr.slice(-400))
    try { child.kill() } catch { /* */ }
    process.exit(0)
  }
  if (Date.now() - t0 > 180000) {
    clearInterval(timer)
    console.log('TIMEOUT\n', stdout, '\nERR:', stderr.slice(-200))
    try { child.kill() } catch { /* */ }
    process.exit(2)
  }
}, 1000)
