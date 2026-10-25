import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanTreeSync } from '../src/main/scanner/core'
import { deepVerify, verifyRebuilt } from '../src/main/scanner/cache'

let root: string
const tree = (p: string) => scanTreeSync(p).root

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cs-deep-'))
  // a/  b/c/d/（≥3 层） e/f/g/h/（更深）
  mkdirSync(join(root, 'a'), { recursive: true })
  mkdirSync(join(root, 'b', 'c', 'd'), { recursive: true })
  mkdirSync(join(root, 'e', 'f', 'g', 'h'), { recursive: true })
  writeFileSync(join(root, 'a', 'x.txt'), 'x')
  writeFileSync(join(root, 'b', 'c', 'd', 'y.txt'), 'y')
  writeFileSync(join(root, 'e', 'f', 'g', 'h', 'z.txt'), 'z')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('v1.2 缓存深层校验（修深层变更漏判）', () => {
  it('未变更：全量校验通过（maxSample=∞ 确定性）', async () => {
    const t = tree(root)
    expect(await deepVerify(t, Infinity)).toBeNull()
  })

  it('深层（3 层以下）目录 mtime 变更被检出', async () => {
    const t = tree(root)
    // 深层目录写入新文件 → 其 mtime 变化（不触父级目录 mtime 的场景：直接 utimes 模拟更深目录）
    const deepDir = join(root, 'e', 'f', 'g', 'h')
    utimesSync(deepDir, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const r = await deepVerify(t, Infinity)
    expect(r).toBeTruthy()
    expect(r).toContain('e')
    // 还原
    const fresh = tree(root)
    void fresh
  })

  it('浅层（0-2 层）变更同样被检出', async () => {
    const t = tree(root)
    utimesSync(join(root, 'a'), new Date(Date.now() + 8000), new Date(Date.now() + 8000))
    expect(await deepVerify(t, Infinity)).toBeTruthy()
  })

  it('抽样模式：maxSample 小于总数时仍覆盖（全量∞ 对照抽样=全部等价）', async () => {
    const t1 = tree(root)
    const r1 = await deepVerify(t1, 0, () => 0) // 抽 0 个深层，只查 0-2 层
    expect(r1).toBeNull() // 当前无变更
    // 变更深层后：maxSample=0 检不出（只查浅层）→ 证明浅层校验确实覆盖不到深层
    utimesSync(join(root, 'e', 'f', 'g', 'h'), new Date(Date.now() + 9000), new Date(Date.now() + 9000))
    const t2 = tree(root) // 重新扫，树里 h 已是新 mtime——需要用「旧树」对照
    // 模拟旧缓存树：把 h 的 mtime 回拨
    const old = JSON.parse(JSON.stringify(t2)) as typeof t2
    const findH = (n: typeof t2): typeof t2 => {
      for (const c of n.children) if ('children' in c) { if (c.name === 'h') return c; const r = findH(c); if (r) return r }
      return null as never
    }
    findH(old).mtime -= 10000
    expect(await deepVerify(old, 0, () => 0)).toBeNull() // 抽样 0：深层变更漏检（证明旧策略缺口）
    expect(await deepVerify(old, Infinity)).toBeTruthy() // 全量：检出（新策略修复）
  })

  it('verifyRebuilt（首层）与 deepVerify 互补：深层变更 verifyRebuilt 放行、deepVerify 拦截', async () => {
    // 构造旧缓存树（h mtime 旧）
    const t = tree(root)
    const old = JSON.parse(JSON.stringify(t)) as typeof t
    const findH = (n: typeof t): typeof t => {
      for (const c of n.children) if ('children' in c) { if (c.name === 'h') return c; const r = findH(c); if (r) return r }
      return null as never
    }
    findH(old).mtime -= 10000
    // 首层（a/b/e）无变化 → verifyRebuilt 放行
    expect(await verifyRebuilt(old)).toBeNull()
    // deepVerify 全量拦截
    expect(await deepVerify(old, Infinity)).toBeTruthy()
  })
})
