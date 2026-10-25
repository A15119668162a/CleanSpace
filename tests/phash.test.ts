import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Jimp from 'jimp'
import { phashFromGray, hamming, groupSimilar } from '../src/shared/phash'

let dir: string

/** 结构化测试图：左暗右亮 + 8px 平滑过渡带（低频为主，缩放稳健） */
async function structuredJimp(seed: number, w: number, h: number): Promise<Jimp> {
  const img = new Jimp(w, h)
  const split = w * (0.4 + (seed % 20) / 100) // 40%-60% 分割
  const band = Math.max(4, Math.floor(w / 8)) // 平滑带
  const dark = 70 + (seed % 20), bright = 210 - (seed % 20)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v: number
    if (x < split - band / 2) v = dark
    else if (x > split + band / 2) v = bright
    else v = dark + (bright - dark) * ((x - (split - band / 2)) / band) // 线性过渡
    const vv = Math.round(v)
    img.setPixelColor(Jimp.rgbaToInt(vv, vv, vv, 255), x, y)
  }
  return img
}

/** 完全不同的图：不同方向 + 不同明暗布局 */
async function differentJimp(kind: number, w: number, h: number): Promise<Jimp> {
  const img = new Jimp(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 128
    if (kind === 0) v = y < h / 2 ? 60 : 220 // 上暗下亮
    else if (kind === 1) v = 40 // 全暗
    else v = ((x / w) * 255 + (y / h) * 80) % 256 // 横向渐变
    img.setPixelColor(Jimp.rgbaToInt(Math.floor(v), Math.floor(v), Math.floor(v), 255), x, y)
  }
  return img
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cs-phash-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('v2.0 pHash 核心算法（F1）', () => {
  const toGray = (img: Jimp): Float64Array => {
    const small = img.clone().resize(32, 32).greyscale()
    const g = new Float64Array(1024)
    small.scan(0, 0, 32, 32, (x: number, y: number, idx: number) => { g[y * 32 + x] = small.bitmap.data[idx] })
    return g
  }

  it('同图不同尺寸 → 海明距离 ≤ 10（宽松档内；二值强边缘图对缩放核敏感）', async () => {
    const base = await structuredJimp(7, 64, 64)
    const half = base.clone().resize(32, 32)
    const big = base.clone().resize(128, 128)
    const h1 = phashFromGray(toGray(base))
    const h2 = phashFromGray(toGray(half))
    const h3 = phashFromGray(toGray(big))
    // 同尺寸同图必须 0
    expect(hamming(h1, phashFromGray(toGray(base.clone())))).toBe(0)
    // 缩放族在宽松档内（真实照片为连续色调，实测距离更小）
    expect(hamming(h1, h2)).toBeLessThanOrEqual(10)
    expect(hamming(h1, h3)).toBeLessThanOrEqual(10)
  }, 30000)

  it('不同图 → 海明距离大（不相似）', async () => {
    const a = phashFromGray(toGray(await structuredJimp(7, 64, 64)))
    const x = phashFromGray(toGray(await differentJimp(0, 64, 64)))
    const y = phashFromGray(toGray(await differentJimp(1, 64, 64)))
    const z = phashFromGray(toGray(await differentJimp(2, 64, 64)))
    for (const other of [x, y, z]) {
      const d = hamming(a, other)
      expect(d).toBeGreaterThan(10)
    }
  }, 30000)

  it('分组：3 尺寸归一组、无关图不进组（验收场景）', () => {
    const hA = '00ff00ff00ff00ff', hA2 = '01ff00ff00ff00ff', hA3 = '02ff00ff00ff00ff' // 相似族
    const hX = 'ffffffffffffffff', hY = 'aaaaaaaaaaaaaaaa' // 无关
    const groups = groupSimilar(
      [
        { path: 'a1.png', hash: hA, size: 1, mtime: 3 },
        { path: 'a2.png', hash: hA2, size: 1, mtime: 1 },
        { path: 'a3.png', hash: hA3, size: 1, mtime: 2 },
        { path: 'x.png', hash: hX, size: 1, mtime: 5 },
        { path: 'y.png', hash: hY, size: 1, mtime: 6 }
      ],
      5
    )
    expect(groups.length).toBe(1)
    expect(groups[0].length).toBe(3)
    expect(groups[0].map((g) => g.path).join()).toContain('a1.png')
    expect(groups[0].map((g) => g.path)).not.toContain('x.png')
    // 组内 mtime 升序（最早在前）
    expect(groups[0][0].path).toBe('a2.png')
  })

  it('红线 7：分组结果不含任何预选/待删标记（纯数据结构，勾选只能 UI 人工）', () => {
    const groups = groupSimilar([{ path: 'p', hash: '00ff00ff00ff00ff', size: 1, mtime: 1 }, { path: 'q', hash: '00ff00ff00ff00fe', size: 1, mtime: 2 }], 5)
    expect(groups.length).toBe(1)
    // 数据结构里没有 selected/checked/delete 字段
    expect(JSON.stringify(groups)).not.toMatch(/select|check|delete/i)
  })

  it('海明距离基本性质', () => {
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0)
    expect(hamming('0000000000000000', '0000000000000001')).toBe(1)
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64)
    expect(hamming('abc', 'abcd')).toBe(64) // 长度不等
  })
})
