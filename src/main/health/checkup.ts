/**
 * 一键体检评分（P5 / M5）
 * 四维：垃圾可释放占比、C 盘剩余空间、启动项数量、回收站堆积
 * 0-100 分（越高越健康），每维带「去处理」目标页
 */
import type Database from 'better-sqlite3'
import { scanJunk } from '../cleaner/scan'
import { listStartup, listBackups } from '../speedup/startup'
import { listDisks } from '../sys/sysinfo'
import type { WhitelistRule } from '../../shared/whitelist'

export type FixTarget = 'clean' | 'insight' | 'speedup' | 'recycle'

export interface CheckDimension {
  id: string
  name: string
  /** 0-100（该维度健康度） */
  score: number
  /** 展示值 */
  display: string
  advice: string
  fix: FixTarget
}

export interface CheckupResult {
  score: number
  dimensions: CheckDimension[]
  ts: number
}

/** 单维评分（线性映射：value 在 [bad, good] 区间 → [0, 100]） */
function lin(value: number, bad: number, good: number): number {
  if (good === bad) return 100
  const t = (value - bad) / (good - bad)
  return Math.max(0, Math.min(100, Math.round(t * 100)))
}

function fmtGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + 'GB'
}

/**
 * 执行体检
 * @param options 可注入 mock（测试用）
 */
export async function runCheckup(
  db: Database.Database,
  whitelist: WhitelistRule[],
  options?: {
    junkBytes?: number
    cFree?: number
    cTotal?: number
    startupCount?: number
    recycleBytes?: number
    recycleCount?: number
    skipReal?: boolean
  }
): Promise<CheckupResult> {
  const dims: CheckDimension[] = []

  // ---- 1) 垃圾可释放 ----
  let junkBytes = options?.junkBytes
  if (junkBytes === undefined) {
    const junk = await scanJunk(whitelist)
    junkBytes = junk.totalBytes
  }
  // 20GB 垃圾 = 0 分；1GB 内 = 100 分
  const jScore = 100 - lin(junkBytes, 0, 20 * 1024 ** 3)
  dims.push({
    id: 'junk', name: '垃圾文件',
    score: jScore,
    display: `可释放 ${fmtGB(junkBytes)}`,
    advice: junkBytes > 5 * 1024 ** 3 ? '垃圾较多，建议清理' : junkBytes > 1024 ** 3 ? '有些垃圾，可顺手清理' : '垃圾很少，保持得不错',
    fix: 'clean'
  })

  // ---- 2) C 盘剩余空间 ----
  let cFree = options?.cFree
  let cTotal = options?.cTotal ?? 200 * 1024 ** 3
  if (cFree === undefined) {
    try {
      const disks = await listDisks()
      const c = disks.find((d) => d.drive === 'C:')
      cFree = c?.freeBytes ?? 0
      cTotal = c?.totalBytes ?? cTotal
    } catch { cFree = 0 }
  }
  const cRatio = cFree / Math.max(cTotal, 1)
  // 剩余 <5% = 0 分；>30% = 100 分
  const cScore = lin(cRatio, 0.05, 0.3)
  dims.push({
    id: 'cdisk', name: 'C 盘空间',
    score: cScore,
    display: `剩余 ${fmtGB(cFree)}（${(cRatio * 100).toFixed(0)}%）`,
    advice: cRatio < 0.1 ? 'C 盘告急！建议清理或转移大文件' : cRatio < 0.2 ? 'C 盘偏满，关注一下' : '空间充足',
    fix: 'insight'
  })

  // ---- 3) 启动项数量 ----
  let startupCount = options?.startupCount
  if (startupCount === undefined) {
    try {
      const items = await listStartup(db, listBackups(db))
      startupCount = items.filter((i) => i.enabled).length
    } catch { startupCount = 0 }
  }
  // 25 个自启 = 0 分；≤8 个 = 100 分
  const sScore = 100 - lin(startupCount, 8, 25)
  dims.push({
    id: 'startup', name: '启动项',
    score: sScore,
    display: `${startupCount} 个开机自启`,
    advice: startupCount > 15 ? '自启太多，拖慢开机，建议禁用不常用的' : startupCount > 8 ? '自启偏多，可精简' : '自启精简，很好',
    fix: 'speedup'
  })

  // ---- 4) 回收站堆积（应用回收站） ----
  let recycleBytes = options?.recycleBytes
  const recycleCount = options?.recycleCount ?? 0
  if (recycleBytes === undefined) {
    const row = db.prepare('SELECT COALESCE(SUM(size),0) s, COUNT(*) c FROM recycle_items WHERE restored = 0').get() as { s: number; c: number }
    recycleBytes = row.s
  }
  // 回收站 >10GB = 0 分；≤1GB = 100
  const rScore = 100 - lin(recycleBytes, 1024 ** 3, 10 * 1024 ** 3)
  dims.push({
    id: 'recycle', name: '回收站',
    score: rScore,
    display: `${fmtGB(recycleBytes)}${recycleCount ? ` / ${recycleCount} 项` : ''}`,
    advice: recycleBytes > 5 * 1024 ** 3 ? '回收站堆积较多，确认无误后可清空' : '回收站正常',
    fix: 'recycle'
  })

  // 加权：垃圾 35% / C盘 30% / 启动项 20% / 回收站 15%
  const W = { junk: 0.35, cdisk: 0.3, startup: 0.2, recycle: 0.15 } as Record<string, number>
  const total = dims.reduce((s, d) => s + d.score * (W[d.id] || 0), 0)
  return { score: Math.round(total), dimensions: dims, ts: Date.now() }
}

/** 体检记录存档（最近 N 次） */
export function saveCheckup(db: Database.Database, r: CheckupResult): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_checkup', JSON.stringify(r))
  // 历史列表
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('checkup_history') as { value: string } | undefined
  const hist: Array<{ ts: number; score: number }> = row ? JSON.parse(row.value) : []
  hist.unshift({ ts: r.ts, score: r.score })
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('checkup_history', JSON.stringify(hist.slice(0, 10)))
}

export function lastCheckup(db: Database.Database): CheckupResult | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('last_checkup') as { value: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}

export function checkupHistory(db: Database.Database): Array<{ ts: number; score: number }> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('checkup_history') as { value: string } | undefined
  if (!row) return []
  try { return JSON.parse(row.value) } catch { return [] }
}
