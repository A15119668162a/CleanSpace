import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compareRoots } from '../src/main/scanner/compare'

let db: Database.Database
let fx: string

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE scan_cache_v3 (path TEXT PRIMARY KEY, root_path TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER DEFAULT 0, is_dir INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0, dir_count INTEGER DEFAULT 0, parent TEXT)`)
  fx = mkdtempSync(join(tmpdir(), 'cs-cmp-'))
  mkdirSync(join(fx, 'a'))
  writeFileSync(join(fx, 'a', 'x.jpg'), 'x'.repeat(100))
  writeFileSync(join(fx, 'a', 'y.mp4'), 'y'.repeat(200))
  // 两个根：fx 和 fx/a（模拟两盘）
  const ins = db.prepare('INSERT INTO scan_cache_v3 (path, root_path, mtime, size, is_dir, parent) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(fx, fx, 1, 300, 1, null)
  ins.run(join(fx, 'a'), fx, 1, 0, 1, fx)
  ins.run(join(fx, 'a', 'x.jpg'), fx, 1, 100, 0, join(fx, 'a'))
  ins.run(join(fx, 'a', 'y.mp4'), fx, 1, 200, 0, join(fx, 'a'))
  ins.run('G:\\', 'G:\\', 2, 500, 1, null)
  ins.run('G:\\big.zip', 'G:\\', 2, 500, 0, 'G:\\')
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v3.5 多磁盘横向对比', () => {
  it('多根聚合：总量/文件数/目录数正确', () => {
    const r = compareRoots(db)
    expect(r.length).toBe(2)
    const g = r.find(x => x.root === 'G:\\')
    expect(g?.totalBytes).toBe(500)
    expect(g?.fileCount).toBe(1)
    expect(g?.dirCount).toBe(1)
    const f = r.find(x => x.root === fx)
    expect(f?.totalBytes).toBe(300)
    expect(f?.fileCount).toBe(2)
  })

  it('按总量降序；TOP 类型含图片/视频', () => {
    const r = compareRoots(db)
    expect(r[0].totalBytes).toBeGreaterThanOrEqual(r[1].totalBytes)
    const f = r.find(x => x.root === fx)!
    const types = f.topTypes.map(t => t.type)
    expect(types).toContain('视频')
    expect(types).toContain('图片')
    expect(f.topTypes.length).toBeLessThanOrEqual(5)
  })

  it('类型口径与全局分类一致（zip→压缩包）', () => {
    const r = compareRoots(db)
    const g = r.find(x => x.root === 'G:\\')!
    expect(g.topTypes[0].type).toBe('压缩包')
  })
})
