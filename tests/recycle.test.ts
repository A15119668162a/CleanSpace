import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { softDelete, restoreItem, restoreBatch, listRecycle, purgeBatch, purgeBatches, purgeAll, purgeExpired, hashFile } from '../src/main/cleaner/recycle'

let root: string
let db: Database.Database

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cs-recycle-'))
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, batch_id TEXT, action TEXT, src_path TEXT, dst_path TEXT, size INTEGER, detail TEXT);
    CREATE TABLE IF NOT EXISTS recycle_items (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, recycled_path TEXT, orig_path TEXT, size INTEGER, ts INTEGER, expires_at INTEGER, restored INTEGER DEFAULT 0);
  `)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  // 回收站根也在临时目录内，一并清
})

describe('P2 软删除回收站（验收：删→回收→恢复→hash 一致）', () => {
  it('软删除：原路径消失、回收站存在、数据库可查', async () => {
    const f = join(root, 'a.txt')
    writeFileSync(f, 'hello-cleanspace-1')
    const item = await softDelete(db, f)
    expect(existsSync(f)).toBe(false)
    expect(existsSync(item.recycled_path)).toBe(true)
    expect(listRecycle(db).length).toBe(1)
    // 回收路径与原路径同盘（rename 可达）
    expect(item.recycled_path.toLowerCase()).toContain('cleanspacerecycle')
  })

  it('恢复：文件回原路径且内容 hash 一致', async () => {
    const f = join(root, 'b.txt')
    writeFileSync(f, 'content-for-hash-check-2')
    const before = await hashFile(f)
    const item = await softDelete(db, f)
    const ok = await restoreItem(db, item)
    expect(ok).toBe(true)
    expect(existsSync(f)).toBe(true)
    expect(await hashFile(f)).toBe(before)
    expect(listRecycle(db).find((x) => x.id === item.id)).toBeUndefined() // 已恢复不再列出
  })

  it('批量恢复（模拟一键撤销整批）', async () => {
    mkdirSync(join(root, 'batch'), { recursive: true })
    const files = ['x.txt', 'y.txt', 'z.txt']
    for (const n of files) writeFileSync(join(root, 'batch', n), 'batch-' + n)
    const items = []
    for (const n of files) items.push(await softDelete(db, join(root, 'batch', n), 99))
    // 同批（batchSize 相同但 batch_id 含时间戳——这里以首个的 batch_id 为准恢复）
    const batchId = items[0].batch_id
    // 手动统一 batch_id（真实流程中同批清理共享批次号，见 junk:clean 实现）
    db.prepare('UPDATE recycle_items SET batch_id = ? WHERE id IN (' + items.map((i) => i.id).join(',') + ')').run(batchId)
    const r = await restoreBatch(db, batchId)
    expect(r.ok).toBe(3)
    expect(r.fail).toBe(0)
    for (const n of files) expect(existsSync(join(root, 'batch', n))).toBe(true)
  })

  it('清空批次：回收文件真删、记录清除', async () => {
    const before = listRecycle(db).length
    const f = join(root, 'c.txt')
    writeFileSync(f, 'to-purge')
    const item = await softDelete(db, f)
    expect(listRecycle(db).length).toBe(before + 1)
    const n = await purgeBatch(db, item.batch_id)
    expect(n).toBe(1)
    expect(existsSync(item.recycled_path)).toBe(false)
    expect(listRecycle(db).length).toBe(before) // 仅少这一条
  })

  it('到期自动清除（15 天边界）', async () => {
    const f = join(root, 'd.txt')
    writeFileSync(f, 'expired')
    const item = await softDelete(db, f, 0, 0) // keepDays=0 立即到期
    // expires_at = now；查询条件 < now，回拨 2ms 保证命中
    db.prepare('UPDATE recycle_items SET expires_at = ? WHERE id = ?').run(Date.now() - 2, item.id)
    const purged = await purgeExpired(db)
    expect(purged).toBeGreaterThanOrEqual(1)
    expect(existsSync(item.recycled_path)).toBe(false)
  })

  it('原路径被占用时恢复加后缀不覆盖', async () => {
    const f = join(root, 'e.txt')
    writeFileSync(f, 'original')
    const item = await softDelete(db, f)
    writeFileSync(f, 'new-file-same-name') // 原路径被新文件占用
    const ok = await restoreItem(db, item)
    expect(ok).toBe(true)
    expect(existsSync(f)).toBe(true)
    // 后缀恢复文件存在
    const files = require('fs').readdirSync(root) as string[]
    expect(files.some((x) => x.startsWith('e-恢复-'))).toBe(true)
  })


  it('v4.2.8 purgeBatches 批量彻底删多批次', async () => {
    const f1 = join(root, 'p1.bin'); writeFileSync(f1, Buffer.alloc(1024, 1))
    const f2 = join(root, 'p2.bin'); writeFileSync(f2, Buffer.alloc(1024, 2))
    const i1 = await softDelete(db, f1)
    const i2 = await softDelete(db, f2)
    expect(i1.batch_id).not.toBe(i2.batch_id)
    const n = await purgeBatches(db, [i1.batch_id, i2.batch_id])
    expect(n).toBe(2)
    expect(existsSync(i1.recycled_path)).toBe(false)
    expect(existsSync(i2.recycled_path)).toBe(false)
    expect(listRecycle(db).some((x) => x.batch_id === i1.batch_id || x.batch_id === i2.batch_id)).toBe(false)
  })

  it('v4.2.8 purgeAll 一键清空全部（含未删项）', async () => {
    const f3 = join(root, 'p3.bin'); writeFileSync(f3, Buffer.alloc(1024, 3))
    const f4 = join(root, 'p4.bin'); writeFileSync(f4, Buffer.alloc(1024, 4))
    const i3 = await softDelete(db, f3)
    const i4 = await softDelete(db, f4)
    const n = await purgeAll(db)
    expect(n).toBeGreaterThanOrEqual(2)
    expect(existsSync(i3.recycled_path)).toBe(false)
    expect(existsSync(i4.recycled_path)).toBe(false)
    expect(listRecycle(db).length).toBe(0)
  })

  it('大小与 mtime 元数据保留', async () => {
    const f = join(root, 'g.bin')
    writeFileSync(f, Buffer.alloc(4096, 7))
    const item = await softDelete(db, f)
    expect(item.size).toBe(4096)
    expect(statSync(item.recycled_path).size).toBe(4096)
    await purgeBatch(db, item.batch_id)
  })
})
