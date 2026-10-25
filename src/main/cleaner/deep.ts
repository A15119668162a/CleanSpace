/**
 * C 盘深度专清（v3.2 / G5）
 * WinSxS / 还原点 / 休眠文件 / 转储：看得见 + 引导安全清。
 * 红线 17：分析阶段零系统改动；绝不 /ResetBase、绝不删页面文件、绝不静默提权；
 * 不可逆操作（还原点删除）文字输入确认。
 */
import { execFile } from 'child_process'
import { stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const run = (cmd: string, args: string[], timeout = 120_000): Promise<{ code: number; out: string }> =>
  new Promise((res) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
      res({ code: e ? ((e as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0, out: String(stdout || '') })
    })
  })

/** 是否管理员（只读探测：net session 需管理员） */
export async function isAdmin(): Promise<boolean> {
  const r = await run('net', ['session'])
  return r.code === 0
}

export interface DeepReport {
  admin: boolean
  winSxS: { supported: boolean; actualSizeGB: number | null; reclaimableGB: number | null; raw?: string }
  restorePoints: { count: number; totalGB: number | null }
  hiberfil: { present: boolean; sizeGB: number | null }
  pagefile: { present: boolean; sizeGB: number | null }
  dump: { present: boolean; sizeGB: number | null; path?: string }
}

/** 全只读分析（零改动——红线 17） */
export async function analyzeDeep(): Promise<DeepReport> {
  const admin = await isAdmin()
  const rep: DeepReport = {
    admin,
    winSxS: { supported: false, actualSizeGB: null, reclaimableGB: null },
    restorePoints: { count: 0, totalGB: null },
    hiberfil: { present: false, sizeGB: null },
    pagefile: { present: false, sizeGB: null },
    dump: { present: false, sizeGB: null }
  }
  // hiberfil / pagefile / dump（C:\ 直读——stat 不需管理员）
  for (const [k, f] of [['hiberfil', 'C:\\hiberfil.sys'], ['pagefile', 'C:\\pagefile.sys']] as const) {
    try {
      const s = await stat(f)
      rep[k] = { present: true, sizeGB: +(s.size / 1024 ** 3).toFixed(2) }
    } catch { rep[k] = { present: false, sizeGB: null } }
  }
  try {
    const dp = join('C:', 'Windows', 'Minidump')
    const md = await stat(dp).catch(() => null)
    if (md) {
      rep.dump = { present: true, sizeGB: 0.01, path: dp }
    } else {
      const mf = join('C:', 'Windows', 'MEMORY.DMP')
      const s = await stat(mf).catch(() => null)
      if (s) rep.dump = { present: true, sizeGB: +(s.size / 1024 ** 3).toFixed(2), path: mf }
    }
  } catch { /* */ }
  // WinSxS：DISM 分析（需管理员；输出多语言解析容错）
  if (admin) {
    const r = await run('Dism', ['/Online', '/Cleanup-Image', '/AnalyzeComponentStore'], 300_000)
    if (r.code === 0) {
      const num = (re: RegExp): number | null => {
        const m = r.out.match(re)
        return m ? parseFloat(m[1]) : null
      }
      // 中文：「组件存储的实际大小: XX.X GB」「可回收的程序包: XX.X GB」
      // 英文："Actual Size of Component Store : XX.X GB" "Backups and Disabled Features : XX.X GB"
      const actual = num(/实际大小[：:]\s*([\d.]+)\s*GB/i) ?? num(/Actual Size of Component Store\s*:?\s*([\d.]+)/i)
      const reclaim = num(/可回收[（(]?程序包|Backups and Disabled Features\s*:?\s*([\d.]+)/i) ?? num(/组件存储清理建议[\s\S]{0,80}?([\d.]+)\s*GB/i)
      rep.winSxS = { supported: true, actualSizeGB: actual, reclaimableGB: reclaim, raw: r.out.slice(-600) }
    }
    // 还原点：vssadmin list shadows 只读
    const v = await run('vssadmin', ['list', 'shadowstorage'])
    if (v.code === 0) {
      const gb = [...v.out.matchAll(/([\d.]+)\s*(GB|GB\s)/gi)].map((m) => parseFloat(m[1]))
      const cnt = (v.out.match(/shadow copy|影子副本/gi) || []).length
      rep.restorePoints = { count: cnt, totalGB: gb.length ? +gb.reduce((a, b) => a + b, 0).toFixed(2) : null }
    }
  }
  return rep
}

export interface DeepAction {
  id: 'winsxs' | 'restore-oldest' | 'hiberfil-off'
  title: string
  /** 后果说明（白话） */
  consequence: string
  reversible: boolean
  /** 需要文字输入确认（不可逆） */
  typedConfirm: boolean
  adminOnly: boolean
}

export const ACTIONS: DeepAction[] = [
  {
    id: 'winsxs',
    title: '清理 WinSxS 组件仓库',
    consequence: '删除已替换的旧组件版本。耗时 5~20 分钟；期间不要关机。不会影响已安装更新（绝不使用 /ResetBase）。',
    reversible: true,
    typedConfirm: false,
    adminOnly: true
  },
  {
    id: 'restore-oldest',
    title: '删除旧还原点（保留最近 1 个）',
    consequence: '被删的还原点无法恢复——删除后不能再回退到那些时间点。系统会保留最近 1 个还原点。',
    reversible: false,
    typedConfirm: true,
    adminOnly: true
  },
  {
    id: 'hiberfil-off',
    title: '关闭休眠（释放 hiberfil.sys）',
    consequence: '失去休眠功能与快速启动；开机可能稍慢。重新开启：管理员运行 powercfg /h on。',
    reversible: true,
    typedConfirm: false,
    adminOnly: true
  }
]

/** 执行清理（用户逐项确认后；红线 17：命令白纸黑字） */
export async function executeDeep(id: string): Promise<{ ok: boolean; output: string; command: string }> {
  if (!(await isAdmin())) return { ok: false, output: '需要管理员权限', command: '' }
  if (id === 'winsxs') {
    // 绝不加 /ResetBase（红线 17）
    const cmd = 'Dism /Online /Cleanup-Image /StartComponentCleanup'
    const r = await run('Dism', ['/Online', '/Cleanup-Image', '/StartComponentCleanup'], 1_800_000)
    return { ok: r.code === 0, output: r.out.slice(-1200), command: cmd }
  }
  if (id === 'restore-oldest') {
    // vssadmin 删最旧（保留最近）：ForcedQuantumFracture 不存在——用 /forshadow 列表最旧 GUID
    const list = await run('vssadmin', ['list', 'shadows'])
    const guids = [...list.out.matchAll(/\{(................-....-....-....-..............)\}/g)].map((m) => m[1])
    if (guids.length <= 1) return { ok: false, output: `只有 ${guids.length} 个还原点，无需清理`, command: '' }
    // 删除除最后一个（最新）外的所有
    const victims = guids.slice(0, -1)
    let outAll = ''
    for (const g of victims) {
      const r = await run('vssadmin', ['delete', 'shadows', '/shadow', `{${g}}`, '/quiet'])
      outAll += `删除 {${g.slice(0, 8)}}…: ${r.code === 0 ? 'OK' : 'FAIL'}\n`
    }
    return { ok: true, output: outAll, command: `vssadmin delete shadows（保留最新 1 个，共删 ${victims.length} 个）` }
  }
  if (id === 'hiberfil-off') {
    const r = await run('powercfg', ['/h', 'off'])
    return { ok: r.code === 0, output: r.code === 0 ? '休眠已关闭，hiberfil.sys 将在重启后释放' : r.out || '失败', command: 'powercfg /h off' }
  }
  return { ok: false, output: '未知操作', command: '' }
}

/** UAC 提权重启（用户点击按钮触发——绝不静默，红线 17） */
export function relaunchElevated(): void {
  const { spawn } = require('child_process') as typeof import('child_process')
  const app = require('electron') as typeof import('electron')
  const exe = process.execPath
  const args = app.app.isPackaged ? ['--elevated'] : [process.argv[1], '--elevated']
  // PowerShell Start-Process -Verb RunAs 弹 UAC（用户可见可拒绝）
  spawn('powershell', ['-NoProfile', 'Command', `Start-Process -FilePath '${exe}' -ArgumentList '${args.join(' ')}' -Verb RunAs`], { detached: true, stdio: 'ignore' }).unref()
  app.app.quit()
}
