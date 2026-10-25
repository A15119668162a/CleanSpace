/**
 * EXIF 时间解析（v3.0 / G1 相册时间线）
 * 纯 JS 解析 JPEG APP1 段的 DateTimeOriginal / DateTime（无需 exif 库）
 * 红线 20：只读——绝不写回文件
 * Worker 线程跑（本文件被 worker-exif.js 引用）
 */
import { readFile } from 'fs/promises'

export interface ExifTime {
  /** 毫秒时间戳；null=无 EXIF 或损坏 */
  ts: number | null
  /** 原始字符串 'YYYY:MM:DD HH:MM:SS' */
  raw?: string
  /** 用了哪个字段 */
  source?: 'DateTimeOriginal' | 'DateTime'
}

/** 读 JPEG APP1 里的 EXIF DateTimeOriginal(0x9003)/DateTime(0x0132) */
export async function readExifTime(path: string): Promise<ExifTime> {
  let buf: Buffer
  try {
    // 只读头部 128KB（EXIF 段在前部；超大照片也够）
    const fh = await openHead(path, 128 * 1024)
    if (!fh) return { ts: null }
    buf = fh
  } catch {
    return { ts: null }
  }
  // JPEG 魔数
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { ts: null }
  // 段遍历找 APP1/Exif
  let off = 2
  let tiff: number = -1
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break
    const marker = buf[off + 1]
    if (marker === 0xda || marker === 0xd9) break // SOS/EOI 后无 EXIF
    const size = buf.readUInt16BE(off + 2)
    if (marker === 0xe1 && size > 8) {
      // APP1：检查 "Exif\0\0"
      const head = buf.toString('ascii', off + 4, off + 10)
      if (head === 'Exif\x00\x00') {
        tiff = off + 10
        break
      }
    }
    off += 2 + size
  }
  if (tiff < 0 || tiff + 8 > buf.length) return { ts: null }
  // TIFF 头：II/MM 字节序
  const bom = buf.toString('ascii', tiff, tiff + 2)
  const le = bom === 'II'
  if (!le && bom !== 'MM') return { ts: null }
  const u16 = (p: number): number => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p))
  const u32 = (p: number): number => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p))
  const ifd0 = tiff + u32(tiff + 4)
  if (ifd0 + 2 > buf.length) return { ts: null }

  // 遍历 IFD 找 ExifIFD 指针(0x8769) 与 DateTime(0x0132)
  const entries0 = u16(ifd0)
  let exifIfd = -1
  let dateTimeOff = -1
  for (let i = 0; i < entries0 && ifd0 + 2 + i * 12 + 12 <= buf.length; i++) {
    const e = ifd0 + 2 + i * 12
    const tag = u16(e)
    if (tag === 0x8769) exifIfd = tiff + u32(e + 8)
    if (tag === 0x0132) dateTimeOff = e
  }
  // DateTimeOriginal 只在 ExifIFD
  const tryIfd = (ifd: number): { org: number; dt: number } => {
    let org = -1, dt = -1
    if (ifd < 0 || ifd + 2 > buf.length) return { org, dt }
    const n = u16(ifd)
    for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= buf.length; i++) {
      const e = ifd + 2 + i * 12
      const tag = u16(e)
      if (tag === 0x9003) org = e
      if (tag === 0x0132) dt = e
    }
    return { org, dt }
  }
  const exifRes = tryIfd(exifIfd)
  // 读取 ASCII 值（VALUE_OFFSET 相对 TIFF 头）
  const readAscii = (entry: number): string => {
    const count = u32(entry + 4)
    const vo = count <= 4 ? entry + 8 : tiff + u32(entry + 8)
    if (vo < 0 || vo + count > buf.length) return ''
    return buf.toString('ascii', vo, vo + count).replace(/\x00+$/, '').trim()
  }
  const parse = (raw: string): number | null => {
    // 'YYYY:MM:DD HH:MM:SS' → 时间戳
    const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
    if (!m) return null
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
    return Number.isFinite(t) ? t : null
  }
  // 优先 DateTimeOriginal
  if (exifRes.org >= 0) {
    const raw = readAscii(exifRes.org)
    const ts = parse(raw)
    if (ts !== null) return { ts, raw, source: 'DateTimeOriginal' }
  }
  const dtEntry = exifRes.dt >= 0 ? exifRes.dt : dateTimeOff
  if (dtEntry >= 0) {
    const raw = readAscii(dtEntry)
    const ts = parse(raw)
    if (ts !== null) return { ts, raw, source: 'DateTime' }
  }
  return { ts: null }
}

/* ================= v3.6 GPS（红线 20 延伸：只读） ================= */
export interface GpsPos { lat: number; lon: number }

/** 读 JPEG EXIF GPS（IFD0 0x8825 指针 → GPS IFD：1/2/3/4 号 tag） */
export async function readExifGps(path: string): Promise<GpsPos | null> {
  let buf: Buffer
  try {
    const fh = await openHead(path, 128 * 1024)
    if (!fh) return null
    buf = fh
  } catch { return null }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let off = 2
  let tiff = -1
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break
    const marker = buf[off + 1]
    if (marker === 0xda || marker === 0xd9) break
    const size = buf.readUInt16BE(off + 2)
    if (marker === 0xe1 && size > 8 && buf.toString('ascii', off + 4, off + 10) === 'Exif\x00\x00') { tiff = off + 10; break }
    off += 2 + size
  }
  if (tiff < 0 || tiff + 8 > buf.length) return null
  const bom = buf.toString('ascii', tiff, tiff + 2)
  const le = bom === 'II'
  if (!le && bom !== 'MM') return null
  const u16 = (p: number): number => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p))
  const u32 = (p: number): number => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p))
  // IFD0 找 GPSIFD 指针 0x8825
  const ifd0 = tiff + u32(tiff + 4)
  if (ifd0 + 2 > buf.length) return null
  const n0 = u16(ifd0)
  let gpsIfd = -1
  for (let i = 0; i < n0 && ifd0 + 2 + i * 12 + 12 <= buf.length; i++) {
    const e = ifd0 + 2 + i * 12
    if (u16(e) === 0x8825) { gpsIfd = tiff + u32(e + 8); break }
  }
  if (gpsIfd < 0 || gpsIfd + 2 > buf.length) return null
  // GPS IFD：1=纬度N/S(ASCII) 2=纬度(rational×3) 3=经度E/W 4=经度(rational×3)
  let latRef = 'N', lonRef = 'E'
  let latVal: number | null = null
  let lonVal: number | null = null
  const ng = u16(gpsIfd)
  const rational = (entry: number): number | null => {
    const count = u32(entry + 4)
    if (count !== 3) return null
    const base = tiff + u32(entry + 8)
    if (base + 24 > buf.length) return null
    const comp = (i: number): number => {
      const num = u32(base + i * 8)
      const den = u32(base + i * 8 + 4)
      return den === 0 ? 0 : num / den
    }
    return comp(0) + comp(1) / 60 + comp(2) / 3600
  }
  for (let i = 0; i < ng && gpsIfd + 2 + i * 12 + 12 <= buf.length; i++) {
    const e = gpsIfd + 2 + i * 12
    const tag = u16(e)
    if (tag === 1) {
      const cnt = u32(e + 4)
      const vo = cnt <= 4 ? e + 8 : tiff + u32(e + 8)
      latRef = buf.toString('ascii', vo, vo + 1) || 'N'
    } else if (tag === 2) latVal = rational(e)
    else if (tag === 3) {
      const cnt = u32(e + 4)
      const vo = cnt <= 4 ? e + 8 : tiff + u32(e + 8)
      lonRef = buf.toString('ascii', vo, vo + 1) || 'E'
    } else if (tag === 4) lonVal = rational(e)
  }
  if (latVal === null || lonVal === null) return null
  const lat = latRef === 'S' ? -latVal : latVal
  const lon = lonRef === 'W' ? -lonVal : lonVal
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) }
}

/** 邻近聚类（dkm 公里内为一组；haversine） */
export function clusterGeo(points: Array<{ lat: number; lon: number; path: string }>, dkm = 3): Array<{ lat: number; lon: number; items: string[] }> {
  const R = 6371
  const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
    const dLat = (b.lat - a.lat) * Math.PI / 180
    const dLon = (b.lon - a.lon) * Math.PI / 180
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(s))
  }
  const used = new Set<string>()
  const out: Array<{ lat: number; lon: number; items: string[] }> = []
  for (const p of points) {
    if (used.has(p.path)) continue
    const g = { lat: p.lat, lon: p.lon, items: [p.path] }
    used.add(p.path)
    for (const q of points) {
      if (used.has(q.path)) continue
      if (dist(p, q) <= dkm) { g.items.push(q.path); used.add(q.path) }
    }
    out.push(g)
  }
  return out.sort((a, b) => b.items.length - a.items.length)
}

/** 读文件头 N 字节（不整读大文件） */
async function openHead(path: string, n: number): Promise<Buffer | null> {
  const { open } = await import('fs/promises')
  const fh = await open(path, 'r')
  try {
    const b = Buffer.alloc(n)
    const { bytesRead } = await fh.read(b, 0, n, 0)
    return b.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}
