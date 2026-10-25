export interface CsBridge {
  appVersion: () => Promise<string>
  dbStatus: () => Promise<{ ok: boolean; tables: string[] }>
  whitelist: () => Promise<Array<{ id: number; pattern: string; enabled: boolean; builtin: boolean; note?: string }>>
  whitelistCheck: (paths: string[]) => Promise<boolean[]>

  disks: () => Promise<Array<{ drive: string; label: string; totalBytes: number; freeBytes: number; fsType: string }>>
  ensureDir: (p: string) => Promise<boolean>

  scanStart: (rootPath: string, force: boolean) => Promise<{
    root: import('@shared/scanner-types').DirNode
    stats: import('@shared/scanner-types').ScanStats
    topFiles: import('@shared/scanner-types').FileEntry[]
    cached: boolean
  }>
  scanCancelAll: () => Promise<boolean>
  onScanProgress: (cb: (p: { taskId: string; phase: string; msg?: string }) => void) => () => void

  showItem: (p: string) => Promise<boolean>
  pendingList: () => Promise<Array<{ path: string; isDir: boolean; addedAt: number }>>
  pendingAdd: (path: string, isDir: boolean) => Promise<Array<{ path: string; isDir: boolean; addedAt: number }>>
  pendingRemove: (path: string) => Promise<Array<{ path: string; isDir: boolean; addedAt: number }>>
  pendingClear: () => Promise<Array<{ path: string; isDir: boolean; addedAt: number }>>

  junkScan: () => Promise<{
    groups: Array<{
      ruleId: string; name: string; desc: string; risk: 'safe' | 'caution' | 'expert'; consequence?: string
      files: Array<{ path: string; size: number; mtime: number }>; totalBytes: number; note?: string
    }>
    totalBytes: number; totalFiles: number; durationMs: number; hardExcludedCount: number
  }>
  junkClean: (files: Array<{ path: string; size: number; mtime: number }>, confirmLevel: string) => Promise<{
    batchId: string; cleaned: number; failed: number; freedBytes: number; undoable: boolean
    errors: Array<{ path: string; message: string }>
  }>
  junkUndo: (batchId: string) => Promise<{ ok: number; fail: number }>
  junkDestroy: (batchId: string) => Promise<number>
  junkThresholds: () => Promise<{ BIG_BYTES: number; BIG_FILES: number }>
  recycleList: () => Promise<Array<{ id: number; batch_id: string; recycled_path: string; orig_path: string; size: number; ts: number; expires_at: number; restored: number }>>
  recycleRestore: (batchId: string) => Promise<{ ok: number; fail: number }>
  recyclePurge: (batchId: string) => Promise<number>
  recyclePurgeMany: (batchIds: string[]) => Promise<number>
  recyclePurgeAll: () => Promise<number>
  sysRecycleStats: () => Promise<{ files: number; bytes: number }>
  sysRecycleClear: () => Promise<{ ok: boolean; error?: string }>

  orgRules: () => Promise<Array<{ id: number; kind: string; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }>>
  orgRuleSave: (rule: { id?: number; kind: string; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }) => Promise<number>
  orgRuleDelete: (id: number) => Promise<boolean>
  orgPlan: (sourceRoot: string, targetRoot: string, keepRelative: boolean) => Promise<{
    items: Array<{ src: string; dst: string; size: number; mtime: number; ruleId: number; reason: string }>
    skipped: Array<{ path: string; reason: string }>
    totalBytes: number
  }>
  orgExecute: (items: Array<{ src: string; dst: string; size: number; mtime: number; ruleId: number; reason: string }>) => Promise<{
    batchId: string; moved: number; failed: number; movedMap: Array<{ src: string; dst: string }>; errors: Array<{ src: string; message: string }>
  }>
  orgRollback: (batchId: string) => Promise<{ ok: number; fail: number; errors: string[] }>
  onOrgProgress: (cb: (p: { done: number; total: number }) => void) => () => void
  dupScan: (root: string) => Promise<{
    groups: Array<{ hash: string; size: number; files: Array<{ path: string; size: number; mtime: number }>; wasteBytes: number }>
    wasteBytes: number; scanned: number; durationMs: number
  }>
  onDupProgress: (cb: (r: number) => void) => () => void

  /* v2.4 F8 自动更新（DashboardView 使用） */
  updateCheck: () => Promise<{ state: string; version?: string; progress?: number; error?: string; ts?: number } | null>
  updateStatus: () => Promise<{ state: string; version?: string; progress?: number; error?: string; ts?: number } | null>
  updateInstall: () => Promise<boolean>
  updateDebug: () => Promise<string[]>
  updateDiag: () => Promise<Record<string, unknown> | null> | null
  onUpdateStatus: (cb: (s: { state: string; version?: string; progress?: number; error?: string }) => void) => (() => void) | undefined
}

declare global {
  interface Window {
    cs?: CsBridge
  }
}

export {}
