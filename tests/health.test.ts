import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { runCheckup, saveCheckup, lastCheckup, checkupHistory } from '../src/main/health/checkup'
import { getSettings, setSetting, addWhitelist, removeWhitelist, toggleWhitelist, exportLogs } from '../src/main/health/settings'

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE whitelist (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT UNIQUE, enabled INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0, note TEXT);
    CREATE TABLE op_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, batch_id TEXT, action TEXT, src_path TEXT, dst_path TEXT, size INTEGER, detail TEXT);
    CREATE TABLE recycle_items (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, recycled_path TEXT, orig_path TEXT, size INTEGER, ts INTEGER, expires_at INTEGER, restored INTEGER DEFAULT 0);
    CREATE TABLE startup_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, source TEXT, name TEXT, command TEXT, reg_file TEXT, link_file TEXT, ts INTEGER);
  `)
  db.prepare("INSERT INTO whitelist (pattern, enabled, builtin, note) VALUES ('C:/Windows/**', 1, 1, '系统目录')").run()
})

const GB = 1024 ** 3

describe('P5 体检评分', () => {
  it('健康机器应得高分', async () => {
    const r = await runCheckup(db, [], { junkBytes: 0.2 * GB, cFree: 80 * GB, cTotal: 200 * GB, startupCount: 5, recycleBytes: 0.1 * GB })
    expect(r.score).toBeGreaterThanOrEqual(90)
    expect(r.dimensions.length).toBe(4)
    for (const d of r.dimensions) expect(d.fix).toBeTruthy()
  })

  it('垃圾满载 + C 盘告急 + 自启爆炸 → 低分', async () => {
    const r = await runCheckup(db, [], { junkBytes: 25 * GB, cFree: 3 * GB, cTotal: 200 * GB, startupCount: 30, recycleBytes: 12 * GB })
    expect(r.score).toBeLessThanOrEqual(15)
    expect(r.dimensions.find((d) => d.id === 'junk')?.score).toBe(0)
    expect(r.dimensions.find((d) => d.id === 'cdisk')?.score).toBe(0)
    expect(r.dimensions.find((d) => d.id === 'startup')?.score).toBe(0)
  })

  it('各维度阈值边界', async () => {
    // C 盘剩余恰 30% → 100；5% → 0
    const a = await runCheckup(db, [], { junkBytes: 0, cFree: 30 * GB, cTotal: 100 * GB, startupCount: 0, recycleBytes: 0 })
    expect(a.dimensions.find((d) => d.id === 'cdisk')?.score).toBe(100)
    const b = await runCheckup(db, [], { junkBytes: 0, cFree: 5 * GB, cTotal: 100 * GB, startupCount: 0, recycleBytes: 0 })
    expect(b.dimensions.find((d) => d.id === 'cdisk')?.score).toBe(0)
    // 启动项 8 → 100；25 → 0
    const c = await runCheckup(db, [], { junkBytes: 0, cFree: 50 * GB, cTotal: 100 * GB, startupCount: 8, recycleBytes: 0 })
    expect(c.dimensions.find((d) => d.id === 'startup')?.score).toBe(100)
    const d = await runCheckup(db, [], { junkBytes: 0, cFree: 50 * GB, cTotal: 100 * GB, startupCount: 25, recycleBytes: 0 })
    expect(d.dimensions.find((x) => x.id === 'startup')?.score).toBe(0)
  })

  it('加权正确：35/30/20/15', async () => {
    // 只有垃圾 0 分，其他满分 → 100 - 35 = 65
    const r = await runCheckup(db, [], { junkBytes: 20 * GB, cFree: 80 * GB, cTotal: 200 * GB, startupCount: 5, recycleBytes: 0 })
    expect(r.score).toBe(65)
  })

  it('存档与历史', async () => {
    const r = await runCheckup(db, [], { junkBytes: 0, cFree: 50 * GB, cTotal: 100 * GB, startupCount: 0, recycleBytes: 0, skipReal: true })
    saveCheckup(db, r)
    expect(lastCheckup(db)?.score).toBe(r.score)
    expect(checkupHistory(db).length).toBe(1)
  })
})

describe('P5 设置中心', () => {
  it('默认值与读写', () => {
    const s = getSettings(db)
    expect(s.recycleKeepDays).toBe(15)
    expect(s.weeklyScan).toBe(true)
    setSetting(db, 'recycle_keep_days', '30')
    expect(getSettings(db).recycleKeepDays).toBe(30)
    setSetting(db, 'recycle_keep_days', '15')
  })

  it('白名单：自定义增/删/启停；内置不可删', () => {
    const add = addWhitelist(db, 'D:\\我的资料', '测试')
    expect(add.ok).toBe(true)
    const dup = addWhitelist(db, 'D:\\我的资料', '再测试')
    expect(dup.ok).toBe(false)
    const bad = addWhitelist(db, 'relative/path', '')
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('绝对路径')

    const rows = db.prepare('SELECT id, builtin FROM whitelist WHERE note = ?').all('测试') as Array<{ id: number; builtin: number }>
    expect(rows.length).toBe(1)
    expect(removeWhitelist(db, rows[0].id)).toBe(true)

    const builtinId = (db.prepare('SELECT id FROM whitelist WHERE builtin = 1').get() as { id: number }).id
    expect(removeWhitelist(db, builtinId)).toBe(false) // 内置拒绝
    expect(toggleWhitelist(db, builtinId, false)).toBe(true) // 但可停用
    toggleWhitelist(db, builtinId, true)
  })

  it('日志导出 CSV（BOM + 转义）', () => {
    db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1700000000000, 'b1', 'clean', 'C:\\x\\带"引号".tmp', 'R:\\a', 123, null)
    const dir = mkdtempSync(join(tmpdir(), 'cs-csv-'))
    const f = join(dir, 'log.csv')
    const r = exportLogs(db, f)
    expect(r.rows).toBeGreaterThanOrEqual(1)
    const txt = readFileSync(f, 'utf8')
    expect(txt.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(txt).toContain('带""引号""') // CSV 转义
    rmSync(dir, { recursive: true, force: true })
  })
})
