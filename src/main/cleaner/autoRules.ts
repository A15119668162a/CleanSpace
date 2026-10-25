/**
 * 自动清理规则（v3.1 / G10）
 * 规则 = 目录 + 文件模式 + 保留天数；每周体检生成软删除预案——绝不真删。
 * 红线 16：白名单路径禁选；单次 >500 文件或 >10GB 只报警不执行。
 */
import type Database from 'better-sqlite3'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { isProtected, type WhitelistRule } from '../../shared/whitelist'

export interface AutoRule {
  id?: number
  dir: string
  /** glob，如 *.exe */
  pattern: string
  keepDays: number
  enabled: 0 | 1
  builtin?: 0 | 1
  note?: string
}

export const BUILTIN_RULES: AutoRule[] = [
  { dir: '', pattern: '*.exe', keepDays: 90, enabled: 0, builtin: 1, note: '下载的安装包保留 90 天（启用前先设置目录）' },
  { dir: '', pattern: '*.zip;*.rar;*.7z', keepDays: 180, enabled: 0, builtin: 1, note: '下载的压缩包保留 180 天' }
]

export function ensureAutoRules(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auto_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dir TEXT NOT NULL,
    pattern TEXT NOT NULL,
    keep_days INTEGER NOT NULL DEFAULT 90,
    enabled INTEGER NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0,
    note TEXT
  )`)
}

/** 规则目标合法性（红线 16：白名单路径禁选） */
export function validateRuleDir(dir: string, whitelist: WhitelistRule[]): { ok: boolean; reason?: string } {
  if (!dir.trim()) return { ok: false, reason: '目录不能为空' }
  if (isProtected(dir, whitelist, { safePockets: false })) return { ok: false, reason: '白名单/系统保护路径不能设为自动清理目标' }
  if (/^[a-z]:\\(windows|program files|program files \(x86\))$/i.test(dir)) return { ok: false, reason: '系统目录禁止' }
  return { ok: true }
}

/** glob → RegExp（*.exe;*.msi 多模式分号分隔） */
export function patternToRegex(pattern: string): RegExp {
  const alts = pattern.split(';').map(p =>
    p.trim().toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
  )
  return new RegExp('^(' + alts.join('|') + ')$', 'i')
}

export interface RuleHit {
  ruleId: number
  path: string
  size: number
  mtime: number
}

export interface PlanResult {
  hits: RuleHit[]
  totalBytes: number
  /** 超限只报警不执行（红线 16） */
  overflow: boolean
  overflowReason?: string
}

/** 生成预案命中清单（只读，不删任何东西） */
export async function planRule(db: Database.Database, rule: AutoRule, whitelist: WhitelistRule[]): Promise<PlanResult> {
  const v = validateRuleDir(rule.dir, whitelist)
  if (!v.ok) return { hits: [], totalBytes: 0, overflow: true, overflowReason: v.reason }
  const re = patternToRegex(rule.pattern)
  const cutoff = Date.now() - rule.keepDays * 86400e3
  const hits: RuleHit[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 2) return
    let ds: Awaited<ReturnType<typeof readdir>>
    try { ds = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of ds) {
      const f = join(d, e.name)
      if (e.isDirectory()) await walk(f, depth + 1)
      else if (re.test(e.name)) {
        try {
          const s = await stat(f)
          if (s.mtimeMs < cutoff) hits.push({ ruleId: rule.id!, path: f, size: s.size, mtime: s.mtimeMs })
        } catch { /* */ }
      }
    }
  }
  await walk(rule.dir, 0)
  const totalBytes = hits.reduce((s, h) => s + h.size, 0)
  let overflow = false
  let overflowReason: string | undefined
  if (hits.length > 500) { overflow = true; overflowReason = `命中 ${hits.length} 个文件（>500），已跳过执行——请检查规则是否过宽` }
  if (totalBytes > 10 * 1024 ** 3) { overflow = true; overflowReason = `命中 ${(totalBytes / 1024 ** 3).toFixed(1)}GB（>10GB），已跳过执行` }
  return { hits, totalBytes, overflow, overflowReason }
}

/** CRUD */
export function listRules(db: Database.Database): AutoRule[] {
  ensureAutoRules(db)
  return db.prepare('SELECT id, dir, pattern, keep_days as keepDays, enabled, builtin, note FROM auto_rules ORDER BY id').all() as never
}
export function saveRule(db: Database.Database, r: AutoRule, whitelist: WhitelistRule[]): { ok: boolean; reason?: string } {
  ensureAutoRules(db)
  const v = validateRuleDir(r.dir, whitelist)
  if (!v.ok) return v
  if (r.id) db.prepare('UPDATE auto_rules SET dir=?, pattern=?, keep_days=?, enabled=? WHERE id=?').run(r.dir, r.pattern, r.keepDays, r.enabled, r.id)
  else db.prepare('INSERT INTO auto_rules (dir, pattern, keep_days, enabled, builtin, note) VALUES (?,?,?,?,?,?)').run(r.dir, r.pattern, r.keepDays, r.enabled, r.builtin || 0, r.note || null)
  return { ok: true }
}
export function deleteRule(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM auto_rules WHERE id = ? AND builtin = 0').run(id) // 内置不可删只能停用
}
