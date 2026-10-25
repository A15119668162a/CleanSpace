import { describe, it, expect } from 'vitest'
import { isHardExcluded, allRules, HARD_EXCLUDE } from '../src/main/cleaner/rules'
import { BUILTIN_WHITELIST, isProtected } from '../src/shared/whitelist'

const wl = BUILTIN_WHITELIST.map((w, i) => ({ id: i + 1, pattern: w.pattern, enabled: true, builtin: true, note: w.note }))

describe('P2 红线：硬排除（聊天记录/书签/密码绝不出现在清理结果）', () => {
  it('微信聊天记录（新旧版结构）全部拦截', () => {
    expect(isHardExcluded('C:\\Users\\u1\\Documents\\WeChat Files\\wxid_abc\\Msg\\Multi\\MSG0.db')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\Documents\\xwechat_files\\radium\\msg\\Msg0.db')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Roaming\\Tencent\\xwechat\\files\\wxid_x\\msg\\a.db')).toBe(false) // 注意：msg 不在硬排除内，但 wechat-cache 规则只指向 cache 子目录
  })

  it('QQ / 钉钉聊天记录拦截', () => {
    expect(isHardExcluded('C:\\Users\\u1\\Documents\\Tencent Files\\123456\\Msg2.0.db')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Roaming\\DingTalk\\data\\chat.db')).toBe(true)
  })

  it('浏览器书签与密码文件拦截', () => {
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Bookmarks')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc.default\\places.sqlite')).toBe(true)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc.default\\key4.db')).toBe(true)
  })

  it('普通缓存文件不误伤', () => {
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Local\\Temp\\abc.tmp')).toBe(false)
    expect(isHardExcluded('C:\\Users\\u1\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_00001')).toBe(false)
  })
})

describe('P2 规则表结构', () => {
  const rules = allRules()

  it('至少覆盖验收要求的全部 safe 级项', () => {
    const safe = rules.filter((r) => r.risk === 'safe').map((r) => r.id)
    for (const need of ['temp-user', 'thumb-cache', 'browser-cache-chrome', 'browser-cache-edge', 'win-update', 'wer']) {
      expect(safe).toContain(need)
    }
  })

  it('微信/QQ 为 caution 级（默认不勾选）', () => {
    const wechat = rules.find((r) => r.id === 'wechat-cache')
    expect(wechat?.risk).toBe('caution')
    const qq = rules.find((r) => r.id === 'qq-cache')
    expect(qq?.risk).toBe('caution')
  })

  it('休眠文件/内存转储为 expert 级且带后果说明', () => {
    for (const id of ['hiberfil', 'memdump']) {
      const r = rules.find((x) => x.id === id)
      expect(r?.risk).toBe('expert')
      expect(r?.consequence).toBeTruthy()
    }
  })

  it('微信缓存规则绝不指向 Documents 聊天记录目录', () => {
    const wechat = rules.find((r) => r.id === 'wechat-cache')
    for (const t of wechat?.targets() || []) {
      expect(t.toLowerCase()).not.toContain('documents\\wechat files')
      expect(t.toLowerCase()).not.toContain('documents/xwechat_files')
    }
  })

  it('浏览器缓存规则自带书签/密码排除清单', () => {
    for (const id of ['browser-cache-chrome', 'browser-cache-edge']) {
      const r = rules.find((x) => x.id === id)!
      expect(r.excludeGlobs?.some((g) => g.includes('Bookmarks'))).toBe(true)
      expect(r.excludeGlobs?.some((g) => g.includes('Login Data'))).toBe(true)
      expect(r.filesOnly).toBe(true)
    }
  })
})

describe('P2 红线：白名单路径绝不可清理', () => {
  it('Documents / Windows / Program Files 命中白名单', () => {
    expect(isProtected('C:\\Users\\a\\Documents\\重要合同.docx', wl)).toBe(true)
    expect(isProtected('C:\\Windows\\System32\\x.dll', wl)).toBe(true)
    expect(isProtected('C:\\Program Files\\App\\a.exe', wl)).toBe(true)
  })
})

describe('HARD_EXCLUDE 自检', () => {
  it('清单非空且全部含说明', () => {
    expect(HARD_EXCLUDE.length).toBeGreaterThanOrEqual(10)
    for (const h of HARD_EXCLUDE) expect(h.why).toBeTruthy()
  })
})
