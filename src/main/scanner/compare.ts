/**
 * 多磁盘横向对比（v3.5 / 备选池）
 * 数据源：scan_cache_v3 各已扫描根聚合（目录行+文件行都在缓存表）。
 * 只读聚合，零新增扫描。
 */
import type Database from 'better-sqlite3'

export interface RootCompare {
  root: string
  totalBytes: number
  fileCount: number
  dirCount: number
  lastScanTs: number | null
  /** TOP5 类型（按文件行扩展名轻分类） */
  topTypes: Array<{ type: string; bytes: number; files: number }>
}

/** 扩展名→类型（与 classifyExt 同口径轻量版——红线 17） */
function typeOf(path: string): string {
  const n = path.toLowerCase()
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic'].includes(ext)) return '图片'
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'rmvb'].includes(ext)) return '视频'
  if (['mp3', 'flac', 'wav', 'aac', 'ogg', 'wma'].includes(ext)) return '音频'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '压缩包'
  if (['exe', 'msi'].includes(ext)) return '安装包'
  if (['doc', 'docx', 'pdf', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'].includes(ext)) return '文档'
  return '其他'
}

/** 聚合全部已扫描根（毫秒级——单表 GROUP BY） */
export function compareRoots(db: Database.Database): RootCompare[] {
  const roots = db.prepare('SELECT DISTINCT root_path FROM scan_cache_v3').all() as Array<{ root_path: string }>
  const out: RootCompare[] = []
  for (const { root_path } of roots) {
    const agg = db.prepare(`
      SELECT
        SUM(CASE WHEN is_dir = 0 THEN size ELSE 0 END) AS bytes,
        SUM(CASE WHEN is_dir = 0 THEN 1 ELSE 0 END) AS files,
        SUM(CASE WHEN is_dir = 1 THEN 1 ELSE 0 END) AS dirs,
        MIN(mtime) AS oldest, MAX(mtime) AS newest
      FROM scan_cache_v3 WHERE root_path = ?
    `).get(root_path) as { bytes: number | null; files: number | null; dirs: number | null; newest: number | null }
    // TOP 类型（文件行按路径后缀聚合）
    const rows = db.prepare('SELECT path, size FROM scan_cache_v3 WHERE root_path = ? AND is_dir = 0').all(root_path) as Array<{ path: string; size: number }>
    const byType = new Map<string, { type: string; bytes: number; files: number }>()
    for (const r of rows) {
      const t = typeOf(r.path)
      const g = byType.get(t) || { type: t, bytes: 0, files: 0 }
      g.bytes += r.size
      g.files++
      byType.set(t, g)
    }
    // 上次扫描时间（settings 记忆的是当前根；各根以缓存写入时间近似——取 newest 目录 mtime）
    out.push({
      root: root_path,
      totalBytes: agg.bytes || 0,
      fileCount: agg.files || 0,
      dirCount: agg.dirs || 0,
      lastScanTs: agg.newest || null,
      topTypes: [...byType.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5)
    })
  }
  return out.sort((a, b) => b.totalBytes - a.totalBytes)
}
