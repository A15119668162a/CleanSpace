import { contextBridge, ipcRenderer } from 'electron'
import type { DirNode, FileEntry, ScanStats } from '@shared/scanner-types'

/**
 * v4.2.1：IPC 参数净化器——剥离 Vue 响应式代理（Proxy 不可结构化克隆，
 * 直传报 "An object could not be cloned"）。带对象参数的 invoke 统一过此网。
 */
function P<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => P(x)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>)) {
    out[k] = P((v as Record<string, unknown>)[k])
  }
  return out as T
}

export interface DiskInfo { drive: string; label: string; totalBytes: number; freeBytes: number; fsType: string }
export interface PendingItem { path: string; isDir: boolean; addedAt: number }
export type RiskLevel = 'safe' | 'caution' | 'expert'
export interface JunkFile { path: string; size: number; mtime: number }
export interface JunkGroup { ruleId: string; name: string; desc: string; risk: RiskLevel; consequence?: string; files: JunkFile[]; totalBytes: number; note?: string }
export interface JunkScanResult { groups: JunkGroup[]; totalBytes: number; totalFiles: number; durationMs: number; hardExcludedCount: number }
export interface CleanReport { batchId: string; cleaned: number; failed: number; freedBytes: number; undoable: boolean; errors: Array<{ path: string; message: string }> }

const api = {
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  dbStatus: (): Promise<{ ok: boolean; tables: string[] }> => ipcRenderer.invoke('app:db-status'),
  whitelist: (): Promise<Array<{ id: number; pattern: string; enabled: boolean; builtin: boolean; note?: string }>> =>
    ipcRenderer.invoke('whitelist:list'),
  whitelistCheck: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('whitelist:check', paths),

  disks: (): Promise<DiskInfo[]> => ipcRenderer.invoke('disks:list'),
  ensureDir: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:ensureDir', p),

  scanStart: (rootPath: string, force: boolean): Promise<{ root: DirNode; stats: ScanStats; topFiles: FileEntry[]; cached: boolean }> =>
    ipcRenderer.invoke('scan:start', rootPath, force),
  scanChildren: (path: string): Promise<{ node: { path: string; name: string; size: number; isDir: boolean; fileCount: number; dirCount: number }; children: Array<{ path: string; name: string; size: number; isDir: boolean; fileCount: number; dirCount: number }> } | null> =>
    ipcRenderer.invoke('scan:children', path),
  scanCancelAll: (): Promise<boolean> => ipcRenderer.invoke('scan:cancelAll'),
  onScanProgress: (cb: (p: { taskId: string; phase: string; msg?: string }) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, p: { taskId: string; phase: string; msg?: string }): void => cb(p)
    ipcRenderer.on('scan:progress', l)
    return () => ipcRenderer.removeListener('scan:progress', l)
  },

  showItem: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:showItem', p),
  pendingList: (): Promise<PendingItem[]> => ipcRenderer.invoke('pending:list'),
  pendingAdd: (path: string, isDir: boolean): Promise<PendingItem[]> => ipcRenderer.invoke('pending:add', path, isDir),
  pendingRemove: (path: string): Promise<PendingItem[]> => ipcRenderer.invoke('pending:remove', path),
  pendingClear: (): Promise<PendingItem[]> => ipcRenderer.invoke('pending:clear'),

  /* 垃圾清扫（P2） */
  junkScan: (): Promise<JunkScanResult> => ipcRenderer.invoke('junk:scan'),
  junkClean: (files: Array<{ path: string; size: number; mtime: number }>, confirmLevel: string): Promise<CleanReport> =>
    ipcRenderer.invoke('junk:clean', P(files), confirmLevel),
  junkUndo: (batchId: string): Promise<{ ok: number; fail: number }> => ipcRenderer.invoke('junk:undo', batchId),
  junkDestroy: (batchId: string): Promise<number> => ipcRenderer.invoke('junk:destroy', batchId),
  junkThresholds: (): Promise<{ BIG_BYTES: number; BIG_FILES: number }> => ipcRenderer.invoke('junk:thresholds'),

  /* 回收站（P2） */
  recycleList: (): Promise<Array<{ id: number; batch_id: string; recycled_path: string; orig_path: string; size: number; ts: number; expires_at: number; restored: number }>> =>
    ipcRenderer.invoke('recycle:list'),
  recycleRestore: (batchId: string): Promise<{ ok: number; fail: number }> => ipcRenderer.invoke('recycle:restore', batchId),
  recyclePurge: (batchId: string): Promise<number> => ipcRenderer.invoke('recycle:purge', batchId),
  /* v4.2.8 永久删除增强 */
  recyclePurgeMany: (batchIds: string[]): Promise<number> => ipcRenderer.invoke('recycle:purge-many', batchIds),
  recyclePurgeAll: (): Promise<number> => ipcRenderer.invoke('recycle:purge-all'),
  sysRecycleStats: (): Promise<{ files: number; bytes: number }> => ipcRenderer.invoke('sys:recycle-stats'),
  sysRecycleClear: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('sys:recycle-clear'),

  /* 智能整理（P3） */
  orgRules: (): Promise<Array<{ id: number; kind: string; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }>> =>
    ipcRenderer.invoke('org:rules'),
  orgRuleSave: (rule: { id?: number; kind: string; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }): Promise<number> =>
    ipcRenderer.invoke('org:rule-save', rule),
  orgRuleDelete: (id: number): Promise<boolean> => ipcRenderer.invoke('org:rule-delete', id),
  orgPlan: (sourceRoot: string, targetRoot: string, keepRelative: boolean): Promise<{
    items: Array<{ src: string; dst: string; size: number; mtime: number; ruleId: number; reason: string }>
    skipped: Array<{ path: string; reason: string }>
    totalBytes: number
  }> => ipcRenderer.invoke('org:plan', sourceRoot, targetRoot, keepRelative),
  orgSuggest: (sourceRoot: string): Promise<{
    suggestedRoot: string
    profile: Array<{ category: string; bytes: number; files: number; topFile?: string; topSize?: number }>
    totalBytes: number
    files: number
  }> => ipcRenderer.invoke('org:suggest', sourceRoot),
  orgExecute: (items: Array<{ src: string; dst: string; size: number; mtime: number; ruleId: number; reason: string }>): Promise<{
    batchId: string; moved: number; failed: number; movedMap: Array<{ src: string; dst: string }>; errors: Array<{ src: string; message: string }>
  }> => ipcRenderer.invoke('org:execute', items),
  orgRollback: (batchId: string): Promise<{ ok: number; fail: number; errors: string[] }> => ipcRenderer.invoke('org:rollback', batchId),
  onOrgProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, p: { done: number; total: number }): void => cb(p)
    ipcRenderer.on('org:progress', l)
    return () => ipcRenderer.removeListener('org:progress', l)
  },

  /* 重复检测（P3） */
  dupScan: (root: string): Promise<{
    groups: Array<{ hash: string; size: number; files: Array<{ path: string; size: number; mtime: number }>; wasteBytes: number }>
    wasteBytes: number; scanned: number; durationMs: number
  }> => ipcRenderer.invoke('dup:scan', root),
  onDupProgress: (cb: (r: number) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, r: number): void => cb(r)
    ipcRenderer.on('dup:progress', l)
    return () => ipcRenderer.removeListener('dup:progress', l)
  },

  /* 提速中心（P4） */
  startupList: (): Promise<Array<{
    id: string; source: string; name: string; command: string; enabled: boolean
    advice?: string; needsAdmin: boolean; backupFile?: string
  }>> => ipcRenderer.invoke('startup:list'),
  startupToggle: (item: { id: string; source: string; name: string; command: string; enabled: boolean }, toEnabled: boolean): Promise<{ ok: boolean; action: 'enabled' | 'disabled'; backupFile?: string }> =>
    ipcRenderer.invoke('startup:toggle', item, toEnabled),
  procsList: (): Promise<Array<{ pid: number; name: string; memBytes: number; safeToKill: boolean }>> =>
    ipcRenderer.invoke('procs:list'),
  procsKill: (pid: number, name: string): Promise<boolean> => ipcRenderer.invoke('procs:kill', pid, name),
  trimMemory: (): Promise<{ trimmed: number; skipped: number }> => ipcRenderer.invoke('trim:memory'),
  sysStat: (): Promise<{
    uptimeMs: number | null
    cpu: { model: string; usage: number; cores: number }
    mem: { totalBytes: number; usedBytes: number; usage: number }
    disks: Array<{ drive: string; label: string; totalBytes: number; freeBytes: number; health: string | null }>
  }> => ipcRenderer.invoke('sys:stat'),

  /* v2.0 F1 相似图片 */
  similarScan: (root: string, threshold: number): Promise<{
    hashed: number; durationMs: number
    groups: Array<Array<{ path: string; size: number; mtime: number }>>
    thumbs: Record<string, string>
  }> => ipcRenderer.invoke('similar:scan', root, threshold),
  similarCancel: (): Promise<boolean> => ipcRenderer.invoke('similar:cancel'),
  onSimilarProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, p: { done: number; total: number }): void => cb(p)
    ipcRenderer.on('similar:progress', l)
    return () => ipcRenderer.removeListener('similar:progress', l)
  },

  /* v2.0 F2 空文件夹 */
  emptydirsScan: (root: string, includeQuasi: boolean): Promise<{
    dirs: Array<{ path: string; quasi: boolean; fileCount: number; size: number }>
    totalBytes: number; skippedByAttr: number; durationMs: number
  }> => ipcRenderer.invoke('emptydirs:scan', root, includeQuasi),
  emptydirsDelete: (dirs: string[]): Promise<{ ok: number; fail: Array<{ path: string; reason: string }>; batchId: string }> =>
    ipcRenderer.invoke('emptydirs:delete', dirs),

  /* v2.1 F3 时光机 */
  snapList: (root?: string): Promise<Array<{ id: number; ts: number; root: string; totalBytes: number; fileCount: number; dirCount: number }>> =>
    ipcRenderer.invoke('snap:list', root),
  snapTake: (root: string): Promise<number> => ipcRenderer.invoke('snap:take', root),
  snapDiff: (sidA: number, sidB: number): Promise<{
    grow: Array<{ path: string; delta: number; fromSize: number; toSize: number; kind: string }>
    shrink: Array<{ path: string; delta: number; fromSize: number; toSize: number; kind: string }>
    newDirs: Array<{ path: string; delta: number; kind: string }>
    goneDirs: Array<{ path: string; delta: number; kind: string }>
  }> => ipcRenderer.invoke('snap:diff', sidA, sidB),
  snapDelete: (id: number): Promise<boolean> => ipcRenderer.invoke('snap:delete', id),

  /* v2.1 F4 空间预警 */
  alertConfig: (): Promise<{ intervalMin: number; cThresholdGB: number; otherThresholdGB: number; enabled: boolean }> =>
    ipcRenderer.invoke('alert:config'),
  alertSet: (cfg: { intervalMin?: number; cThresholdGB?: number; otherThresholdGB?: number; enabled?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('alert:set', cfg),
  alertCheckNow: (): Promise<Array<{ drive: string; freeGB: number; thresholdGB: number }>> =>
    ipcRenderer.invoke('alert:check-now'),

  /* v2.2 F6 全局搜索 + 媒体 */
  searchQuery: (q: { namePattern?: string; minSize?: number; maxSize?: number; after?: number; before?: number; types?: string[]; limit?: number }): Promise<Array<{ path: string; name: string; size: number; mtime: number; type: string }>> =>
    ipcRenderer.invoke('search:query', q),
  searchStats: (): Promise<{ files: number; roots: string[]; indexedAt: number | null }> => ipcRenderer.invoke('search:stats'),
  searchMedia: (types: string[], groupByDir: boolean, root?: string): Promise<{ hits: Array<{ path: string; name: string; size: number; mtime: number; type: string }>; groups: Array<{ dir: string; count: number; bytes: number }> }> =>
    ipcRenderer.invoke('search:media', P(types), groupByDir, root),
  mediaThumbs: (files: Array<{ path: string; mtime: number }>): Promise<Record<string, string>> => ipcRenderer.invoke('media:thumbs', P(files)),

  /* v2.2.1 F9.2 视频 */
  videoProbe: (files: Array<{ path: string; mtime: number }>): Promise<Record<string, { thumb?: string; durationSec?: number; width?: number; height?: number }>> =>
    ipcRenderer.invoke('video:probe', files),
  videoOpen: (path: string): Promise<string> => ipcRenderer.invoke('video:open', path),
  videoPlayposGet: (path: string): Promise<number | null> => ipcRenderer.invoke('video:playpos-get', path),
  videoPlayposSet: (path: string, pos: number, duration: number): Promise<boolean> => ipcRenderer.invoke('video:playpos-set', path, pos, duration),

  /* v2.3 F5 卸载残留 + F7 报告 */
  residueScan: (): Promise<{
    items: Array<{ path: string; size: number; files: number; mtime: number; guess: string }>
    totalBytes: number; installedCount: number; durationMs: number
  }> => ipcRenderer.invoke('residue:scan'),
  reportGenerate: (month: string): Promise<string> => ipcRenderer.invoke('report:generate', month),
  reportList: (): Promise<Array<{ month: string; file: string }>> => ipcRenderer.invoke('report:list'),

  /* v4.1 崩溃恢复 + 自检 */
  /* v4.2.5 整理台账 */
  orgRecent: (): Promise<Array<{ id: number; batch_id: string; ts: number; kind: string; items: number; status: string }>> => ipcRenderer.invoke('org:recent'),
  orgHistory: (): Promise<Array<{ id: number; batch_id: string; ts: number; kind: string; items: number; status: string }>> => ipcRenderer.invoke('org:history'),

  /* v4.2.4 目录选择 + 清理进度 */
  pickDir: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir', title),
  onCleanProgress: (cb: (p: { done: number; total: number; phase: string }) => void): (() => void) => {
    const h = (_e: unknown, p: { done: number; total: number; phase: string }): void => cb(p)
    ipcRenderer.on('clean:progress', h)
    return () => ipcRenderer.removeListener('clean:progress', h)
  },

  /* v4.2.2 安全口袋开关 */
  safePocketsGet: (): Promise<boolean> => ipcRenderer.invoke('safepockets:get'),
  safePocketsSet: (on: boolean): Promise<boolean> => ipcRenderer.invoke('safepockets:set', on),

  crashLast: (): Promise<{ version: string; ts: number; kind: string; summary: string; kindText: string } | null> => ipcRenderer.invoke('crash:last'),
  selfcheckRun: (): Promise<Array<{ id: string; label: string; ok: boolean; note?: string }>> => ipcRenderer.invoke('selfcheck:run'),

  /* v4.0 安全红线 */
  redlinesList: (): Promise<Array<{ no: number; title: string; plain: string; guard: string; since: string }>> => ipcRenderer.invoke('redlines:list'),

  /* v3.6 EXIF 地点 */
  exifGps: (files: Array<{ path: string; mtime: number }>): Promise<{ points: Array<{ lat: number; lon: number; path: string }>; clusters: Array<{ lat: number; lon: number; items: string[] }> }> => ipcRenderer.invoke('exif:gps', P(files)),
  /* v3.6 媒体标签 */
  tagAdd: (path: string, tag: string): Promise<boolean> => ipcRenderer.invoke('tag:add', path, tag),
  tagRemove: (path: string, tag: string): Promise<boolean> => ipcRenderer.invoke('tag:remove', path, tag),
  tagsOf: (path: string): Promise<string[]> => ipcRenderer.invoke('tag:of', path),
  tagStats: (): Promise<Array<{ tag: string; count: number }>> => ipcRenderer.invoke('tag:stats'),
  tagBy: (tag: string): Promise<string[]> => ipcRenderer.invoke('tag:by', tag),

  /* v3.5 多磁盘对比 */
  compareRoots: (): Promise<Array<{ root: string; totalBytes: number; fileCount: number; dirCount: number; lastScanTs: number | null; topTypes: Array<{ type: string; bytes: number; files: number }> }>> => ipcRenderer.invoke('compare:roots'),

  /* v3.2 G5 深度专清 */
  deepAnalyze: (): Promise<{ admin: boolean; winSxS: { supported: boolean; actualSizeGB: number | null; reclaimableGB: number | null; raw?: string }; restorePoints: { count: number; totalGB: number | null }; hiberfil: { present: boolean; sizeGB: number | null }; pagefile: { present: boolean; sizeGB: number | null }; dump: { present: boolean; sizeGB: number | null; path?: string } }> => ipcRenderer.invoke('deep:analyze'),
  deepExecute: (id: string): Promise<{ ok: boolean; output: string; command: string }> => ipcRenderer.invoke('deep:execute', id),
  deepElevate: (): Promise<boolean> => ipcRenderer.invoke('deep:elevate'),
  /* v3.2 G6 浏览器专清 */
  browserProfiles: (): Promise<Array<{ browser: string; name: string; root: string; sizeMB: number }>> => ipcRenderer.invoke('browser:profiles'),
  browserScan: (prof: { browser: string; name: string; root: string; sizeMB: number }): Promise<Array<{ path: string; size: number; mtime: number; zone: string; level: string; what: string }>> => ipcRenderer.invoke('browser:scan', P(prof)),
  browserRunning: (b: string): Promise<boolean> => ipcRenderer.invoke('browser:running', b),

  /* v3.1 G10 自动清理规则 */
  autoRulesList: (): Promise<Array<{ id: number; dir: string; pattern: string; keepDays: number; enabled: number; builtin: number; note?: string }>> => ipcRenderer.invoke('autorules:list'),
  autoRulesSave: (r: { id?: number; dir: string; pattern: string; keepDays: number; enabled: number }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('autorules:save', r),
  autoRulesDelete: (id: number): Promise<boolean> => ipcRenderer.invoke('autorules:delete', id),
  autoRulesPlan: (id: number): Promise<{ hits: Array<{ ruleId: number; path: string; size: number; mtime: number }>; totalBytes: number; overflow: boolean; overflowReason?: string }> => ipcRenderer.invoke('autorules:plan', id),
  /* v3.1 G4 下载监视 */
  watchDirsList: (): Promise<Array<{ id: number; dir: string; mode: string }>> => ipcRenderer.invoke('watchdirs:list'),
  watchDirsAdd: (dir: string): Promise<boolean> => ipcRenderer.invoke('watchdirs:add', dir),
  watchDirsRemove: (dir: string): Promise<boolean> => ipcRenderer.invoke('watchdirs:remove', dir),
  watchDirsMode: (dir: string, mode: string): Promise<boolean> => ipcRenderer.invoke('watchdirs:mode', dir, mode),

  /* v3.1 G11 微信/QQ 专清 */
  chatAccounts: (): Promise<Array<{ app: string; id: string; root: string; size: number }>> => ipcRenderer.invoke('chat:accounts'),
  chatScan: (acct: { app: string; id: string; root: string; size: number }, months: number): Promise<Array<{ path: string; size: number; mtime: number; zone: string; level: string; what: string; session?: string }>> =>
    ipcRenderer.invoke('chat:scan', acct, months),

  /* v3.0 G1 相册时间线 */
  exifTimes: (files: Array<{ path: string; mtime: number }>): Promise<Record<string, { ts: number | null; source?: string; approx?: boolean }>> =>
    ipcRenderer.invoke('exif:times', files),

  /* v3.0 G3 大文件体检 */
  advisorAnalyze: (files: Array<{ path: string; name: string; size: number }>): Promise<Record<string, { what: string; advice: string; why: string; kbId?: string; generic?: boolean }>> =>
    ipcRenderer.invoke('advisor:analyze', files),

  /* v2.4.1 恢复上次扫描 */
  scanLast: (): Promise<{ root: string; ts: number | null } | null> => ipcRenderer.invoke('scan:last'),

  /* v2.4 F8 自动更新 */
  updateCheck: (): Promise<{ state: string; version?: string; progress?: number; error?: string; ts?: number } | null> =>
    ipcRenderer.invoke('update:check'),
  updateStatus: (): Promise<{ state: string; version?: string; progress?: number; error?: string; ts?: number } | null> =>
    ipcRenderer.invoke('update:status'),
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
  updateDebug: (): Promise<string[]> => ipcRenderer.invoke('update:debug'),
  updateDiag: (): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('update:diag').catch(() => null),
  onUpdateStatus: (cb: (s: { state: string; version?: string; progress?: number; error?: string }) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, s: { state: string; version?: string; progress?: number; error?: string }): void => cb(s)
    ipcRenderer.on('update:status', l)
    return () => ipcRenderer.removeListener('update:status', l)
  },

  /* 体检管家（P5） */
  checkupRun: (): Promise<{
    score: number; ts: number
    dimensions: Array<{ id: string; name: string; score: number; display: string; advice: string; fix: string }>
  }> => ipcRenderer.invoke('checkup:run'),
  checkupLast: (): Promise<{ score: number; ts: number; dimensions: Array<{ id: string; name: string; score: number; display: string; advice: string; fix: string }> } | null> =>
    ipcRenderer.invoke('checkup:last'),
  checkupHistory: (): Promise<Array<{ ts: number; score: number }>> => ipcRenderer.invoke('checkup:history'),
  settingsGet: (): Promise<{ recycleKeepDays: number; autoStart: boolean; weeklyScan: boolean; closeToTray: boolean; language: string }> =>
    ipcRenderer.invoke('settings:get'),
  settingsSet: (key: string, value: string): Promise<boolean> => ipcRenderer.invoke('settings:set', key, value),
  whitelistAdd: (pattern: string, note: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('whitelist:add', pattern, note),
  whitelistRemove: (id: number): Promise<boolean> => ipcRenderer.invoke('whitelist:remove', id),
  whitelistToggle: (id: number, enabled: boolean): Promise<boolean> => ipcRenderer.invoke('whitelist:toggle', id, enabled),
  whitelistAll: (): Promise<Array<{ id: number; pattern: string; enabled: boolean; builtin: boolean; note?: string }>> =>
    ipcRenderer.invoke('whitelist:all'),
  logsExport: (): Promise<{ rows: number } | null> => ipcRenderer.invoke('logs:export'),
  onNavigate: (cb: (page: string) => void): (() => void) => {
    const l = (_e: Electron.IpcRendererEvent, p: string): void => cb(p)
    ipcRenderer.on('navigate', l)
    return () => ipcRenderer.removeListener('navigate', l)
  }
}

contextBridge.exposeInMainWorld('cs', api)
export type CsApi = typeof api
