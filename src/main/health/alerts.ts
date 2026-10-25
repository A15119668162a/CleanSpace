/**
 * 空间预警监控（v2.1 / F4）
 * 30 分钟（可调 10~120）检查磁盘剩余；阈值（C 盘 10GB / 其他 5GB 可设）触发：
 * Windows 通知 + 托盘图标变红；恢复后图标复原。
 * 红线 9：同一磁盘同一预警 24h 内只提醒一次（alerts_log 频控）。
 */
import type Database from 'better-sqlite3'
import { BrowserWindow } from 'electron'
import { listDisks } from '../sys/sysinfo'

export interface AlertConfig {
  intervalMin: number      // 检查频率（分钟）
  cThresholdGB: number     // C 盘阈值
  otherThresholdGB: number // 其他盘阈值
  enabled: boolean
}

export function getAlertConfig(db: Database.Database): AlertConfig {
  db.exec('CREATE TABLE IF NOT EXISTS alerts_log (id INTEGER PRIMARY KEY AUTOINCREMENT, drive TEXT, ts INTEGER, free_bytes INTEGER)')
  const g = (k: string, d: string): string => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined
    return row?.value ?? d
  }
  return {
    intervalMin: Number(g('alert_interval_min', '30')) || 30,
    cThresholdGB: Number(g('alert_c_gb', '10')) || 10,
    otherThresholdGB: Number(g('alert_other_gb', '5')) || 5,
    enabled: g('alert_enabled', '1') === '1'
  }
}

export function setAlertConfig(db: Database.Database, c: Partial<AlertConfig>): void {
  const s = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  if (c.intervalMin !== undefined) s.run('alert_interval_min', String(c.intervalMin))
  if (c.cThresholdGB !== undefined) s.run('alert_c_gb', String(c.cThresholdGB))
  if (c.otherThresholdGB !== undefined) s.run('alert_other_gb', String(c.otherThresholdGB))
  if (c.enabled !== undefined) s.run('alert_enabled', c.enabled ? '1' : '0')
}

/** 24h 频控：该盘上次同类预警是否在 24h 内（红线 9） */
export function recentlyAlerted(db: Database.Database, drive: string, now = Date.now()): boolean {
  const row = db.prepare('SELECT MAX(ts) t FROM alerts_log WHERE drive = ?').get(drive) as { t: number | null }
  return row.t !== null && now - row.t < 24 * 3600 * 1000
}

export interface AlertEvent {
  drive: string
  freeGB: number
  thresholdGB: number
}

/** 单次检查（可注入 disks 便于测试）：返回本次触发的预警（已过频控的） */
export async function checkDisks(
  db: Database.Database,
  cfg: AlertConfig,
  inject?: Array<{ drive: string; freeBytes: number }>
): Promise<AlertEvent[]> {
  if (!cfg.enabled) return []
  const disks = inject || (await listDisks())
  const events: AlertEvent[] = []
  const ins = db.prepare('INSERT INTO alerts_log (drive, ts, free_bytes) VALUES (?, ?, ?)')
  for (const d of disks) {
    const isC = d.drive.startsWith('C')
    const th = isC ? cfg.cThresholdGB : cfg.otherThresholdGB
    const freeGB = d.freeBytes / 1024 ** 3
    if (freeGB < th) {
      if (recentlyAlerted(db, d.drive)) continue // 红线 9：24h 频控
      ins.run(d.drive, Date.now(), d.freeBytes)
      events.push({ drive: d.drive, freeGB, thresholdGB: th })
    }
  }
  return events
}

/** 触发预警动作：Windows 通知（点击直达透视）+ 托盘变红回调 */
export function fireAlerts(events: AlertEvent[], onTrayAlert: (alert: boolean) => void): void {
  for (const e of events) {
    try {
      const Notification = require('electron').Notification as typeof import('electron').Notification
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `净澈 · ${e.drive} 空间告急`,
          body: `剩余仅 ${e.freeGB.toFixed(1)}GB（低于 ${e.thresholdGB}GB 阈值）。点击查看空间占用。`
        })
        n.on('click', () => {
          for (const w of BrowserWindow.getAllWindows()) {
            w.show()
            w.webContents.send('navigate', 'insight')
          }
        })
        n.show()
      }
    } catch { /* 通知失败不影响 */ }
  }
  onTrayAlert(events.length > 0)
}

/* ---------------- 定时器（主进程生命周期） ---------------- */
let timer: ReturnType<typeof setInterval> | null = null
let powerResumeListener: ((e: Electron.Event) => void) | null = null

/** 启动监控（重复调用先停旧） */
export function startMonitor(
  db: Database.Database,
  deps: { onTrayAlert: (alert: boolean) => void; onConfigChanged?: () => AlertConfig }
): void {
  stopMonitor()
  const run = (): void => {
    const cfg = deps.onConfigChanged ? deps.onConfigChanged() : getAlertConfig(db)
    void checkDisks(db, cfg)
      .then((events) => { if (events.length) fireAlerts(events, deps.onTrayAlert) })
      .catch(() => undefined)
  }
  const cfg0 = getAlertConfig(db)
  timer = setInterval(run, Math.min(Math.max(cfg0.intervalMin, 10), 120) * 60 * 1000)
  // 电源唤醒：立即补查一次
  try {
    const electron = require('electron') as typeof import('electron')
    powerResumeListener = (): void => run()
    electron.powerMonitor.on('resume', powerResumeListener)
  } catch { /* 测试环境无 electron */ }
  // 启动时先查一次（延迟 30s 避免与启动扫描抢 IO）
  setTimeout(run, 30 * 1000)
}

export function stopMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
  if (powerResumeListener) {
    try {
      const electron = require('electron') as typeof import('electron')
      electron.powerMonitor.removeListener('resume', powerResumeListener)
    } catch { /* */ }
    powerResumeListener = null
  }
}
