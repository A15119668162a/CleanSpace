/**
 * 扫描引擎（主进程侧，v2 并行分片）
 * - 首层子目录分片 → Worker 池并行扫描（默认 min(4, cpus) 路）
 * - 根目录的松散文件由主进程轻量补扫（不阻塞）
 * - 进度事件经 BrowserWindow 广播；支持取消
 * - 缓存：整树命中 → 秒级重建
 */
import { Worker } from 'worker_threads'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import os from 'os'
import { getDb } from '../store/db'
import type { DirNode, FileEntry, ScanStats } from './core'
import { migrateScanCache, cacheHit, rebuildTree, saveCache, verifyRebuilt, deepVerify, cacheHasFileRows } from './cache'

export interface ScanResultPayload {
  root: DirNode
  stats: ScanStats
  topFiles: FileEntry[]
  cached: boolean
}

export type ProgressSink = (p: { taskId: string; phase: 'start' | 'shard-done' | 'done'; msg?: string; done?: number; total?: number }) => void

let sink: ProgressSink | null = null
export function setProgressSink(fn: ProgressSink): void {
  sink = fn
}

const active = new Set<Worker>()

/** 系统保护/无意义目录（分片时跳过） */
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'recovery'])

/** 最近一次扫描的完整树（主进程内存，供按需取子节点） */
let lastTree: DirNode | null = null

/** 当前内存中的完整扫描树（快照/下钻用；无扫描结果返回 null） */
export function treeOf(rootPath: string): DirNode | null {
  if (!lastTree) return null
  return lastTree.path.replace(/\\/g, '/').toLowerCase() === rootPath.replace(/\\/g, '/').toLowerCase() ? lastTree : null
}

export interface NodeMeta {
  path: string
  name: string
  size: number
  isDir: boolean
  fileCount: number
  dirCount: number
}

/** 按路径查找节点（v4.2.6 迭代化——防深树爆栈） */
function findNode(root: DirNode, path: string): DirNode | null {
  const target = path.toLowerCase()
  const stack: DirNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.path.toLowerCase() === target) return n
    for (const c of n.children) if ('children' in c) stack.push(c as DirNode)
  }
  return null
}

/** 取某节点的直接子项（目录+文件，按大小排序，封顶 300）——渲染端旭日图下钻用 */
export function childrenOf(path: string): { node: NodeMeta; children: NodeMeta[] } | null {
  if (!lastTree) return null
  const n = findNode(lastTree, path)
  if (!n) return null
  const kids: NodeMeta[] = []
  for (const c of n.children) {
    if ('children' in c) kids.push({ path: c.path, name: c.name, size: c.size, isDir: true, fileCount: c.fileCount, dirCount: c.dirCount })
    else kids.push({ path: c.path, name: c.name, size: c.size, isDir: false, fileCount: 0, dirCount: 0 })
  }
  kids.sort((a, b) => b.size - a.size)
  return {
    node: { path: n.path, name: n.name, size: n.size, isDir: true, fileCount: n.fileCount, dirCount: n.dirCount },
    children: kids.slice(0, 300)
  }
}

/** 瘦身根节点：仅目录层、深度 ≤3、每节点子项 ≤80（IPC 回传用，防巨型克隆失败） */
function slimTree(n: DirNode, depth: number): DirNode {
  const out: DirNode = { path: n.path, name: n.name, size: n.size, mtime: n.mtime, children: [], fileCount: n.fileCount, dirCount: n.dirCount }
  if (depth >= 3) return out
  const dirs = n.children.filter((c): c is DirNode => 'children' in c).sort((a, b) => b.size - a.size)
  for (const d of dirs.slice(0, 80)) out.children.push(slimTree(d, depth + 1))
  return out
}

export function cancelAll(): void {
  for (const w of active) w.terminate()
  active.clear()
}

function emptyStats(): ScanStats {
  return { totalFiles: 0, totalDirs: 0, totalBytes: 0, errors: 0, skipped: [], durationMs: 0, typeBytes: {}, typeFiles: {} }
}

function mergeTop(dst: FileEntry[], src: FileEntry[], n = 50): FileEntry[] {
  return [...dst, ...src].sort((a, b) => b.size - a.size).slice(0, n)
}

function workerPath(): string {
  return `${__dirname}/scanner/worker.js`.replace(/\\/g, '/')
}

/** 单 worker 扫描一个分片，Promise 化（filesOnly：只扫该目录层文件，子目录独立分片） */
function runShard(rootPath: string, label: string, filesOnly = false): Promise<{ root: DirNode; stats: ScanStats; topFiles: FileEntry[] }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath(), {
      workerData: { taskId: label, rootPath, filesOnly },
      resourceLimits: { maxOldGenerationSizeMb: 2048 }
    })
    active.add(w)
    w.on('message', (m: { type: string; message?: string; root?: DirNode; stats?: ScanStats; topFiles?: FileEntry[]; allFiles?: FileEntry[] }) => {
      if (m.type === 'done' && m.root && m.stats) resolve({ root: m.root, stats: m.stats, topFiles: m.topFiles || [], allFiles: m.allFiles || [] })
      else if (m.type === 'error') reject(new Error(m.message))
    })
    w.on('error', reject)
    w.on('exit', (code) => {
      active.delete(w)
      if (code !== 0) reject(new Error(`worker(${label}) 异常退出: ${code}`))
    })
  })
}

/** 列目录的直接子目录（快，不递归） */
async function listSubDirs(p: string): Promise<string[]> {
  try {
    const ds = await readdir(p, { withFileTypes: true })
    return ds
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !SKIP_DIRS.has(d.name.toLowerCase()))
      .map((d) => join(p, d.name))
  } catch {
    return []
  }
}

/** 扫描/缓存恢复后的持久化：记忆根 + 快照 + 搜索索引（v2.4.1：缓存命中也执行——否则索引永远不建） */
/** 从缓存读该根的全部文件行（缓存命中路径的索引源） */
function flattenCachedFiles(db: import('better-sqlite3').Database, rootPath: string): Array<{ path: string; size: number; mtime: number }> {
  try {
    return db.prepare('SELECT path, size, mtime FROM scan_cache_v3 WHERE root_path = ? AND is_dir = 0').all(rootPath) as Array<{ path: string; size: number; mtime: number }>
  } catch { return [] }
}

async function persistAfterScan(db: import('better-sqlite3').Database, rootPath: string, tree: DirNode, allFiles?: Array<{ path: string; size: number; mtime: number }>): Promise<void> {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_scan_root', ?)").run(rootPath)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_scan_ts', ?)").run(String(Date.now()))
  } catch { /* */ }
  try {
    const { saveSnapshot, flattenTree } = await import('../health/snapshots')
    const rows = flattenTree(tree as never)
    saveSnapshot(db, rootPath, rows)
    console.log(`[engine] snapshot saved: ${rows.length} dirs`)
  } catch (e) {
    console.log('[engine] snapshot save failed:', (e as Error).message)
  }
  try {
    const { rebuildIndex, flattenForIndex } = await import('../search/index')
    // v2.4.2：显式 allFiles 直供（深层文件不进树的内存优化下，树展平会漏）；
    // 缓存命中路径传 flattenCachedFiles 结果
    const explicit = allFiles && allFiles.length ? allFiles : flattenCachedFiles(db, rootPath)
    const rows = flattenForIndex(tree as never, rootPath, [], explicit)
    rebuildIndex(db, rootPath, rows)
    console.log(`[engine] search index rebuilt: ${rows.length} files`)
  } catch (e) {
    console.log('[engine] index rebuild failed:', (e as Error).message)
  }
}

/**
 * 并行扫描：根的首层子目录分片 + 根松散文件主进程补扫
 */
export async function startScan(rootPath: string, force: boolean): Promise<ScanResultPayload> {
  const t0 = Date.now()
  const db = getDb()
  migrateScanCache(db)
  // 主进程侧同样禁用 .asar 拦截（根层松散文件 stat 用）
  const prevNoAsar = process.noAsar
  process.noAsar = true

  // 缓存路径
  if (!force) {
    try {
      const hit = await cacheHit(db, rootPath)
      if (hit.hit && hit.rows && cacheHasFileRows(hit.rows)) {
        const rebuilt = rebuildTree(hit.rows, rootPath)
        console.log('[engine] rebuildTree:', rebuilt ? 'ok kids=' + rebuilt.children.length : 'null')
        if (rebuilt) {
          const reason = await verifyRebuilt(rebuilt)
          console.log('[engine] verify:', reason === null ? 'PASS' : 'FAIL ' + reason)
          if (reason === null) {
            // 深层校验（v1.2）：防深层变更漏判；失败 → 放弃缓存走全量
            const deepReason = await deepVerify(rebuilt)
            if (deepReason !== null) {
              console.log('[engine] deepVerify FAIL → 全量重扫:', deepReason)
            } else {
              process.noAsar = prevNoAsar
              lastTree = rebuilt
              // v2.4.1 修复：缓存命中也建索引/存快照（否则自动恢复场景索引永远为空）
              void persistAfterScan(db, rootPath, rebuilt) // 文件明细在函数内自动从缓存读
              const slim = slimTree(rebuilt, 0)
              return {
                root: slim,
                stats: {
                  totalFiles: rebuilt.fileCount, totalDirs: rebuilt.dirCount, totalBytes: rebuilt.size,
                  errors: 0, skipped: [], durationMs: 0, typeBytes: {}, typeFiles: {}
                },
                topFiles: [], cached: true
              }
            }
          }
        }
      }
    } catch { /* 缓存异常忽略，走全量 */ }
  }
  console.log('[engine] cache miss → full scan')

  // 准备根节点
  const rootName = rootPath.split(/[\\/]/).pop() || rootPath
  const rs = await stat(rootPath)
  const root: DirNode = { path: rootPath, name: rootName, size: 0, mtime: rs.mtimeMs, children: [], fileCount: 0, dirCount: 0 }
  const stats = emptyStats()

  const dirents = await readdir(rootPath, { withFileTypes: true }).catch(() => [] as never)
  // 分片：首层子目录；仅当首层分片少且某分片子目录多（≥8）时下钻一层拆开；跳过系统保护目录
  const rawShards: Array<{ path: string; filesOnly: boolean }> = []
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue
    if (!d.isDirectory()) continue
    if (SKIP_DIRS.has(d.name.toLowerCase())) continue
    rawShards.push({ path: join(rootPath, d.name), filesOnly: false })
  }
  let shardDirs: Array<{ path: string; filesOnly: boolean }> = rawShards
  if (rawShards.length > 0 && rawShards.length < 8) {
    const expanded: Array<{ path: string; filesOnly: boolean }> = []
    for (const s of rawShards) {
      const subs = await listSubDirs(s.path)
      if (subs.length >= 8) {
        expanded.push({ path: s.path, filesOnly: true })
        for (const sp of subs) expanded.push({ path: sp, filesOnly: false }) // v4.2.6 循环防 spread 爆栈
      } else {
        expanded.push(s)
      }
    }
    shardDirs = expanded
  }
  // 并行度
  const PARALLEL = Math.min(8, Math.max(3, os.cpus().length >> 1), shardDirs.length || 1)

  sink?.({ taskId: 'scan', phase: 'start', msg: rootPath, total: shardDirs.length })

  // 分片队列
  const results: Array<{ root: DirNode; stats: ScanStats; topFiles: FileEntry[] }> = []
  let doneCount = 0
  const queue = [...shardDirs]
  const runners = Array.from({ length: PARALLEL }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) break
      try {
        const r = await runShard(item.path, item.path.split('\\').pop() || item.path.split('/').pop() || item.path, item.filesOnly)
        results.push(r)
      } catch (e) {
        // 单分片失败不致命：记为 skipped
        console.error('[engine] shard FAILED:', item.path, (e as Error).message)
        stats.skipped.push({ path: item.path, reason: 'error' })
        stats.errors++
      }
      doneCount++
      sink?.({ taskId: 'scan', phase: 'shard-done', done: doneCount, total: shardDirs.length })
    }
  })

  // 根松散文件（主进程轻量扫，仅当前层文件）
  const rootFiles: FileEntry[] = []
  for (const d of dirents) {
    if (d.isFile() && !d.isSymbolicLink()) {
      try {
        const full = join(rootPath, d.name)
        const s = await stat(full)
        const fe: FileEntry = { path: full, size: s.size, mtime: s.mtimeMs }
        rootFiles.push(fe)
        root.children.push(fe)
      } catch { stats.errors++ }
    }
  }

  await Promise.all(runners)

  // 合并：按 path 索引；filesOnly 分片的 root 与其子目录分片的 root 建父子挂接
  const nodeByPath = new Map<string, DirNode>()
  for (const r of results) nodeByPath.set(r.root.path.toLowerCase(), r.root)
  const top: DirNode[] = []
  for (const r of results) {
    const parentPath = r.root.path.slice(0, r.root.path.lastIndexOf('\\')).toLowerCase()
    const parentNode = nodeByPath.get(parentPath)
    if (parentNode) {
      parentNode.children.push(r.root)
      parentNode.size += r.root.size
      parentNode.fileCount += r.root.fileCount
      parentNode.dirCount += r.root.dirCount + 1
    } else {
      top.push(r.root)
    }
  }

  // 汇总 stats：以树为准重算（root.children 已包含全部顶层分片；数所有目录节点，不含根）
  let totalDirs = 0
  // v4.2.6 迭代化统计
  const cntStack: DirNode[] = [...top]
  while (cntStack.length > 0) {
    const n = cntStack.pop()!
    totalDirs++
    for (const c of n.children) if ('children' in c) cntStack.push(c as DirNode)
  }

  let topFiles = rootFiles.slice(0, 50)
  const rootFilesBytes = rootFiles.reduce((s, f) => s + f.size, 0)

  // files/bytes/type 从分片 stats 累加（无重复：filesOnly 片无子目录计数、全量片各自子树闭合）
  stats.totalFiles = 0
  stats.totalBytes = 0
  const allFiles: FileEntry[] = [] // v2.4.2：全量文件明细（搜索索引源）
  for (const r of results) {
    stats.totalFiles += r.stats.totalFiles
    stats.totalBytes += r.stats.totalBytes
    for (const k of Object.keys(r.stats.typeBytes)) stats.typeBytes[k] = (stats.typeBytes[k] || 0) + r.stats.typeBytes[k]
    for (const k of Object.keys(r.stats.typeFiles)) stats.typeFiles[k] = (stats.typeFiles[k] || 0) + r.stats.typeFiles[k]
    stats.errors += r.stats.errors
    // v4.2.6：循环追加（spread push 超 ~6.5 万参数爆栈——Windows/Users 海量 EPERM 目录真凶）
    for (const sk of r.stats.skipped) stats.skipped.push(sk)
    topFiles = mergeTop(topFiles, r.topFiles)
    if (r.allFiles) for (const af of r.allFiles) allFiles.push(af) // v4.2.6 循环追加（同上防 spread 爆栈）
  }
  for (const t of top) root.children.push(t)
  stats.totalDirs = totalDirs
  root.dirCount = totalDirs
  root.size = stats.totalBytes + rootFilesBytes
  root.fileCount = stats.totalFiles + rootFiles.length
  stats.totalFiles += rootFiles.length
  stats.totalBytes += rootFilesBytes
  // 根文件类型统计
  for (const fe of rootFiles) {
    const ext = fe.path.slice(fe.path.lastIndexOf('.') + 1).toLowerCase()
    const key = classifyExt(ext)
    stats.typeBytes[key] = (stats.typeBytes[key] || 0) + fe.size
    stats.typeFiles[key] = (stats.typeFiles[key] || 0) + 1
  }

  stats.durationMs = Date.now() - t0

  // 记忆根 + 快照 + 搜索索引（公共持久化）
  await persistAfterScan(db, rootPath, root, allFiles)

  process.noAsar = prevNoAsar
  try {
    saveCache(db, root, [...allFiles, ...rootFiles]) // v2.4.2：文件行全量入缓存（深层不进树）
  } catch { /* 缓存失败不影响结果 */ }

  sink?.({ taskId: 'scan', phase: 'done' })
  // 完整树留主进程内存（按需下钻）；IPC 只回瘦树（≤3 层目录），防巨型克隆失败
  lastTree = root
  const slim = slimTree(root, 0)
  return { root: slim, stats, topFiles, cached: false }
}

/** 与 core.classifyFile 一致的扩展名分类（避免主进程打包 core 双份） */
function classifyExt(ext: string): string {
  const sets: Array<[string, string]> = [
    ['mp4,mkv,avi,mov,wmv,flv,webm,m4v,rmvb,rm', '视频'],
    ['jpg,jpeg,png,gif,webp,bmp,svg,ico,tiff,heic,avif', '图片'],
    ['mp3,wav,flac,aac,ogg,wma,m4a,ape', '音频'],
    ['pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,csv,wps,et,dps', '文档'],
    ['zip,rar,7z,tar,gz,bz2,xz,iso', '压缩包'],
    ['exe,msi,msix,appx', '安装包'],
    ['js,ts,py,java,c,cpp,h,cs,go,rs,rb,php,html,css,vue,json,xml,yml,yaml,sh,bat,ps1', '代码']
  ]
  for (const [list, name] of sets) if (list.split(',').includes(ext)) return name
  return '其他'
}
