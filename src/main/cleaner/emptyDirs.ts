/**
 * 空文件夹清理（v2.0 / F2）
 * 递归识别空目录树 → 自底向上删除（直接删不进软删除——无内容恢复成本低，预览逐行列出）
 * 排除：白名单、云同步占位、隐藏/系统属性目录（attrib 查询，不可用降级黑名单）
 */
import { readdir, stat, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import type { WhitelistRule } from '../../shared/whitelist'
import { isProtected } from '../../shared/whitelist'

const pexec = promisify(exec)

/** 云同步/常见占位目录名（硬编码排除） */
const PLACEHOLDER_SKIP = new Set([
  'onedrive', '坚果云', 'nutstore', '百度云', '百度网盘', 'baidunetdisk', 'baiduyun',
  'dropbox', 'googledrive', 'icloud~', 'icloud', '腾讯微云', 'revolt', '.git', '.svn', '.hg', 'node_modules'
])
/** 常见云同步占位标记文件（目录内含这些 → 认为是同步占位不判空） */
const MARKER_FILES = new Set(['.placeholder', 'desktop.ini', 'thumbs.db', '.gitkeep', 'icon\r', '.dropbox.device'])

export interface EmptyDir {
  path: string
  /** 准空目录（仅 Thumbs.db/desktop.ini） */
  quasi: boolean
  fileCount: number
  size: number
}

export interface EmptyScanResult {
  dirs: EmptyDir[]
  /** 可清理总大小（准空的标记文件大小） */
  totalBytes: number
  skippedByAttr: number
  durationMs: number
}

interface TreeNode {
  path: string
  isMarkerOnly: boolean
  fileCount: number
  size: number
  children: TreeNode[]
}

/** 递归建树（跳过系统/白名单/占位目录）；markerOnly=目录内文件全是占位标记（Thumbs.db/desktop.ini 等） */
async function buildTree(dir: string, whitelist: WhitelistRule[], attrSkip: Set<string>): Promise<TreeNode | null> {
  if (isProtected(dir, whitelist)) return null
  const name = dir.slice(dir.lastIndexOf('\\') + 1).slice(dir.lastIndexOf('/') + 1).toLowerCase()
  if (PLACEHOLDER_SKIP.has(name)) return null
  if (attrSkip.has(dir.toLowerCase())) return null
  const node: TreeNode = { path: dir, isMarkerOnly: true, fileCount: 0, size: 0, children: [] }
  let dirents: Awaited<ReturnType<typeof readdir>>
  try { dirents = await readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const d of dirents) {
    const full = join(dir, d.name)
    if (d.isDirectory()) {
      const child = await buildTree(full, whitelist, attrSkip)
      if (child) node.children.push(child)
    } else if (d.isFile()) {
      try {
        const s = await stat(full)
        node.fileCount++
        node.size += s.size
        if (!MARKER_FILES.has(d.name.toLowerCase())) node.isMarkerOnly = false
      } catch { node.isMarkerOnly = false }
    }
  }
  return node
}

/** 收集空目录（自底向上：子全空且自身无文件 → 空；标记文件目录按 quasi 过滤） */
function collectEmpty(node: TreeNode, includeQuasi: boolean): EmptyDir[] {
  const out: EmptyDir[] = []
  const walk = (n: TreeNode): { empty: boolean; hasRealFile: boolean } => {
    let hasRealFile = n.fileCount > 0 && !n.isMarkerOnly
    let allChildrenEmpty = true
    for (const c of n.children) {
      const r = walk(c)
      if (r.hasRealFile) hasRealFile = true
      if (!r.empty) allChildrenEmpty = false
    }
    // 本目录空：无真实文件 + 所有子目录空（子目录可能带标记文件——仍算空树）
    const isEmpty = !hasRealFile && allChildrenEmpty
    if (isEmpty && (n.fileCount === 0 || n.isMarkerOnly)) {
      out.push({ path: n.path, quasi: n.fileCount > 0, fileCount: n.fileCount, size: n.size })
      return { empty: true, hasRealFile: false }
    }
    // 本身不空但子目录全空：父不删（父有文件），子已在 out
    return { empty: false, hasRealFile }
  }
  walk(node)
  return out.filter((d) => includeQuasi || !d.quasi)
}

/** 批量查隐藏/系统属性（attrib 一次查整目录树太贵——只查两层内目录，失败降级为空集） */
async function hiddenDirs(root: string): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const { stdout } = await pexec(`attrib +s +h 2>nul & attrib "${root}\\*" /d /l`, { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
    for (const line of stdout.split(/\r?\n/)) {
      // "  SH        C:\xxx\dir"——SH 属性且以路径结尾
      const m = line.match(/^\s*([A-Z ]*S[A-Z ]*|[A-Z ]*H[A-Z ]*)\s+(.+?)(?:\s+\[[^\]]*\])?\s*$/)
      if (m && /^([SH][A-Z ]*\s){1,}/.test(line)) {
        const p = m[2].replace(/\s*\[[^\]]*\]\s*$/, '').trim()
        if (p) out.add(p.toLowerCase())
      }
    }
  } catch { /* attrib 不可用——降级为不跳过（宁可多展示也不静默漏） */ }
  return out
}

export async function scanEmptyDirs(root: string, whitelist: WhitelistRule[], includeQuasi = false): Promise<EmptyScanResult> {
  const t0 = Date.now()
  if (!existsSync(root)) return { dirs: [], totalBytes: 0, skippedByAttr: 0, durationMs: 0 }
  const attrSkip = await hiddenDirs(root)
  const tree = await buildTree(root, whitelist, attrSkip)
  if (!tree) return { dirs: [], totalBytes: 0, skippedByAttr: attrSkip.size, durationMs: Date.now() - t0 }
  const dirs = collectEmpty(tree, includeQuasi)
  return { dirs, totalBytes: dirs.reduce((s, d) => s + d.size, 0), skippedByAttr: attrSkip.size, durationMs: Date.now() - t0 }
}

/** 自底向上删除（深路径先删；失败不中断） */
export async function deleteEmptyDirs(dirs: string[]): Promise<{ ok: number; fail: Array<{ path: string; reason: string }> }> {
  const sorted = [...dirs].sort((a, b) => b.length - a.length) // 深的在前
  const fail: Array<{ path: string; reason: string }> = []
  let ok = 0
  for (const d of sorted) {
    try {
      await rm(d, { recursive: true, force: true })
      ok++
    } catch (e) {
      fail.push({ path: d, reason: (e as Error).message })
    }
  }
  return { ok, fail }
}
