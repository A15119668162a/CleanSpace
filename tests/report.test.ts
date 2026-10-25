import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { aggregateMonth, renderReport } from '../src/main/health/report'

let db: Database.Database
let fx: string

const MONTH = '2026-10'
const [Y, M] = MONTH.split('-').map(Number)
const T = (day: number): number => new Date(Y, M - 1, day, 12).getTime()

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE op_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, batch_id TEXT, action TEXT, src_path TEXT, dst_path TEXT, size INTEGER, detail TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, root TEXT, total_bytes INTEGER, file_count INTEGER, dir_count INTEGER);
  `)
  // 注入已知日志
  const ins = db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, size) VALUES (?, ?, ?, ?, ?)')
  ins.run(T(2), 'b1', 'clean', 'C:\\Temp\\big1.tmp', 2 * 1024 ** 3)
  ins.run(T(5), 'b1', 'clean', 'C:\\Temp\\big2.tmp', 1 * 1024 ** 3)
  ins.run(T(8), 'b2', 'clean', 'C:\\Temp\\small.tmp', 50 * 1024 ** 2)
  ins.run(T(10), 'o1', 'organize', 'D:\\dl\\a.jpg', 1024 ** 2)
  ins.run(T(10), 'o1', 'organize', 'D:\\dl\\b.jpg', 1024 ** 2)
  ins.run(T(12), 'e1', 'clean_emptydir', 'D:\\empty\\x', 0)
  // 体检历史
  db.prepare("INSERT INTO settings (key, value) VALUES ('checkup_history', ?)").run(JSON.stringify([
    { ts: T(3), score: 62 }, { ts: T(13), score: 78 }, { ts: T(23), score: 85 }
  ]))
  // 快照（C 盘首尾）
  const insS = db.prepare('INSERT INTO snapshots (ts, root, total_bytes, file_count, dir_count) VALUES (?, ?, ?, 0, 0)')
  insS.run(T(1), 'C:\\', 100 * 1024 ** 3)
  insS.run(T(28), 'C:\\', 97 * 1024 ** 3)
  fx = mkdtempSync(join(tmpdir(), 'cs-report-'))
})

afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v2.3 F7 月度报告（日志注入 → 数字一致）', () => {
  it('聚合：清理 3.05GB/3 文件、整理 2、空目录 1、趋势 3 次、C 盘 -3GB', () => {
    const s = aggregateMonth(db, MONTH)
    expect(s.cleanedFiles).toBe(3)
    expect(s.cleanedBytes).toBe(2 * 1024 ** 3 + 1024 ** 3 + 50 * 1024 ** 2)
    expect(s.organizedFiles).toBe(2)
    expect(s.emptyDirs).toBe(1)
    expect(s.scoreHistory.length).toBe(3)
    expect(s.spaceDelta).toBe(-3 * 1024 ** 3)
    // TOP1 是最大项
    expect(s.topItems[0].path).toContain('big1.tmp')
  })

  it('跨月隔离：11 月无数据', () => {
    const s = aggregateMonth(db, '2026-11')
    expect(s.cleanedFiles).toBe(0)
    expect(s.scoreHistory.length).toBe(0)
  })

  it('HTML 单文件自包含（无外部资源引用）+ 关键数字在文中', () => {
    const s = aggregateMonth(db, MONTH)
    const html = renderReport(s)
    expect(html).toContain('<style>')            // 样式内嵌
    expect(html).not.toMatch(/src=["']https?:/)  // 无外链
    expect(html).not.toMatch(/href=["']https?:/)
    expect(html).toContain('2026-10')
    expect(html).toContain('3.05 GB')            // 清理总量
    expect(html).toContain('svg')                // 趋势图
  })
})
