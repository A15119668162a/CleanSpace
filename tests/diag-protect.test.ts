import { describe, it, expect } from 'vitest'
import { isProtected, globToRegExp } from '../src/shared/whitelist'

const rules = [
  { id: 1, pattern: 'C:/Windows/**', enabled: true, builtin: true },
  { id: 5, pattern: 'C:/Users/*/Documents/**', enabled: true, builtin: true },
  { id: 6, pattern: 'C:/Users/*/Documents/WeChat Files/**', enabled: true, builtin: true },
  { id: 9, pattern: 'C:/Users/*/AppData/Roaming/DingTalk/**', enabled: true, builtin: true }
]

describe('诊断：isProtected 是否误拦垃圾扫描路径', () => {
  it('Temp 目录及其文件不被拦截', () => {
    expect(isProtected('C:\\Users\\Administrator\\AppData\\Local\\Temp\\abc.tmp', rules)).toBe(false)
    expect(isProtected('C:\\Users\\Administrator\\AppData\\Local\\Temp', rules)).toBe(false)
  })
  it('缩略图/浏览器缓存/CrashDumps 不拦截', () => {
    expect(isProtected('C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_wb.db', rules)).toBe(false)
    expect(isProtected('C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_001', rules)).toBe(false)
    expect(isProtected('C:\\Users\\Administrator\\AppData\\Local\\CrashDumps\\a.dmp', rules)).toBe(false)
  })
  it('Windows 目录确实拦截（win-update 目标被白名单拦——预期行为？）', () => {
    const r = isProtected('C:\\Windows\\SoftwareDistribution\\Download\\x.msu', rules)
    console.log('win-update 目标被拦:', r)
  })
  it('Documents 仍正确拦截', () => {
    expect(isProtected('C:\\Users\\Administrator\\Documents\\a.docx', rules)).toBe(true)
  })
  it('glob `*` 不跨层（Administrator 单层）', () => {
    const re = globToRegExp('C:/Users/*/Documents/**')
    console.log('regex:', re.source)
    expect(re.test('c:/users/administrator/documents/a.docx')).toBe(true)
    expect(re.test('c:/users/administrator/documents/sub/a.docx')).toBe(true)
  })
})
