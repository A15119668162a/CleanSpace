import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { getAlertConfig, setAlertConfig, checkDisks, recentlyAlerted } from '../src/main/health/alerts'

let db: Database.Database
beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE alerts_log (id INTEGER PRIMARY KEY AUTOINCREMENT, drive TEXT, ts INTEGER, free_bytes INTEGER);
  `)
})

const GB = 1024 ** 3

describe('v2.1 空间预警（F4）', () => {
  it('默认配置：30 分钟 / C 10GB / 其他 5GB / 启用', () => {
    const c = getAlertConfig(db)
    expect(c.intervalMin).toBe(30)
    expect(c.cThresholdGB).toBe(10)
    expect(c.otherThresholdGB).toBe(5)
    expect(c.enabled).toBe(true)
  })

  it('配置读写往返', () => {
    setAlertConfig(db, { intervalMin: 60, cThresholdGB: 20, enabled: false })
    const c = getAlertConfig(db)
    expect(c.intervalMin).toBe(60)
    expect(c.cThresholdGB).toBe(20)
    expect(c.enabled).toBe(false)
    setAlertConfig(db, { intervalMin: 30, cThresholdGB: 10, enabled: true })
  })

  it('注入磁盘：低于阈值触发、达标不触发', async () => {
    const cfg = getAlertConfig(db)
    const events = await checkDisks(db, cfg, [
      { drive: 'C:', freeBytes: 3 * GB },   // 3GB < 10GB → 触发
      { drive: 'D:', freeBytes: 4 * GB },   // 4GB < 5GB → 触发
      { drive: 'E:', freeBytes: 100 * GB }  // 达标
    ])
    expect(events.length).toBe(2)
    expect(events.find((e) => e.drive === 'C:')).toBeTruthy()
    expect(events.find((e) => e.drive === 'D:')).toBeTruthy()
    expect(events.find((e) => e.drive === 'E:')).toBeFalsy()
  })

  it('红线 9：同一盘 24h 内第二次检查不再触发', async () => {
    const cfg = getAlertConfig(db)
    const e1 = await checkDisks(db, cfg, [{ drive: 'X:', freeBytes: 1 * GB }])
    expect(e1.length).toBe(1)
    const e2 = await checkDisks(db, cfg, [{ drive: 'X:', freeBytes: 1 * GB }])
    expect(e2.length).toBe(0) // 频控拦截
    expect(recentlyAlerted(db, 'X:')).toBe(true)
    expect(recentlyAlerted(db, 'Y:')).toBe(false)
  })

  it('频控 24h 边界：回拨 alerts_log 后可再触发', async () => {
    db.prepare("UPDATE alerts_log SET ts = ? WHERE drive = 'X:'").run(Date.now() - 25 * 3600 * 1000)
    const cfg = getAlertConfig(db)
    const e = await checkDisks(db, cfg, [{ drive: 'X:', freeBytes: 1 * GB }])
    expect(e.length).toBe(1) // 超过 24h → 重新允许
  })

  it('总开关关闭 → 不触发', async () => {
    setAlertConfig(db, { enabled: false })
    const cfg = getAlertConfig(db)
    const e = await checkDisks(db, cfg, [{ drive: 'Z:', freeBytes: 0 }])
    expect(e.length).toBe(0)
    setAlertConfig(db, { enabled: true })
  })
})
