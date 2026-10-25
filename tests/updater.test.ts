import { describe, it, expect } from 'vitest'
import { UPDATE_URL, pruneVersions } from '../src/shared/update-policy'

describe('v2.4 F8 自动更新（纯函数）', () => {
  it('更新源指向 cbxs.top 自建源', () => {
    expect(UPDATE_URL).toBe('https://cbxs.top/update/cleanspace/')
  })

  it('滚动保留：3 版内不删', () => {
    expect(pruneVersions(['2.4.0', '2.3.0', '2.2.1'])).toEqual([])
    expect(pruneVersions(['2.2.1'])).toEqual([])
    expect(pruneVersions([])).toEqual([])
  })

  it('滚动保留：第 4 版出现时删最旧', () => {
    const del = pruneVersions(['2.4.0', '2.3.0', '2.2.1', '2.1.0'])
    expect(del).toEqual(['2.1.0'])
    const del2 = pruneVersions(['2.5.0', '2.4.0', '2.3.0', '2.2.1', '2.1.0'])
    expect(del2).toEqual(['2.2.1', '2.1.0'])
  })

  it('语义版本数字序（10.0 > 9.9 不按字典序）', () => {
    const del = pruneVersions(['10.0.0', '9.9.0', '9.8.0', '9.7.0'])
    expect(del).toEqual(['9.7.0'])
  })
})
