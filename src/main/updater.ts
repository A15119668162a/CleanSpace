/**
 * 自动更新（v2.4 / F8）
 * electron-updater generic provider → https://cbxs.top/update/cleanspace/
 * 启动延迟 30s 静默检查 + 设置页手动入口；下载进度推送渲染层；
 * 校验失败自动回滚不安装（electron-updater 内建哈希校验——红线 10）；
 * 无网/源不可达 3s 超时静默（不影响启动）。
 */
import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import type Database from 'better-sqlite3'
import { UPDATE_URL } from '../shared/update-policy'

export { UPDATE_URL, pruneVersions } from '../shared/update-policy'

export interface UpdateStatus {
  state: 'none' | 'available' | 'downloading' | 'ready' | 'uptodate' | 'error'
  version?: string
  progress?: number // 0-100
  bytesPerSecond?: number
  releaseNotes?: string
  error?: string
}

let started = false
let debugBuf: string[] = []
function debugLog(msg: string): void {
  debugBuf.push(Date.now() % 100000 + ' ' + msg)
  if (debugBuf.length > 30) debugBuf.shift()
}
export function readDebug(): string[] { return [...debugBuf] }
let failReason: string | null = null // 最近一次手动检查失败原因（诊断用）

/** 配置 + 事件接线（应用启动后调用一次；v4.2.9 手动检查前也会兜底调用——幂等） */
export function initUpdater(db: Database.Database): void {
  if (started) return
  started = true
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // 快速失败：网络栈超时（默认可挂很久）
  autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' }
  autoUpdater.on('update-available', (i: { version: string }) => {
    push(db, { state: 'available', version: i.version })
  })
  autoUpdater.on('download-progress', (p: { percent: number; bytesPerSecond: number }) => {
    push(db, { state: 'downloading', progress: p.percent, bytesPerSecond: p.bytesPerSecond })
  })
  autoUpdater.on('update-downloaded', (i: { version: string }) => {
    push(db, { state: 'ready', version: i.version })
  })
  autoUpdater.on('update-not-available', () => {
    push(db, { state: 'uptodate' })
  })
  autoUpdater.on('error', (e: Error) => {
    push(db, { state: 'error', error: e.message })
  })
  // 启动 30s 后静默检查
  setTimeout(() => {
    void checkForUpdates().catch(() => undefined)
  }, 30 * 1000)
}

/** v4.2.9 手动检查：15s 硬超时（electron-updater 无网时 promise 可悬挂几分钟——「点了没反应」根因之一）
 * 注意：executor 内同步异常也必须落 done(false)，否则 Promise 永不 resolve（UI 悬挂根因之二） */
let cachedDb: Database.Database | null = null
export function setCachedDb(db: Database.Database): void { cachedDb = db }
/** 手动检查兜底：若 initUpdater 尚未跑（tray 链失败连坐），先注册事件 */
function ensureInit(): void {
  if (started || !cachedDb) return
  debugLog('ensureInit（initUpdater 未跑——手动触发兜底）')
  initUpdater(cachedDb)
}

export async function checkForUpdates(timeoutMs = 15000): Promise<boolean> {
  failReason = null
  ensureInit()
  debugLog('check-in')
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (v: boolean): void => { if (!settled) { settled = true; debugLog('done(' + v + ')'); clearTimeout(t); resolve(v) } }
    const t = setTimeout(() => done(false), timeoutMs)
    // 任一终态事件即视为完成（checkForUpdates 的 await 在 error 时不一定 reject）
    const fin = (): void => { setTimeout(() => done(true), 300) }
    autoUpdater.once('update-not-available', fin)
    autoUpdater.once('update-available', fin)
    autoUpdater.once('error', () => done(false))
    // v4.2.9：reject/同步异常都要留痕（否则静默失败无迹可寻）
    const fail = (e: unknown): void => {
      done(false)
      failReason = e instanceof Error ? e.message : String(e)
    }
    try {
      const p = autoUpdater.checkForUpdates()
      debugLog('launched typeof=' + typeof p)
      p.then(() => { debugLog('resolve'); done(true) }, fail)
    } catch (e) { debugLog('sync-throw: ' + String(e)); fail(e) }
  })
}

/** 立即重启安装（用户在升级弹窗点「立即安装」） */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

/** v4.2.9 诊断信息（渲染层「检查失败」时可展开） */
export function diagUpdater(): Record<string, unknown> {
  return {
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    currentVersion: String(autoUpdater.currentVersion?.version || ''),
    autoDownload: autoUpdater.autoDownload,
    allowDowngrade: autoUpdater.allowDowngrade
  }
}

/** v4.2.9 取最近一次手动检查失败原因（诊断） */
export function lastFailReason(): string | null { return failReason }

/** v4.2.9 把失败写入 DB 状态（UI 可见，不再静默悬挂） */
export function noteFail(db: Database.Database, reason: string | null): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('update_status', ?)").run(JSON.stringify({ state: 'error', error: reason || 'timeout', ts: Date.now() }))
  } catch { /* */ }
}

/** v4.2.9 检查前置：清除上次残留状态（error 会永远躺在 DB 里——UI 显示陈旧错误的根因） */
export function beginCheck(db?: Database.Database): void {
  if (!db) return
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('update_status', ?)").run(JSON.stringify({ state: 'checking', ts: Date.now() }))
  } catch { /* */ }
}

/* ---------------- 状态持久化（渲染层拉取） ---------------- */
function push(db: Database.Database, s: UpdateStatus): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('update_status', ?)").run(JSON.stringify({ ...s, ts: Date.now() }))
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:status', s)
  } catch { /* */ }
}

export function readStatus(db: Database.Database): (UpdateStatus & { ts?: number }) | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'update_status'").get() as { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  } catch { return null }
}
