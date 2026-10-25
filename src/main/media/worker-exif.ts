/**
 * EXIF Worker（v3.0 G1）：批量解析照片时间，结果带缓存键
 * workerData: { files: Array<{path, mtime}>, cacheDir }
 */
import { parentPort, workerData } from 'worker_threads'
import { readExifTime } from './exif'

if (typeof process.noAsar === 'boolean') process.noAsar = true

const { files } = workerData as { files: Array<{ path: string; mtime: number }> }

async function main(): Promise<void> {
  const out: Record<string, { ts: number | null; source?: string }> = {}
  for (const f of files) {
    try {
      const r = await readExifTime(f.path)
      out[f.path] = { ts: r.ts, source: r.source }
    } catch {
      out[f.path] = { ts: null }
    }
    // 批量进度推送（前端可渐进渲染）
    parentPort?.postMessage({ type: 'progress', done: Object.keys(out).length, total: files.length })
  }
  parentPort?.postMessage({ type: 'done', results: out })
}

void main()
