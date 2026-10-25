/**
 * 重复文件检测（P3）：三层过滤
 * 1) 大小分组（同大小才可能同内容）
 * 2) 头尾 4KB 哈希粗筛
 * 3) 全量 SHA-256 确认（内容完全相同才算重复——验收：抽检无误报）
 */
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import type Database from 'better-sqlite3'

export interface FileMeta { path: string; size: number; mtime: number }

export interface DupGroup {
  /** 全量哈希（组标识） */
  hash: string
  size: number
  files: FileMeta[]
  /** 可释放空间 = (n-1) * size */
  wasteBytes: number
}

export interface DupScanResult {
  groups: DupGroup[]
  wasteBytes: number
  scanned: number
  durationMs: number
}

/** 流式哈希（避免整文件读入内存） */
function hashStream(p: string, bytes?: { start: number; length: number }): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    const s = createReadStream(p, bytes ? { start: bytes.start, end: bytes.start + bytes.length - 1 } : undefined)
    s.on('data', (d) => h.update(d))
    s.on('end', () => res(h.digest('hex')))
    s.on('error', rej)
  })
}

async function headTailHash(p: string, size: number): Promise<string> {
  const HEAD = 4096
  if (size <= HEAD * 2) return hashStream(p) // 小文件直接全量
  const [head, tail] = await Promise.all([
    hashStream(p, { start: 0, length: HEAD }),
    hashStream(p, { start: size - HEAD, length: HEAD })
  ])
  return head + ':' + tail
}

/**
 * 检测重复
 * @param files 候选文件列表（调用方负责白名单/排除过滤）
 * @param onProgress 进度回调（0-1）
 * @param minSize 忽略小于该值的文件（默认 1KB——太小的哈希开销大于收益）
 */
export async function findDuplicates(
  files: FileMeta[],
  onProgress?: (ratio: number, phase: string) => void,
  minSize = 1024
): Promise<DupScanResult> {
  const t0 = Date.now()
  // 1) 大小分组
  onProgress?.(0.05, '按大小分组')
  const bySize = new Map<number, FileMeta[]>()
  for (const f of files) {
    if (f.size < minSize) continue
    const arr = bySize.get(f.size) || []
    arr.push(f)
    bySize.set(f.size, arr)
  }
  const sizeCandidates = [...bySize.values()].filter((a) => a.length > 1)
  const totalCand = sizeCandidates.reduce((s, a) => s + a.length, 0) || 1

  // 2) 头尾哈希粗筛
  const stage2: Array<{ sig: string; files: FileMeta[] }> = []
  let done2 = 0
  for (const group of sizeCandidates) {
    const bySig = new Map<string, FileMeta[]>()
    for (const f of group) {
      try {
        const sig = await headTailHash(f.path, f.size)
        const arr = bySig.get(sig) || []
        arr.push(f)
        bySig.set(sig, arr)
      } catch { /* 读不了的跳过 */ }
      done2++
      onProgress?.(0.05 + 0.45 * (done2 / totalCand), '头尾哈希粗筛')
    }
    for (const [sig, arr] of bySig) if (arr.length > 1) stage2.push({ sig, files: arr })
  }

  // 3) 全量哈希确认
  const groups: DupGroup[] = []
  let done3 = 0
  const total3 = stage2.reduce((s, g) => s + g.files.length, 0) || 1
  for (const g of stage2) {
    const byHash = new Map<string, FileMeta[]>()
    for (const f of g.files) {
      try {
        // 头尾即全量的（小文件）直接复用 sig
        const full = f.size <= 8192 ? g.sig.replace(':', '') : await hashStream(f.path)
        const arr = byHash.get(full) || []
        arr.push(f)
        byHash.set(full, arr)
      } catch { /* */ }
      done3++
      onProgress?.(0.5 + 0.5 * (done3 / total3), '全量哈希确认')
    }
    for (const [hash, arr] of byHash) {
      if (arr.length > 1) {
        // 组内按 mtime 排序（最早优先——「保留最早」策略的默认建议）
        arr.sort((a, b) => a.mtime - b.mtime)
        groups.push({ hash, size: arr[0].size, files: arr, wasteBytes: arr[0].size * (arr.length - 1) })
      }
    }
  }

  groups.sort((a, b) => b.wasteBytes - a.wasteBytes)
  return {
    groups,
    wasteBytes: groups.reduce((s, g) => s + g.wasteBytes, 0),
    scanned: files.length,
    durationMs: Date.now() - t0
  }
}

/** 记录 op_log（查重清理动作走软删除，由 cleaner 执行） */
export function logDupDecision(db: Database.Database, keep: string, remove: string[], batchId: string): void {
  const ins = db.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, dst_path, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of remove) ins.run(Date.now(), batchId, 'dedup', r, null, 0, JSON.stringify({ keep }))
}

export type { FileMeta }
