/**
 * 垃圾扫描器（P2）：按规则枚举候选 → 硬排除/白名单过滤 → 汇总
 * 只读操作（红线 #5：扫描阶段零写入）
 */
import { readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { allRules, isHardExcluded, isWhitelisted, type JunkRule, type RiskLevel } from './rules'
import type { WhitelistRule } from '../../shared/whitelist'

export interface JunkFile {
  path: string
  size: number
  mtime: number
}

export interface JunkGroup {
  ruleId: string
  name: string
  desc: string
  risk: RiskLevel
  consequence?: string
  files: JunkFile[]
  totalBytes: number
  /** 目录不可访问等说明 */
  note?: string
}

export interface JunkScanResult {
  groups: JunkGroup[]
  totalBytes: number
  totalFiles: number
  durationMs: number
  /** 硬排除命中的数量（诊断用） */
  hardExcludedCount: number
}

function simpleGlobMatch(pattern: string, name: string): boolean {
  // 极简 glob：* 通配
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
  return re.test(name)
}

/** 列目录下所有文件（含一层子目录；TEMP 等常见多级） */
export const diagLog: string[] = []
async function walkFiles(dir: string, depth = 0, maxDepth = 3): Promise<JunkFile[]> {
  const out: JunkFile[] = []
  let dirents: Awaited<ReturnType<typeof readdir>>
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    diagLog.push(`readdir FAIL ${dir}: ${(e as Error).message}`)
    return out
  }
  diagLog.push(`readdir OK ${dir}: ${dirents.length} 项`)
  for (const d of dirents) {
    const full = join(dir, d.name)
    if (d.isDirectory() && depth < maxDepth) {
      out.push(...(await walkFiles(full, depth + 1, maxDepth)))
    } else if (d.isFile()) {
      try {
        const s = await stat(full)
        out.push({ path: full, size: s.size, mtime: s.mtimeMs })
      } catch (e) {
        diagLog.push(`stat FAIL ${full}: ${(e as Error).message}`)
      }
    }
  }
  return out
}

/** 单规则扫描 */
async function scanRule(rule: JunkRule, whitelistRules: WhitelistRule[], stats: { hardExcluded: number }, opts?: { safePockets?: boolean }): Promise<JunkGroup> {
  const group: JunkGroup = {
    ruleId: rule.id, name: rule.name, desc: rule.desc, risk: rule.risk,
    consequence: rule.consequence, files: [], totalBytes: 0
  }
  for (const target of rule.targets()) {
    if (!existsSync(target)) continue
    let st
    try { st = await stat(target) } catch { continue }
    if (st.isFile()) {
      // 单文件目标（hiberfil.sys 等）
      if (isHardExcluded(target) || isWhitelisted(target, whitelistRules, opts)) { stats.hardExcluded++; continue }
      group.files.push({ path: target, size: st.size, mtime: st.mtimeMs })
      continue
    }
    if (!st.isDirectory()) continue
    if (isWhitelisted(target, whitelistRules, opts)) { stats.hardExcluded++; continue }
    // 目录目标：枚举文件
    const files = await walkFiles(target)
    for (const f of files) {
      const name = f.path.slice(f.path.lastIndexOf('\\') + 1).slice(f.path.lastIndexOf('/') + 1)
      if (rule.excludeGlobs?.some((g) => simpleGlobMatch(g, name))) { stats.hardExcluded++; continue }
      if (isHardExcluded(f.path)) { stats.hardExcluded++; continue }
      if (isWhitelisted(f.path, whitelistRules, opts)) { stats.hardExcluded++; continue }
      group.files.push(f)
    }
  }
  group.files.sort((a, b) => b.size - a.size)
  group.totalBytes = group.files.reduce((s, f) => s + f.size, 0)
  if (group.files.length === 0 && rule.targets().some((t) => existsSync(t))) group.note = '无可清理内容'
  return group
}

export async function scanJunk(whitelistRules: WhitelistRule[], opts?: { safePockets?: boolean }): Promise<JunkScanResult> {
  const t0 = Date.now()
  const stat = { hardExcluded: 0 }
  const groups: JunkGroup[] = []
  diagLog.length = 0
  for (const rule of allRules()) {
    try {
      groups.push(await scanRule(rule, whitelistRules, stat, opts))
    } catch (e) {
      diagLog.push(`scanRule FAIL ${rule.id}: ${(e as Error).message}`)
      groups.push({ ruleId: rule.id, name: rule.name, desc: rule.desc, risk: rule.risk, consequence: rule.consequence, files: [], totalBytes: 0, note: '扫描失败: ' + (e as Error).message })
    }
  }
  const totalBytes = groups.reduce((s, g) => s + g.totalBytes, 0)
  const totalFiles = groups.reduce((s, g) => s + g.files.length, 0)
  return { groups, totalBytes, totalFiles, durationMs: Date.now() - t0, hardExcludedCount: stat.hardExcluded }
}
