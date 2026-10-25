/**
 * 下载目录自动整理（v3.1 / G4）
 * fs.watch recursive + 30s 去抖；三档模式（report/auto/off）；未完成文件绝不碰。
 * 红线 15：监视目录白名单化（用户逐个添加）；移动走日志可回滚。
 */
import type Database from 'better-sqlite3'
import { watch, type FSWatcher } from 'fs'
import { readdir, stat, rename, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { classifyForMove } from './classhelpers'

export type WatchMode = 'report' | 'auto' | 'off'

/** 未完成下载特征（红线 15：绝不触碰） */
export const INCOMPLETE_EXT = ['.crdownload', '.part', '.tmp', '.downloading', '.partial', '.download']

export function isIncomplete(name: string): boolean {
  const ln = name.toLowerCase()
  return INCOMPLETE_EXT.some((e) => ln.endsWith(e))
}

/** 单文件上限 2GB：超过进待人工不移动 */
export const MAX_FILE = 2 * 1024 ** 3

export interface WatchDir {
  id?: number
  dir: string
  mode: WatchMode
}

export function ensureWatchDirs(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS watch_dirs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dir TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'report'
  )`)
}

export function listWatchDirs(db: Database.Database): WatchDir[] {
  ensureWatchDirs(db)
  return db.prepare('SELECT id, dir, mode FROM watch_dirs').all() as never
}

export function addWatchDir(db: Database.Database, dir: string, mode: WatchMode = 'report'): boolean {
  ensureWatchDirs(db)
  try { db.prepare('INSERT INTO watch_dirs (dir, mode) VALUES (?, ?)').run(dir, mode); return true } catch { return false }
}
export function removeWatchDir(db: Database.Database, dir: string): void {
  db.prepare('DELETE FROM watch_dirs WHERE dir = ?').run(dir)
}
export function setWatchMode(db: Database.Database, dir: string, mode: WatchMode): void {
  db.prepare('UPDATE watch_dirs SET mode = ? WHERE dir = ?').run(mode, dir)
}

/* ---------------- 去抖调度 ---------------- */
interface Pending { timer: NodeJS.Timeout; files: Set<string> }
const pending = new Map<string, Pending>()

/** 文件事件入队（30s 去抖：浏览器 .crdownload→改名 完成后才开始处理） */
export function enqueue(dir: string, file: string, onBatch: (dir: string, files: string[]) => Promise<void>, debounceMs = 30_000): void {
  if (isIncomplete(file)) return // 红线 15：未完成文件连队列都不进
  const p = pending.get(dir) || { timer: null as never, files: new Set<string>() }
  p.files.add(join(dir, file))
  clearTimeout(p.timer)
  p.timer = setTimeout(() => {
    const files = [...p.files]
    p.files.clear()
    pending.delete(dir)
    void onBatch(dir, files)
  }, debounceMs)
  pending.set(dir, p)
}

/* ---------------- 归档执行 ---------------- */
export interface MoveResult {
  moved: Array<{ from: string; to: string }>
  skipped: Array<{ file: string; reason: string }>
  manualPending: string[]
}

/** 目标路径：{dir}/已整理/{类型}/文件名（冲突 -1 后缀） */
export async function archiveFile(dir: string, file: string): Promise<{ from: string; to: string } | { skip: string; reason: string }> {
  try {
    const s = await stat(file)
    if (s.size > MAX_FILE) return { skip: file, reason: '超过 2GB，转人工处理' }
    const typeDir = classifyForMove(file)
    const destDir = join(dir, '已整理', typeDir)
    await mkdir(destDir, { recursive: true })
    let dest = join(destDir, file.split(/[\\/]/).pop()!)
    let i = 1
    while (await exists(dest)) {
      const nm = file.split(/[\\/]/).pop()!
      const dot = nm.lastIndexOf('.')
      dest = join(destDir, dot > 0 ? `${nm.slice(0, dot)}-${i}${nm.slice(dot)}` : `${nm}-${i}`)
      i++
    }
    await rename(file, dest)
    return { from: file, to: dest }
  } catch (e) {
    return { skip: file, reason: (e as Error).message }
  }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

/** 批处理（auto 模式直接归档；report 模式只生成建议） */
export async function processBatch(dir: string, files: string[], mode: WatchMode): Promise<MoveResult & { suggestions?: string[] }> {
  if (mode === 'off') return { moved: [], skipped: [], manualPending: [] }
  const out: MoveResult = { moved: [], skipped: [], manualPending: [] }
  const suggestions: string[] = []
  for (const f of files) {
    if (isIncomplete(f.split(/[\\/]/).pop() || '')) continue
    if (mode === 'report') { suggestions.push(f); continue }
    const r = await archiveFile(dir, f)
    if ('from' in r) out.moved.push(r)
    else if (r.reason.includes('人工')) out.manualPending.push(r.skip)
    else out.skipped.push(r)
  }
  return { ...out, suggestions }
}

/* ---------------- Watcher 生命周期 ---------------- */
const watchers = new Map<string, FSWatcher>()

export function startWatchers(db: Database.Database, onMove: (moved: Array<{ from: string; to: string }>) => void): void {
  stopWatchers()
  for (const w of listWatchDirs(db)) {
    if (w.mode === 'off') continue
    try {
      const fw = watch(w.dir, { recursive: true }, (_evt, file) => {
        if (typeof file === 'string') enqueue(w.dir, file, async (dir, files) => {
          const r = await processBatch(dir, files, w.mode)
          if (r.moved.length && onMove) onMove(r.moved)
        })
      })
      watchers.set(w.dir, fw)
    } catch { /* 目录不存在 */ }
  }
}

export function stopWatchers(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
}
