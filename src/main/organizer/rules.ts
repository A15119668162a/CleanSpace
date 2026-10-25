/**
 * 整理规则引擎（P3）
 * 规则：type（按类型）/ date（按年-月归档）/ size（大文件单列）/ custom（扩展名通配）
 * plan() 只读生成预案（报告模式零写入——红线 #5、验收：前后快照 diff 为空）
 */
import { readdir, stat } from 'fs/promises'
import { join, extname, basename } from 'path'
import { classifyFile } from '../scanner/core'
import { isProtected } from '../../shared/whitelist'
import type { WhitelistRule } from '../../shared/whitelist'
import { isHardExcluded } from '../cleaner/rules'

export type RuleKind = 'type' | 'date' | 'size' | 'custom'

export interface OrganizeRule {
  id: number
  kind: RuleKind
  name: string
  /** JSON 配置：type→{category}, date→{granularity:'year'|'month'}, size→{minBytes}, custom→{ext:'psd'} + {targetFolder} */
  config: Record<string, unknown>
  enabled: boolean
  priority: number
}

export interface MovePlanItem {
  src: string
  /** 目标绝对路径（含文件名） */
  dst: string
  size: number
  mtime: number
  ruleId: number
  reason: string
}

export interface PlanOptions {
  /** 目标根目录（如 D:\整理后） */
  targetRoot: string
  /** 保留相对路径（true）或平铺（false） */
  keepRelative: boolean
  /** 平铺时的命名冲突自动 -1/-2（预演也标出） */
  rules: OrganizeRule[]
  whitelist: WhitelistRule[]
}

export interface PlanResult {
  items: MovePlanItem[]
  skipped: Array<{ path: string; reason: string }>
  totalBytes: number
}

/** 源目录扫描（浅层递归，默认 ≤4 层；跳过系统目录/回收站） */
const SKIP = new Set(['cleanspacerecycle', '$recycle.bin', 'system volume information', 'node_modules', '.git'])
export async function collectFiles(root: string, depth = 0, maxDepth = 4): Promise<Array<{ path: string; size: number; mtime: number }>> {
  const out: Array<{ path: string; size: number; mtime: number }> = []
  if (depth > maxDepth) return out
  let dirents: Awaited<ReturnType<typeof readdir>>
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch { return out }
  for (const d of dirents) {
    const full = join(root, d.name)
    if (d.isDirectory()) {
      if (SKIP.has(d.name.toLowerCase())) continue
      out.push(...(await collectFiles(full, depth + 1, maxDepth)))
    } else if (d.isFile()) {
      try {
        const s = await stat(full)
        out.push({ path: full, size: s.size, mtime: s.mtimeMs })
      } catch { /* */ }
    }
  }
  return out
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }

/** 按规则计算单个文件的目标子路径（相对 targetRoot），不匹配返回 null */
function matchRule(file: { path: string; size: number; mtime: number }, rule: OrganizeRule): { sub: string; reason: string } | null {
  const ext = extname(file.path).slice(1).toLowerCase()
  switch (rule.kind) {
    case 'type': {
      const cat = classifyFile(basename(file.path))
      if (cat === rule.config.category) return { sub: String(rule.config.targetFolder || cat), reason: `类型：${cat}` }
      return null
    }
    case 'date': {
      const d = new Date(file.mtime)
      const g = rule.config.granularity === 'year' ? `${d.getFullYear()}` : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
      return { sub: join(String(rule.config.targetFolder || '归档'), g), reason: `按${rule.config.granularity === 'year' ? '年' : '年-月'}归档：${g}` }
    }
    case 'size': {
      if (file.size >= Number(rule.config.minBytes || 0)) {
        return { sub: String(rule.config.targetFolder || '大文件'), reason: `大于阈值 ${Number(rule.config.minBytes) / 1024 ** 3 >= 1 ? (Number(rule.config.minBytes) / 1024 ** 3).toFixed(0) + 'GB' : (Number(rule.config.minBytes) / 1024 ** 2).toFixed(0) + 'MB'}` }
      }
      return null
    }
    case 'custom': {
      const want = String(rule.config.ext || '').toLowerCase().replace(/^\./, '')
      if (want && ext === want) return { sub: String(rule.config.targetFolder || want + '文件'), reason: `自定义 *.${want}` }
      return null
    }
    default:
      return null
  }
}

/** 命名冲突预演：目标已占用或计划内重复 → 追加 -1/-2 */
function dedupe(dst: string, taken: Set<string>, exists: (p: string) => boolean): string {
  if (!taken.has(dst.toLowerCase()) && !exists(dst)) {
    taken.add(dst.toLowerCase())
    return dst
  }
  const dot = dst.lastIndexOf('.')
  const stem = dot > 0 ? dst.slice(0, dot) : dst
  const ext = dot > 0 ? dst.slice(dot) : ''
  for (let i = 1; ; i++) {
    const cand = `${stem}-${i}${ext}`
    if (!taken.has(cand.toLowerCase()) && !exists(cand)) {
      taken.add(cand.toLowerCase())
      return cand
    }
  }
}

/**
 * 生成整理预案（只读，零写入）
 * 高优先级规则先匹配（priority 大者先）；一个文件只进一个目标
 */
export async function plan(
  sourceRoot: string,
  opts: PlanOptions,
  existsFn: (p: string) => boolean
): Promise<PlanResult> {
  const files = await collectFiles(sourceRoot)
  const rules = [...opts.rules].filter((r) => r.enabled).sort((a, b) => b.priority - a.priority)
  const items: MovePlanItem[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  const taken = new Set<string>()

  for (const f of files) {
    // 红线：白名单/硬排除目录不动
    if (isProtected(f.path, opts.whitelist)) { skipped.push({ path: f.path, reason: '白名单保护' }); continue }
    if (isHardExcluded(f.path)) { skipped.push({ path: f.path, reason: '安全排除' }); continue }

    const hit = rules.reduce<{ sub: string; reason: string; ruleId: number } | null>((acc, r) => acc || (() => { const m = matchRule(f, r); return m ? { ...m, ruleId: r.id } : null })(), null)
    if (!hit) { skipped.push({ path: f.path, reason: '无匹配规则' }); continue }

    // 目标路径
    let dst: string
    if (opts.keepRelative) {
      const rel = f.path.slice(sourceRoot.length).replace(/^[\\/]+/, '')
      dst = join(opts.targetRoot, hit.sub, rel)
    } else {
      dst = join(opts.targetRoot, hit.sub, basename(f.path))
    }
    dst = dedupe(dst, taken, existsFn)
    items.push({ src: f.path, dst, size: f.size, mtime: f.mtime, ruleId: hit.ruleId, reason: hit.reason })
  }

  return { items, skipped, totalBytes: items.reduce((s, i) => s + i.size, 0) }
}

/** 默认规则集（首次进入整理页时的种子） */
export function defaultRules(): OrganizeRule[] {
  return [
    { id: 1, kind: 'custom', name: '图片', config: { category: '图片', targetFolder: '图片' }, enabled: true, priority: 5 },
    { id: 2, kind: 'custom', name: '视频', config: { category: '视频', targetFolder: '视频' }, enabled: true, priority: 5 },
    { id: 3, kind: 'custom', name: '文档', config: { category: '文档', targetFolder: '文档' }, enabled: true, priority: 5 },
    { id: 4, kind: 'custom', name: '压缩包', config: { category: '压缩包', targetFolder: '压缩包' }, enabled: true, priority: 4 },
    { id: 5, kind: 'custom', name: '安装包', config: { category: '安装包', targetFolder: '安装包' }, enabled: true, priority: 4 },
    { id: 6, kind: 'size', name: '大文件（>1GB）', config: { minBytes: 1024 ** 3, targetFolder: '大文件' }, enabled: false, priority: 10 },
    { id: 7, kind: 'date', name: '按年-月归档', config: { granularity: 'month', targetFolder: '归档' }, enabled: false, priority: 3 }
  ].map((r) => ({ ...r, kind: r.kind === 'custom' && r.config.category ? 'type' : r.kind }) as OrganizeRule)
}

/* ---------------- v1.4 目标目录推荐 ---------------- */
export interface SuggestResult {
  /** 推荐目标根（同盘新建"已整理"目录，避免跨盘移动成本） */
  suggestedRoot: string
  /** 源目录内容画像（按占用排序） */
  profile: Array<{ category: string; bytes: number; files: number; topFile?: string; topSize?: number }>
  totalBytes: number
  files: number
}

/** 分析源目录：类型画像 + 最大文件 + 最多类型 → 推荐整理目标 */
export async function suggestTarget(sourceRoot: string): Promise<SuggestResult> {
  const files = await collectFiles(sourceRoot, 0, 4)
  const byCat = new Map<string, { bytes: number; files: number; topFile?: string; topSize?: number }>()
  for (const f of files) {
    const cat = classifyFile(basename(f.path))
    const e = byCat.get(cat) || { bytes: 0, files: 0 }
    e.bytes += f.size
    e.files++
    if (!e.topSize || f.size > e.topSize) { e.topSize = f.size; e.topFile = f.path }
    byCat.set(cat, e)
  }
  const profile = [...byCat.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
  // 推荐目标：源目录所在盘根下「已整理」（同盘 rename 零拷贝）
  const drive = sourceRoot.slice(0, 3) // "D:\"
  const suggestedRoot = drive.endsWith('\\') || drive.endsWith('/') ? drive + '已整理' : drive + '\\已整理'
  return {
    suggestedRoot,
    profile: profile.slice(0, 8),
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    files: files.length
  }
}
