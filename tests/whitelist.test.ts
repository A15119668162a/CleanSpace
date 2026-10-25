import { describe, it, expect } from 'vitest'
import { isProtected, normalizePath, BUILTIN_WHITELIST } from '@shared/whitelist'

const rules = BUILTIN_WHITELIST.map((w, i) => ({
  id: i + 1,
  pattern: w.pattern,
  enabled: true,
  builtin: true,
  note: w.note
}))

describe('安全红线 #1：白名单硬保护', () => {
  it('系统目录受保护：C:\\Windows 及其下所有文件', () => {
    expect(isProtected('C:\\Windows\\System32\\drivers\\etc\\hosts', rules)).toBe(true)
    expect(isProtected('C:\\Windows', rules)).toBe(true)
  })

  it('Program Files（含 x86 / Arm）受保护', () => {
    expect(isProtected('C:\\Program Files\\App\\app.exe', rules)).toBe(true)
    expect(isProtected('C:\\Program Files (x86)\\App\\app.exe', rules)).toBe(true)
  })

  it('用户文档目录受保护（任意用户名）', () => {
    expect(isProtected('C:\\Users\\alice\\Documents\\report.docx', rules)).toBe(true)
    expect(isProtected('C:\\Users\\bob\\Documents\\work\\notes.txt', rules)).toBe(true)
    expect(isProtected('D:\\Users\\bob\\Documents\\a.txt', rules)).toBe(false) // 仅 C 盘默认
  })

  it('聊天记录目录绝不放行：微信 / QQ / 钉钉', () => {
    expect(isProtected('C:\\Users\\u1\\Documents\\WeChat Files\\wxid_x\\Msg\\a.db', rules)).toBe(true)
    expect(isProtected('C:\\Users\\u1\\Documents\\xwechat_files\\radium\\a.db', rules)).toBe(true)
    expect(isProtected('C:\\Users\\u1\\Documents\\Tencent Files\\123456\\a.db', rules)).toBe(true)
    expect(isProtected('C:\\Users\\u1\\AppData\\Roaming\\DingTalk\\x.dat', rules)).toBe(true)
  })

  it('普通目录不受保护', () => {
    expect(isProtected('D:\\Downloads\\movie.mkv', rules)).toBe(false)
    expect(isProtected('C:\\Users\\alice\\Downloads\\a.zip', rules)).toBe(false)
  })

  it('路径分隔符与大小写不影响判定', () => {
    expect(isProtected('c:/windows/system32/cmd.exe', rules)).toBe(true)
    expect(isProtected('C:\\WINDOWS\\regedit.exe', rules)).toBe(true)
  })

  it('禁用的规则不生效', () => {
    const disabled = [{ id: 1, pattern: 'C:/Windows/**', enabled: false, builtin: true }]
    expect(isProtected('C:\\Windows\\notepad.exe', disabled)).toBe(false)
  })
})

describe('normalizePath', () => {
  it('反斜杠 → 正斜杠并转小写', () => {
    expect(normalizePath('C:\\Users\\ALICE\\Dt')).toBe('c:/users/alice/dt')
  })
})
