/**
 * 媒体标签系统（v3.6 / 备选池收官）
 * media_tags(path, tag) 唯一；全部只增不删文件——纯元数据。
 */
import type Database from 'better-sqlite3'

export function ensureMediaTags(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS media_tags (
    path TEXT NOT NULL,
    tag TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (path, tag)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag)')
}

export function tagAdd(db: Database.Database, path: string, tag: string): boolean {
  ensureMediaTags(db)
  const t = tag.trim().slice(0, 24)
  if (!t) return false
  db.prepare('INSERT OR IGNORE INTO media_tags (path, tag, added_at) VALUES (?, ?, ?)').run(path, t, Date.now())
  return true
}

export function tagRemove(db: Database.Database, path: string, tag: string): void {
  ensureMediaTags(db)
  db.prepare('DELETE FROM media_tags WHERE path = ? AND tag = ?').run(path, tag)
}

/** 单文件的标签 */
export function tagsOf(db: Database.Database, path: string): string[] {
  ensureMediaTags(db)
  return (db.prepare('SELECT tag FROM media_tags WHERE path = ? ORDER BY added_at').all(path) as Array<{ tag: string }>).map((r) => r.tag)
}

/** 全部标签统计（chips 用） */
export function tagStats(db: Database.Database): Array<{ tag: string; count: number }> {
  ensureMediaTags(db)
  return db.prepare('SELECT tag, COUNT(*) as count FROM media_tags GROUP BY tag ORDER BY count DESC, tag').all() as never
}

/** 某标签下全部文件 */
export function byTag(db: Database.Database, tag: string): string[] {
  ensureMediaTags(db)
  return (db.prepare('SELECT path FROM media_tags WHERE tag = ? ORDER BY added_at DESC').all(tag) as Array<{ path: string }>).map((r) => r.path)
}
