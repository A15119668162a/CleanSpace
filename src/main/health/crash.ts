/**
 * 崩溃标记与恢复（v4.1 / 方向 A「稳如磐石」）
 * 未捕获异常/渲染进程崩溃 → crash-marker.json；下次启动检测并告知用户。
 * 只记录不外传（本地文件；隐私红线——栈信息不出机器）。
 */
import { app } from 'electron'
import { writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

export interface CrashMark {
  version: string
  ts: number
  kind: 'uncaught' | 'unhandled' | 'renderer-gone' | 'oom'
  summary: string
}

function markerPath(): string {
  return join(app.getPath('userData'), 'crash-marker.json')
}

export function writeMarker(kind: CrashMark['kind'], err: Error | { message?: string; reason?: string }): void {
  try {
    const summary = String((err as Error).message || (err as { reason?: string }).reason || '未知').slice(0, 300)
    const m: CrashMark = { version: app.getVersion(), ts: Date.now(), kind, summary }
    writeFileSync(markerPath(), JSON.stringify(m), 'utf8')
  } catch { /* 尽力 */ }
}

/** 启动时读取（读后即删——只提示一次） */
export function takeMarker(): CrashMark | null {
  try {
    const p = markerPath()
    if (!existsSync(p)) return null
    const m = JSON.parse(readFileSync(p, 'utf8')) as CrashMark
    rmSync(p, { force: true })
    return m
  } catch { return null }
}

/** 全局挂载（main 早期调用） */
export function installCrashGuard(): void {
  process.on('uncaughtException', (e) => writeMarker('uncaught', e))
  process.on('unhandledRejection', (r) => writeMarker('unhandled', (r as Error) || { reason: String(r) }))
  app.on('render-process-gone', (_e, _wc, details) => {
    writeMarker(details.reason === 'oom' ? 'oom' : 'renderer-gone', { reason: `${details.reason}: exitCode=${details.exitCode}` })
  })
}

export const KIND_TEXT: Record<CrashMark['kind'], string> = {
  uncaught: '主进程未捕获异常',
  unhandled: '异步操作失败',
  'renderer-gone': '界面进程退出',
  oom: '内存不足（OOM）'
}
