import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readExifTime } from '../src/main/media/exif'

let fx: string

/** 构造最小 JPEG+EXIF（APP1 含 DateTimeOriginal） */
function makeExifJpeg(path: string, dt: string): void {
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
  const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255]
  const u32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]

  // 布局（TIFF 相对偏移）：
  // 0..7   TIFF 头（II 42 @8）
  // 8      IFD0：count=1，entry(0x8769 ptr→26)，next=0 → 占 2+12+4=18，故 ExifIFD 起 26
  // 26     ExifIFD：count=1，entry(0x9003 ASCII count=20，valueOffset→40)，40 起为值区
  const ifd0Off = 8
  const exifIfdOff = ifd0Off + 2 + 12 + 4 // 26
  const dtValOff = exifIfdOff + 2 + 12 // 40
  const dtBytes = ascii(dt + '\x00') // 20 字节

  const ifd0 = [
    ...u16(1),                                // 1 entry
    ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfdOff), // ExifIFD 指针
    ...u32(0)                                 // next IFD = 0
  ]
  const exifIfd = [
    ...u16(1),                                // 1 entry
    ...u16(0x9003), ...u16(2), ...u32(dtBytes.length), ...u32(dtValOff)
  ]
  const tiff = [...ascii('II'), ...u16(42), ...u32(ifd0Off), ...ifd0, ...exifIfd, ...dtBytes]
  const payload = [...ascii('Exif\x00\x00'), ...tiff]
  const seg = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]
  writeFileSync(path, Buffer.from([0xff, 0xd8, ...seg, 0xff, 0xd9]))
}

beforeAll(() => {
  fx = mkdtempSync(join(tmpdir(), 'cs-exif-'))
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v3.0 G1 EXIF 时间解析（红线 20：只读）', () => {
  it('标准 EXIF DateTimeOriginal 正确解析', async () => {
    const p = join(fx, 'a.jpg')
    makeExifJpeg(p, '2024:03:15 10:30:00')
    const r = await readExifTime(p)
    expect(r.ts).toBeTruthy()
    const d = new Date(r.ts!)
    expect(d.getFullYear()).toBe(2024)
    expect(d.getMonth()).toBe(2) // 3 月
    expect(d.getDate()).toBe(15)
    expect(d.getHours()).toBe(10)
    expect(r.source).toBe('DateTimeOriginal')
  })

  it('无 EXIF 的普通 JPEG → ts null（前端按文件时间归位标 ≈）', async () => {
    const p = join(fx, 'plain.jpg')
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const r = await readExifTime(p)
    expect(r.ts).toBeNull()
  })

  it('损坏/非 JPEG → ts null 不抛异常', async () => {
    const p = join(fx, 'broken.jpg')
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    const r = await readExifTime(p)
    expect(r.ts).toBeNull()
    const p2 = join(fx, 'nothere.jpg')
    const r2 = await readExifTime(p2)
    expect(r2.ts).toBeNull()
  })

  it('红线 20：解析后源文件字节与 mtime 完全不变', async () => {
    const p = join(fx, 'ro.jpg')
    makeExifJpeg(p, '2023:12:01 08:00:00')
    const before = readFileSync(p)
    const stBefore = statSync(p)
    await readExifTime(p)
    await readExifTime(p)
    const after = readFileSync(p)
    expect(before.equals(after)).toBe(true)
    expect(statSync(p).mtimeMs).toBe(stBefore.mtimeMs)
  })

  it('闰年 2-29 正确', async () => {
    const p = join(fx, 'leap.jpg')
    makeExifJpeg(p, '2024:02:29 23:59:59')
    const r = await readExifTime(p)
    expect(new Date(r.ts!).getDate()).toBe(29)
  })
})
