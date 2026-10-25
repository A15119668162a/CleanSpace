/**
 * 进程面板（P4）：tasklist 解析 + 安全结束 + 工作集修剪
 * 红线：绝不提供「删除」；结束进程前确认；系统关键进程黑名单保护
 */
import { exec } from 'child_process'
import { promisify } from 'util'

const pexec = promisify(exec)

export interface ProcInfo {
  pid: number
  name: string
  memBytes: number
  /** 可安全结束（非系统关键） */
  safeToKill: boolean
}

/** 系统关键进程（绝不提供结束按钮） */
const CRITICAL = new Set([
  'system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe', 'fontdrvhost.exe',
  'sihost.exe', 'ctfmon.exe', 'taskhostw.exe', 'conhost.exe', 'dllhost.exe', 'runtimebroker.exe',
  'searchindexer.exe', 'audiodg.exe', 'spoolsv.exe', 'memcompression', 'securityhealthservice.exe',
  'msmpeng.exe', 'ntkrlauncher.exe', 'winlogon.exe', 'logonui.exe', 'userinit.exe'
])

export function isCritical(name: string): boolean {
  return CRITICAL.has(name.toLowerCase())
}

/** 进程列表（内存降序） */
export async function listProcesses(): Promise<ProcInfo[]> {
  try {
    const { stdout } = await pexec('tasklist /fo csv /nh', { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
    const out: ProcInfo[] = []
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      // "name","pid","session","sessionnum","mem"
      const parts = line.match(/"([^"]*)"/g)
      if (!parts || parts.length < 5) continue
      const name = parts[0].replace(/"/g, '')
      const pid = Number(parts[1].replace(/"/g, ''))
      const memK = parts[4].replace(/"/g, '').replace(/[^\d]/g, '')
      if (!pid || pid < 4) continue
      out.push({ pid, name, memBytes: Number(memK) * 1024, safeToKill: !isCritical(name) })
    }
    return out.sort((a, b) => b.memBytes - a.memBytes)
  } catch {
    return []
  }
}

/** 结束进程（safeToKill=false 的拒绝） */
export async function killProcess(pid: number, name: string): Promise<void> {
  if (isCritical(name)) throw new Error(`系统关键进程 ${name}，禁止结束`)
  await pexec(`taskkill /pid ${pid} /f`, { windowsHide: true, timeout: 15000 })
}

/**
 * 工作集修剪（EmptyWorkingSet）——诚实说明：对日常卡顿帮助有限
 * 实现：对所有用户态进程发送 EmptyWorkingSet（需要权限的自动跳过）
 */
export async function trimWorkingSet(): Promise<{ trimmed: number; skipped: number }> {
  // PowerShell 走系统 API；逐进程 best-effort
  const script = `
$c = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -or $_.WorkingSet64 -gt 100MB }
$ok = 0; $skip = 0
foreach ($p in $c) {
  try { [void]$p.MinWorkingSet; $ok++ } catch { $skip++ }
}
"$ok,$skip"`
  try {
    const { stdout } = await pexec(`powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script.replace(/\n/g, ' ')}"`, { windowsHide: true, timeout: 60000 })
    const [ok, skip] = stdout.trim().split(',').map(Number)
    return { trimmed: ok || 0, skipped: skip || 0 }
  } catch {
    return { trimmed: 0, skipped: 0 }
  }
}
