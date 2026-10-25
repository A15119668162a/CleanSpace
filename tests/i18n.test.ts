import { describe, it, expect } from 'vitest'
import { NAV, TABS, BUTTONS, CLEAN, MEDIA, dict } from '../src/renderer/src/i18n/dict'

describe('v3.4 G8 i18n（zh/en key 完整性 0 缺失）', () => {
  it('三段词典 zh/en key 集合完全一致', () => {
    for (const sec of [NAV, TABS, BUTTONS, CLEAN, MEDIA]) {
      const zk = Object.keys(sec.zh).sort()
      const ek = Object.keys(sec.en).sort()
      expect(ek).toEqual(zk)
    }
  })

  it('en 值无空串（漏译=空也过不了）', () => {
    for (const sec of [NAV, TABS, BUTTONS, CLEAN, MEDIA]) {
      for (const [k, v] of Object.entries(sec.en)) {
        expect(String(v).length, `en.${k} 为空`).toBeGreaterThan(0)
      }
    }
  })

  it('dict() 合并视图两语言同 key 数', () => {
    const zh = dict('zh')
    const en = dict('en')
    expect(Object.keys(zh).length).toBe(Object.keys(en).length)
    expect(Object.keys(zh).length).toBeGreaterThanOrEqual(90)
  })

  it('核心词双语抽检', () => {
    expect(NAV.en.scanC).toContain('Scan')
    expect(CLEAN.en.caution).toBe('Caution')
    expect(MEDIA.en.timeline).toBe('Timeline')
    expect(NAV.zh.scanC).toContain('扫描')
  })
})
