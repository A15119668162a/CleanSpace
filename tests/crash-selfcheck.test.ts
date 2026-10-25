import { describe, it, expect } from 'vitest'
import { KIND_TEXT, type CrashMark } from '../src/main/health/crash'
import { runSelfCheck } from '../src/main/health/selfcheck'
import Database from 'better-sqlite3'

describe('v4.1 崩溃恢复 + 自检', () => {
  it('KIND_TEXT 四类齐全（白话映射完整）', () => {
    for (const k of ['uncaught', 'unhandled', 'renderer-gone', 'oom'] as const) {
      expect(KIND_TEXT[k].length).toBeGreaterThan(3)
    }
  })

  it('CrashMark 形状：版本/时间/类型/摘要', () => {
    const m: CrashMark = { version: '4.1.0', ts: Date.now(), kind: 'oom', summary: 'x'.repeat(300) }
    expect(m.summary.length).toBe(300) // 写入侧才截断——类型允许
  })

  it('自检四项（真实环境）：db/cdisk/ffmpeg/update 全返回且带 label', async () => {
    const db = new Database(':memory:')
    const items = await runSelfCheck(db as never)
    expect(items.length).toBe(4)
    expect(items.map(i => i.id).sort()).toEqual(['cdisk', 'db', 'ffmpeg', 'update'])
    for (const i of items) {
      expect(i.label.length).toBeGreaterThan(2)
      expect(typeof i.ok).toBe('boolean')
      if (!i.ok) expect(i.note).toBeTruthy() // 异常必须给白话说明
    }
    // 内存库 integrity 必然 ok
    expect(items.find(i => i.id === 'db')!.ok).toBe(true)
  }, 30_000)
})
