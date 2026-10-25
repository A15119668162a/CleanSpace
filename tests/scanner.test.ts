import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanTree, classifyFile, topDirs, toSunburst } from '../src/main/scanner/core'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cs-test-'))
  // 结构：
  // root/
  //   big/  a.bin(1000) b.mp4(500)
  //   sub/deep/  c.txt(10)
  //   d.docx(100) e.zip(50) link→不测符号链接（Windows 权限复杂）
  mkdirSync(join(root, 'big'))
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(root, 'big', 'a.bin'), Buffer.alloc(1000))
  writeFileSync(join(root, 'big', 'b.mp4'), Buffer.alloc(500))
  writeFileSync(join(root, 'sub', 'deep', 'c.txt'), 'hello'
  )
  writeFileSync(join(root, 'd.docx'), Buffer.alloc(100))
  writeFileSync(join(root, 'e.zip'), Buffer.alloc(50))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('classifyFile', () => {
  it('各类型', () => {
    expect(classifyFile('a.MP4')).toBe('视频')
    expect(classifyFile('b.jpeg')).toBe('图片')
    expect(classifyFile('c.mp3')).toBe('音频')
    expect(classifyFile('d.docx')).toBe('文档')
    expect(classifyFile('e.7z')).toBe('压缩包')
    expect(classifyFile('f.exe')).toBe('安装包')
    expect(classifyFile('g.ts')).toBe('代码')
    expect(classifyFile('noext')).toBe('其他')
    expect(classifyFile('.gitignore')).toBe('其他')
  })
})

describe('scanTree', () => {
  it('聚合 size / fileCount / dirCount 与实际一致', async () => {
    const r = await scanTree(root)
    expect(r.stats.totalFiles).toBe(5)
    expect(r.stats.totalDirs).toBe(3) // big, sub, sub/deep
    expect(r.stats.totalBytes).toBe(1655)
    expect(r.root.size).toBe(1655)
    expect(r.root.fileCount).toBe(5)
    expect(r.root.dirCount).toBe(3)

    const big = r.root.children.find((c) => 'children' in c && c.name === 'big') as typeof r.root
    expect(big.size).toBe(1500)
    expect(big.dirCount).toBe(0)

    const sub = r.root.children.find((c) => 'children' in c && c.name === 'sub') as typeof r.root
    expect(sub.size).toBe(5)
    expect(sub.dirCount).toBe(1)
  })

  it('TOP-N 大文件按 size 降序', async () => {
    const r = await scanTree(root, { topN: 3 })
    expect(r.topFiles.length).toBe(3)
    expect(r.topFiles[0].path.endsWith('a.bin')).toBe(true)
    expect(r.topFiles.map((f) => f.size)).toEqual([1000, 500, 100])
  })

  it('类型统计', async () => {
    const r = await scanTree(root)
    expect(r.stats.typeBytes['视频']).toBe(500)
    expect(r.stats.typeBytes['文档']).toBe(105) // d.docx(100) + c.txt(5)
    expect(r.stats.typeBytes['安装包']).toBeUndefined() // .bin 是其他
    expect(r.stats.typeFiles['其他']).toBe(1)
  })

  it('不存在目录抛错', async () => {
    await expect(scanTree(join(root, 'nope'))).rejects.toThrow()
  })
})

describe('topDirs / toSunburst', () => {
  it('topDirs 排序正确', async () => {
    const r = await scanTree(root)
    const dirs = topDirs(r.root, 2)
    expect(dirs[0].name).toBe('big')
    expect(dirs.length).toBe(2)
  })

  it('toSunburst 保留层级与聚合', async () => {
    const r = await scanTree(root)
    const s = toSunburst(r.root, 0)
    expect(s.name).toBeTruthy()
    expect(s.children!.length).toBeGreaterThanOrEqual(3) // big, sub, d.docx, e.zip
    const small = toSunburst(r.root, 400)
    const flat = JSON.stringify(small)
    expect(flat).toContain('较小项')
  })
})

describe('mtime 捕获', () => {
  it('目录与文件 mtime 均为数值', async () => {
    const t = Date.now()
    utimesSync(join(root, 'd.docx'), new Date(t - 5000), new Date(t - 5000))
    const r = await scanTree(root)
    const d = r.root.children.find((c) => !('children' in c) && c.path.endsWith('d.docx')) as { mtime: number }
    expect(d.mtime).toBeGreaterThan(0)
    expect(r.root.mtime).toBeGreaterThan(0)
  })
})
