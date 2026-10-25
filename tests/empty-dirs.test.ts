import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanEmptyDirs, deleteEmptyDirs } from '../src/main/cleaner/emptyDirs'
import { BUILTIN_WHITELIST } from '../src/shared/whitelist'

const wl = BUILTIN_WHITELIST.map((w, i) => ({ id: i + 1, pattern: w.pattern, enabled: true, builtin: true, note: w.note }))

let root: string
let realDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cs-empty-'))
  // ① 嵌套空树 a/b/c（三层全空）
  mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
  // ② 准空目录：仅 Thumbs.db
  const quasi = join(root, 'quasi')
  mkdirSync(quasi, { recursive: true })
  writeFileSync(join(quasi, 'Thumbs.db'), 'x')
  // ③ 有真实文件的目录（绝不能出现）
  realDir = join(root, 'real')
  mkdirSync(realDir, { recursive: true })
  writeFileSync(join(realDir, 'data.txt'), 'content')
  // ④ 占位目录（OneDrive 命名——跳过）
  mkdirSync(join(root, 'OneDrive'), { recursive: true })
  // ⑤ 父有文件、子空的情形（子应出现、父不出现）
  mkdirSync(join(root, 'parent', 'emptychild'), { recursive: true })
  writeFileSync(join(root, 'parent', 'keep.txt'), 'keep')
  // ⑥ .git 跳过
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('v2.0 空文件夹清理（F2）', () => {
  it('识别：嵌套空树 + 父有文件子空；不含真实文件目录/占位/.git', async () => {
    const r = await scanEmptyDirs(root, wl, false)
    const paths = r.dirs.map((d) => d.path)
    // 嵌套空树三层都算
    expect(paths.some((p) => p.endsWith(join('a', 'b', 'c')))).toBe(true)
    expect(paths.some((p) => p.endsWith(join('a', 'b')))).toBe(true)
    // 准空（默认关）不出现
    expect(paths.some((p) => p.endsWith('quasi'))).toBe(false)
    // 真实文件目录绝不出现（红线 13）
    expect(paths.some((p) => p.endsWith('real'))).toBe(false)
    expect(paths.some((p) => p.endsWith('parent'))).toBe(false)
    // 子空出现
    expect(paths.some((p) => p.endsWith('emptychild'))).toBe(true)
    // 占位/.git 跳过
    expect(paths.some((p) => p.includes('onedrive'))).toBe(false)
    expect(paths.some((p) => p.includes('.git'))).toBe(false)
  })

  it('includeQuasi=true 时准空目录出现且带 quasi 标记', async () => {
    const r = await scanEmptyDirs(root, wl, true)
    const q = r.dirs.find((d) => d.path.endsWith('quasi'))
    expect(q?.quasi).toBe(true)
    expect(q?.fileCount).toBe(1)
  })

  it('红线 13 强化：任何含真实文件的目录绝不在清单', async () => {
    const r = await scanEmptyDirs(root, wl, true)
    const paths = r.dirs.map((d) => d.path)
    for (const p of paths) {
      expect(p.endsWith('real')).toBe(false)
      expect(p.endsWith('parent')).toBe(false)
    }
    // 空树根 a 无文件——应在清单（合规）
    expect(paths.some((p) => p.endsWith('\\a') || p.endsWith('/a'))).toBe(true)
  })

  it('执行：自底向上删干净，被占用/异常不中断逐项报告', async () => {
    const r = await scanEmptyDirs(root, wl, true)
    const res = await deleteEmptyDirs(r.dirs.map((d) => d.path))
    expect(res.ok).toBe(r.dirs.length)
    expect(res.fail.length).toBe(0)
    // 验证全删
    expect(existsSync(join(root, 'a'))).toBe(false)
    expect(existsSync(join(root, 'quasi'))).toBe(false)
    // 真实文件目录仍在
    expect(existsSync(realDir)).toBe(true)
    expect(existsSync(join(root, 'parent', 'keep.txt'))).toBe(true)
  })

  it('删除后再扫：清单为空', async () => {
    const r = await scanEmptyDirs(root, wl, true)
    // parent/emptychild 已删；剩 real/parent(有文件)/OneDrive(跳过)/.git(跳过) → 无空目录
    expect(r.dirs.length).toBe(0)
  })
})
