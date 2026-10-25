/**
 * 卸载残留清理（v2.3 / F5）
 * 原理：注册表已安装清单 × 磁盘 AppData/ProgramData/Program Files 交叉比对
 * 双重校验（红线 8）：注册表无记录 + 不在厂商字典 → 才算孤儿残留
 * 谨慎级（默认不勾）+ 软删除
 */
import type Database from 'better-sqlite3'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { isProtected, type WhitelistRule } from '../../shared/whitelist'

const pexec = promisify(exec)

/** 厂商字典：即使某产品卸载，厂商目录下还有别的产品/配置在用——整目录不判残留 */
export const VENDOR_KEEP = new Set([
  'google', 'microsoft', 'tencent', 'alibaba', 'baidu', 'netease', 'mozilla',
  'adobe', 'oracle', 'ibm', 'intel', 'nvidia', 'amd', 'realtek', 'dell', 'hp',
  'lenovo', 'asus', 'logitech', 'razer', 'steam', 'valve', 'discord', 'slack',
  'zoom', 'dingtalk', 'wechat', 'weixin', 'qq', 'foxit', 'wps', 'kingsoft',
  'sogou', 'iflytek', 'huawei', 'xiaomi', 'bytedance', 'kuaishou', 'bilibili',
  'citrix', 'vmware', 'virtualbox', 'docker', 'github', 'git', 'nodejs', 'python',
  'openai', 'anthropic', 'notion', 'obsidian', 'typora', 'vscode'
])

export interface ResidueItem {
  path: string
  size: number
  files: number
  mtime: number
  /** 从目录名猜测的疑似软件 */
  guess: string
}

export interface ResidueResult {
  items: ResidueItem[]
  totalBytes: number
  installedCount: number // 注册表已装数（诊断展示）
  cacheFromCache: boolean
  durationMs: number
}

/** 已安装软件名集合（Uninstall 键 + UWP；结果缓存 24h） */
export async function installedNames(db: Database.Database): Promise<Set<string>> {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'installed_cache'").get() as { value: string } | undefined
  const meta = db.prepare("SELECT value FROM settings WHERE key = 'installed_cache_ts'").get() as { value: string } | undefined
  if (row && meta && Date.now() - Number(meta.value) < 24 * 3600e3) {
    try { return new Set(JSON.parse(row.value) as string[]) } catch { /* 重建 */ }
  }
  const names = new Set<string>()
  // 注册表 Uninstall 键（HKLM/HKCU 64/32）
  for (const hive of ['HKLM', 'HKCU']) {
    for (const wow of ['\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
      try {
        const { stdout } = await pexec(`reg query "${hive}${wow}" /s /v DisplayName 2>nul | findstr /i DisplayName`, { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/DisplayName\s+REG_\S+\s+(.+)/i)
          if (m) names.add(m[1].trim().toLowerCase())
        }
      } catch { /* 键不存在 */ }
    }
  }
  // UWP（沙箱/权限不可用时静默跳过）
  try {
    const { stdout } = await pexec('powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AppxPackage | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress"', { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    const j = JSON.parse(stdout.trim() || '[]')
    const arr = Array.isArray(j) ? j : [j]
    for (const n of arr) if (n) names.add(String(n).toLowerCase())
  } catch { /* */ }
  // 缓存
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('installed_cache', ?)").run(JSON.stringify([...names]))
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('installed_cache_ts', ?)").run(String(Date.now()))
  return names
}

/** 扫描根（AppData 双向 + ProgramData + Program Files 双向） */
function scanRoots(): string[] {
  const hd = homedir()
  return [
    join(hd, 'AppData', 'Roaming'),
    join(hd, 'AppData', 'Local'),
    join('C:', 'ProgramData'),
    join('C:', 'Program Files'),
    join('C:', 'Program Files (x86)')
  ]
}

async function dirSize(p: string): Promise<{ size: number; files: number; mtime: number }> {
  let size = 0, files = 0, mtime = 0
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let dirents: Awaited<ReturnType<typeof readdir>>
    try { dirents = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of dirents) {
      const f = join(d, e.name)
      try {
        if (e.isDirectory()) await walk(f, depth + 1)
        else { const s = await stat(f); size += s.size; files++; if (s.mtimeMs > mtime) mtime = s.mtimeMs }
      } catch { /* */ }
    }
  }
  await walk(p, 0)
  if (mtime === 0) { try { mtime = (await stat(p)).mtimeMs } catch { /* */ } }
  return { size, files, mtime }
}

/** 名称匹配：目录名与已装名的 token 重合（双向 includes；导出供测试） */
export function matchesInstalledTester(dirName: string, installed: Set<string>): boolean {
  return matchesInstalled(dirName, installed)
}

function matchesInstalled(dirName: string, installed: Set<string>): boolean {
  const dn = dirName.toLowerCase()
  for (const n of installed) {
    if (n.length < 3) continue
    if (dn.includes(n) || n.includes(dn)) return true
  }
  return false
}

/** 主扫描（红线 8：双重校验都在才展示） */
export async function scanResidue(db: Database.Database, whitelist: WhitelistRule[]): Promise<ResidueResult> {
  const t0 = Date.now()
  const installed = await installedNames(db)
  const items: ResidueItem[] = []
  for (const root of scanRoots()) {
    let dirents: Awaited<ReturnType<typeof readdir>>
    try { dirents = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const d of dirents) {
      if (!d.isDirectory()) continue
      const name = d.name
      const ln = name.toLowerCase()
      if (ln.startsWith('.')) continue
      if (ln.startsWith('$')) continue
      // 校验①：厂商字典
      if (VENDOR_KEEP.has(ln)) continue
      // 厂商目录嵌套：AppData/Local/Google/Chrome——Chrome 已装会命中②；Google 不判整目录
      const full = join(root, name)
      if (isProtected(full, whitelist)) continue
      // 校验②：注册表已装（含子产品名匹配——如 Roaming/Tencent 下 QQ 已装）
      if (matchesInstalled(name, installed)) continue
      // 子目录名也比对（厂商目录下的具体产品，如 AppData/Local/Tencent/WeChatApp）
      let subInstalled = false
      try {
        const subs = await readdir(full, { withFileTypes: true })
        for (const sd of subs.slice(0, 30)) {
          if (sd.isDirectory() && matchesInstalled(sd.name, installed)) { subInstalled = true; break }
        }
      } catch { /* */ }
      if (subInstalled) continue
      // 双重通过 → 候选残留
      const s = await dirSize(full)
      if (s.size < 1024 * 512) continue // <0.5MB 不值得展示
      items.push({ path: full, size: s.size, files: s.files, mtime: s.mtime, guess: guessSoft(name) })
    }
  }
  items.sort((a, b) => b.size - a.size)
  return { items, totalBytes: items.reduce((s, i) => s + i.size, 0), installedCount: installed.size, cacheFromCache: false, durationMs: Date.now() - t0 }
}

/** 目录名猜软件（去常见后缀） */
function guessSoft(name: string): string {
  return name.replace(/(app|application|software|soft|client|tool|helper|update(r)?|setup|corp|ltd|inc)/gi, '').replace(/\s{2,}/g, ' ').trim() || name
}
