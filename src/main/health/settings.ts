/**
 * 设置中心（P5 / M5）
 * - 回收站保留天数（recycle.ts 消费）
 * - 开机自启（Electron app.setLoginItemSettings）
 * - 白名单管理（自定义增删；builtin 只读）
 * - 日志导出（op_log → CSV）
 * - 定期任务（每周垃圾扫描提醒，只扫不清 + Windows 通知）
 */
import type Database from 'better-sqlite3'
import { app, Notification } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import type { WhitelistRule } from '../../shared/whitelist'

export interface AppSettings {
  recycleKeepDays: number
  autoStart: boolean
  weeklyScan: boolean
  closeToTray: boolean
  language: string
}

export function getSettings(db: Database.Database): AppSettings {
  const get = (k: string, d: string): string => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined
    return row?.value ?? d
  }
  return {
    recycleKeepDays: Number(get('recycle_keep_days', '15')) || 15,
    autoStart: get('auto_start', '0') === '1',
    weeklyScan: get('weekly_scan', '1') === '1',
    closeToTray: get('close_to_tray', '1') === '1',
    language: get('language', 'zh-CN')
  }
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

/** 开机自启（Electron 官方 API，写注册表 Run） */
export function applyAutoStart(enable: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enable,
    args: ['--hidden']
  })
}

export function isAutoStart(): boolean {
  return app.getLoginItemSettings().openAtLogin
}

/* ---------------- 白名单管理 ---------------- */
export function addWhitelist(db: Database.Database, pattern: string, note: string): { ok: boolean; error?: string } {
  const p = pattern.trim().replace(/\\/g, '/')
  if (!p) return { ok: false, error: '路径不能为空' }
  if (!/^[A-Za-z]:(\/|$)/.test(p)) return { ok: false, error: '请输入绝对路径，如 D:\\资料 或 D:\\资料\\**' }
  try {
    db.prepare('INSERT INTO whitelist (pattern, enabled, builtin, note) VALUES (?, 1, 0, ?)').run(p, note || '自定义')
    return { ok: true }
  } catch {
    return { ok: false, error: '该规则已存在' }
  }
}

export function removeWhitelist(db: Database.Database, id: number): boolean {
  const row = db.prepare('SELECT builtin FROM whitelist WHERE id = ?').get(id) as { builtin: number } | undefined
  if (!row || row.builtin) return false // 内置规则不可删
  db.prepare('DELETE FROM whitelist WHERE id = ?').run(id)
  return true
}

export function toggleWhitelist(db: Database.Database, id: number, enabled: boolean): boolean {
  const row = db.prepare('SELECT builtin FROM whitelist WHERE id = ?').get(id) as { builtin: number } | undefined
  if (!row) return false
  db.prepare('UPDATE whitelist SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return true
}

export function allWhitelist(db: Database.Database): WhitelistRule[] {
  return db.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist ORDER BY builtin DESC, id').all() as WhitelistRule[]
}

/* ---------------- 日志导出 ---------------- */
export function exportLogs(db: Database.Database, savePath: string): { rows: number } {
  const rows = db.prepare('SELECT ts, batch_id, action, src_path, dst_path, size, detail FROM op_log ORDER BY id DESC').all() as Array<{
    ts: number; batch_id: string; action: string; src_path: string; dst_path: string | null; size: number; detail: string | null
  }>
  const esc = (s: unknown): string => {
    const v = s === null || s === undefined ? '' : String(s)
    return '"' + v.replace(/"/g, '""') + '"'
  }
  const head = '时间,批次,操作,原路径,新路径,大小,详情'
  const body = rows.map((r) =>
    [new Date(r.ts).toLocaleString('zh-CN', { hour12: false }), r.batch_id, r.action, r.src_path, r.dst_path, r.size, r.detail]
      .map(esc).join(',')
  )
  const csv = '\uFEFF' + head + '\r\n' + body.join('\r\n') // BOM 保证 Excel 中文不乱码
  writeFileSync(savePath, csv, 'utf8')
  return { rows: rows.length }
}

/* ---------------- 定期任务（每周垃圾扫描） ---------------- */
const WEEK_MS = 7 * 24 * 3600 * 1000

/** 检查是否该跑了（上次扫描超 7 天）；跑了则通知（只扫不清——红线） */
export async function maybeWeeklyScan(db: Database.Database, whitelist: WhitelistRule[]): Promise<{ ran: boolean; junkBytes?: number }> {
  const s = getSettings(db)
  if (!s.weeklyScan) return { ran: false }
  const last = db.prepare('SELECT value FROM settings WHERE key = ?').get('weekly_scan_last') as { value: string } | undefined
  const lastTs = last ? Number(last.value) : 0
  if (Date.now() - lastTs < WEEK_MS) return { ran: false }

  const { scanJunk } = await import('../cleaner/scan')
  // v4.2.3：周扫与手动清扫同口径（安全口袋开关一致——修复扫/清不一致的根源）
  const pocketsOn = (() => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('safe_pockets') as { value: string } | undefined
      return row ? row.value !== '0' : true
    } catch { return true }
  })()
  const junk = await scanJunk(whitelist, { safePockets: pocketsOn })
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('weekly_scan_last', String(Date.now()))
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('weekly_scan_last_result', JSON.stringify({ bytes: junk.totalBytes, files: junk.totalFiles, ts: Date.now() }))

  const gb = (junk.totalBytes / 1024 ** 3).toFixed(1)
  // v3.5：周体检自动生成报告（复用月报引擎，报告先行——通知点击直达）
  let reportPath = ''
  try {
    const { generateReport } = await import('./report')
    reportPath = generateReport(db, new Date().toISOString().slice(0, 7))
  } catch { /* 报告失败不阻塞通知 */ }
  const msg = junk.totalBytes > 1024 ** 3 ? `发现 ${gb}GB 可清理垃圾${reportPath ? '，本周报告已生成' : ''}` : '垃圾很少，一切正常'
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: '净澈 · 每周体检', body: msg })
      n.on('click', () => {
        for (const w of require('electron').BrowserWindow.getAllWindows()) {
          w.show()
          w.webContents.send('navigate', 'clean')
        }
      })
      n.show()
    }
  } catch { /* 通知失败不影响 */ }
  return { ran: true, junkBytes: junk.totalBytes }
}
