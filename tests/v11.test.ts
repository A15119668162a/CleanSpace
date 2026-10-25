import { describe, it, expect } from 'vitest'
import { quoteTaskPath } from '../src/main/speedup/tasks'
import { pickByPolicy, type Policy } from '../src/main/organizer/policy'

describe('v1.1 计划任务：schtasks 命名转义', () => {
  it('普通路径引号包裹', () => {
    expect(quoteTaskPath('\\MyTask')).toBe('"\\MyTask"')
  })
  it('含引号的路径翻倍转义（防注入）', () => {
    expect(quoteTaskPath('\\Evil"Name')).toBe('"\\Evil""Name"')
  })
})

describe('v1.1 查重保留策略（M3 规格）', () => {
  const files = [
    { path: 'D:\\a\\new.bin', size: 1, mtime: 200 },
    { path: 'D:\\b\\old.bin', size: 1, mtime: 100 },
    { path: 'D:\\c\\mid.bin', size: 1, mtime: 150 }
  ]
  it('保留最早：其余为副本', () => {
    const { keep, victims } = pickByPolicy(files, 'earliest')
    expect(keep.path).toBe('D:\\b\\old.bin')
    expect(victims.length).toBe(2)
    expect(victims.map((v) => v.path)).not.toContain('D:\\b\\old.bin')
  })
  it('保留最新', () => {
    const { keep } = pickByPolicy(files, 'latest')
    expect(keep.path).toBe('D:\\a\\new.bin')
  })
  it('保留路径最短（等长时最早优先）', () => {
    const { keep } = pickByPolicy(files, 'shortest-path')
    expect(keep.path).toBe('D:\\b\\old.bin') // 三条等长 → tie-break mtime 最早
    const deep = [
      { path: 'D:\\a\\b\\c\\deep.bin', size: 1, mtime: 1 },
      { path: 'D:\\shallow.bin', size: 1, mtime: 9 }
    ]
    expect(pickByPolicy(deep, 'shortest-path').keep.path).toBe('D:\\shallow.bin')
  })
  it('空组与单文件安全', () => {
    expect(pickByPolicy([], 'earliest').keep).toBeNull()
    const one = [{ path: 'x', size: 1, mtime: 1 }]
    expect(pickByPolicy(one, 'earliest').victims.length).toBe(0)
  })
  it('策略类型完整', () => {
    const ps: Policy[] = ['earliest', 'latest', 'shortest-path']
    expect(ps.length).toBe(3)
  })
})
