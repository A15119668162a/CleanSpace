/**
 * 发布更新到 cbxs.top（v2.4 / F8）
 * 用法：node scripts/publish-update.js [版本号（默认读 package.json）]
 * 前置：本地已打包（C:\tempbuild\净澈CleanSpace_<v>_安装包.exe 与 latest.yml）
 * 动作：scp 上传 latest.yml + 安装包 + blockmap 到服务器 /var/www/update/cleanspace/
 *       并执行服务器端滚动清理（保留最近 3 版）——与服务器现有策略一致
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const HOST = 'root@cbxs.top'
const REMOTE_DIR = '/var/www/update/cleanspace'
const LOCAL_DIR = 'C:\\tempbuild'

const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
const exe = path.join(LOCAL_DIR, `净澈CleanSpace_${version}_安装包.exe`)
const exeBlockmap = exe + '.blockmap'

console.log(`[publish] 版本 ${version}`)

if (!fs.existsSync(exe)) {
  console.error(`[publish] 安装包不存在：${exe}\n先运行打包（空间不足时清理后重打）。`)
  process.exit(1)
}

// latest.yml 由 electron-builder 生成；若无，生成最小可用版
let latestPath = path.join(LOCAL_DIR, 'latest.yml')
if (!fs.existsSync(latestPath)) {
  const size = fs.statSync(exe).size
  const sha2 = execSync(`powershell -NoProfile -Command "(Get-FileHash -Path '${exe.replace(/'/g, "''")}' -Algorithm SHA512).Hash.ToLower()"`, { encoding: 'utf8' }).trim()
  const yml = `version: ${version}\npath: 净澈CleanSpace_${version}_安装包.exe\nsha512: ${sha2}\nfiles:\n  - url: 净澈CleanSpace_${version}_安装包.exe\n    sha512: ${sha2}\n    size: ${size}\n`
  fs.writeFileSync(latestPath, yml)
  console.log('[publish] 已生成 latest.yml（SHA-512 校验——红线 10）')
}

const files = [latestPath, exe]
if (fs.existsSync(exeBlockmap)) files.push(exeBlockmap)

console.log('[publish] 上传中…')
for (const f of files) {
  execSync(`scp "${f}" ${HOST}:${REMOTE_DIR}/`, { stdio: 'inherit' })
  console.log('  ✓', path.basename(f))
}

// 服务器端滚动保留 3 版
console.log('[publish] 服务器滚动清理（保留最近 3 版）…')
const clean = `ls -1 ${REMOTE_DIR}/净澈CleanSpace_*_安装包.exe 2>/dev/null | sort -t_ -k3 -V | head -n -3 | xargs -r rm -f; ls -1 ${REMOTE_DIR} | grep -E 'blockmap|yml' | wc -l`
execSync(`ssh ${HOST} "${clean}"`, { stdio: 'inherit' })
console.log('[publish] 完成 ✓  更新源：https://cbxs.top/update/cleanspace/')
