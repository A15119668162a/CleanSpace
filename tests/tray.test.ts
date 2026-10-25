import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { getSettings, setSetting } from '../src/main/health/settings'

let db: Database.Database
beforeAll(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
})

describe('v1.3 托盘相关设置', () => {
  it('close_to_tray 默认开启', () => {
    expect(getSettings(db).closeToTray).toBe(true)
  })
  it('可关闭并读回', () => {
    setSetting(db, 'close_to_tray', '0')
    expect(getSettings(db).closeToTray).toBe(false)
    setSetting(db, 'close_to_tray', '1')
    expect(getSettings(db).closeToTray).toBe(true)
  })
})
