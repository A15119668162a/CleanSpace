/**
 * pHash Worker（v2.0 / F1）
 * Jimp 解码 → 32×32 灰度 → pHash；160px 缩略图 → 磁盘缓存
 * 消息协议：{ files, threshold } → 进度/结果；{ cancel: true } 中止
 */
import { parentPort, workerData } from 'worker_threads'
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { phashFromGray, hamming, groupSimilar } from '../../shared/phash'

interface Job {
  files: Array<{ path: string; size: number; mtime: number }>
  threshold: number
  cacheDir: string
  thumbSize?: number
  /** v2.2 媒体模式：只出缩略图映射（不做 pHash 分组） */
  thumbsOnly?: boolean
}

const job = workerData as Job
const THUMB = job.thumbSize || 160
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i

let cancelled = false
parentPort?.on('message', (m: { cancel?: boolean }) => {
  if (m.cancel) cancelled = true
})

async function loadJimp(): Promise<typeof import('jimp') | null> {
  try { return (await import('jimp')).default || (await import('jimp')) } catch { return null }
}

function thumbCachePath(cacheDir: string, path: string, mtime: number): string {
  const key = createHash('sha1').update(path + '|' + mtime).digest('hex').slice(0, 20)
  return join(cacheDir, key + '.jpg')
}

async function processFile(
  J: NonNullable<Awaited<ReturnType<typeof loadJimp>>>,
  f: { path: string; size: number; mtime: number },
  cacheDir: string
): Promise<{ hash?: string; thumb?: string } | null> {
  if (!IMG_EXT.test(f.path)) return null
  // 缓存命中：指纹存同名 .txt
  const tp = thumbCachePath(cacheDir, f.path, f.mtime)
  const fp = tp.replace(/\.jpg$/, '.phash')
  if (existsSync(tp) && existsSync(fp)) {
    return { hash: readFileSync(fp, 'utf8').trim(), thumb: tp }
  }
  const img = await J.read(f.path)
  // 灰度 32×32 → pHash
  const g = img.clone().resize(32, 32).greyscale()
  const gray = new Float64Array(1024)
  g.scan(0, 0, 32, 32, (x, y, idx) => { gray[y * 32 + x] = g.bitmap.data[idx] })
  const hash = phashFromGray(gray)
  // 缩略图 160px（ GIF 保持原格式首帧；Jimp 写 jpg 保兼容体积）
  const t = img.clone().contain(THUMB, THUMB)
  writeFileSync(tp, await t.getBufferAsync(J.MIME_JPEG))
  writeFileSync(fp, hash, 'utf8')
  return { hash, thumb: tp }
}

;(async () => {
  mkdirSync(job.cacheDir, { recursive: true })
  const J = await loadJimp()
  if (!J) {
    parentPort?.postMessage({ type: 'error', message: 'Jimp 加载失败' })
    return
  }
  const out: Array<{ path: string; hash: string; size: number; mtime: number; thumb: string }> = []
  let done = 0
  for (const f of job.files) {
    if (cancelled) { parentPort?.postMessage({ type: 'cancelled', done }); return }
    try {
      const r = await processFile(J, f, job.cacheDir)
      if (r?.hash) out.push({ path: f.path, hash: r.hash, size: f.size, mtime: f.mtime, thumb: r.thumb! })
    } catch { /* 解码失败跳过（HEIC/损坏等） */ }
    done++
    if (done % 20 === 0 || done === job.files.length) parentPort?.postMessage({ type: 'progress', done, total: job.files.length })
  }
  if (job.thumbsOnly) {
    parentPort?.postMessage({ type: 'done', hashed: out.length, groups: [], thumbs: Object.fromEntries(out.map((o) => [o.path, o.thumb])) })
    return
  }
  const groups = groupSimilar(out, job.threshold)
  parentPort?.postMessage({ type: 'done', hashed: out.length, groups, thumbs: Object.fromEntries(out.map((o) => [o.path, o.thumb])) })
})()
