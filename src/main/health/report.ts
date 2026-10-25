/**
 * 月度清理报告（v2.3 / F7）
 * 数据源：op_log + 体检历史 + 快照；产出单文件玻璃风 HTML（样式/SVG 内嵌，无外部资源）
 * 每月 1 日自动生成上月 + 通知；本地生成不上传
 */
import type Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs'

/** Electron API 惰性获取（vitest/无 GUI 环境降级） */
function electronApi(): { app: { getPath: (n: string) => string }; Notification?: { isSupported(): boolean; new (o: unknown): { show(): void } } } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const e = require('electron') as typeof import('electron')
    return e as never
  } catch { return null }
}

export interface MonthlyStats {
  month: string // yyyy-MM
  cleanedBytes: number
  cleanedFiles: number
  organizedFiles: number
  emptyDirs: number
  topItems: Array<{ path: string; size: number; action: string; ts: number }>
  scoreHistory: Array<{ ts: number; score: number }>
  spaceDelta: number | null // 结合快照（同 root 首尾对比）
}

/** 聚合某月统计（op_log 严格一致——验收：注入日志校验数字） */
export function aggregateMonth(db: Database.Database, month: string): MonthlyStats {
  const [y, m] = month.split('-').map(Number)
  const start = new Date(y, m - 1, 1).getTime()
  const end = new Date(y, m, 1).getTime()
  const rows = db.prepare('SELECT ts, action, src_path, size FROM op_log WHERE ts >= ? AND ts < ? ORDER BY size DESC').all(start, end) as Array<{ ts: number; action: string; src_path: string; size: number }>
  let cleanedBytes = 0, cleanedFiles = 0, organizedFiles = 0, emptyDirs = 0
  for (const r of rows) {
    if (r.action === 'clean') { cleanedBytes += r.size; cleanedFiles++ }
    else if (r.action === 'organize') organizedFiles++
    else if (r.action === 'clean_emptydir') emptyDirs++
  }
  const topItems = rows.filter((r) => r.action === 'clean' && r.size > 0).slice(0, 5).map((r) => ({ path: r.src_path, size: r.size, action: r.action, ts: r.ts }))
  // 体检历史（当月）
  const chkRow = db.prepare("SELECT value FROM settings WHERE key = 'checkup_history'").get() as { value: string } | undefined
  const hist: Array<{ ts: number; score: number }> = chkRow ? JSON.parse(chkRow.value) : []
  const scoreHistory = hist.filter((h) => h.ts >= start && h.ts < end)
  // 空间变化（快照同 root 首尾）
  let spaceDelta: number | null = null
  try {
    const snaps = db.prepare("SELECT id, ts, root, total_bytes FROM snapshots WHERE root IN (SELECT root FROM snapshots WHERE ts >= ? AND ts < ?) ORDER BY ts").all(start, end) as Array<{ id: number; ts: number; root: string; total_bytes: number }>
    const byRoot = new Map<string, Array<{ ts: number; total_bytes: number }>>()
    for (const s of snaps) {
      const arr = byRoot.get(s.root) || []
      arr.push({ ts: s.ts, total_bytes: s.total_bytes })
      byRoot.set(s.root, arr)
    }
    // 最大盘（C:）的首尾差
    const cRoot = [...byRoot.keys()].find((r) => r.startsWith('C:'))
    if (cRoot) {
      const arr = byRoot.get(cRoot)!
      if (arr.length >= 2) spaceDelta = arr[arr.length - 1].total_bytes - arr[0].total_bytes
    }
  } catch { /* snapshots 表可能未建 */ }
  return { month, cleanedBytes, cleanedFiles, organizedFiles, emptyDirs, topItems, scoreHistory, spaceDelta }
}

const fmtGB = (b: number): string => (b / 1024 ** 3).toFixed(2) + ' GB'

/** SVG 折线（体检趋势） */
function sparkline(scores: Array<{ ts: number; score: number }>): string {
  if (scores.length < 2) return ''
  const w = 560, h = 120, pad = 10
  const min = Math.min(...scores.map((s) => s.score), 0)
  const max = Math.max(...scores.map((s) => s.score), 100)
  const pts = scores.map((s, i) => {
    const x = pad + (i / (scores.length - 1)) * (w - pad * 2)
    const y = h - pad - ((s.score - min) / Math.max(max - min, 1)) * (h - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="#6EA8FF" stroke-width="3" stroke-linecap="round"/><polyline points="${pad},${h - pad} ${pts.join(' ')} ${w - pad},${h - pad}" fill="rgba(110,168,255,0.12)" stroke="none"/>${pts.map((p, i) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="4" fill="${scores[i].score >= 80 ? '#37D399' : scores[i].score >= 60 ? '#6EA8FF' : '#FF5D6C'}"/>`).join('')}</svg>`
}

/** 生成单文件 HTML（玻璃风 Token 内嵌） */
export function renderReport(s: MonthlyStats): string {
  const rows = s.topItems.map((t, i) => `<tr><td>${i + 1}</td><td class="p">${escapeHtml(t.path)}</td><td>${fmtGB(t.size)}</td><td>${new Date(t.ts).toLocaleDateString('zh-CN')}</td></tr>`).join('')
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>净澈 · ${s.month} 清理报告</title><style>
    body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:linear-gradient(160deg,#070B1C,#101740);color:#F2F5FF;padding:40px}
    .wrap{max-width:760px;margin:0 auto}
    h1{font-size:26px;margin:0 0 6px} .sub{color:rgba(242,245,255,.55);font-size:13px;margin-bottom:28px}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:26px}
    .card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:20px;text-align:center;backdrop-filter:blur(14px)}
    .card b{display:block;font-size:24px;margin-bottom:6px;color:#37D399}
    .card span{font-size:11px;color:rgba(242,245,255,.55)}
    .sec{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:22px;margin-bottom:18px}
    .sec h3{margin:0 0 12px;font-size:15px}
    table{width:100%;border-collapse:collapse;font-size:12.5px}
    td{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.07)}
    td.p{direction:rtl;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px}
    .delta{font-size:14px} .up{color:#FF5D6C} .down{color:#37D399}
  </style></head><body><div class="wrap">
    <h1>净澈 CleanSpace · ${s.month} 月度报告</h1>
    <div class="sub">本地生成 · 未经任何上传 · ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>
    <div class="grid">
      <div class="card"><b>${fmtGB(s.cleanedBytes)}</b><span>清理释放</span></div>
      <div class="card"><b>${s.cleanedFiles}</b><span>清理文件</span></div>
      <div class="card"><b>${s.organizedFiles}</b><span>整理移动</span></div>
      <div class="card"><b>${s.emptyDirs}</b><span>空目录清除</span></div>
    </div>
    <div class="sec"><h3>📈 体检趋势（${s.scoreHistory.length} 次）</h3>${sparkline(s.scoreHistory) || '<p style="color:rgba(242,245,255,.4);font-size:12.5px">本月无体检记录</p>'}</div>
    ${s.spaceDelta !== null ? `<div class="sec"><h3>💾 C 盘空间变化</h3><p class="delta ${s.spaceDelta > 0 ? 'up' : 'down'}">${s.spaceDelta > 0 ? '增加' : '减少'} ${fmtGB(Math.abs(s.spaceDelta))}（快照对比）</p></div>` : ''}
    ${rows ? `<div class="sec"><h3>🏆 清理 TOP 5</h3><table>${rows}</table></div>` : ''}
    <p style="text-align:center;color:rgba(242,245,255,.35);font-size:11px;margin-top:30px">净澈 CleanSpace · 让电脑保持轻盈</p>
  </div></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 报告目录 */
export function reportDir(): string {
  const e = electronApi()
  const base = e?.app.getPath('userData') || require('os').tmpdir()
  const d = join(base, 'reports')
  mkdirSync(d, { recursive: true })
  return d
}

/** 生成并落盘（返回文件路径） */
export function generateReport(db: Database.Database, month: string): string {
  const s = aggregateMonth(db, month)
  const html = renderReport(s)
  const p = join(reportDir(), `净澈清理报告_${month}.html`)
  writeFileSync(p, html, 'utf8')
  return p
}

/** 历史报告列表 */
export function listReports(): Array<{ month: string; file: string }> {
  try {
    return readdirSync(reportDir())
      .filter((f) => f.startsWith('净澈清理报告_') && f.endsWith('.html'))
      .map((f) => ({ month: f.replace('净澈清理报告_', '').replace('.html', ''), file: join(reportDir(), f) }))
      .sort((a, b) => b.month.localeCompare(a.month))
  } catch { return [] }
}

/** 每月 1 日自动生成上月 + 通知（应用启动时调用，幂等） */
export function maybeMonthlyReport(db: Database.Database): void {
  const now = new Date()
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const monthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`
  const key = 'report_generated:' + monthKey
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (done) return
  const p = generateReport(db, monthKey)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, p)
  try {
    const e = electronApi()
    const N = e?.Notification
    if (N?.isSupported()) {
      new N({ title: '净澈 · 上月清理报告已生成', body: `${monthKey} 的战果总结已就绪，管家页设置中心可查看` }).show()
    }
  } catch { /* */ }
}
