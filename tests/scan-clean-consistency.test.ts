import { describe, it, expect } from 'vitest'
import { isProtected, type WhitelistRule } from '../src/shared/whitelist'

/** 同一套开关值下，扫描判定与清理判定必须一致（v4.2.3 修复回归锁） */
const RULES: WhitelistRule[] = [
  { id: 1, pattern: 'C:/Windows/**', enabled: true, builtin: true },
  { id: 2, pattern: 'C:/Program Files/**', enabled: true, builtin: true }
]
const POCKET_FILE = 'C:/Windows/SoftwareDistribution/Download/6677d0c6.tmp'

describe('v4.2.3 扫/清同口径（安全口袋开关一致性）', () => {
  it('开关开：扫描放行 = 清理放行（同一判定函数同参）', () => {
    // isWhitelisted 与 junk:clean 的 isProtected 走同一 opts
    const scanAllows = !isProtected(POCKET_FILE, RULES, { safePockets: true })
    const cleanAllows = !isProtected(POCKET_FILE, RULES, { safePockets: true })
    expect(scanAllows).toBe(cleanAllows)
    expect(scanAllows).toBe(true)
  })

  it('开关关：扫描拦 = 清理拦（不再出现"扫得出清不掉"）', () => {
    const scanBlocks = isProtected(POCKET_FILE, RULES, { safePockets: false })
    const cleanBlocks = isProtected(POCKET_FILE, RULES, { safePockets: false })
    expect(scanBlocks).toBe(cleanBlocks)
    expect(scanBlocks).toBe(true)
  })

  it('非口袋系统文件：任何开关下都双端拦截', () => {
    for (const opt of [{ safePockets: true }, { safePockets: false }] as const) {
      expect(isProtected('C:/Windows/System32/cmd.exe', RULES, opt)).toBe(true)
    }
  })

  it('开关默认值：不传 opts 时口袋开（向后兼容；调用方 ipc 已显式传真实设置）', () => {
    expect(isProtected(POCKET_FILE, RULES)).toBe(false)
  })
})
