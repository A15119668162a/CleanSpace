import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { BUILTIN_WHITELIST } from '@shared/whitelist'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('userData'), 'data')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'cleanspace.db'))
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      action TEXT NOT NULL,          -- clean / organize / disable_startup / restore / rollback
      src_path TEXT NOT NULL,
      dst_path TEXT,                 -- 软删除目标 / 整理新路径
      size INTEGER DEFAULT 0,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_op_log_batch ON op_log(batch_id);

    CREATE TABLE IF NOT EXISTS recycle_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      recycled_path TEXT NOT NULL,   -- _recycle 内的存储路径
      orig_path TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      ts INTEGER NOT NULL,
      expires_at INTEGER,            -- 到期真正清除
      restored INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_recycle_batch ON recycle_items(batch_id);

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,            -- type / date / size / custom
      name TEXT NOT NULL,
      config TEXT NOT NULL,          -- JSON
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_cache (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER DEFAULT 0,
      is_dir INTEGER DEFAULT 0,
      children_hash TEXT,
      parent TEXT
    );

    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      builtin INTEGER DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)

  seedWhitelist(db)
}

function seedWhitelist(db: Database.Database): void {
  const cnt = (db.prepare('SELECT COUNT(*) AS c FROM whitelist').get() as { c: number }).c
  if (cnt > 0) return
  const ins = db.prepare('INSERT OR IGNORE INTO whitelist (pattern, enabled, builtin, note) VALUES (?, 1, 1, ?)')
  for (const w of BUILTIN_WHITELIST) ins.run(w.pattern, w.note)
}

/** 供测试用：以内存库初始化 */
export function initForTest(): Database.Database {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}
