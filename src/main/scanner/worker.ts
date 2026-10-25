/**
 * 扫描 Worker 线程
 * workerData: { taskId, rootPath, filesOnly? }
 */
import { parentPort, workerData } from 'worker_threads'
import { scanTreeSync } from './core'

// 关键：禁用 Electron 的 .asar 拦截（否则扫描含 .asar 文件的目录时每个都要解析归档头，极慢）
if (typeof process.noAsar === 'boolean') process.noAsar = true

const { taskId, rootPath, filesOnly } = workerData as { taskId: string; rootPath: string; filesOnly?: boolean }

function post(msg: unknown): void {
  parentPort?.postMessage(msg)
}

try {
  const result = scanTreeSync(rootPath, { topN: 50, filesOnly })
  // v2.4.2：allFiles 回传（搜索索引源；structuredClone 拷贝安全）
  post({ taskId, type: 'done', root: result.root, stats: result.stats, topFiles: result.topFiles, allFiles: result.allFiles || [] })
} catch (e) {
  post({ taskId, type: 'error', message: (e as Error).message })
}
