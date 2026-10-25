/**
 * 整理执行器（P3 → v4.2.5 日志账本重构）
 * - op_log 永不删除（历史完整）；org_batches 批次台账（状态机）
 * - 只允许回退最近 2 个未回退批次（含回退产生的批次——回退可再回退）
 * - 回退 = 反向移动 + 记新批次（action='rollback'）——链式回退
 * - 红线：执行前逐文件白名单/硬排除拦截（不变）
 */
import type Database from 'better-sqlite3'
import { rename, mkdir, stat } from 'fs/promises'
import { parse } from 'path'
import { existsSync } from 'fs'
import { isProtected } from '../../shared/whitelist'
import type { WhitelistRule } from '../../shared/whitelist'
import { isHardExcluded } from '../cleaner/rules'
import type { MovePlanItem } from './rules'

export interface ExecResult {
  batchId: string
  moved: number
  failed: number
  /** 实际落地路径（含冲突后缀后的最终名） */
  movedMap: Array<{ src: string; dst: string }>
  errors: Array<{ src: string; message: string }>
}

export interface RollbackResult {
  ok: number
  fail: number
  /** v4.2.5：回退产生的反向批次（用它再回退 = 恢复整理） */
  rollbackBatchId: string
  errors: string[]
}

export interface OrgBatch {
  id: number
  batch_id: string
  ts: number
  kind: 'organize' | 'rollback'
  items: number
  status: 'active' | 'rolled_back'
}

/** 台账表（幂等建） */
export function ensureOrgBatches(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS org_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT UNIQUE NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'organize',
    items INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  )`)
}

function recordBatch(db: Database.Database, batchId: string, kind: 'organize' | 'rollback', items: number): void {
  ensureOrgBatches(db)
  db.prepare('INSERT OR REPLACE INTO org_batches (batch_id, ts, kind, items, status) VALUES (?, ?, ?, ?, ?)').run(batchId, Date.now(), kind, items, 'active')
}

/** 最近可回退批次（最近 2 个 active，时间倒序） */
export function recentRollbackable(db: Database.Database, limit = 2): OrgBatch[] {
  ensureOrgBatches(db)
  return db.prepare(
    "SELECT id, batch_id, ts, kind, items, status FROM org_batches WHERE status = 'active' ORDER BY ts DESC LIMIT ?"
  ).all(limit) as OrgBatch[]
}

/** 台账流水（日志页展示：最近 50 条） */
export function batchHistory(db: Database.Database): OrgBatch[] {
  ensureOrgBatches(db)
  return db.prepare('SELECT id, batch_id, ts, kind, items, status FROM org_batches ORDER BY ts DESC LIMIT 50').all() as OrgBatch[]
}


/** 执行移动（分批 200 个/批 yield，进度回调） */
export async function executePlan(
  db: Database.Database,
  items: MovePlanItem[],
  whitelist: WhitelistRule[],
  onProgress?: (done: number, total: number) => void
): Promise<ExecResult> {
  const batchId = `org-${Date.now().toString(36)}`
  const res: ExecResult = { batchId, moved: 0, failed: 0, movedMap: [], errors: [] }
  const ins = db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const total = items.length

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    // 红线：执行前拦截
    if (isProtected(it.src, whitelist) || isHardExcluded(it.src)) {
      res.failed++
      res.errors.push({ src: it.src, message: '安全拦截：白名单/排除目录' })
      continue
    }
    try {
      // 目标目录 + 冲突后缀（执行时按磁盘现状）
      await mkdir(parse(it.dst).dir, { recursive: true })
      let dst = it.dst
      if (existsSync(dst)) {
        const p = parse(it.dst)
        let n = 1
        while (existsSync(`${p.dir}\\${p.name}-${n}${p.ext}`)) n++
        dst = `${p.dir}\\${p.name}-${n}${p.ext}`
      }
      await rename(it.src, dst)
      ins.run(Date.now(), batchId, 'organize', it.src, dst, it.size, null)
      res.moved++
      res.movedMap.push({ src: it.src, dst })
    } catch (e) {
      res.failed++
      res.errors.push({ src: it.src, message: (e as Error).message })
    }
    if (i % 200 === 0) {
      onProgress?.(i + 1, total)
      // 让出事件循环（UI 不卡）
      await new Promise((r) => setImmediate(r))
    }
  }
  onProgress?.(total, total)
  recordBatch(db, batchId, 'organize', res.moved)
  return res
}

/** 回退：op_log 逆序 dst→src 反向移动；**日志不删**；反向移动记新批次（可再回退） */
export async function rollback(db: Database.Database, batchId: string, onProgress?: (done: number, total: number) => void): Promise<RollbackResult> {
  ensureOrgBatches(db)
  const meta = db.prepare('SELECT status FROM org_batches WHERE batch_id = ?').get(batchId) as { status: string } | undefined
  if (meta && meta.status === 'rolled_back') return { ok: 0, fail: 0, rollbackBatchId: '', errors: ['该批次已回退过'] }

  // v4.2.5：批次可能是整理（organize）也可能是回退（rollback）——回退 rollback 批次 = 恢复整理
  const kindRow = db.prepare('SELECT kind FROM org_batches WHERE batch_id = ?').get(batchId) as { kind: string } | undefined
  const srcAction = kindRow?.kind === 'rollback' ? 'rollback' : 'organize'
  const rows = db
    .prepare(`SELECT id, src_path, dst_path FROM op_log WHERE batch_id = ? AND action = '${srcAction}' ORDER BY id DESC`)
    .all(batchId) as Array<{ id: number; src_path: string; dst_path: string }>
  const rbBatch = `rb-${Date.now().toString(36)}`
  const res: RollbackResult = { ok: 0, fail: 0, rollbackBatchId: rbBatch, errors: [] }
  const ins = db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    try {
      if (!existsSync(r.dst_path)) {
        res.fail++
        res.errors.push(`目标已不存在: ${r.dst_path}`)
        continue
      }
      // 原路径被占（同批冲突场景）→ 后缀
      let back = r.src_path
      if (existsSync(back)) {
        const p = parse(r.src_path)
        let n = 1
        while (existsSync(`${p.dir}\\${p.name}-回滚${n}${p.ext}`)) n++
        back = `${p.dir}\\${p.name}-回滚${n}${p.ext}`
      }
      await rename(r.dst_path, back)
      // v4.2.5：反向移动记账（detail=原批次号溯源）；原日志保留
      ins.run(Date.now(), rbBatch, 'rollback', r.dst_path, back, null, batchId)
      res.ok++
    } catch (e) {
      res.fail++
      res.errors.push((e as Error).message)
    }
    if (i % 200 === 0) {
      onProgress?.(i + 1, rows.length)
      await new Promise((r2) => setImmediate(r2))
    }
  }
  // 原批次标记已回退；回退批次入账（active——可再回退）
  db.prepare("UPDATE org_batches SET status = 'rolled_back' WHERE batch_id = ?").run(batchId)
  recordBatch(db, rbBatch, 'rollback', res.ok)
  return res
}

/** 校验文件对（hash 比对，回滚后内容不变验收） */
export async function fileHash(p: string): Promise<string | null> {
  try {
    const { createHash } = await import('crypto')
    const { createReadStream } = await import('fs')
    const s = await stat(p)
    void s
    return await new Promise((resolve) => {
      const h = createHash('sha256')
      const rs = createReadStream(p)
      rs.on('data', (d) => h.update(d))
      rs.on('end', () => resolve(h.digest('hex')))
      rs.on('error', () => resolve(null))
    })
  } catch {
    return null
  }
}
