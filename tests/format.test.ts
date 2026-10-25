import { describe, it, expect } from 'vitest'
import { formatBytes } from '@shared/format'

describe('formatBytes', () => {
  it('边界值', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('--')
    expect(formatBytes(Number.NaN)).toBe('--')
  })
  it('各单位', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB')
    expect(formatBytes(12.6 * 1024 ** 3)).toBe('12.60 GB')
  })
})
