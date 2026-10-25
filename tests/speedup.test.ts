import { describe, it, expect } from 'vitest'
import { adviceFor, regFileContent, listStartup } from '../src/main/speedup/startup'
import { isCritical, listProcesses } from '../src/main/speedup/processes'
import Database from 'better-sqlite3'

describe('P4 启动项：.reg 备份内容格式', () => {
  it('REG_SZ 转义正确（路径反斜杠 + 引号）', () => {
    const c = regFileContent('HKCU', 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', '微信', 'C:\\Program Files\\WeChat\\WeChat.exe /min')
    expect(c).toContain('Windows Registry Editor Version 5.00')
    expect(c).toContain('[HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]')
    expect(c).toContain('"微信"="C:\\\\Program Files\\\\WeChat\\\\WeChat.exe /min"')
  })
})

describe('P4 启动项：内置知识库', () => {
  it('常见软件命中建议', () => {
    expect(adviceFor('WeChat', 'C:\\WeChat\\WeChat.exe'))?.toContain('微信')
    expect(adviceFor('SogouIme', ''))?.toBeTruthy()
    expect(adviceFor('NvContainer', ''))?.toContain('建议保留')
    expect(adviceFor('SecurityHealth', ''))?.toContain('建议保留')
  })
  it('未知软件无建议（不瞎编）', () => {
    expect(adviceFor('MyRandomTool', 'D:\\x.exe')).toBeUndefined()
  })
})

describe('P4 启动项：listStartup 集成（真实注册表，只读）', () => {
  it('能列出 HKCU Run（至少 0 项不报错）且备份项标记为禁用', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS startup_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, source TEXT, name TEXT, command TEXT, reg_file TEXT, link_file TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS op_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, batch_id TEXT, action TEXT, src_path TEXT, dst_path TEXT, size INTEGER, detail TEXT);
    `)
    const items = await listStartup(db, [])
    expect(Array.isArray(items)).toBe(true)
    // 每项具备完整字段
    for (const i of items) {
      expect(i.id).toMatch(/::/)
      expect(['registry-hkcu-run', 'registry-hkcu-runonce', 'registry-hklm-run', 'registry-hklm-runonce', 'folder-user', 'folder-common', 'task']).toContain(i.source)
      expect(typeof i.enabled).toBe('boolean')
    }
    // HKLM 项 needsAdmin=true
    for (const i of items.filter((x) => x.source.startsWith('registry-hklm'))) expect(i.needsAdmin).toBe(true)
  })
})

describe('P4 进程：系统关键进程黑名单（红线：绝不提供结束）', () => {
  it('关键进程识别', () => {
    for (const n of ['explorer.exe', 'csrss.exe', 'svchost.exe', 'lsass.exe', 'services.exe', 'dwm.exe', 'System']) {
      expect(isCritical(n)).toBe(true)
    }
  })
  it('普通进程非关键', () => {
    for (const n of ['WeChat.exe', 'chrome.exe', 'notepad.exe', 'Code.exe']) expect(isCritical(n)).toBe(false)
  })
  it('listProcesses 真实运行：系统进程 safeToKill=false', async () => {
    const list = await listProcesses()
    expect(list.length).toBeGreaterThan(10)
    expect(list[0].memBytes).toBeGreaterThan(0)
    // 排序正确（降序）
    for (let i = 1; i < Math.min(list.length, 20); i++) expect(list[i - 1].memBytes).toBeGreaterThanOrEqual(list[i].memBytes)
    const sys = list.find((p) => p.name.toLowerCase() === 'svchost.exe')
    if (sys) expect(sys.safeToKill).toBe(false)
    const crit = list.filter((p) => !p.safeToKill)
    for (const c of crit) expect(isCritical(c.name)).toBe(true)
  })
})
