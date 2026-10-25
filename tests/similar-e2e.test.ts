import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Jimp from 'jimp'
import { findSimilar } from '../src/main/scanner/similar'
import { BUILTIN_WHITELIST } from '../src/shared/whitelist'

const wl = BUILTIN_WHITELIST.map((w, i) => ({ id: i + 1, pattern: w.pattern, enabled: true, builtin: true, note: w.note }))

let fx: string
const J = Jimp as unknown as typeof import('jimp')

beforeAll(async () => {
  fx = mkdtempSync(join(tmpdir(), 'cs-sim-'))
  // a1：结构化照片样图；a2：a1 的字节级副本（distance 必 0）；c：不同结构图
  const img = new J(256, 256)
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const base = x < 115 ? 75 : 205
    const yGrad = Math.sin((y / 256) * Math.PI) * 18
    const xRipple = Math.sin((x / 256) * Math.PI * 2) * 12
    const v = Math.max(0, Math.min(255, Math.round(base + yGrad + xRipple)))
    img.setPixelColor(J.rgbaToInt(v, v, v, 255), x, y)
  }
  await img.writeAsync(join(fx, 'a1.png'))
  const { copyFileSync } = await import('fs')
  copyFileSync(join(fx, 'a1.png'), join(fx, 'a2.png')) // 完全相同（多备份场景）
  const b = new J(256, 256)
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = Math.round(30 + ((x + y) % 32) * 6)
    b.setPixelColor(J.rgbaToInt(v, v, v, 255), x, y)
  }
  await b.writeAsync(join(fx, 'b.png'))
}, 60000)
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v2.0 相似图片端到端（worker 真实解码）', () => {
  it('相同图归组、不同图不进组；缩略图生成（端到端：worker 真实解码）', async () => {
    for (const n of ['a1.png', 'a2.png', 'b.png']) {
      const p = join(fx, n)
      expect(existsSync(p)).toBe(true)
      console.log(n, statSync(p).size, 'bytes')
    }
    const r = await findSimilar(fx, 5, wl)
    expect(r.hashed).toBe(3)
    console.log('groups:', JSON.stringify(r.groups.map((g) => g.map((f) => f.path.split('\\').pop()))))
    // a1/a2 字节级相同 → 必归组（distance=0）；b 不进组
    const g = r.groups.find((x) => x.length === 2 && x.every((f) => /a[12]\.png$/.test(f.path)))
    expect(g).toBeTruthy()
    expect(Object.keys(r.thumbs).length).toBe(3)
  }, 120000)
})
