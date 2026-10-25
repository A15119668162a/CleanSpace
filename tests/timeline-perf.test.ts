/**
 * 时间线构建性能（v4.0 方向 A）
 * 抽取 MediaView.buildTimeline 同构逻辑：3 万条年月分组 < 500ms。
 */
import { describe, it, expect } from 'vitest'

interface T { t: number; path: string }

/** 与 MediaView.buildTimeline 相同算法（纯函数版） */
export function buildTimeline(all: T[]): Array<{ year: number; months: Array<{ month: number; hits: T[] }> }> {
  const by = new Map<string, T[]>()
  for (const h of all) {
    const d = new Date(h.t)
    if (Number.isNaN(d.getTime())) continue
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const arr = by.get(k) || []
    arr.push(h)
    by.set(k, arr)
  }
  const keys = [...by.keys()].sort((a, b) => b.localeCompare(a))
  const years: Array<{ year: number; months: Array<{ month: number; hits: T[] }> }> = []
  for (const k of keys) {
    const [y, m] = k.split('-').map(Number)
    let Y = years.find(x => x.year === y)
    if (!Y) { Y = { year: y, months: [] }; years.push(Y) }
    const hits = by.get(k)!.sort((a, b) => b.t - a.t)
    Y.months.push({ month: m, hits })
  }
  return years
}

describe('v4.0 时间线性能（3 万张）', () => {
  it('构建 30,000 条 < 500ms，分组正确', () => {
    const N = 30_000
    const now = Date.now()
    const all: T[] = Array.from({ length: N }, (_, i) => ({
      t: now - Math.floor(Math.random() * 5 * 365 * 86400e3),
      path: `C:/photos/p${i}.jpg`
    }))
    const t0 = performance.now()
    const g = buildTimeline(all)
    const ms = performance.now() - t0
    expect(g.length).toBeGreaterThanOrEqual(4) // 5 年随机
    expect(g.reduce((s, y) => s + y.months.reduce((s2, m) => s2 + m.hits.length, 0), 0)).toBe(N)
    expect(ms).toBeLessThan(500)
  })

  it('年降序、月内时间降序', () => {
    const all = [
      { t: new Date(2024, 2, 15).getTime(), path: 'a' },
      { t: new Date(2024, 2, 10).getTime(), path: 'b' },
      { t: new Date(2023, 11, 1).getTime(), path: 'c' }
    ]
    const g = buildTimeline(all)
    expect(g[0].year).toBe(2024)
    expect(g[0].months[0].hits[0].path).toBe('a')
    expect(g[1].year).toBe(2023)
  })
})
