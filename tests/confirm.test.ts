import { describe, it, expect } from 'vitest'
import { validateConfirm, BIG_BYTES, BIG_FILES } from '../src/main/cleaner/execute'

const f = (size: number) => ({ path: 'C:\\x\\f.bin', size, mtime: 0 })

describe('P2 三级确认（红线 #3：大批量需文字确认）', () => {
  it('阈值常量正确（>10GB 或 >500 文件）', () => {
    expect(BIG_BYTES).toBe(10 * 1024 ** 3)
    expect(BIG_FILES).toBe(500)
  })

  it('仅勾选（checked）不允许执行', () => {
    expect(validateConfirm([f(100)], 'checked')).toContain('明细预览')
  })

  it('预览后（previewed）也不可直接执行——必须执行确认', () => {
    expect(validateConfirm([f(100)], 'previewed')).toBeTruthy()
  })

  it('小批量：confirmed 即可', () => {
    expect(validateConfirm([f(100), f(200)], 'confirmed')).toBeNull()
  })

  it('大批量（>500 文件）：confirmed 不够，必须 text-confirmed（红线测试 #5）', () => {
    const files = Array.from({ length: 501 }, (_, i) => f(10))
    const err = validateConfirm(files, 'confirmed')
    expect(err).toBeTruthy()
    expect(err).toContain('二次确认')
    expect(validateConfirm(files, 'text-confirmed')).toBeNull()
  })

  it('大批量（>10GB）：同样需要 text-confirmed', () => {
    const files = [f(BIG_BYTES + 1)]
    expect(validateConfirm(files, 'confirmed')).toBeTruthy()
    expect(validateConfirm(files, 'text-confirmed')).toBeNull()
  })

  it('恰好 500 文件不算大批量', () => {
    const files = Array.from({ length: 500 }, () => f(10))
    expect(validateConfirm(files, 'confirmed')).toBeNull()
  })
})
