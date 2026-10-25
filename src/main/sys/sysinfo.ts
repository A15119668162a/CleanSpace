/**
 * 系统交互封装（PowerShell 子进程，仅只读查询与定位）
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import { stat } from 'fs/promises'

const pexec = promisify(exec)

export interface DiskInfo {
  drive: string // "C:"
  label: string
  totalBytes: number
  freeBytes: number
  fsType: string
}

function ps(cmd: string, timeoutMs = 15000): Promise<string> {
  // 强制 PowerShell 输出 UTF-8（默认 GBK 会导致中文卷标/名称乱码）
  const c = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`
  return pexec(
    `powershell -NoProfile -NonInteractive -Command "${c.replace(/"/g, '\\"')}"`,
    { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }
  ).then((r) => r.stdout)
}

/** 磁盘列表（WMI → PowerShell），失败返回空数组（UI 显示降级提示） */
export async function listDisks(): Promise<DiskInfo[]> {
  try {
    const out = await ps(
      `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json -Compress`
    )
    let arr: unknown = JSON.parse(out)
    if (!Array.isArray(arr)) arr = [arr]
    return (arr as Array<Record<string, unknown>>)
      .filter((d) => d.DeviceID)
      .map((d) => ({
        drive: String(d.DeviceID),
        label: String(d.VolumeName || '本地磁盘'),
        totalBytes: Number(d.Size) || 0,
        freeBytes: Number(d.FreeSpace) || 0,
        fsType: String(d.FileSystem || '')
      }))
  } catch {
    return []
  }
}

/** 当前用户目录大小（不扫描，只回路径信息，供快速入口） */
export async function userHome(): Promise<string> {
  return process.env.USERPROFILE || 'C:\\Users'
}

/** 验证路径存在且为目录 */
export async function ensureDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}
