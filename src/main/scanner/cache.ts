/**
 * 扫描缓存（SQLite scan_cache 表，v3）
 * 每行记录所属扫描根（root_path 列），子树查询走索引直查，避免 LIKE 转义歧义
 */
import type Database from 'better-sqlite3'
import { readdir, stat } from 'fs/promises'
import type { DirNode, FileEntry } from './core'

export interface CacheRow {
  path: string
  root_path: string
  mtime: number
  size: number
  is_dir: number
  file_count: number
  dir_count: number
  parent: string | null
}

export function migrateScanCache(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_cache_v3 (
      path TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER DEFAULT 0,
      is_dir INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0,
      dir_count INTEGER DEFAULT 0,
      parent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scan_cache_root ON scan_cache_v3(root_path);
  `)
}

export function loadSubtree(db: Database.Database, rootPath: string): Map<string, CacheRow> {
  const map = new Map<string, CacheRow>()
  const rows = db
    .prepare('SELECT path, root_path, mtime, size, is_dir, file_count, dir_count, parent FROM scan_cache_v3 WHERE root_path = ?')
    .all(rootPath) as CacheRow[]
  for (const r of rows) map.set(r.path.toLowerCase(), r)
  return map
}

/** 全树写缓存（事务） */
export function saveCache(db: Database.Database, root: DirNode, allFiles?: Array<{ path: string; size: number; mtime: number }>): void {
  const run = db.transaction((): void => {
    db.prepare('DELETE FROM scan_cache_v3 WHERE root_path = ?').run(root.path)
    const insDir = db.prepare(
      'INSERT OR REPLACE INTO scan_cache_v3 (path, root_path, mtime, size, is_dir, file_count, dir_count, parent) VALUES (?, ?, ?, ?, 1, ?, ?, ?)'
    )
    // v2.4.2：文件行入缓存（is_dir=0）——深层文件不进树（内存优化），必须由 allFiles 直写
    const insFile = db.prepare(
      'INSERT OR REPLACE INTO scan_cache_v3 (path, root_path, mtime, size, is_dir, file_count, dir_count, parent) VALUES (?, ?, ?, ?, 0, 0, 0, ?)'
    )
    const parentOf = (p: string): string => {
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i > 0 ? p.slice(0, i) : root.path
    }
    // v4.2.6：迭代化持久化遍历（防深树爆栈）
    const pstack: Array<{ n: DirNode; parent: string | null }> = [{ n: root, parent: null }]
    while (pstack.length > 0) {
      const { n, parent } = pstack.pop()!
      insDir.run(n.path, root.path, n.mtime, n.size, n.fileCount, n.dirCount, parent)
      for (const c of n.children) if ('children' in c) pstack.push({ n: c, parent: n.path })
      for (const f of n.files || []) insFile.run(f.path, root.path, f.mtime, f.size, n.path)
    }
    if (allFiles) for (const f of allFiles) insFile.run(f.path, root.path, f.mtime, f.size, parentOf(f.path))
  })
  run()
}

function rowToNode(row: CacheRow): DirNode {
  const name = row.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || row.path
  return { path: row.path, name, size: row.size, mtime: row.mtime, children: [], fileCount: row.file_count, dirCount: row.dir_count }
}

/** 缓存重建：按 parent 链组装回树（仅目录层） */
export function rebuildTree(rows: Map<string, CacheRow>, rootPath: string): DirNode | null {
  const rootRow = rows.get(rootPath.toLowerCase())
  if (!rootRow) return null
  const root = rowToNode(rootRow)
  const byParent = new Map<string, DirNode[]>()
  const filesByParent = new Map<string, FileEntry[]>()
  for (const r of rows.values()) {
    if (!r.parent) continue
    const key = r.parent.toLowerCase()
    if (r.is_dir === 0) {
      // v2.4.1：文件行挂到所属目录（type 由扩展名重算——与 classifyExt 同口径）
      const arr = filesByParent.get(key) || []
      arr.push(fileRowToEntry(r))
      filesByParent.set(key, arr)
    } else {
      const arr = byParent.get(key) || []
      arr.push(rowToNode(r))
      byParent.set(key, arr)
    }
  }
  // v4.2.6：显式栈迭代（替代递归）——防超深目录链爆栈（RangeError: Maximum call stack size exceeded）
  // 同时防环：缓存历史中可能残留 junction 环，visited 拦截
  const visited = new Set<string>([rootPath.toLowerCase()])
  const stack: DirNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    n.files = filesByParent.get(n.path.toLowerCase()) || []
    const kids = byParent.get(n.path.toLowerCase())
    n.children = []
    if (kids) {
      n.children = [...kids].sort((a, b) => b.size - a.size)
      for (const k of kids) {
        const kl = k.path.toLowerCase()
        if (visited.has(kl)) continue // 环防护：同一目录只挂一次
        visited.add(kl)
        stack.push(k)
      }
    }
  }
  return root
}

/** 缓存里是否含文件行（v2.4.1 旧格式缓存无文件行——需全量重扫一次迁移） */
export function cacheHasFileRows(rows: Map<string, CacheRow>): boolean {
  for (const r of rows.values()) if (r.is_dir === 0) return true
  return false
}

/** 文件行 → FileEntry（type 与 classifyExt 同口径的轻量映射，避免打包 core 双份） */
function fileRowToEntry(row: CacheRow): FileEntry {
  const name = row.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || row.path
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return { path: row.path, name, size: row.size, mtime: row.mtime, type: lightClassify(ext) }
}

export function lightClassify(ext: string): string {
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic', 'tiff'].includes(ext)) return '图片'
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'rmvb'].includes(ext)) return '视频'
  if (['mp3', 'flac', 'wav', 'aac', 'ogg', 'wma'].includes(ext)) return '音频'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return '压缩包'
  if (['exe', 'msi'].includes(ext)) return '安装包'
  if (['doc', 'docx', 'pdf', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'].includes(ext)) return '文档'
  if (['js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'html', 'css', 'json', 'xml', 'sh', 'bat'].includes(ext)) return '代码'
  return '其他'
}

/** 根目录缓存整树命中判定：根 mtime 未变 */
export async function cacheHit(db: Database.Database, rootPath: string): Promise<{ hit: boolean; rows?: Map<string, CacheRow> }> {
  try {
    const s = await stat(rootPath)
    const rows = loadSubtree(db, rootPath)
    const rootRow = rows.get(rootPath.toLowerCase())
    console.log('[cache] hit check:', JSON.stringify(rootPath), 'rows=' + rows.size, 'rootRow=' + !!rootRow, rootRow ? `mtime disk=${s.mtimeMs} cached=${rootRow.mtime} diff=${Math.abs(rootRow.mtime - s.mtimeMs)}` : '')
    if (rootRow && Math.abs(rootRow.mtime - s.mtimeMs) < 2) return { hit: true, rows }
    return { hit: false, rows }
  } catch (e) {
    console.log('[cache] stat failed:', (e as Error).message)
    return { hit: false }
  }
}

/** 校验重建树首层与实际目录一致（防陈旧缓存），返回失败原因或 null；跳过系统目录
 * 策略：子集校验——缓存中的目录必须都存在于磁盘且 mtime 未变；磁盘新增目录不影响命中（顶层合并时补） */
const VERIFY_SKIP = new Set(['$recycle.bin', 'system volume information', 'recovery'])
export async function verifyRebuilt(root: DirNode): Promise<string | null> {
  try {
    const dirents = await readdir(root.path, { withFileTypes: true })
    const realDirs = new Set(dirents.filter((d) => d.isDirectory() && !VERIFY_SKIP.has(d.name.toLowerCase())).map((d) => d.name.toLowerCase()))
    for (const c of root.children as DirNode[]) {
      const key = c.name.toLowerCase()
      if (VERIFY_SKIP.has(key)) continue
      if (!realDirs.has(key)) return `dir gone: ${c.name}`
      const s = await stat(c.path)
      if (Math.abs(s.mtimeMs - c.mtime) >= 2) return `mtime diff ${c.name}: disk=${s.mtimeMs} cached=${c.mtime}`
    }
    return null
  } catch (e) {
    return 'verify error: ' + (e as Error).message
  }
}

/**
 * 深层校验（v1.2）：NTFS 目录 mtime 只随直接子项变化，深层改动不传导到根。
 * 策略：0-2 层全量校验 mtime + 深层（≥3 层）随机抽样（默认 800 个）。
 * 任何被抽到的目录 mtime 与缓存不符 → 返回原因（判 miss 走全量重扫）。
 * maxSample=Infinity 时为全量确定性校验（测试用）。
 */
export async function deepVerify(root: DirNode, maxSample = 800, rng: () => number = Math.random): Promise<string | null> {
  const shallow: DirNode[] = []
  const deep: DirNode[] = []
  // v4.2.6：迭代化（显式栈带深度）——防深树爆栈
  const stack: Array<{ n: DirNode; depth: number }> = [{ n: root, depth: 0 }]
  while (stack.length > 0) {
    const { n, depth } = stack.pop()!
    for (const c of n.children) {
      if (!('children' in c)) continue
      if (VERIFY_SKIP.has(c.name.toLowerCase())) continue
      if (depth < 2) shallow.push(c)
      else deep.push(c)
      stack.push({ n: c, depth: depth + 1 })
    }
  }

  // 0-2 层全量
  for (const d of shallow) {
    try {
      const s = await stat(d.path)
      if (Math.abs(s.mtimeMs - d.mtime) >= 2) return `deep mtime diff(shallow ${d.path.replace(/\\/g, '/').split('/').length}层): disk=${s.mtimeMs} cached=${d.mtime}`
    } catch (e) {
      return 'deep stat error: ' + d.path + ' (' + (e as Error).message + ')'
    }
  }
  // 深层抽样
  const pool = maxSample >= deep.length ? deep : sampleOf(deep, maxSample, rng)
  for (const d of pool) {
    try {
      const s = await stat(d.path)
      if (Math.abs(s.mtimeMs - d.mtime) >= 2) return `deep mtime diff(sampled ${d.path}): disk=${s.mtimeMs} cached=${d.mtime}`
    } catch (e) {
      return 'deep stat error: ' + d.path + ' (' + (e as Error).message + ')'
    }
  }
  return null
}

/** Fisher-Yates 部分抽样 */
function sampleOf<T>(arr: T[], n: number, rng: () => number): T[] {
  const a = [...arr]
  const k = Math.min(n, a.length)
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (a.length - i))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, k)
}

export type { DirNode, FileEntry }
