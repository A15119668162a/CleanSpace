/**
 * 扫描核心（纯 Node，Worker 内运行，可独立测试）
 * 迭代式遍历 + TOP-N 小顶堆 + 类型统计；目录 size 由子项聚合（引用共享，自底向上累加）
 */
import { readdirSync, statSync, type Dirent, type Stats } from 'fs'
import { join } from 'path'

export interface FileEntry { path: string; size: number; mtime: number }

export interface ScanOptions {
  /** 收集 TOP-N 大文件（默认 50） */
  topN?: number
  /** 目录条目数超过该值时跳过该子目录（防异常黑洞），0=不限制 */
  maxDirEntries?: number
  /** 仅保留根层文件明细；深层目录只聚合统计（默认 true，防止大目录树撑爆内存/传输） */
  rootFilesOnly?: boolean
  /** 仅扫描当前层的文件（不递归子目录、不计子目录数）—— 用于分片拆分时父目录补扫 */
  filesOnly?: boolean
}

export interface ScanStats {
  totalFiles: number
  totalDirs: number
  totalBytes: number
  errors: number
  skipped: Array<{ path: string; reason: 'denied' | 'error' }>
  durationMs: number
  typeBytes: Record<string, number>
  typeFiles: Record<string, number>
}

export interface DirNode {
  path: string
  name: string
  size: number
  mtime: number
  children: Array<DirNode | FileEntry>
  fileCount: number
  dirCount: number
}

/* ---------------- TOP-N 小顶堆（按 size） ---------------- */
class TopHeap {
  private h: FileEntry[] = []
  private built = false
  constructor(private readonly max: number) {}

  push(e: FileEntry): void {
    if (this.max <= 0) return
    if (this.h.length < this.max) {
      this.h.push(e)
      if (this.h.length === this.max) { this.heapify(); this.built = true }
      return
    }
    if (!this.built) { this.heapify(); this.built = true }
    if (e.size > this.h[0].size) { this.h[0] = e; this.down(0) }
  }

  private heapify(): void {
    for (let i = (this.h.length >> 1) - 1; i >= 0; i--) this.down(i)
  }

  private down(i: number): void {
    const n = this.h.length
    for (;;) {
      const l = 2 * i + 1, r = l + 1
      let m = i
      if (l < n && this.h[l].size < this.h[m].size) m = l
      if (r < n && this.h[r].size < this.h[m].size) m = r
      if (m === i) break
      const t = this.h[i]; this.h[i] = this.h[m]; this.h[m] = t
      i = m
    }
  }

  sorted(): FileEntry[] { return [...this.h].sort((a, b) => b.size - a.size) }
}

/* ---------------- 类型分类（M1 分布 + M3 整理共用） ---------------- */
export const VIDEO_EXT = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'rmvb', 'rm'])
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'heic', 'avif'])
export const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'ape'])
export const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'wps', 'et', 'dps'])
export const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'])
export const INSTALLER_EXT = new Set(['exe', 'msi', 'msix', 'appx'])
export const CODE_EXT = new Set(['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'vue', 'json', 'xml', 'yml', 'yaml', 'sh', 'bat', 'ps1'])

export function classifyFile(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return '其他'
  const ext = name.slice(dot + 1).toLowerCase()
  if (VIDEO_EXT.has(ext)) return '视频'
  if (IMAGE_EXT.has(ext)) return '图片'
  if (AUDIO_EXT.has(ext)) return '音频'
  if (DOC_EXT.has(ext)) return '文档'
  if (ARCHIVE_EXT.has(ext)) return '压缩包'
  if (INSTALLER_EXT.has(ext)) return '安装包'
  if (CODE_EXT.has(ext)) return '代码'
  return '其他'
}

export interface ScanResult {
  root: DirNode
  stats: ScanStats
  topFiles: FileEntry[]
  /** 全部文件明细（v2.4.2：搜索索引用；内存换完整索引） */
  allFiles?: FileEntry[]
}

/**
 * 精简树：仅保留目录层与文件名集合（供缓存/旭日图目录下钻），剥离文件对象引用
 * 根层以下的文件全部聚合为「文件总大小/数量」记录在目录节点，children 只留子目录
 * —— 大幅降低跨线程传输与内存占用（41 万文件场景）
 */
export function pruneTree(node: DirNode, keepFilesAtRoot = true): DirNode {
  const pruned: DirNode = { ...node, children: [] }
  for (const c of node.children) {
    if ('children' in c) {
      pruned.children.push(pruneTree(c, false))
    } else if (keepFilesAtRoot) {
      pruned.children.push(c)
    }
  }
  return pruned
}

interface EntryMeta { name: string; isDir: boolean; size: number; mtime: number }
interface Frame { node: DirNode; entries: EntryMeta[]; idx: number }

/**
 * 全量扫描单个目录树（同步 IO 版：Worker 内运行，避免 41 万次异步 stat 的调度开销）
 * - 同步 readdirSync/statSync + 显式栈，目录 size 自底向上聚合
 * - 权限不足 → skipped(denied)，绝不静默失败；符号链接不跟随
 * - 路径统一 Windows 反斜杠
 */
export function scanTreeSync(rootPath: string, opts: ScanOptions = {}): ScanResult {
  const t0 = Date.now()
  const topN = opts.topN ?? 50
  const maxEntries = opts.maxDirEntries ?? 0
  const top = new TopHeap(topN)
  const stats: ScanStats = {
    totalFiles: 0, totalDirs: 0, totalBytes: 0, errors: 0,
    skipped: [], durationMs: 0, typeBytes: {}, typeFiles: {}
  }

  // 规范化：统一反斜杠；盘符根（F:\）保留尾部反斜杠，其余去尾
  function normalizeRoot(p: string): string {
    if (process.platform !== 'win32') return p.replace(/\/+$/, '')
    const b = p.replace(/\//g, '\\')
    const noTail = b.replace(/\\+$/, '')
    return /^[A-Za-z]:$/.test(noTail) ? noTail + '\\' : noTail
  }
  const normRoot = normalizeRoot(rootPath)
  const rootName = normRoot.split(/[\\/]/).filter(Boolean).pop() || normRoot
  let rootStat: Stats
  try {
    rootStat = statSync(normRoot)
    if (!rootStat.isDirectory()) throw new Error(`不是目录`)
  } catch (e) {
    throw new Error(`目录不存在或不可访问: ${rootPath} (${(e as Error).message})`)
  }
  const root: DirNode = { path: normRoot, name: rootName, size: 0, mtime: rootStat.mtimeMs, children: [], fileCount: 0, dirCount: 0 }
  const allFiles: FileEntry[] = []
  const ALL_FILES_CAP = 5_000_000 // v2.4.2：索引明细上限（500 万文件足够全盘）

  interface Frame { node: DirNode; entries: EntryMeta[]; idx: number }
  const stack: Frame[] = []
  let current: Frame | undefined = { node: root, entries: [], idx: 0 }

  const rootFilesOnly = opts.rootFilesOnly ?? true
  const filesOnlyFlag = opts.filesOnly ?? false
  let depth = 0
  while (current) {
    if (current.idx === 0 && current.entries.length === 0) {
      let dirents: Dirent[]
      try {
        dirents = readdirSync(current.node.path, { withFileTypes: true })
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        stats.skipped.push({ path: current.node.path, reason: code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ? 'denied' : 'error' })
        stats.errors++
        current = stack.pop()
        continue
      }
      if (maxEntries > 0 && dirents.length > maxEntries) {
        stats.skipped.push({ path: current.node.path, reason: 'error' })
        current = stack.pop()
        continue
      }
      const list: EntryMeta[] = []
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue
        // filesOnly 模式：跳过子目录（子目录由独立分片负责，避免重复计数）
        if (filesOnlyFlag && d.isDirectory()) continue
        const full = join(current.node.path, d.name)
        try {
          const s = statSync(full)
          list.push({ name: d.name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs })
        } catch { stats.errors++ }
      }
      current.entries = list
    }

    if (current.idx < current.entries.length) {
      const e = current.entries[current.idx++]
      if (e.isDir) {
        stats.totalDirs++
        const child: DirNode = { path: join(current.node.path, e.name), name: e.name, size: 0, mtime: e.mtime, children: [], fileCount: 0, dirCount: 0 }
        current.node.children.push(child)
        stack.push(current)
        depth++
        current = { node: child, entries: [], idx: 0 }
      } else {
        stats.totalFiles++
        stats.totalBytes += e.size
        const fe: FileEntry = { path: join(current.node.path, e.name), size: e.size, mtime: e.mtime }
        // v2.4.2：全量明细收集（索引用）；树仍按内存优化只留根层
        if (allFiles.length < ALL_FILES_CAP) allFiles.push(fe)
        // 内存优化：仅根层保留文件明细，深层只计数（明细已在 top/type 统计里）
        if (depth === 0 || !rootFilesOnly) current.node.children.push(fe)
        current.node.size += e.size
        current.node.fileCount++
        const cat = classifyFile(e.name)
        stats.typeBytes[cat] = (stats.typeBytes[cat] || 0) + e.size
        stats.typeFiles[cat] = (stats.typeFiles[cat] || 0) + 1
        top.push(fe)
      }
    } else {
      const finished = current.node
      const parentFrame = stack.pop()
      depth--
      if (parentFrame) {
        parentFrame.node.size += finished.size
        parentFrame.node.fileCount += finished.fileCount
        parentFrame.node.dirCount += finished.dirCount + 1
      }
      current = parentFrame
    }
  }

  stats.durationMs = Date.now() - t0
  return { root, stats, topFiles: top.sorted(), allFiles }
}

/** 异步版保留（测试与兼容） */
export async function scanTree(rootPath: string, opts: ScanOptions = {}): Promise<ScanResult> {
  return scanTreeSync(rootPath, opts)
}

/** TOP-N 文件夹排行（不含根，按 size 降序） */
export function topDirs(root: DirNode, n = 20): DirNode[] {
  const arr: DirNode[] = []
  // v4.2.6：迭代化（防深树爆栈）
  const stack: DirNode[] = [root]
  while (stack.length > 0) {
    const d = stack.pop()!
    for (const c of d.children) if ('children' in c) { arr.push(c); stack.push(c) }
  }
  return arr.sort((a, b) => b.size - a.size).slice(0, n)
}

export interface SunburstNode {
  name: string
  value?: number
  children?: SunburstNode[]
  path?: string
  isFile?: boolean
}

/** 目录树 → ECharts sunburst data（小扇区聚合，控制节点数） */
export function toSunburst(node: DirNode, minSize: number, maxChildren = 60): SunburstNode {
  const conv = (n: DirNode): SunburstNode => {
    const kids: SunburstNode[] = []
    let rest = 0
    for (const c of n.children) {
      if (c.size < minSize) { rest += c.size; continue }
      if ('children' in c) kids.push(conv(c))
      else kids.push({ name: c.name, value: c.size, path: c.path, isFile: true })
    }
    if (rest > 0) kids.push({ name: '· 较小项', value: rest, path: n.path })
    if (kids.length > maxChildren) {
      kids.sort((a, b) => (b.value || 0) - (a.value || 0))
      const kept = kids.slice(0, maxChildren - 1)
      const restVal = kids.slice(maxChildren - 1).reduce((s, k) => s + (k.value || 0), 0)
      kept.push({ name: '其他', value: restVal, path: n.path })
      return { name: n.name, children: kept, path: n.path }
    }
    return { name: n.name, children: kids, path: n.path }
  }
  return conv(node)
}
