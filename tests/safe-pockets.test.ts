import { describe, it, expect } from 'vitest'
import { isProtected, isSafePocket, SAFE_POCKETS, BUILTIN_WHITELIST, type WhitelistRule } from '../src/shared/whitelist'

const RULES: WhitelistRule[] = BUILTIN_WHITELIST.map((b, i) => ({ id: i + 1, pattern: b.pattern, enabled: true, builtin: true, note: b.note }))

describe('v4.2.2 安全口袋（保护目录里的安全垃圾可清）', () => {
  it('口袋命中：Windows Temp/更新缓存/错误报告不受保护伞拦截', () => {
    expect(isSafePocket('C:\\Windows\\Temp\\abc.tmp')).toBe(true)
    expect(isSafePocket('C:\\Windows\\SoftwareDistribution\\Download\\kb5034441.msu')).toBe(true)
    expect(isSafePocket('C:\\Windows\\Minidump\\1024.dmp')).toBe(true)
    expect(isSafePocket('C:\\Windows\\Prefetch\\CHROME.EXE.pf')).toBe(true)
    expect(isSafePocket('C:\\Users\\john\\AppData\\Local\\Microsoft\\Windows\\WER\\Report.wer')).toBe(true)
    // isProtected 全链：口袋优先于 C:/Windows/**
    expect(isProtected('C:\\Windows\\Temp\\x.tmp', RULES)).toBe(false)
    expect(isProtected('C:\\Windows\\SoftwareDistribution\\Download\\a.msu', RULES)).toBe(false)
  })

  it('口袋不越界：系统关键位置仍被保护（红线 1 不破）', () => {
    expect(isProtected('C:\\Windows\\System32\\cmd.exe', RULES)).toBe(true)
    expect(isProtected('C:\\Windows\\explorer.exe', RULES)).toBe(true)
    expect(isProtected('C:\\Windows\\SysWOW64\\dllhost.exe', RULES)).toBe(true)
    expect(isProtected('C:\\Program Files\\app\\app.exe', RULES)).toBe(true)
    expect(isProtected('C:\\Windows\\inetsrv\\config\\schema', RULES)).toBe(true)
    // System32 里的 .log 也不放开（只放开精确口袋目录）
    expect(isProtected('C:\\Windows\\System32\\logs\\wmi.log', RULES)).toBe(true)
    // 聊天记录（红线 21）与文档仍保护
    expect(isProtected('C:\\Users\\a\\Documents\\WeChat Files\\wxid\\Msg\\MSG0.db', RULES)).toBe(true)
    expect(isProtected('C:\\Users\\a\\Documents\\报表.xlsx', RULES)).toBe(true)
  })

  it('通配口袋：任意用户名命中，但不跨层', () => {
    expect(isSafePocket('C:\\Users\\zhang\\AppData\\Local\\CrashDumps\\app.dmp')).toBe(true)
    expect(isSafePocket('C:\\Users\\zhang\\AppData\\Roaming\\CrashDumps\\app.dmp')).toBe(false) // Local 才是口袋
  })

  it('开关：safePockets:false 恢复完全保护', () => {
    expect(isProtected('C:\\Windows\\Temp\\x.tmp', RULES, { safePockets: false })).toBe(true)
    expect(isProtected('C:\\Windows\\SoftwareDistribution\\Download\\a.msu', RULES, { safePockets: false })).toBe(true)
  })

  it('口袋清单本身不含通配结尾/Program Files（防未来误改）', () => {
    for (const p of SAFE_POCKETS) {
      expect(p.endsWith('/*')).toBe(false)
      expect(p.includes('program files')).toBe(false)
      expect(p.startsWith('c:/')).toBe(true)
    }
  })
})
