import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isForbiddenPath, findProfiles, scanProfile, CHROMIUM_ZONES, FORBIDDEN_BROWSER, type BrowserProfile } from '../src/main/cleaner/browser'
import { analyzeDeep, ACTIONS, isAdmin } from '../src/main/cleaner/deep'

let fx: string

beforeAll(() => {
  fx = mkdtempSync(join(tmpdir(), 'cs-g6-'))
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v3.2 G6 浏览器专清（红线 18：五类数据物理隔离）', () => {
  it('红线 18：书签/密码/历史/扩展/自动填充路径在任何形式下都被拒绝', () => {
    // 直接名
    for (const f of ['Bookmarks', 'Bookmarks.bak', 'Login Data', 'History', 'Web Data', 'places.sqlite', 'logins.json', 'key4.db', 'formhistory.sqlite']) {
      expect(isForbiddenPath(join('C:', 'x', 'Default', f))).toBe(true)
    }
    // 完整路径
    expect(isForbiddenPath('C:/Users/a/AppData/Local/Google/Chrome/User Data/Default/Login Data')).toBe(true)
    expect(isForbiddenPath('C:\\Users\\a\\...\\Default\\Bookmarks.bak')).toBe(true)
    // 扩展目录
    expect(isForbiddenPath(join('C:', 'x', 'Default', 'Extensions'))).toBe(true)
    // 正常缓存不受影响
    expect(isForbiddenPath(join('C:', 'x', 'Default', 'Cache', 'data_1'))).toBe(false)
    expect(isForbiddenPath(join('C:', 'x', 'Default', 'Code Cache', 'js', 'abc'))).toBe(false)
  })

  it('红线 18 实战：构造含禁区文件的 Profile——扫描结果零泄漏', async () => {
    const root = join(fx, 'Default')
    mkdirSync(join(root, 'Cache'), { recursive: true })
    mkdirSync(join(root, 'Extensions', 'ext1'), { recursive: true })
    writeFileSync(join(root, 'Cache', 'f_00.dat'), 'cache'.repeat(100))
    writeFileSync(join(root, 'Cache', 'data_1'), 'x'.repeat(50))
    writeFileSync(join(root, 'Bookmarks'), '{"roots":{}}')      // 禁区
    writeFileSync(join(root, 'Login Data'), 'sqlite-head')       // 禁区
    writeFileSync(join(root, 'History'), 'hist')                 // 禁区
    writeFileSync(join(root, 'Web Data'), 'web')                 // 禁区
    writeFileSync(join(root, 'Extensions', 'ext1', 'manifest.json'), '{}') // 禁区目录
    const prof: BrowserProfile = { browser: 'chrome', name: 'Default', root, sizeMB: 1 }
    const items = await scanProfile(prof)
    expect(items.filter((i) => isForbiddenPath(i.path))).toEqual([]) // 零禁区泄漏
    expect(items.some((i) => i.path.includes('f_00.dat'))).toBe(true) // 正常缓存入列
    expect(items.some((i) => i.path.includes('Bookmarks'))).toBe(false)
    expect(items.some((i) => i.path.includes('Extensions'))).toBe(false)
  })

  it('分区定义：safe 默认无后果文案缺失；caution 必须带后果', () => {
    for (const z of [...CHROMIUM_ZONES]) {
      if (z.level === 'caution') expect(z.consequence).toBeTruthy()
    }
  })

  it('禁区字典覆盖五类核心文件名', () => {
    const j = FORBIDDEN_BROWSER.join(' ').toLowerCase()
    for (const k of ['bookmark', 'login', 'history', 'extension', 'web data', 'places.sqlite', 'logins.json', 'key4.db']) {
      expect(j).toContain(k)
    }
  })
})

describe('v3.2 G5 深度专清（红线 17）', () => {
  it('分析只读零异常（真实系统跑通；DISM 分析可达数分钟）', async () => {
    const r = await analyzeDeep()
    expect(typeof r.admin).toBe('boolean')
    expect(r.hiberfil.present === false || typeof r.hiberfil.sizeGB === 'number').toBe(true)
    expect(r.winSxS.supported === false || r.winSxS.raw === undefined || typeof r.winSxS.raw === 'string').toBe(true)
  }, 360_000)

  it('红线 17：ACTIONS 不含 /ResetBase、不删页面文件；不可逆项须文字确认', () => {
    for (const a of ACTIONS) {
      expect(a.consequence.length).toBeGreaterThan(10) // 后果说明卡必须白话充分
      if (!a.reversible) expect(a.typedConfirm).toBe(true) // 不可逆→文字确认
    }
    const ws = ACTIONS.find((a) => a.id === 'winsxs')!
    expect(ws.reversible).toBe(true)
    // 页面文件不在任何清理项里
    expect(ACTIONS.some((a) => /pagefile|页面文件/i.test(a.title))).toBe(false)
  })

  it('isAdmin 探测不抛异常', async () => {
    await expect(isAdmin()).resolves.toBeDefined()
  })
})
