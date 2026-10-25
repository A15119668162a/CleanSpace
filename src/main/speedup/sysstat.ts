/**
 * 系统概况（P4）：开机时长 / CPU·内存实时 / 磁盘健康
 * 原则：读取失败则隐藏该项（不显示错误占位）
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'

const pexec = promisify(exec)

export interface SysStat {
  /** 开机时长（ms），读取失败为 null（UI 隐藏） */
  uptimeMs: number | null
  cpu: { model: string; usage: number; cores: number }
  mem: { totalBytes: number; usedBytes: number; usage: number }
  disks: Array<{ drive: string; label: string; totalBytes: number; freeBytes: number; health: string | null }>
}

/** 开机时长：LastBootUpTime（失败返回 null） */
export async function bootTime(): Promise<number | null> {
  try {
    const { stdout } = await pexec(
      'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_OperatingSystem).LastBootUpTime"',
      { windowsHide: true, timeout: 10000 }
    )
    const t = new Date(stdout.trim()).getTime()
    if (Number.isNaN(t)) return null
    return Date.now() - t
  } catch {
    return null
  }
}

/** CPU 使用率（两次采样差分，~500ms） */
export async function cpuUsage(sampleMs = 500): Promise<number> {
  const s1 = os.cpus().map((c) => c.times)
  await new Promise((r) => setTimeout(r, sampleMs))
  const s2 = os.cpus().map((c) => c.times)
  let idle = 0, total = 0
  s2.forEach((t2, i) => {
    const t1 = s1[i]
    const dIdle = t2.idle - t1.idle
    const dTotal = (t2.user - t1.user) + (t2.nice - t1.nice) + (t2.sys - t1.sys) + (t2.idle - t1.idle) + (t2.irq - t1.irq)
    idle += dIdle
    total += dTotal
  })
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idle / total) * 100))
}

/** 磁盘健康（Get-PhysicalDisk，失败 null） */
export async function diskHealth(): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  try {
    const { stdout } = await pexec(
      'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Partition | Where-Object DriveLetter | Select-Object DriveLetter, DiskNumber | ConvertTo-Json -Compress; \'---\'; Get-PhysicalDisk | Select-Object DeviceNumber, HealthStatus | ConvertTo-Json -Compress"',
      { windowsHide: true, timeout: 15000 }
    )
    const [partStr, diskStr] = stdout.split('---')
    const parts = JSON.parse(partStr.trim() || '[]')
    const disks = JSON.parse((diskStr || '[]').trim() || '[]')
    const pArr = Array.isArray(parts) ? parts : [parts]
    const dArr = Array.isArray(disks) ? disks : [disks]
    for (const p of pArr) {
      if (p?.DriveLetter == null) continue
      const d = dArr.find((x) => Number(x.DeviceNumber) === Number(p.DiskNumber))
      if (d) m.set(String(p.DriveLetter) + ':', String(d.HealthStatus))
    }
  } catch { /* 全部无健康信息 */ }
  return m
}

/** 一次性全量采集 */
export async function collectSysStat(disks: Array<{ drive: string; label: string; totalBytes: number; freeBytes: number }>): Promise<SysStat> {
  const [uptime, usage, health] = await Promise.all([bootTime(), cpuUsage(), diskHealth()])
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  return {
    uptimeMs: uptime,
    cpu: { model: os.cpus()[0]?.model || '', usage, cores: os.cpus().length },
    mem: { totalBytes: totalMem, usedBytes: totalMem - freeMem, usage: (totalMem - freeMem) / totalMem * 100 },
    disks: disks.map((d) => ({ ...d, health: health.get(d.drive) || null }))
  }
}
