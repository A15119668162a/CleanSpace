import { describe, it, expect } from 'vitest'
import { VENDOR_KEEP, matchesInstalledTester } from '../src/main/cleaner/residue'

describe('v2.3 F5 卸载残留红线（厂商字典 + 已装匹配）', () => {
  it('厂商字典覆盖主流厂商（红线 8 前置）', () => {
    for (const v of ['google', 'tencent', 'microsoft', 'adobe', 'wechat', 'dingtalk']) {
      expect(VENDOR_KEEP.has(v)).toBe(true)
    }
  })

  it('已装软件目录匹配（双向包含：目录名含已装名，或已装名含目录名）', () => {
    const inst = new Set(['wechat store', 'chrome', 'visual studio code'])
    expect(matchesInstalledTester('WeChat Store', inst)).toBe(true)   // 大小写无关
    expect(matchesInstalledTester('Chrome', inst)).toBe(true)
    expect(matchesInstalledTester('Code', inst)).toBe(true)           // 'visual studio code'.includes('code')
  })

  it('孤儿目录不误拦（无任何已装关联）', () => {
    const inst = new Set(['chrome'])
    expect(matchesInstalledTester('SomeAbandonedTool', inst)).toBe(false)
    expect(matchesInstalledTester('老软件残留123', inst)).toBe(false)
  })

  it('太短名（<3 字符）不参与匹配——防 qq 误撞一切含 q 目录', () => {
    const inst = new Set(['qq', 'ab'])
    expect(matchesInstalledTester('qq', inst)).toBe(false) // 长度 2 被跳过——厂商字典兜底
  })
})
