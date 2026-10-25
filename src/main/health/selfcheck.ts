/**
 * 启动健康自检（v4.1 / 方向 A）
 * 只读探测四项：SQLite 完整性 / C 盘余量 / ffmpeg 可用 / 更新源可达。
 * 任何一项异常只提示不阻塞启动。
 */
import type Database from 'better-sqlite3'
import { stat } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

const pexec = promisify(execFile)

export interface SelfCheckItem {
  id: 'db' | 'cdisk' | 'ffmpeg' | 'update'
  label: string
  ok: boolean
  /** ok=false 时的白话说明 */
  note?: string
}

export async function runSelfCheck(db: Database.Database): Promise<SelfCheckItem[]> {
  const out: SelfCheckItem[] = []
  // 1) SQLite 完整性
  try {
    const r = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    const ok = r[0]?.integrity_check === 'ok'
    out.push({ id: 'db', label: '数据库完整性', ok, note: ok ? undefined : '数据库需修复——清理历史与标签可能异常' })
  } catch (e) {
    out.push({ id: 'db', label: '数据库完整性', ok: false, note: (e as Error).message.slice(0, 80) })
  }
  // 2) C 盘余量（<2GB 警告）
  try {
    const s = await stat('C:\\')
    const freeGB = (s as unknown as { free?: number }).free ? ((s as unknown as { free: number }).free) / 1024 ** 3 : null
    // stat 不带 free——用 cmd dir 不可靠；改 wmic 已弃。用 fs.statfs（Node 18.15+）
    const fs = await import('fs')
    const st = (fs as unknown as { statfs?: (p: string) => { bavail: number; bsize: number } }).statfs
    if (typeof st === 'function') {
      const sf = (fs as unknown as { statfs: (p: string) => { bavail: number; bsize: number } }).statfs('C:\\')
      const gb = (sf.bavail * sf.bsize) / 1024 ** 3
      out.push({ id: 'cdisk', label: `C 盘剩余 ${gb.toFixed(0)}GB`, ok: gb > 2, note: gb > 2 ? undefined : 'C 盘空间告急（<2GB）——建议立即清理' })
    } else {
      out.push({ id: 'cdisk', label: 'C 盘剩余', ok: true })
    }
  } catch {
    out.push({ id: 'cdisk', label: 'C 盘剩余', ok: true }) // 探测失败不误报
  }
  // 3) ffmpeg（缺了只影响视频相关功能）
  const { findFfmpeg } = await import('../media/ffmpeg')
  const ff = await findFfmpeg()
  out.push({ id: 'ffmpeg', label: '视频引擎 ffmpeg', ok: !!ff, note: ff ? undefined : '未安装——视频点播/查重降级（不影响其他功能）' })
  // 4) 更新源可达（3s 超时；不可达不阻塞）
  let updateOk = true
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 3000)
    const { UPDATE_URL } = await import('../../shared/update-policy')
    await fetch(UPDATE_URL + 'latest.yml', { method: 'HEAD', signal: ctrl.signal })
  } catch { updateOk = false }
  out.push({ id: 'update', label: '更新源', ok: updateOk, note: updateOk ? undefined : '暂不可达（网络或代理）——不影响使用' })
  return out
}
