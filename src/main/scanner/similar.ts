/**
 * 相似图片引擎（v2.0 / F1）：Worker 调度 + IPC
 */
import { Worker } from 'worker_threads'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import type { WhitelistRule } from '../../shared/whitelist'
import { isProtected } from '../../shared/whitelist'
import { collectFiles } from '../organizer/rules'

export interface SimilarGroup {
  files: Array<{ path: string; size: number; mtime: number }>
}

export interface PhashResult {
  hashed: number
  groups: SimilarGroup[]
  thumbs: Record<string, string>
  durationMs: number
}

let worker: Worker | null = null

export function cancelPhash(): void {
  worker?.postMessage({ cancel: true })
}

/** 扫描目录下图片（>10KB，白名单过滤）→ pHash → 相似分组 */
/** 缓存目录：Electron 下 userData，测试/无 app 环境（app 未 ready 等）退 tmpdir */
function thumbCacheDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    return join(app.getPath('userData'), 'thumb-cache')
  } catch {
    return join(require('os').tmpdir(), 'cleanspace-thumb-cache')
  }
}

export async function findSimilar(
  root: string,
  threshold: number,
  whitelist: WhitelistRule[],
  onProgress?: (done: number, total: number) => void
): Promise<PhashResult> {
  const t0 = Date.now()
  const files = (await collectFiles(root, 0, 6)).filter(
    (f) => f.size > 10 * 1024 && /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(f.path) && !isProtected(f.path, whitelist)
  )
  const cacheDir = thumbCacheDir()
  mkdirSync(cacheDir, { recursive: true })

  return new Promise((resolve, reject) => {
    // dev: out/main/scanner/worker-phash.js；asar 打包: app.asar/out/main/chunks/worker-phash-*.js
    const here = dirname(__filename)
    const candidates = [
      join(here, 'worker-phash.js'),                       // dev 构建产物（out/main/scanner/）
      join(here, 'scanner', 'worker-phash.js'),             // 打包（chunk 在 out/main/）
      join(here, '..', 'scanner', 'worker-phash.js'),       // chunk 在 out/main/chunks/
      join(here, 'chunks', 'worker-phash.js'),              // 分包兜底
      // vitest（__filename 指向 src/main/scanner/）：探测仓库 out 产物
      join(here, '..', '..', '..', 'out', 'main', 'scanner', 'worker-phash.js')
    ]
    const fsx = require('fs') as typeof import('fs')
    const entry = candidates.find((c) => fsx.existsSync(c))
    if (!entry) { reject(new Error('worker-phash 入口未找到: ' + candidates.join(' | '))); return }
    worker = new Worker(entry, {
      workerData: { files, threshold, cacheDir },
      resourceLimits: { maxOldGenerationSizeMb: 2048 }
    })
    worker.on('message', (m: { type: string; done?: number; total?: number; hashed?: number; groups?: SimilarGroup[]; thumbs?: Record<string, string>; message?: string }) => {
      if (m.type === 'progress' && m.done !== undefined) onProgress?.(m.done, m.total || files.length)
      else if (m.type === 'done') {
        resolve({ hashed: m.hashed || 0, groups: m.groups || [], thumbs: m.thumbs || {}, durationMs: Date.now() - t0 })
        worker?.terminate().catch(() => undefined)
        worker = null
      } else if (m.type === 'error') reject(new Error(m.message))
      else if (m.type === 'cancelled') {
        reject(new Error('已取消'))
        worker?.terminate().catch(() => undefined)
        worker = null
      }
    })
    worker.on('error', (e) => { worker = null; reject(e) })
  })
}
