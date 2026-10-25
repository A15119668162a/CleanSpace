/**
 * 视频首帧抽帧与元数据（v2.2.1 / F9.2）
 * ffmpeg 三级定位：PATH → 常见安装路径 → 降级（占位图标，红线 16：失败不崩溃不阻塞）
 * 临时文件放系统 temp，随用随清
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { app } from 'electron'

const pexec = promisify(exec)

let ffmpegPath: string | null = null
let ffmpegChecked = false

const CANDIDATES = [
  'ffmpeg', // PATH
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
  join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin', 'ffmpeg.exe')
]

/** 定位 ffmpeg（一次性；找不到返回 null——优雅降级） */
export async function findFfmpeg(): Promise<string | null> {
  if (ffmpegChecked) return ffmpegPath
  ffmpegChecked = true
  for (const c of CANDIDATES) {
    try {
      const q = c === 'ffmpeg' ? 'ffmpeg -version' : `"${c}" -version`
      await pexec(q, { windowsHide: true, timeout: 5000 })
      ffmpegPath = c
      return c
    } catch { /* 下一个 */ }
  }
  return null
}

export interface VideoMeta {
  thumb?: string   // 首帧 jpg 路径（失败无）
  durationSec?: number
  width?: number
  height?: number
}

function cacheDir(): string {
  const d = join(app.getPath('userData'), 'video-thumbs')
  mkdirSync(d, { recursive: true })
  return d
}

/**
 * 抽帧 + 元数据（单个；失败返回空对象——调用方显示占位）
 * thumbKey 复用缓存（path+mtime）
 */
export async function probeVideo(path: string, mtime: number): Promise<VideoMeta> {
  const ff = await findFfmpeg()
  if (!ff) return {}
  const key = createHash('sha1').update(path + '|' + mtime).digest('hex').slice(0, 20)
  const dir = cacheDir()
  const thumb = join(dir, key + '.jpg')
  const metaF = join(dir, key + '.json')
  if (existsSync(thumb) && existsSync(metaF)) {
    try { return JSON.parse(require('fs').readFileSync(metaF, 'utf8')) as VideoMeta } catch { /* 重建 */ }
  }
  const q = (cmd: string): string => (ff === 'ffmpeg' ? cmd : `"${ff}" ${cmd}`)
  const meta: VideoMeta = {}
  // ffprobe 同目录定位（元数据：时长/分辨率）
  try {
    const ffprobe = ff === 'ffmpeg' ? 'ffprobe' : join(dirname(ff), 'ffprobe.exe')
    const qq = ffprobe === 'ffprobe' ? 'ffprobe' : `"${ffprobe}"`
    const { stdout } = await pexec(`${qq} -v quiet -print_format json -show_format -show_streams "${path}"`, { windowsHide: true, timeout: 15000 })
    const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; codec_type?: string }> }
    meta.durationSec = Number(j.format?.duration) || undefined
    const v = j.streams?.find((s) => s.codec_type === 'video')
    if (v?.width) { meta.width = v.width; meta.height = v.height }
  } catch { /* 元数据拿不到就 -- */ }
  // 抽帧（-ss 3 跳过黑场；失败留空）
  try {
    await pexec(q(`-ss 3 -i "${path}" -vframes 1 -vf "scale=320:-2" -q:v 5 -y "${thumb}"`), { windowsHide: true, timeout: 20000 })
    if (existsSync(thumb)) meta.thumb = thumb
  } catch { /* 占位 */ }
  try { require('fs').writeFileSync(metaF, JSON.stringify(meta)) } catch { /* */ }
  return meta
}

/** 批量（并发 2，避免同时解码多个视频抢占 CPU；单个失败跳过不阻塞——红线 16） */
export async function probeVideos(files: Array<{ path: string; mtime: number }>, onDone?: (i: number, total: number) => void): Promise<Record<string, VideoMeta>> {
  const out: Record<string, VideoMeta> = {}
  const total = files.length
  for (let i = 0; i < files.length; i += 2) {
    const pair = files.slice(i, i + 2)
    const rs = await Promise.allSettled(pair.map((f) => probeVideo(f.path, f.mtime)))
    rs.forEach((r, k) => { if (r.status === 'fulfilled') out[pair[k].path] = r.value })
    onDone?.(Math.min(i + 2, total), total)
  }
  return out
}

/** 清空视频缩略图缓存（设置用） */
export function clearVideoThumbCache(): void {
  try { rmSync(cacheDir(), { recursive: true, force: true }) } catch { /* */ }
}
