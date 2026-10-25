/**
 * 磁盘快照·时光机（v2.1 / F3）
 * 目录级快照存 SQLite（snapshots 头 + snapshot_dirs 行）；diff 输出增长/减少/新增/消失；
 * 30 份滚动淘汰。单份目录级快照 <20MB/百万文件（每行 ~50B）。
 */
import type Database from 'better-sqlite3'

export interface SnapshotMeta {
  id: number
  ts: number
  root: string
  totalBytes: number
  fileCount: number
  dirCount: number
}

export interface DirRow {
  path: string
  size: number
  files: number
  dirs: number
  mtime: number
}

export interface DiffEntry {
  path: string
  delta: number
  fromSize: number
  toSize: number
  kind: 'grow' | 'shrink' | 'new' | 'gone'
}

export interface DiffResult {
  grow: DiffEntry[] // 增长 TOP（空间被谁吃了）
  shrink: DiffEntry[] // 减少 TOP（清理战果）
  newDirs: DiffEntry[]
  goneDirs: DiffEntry[]
}

/** 建表（幂等） */
export function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      root TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      dir_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshot_dirs (
      snapshot_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      files INTEGER NOT NULL,
      dirs INTEGER NOT NULL,
      mtime INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_dirs_sid ON snapshot_dirs(snapshot_id);
  `)
}

const MAX_SNAPSHOTS = 30

/** 保存快照（rows 为目录级聚合行；root 行应在首位——total/fileCount 取根行） */
export function saveSnapshot(db: Database.Database, root: string, rows: DirRow[], keep = MAX_SNAPSHOTS): number {
  ensureTables(db)
  const rootRow = rows.find((r) => r.path.length <= root.length + 1) || rows[0]
  const totalBytes = rootRow?.size || 0
  const fileCount = rootRow?.files || 0
  const ins = db.prepare('INSERT INTO snapshots (ts, root, total_bytes, file_count, dir_count) VALUES (?, ?, ?, ?, ?)')
  const info = ins.run(Date.now(), root, totalBytes, fileCount, rows.length)
  const sid = Number(info.lastInsertRowid)
  const insDir = db.prepare('INSERT INTO snapshot_dirs (snapshot_id, path, size, files, dirs, mtime) VALUES (?, ?, ?, ?, ?, ?)')
  const tx = db.transaction((list: DirRow[]): void => {
    for (const r of list) insDir.run(sid, r.path, r.size, r.files, r.dirs, Math.round(r.mtime))
  })
  tx(rows)
  // 滚动淘汰：同 root 保留最近 keep 份
  pruneSnapshots(db, root, keep)
  return sid
}

/** 超量淘汰最旧（按 root 分组各自保留） */
export function pruneSnapshots(db: Database.Database, root: string, keep = MAX_SNAPSHOTS): number {
  ensureTables(db)
  const ids = db.prepare('SELECT id FROM snapshots WHERE root = ? ORDER BY ts DESC').all(root) as Array<{ id: number }>
  if (ids.length <= keep) return 0
  const drop = ids.slice(keep)
  const delDirs = db.prepare('DELETE FROM snapshot_dirs WHERE snapshot_id = ?')
  const delSnap = db.prepare('DELETE FROM snapshots WHERE id = ?')
  const tx = db.transaction((): void => {
    for (const d of drop) { delDirs.run(d.id); delSnap.run(d.id) }
  })
  tx()
  return drop.length
}

export function listSnapshots(db: Database.Database, root?: string): SnapshotMeta[] {
  ensureTables(db)
  const q = root
    ? 'SELECT id, ts, root, total_bytes AS totalBytes, file_count AS fileCount, dir_count AS dirCount FROM snapshots WHERE root = ? ORDER BY ts DESC'
    : 'SELECT id, ts, root, total_bytes AS totalBytes, file_count AS fileCount, dir_count AS dirCount FROM snapshots ORDER BY ts DESC'
  return (root ? db.prepare(q).all(root) : db.prepare(q).all()) as SnapshotMeta[]
}

export function deleteSnapshot(db: Database.Database, id: number): void {
  ensureTables(db)
  db.prepare('DELETE FROM snapshot_dirs WHERE snapshot_id = ?').run(id)
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id)
}

function loadDirs(db: Database.Database, sid: number): Map<string, DirRow> {
  const rows = db.prepare('SELECT path, size, files, dirs, mtime FROM snapshot_dirs WHERE snapshot_id = ?').all(sid) as DirRow[]
  return new Map(rows.map((r) => [r.path.toLowerCase(), r]))
}

/**
 * 对比两份快照（a 早 / b 晚）
 * 红线 12：无变化 → diff 为空（严格相等，无噪声）
 */
export function diffSnapshots(db: Database.Database, sidA: number, sidB: number, topN = 20): DiffResult {
  const a = loadDirs(db, sidA)
  const b = loadDirs(db, sidB)
  const grow: DiffEntry[] = []
  const shrink: DiffEntry[] = []
  const newDirs: DiffEntry[] = []
  const goneDirs: DiffEntry[] = []

  for (const [p, rowB] of b) {
    const rowA = a.get(p)
    if (!rowA) {
      newDirs.push({ path: rowB.path, delta: rowB.size, fromSize: 0, toSize: rowB.size, kind: 'new' })
    } else if (rowB.size > rowA.size) {
      grow.push({ path: rowB.path, delta: rowB.size - rowA.size, fromSize: rowA.size, toSize: rowB.size, kind: 'grow' })
    } else if (rowB.size < rowA.size) {
      shrink.push({ path: rowB.path, delta: rowA.size - rowB.size, fromSize: rowA.size, toSize: rowB.size, kind: 'shrink' })
    }
    // size 相等 → 无差异（mtime 变化不产生 diff 行——目录大小没变不算空间事件）
  }
  for (const [p, rowA] of a) {
    if (!b.has(p)) goneDirs.push({ path: rowA.path, delta: rowA.size, fromSize: rowA.size, toSize: 0, kind: 'gone' })
  }

  grow.sort((x, y) => y.delta - x.delta)
  shrink.sort((x, y) => y.delta - x.delta)
  return {
    grow: grow.slice(0, topN),
    shrink: shrink.slice(0, topN),
    newDirs: newDirs.sort((x, y) => y.delta - x.delta).slice(0, topN),
    goneDirs: goneDirs.sort((x, y) => y.delta - x.delta).slice(0, topN)
  }
}

/* ---------------- 从扫描树提取目录行（engine 树 → DirRow[]） ---------------- */
interface TreeNodeLike {
  path: string
  size: number
  fileCount: number
  dirCount: number
  mtime?: number
  children?: unknown[]
}

/** 展平扫描树为目录行（全部层级；百万文件≈十万目录≈5MB 行数据） */
export function flattenTree(node: TreeNodeLike, out: DirRow[] = []): DirRow[] {
  // v4.2.6：迭代化（显式栈）——C 盘 30 万+目录深递归爆栈修复
  const stack: TreeNodeLike[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    out.push({ path: n.path, size: n.size, files: n.fileCount, dirs: n.dirCount, mtime: n.mtime || 0 })
    for (const c of ((n.children || []) as TreeNodeLike[])) {
      if ('fileCount' in c && c.fileCount !== undefined) stack.push(c)
    }
  }
  return out
}
