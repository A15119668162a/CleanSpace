/**
 * 全局文件搜索索引（v2.2 / F6）
 * SQLite 表 file_index（LIKE + 多索引；只索引元数据，不含内容）
 */
import type Database from 'better-sqlite3'

export interface IndexedFile {
  path: string
  root: string
  name: string
  ext: string
  size: number
  mtime: number
  type: string
}

export interface SearchQuery {
  namePattern?: string
  minSize?: number
  maxSize?: number
  after?: number
  before?: number
  types?: string[]
  limit?: number
}

export interface SearchHit {
  path: string
  name: string
  size: number
  mtime: number
  type: string
}

export function ensureIndexTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_index (
      path TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      type TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fi_root ON file_index(root);
    CREATE INDEX IF NOT EXISTS idx_fi_ext ON file_index(ext);
    CREATE INDEX IF NOT EXISTS idx_fi_type ON file_index(type);
    CREATE INDEX IF NOT EXISTS idx_fi_size ON file_index(size);
  `)
}

export interface IndexStats {
  files: number
  roots: string[]
  indexedAt: number | null
}

export function indexStats(db: Database.Database): IndexStats {
  ensureIndexTable(db)
  const row = db.prepare('SELECT COUNT(*) c FROM file_index').get() as { c: number }
  const roots = db.prepare('SELECT DISTINCT root FROM file_index').all() as Array<{ root: string }>
  const meta = db.prepare("SELECT value FROM settings WHERE key = 'file_index_ts'").get() as { value: string } | undefined
  return { files: row.c, roots: roots.map((r) => r.root), indexedAt: meta ? Number(meta.value) : null }
}

export function rebuildIndex(db: Database.Database, root: string, rows: IndexedFile[]): number {
  ensureIndexTable(db)
  const tx = db.transaction((): void => {
    db.prepare('DELETE FROM file_index WHERE root = ?').run(root)
    const ins = db.prepare('INSERT OR REPLACE INTO file_index (path, root, name, ext, size, mtime, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(r.path, r.root, r.name, r.ext, r.size, Math.round(r.mtime), r.type)
  })
  tx()
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('file_index_ts', ?)").run(String(Date.now()))
  return rows.length
}

function patternToLike(p: string): { like: string; ok: boolean } {
  const s = p.trim().toLowerCase()
  if (!s) return { like: '', ok: true }
  if (/[^*\w\u4e00-\u9fa5 .()%\-_+!@#$^&=[\]{}';,~`]/.test(s)) return { like: '', ok: false }
  return { like: s.replace(/\*/g, '%'), ok: true }
}

export function searchFiles(db: Database.Database, q: SearchQuery): SearchHit[] {
  ensureIndexTable(db)
  const where: string[] = []
  const params: unknown[] = []
  if (q.namePattern) {
    const { like, ok } = patternToLike(q.namePattern)
    if (!ok) return []
    if (like) { where.push("name LIKE ? ESCAPE '\\'"); params.push(like) }
  }
  if (q.minSize !== undefined) { where.push('size >= ?'); params.push(q.minSize) }
  if (q.maxSize !== undefined) { where.push('size <= ?'); params.push(q.maxSize) }
  if (q.after !== undefined) { where.push('mtime >= ?'); params.push(q.after) }
  if (q.before !== undefined) { where.push('mtime <= ?'); params.push(q.before) }
  if (q.types?.length) { where.push(`type IN (${q.types.map(() => '?').join(',')})`); params.push(...q.types) }
  const sql = `SELECT path, name, size, mtime, type FROM file_index ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY size DESC LIMIT ?`
  params.push(Math.min(q.limit || 500, 2000))
  return db.prepare(sql).all(...params) as SearchHit[]
}

interface FileEntryLike { name: string; path: string; size: number; type: string; mtime?: number }
interface DirNodeLike { path: string; children?: unknown[]; files?: FileEntryLike[] }

/**
 * 展平扫描树为索引行。两种树形态都支持：
 * ① 引擎全量树：children 混合（DirNode | FileEntry{path,size,mtime}——无 name/type）
 * ② 缓存重建树：children 目录 + files 显式文件数组（rebuildTree 产出，含 name/type）
 * type 分类与 core.classifyFile 同口径（红线 17）。
 */
export function flattenForIndex(node: DirNodeLike, root: string, out: IndexedFile[] = []): IndexedFile[] {
  // v4.2.6：迭代化（显式栈）——深树爆栈修复
  const stack: DirNodeLike[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    for (const f of n.files || []) pushRow(out, root, f.path, f.size, f.mtime || 0, f.name, f.type)
    for (const c of (n.children || []) as Array<Record<string, unknown>>) {
      if (!c || typeof c !== 'object') continue
      if ('children' in c || 'files' in c) {
        stack.push(c as DirNodeLike) // 目录节点
      } else if ('path' in c && 'size' in c) {
        pushRow(out, root, String(c.path), Number(c.size), Number(c.mtime || 0)) // 裸 FileEntry（引擎树）
      }
    }
  }
  return out
}

function pushRow(out: IndexedFile[], root: string, path: string, size: number, mtime: number, name?: string, type?: string): void {
  const nm = name || path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
  const ext = nm.includes('.') ? nm.slice(nm.lastIndexOf('.') + 1).toLowerCase() : ''
  out.push({ path, root, name: nm, ext, size, mtime, type: type || classifyForIndex(ext) })
}

/** 与 core.classifyFile 同口径（红线 17：跨处分类必须同源） */
function classifyForIndex(ext: string): string {
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic', 'tiff', 'tif', 'avif'].includes(ext)) return '图片'
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'rmvb', '3gp', 'ts'].includes(ext)) return '视频'
  if (['mp3', 'flac', 'wav', 'aac', 'ogg', 'wma', 'm4a', 'ape'].includes(ext)) return '音频'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(ext)) return '压缩包'
  if (['exe', 'msi', 'msix', 'appx'].includes(ext)) return '安装包'
  if (['doc', 'docx', 'pdf', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'epub'].includes(ext)) return '文档'
  if (['js', 'ts', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'html', 'css', 'json', 'xml', 'yml', 'yaml', 'sh', 'bat', 'ps1', 'sql'].includes(ext)) return '代码'
  return '其他'
}
