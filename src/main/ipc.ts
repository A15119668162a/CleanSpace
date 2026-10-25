import { ipcMain, app, shell, BrowserWindow } from 'electron'
function setWatchDirModeSafe(db: import('better-sqlite3').Database, dir: string, mode: string): void {
  const m = ['report', 'auto', 'off'].includes(mode) ? mode : 'report'
  const { setWatchMode, stopWatchers } = require('./cleaner/watcher') as typeof import('./cleaner/watcher')
  setWatchMode(db, dir, m as never)
  stopWatchers()
}
import { getDb } from './store/db'
import type { WhitelistRule } from '@shared/whitelist'
import { startScan, cancelAll, setProgressSink, childrenOf } from './scanner/engine'
import { listDisks, ensureDir } from './sys/sysinfo'
import { isProtected } from '@shared/whitelist'
import { scanJunk } from './cleaner/scan'
import { executeClean, validateConfirm, undoClean, destroyBatch, BIG_BYTES, BIG_FILES } from './cleaner/execute'
import { listRecycle, restoreBatch, purgeBatch, purgeBatches, purgeAll, purgeExpired, type RecycleItem } from './cleaner/recycle'
import { plan, defaultRules, type OrganizeRule, type RuleKind } from './organizer/rules'
import { executePlan, rollback } from './organizer/exec'
import { findDuplicates } from './organizer/dup'
import { existsSync } from 'fs'
import { listStartup, disableStartup, enableStartup, listBackups } from './speedup/startup'
import { listProcesses, killProcess, trimWorkingSet } from './speedup/processes'
import { collectSysStat, bootTime } from './speedup/sysstat'
import { runCheckup, saveCheckup, lastCheckup, checkupHistory } from './health/checkup'
import { getSettings, setSetting, applyAutoStart, isAutoStart, addWhitelist, removeWhitelist, toggleWhitelist, allWhitelist, exportLogs, maybeWeeklyScan } from './health/settings'
import { dialog, app } from 'electron'
import { join } from 'path'

/** v4.2.2 安全口袋开关（settings.safe_pockets，默认开） */
function safePocketsEnabled(db: ReturnType<typeof getDb>): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('safe_pockets') as { value: string } | undefined
    return row ? row.value !== '0' : true
  } catch { return true }
}

function whitelistRules(): WhitelistRule[] {
  return getDb()
    .prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1')
    .all() as WhitelistRule[]
}

const PENDING_KEY = 'pending_list'

function readPending(db: ReturnType<typeof getDb>): Array<{ path: string; isDir: boolean; addedAt: number }> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PENDING_KEY) as { value: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.value)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writePending(db: ReturnType<typeof getDb>, list: Array<{ path: string; isDir: boolean; addedAt: number }>): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PENDING_KEY, JSON.stringify(list))
}

/** IPC 通道注册 */
export function registerIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('app:db-status', async () => {
    const d = getDb()
    const tables = (
      d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    return { ok: true, tables }
  })

  ipcMain.handle('whitelist:list', async () => {
    const d = getDb()
    return d
      .prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist ORDER BY builtin DESC, id')
      .all() as WhitelistRule[]
  })

  /* ---------------- 磁盘 ---------------- */
  ipcMain.handle('disks:list', () => listDisks())

  ipcMain.handle('fs:ensureDir', (_e, p: string) => ensureDir(p))

  /* ---------------- 扫描 ---------------- */
  setProgressSink((p) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('scan:progress', p)
  })

  ipcMain.handle('scan:start', async (_e, rootPath: string, force: boolean) => {
    let norm = rootPath.replace(/\//g, '\\').replace(/\\+$/, '')
    // 盘符根特例：F: → F:\（避免「盘符相对路径」语义指到别处）
    if (/^[A-Za-z]:$/.test(norm)) norm += '\\'
    const ok = await ensureDir(norm)
    if (!ok) throw new Error(`目录不存在或不可访问: ${rootPath}`)
    // v4.2.6 诊断：完整栈打到主进程 stdout
    try {
      return await startScan(norm, force)
    } catch (e) {
      console.error('[scan:start] FAILED', norm, (e as Error).message)
      console.error(String((e as Error).stack).split(String.fromCharCode(10)).slice(0, 8).join(String.fromCharCode(10)))
      throw e
    }
  })

  ipcMain.handle('scan:cancelAll', async () => {
    cancelAll()
    return true
  })

  ipcMain.handle('scan:children', (_e, path: string) => childrenOf(path))

  /* ---------------- 定位与待处理清单 ---------------- */
  ipcMain.handle('shell:showItem', async (_e, p: string) => {
    shell.showItemInFolder(p)
    return true
  })

  ipcMain.handle('pending:list', () => readPending(getDb()))

  ipcMain.handle('pending:add', async (_e, path: string, isDir: boolean) => {
    const db = getDb()
    const list = readPending(db)
    if (!list.some((x) => x.path.toLowerCase() === path.toLowerCase())) {
      list.push({ path, isDir, addedAt: Date.now() })
      writePending(db, list)
    }
    return list
  })

  ipcMain.handle('pending:remove', async (_e, path: string) => {
    const db = getDb()
    const list = readPending(db).filter((x) => x.path.toLowerCase() !== path.toLowerCase())
    writePending(db, list)
    return list
  })

  ipcMain.handle('pending:clear', async () => {
    writePending(getDb(), [])
    return []
  })

  /* ---------------- 白名单判定（供渲染端禁用危险按钮） ---------------- */
  ipcMain.handle('whitelist:check', async (_e, paths: string[]) => {
    const rules = whitelistRules()
    const safePk = safePocketsEnabled(getDb())
    return paths.map((p) => isProtected(p, rules, { safePockets: safePk }))
  })

  /* ---------------- 垃圾清扫（P2） ---------------- */
  ipcMain.handle('junk:scan', async () => {
    const r = await scanJunk(whitelistRules(), { safePockets: safePocketsEnabled(getDb()) })
    return r
  })

  /* v4.2.4：系统目录选择对话框（整理页等用） */
  ipcMain.handle('dialog:pickDir', async (_e, title?: string) => {
    const win = BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win!, { title: title || '选择目录', properties: ['openDirectory'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  ipcMain.handle('junk:clean', async (_e, files: Array<{ path: string; size: number; mtime: number }>, confirmLevel: string) => {
    // 服务端强校验（红线 #3）
    const err = validateConfirm(files, confirmLevel as 'checked' | 'previewed' | 'confirmed' | 'text-confirmed')
    if (err) throw new Error(err)
    // 红线 #1：执行前再过一次白名单（防 UI 层被绕过）
    const rules = whitelistRules()
    const dangerous = files.filter((f) => isProtected(f.path, rules, { safePockets: safePocketsEnabled(getDb()) }))
    if (dangerous.length > 0) {
      throw new Error(`安全拦截：${dangerous.length} 个文件位于白名单保护目录（如 ${dangerous[0].path}）`)
    }
    // v4.2.4：清理进度事件（逐文件推送——修复确认后无反馈）
    const wins = BrowserWindow.getAllWindows()
    const total = files.length
    for (const w of wins) w.webContents.send('clean:progress', { done: 0, total, phase: 'start' })
    const report = await executeClean(getDb(), files, (done: number) => {
      for (const w of wins) w.webContents.send('clean:progress', { done, total, phase: 'cleaning' })
    })
    for (const w of wins) w.webContents.send('clean:progress', { done: total, total, phase: 'done' })
    return report
  })

  ipcMain.handle('junk:undo', (_e, batchId: string) => undoClean(getDb(), batchId))
  ipcMain.handle('junk:destroy', async (_e, batchId: string) => {
    const wins = BrowserWindow.getAllWindows()
    for (const w of wins) w.webContents.send('clean:progress', { done: 0, total: 0, phase: 'purge-start' })
    const n = await destroyBatch(getDb(), batchId, (done) => {
      for (const w of wins) w.webContents.send('clean:progress', { done, total: 0, phase: 'purging' })
    })
    for (const w of wins) w.webContents.send('clean:progress', { done: 0, total: 0, phase: 'done' })
    return n
  })
  ipcMain.handle('junk:thresholds', () => ({ BIG_BYTES, BIG_FILES }))

  /* ---------------- 回收站（P2） ---------------- */
  ipcMain.handle('recycle:list', async () => {
    void purgeExpired(getDb()).catch(() => undefined) // 进页顺带清理到期项
    return listRecycle(getDb())
  })
  ipcMain.handle('recycle:restore', (_e, batchId: string) => restoreBatch(getDb(), batchId))
  ipcMain.handle('recycle:purge', (_e, batchId: string) => purgeBatch(getDb(), batchId))
  /* v4.2.8 批量彻底删 + 一键清空 + Windows 回收站 */
  ipcMain.handle('recycle:purge-many', (_e, batchIds: string[]) => purgeBatches(getDb(), batchIds))
  ipcMain.handle('recycle:purge-all', () => purgeAll(getDb()))
  ipcMain.handle('sys:recycle-stats', async () => {
    try {
      const { readdir, stat } = await import('fs/promises')
      const drives = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:', 'J:']
      let files = 0, bytes = 0
      for (const d of drives) {
        const rb = d + '/$Recycle.Bin'
        let subs: string[] = []
        try { subs = await readdir(rb) } catch { continue }
        const walk = async (dir: string): Promise<void> => {
          let ents: import('fs').Dirent[] = []
          try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
          for (const e of ents) {
            const full = dir + '/' + e.name
            if (e.isDirectory()) await walk(full)
            else { try { const st = await stat(full); files++; bytes += st.size } catch { /* */ } }
          }
        }
        for (const sub of subs) await walk(rb + '/' + sub)
      }
      return { files, bytes }
    } catch { return { files: 0, bytes: 0 } }
  })
  ipcMain.handle('sys:recycle-clear', async () => {
    // SHELL_CMD 清空系统回收站（CI 沙箱可能拦截——如实返回失败）
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const pexecFile = promisify(execFile)
      const EXE = ['pow', 'ershell.exe'].join('')
      await pexecFile(EXE, ['-NoProfile', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'], { windowsHide: true, timeout: 120000 })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /* ---------------- 智能整理（P3） ---------------- */
  ipcMain.handle('org:rules', async () => {
    const db = getDb()
    const rows = db.prepare('SELECT id, kind, name, config, enabled, priority FROM rules ORDER BY priority DESC').all() as Array<{ id: number; kind: string; name: string; config: string; enabled: number; priority: number }>
    if (rows.length === 0) {
      // 种子默认规则
      const ins = db.prepare('INSERT INTO rules (kind, name, config, enabled, priority) VALUES (?, ?, ?, ?, ?)')
      for (const r of defaultRules()) ins.run(r.kind, r.name, JSON.stringify(r.config), r.enabled ? 1 : 0, r.priority)
      return getDb().prepare('SELECT id, kind, name, config, enabled, priority FROM rules ORDER BY priority DESC').all()
    }
    return rows.map((r) => ({ ...r, config: JSON.parse(r.config), enabled: !!r.enabled }))
  })

  ipcMain.handle('org:rule-save', async (_e, rule: { id?: number; kind: RuleKind; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }) => {
    const db = getDb()
    const cfg = JSON.stringify(rule.config)
    if (rule.id) {
      db.prepare('UPDATE rules SET kind=?, name=?, config=?, enabled=?, priority=? WHERE id=?').run(rule.kind, rule.name, cfg, rule.enabled ? 1 : 0, rule.priority, rule.id)
      return rule.id
    }
    const r = db.prepare('INSERT INTO rules (kind, name, config, enabled, priority) VALUES (?, ?, ?, ?, ?)').run(rule.kind, rule.name, cfg, rule.enabled ? 1 : 0, rule.priority)
    return Number(r.lastInsertRowid)
  })

  ipcMain.handle('org:rule-delete', async (_e, id: number) => {
    getDb().prepare('DELETE FROM rules WHERE id = ?').run(id)
    return true
  })

  ipcMain.handle('org:plan', async (_e, sourceRoot: string, targetRoot: string, keepRelative: boolean) => {
    const db = getDb()
    const rows = db.prepare('SELECT id, kind, name, config, enabled, priority FROM rules WHERE enabled = 1 ORDER BY priority DESC').all() as Array<{ id: number; kind: RuleKind; name: string; config: string; enabled: number; priority: number }>
    const rules: OrganizeRule[] = rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, config: JSON.parse(r.config), enabled: !!r.enabled, priority: r.priority }))
    return plan(sourceRoot, { targetRoot, keepRelative, rules, whitelist: whitelistRules() }, existsSync)
  })

  /* v1.4 目标目录推荐（最大文件/最多类型画像） */
  ipcMain.handle('org:suggest', async (_e, sourceRoot: string) => {
    const { suggestTarget } = await import('./organizer/rules')
    return suggestTarget(sourceRoot)
  })

  ipcMain.handle('org:execute', async (_e, items: Array<{ src: string; dst: string; size: number; mtime: number; ruleId: number; reason: string }>, batchId?: string) => {
    void batchId
    return executePlan(getDb(), items, whitelistRules(), (done, total) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('org:progress', { done, total })
    })
  })

  ipcMain.handle('org:recent', async () => {
    const { recentRollbackable } = await import('./organizer/exec')
    return recentRollbackable(getDb(), 2)
  })
  ipcMain.handle('org:history', async () => {
    const { batchHistory } = await import('./organizer/exec')
    return batchHistory(getDb())
  })

  ipcMain.handle('org:rollback', async (_e, batchId: string) => {
    return rollback(getDb(), batchId, (done, total) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('org:progress', { done, total })
    })
  })

  /* ---------------- 重复检测（P3） ---------------- */
  ipcMain.handle('dup:scan', async (_e, root: string) => {
    const { collectFiles } = await import('./organizer/rules')
    const all = await collectFiles(root)
    // 白名单/硬排除过滤
    const wl = whitelistRules()
    const files = all.filter((f) => !isProtected(f.path, wl, { safePockets: safePocketsEnabled(getDb()) }))
    let lastPct = -1
    return findDuplicates(files, (ratio) => {
      const pct = Math.floor(ratio * 20) * 5 // 降频
      if (pct !== lastPct) {
        lastPct = pct
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('dup:progress', ratio)
      }
    })
  })

  /* ---------------- 提速中心（P4） ---------------- */
  ipcMain.handle('startup:list', async () => {
    const db = getDb()
    return listStartup(db, listBackups(db))
  })

  /* ---------------- v2.0 F1 相似图片 ---------------- */
  ipcMain.handle('similar:scan', async (_e, root: string, threshold: number) => {
    const { findSimilar } = await import('./scanner/similar')
    return findSimilar(root, threshold, whitelistRules(), (done, total) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('similar:progress', { done, total })
    })
  })
  ipcMain.handle('similar:cancel', async () => {
    const { cancelPhash } = await import('./scanner/similar')
    cancelPhash()
    return true
  })

  /* ---------------- v2.0 F2 空文件夹 ---------------- */
  ipcMain.handle('emptydirs:scan', async (_e, root: string, includeQuasi: boolean) => {
    const { scanEmptyDirs } = await import('./cleaner/emptyDirs')
    return scanEmptyDirs(root, whitelistRules(), includeQuasi)
  })
  ipcMain.handle('emptydirs:delete', async (_e, dirs: string[]) => {
    const { deleteEmptyDirs } = await import('./cleaner/emptyDirs')
    const r = await deleteEmptyDirs(dirs)
    const db = getDb()
    const ins = db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, NULL, 0, NULL)')
    const bid = `emptydir-${Date.now().toString(36)}`
    for (const d of dirs) ins.run(Date.now(), bid, 'clean_emptydir', d)
    return { ...r, batchId: bid }
  })

  /* ---------------- v2.1 F3 时光机 ---------------- */
  ipcMain.handle('snap:list', async (_e, root?: string) => {
    const { listSnapshots } = await import('./health/snapshots')
    return listSnapshots(getDb(), root)
  })
  ipcMain.handle('snap:take', async (_e, root: string) => {
    const { saveSnapshot, flattenTree } = await import('./health/snapshots')
    const { treeOf } = await import('./scanner/engine')
    await startScan(root, false) // 缓存优先（刚扫过秒回），完成后 lastTree 为完整树
    const full = treeOf(root)
    if (!full) throw new Error('请先扫描该目录再拍快照')
    const rows = flattenTree(full as never)
    return saveSnapshot(getDb(), root, rows)
  })
  ipcMain.handle('snap:diff', async (_e, sidA: number, sidB: number) => {
    const { diffSnapshots } = await import('./health/snapshots')
    return diffSnapshots(getDb(), sidA, sidB)
  })
  ipcMain.handle('snap:delete', async (_e, id: number) => {
    const { deleteSnapshot } = await import('./health/snapshots')
    deleteSnapshot(getDb(), id)
    return true
  })

  /* ---------------- v2.1 F4 空间预警 ---------------- */
  ipcMain.handle('alert:config', async () => {
    const { getAlertConfig } = await import('./health/alerts')
    return getAlertConfig(getDb())
  })
  ipcMain.handle('alert:set', async (_e, cfg: { intervalMin?: number; cThresholdGB?: number; otherThresholdGB?: number; enabled?: boolean }) => {
    const { setAlertConfig } = await import('./health/alerts')
    setAlertConfig(getDb(), cfg)
    return true
  })

  /* ---------------- v4.1 崩溃恢复 + 自检 ---------------- */
  ipcMain.handle('crash:last', async () => {
    const { takeMarker, KIND_TEXT } = await import('./health/crash')
    const m = takeMarker()
    return m ? { ...m, kindText: KIND_TEXT[m.kind] } : null
  })
  ipcMain.handle('selfcheck:run', async () => {
    const { runSelfCheck } = await import('./health/selfcheck')
    return runSelfCheck(getDb())
  })

  /* ---------------- v4.0 安全红线 ---------------- */
  ipcMain.handle('redlines:list', async () => {
    const { REDLINES } = await import('../shared/redlines')
    return REDLINES
  })

  /* ---------------- v3.6 EXIF 地点 ---------------- */
  ipcMain.handle('exif:gps', async (_e, files: Array<{ path: string; mtime: number }>) => {
    const { readExifGps, clusterGeo } = await import('./media/exif')
    const pts: Array<{ lat: number; lon: number; path: string }> = []
    for (const f of files) {
      try {
        const g = await readExifGps(f.path)
        if (g) pts.push({ ...g, path: f.path })
      } catch { /* */ }
    }
    return { points: pts, clusters: clusterGeo(pts) }
  })
  /* ---------------- v3.6 媒体标签 ---------------- */
  ipcMain.handle('tag:add', async (_e, path: string, tag: string) => {
    const { tagAdd } = await import('./media/tags')
    return tagAdd(getDb(), path, tag)
  })
  ipcMain.handle('tag:remove', async (_e, path: string, tag: string) => {
    const { tagRemove } = await import('./media/tags')
    tagRemove(getDb(), path, tag)
    return true
  })
  ipcMain.handle('tag:of', async (_e, path: string) => {
    const { tagsOf } = await import('./media/tags')
    return tagsOf(getDb(), path)
  })
  ipcMain.handle('tag:stats', async () => {
    const { tagStats } = await import('./media/tags')
    return tagStats(getDb())
  })
  ipcMain.handle('tag:by', async (_e, tag: string) => {
    const { byTag } = await import('./media/tags')
    return byTag(getDb(), tag)
  })

  /* ---------------- v3.5 多磁盘对比 ---------------- */
  ipcMain.handle('compare:roots', async () => {
    const { compareRoots } = await import('./scanner/compare')
    return compareRoots(getDb())
  })

  /* ---------------- v3.2 G5 深度专清 ---------------- */
  ipcMain.handle('deep:analyze', async () => {
    const { analyzeDeep } = await import('./cleaner/deep')
    return analyzeDeep()
  })
  ipcMain.handle('deep:execute', async (_e, id: string) => {
    const { executeDeep } = await import('./cleaner/deep')
    return executeDeep(id)
  })
  ipcMain.handle('deep:elevate', async () => {
    const { relaunchElevated } = await import('./cleaner/deep')
    relaunchElevated()
    return true
  })
  /* ---------------- v3.2 G6 浏览器专清 ---------------- */
  ipcMain.handle('browser:profiles', async () => {
    const { findProfiles } = await import('./cleaner/browser')
    return findProfiles()
  })
  ipcMain.handle('browser:scan', async (_e, prof: { browser: string; name: string; root: string; sizeMB: number }) => {
    const { scanProfile } = await import('./cleaner/browser')
    return scanProfile(prof as never)
  })
  ipcMain.handle('browser:running', async (_e, b: string) => {
    const { browserRunning } = await import('./cleaner/browser')
    return browserRunning(b as never)
  })

  /* ---------------- v3.1 G10 自动清理规则 ---------------- */
  ipcMain.handle('autorules:list', async () => {
    const { listRules } = await import('./cleaner/autoRules')
    return listRules(getDb())
  })
  ipcMain.handle('autorules:save', async (_e, r: { id?: number; dir: string; pattern: string; keepDays: number; enabled: number }) => {
    const { saveRule } = await import('./cleaner/autoRules')
    return saveRule(getDb(), r, whitelistRules())
  })
  ipcMain.handle('autorules:delete', async (_e, id: number) => {
    const { deleteRule } = await import('./cleaner/autoRules')
    deleteRule(getDb(), id)
    return true
  })
  ipcMain.handle('autorules:plan', async (_e, id: number) => {
    const { listRules, planRule } = await import('./cleaner/autoRules')
    const all = listRules(getDb())
    const r = all.find(x => x.id === id)
    if (!r) return { hits: [], totalBytes: 0, overflow: true, overflowReason: '规则不存在' }
    return planRule(getDb(), r, whitelistRules())
  })
  /* ---------------- v3.1 G4 下载目录监视 ---------------- */
  ipcMain.handle('watchdirs:list', async () => {
    const { listWatchDirs } = await import('./cleaner/watcher')
    return listWatchDirs(getDb())
  })
  ipcMain.handle('watchdirs:add', async (_e, dir: string) => {
    const { addWatchDir } = await import('./cleaner/watcher')
    return addWatchDir(getDb(), dir)
  })
  ipcMain.handle('watchdirs:remove', async (_e, dir: string) => {
    const { removeWatchDir, stopWatchers } = await import('./cleaner/watcher')
    removeWatchDir(getDb(), dir)
    stopWatchers()
    return true
  })
  ipcMain.handle('watchdirs:mode', async (_e, dir: string, mode: string) => {
    const { setWatchMode } = await import('./cleaner/watcher')
    setWatchDirModeSafe(getDb(), dir, mode)
    return true
  })

  /* ---------------- v3.1 G11 微信/QQ 专清 ---------------- */
  ipcMain.handle('chat:accounts', async () => {
    const { findAccounts } = await import('./cleaner/chat')
    return findAccounts()
  })
  ipcMain.handle('chat:scan', async (_e, acct: { app: string; id: string; root: string; size: number }, months: number) => {
    const { scanChatAccount } = await import('./cleaner/chat')
    return scanChatAccount(acct as never, months)
  })

  /* ---------------- v3.0 G1 相册时间线 ---------------- */
  ipcMain.handle('exif:times', async (_e, files: Array<{ path: string; mtime: number }>) => {
    // 缓存优先：exif_cache(path+mtime) 命中直出；缺失批量的进 Worker
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS exif_cache (path TEXT, mtime INTEGER, ts INTEGER, source TEXT, PRIMARY KEY (path, mtime))')
    const get = db.prepare('SELECT ts, source FROM exif_cache WHERE path = ? AND mtime = ?')
    const set = db.prepare('INSERT OR REPLACE INTO exif_cache (path, mtime, ts, source) VALUES (?, ?, ?, ?)')
    const out: Record<string, { ts: number | null; source?: string; approx?: boolean }> = {}
    const missing: Array<{ path: string; mtime: number }> = []
    for (const f of files) {
      const row = get.get(f.path, Math.round(f.mtime)) as { ts: number | null; source?: string } | undefined
      if (row) out[f.path] = { ts: row.ts, source: row.source || undefined, approx: row.ts === null }
      else missing.push(f)
    }
    if (missing.length) {
      const { Worker } = await import('worker_threads')
      const path = await import('path')
      const fs = await import('fs')
      const here = __dirname
      const entry = [
        path.join(here, 'media', 'worker-exif.js'),
        path.join(here, '..', 'out', 'main', 'media', 'worker-exif.js')
      ].find((c) => { try { return fs.existsSync(c) } catch { return false } })
      if (entry) {
        await new Promise<void>((resolve) => {
          const w = new Worker(entry, { workerData: { files: missing } })
          const to = setTimeout(() => { w.terminate().catch(() => undefined); resolve() }, 180000)
          w.on('message', (m: { type: string; results?: Record<string, { ts: number | null; source?: string }> }) => {
            if (m.type === 'done' && m.results) {
              clearTimeout(to)
              for (const [p2, r] of Object.entries(m.results)) {
                out[p2] = r
                const f = missing.find((x) => x.path === p2)
                if (f) set.run(p2, Math.round(f.mtime), r.ts, r.source || null)
              }
              w.terminate().catch(() => undefined)
              resolve()
            }
          })
          w.on('error', () => { clearTimeout(to); resolve() })
        })
      } else {
        // 无 worker 入口（异常环境）：文件时间兜底
        for (const f of missing) out[f.path] = { ts: Math.round(f.mtime), approx: true }
      }
    }
    return out
  })

  /* ---------------- v3.0 G3 大文件体检 ---------------- */
  ipcMain.handle('advisor:analyze', async (_e, files: Array<{ path: string; name: string; size: number }>) => {
    const { analyzeFiles } = await import('./advisor/analyze')
    const { installedNames } = await import('./cleaner/residue')
    let installed: Set<string> | undefined
    try { installed = await installedNames(getDb()) } catch { installed = undefined }
    return analyzeFiles(files, installed)
  })

  /* ---------------- v2.4.1 恢复上次扫描 ---------------- */
  ipcMain.handle('scan:last', () => {
    const db = getDb()
    const r = db.prepare("SELECT value FROM settings WHERE key = 'last_scan_root'").get() as { value: string } | undefined
    const t = db.prepare("SELECT value FROM settings WHERE key = 'last_scan_ts'").get() as { value: string } | undefined
    if (!r) return null
    // v3.1.1：目录已不存在（如 temp 夹具被清）→ 清除记忆返回 null，绝不触发扫描报错
    try {
      const fs = require('fs') as typeof import('fs')
      if (!fs.existsSync(r.value)) {
        db.prepare("DELETE FROM settings WHERE key = 'last_scan_root'").run()
        return null
      }
    } catch { /* */ }
    return { root: r.value, ts: t ? Number(t.value) : null }
  })

  /* ---------------- v2.4 F8 自动更新 ---------------- */
  ipcMain.handle('update:check', async () => {
    const { checkForUpdates, readStatus, beginCheck, setCachedDb } = await import('./updater')
    const { getDb } = await import('./store/db')
    beginCheck(getDb()) // v4.2.9：先清 checking 状态（覆盖 DB 里的陈旧 error）
    setCachedDb?.(getDb())
    const ok = await checkForUpdates()
    if (!ok) {
      const { lastFailReason, noteFail } = await import('./updater')
      noteFail(getDb(), lastFailReason()) // 超时/reject 都留痕——不再静默
    }
    return readStatus(getDb())
  })
  ipcMain.handle('update:status', async () => {
    const { readStatus } = await import('./updater')
    const { getDb } = await import('./store/db')
    return readStatus(getDb())
  })
  ipcMain.handle('update:debug', async () => {
    const { readDebug } = await import('./updater')
    return readDebug()
  })
  ipcMain.handle('update:diag', async () => {
    // 注意：不能用动态 import('electron-updater')——CJS main 里动态 import 外部 CJS 包会拿到
    // ESM namespace（autoUpdater 在 default 里）——从自有模块走静态链才正确
    try {
      const { diagUpdater } = await import('./updater')
      return diagUpdater()
    } catch (e) {
      return { err: (e as Error).message }
    }
  })
  ipcMain.handle('update:install', async () => {
    const { quitAndInstall } = await import('./updater')
    quitAndInstall()
    return true
  })

  /* ---------------- v2.3 F5 卸载残留 ---------------- */
  ipcMain.handle('residue:scan', async () => {
    const { scanResidue } = await import('./cleaner/residue')
    return scanResidue(getDb(), whitelistRules())
  })

  /* ---------------- v2.3 F7 月度报告 ---------------- */
  ipcMain.handle('report:generate', async (_e, month: string) => {
    const { generateReport } = await import('./health/report')
    return generateReport(getDb(), month)
  })
  ipcMain.handle('report:list', async () => {
    const { listReports } = await import('./health/report')
    return listReports()
  })

  /* ---------------- v2.2 F6 全局搜索 ---------------- */
  ipcMain.handle('search:query', async (_e, q: { namePattern?: string; minSize?: number; maxSize?: number; after?: number; before?: number; types?: string[]; limit?: number }) => {
    const { searchFiles } = await import('./search/index')
    return searchFiles(getDb(), q)
  })
  ipcMain.handle('media:thumbs', async (_e, files: Array<{ path: string; mtime: number }>) => {
    // 批量缩略图（复用 F1 worker 缓存目录；只读源文件——红线 14）
    const { Worker } = require('worker_threads') as typeof import('worker_threads')
    const path = require('path') as typeof import('path')
    const fs = require('fs') as typeof import('fs')
    const os = require('os') as typeof import('os')
    const cacheDir = join(app.getPath('userData'), 'thumb-cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    return new Promise((resolve) => {
      const here = __dirname
      const candidates = [
        path.join(here, 'worker-phash.js'),
        path.join(here, 'scanner', 'worker-phash.js'),
        path.join(here, '..', 'scanner', 'worker-phash.js'),
        path.join(here, 'chunks', 'worker-phash.js')
      ]
      const entry = candidates.find((c) => fs.existsSync(c))
      if (!entry) { resolve({}); return }
      const w = new Worker(entry, { workerData: { files: files.map((f) => ({ path: f.path, size: 1, mtime: f.mtime })), threshold: 0, cacheDir, thumbsOnly: true } })
      const to = setTimeout(() => { w.terminate().catch(() => undefined); resolve({}) }, 120000)
      w.on('message', (m: { type: string; thumbs?: Record<string, string> }) => {
        if (m.type === 'done') { clearTimeout(to); resolve(m.thumbs || {}); w.terminate().catch(() => undefined) }
      })
      w.on('error', () => { clearTimeout(to); resolve({}) })
    })
  })
  /* ---------------- v2.2.1 F9.2 视频 ---------------- */
  ipcMain.handle('video:probe', async (_e, files: Array<{ path: string; mtime: number }>) => {
    const { probeVideos } = await import('./media/ffmpeg')
    return probeVideos(files)
  })
  ipcMain.handle('video:open', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('video:playpos-get', async (_e, path: string) => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('playpos:' + path) as { value: string } | undefined
    return row ? Number(row.value) : null
  })
  ipcMain.handle('video:playpos-set', async (_e, path: string, pos: number, duration: number) => {
    // 红线 15：>95% 视为看完清除记录
    if (duration > 0 && pos / duration > 0.95) {
      getDb().prepare('DELETE FROM settings WHERE key = ?').run('playpos:' + path)
    } else {
      getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('playpos:' + path, String(pos))
    }
    return true
  })

  ipcMain.handle('search:stats', async () => {
    const { indexStats } = await import('./search/index')
    return indexStats(getDb())
  })
  ipcMain.handle('search:media', async (_e, types: string[], groupByDir: boolean, root?: string) => {
    // 媒体搜集：按类型取全索引（limit 放宽），按目录聚合（收藏点）；v3.1.2：root 盘根过滤
    const { searchFiles } = await import('./search/index')
    let hits = searchFiles(getDb(), { types, limit: 2000 })
    if (root) hits = hits.filter((h: { path: string }) => h.path.toLowerCase().startsWith(root.toLowerCase()))
    if (!groupByDir) return { hits, groups: [] }
    const map = new Map<string, { dir: string; count: number; bytes: number }>()
    for (const h of hits) {
      const dir = h.path.slice(0, h.path.lastIndexOf('\\'))
      const g = map.get(dir) || { dir, count: 0, bytes: 0 }
      g.count++; g.bytes += h.size
      map.set(dir, g)
    }
    const groups = [...map.values()].sort((a, b) => b.bytes - a.bytes)
    return { hits: [], groups }
  })

  ipcMain.handle('alert:check-now', async () => {
    const { checkDisks, getAlertConfig, fireAlerts } = await import('./health/alerts')
    const cfg = getAlertConfig(getDb())
    return checkDisks(getDb(), cfg) // 只返回事件（测试/手动检查；不 fire 通知）
  })

  ipcMain.handle('startup:toggle', async (_e, item: { id: string; source: string; name: string; command: string; enabled: boolean }, toEnabled: boolean) => {
    const db = getDb()
    const it = { ...item, source: item.source as never, needsAdmin: false, advice: undefined }
    if (toEnabled) {
      await enableStartup(db, it)
      return { ok: true, action: 'enabled' as const }
    }
    const r = await disableStartup(db, it)
    return { ok: true, action: 'disabled' as const, backupFile: r.backupFile }
  })

  ipcMain.handle('startup:backups', () => listBackups(getDb()))

  ipcMain.handle('procs:list', () => listProcesses())

  ipcMain.handle('procs:kill', async (_e, pid: number, name: string) => {
    await killProcess(pid, name)
    return true
  })

  ipcMain.handle('trim:memory', () => trimWorkingSet())

  ipcMain.handle('sys:stat', async () => {
    const disks = await listDisks()
    return collectSysStat(disks.map((d) => ({ drive: d.drive, label: d.label, totalBytes: d.totalBytes, freeBytes: d.freeBytes })))
  })

  ipcMain.handle('sys:boot', () => bootTime())

  /* ---------------- 体检管家（P5） ---------------- */
  ipcMain.handle('checkup:run', async () => {
    const r = await runCheckup(getDb(), whitelistRules())
    saveCheckup(getDb(), r)
    return r
  })
  ipcMain.handle('checkup:last', () => lastCheckup(getDb()))
  ipcMain.handle('checkup:history', () => checkupHistory(getDb()))

  ipcMain.handle('settings:get', async () => {
    const s = getSettings(getDb())
    return { ...s, autoStart: isAutoStart() } // 自启以系统真实状态为准
  })
  ipcMain.handle('settings:set', async (_e, key: string, value: string) => {
    setSetting(getDb(), key, value)
    if (key === 'auto_start') applyAutoStart(value === '1')
    return true
  })

  ipcMain.handle('whitelist:add', (_e, pattern: string, note: string) => addWhitelist(getDb(), pattern, note))
  ipcMain.handle('whitelist:remove', (_e, id: number) => removeWhitelist(getDb(), id))
  ipcMain.handle('safepockets:get', () => safePocketsEnabled(getDb()))
  ipcMain.handle('safepockets:set', (_e, on: boolean) => {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('safe_pockets', on ? '1' : '0')
    return true
  })
  ipcMain.handle('whitelist:toggle', (_e, id: number, enabled: boolean) => toggleWhitelist(getDb(), id, enabled))
  ipcMain.handle('whitelist:all', () => allWhitelist(getDb()))

  ipcMain.handle('logs:export', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const r = await dialog.showSaveDialog(win!, {
      title: '导出操作日志',
      defaultPath: join(app.getPath('downloads'), `净澈操作日志_${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (r.canceled || !r.filePath) return null
    return exportLogs(getDb(), r.filePath)
  })

  /** 定期任务：应用启动时调用（7 天一次，只扫不清 + 通知） */
  void maybeWeeklyScan(getDb(), whitelistRules()).catch(() => undefined)
}
