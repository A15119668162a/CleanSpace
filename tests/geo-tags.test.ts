import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readExifGps, clusterGeo } from '../src/main/media/exif'
import { tagAdd, tagRemove, tagsOf, tagStats, byTag } from '../src/main/media/tags'

let db: Database.Database
let fx: string

/** 构造含 GPS 的最小 JPEG（IFD0: GPSIFD 指针 → GPS IFD 四 tag） */
function makeGpsJpeg(path: string, latDeg: [number, number, number], lonDeg: [number, number, number], latRef = 'N', lonRef = 'E'): void {
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
  const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255]
  const u32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]
  const rat = (num: number, den: number): number[] => [...u32(num), ...u32(den)]
  // 布局：TIFF8 | IFD0(count1+entry12+next4=18) | GPSIFD(count4+entry48=50) | 值区
  const gpsIfdOff = 8 + 18
  const valOff = gpsIfdOff + 50
  const latValOff = valOff
  const lonValOff = valOff + 24
  // entry：ASCII 且 count≤4 → 值内联（ref 字符+\0 填充 4 字节）；否则外置偏移
  const entry = (tag: number, type: number, count: number, inlineVal: string | number): number[] => {
    const head = [...u16(tag), ...u16(type), ...u32(count)]
    if (typeof inlineVal === 'string') {
      const b = [...ascii(inlineVal).slice(0, 4), ...Array(4).fill(0)].slice(0, 4)
      return [...head, ...b]
    }
    return [...head, ...u32(inlineVal)]
  }
  // 简化：ASCII ref（count=2 含 \0）值内联；rational 全外置
  const ifd0 = [
    ...u16(1),
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsIfdOff),
    ...u32(0)
  ]
  const gps = [
    ...u16(4),
    ...entry(1, 2, 2, latRef),
    ...entry(2, 5, 3, latValOff),
    ...entry(3, 2, 2, lonRef),
    ...entry(4, 5, 3, lonValOff)
  ]
  const latR = [...rat(latDeg[0], 1), ...rat(latDeg[1] * 10000, 10000), ...rat(latDeg[2] * 10000, 10000)]
  const lonR = [...rat(lonDeg[0], 1), ...rat(lonDeg[1] * 10000, 10000), ...rat(lonDeg[2] * 10000, 10000)]
  const tiff = [...ascii('II'), ...u16(42), ...u32(8), ...ifd0, ...gps, ...latR, ...lonR]
  const payload = [...ascii('Exif\x00\x00'), ...tiff]
  writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload, 0xff, 0xd9]))
}

beforeAll(() => {
  db = new Database(':memory:')
  fx = mkdtempSync(join(tmpdir(), 'cs-gps-'))
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v3.6 EXIF 地点（红线 20 只读）', () => {
  it('GPS 解析：北京天安门 39°54\'26"N 116°23\'29"E', async () => {
    const p = join(fx, 'bj.jpg')
    makeGpsJpeg(p, [39, 54, 26], [116, 23, 29])
    const g = await readExifGps(p)
    expect(g).toBeTruthy()
    expect(Math.abs(g!.lat - 39.9072)).toBeLessThan(0.001)
    expect(Math.abs(g!.lon - 116.3911)).toBeLessThan(0.001)
  })

  it('南纬/西经符号正确', async () => {
    const p = join(fx, 'sw.jpg')
    makeGpsJpeg(p, [33, 52, 0], [151, 12, 0], 'S', 'W')
    const g = await readExifGps(p)
    expect(g!.lat).toBeLessThan(0)
    expect(g!.lon).toBeLessThan(0)
  })

  it('无 GPS JPEG → null', async () => {
    const p = join(fx, 'nogps.jpg')
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(await readExifGps(p)).toBeNull()
  })

  it('聚类：3km 内归组、远处分开', () => {
    const pts = [
      { lat: 39.90, lon: 116.39, path: 'a' },
      { lat: 39.905, lon: 116.395, path: 'b' },   // ~700m → 同组
      { lat: 39.91, lon: 116.40, path: 'c' },     // ~1.4km+2km? 约 2.6km 内
      { lat: 31.23, lon: 121.47, path: 'd' }      // 上海 → 另一组
    ]
    const g = clusterGeo(pts, 3)
    expect(g.length).toBe(2)
    expect(g[0].items.length).toBe(3)
    expect(g.find((x) => x.items.includes('d'))!.items.length).toBe(1)
  })
})

describe('v3.6 媒体标签', () => {
  it('增删查往返 + 统计 + 按标签取', () => {
    expect(tagAdd(db, 'C:/a.jpg', '旅行')).toBe(true)
    expect(tagAdd(db, 'C:/a.jpg', '家人')).toBe(true)
    expect(tagAdd(db, 'C:/b.jpg', '旅行')).toBe(true)
    expect(tagAdd(db, 'C:/a.jpg', '旅行')).toBe(true) // 幂等
    expect(tagsOf(db, 'C:/a.jpg').sort()).toEqual(['家人', '旅行'])
    const st = tagStats(db)
    expect(st.find((s) => s.tag === '旅行')!.count).toBe(2)
    expect(byTag(db, '旅行').length).toBe(2)
    tagRemove(db, 'C:/a.jpg', '旅行')
    expect(tagsOf(db, 'C:/a.jpg')).toEqual(['家人'])
    // 空标签拒绝
    expect(tagAdd(db, 'C:/a.jpg', '   ')).toBe(false)
  })
})
