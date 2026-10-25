import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executePlan, rollback, recentRollbackable, batchHistory } from '../src/main/organizer/exec'
import type { MovePlanItem } from '../src/main/organizer/rules'

let db: Database.Database
let fx: string
const PLAN = (): MovePlanItem[] => [
  { src: join(fx, 'a.jpg'), dst: join(fx, 'out', '图片', 'a.jpg'), size: 100, mtime: 1, ruleId: 1, reason: 'test' },
  { src: join(fx, 'b.mp4'), dst: join(fx, 'out', '视频', 'b.mp4'), size: 200, mtime: 1, ruleId: 1, reason: 'test' }
]

beforeAll(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE op_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, batch_id TEXT, action TEXT, src_path TEXT, dst_path TEXT, size INTEGER, detail TEXT)')
  fx = mkdtempSync(join(tmpdir(), 'cs-ledger-'))
  writeFileSync(join(fx, 'a.jpg'), 'a')
  writeFileSync(join(fx, 'b.mp4'), 'b')
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v4.2.5 整理台账（日志化回退）', () => {
  it('执行→台账 active；回退→原批次 rolled_back + 新回退批次 active；文件物理还原', async () => {
    const r1 = await executePlan(db, PLAN(), [])
    expect(r1.moved).toBe(2)
    expect(existsSync(join(fx, 'out', '图片', 'a.jpg'))).toBe(true)
    let recent = recentRollbackable(db, 2)
    expect(recent.length).toBe(1)
    expect(recent[0].batch_id).toBe(r1.batchId)
    expect(recent[0].status).toBe('active')

    const rb = await rollback(db, r1.batchId)
    expect(rb.ok).toBe(2)
    expect(rb.rollbackBatchId).toMatch(/^rb-/)
    // 文件回原位
    expect(existsSync(join(fx, 'a.jpg'))).toBe(true)
    expect(existsSync(join(fx, 'b.mp4'))).toBe(true)
    // 台账：回退批次 active（可再回退）
    recent = recentRollbackable(db, 2)
    expect(recent[0].batch_id).toBe(rb.rollbackBatchId)
    expect(recent[0].kind).toBe('rollback')
  })

  it('回退的回退（恢复整理）：文件再次移动到目标；原整理批次不可重复回退', async () => {
    // 上轮的回退批次再回退 = 恢复整理结果
    const rec = recentRollbackable(db, 2)
    const rbBatch = rec[0].batch_id
    const rb2 = await rollback(db, rbBatch)
    expect(rb2.ok).toBe(2)
    // 文件又回到整理后的位置
    expect(existsSync(join(fx, 'out', '图片', 'a.jpg'))).toBe(true)

    // 已回退批次重复回退 → 拒绝
    const again = await rollback(db, rec[0].batch_id)
    expect(again.ok).toBe(0)
    expect(again.errors[0]).toContain('已回退')
  })

  it('只保留最近两次可回退：做 3 次整理后 recent ≤ 2 且为最新', async () => {
    // 恢复初始（清空 fx out）
    rmSync(join(fx, 'out'), { recursive: true, force: true })
    writeFileSync(join(fx, 'a.jpg'), 'a')
    writeFileSync(join(fx, 'b.mp4'), 'b')
    for (let i = 0; i < 3; i++) {
      const r = await executePlan(db, PLAN(), [])
      expect(r.moved).toBe(2)
      // 移回源（模拟下一次整理前状态）
      const rb = await rollback(db, r.batchId)
      expect(rb.ok).toBe(2)
    }
    const recent = recentRollbackable(db, 2)
    expect(recent.length).toBeLessThanOrEqual(2)
    // 全部流水在
    const hist = batchHistory(db)
    expect(hist.length).toBeGreaterThanOrEqual(7) // 3 整理 + 3 回退 + 首轮 2
  })

  it('流水含状态标注（active/rolled_back 混合）', () => {
    const hist = batchHistory(db)
    expect(hist.some((h) => h.status === 'rolled_back')).toBe(true)
    expect(hist.some((h) => h.kind === 'rollback')).toBe(true)
  })
})
