/**
 * 启动项管理（P4）
 * 读取：注册表 Run/RunOnce（HKCU+HKLM）、启动文件夹（用户+公共）、登录计划任务
 * 操作：仅「启用 / 禁用」。禁用 = 完整备份（SQLite + .reg/.lnk 文件）后移除；
 *       启用 = 从备份恢复。绝不提供删除（红线）。
 */
import type Database from 'better-sqlite3'
import { exec } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'

const pexec = promisify(exec)

/* ---------------- 类型 ---------------- */
export type StartupSource = 'registry-hkcu-run' | 'registry-hkcu-runonce' | 'registry-hklm-run' | 'registry-hklm-runonce' | 'folder-user' | 'folder-common' | 'task'

export interface StartupItem {
  id: string // source::name
  source: StartupSource
  name: string
  command: string
  enabled: boolean
  /** 内置知识库的影响说明 */
  advice?: string
  /** 需要管理员权限（HKLM/公共文件夹） */
  needsAdmin: boolean
  /** 备份位置（禁用后产生） */
  backupFile?: string
}

export interface BackupRow {
  id: number
  item_id: string
  source: string
  name: string
  command: string
  reg_file: string | null
  link_file: string | null
  ts: number
}

/* ---------------- 内置知识库（常见启动项影响说明） ---------------- */
const KNOWLEDGE: Array<{ match: RegExp; advice: string }> = [
  { match: /wechat|weixin|微信/i, advice: '微信：禁用后开机不自动启动，不影响收消息（手动打开后正常）' },
  { match: /qq\.exe|qqintl/i, advice: 'QQ：可禁用，需要时手动打开' },
  { match: /dingtalk|钉钉/i, advice: '钉钉：可禁用，需要时手动打开' },
  { match: /alipay/i, advice: '支付宝相关服务：可禁用' },
  { match: /360(safe|se|sd|tray)|360安全/i, advice: '360 系：禁用后不常驻，杀毒防护将关闭，请确认有其他防护' },
  { match: /huorong|hips|火绒/i, advice: '火绒安全：建议保留（安全软件）' },
  { match: /onedrive/i, advice: 'OneDrive：禁用后不同步文件，需要时手动打开' },
  { match: /teams/i, advice: 'Microsoft Teams：可禁用' },
  { match: /steam/i, advice: 'Steam：可禁用，游戏内加速等功能需手动开' },
  { match: /nvidia|geforce|nvcontainer/i, advice: 'NVIDIA 驱动组件：建议保留（显卡功能相关）' },
  { match: /amd.*\\| RadeonSoftware/i, advice: 'AMD 驱动组件：建议保留' },
  { match: /realt(ek|ek).*audio|ravc|hd audio/i, advice: 'Realtek 音频管理：可禁用（声音仍正常，仅面板不常驻）' },
  { match: /synaptics|elan|touchpad/i, advice: '触摸板辅助：笔记本建议保留（手势功能）' },
  { match: /icloud|itunes/i, advice: 'Apple 相关：不用 iPhone 同步可禁用' },
  { match: /adobe.*(arm|updater)|creative cloud/i, advice: 'Adobe 更新器：可禁用' },
  { match: /sunlogin|todesk|anydesk|teamviewer|向日葵/i, advice: '远程控制软件：若不依赖远程开机连接可禁用' },
  { match: /securityhealth|windows defender|mssecext/i, advice: 'Windows 安全中心：建议保留' },
  { match: /cisco|anyconnect|vpn/i, advice: 'VPN 客户端：按需保留' },
  { match: /thunder|xunlei|迅雷/i, advice: '迅雷：可禁用' },
  { match: /netease|cloudmusic|网易云音乐/i, advice: '网易云等播放器：可禁用' },
  { match: /sogou|搜狗|baidu|QQPinyin|输入法/i, advice: '输入法服务：建议保留（禁用可能影响输入法）' }
]

export function adviceFor(name: string, command: string): string | undefined {
  const s = name + ' ' + command
  for (const k of KNOWLEDGE) if (k.match.test(s)) return k.advice
  return undefined
}

/* ---------------- 注册表解析 ---------------- */
const REG_KEYS: Array<{ source: StartupSource; hive: string; sub: string; admin: boolean }> = [
  { source: 'registry-hkcu-run', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', admin: false },
  { source: 'registry-hkcu-runonce', hive: 'HKCU', sub: 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', admin: false },
  { source: 'registry-hklm-run', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', admin: true },
  { source: 'registry-hklm-runonce', hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce', admin: true }
]

async function queryRegKey(hive: string, sub: string): Promise<Array<{ name: string; value: string }>> {
  const out: Array<{ name: string; value: string }> = []
  try {
    const { stdout } = await pexec(`reg query "${hive}\\${sub}" 2>nul`, { windowsHide: true, timeout: 10000 })
    for (const line of stdout.split(/\r?\n/)) {
      // 形如 "    Name    REG_SZ    value"
      const m = line.match(/^\s+(\S.*?)\s+REG_(?:SZ|EXPAND_SZ|BINARY|DWORD)\s+(.*)$/)
      if (m) out.push({ name: m[1].trim(), value: m[2].trim() })
    }
  } catch { /* 键不存在或无权限 */ }
  return out
}

/* ---------------- 启动文件夹 ---------------- */
function folderPaths(): Array<{ source: StartupSource; dir: string; admin: boolean }> {
  return [
    { source: 'folder-user', dir: join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), admin: false },
    { source: 'folder-common', dir: join('C:', 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'), admin: true }
  ]
}

/* ---------------- 读取全部 ---------------- */
export async function listStartup(db: Database.Database, backups: BackupRow[]): Promise<StartupItem[]> {
  const disabled = new Map(backups.map((b) => [b.item_id, b]))
  const items: StartupItem[] = []

  for (const k of REG_KEYS) {
    const rows = await queryRegKey(k.hive, k.sub)
    for (const r of rows) {
      const id = `${k.source}::${r.name}`
      const b = disabled.get(id)
      items.push({
        id, source: k.source, name: r.name, command: r.value,
        enabled: !b, advice: adviceFor(r.name, r.value), needsAdmin: k.admin,
        backupFile: b?.reg_file || undefined
      })
    }
  }

  for (const f of folderPaths()) {
    if (!existsSync(f.dir)) continue
    let files: string[] = []
    try { files = readdirSync(f.dir) } catch { continue }
    for (const name of files) {
      if (!/\.(lnk|bat|cmd|exe)$/i.test(name)) continue
      const id = `${f.source}::${name}`
      const b = disabled.get(id)
      items.push({
        id, source: f.source, name, command: join(f.dir, name),
        enabled: !b, advice: adviceFor(name, ''), needsAdmin: f.admin,
        backupFile: b?.link_file || undefined
      })
    }
  }

  // 登录计划任务（v1.1 补齐，读取失败优雅降级为空）
  try {
    const { listLogonTasks } = await import('./tasks')
    const tasks = await listLogonTasks()
    for (const t of tasks) {
      const id = `task::${t.taskPath}`
      const b = disabled.get(id)
      items.push({
        id, source: 'task', name: t.taskPath, command: t.command,
        enabled: b ? false : t.enabled, advice: adviceFor(t.taskPath, t.command),
        needsAdmin: t.taskPath.startsWith('\\Microsoft'),
        backupFile: b?.reg_file || undefined
      })
    }
  } catch { /* schtasks 不可用时跳过 */ }

  // 已禁用但不在当前列表的（备份仍在）也展示为「已禁用」
  for (const b of backups) {
    if (!items.some((i) => i.id === b.item_id)) {
      items.push({
        id: b.item_id, source: b.source as StartupSource, name: b.name, command: b.command,
        enabled: false, advice: adviceFor(b.name, b.command),
        needsAdmin: b.source.startsWith('registry-hklm') || b.source === 'folder-common',
        backupFile: b.reg_file || b.link_file || undefined
      })
    }
  }
  return items
}

/* ---------------- 备份目录 ---------------- */
export function backupDir(): string {
  const d = join(app.getPath('userData'), 'startup-backups')
  mkdirSync(d, { recursive: true })
  return d
}

/** 生成 .reg 备份内容（用于 reg 导入恢复） */
export function regFileContent(hive: string, sub: string, name: string, value: string, type = 'REG_SZ'): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `Windows Registry Editor Version 5.00\r\n\r\n[${hive}\\${sub}]\r\n"${esc(name)}"=${type === 'REG_SZ' ? `"${esc(value)}"` : value}\r\n`
}

/** 写 .reg 文件（reg import 要求 UTF-16LE BOM） */
export function writeRegFile(path: string, content: string): void {
  const BOM = Buffer.from([0xff, 0xfe])
  const body = Buffer.from(content, 'utf16le')
  writeFileSync(path, Buffer.concat([BOM, body]))
}

/** 禁用：备份 → 移除（注册表 delete / 文件移入备份目录） */
export async function disableStartup(db: Database.Database, item: StartupItem): Promise<{ backupFile: string }> {
  const dir = backupDir()
  const ts = Date.now().toString(36)
  const bakTable = db.prepare('CREATE TABLE IF NOT EXISTS startup_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, source TEXT, name TEXT, command TEXT, reg_file TEXT, link_file TEXT, ts INTEGER)')
  bakTable.run()
  const sel = db.prepare('SELECT * FROM startup_backup WHERE item_id = ?')
  const existing = sel.get(item.id) as BackupRow | undefined
  if (existing) throw new Error('该项已处于禁用状态（已有备份）')

  if (item.source.startsWith('registry-')) {
    const k = REG_KEYS.find((x) => x.source === item.source)!
    // .reg 备份文件
    const regFile = join(dir, `${ts}-${item.name.replace(/[\\/:*?"<>|]/g, '_')}.reg`)
    writeRegFile(regFile, regFileContent(k.hive, k.sub, item.name, item.command))
    // 备份记录
    db.prepare('INSERT INTO startup_backup (item_id, source, name, command, reg_file, link_file, ts) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(item.id, item.source, item.name, item.command, regFile, Date.now())
    // 移除
    await pexec(`reg delete "${k.hive}\\${k.sub}" /v "${item.name}" /f`, { windowsHide: true, timeout: 10000 })
    // op_log
    db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(Date.now(), `startup-${ts}`, 'disable_startup', `${k.hive}\\${k.sub}::${item.name}`, regFile, JSON.stringify({ name: item.name, command: item.command, hive: k.hive, sub: k.sub }))
    return { backupFile: regFile }
  }

  if (item.source.startsWith('folder-')) {
    const f = folderPaths().find((x) => x.source === item.source)!
    const src = join(f.dir, item.name)
    const linkFile = join(dir, `${ts}-${item.name}`)
    copyFileSync(src, linkFile)
    unlinkSync(src)
    db.prepare('INSERT INTO startup_backup (item_id, source, name, command, reg_file, link_file, ts) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .run(item.id, item.source, item.name, item.command, linkFile, Date.now())
    db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(Date.now(), `startup-${ts}`, 'disable_startup', src, linkFile, JSON.stringify({ name: item.name, folder: f.dir }))
    return { backupFile: linkFile }
  }

  if (item.source === 'task') {
    // v1.1：计划任务走专门实现（XML 备份 + schtasks 启停）
    const { disableLogonTask } = await import('./tasks')
    const taskPath = item.id.startsWith('task::') ? item.id.slice(6) : item.name
    return disableLogonTask(db, { ...item, name: taskPath } as StartupItem & { name: string })
  }

  throw new Error('暂不支持该来源的禁用')
}

/** 启用：从备份恢复 */
export async function enableStartup(db: Database.Database, item: StartupItem): Promise<void> {
  const sel = db.prepare('SELECT * FROM startup_backup WHERE item_id = ?')
  const b = sel.get(item.id) as BackupRow | undefined
  if (!b) throw new Error('未找到备份记录')

  if (item.source.startsWith('registry-')) {
    if (!b.reg_file || !existsSync(b.reg_file)) throw new Error('备份 .reg 文件丢失，无法恢复')
    await pexec(`reg import "${b.reg_file}"`, { windowsHide: true, timeout: 10000 })
  } else if (item.source.startsWith('folder-')) {
    const f = folderPaths().find((x) => x.source === item.source)!
    if (!b.link_file || !existsSync(b.link_file)) throw new Error('备份文件丢失，无法恢复')
    copyFileSync(b.link_file, join(f.dir, b.name))
  } else {
  if (item.source === 'task') {
    const { enableLogonTask } = await import('./tasks')
    const taskPath = item.id.startsWith('task::') ? item.id.slice(6) : item.name
    await enableLogonTask(db, taskPath)
    return
  }

  throw new Error('暂不支持该来源的恢复')
}

  db.prepare('DELETE FROM startup_backup WHERE item_id = ?').run(item.id)
  db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, 0, NULL)')
    .run(Date.now(), `startup-restore-${Date.now().toString(36)}`, 'restore', b.name, null)
}

/** 全部备份记录 */
export function listBackups(db: Database.Database): BackupRow[] {
  db.exec('CREATE TABLE IF NOT EXISTS startup_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, source TEXT, name TEXT, command TEXT, reg_file TEXT, link_file TEXT, ts INTEGER)')
  return db.prepare('SELECT * FROM startup_backup ORDER BY ts DESC').all() as BackupRow[]
}
