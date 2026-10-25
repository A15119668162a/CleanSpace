/**
 * 视频查重（v3.3 / G2）
 * 两层判定：时长差 ≤2s 预筛 → 头/中/尾三帧 pHash 全相似（海明 ≤6）才归组。
 * ffmpeg 缺失降级：时长+大小近似分组，诚实标注"未验证画面"。
 * 红线 19：绝不预选待删（沿用相似图片）。
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { app } from 'electron'
import { findFfmpeg } from './ffmpeg'

const pexec = promisify(exec)

export interface VidInfo {
  path: string
  size: number
  mtime: number
  durationSec: number | null
  width?: number
  height?: number
  /** 三帧 pHash（十六进制串；降级时 undefined） */
  hashes?: [string, string, string]
  /** 像素总数（分辨率推荐用） */
  pixels?: number
}

export interface VidGroup {
  /** 组内建议保留（最大分辨率；仅建议） */
  keep: VidInfo
  victims: VidInfo[]
  /** 降级模式（未验证画面） */
  approx: boolean
}

export type ProgressCb = (done: number, total: number) => void

/** 单视频信息+三帧哈希（缓存 path+mtime） */
export async function vidInfo(path: string, mtime: number, size: number): Promise<Omit<VidInfo, 'path' | 'size' | 'mtime'>> {
  const ff = await findFfmpeg()
  const key = createHash('sha1').update('vd|' + path + '|' + mtime).digest('hex').slice(0, 20)
  const dir = join(app.getPath('userData'), 'video-dup')
  mkdirSync(dir, { recursive: true })
  const cf = join(dir, key + '.json')
  if (existsSync(cf)) {
    try { return JSON.parse(readFileSync(cf, 'utf8')) } catch { /* 重建 */ }
  }
  const out: Omit<VidInfo, 'path' | 'size' | 'mtime'> = { durationSec: null }
  if (ff) {
    const ffprobe = ff === 'ffmpeg' ? 'ffprobe' : join(dirname(ff), 'ffprobe.exe')
    const qq = ffprobe === 'ffprobe' ? 'ffprobe' : `"${ffprobe}"`
    try {
      const { stdout } = await pexec(`${qq} -v quiet -print_format json -show_format -show_streams "${path}"`, { windowsHide: true, timeout: 20000 })
      const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; codec_type?: string }> }
      out.durationSec = Number(j.format?.duration) || null
      const v = j.streams?.find((s) => s.codec_type === 'video')
      if (v?.width) { out.width = v.width; out.height = v.height; out.pixels = v.width * v.height }
    } catch { /* */ }
    // 三帧：10%（头）50%（中）90%（尾）
    if (out.durationSec && out.durationSec > 0) {
      const q = (cmd: string): string => (ff === 'ffmpeg' ? cmd : `"${ff}" ${cmd}`)
      // 8x8 灰度 raw → aHash（64bit 十六进制）：对视频帧查重足够稳（同源不同分辨率灰度均值高度一致）
      const frame = async (at: number): Promise<string | null> => {
        const fp = join(dir, key + '_' + Math.round(at * 100) + '.gray')
        try {
          await pexec(q(`-ss ${at.toFixed(2)} -i "${path}" -vframes 1 -vf "scale=8:8" -f rawvideo -pix_fmt gray -y "${fp}"`), { windowsHide: true, timeout: 20000 })
          const buf = await readFile(fp)
          if (buf.length < 64) return null
          const px = Array.from(buf.subarray(0, 64))
          const avg = px.reduce((a, b) => a + b, 0) / 64
          let hex = ''
          for (let i = 0; i < 64; i += 4) {
            let n = 0
            for (let k = 0; k < 4; k++) n = (n << 1) | (px[i + k] > avg ? 1 : 0)
            hex += n.toString(16)
          }
          return hex
        } catch { return null }
      }
      const h1 = await frame(Math.max(0.5, out.durationSec * 0.1))
      const h2 = await frame(out.durationSec * 0.5)
      const h3 = await frame(Math.max(0.5, out.durationSec * 0.9))
      if (h1 && h2 && h3) out.hashes = [h1, h2, h3]
    }
  }
  try { writeFileSync(cf, JSON.stringify(out)) } catch { /* */ }
  return out
}

import { readFile } from 'fs/promises'

/** 主查重入口 */
export async function findVideoDupes(files: Array<{ path: string; size: number; mtime: number }>, onProgress?: ProgressCb): Promise<{ groups: VidGroup[]; degraded: boolean; infos: VidInfo[] }> {
  const ff = await findFfmpeg()
  const degraded = !ff
  // 逐个取信息（并发 2）
  const infos: VidInfo[] = []
  for (let i = 0; i < files.length; i += 2) {
    const pair = files.slice(i, i + 2)
    const rs = await Promise.allSettled(pair.map((f) => vidInfo(f.path, f.mtime, f.size)))
    rs.forEach((r, k) => {
      if (r.status === 'fulfilled') infos.push({ ...pair[k], ...r.value })
    })
    onProgress?.(Math.min(i + 2, files.length), files.length)
  }
  // 第一层：时长分桶（±2s）
  const withDur = infos.filter((v) => v.durationSec !== null)
  const buckets: VidInfo[][] = []
  const sorted = [...withDur].sort((a, b) => (a.durationSec || 0) - (b.durationSec || 0))
  for (const v of sorted) {
    const b = buckets.find((bk) => Math.abs((bk[0].durationSec || 0) - (v.durationSec || 0)) <= 2)
    if (b) b.push(v)
    else buckets.push([v])
  }
  // 第二层：桶内分组
  const groups: VidGroup[] = []
  for (const b of buckets) {
    if (b.length < 2) continue
    if (degraded || b.some((v) => !v.hashes)) {
      // 降级：时长相同 + 大小相差 <15% 归组（近似）
      const bySize = [...b].sort((x, y) => y.size - x.size)
      const g: VidInfo[] = [bySize[0]]
      for (const v of bySize.slice(1)) {
        if (Math.abs(v.size - bySize[0].size) / bySize[0].size < 0.15) g.push(v)
      }
      if (g.length > 1) groups.push(mkGroup(g, true))
    } else {
      // 三帧全相似归组（贪心聚类）
      const used = new Set<string>()
      for (const v of b) {
        if (used.has(v.path)) continue
        const g = [v]
        used.add(v.path)
        for (const w of b) {
          if (used.has(w.path) || !w.hashes || !v.hashes) continue
          const d = (i: number): number => hamming(v.hashes![i], w.hashes![i])
          if (d(0) <= 6 && d(1) <= 6 && d(2) <= 6) { g.push(w); used.add(w.path) }
        }
        if (g.length > 1) groups.push(mkGroup(g, false))
      }
    }
  }
  return { groups, degraded, infos }
}

function mkGroup(g: VidInfo[], approx: boolean): VidGroup {
  const sorted = [...g].sort((a, b) => (b.pixels || b.size) - (a.pixels || a.size))
  return { keep: sorted[0], victims: sorted.slice(1), approx }
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 99
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1)
  }
  return d
}
