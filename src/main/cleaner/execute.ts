/**
 * 清理执行器（P2）：三级确认 + 批量软删除 + 完成报告
 */
import type Database from 'better-sqlite3'
import { softDelete, restoreBatch, purgeBatch } from './recycle'
import type { JunkFile } from './scan'

/** 大批量阈值（红线 #3：>10GB 或 >500 文件需文字输入确认） */
export const BIG_BYTES = 10 * 1024 ** 3
export const BIG_FILES = 500

export interface CleanRequest {
  files: JunkFile[]
  /** UI 已经过的确认级别：'checked' | 'previewed' | 'confirmed' | 'text-confirmed' */
  confirmLevel: 'checked' | 'previewed' | 'confirmed' | 'text-confirmed'
}

export interface CleanReport {
  batchId: string
  cleaned: number
  failed: number
  freedBytes: number
  /** 可一键撤销 */
  undoable: boolean
  errors: Array<{ path: string; message: string }>
}

/** 服务端强校验（不信任 UI 传入的 confirmLevel 单独放行） */
export function validateConfirm(files: JunkFile[], confirmLevel: CleanRequest['confirmLevel']): string | null {
  if (confirmLevel === 'checked') return '必须先经过明细预览'
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const big = totalBytes > BIG_BYTES || files.length > BIG_FILES
  if (big && confirmLevel !== 'text-confirmed') {
    return `本次清理 ${files.length} 个文件，超过大批量阈值（>10GB 或 >500 文件），需输入"确认"二次确认`
  }
  if (confirmLevel !== 'confirmed' && confirmLevel !== 'text-confirmed') return '未通过执行确认'
  return null
}

export async function executeClean(db: Database.Database, files: JunkFile[], onProgress?: (done: number) => void): Promise<CleanReport> {
  const batchTs = Date.now().toString(36)
  let cleaned = 0, failed = 0, freedBytes = 0
  const errors: Array<{ path: string; message: string }> = []
  let batchId = ''
  for (const f of files) {
    try {
      const item = await softDelete(db, f.path, 0)
      if (!batchId) batchId = item.batch_id
      else {
        // 统一批次号（软删默认带时间戳，这里回写统一）
        db.prepare('UPDATE recycle_items SET batch_id = ? WHERE id = ?').run(batchId, item.id)
        db.prepare('UPDATE op_log SET batch_id = ? WHERE dst_path = ?').run(batchId, item.recycled_path)
      }
      cleaned++
      freedBytes += f.size
    } catch (e) {
      failed++
      errors.push({ path: f.path, message: (e as Error).message })
    }
    onProgress?.(cleaned + failed)
  }
  void batchTs
  return { batchId, cleaned, failed, freedBytes, undoable: cleaned > 0, errors }
}

/** 一键撤销整批 */
export async function undoClean(db: Database.Database, batchId: string): Promise<{ ok: number; fail: number }> {
  return restoreBatch(db, batchId)
}

/** 手动清空批次（不可恢复，UI 需显著警示） */
export async function destroyBatch(db: Database.Database, batchId: string): Promise<number> {
  return purgeBatch(db, batchId)
}
