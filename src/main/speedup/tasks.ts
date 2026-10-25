/**
 * 计划任务登录启动项（v1.1 / M4 补齐）
 * 读取：schtasks /query /xml 或 PowerShell 筛选含 LogonTrigger 的任务
 * 操作：仅启用/禁用（schtasks /Change /ENABLE|/DISABLE）+ XML 备份（可查可恢复）
 * 红线不变：绝不删除
 */
import type Database from 'better-sqlite3'
import { exec } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync } from 'fs'

const pexec = promisify(exec)

export interface TaskItem {
  /** schtasks 路径名，如 \Microsoft\Windows\Xxx 或 \MyTask */
  taskPath: string
  command: string
  enabled: boolean
  /** 下次运行时间（展示用） */
  nextRun?: string
}

/** PowerShell：列出含登录触发器的任务（含状态与动作命令） */
const PS_LIST = `
Get-ScheduledTask | Where-Object {
  $_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.State -ne 'Disabled' -or $_.Triggers.CimClass.CimClassName -contains 'MSFT_TaskLogonTrigger' }
} | Where-Object { $_.TaskPath -notlike '\\Microsoft\\Windows\\*' } | ForEach-Object {
  $act = ($_.Actions | Where-Object { $_.Execute } | Select-Object -First 1).Execute
  if (-not $act) { return }
  [PSCustomObject]@{
    Path = $_.TaskPath + $_.TaskName
    Cmd = $act
    State = [string]$_.State
  }
} | ConvertTo-Json -Compress`

/** 读取登录计划任务（失败返回空数组——沙箱拦截/无任务时优雅降级） */
export async function listLogonTasks(): Promise<TaskItem[]> {
  try {
    const { stdout } = await pexec(
      `powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${PS_LIST.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
      { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 }
    )
    const raw = stdout.trim()
    if (!raw) return []
    let arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) arr = [arr]
    return (arr as Array<Record<string, unknown>>)
      .filter((t) => t.Path && t.Cmd)
      .map((t) => ({
        taskPath: String(t.Path),
        command: String(t.Cmd),
        enabled: String(t.State).toLowerCase() !== 'disabled',
        nextRun: undefined
      }))
  } catch {
    return []
  }
}

/** 备份目录（复用启动项备份目录） */
function taskBackupDir(): string {
  const d = join(app.getPath('userData'), 'startup-backups')
  mkdirSync(d, { recursive: true })
  return d
}

/** schtasks 任务名的安全转义（引号包裹，内部引号翻倍） */
export function quoteTaskPath(p: string): string {
  return '"' + p.replace(/"/g, '""') + '"'
}

/** 禁用计划任务：导出 XML 备份 + schtasks /DISABLE（记录 op_log） */
export async function disableLogonTask(db: Database.Database, taskPath: string): Promise<{ backupFile: string }> {
  const ts = Date.now().toString(36)
  const dir = taskBackupDir()
  const safeName = taskPath.replace(/[\\/:*?"<>|]/g, '_').slice(-60)
  const xmlFile = join(dir, `task-${ts}-${safeName}.xml`)

  // 1) 导出 XML 备份（即使 schtasks 查询失败也先尝试）
  const q = await pexec(`schtasks /query /tn ${quoteTaskPath(taskPath)} /xml`, { windowsHide: true, timeout: 15000 })
    .catch(() => null)
  if (!q || !q.stdout.trim()) throw new Error('无法读取任务定义（可能需要管理员权限）')
  writeFileSync(xmlFile, q.stdout, 'utf8')

  // 2) 禁用
  await pexec(`schtasks /change /tn ${quoteTaskPath(taskPath)} /disable`, { windowsHide: true, timeout: 15000 })

  // 3) 记录（startup_backup 表复用：reg_file 存 XML 路径）
  db.exec('CREATE TABLE IF NOT EXISTS startup_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, source TEXT, name TEXT, command TEXT, reg_file TEXT, link_file TEXT, ts INTEGER)')
  db.prepare('INSERT OR REPLACE INTO startup_backup (item_id, source, name, command, reg_file, link_file, ts) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run(`task::${taskPath}`, 'task', taskPath, '', xmlFile, Date.now())
  db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(Date.now(), `task-${ts}`, 'disable_startup', taskPath, xmlFile, JSON.stringify({ kind: 'scheduled-task' }))
  return { backupFile: xmlFile }
}

/** 启用计划任务：schtasks /ENABLE + 清备份记录（XML 保留作历史） */
export async function enableLogonTask(db: Database.Database, taskPath: string): Promise<void> {
  const row = db.prepare("SELECT reg_file FROM startup_backup WHERE item_id = ?").get(`task::${taskPath}`) as { reg_file: string | null } | undefined
  await pexec(`schtasks /change /tn ${quoteTaskPath(taskPath)} /enable`, { windowsHide: true, timeout: 15000 })
  if (row) db.prepare('DELETE FROM startup_backup WHERE item_id = ?').run(`task::${taskPath}`)
  db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, 0, NULL)')
    .run(Date.now(), `task-restore-${Date.now().toString(36)}`, 'restore', taskPath, null)
}

/** 备份 XML 是否存在（恢复失败诊断用） */
export function taskBackupExists(file: string | null | undefined): boolean {
  return !!file && existsSync(file)
}
