/**
 * 软删除回收站（P2 安全机制核心）
 * 删除 = 同盘 rename 到 {盘符根}\CleanspaceRecycle\{日期-批次}\...（保留原相对结构）
 * SQLite recycle_items 记原路径/回收路径/批次；到期自动真删；恢复用 rename 原路还原
 */
import type Database from 'better-sqlite3'
import { rename, mkdir, stat, rm, readdir } from 'fs/promises'
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { join, parse, resolve } from 'path'

export interface RecycleItem {
  id: number
  batch_id: string
  recycled_path: string
  orig_path: string
  size: number
  ts: number
  expires_at: number
  restored: number
}

/** 计算文件 SHA-256（恢复校验用，小文件直读） */
export function hashFile(p: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    const s = createReadStream(p)
    s.on('data', (d) => h.update(d))
    s.on('end', () => res(h.digest('hex')))
    s.on('error', rej)
  })
}

function recycleRootFor(absPath: string): string {
  const p = parse(resolve(absPath))
  return join(p.root, 'CleanspaceRecycle')
}

/** 软删除单个文件（同盘 rename，原子且快） */
export async function softDelete(
  db: Database.Database,
  origPath: string,
  batchSize = 0,
  keepDays = 15
): Promise<RecycleItem> {
  const abs = resolve(origPath)
  const st = await stat(abs)
  const batchId = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}${batchSize ? '-' + batchSize : ''}`
  const root = recycleRootFor(abs)
  const rel = abs.slice(parse(abs).root.length)
  const dest = join(root, batchId, rel)
  await mkdir(join(root, batchId, parse(rel).dir.replace(/^\\+|\/+/g, '') || '.'), { recursive: true })
  await rename(abs, dest)

  const now = Date.now()
  const info = db
    .prepare(
      'INSERT INTO recycle_items (batch_id, recycled_path, orig_path, size, ts, expires_at, restored) VALUES (?, ?, ?, ?, ?, ?, 0)'
    )
    .run(batchId, dest, abs, st.size, now, now + keepDays * 86400000)
  const item: RecycleItem = {
    id: Number(info.lastInsertRowid),
    batch_id: batchId,
    recycled_path: dest,
    orig_path: abs,
    size: st.size,
    ts: now,
    expires_at: now + keepDays * 86400000,
    restored: 0
  }
  db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    now, batchId, 'clean', abs, dest, st.size, null
  )
  return item
}

/** 恢复单个（rename 回原路径；原路径父目录若消失则重建） */
export async function restoreItem(db: Database.Database, item: RecycleItem): Promise<boolean> {
  if (!existsSync(item.recycled_path)) return false
  await mkdir(parse(item.orig_path).dir, { recursive: true })
  let dest = item.orig_path
  if (existsSync(dest)) {
    // 原路径被占用：加后缀
    const p = parse(item.orig_path)
    dest = join(p.dir, `${p.name}-恢复-${Date.now().toString(36)}${p.ext}`)
  }
  await rename(item.recycled_path, dest)
  db.prepare('UPDATE recycle_items SET restored = 1 WHERE id = ?').run(item.id)
  db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    Date.now(), item.batch_id, 'restore', item.recycled_path, dest, item.size, null
  )
  return true
}

/** 恢复整批（按批次号） */
export async function restoreBatch(db: Database.Database, batchId: string): Promise<{ ok: number; fail: number }> {
  const items = db.prepare('SELECT * FROM recycle_items WHERE batch_id = ? AND restored = 0').all(batchId) as RecycleItem[]
  let ok = 0, fail = 0
  for (const it of items) {
    try {
      if (await restoreItem(db, it)) ok++
      else fail++
    } catch { fail++ }
  }
  return { ok, fail }
}

/** 列出回收站（未恢复，按批次分组倒序） */
export function listRecycle(db: Database.Database): RecycleItem[] {
  return db.prepare('SELECT * FROM recycle_items WHERE restored = 0 ORDER BY ts DESC').all() as RecycleItem[]
}

/** 真正删除单项（到期/用户手动） */
export async function purgeItem(db: Database.Database, item: RecycleItem): Promise<void> {
  if (existsSync(item.recycled_path)) await rm(item.recycled_path, { force: true })
  db.prepare('DELETE FROM recycle_items WHERE id = ?').run(item.id)
}

/** 清空整批 */
export async function purgeBatch(db: Database.Database, batchId: string, onProgress?: (done: number) => void): Promise<number> {
  const items = db.prepare('SELECT * FROM recycle_items WHERE batch_id = ? AND restored = 0').all(batchId) as RecycleItem[]
  let done = 0
  for (const it of items) { await purgeItem(db, it); done++; onProgress?.(done) }
  // 清理可能的空批次目录
  try {
    const sample = items[0]
    if (sample) {
      const batchDir = parse(sample.recycled_path).dir
      const files = await readdir(batchDir).catch(() => [] as string[])
      if (files.length === 0) await rm(batchDir, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch { /* */ }
  return items.length
}

/** v4.2.8 批量彻底删除（勾选多批次；用户主动永久删） */
export async function purgeBatches(db: Database.Database, batchIds: string[]): Promise<number> {
  let total = 0
  for (const id of batchIds) total += await purgeBatch(db, id)
  return total
}

/** v4.2.8 一键清空应用回收站（全部批次，永久删） */
export async function purgeAll(db: Database.Database, onProgress?: (done: number) => void): Promise<number> {
  const items = db.prepare('SELECT * FROM recycle_items WHERE restored = 0').all() as RecycleItem[]
  let done = 0
  for (const it of items) { await purgeItem(db, it); done++; onProgress?.(done) }
  // 清空所有批次空目录
  try {
    const roots = new Set<string>()
    for (const it of items) {
      const p = parse(it.recycled_path)
      roots.add(p.root)
    }
    for (const root of roots) {
      const rc = join(root, 'CleanspaceRecycle')
      if (existsSync(rc)) {
        const subs = await readdir(rc).catch(() => [] as string[])
        for (const sub of subs) {
          const sd = join(rc, sub)
          const files = await readdir(sd).catch(() => ['x'])
          if (files.length === 0) await rm(sd, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  } catch { /* */ }
  return items.length
}

/** 到期自动清除（默认 15 天，应用启动/清扫页进入时调用） */
export async function purgeExpired(db: Database.Database): Promise<number> {
  const now = Date.now()
  const items = db.prepare('SELECT * FROM recycle_items WHERE restored = 0 AND expires_at < ?').all(now) as RecycleItem[]
  for (const it of items) await purgeItem(db, it)
  return items.length
}
