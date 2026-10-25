import { describe, it, expect } from 'vitest'
import { REDLINES } from '../src/shared/redlines'

describe('v4.0 安全红线页（方向 A）', () => {
  it('21 条完整：编号 1-21 连续不重不漏', () => {
    expect(REDLINES.length).toBe(21)
    const nos = REDLINES.map(r => r.no).sort((a, b) => a - b)
    expect(nos).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
  })

  it('每条四要素齐全：标题>4字 / 白话>10字 / 守护方式 / 期数', () => {
    for (const r of REDLINES) {
      expect(r.title.length, `#${r.no} title`).toBeGreaterThan(4)
      expect(r.plain.length, `#${r.no} plain`).toBeGreaterThan(10)
      expect(r.guard.length).toBeGreaterThan(2)
      expect(['一期', '二期', '三期']).toContain(r.since)
    }
  })

  it('关键红线在列：物理隔离×2 / 只读 / 可撤销', () => {
    const t = REDLINES.map(r => r.title).join('|')
    expect(t).toContain('聊天记录物理隔离')
    expect(t).toContain('浏览器五类数据物理隔离')
    expect(t).toContain('EXIF 只读')
    expect(t).toContain('一切删除可撤销')
  })
})
