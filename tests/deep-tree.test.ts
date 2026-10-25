import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rebuildTree, type CacheRow } from '../src/main/scanner/cache'
import { topDirs } from '../src/main/scanner/core'

let db: Database.Database
let fx: string
beforeAll(() => {
  db = new Database(':memory:')
  fx = mkdtempSync(join(tmpdir(), 'cs-deep-'))
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

/** 构造 5000 层深的缓存行（不用真文件系统——直接喂 Map，只测树逻辑） */
function deepRows(depth: number): Map<string, CacheRow> {
  const rows = new Map<string, CacheRow>()
  const root = 'C:/deep'
  rows.set(root.toLowerCase(), { path: root, parent: null, mtime: 0, size: 0, is_dir: 1, file_count: 0, dir_count: 0 } as unknown as CacheRow)
  let prev = root
  for (let i = 1; i <= depth; i++) {
    const p = `${root}/d${i}`
    rows.set(p.toLowerCase(), { path: p, parent: prev, mtime: 0, size: i, is_dir: 1, file_count: 0, dir_count: 0 } as unknown as CacheRow)
    prev = p
  }
  return rows
}

describe('v4.2.6 扫描爆栈修复（深目录树迭代化）', () => {
  it('rebuildTree：5000 层深链不爆栈且完整', () => {
    const t = rebuildTree(deepRows(5000), 'C:/deep')
    expect(t).toBeTruthy()
    // 数层数
    let n = t!, d = 0
    while (n.children.length > 0) { n = n.children[0]; d++ }
    expect(d).toBe(5000)
  })

  it('rebuildTree：缓存环（junction 历史残留）不死循环', () => {
    const rows = deepRows(3)
    // 制造环：d3 的 parent 指回 d1
    rows.set('c:/deep/d3'.toLowerCase(), { path: 'C:/deep/d3', parent: 'C:/deep/d1', mtime: 0, size: 3, is_dir: 1, file_count: 0, dir_count: 0 } as never)
    // d1 已在 d3 的 children（parent=d1 的都挂 d1 下）→ d3 会挂到 d1 下两次？visited 拦截
    const t = rebuildTree(rows, 'C:/deep')
    expect(t).toBeTruthy() // 不死循环即通过
  })

  it('topDirs：5000 层不爆栈', () => {
    // 用 rebuildTree 产物
    const tree = rebuildTree(deepRows(4000), 'C:/deep')!
    const top = topDirs(tree, 20)
    expect(top.length).toBe(20)
  })
})

import { flattenTree } from '../src/main/health/snapshots'
import { flattenForIndex } from '../src/main/search/index'

describe('v4.2.6 persist 链爆栈（C 盘 30 万目录真因）', () => {
  it('flattenTree：5000 层不爆栈', () => {
    const tree = rebuildTree(deepRows(5000), 'C:/deep')!
    const rows = flattenTree(tree)
    expect(rows.length).toBe(5001)
  })
  it('flattenForIndex：5000 层不爆栈', () => {
    const tree = rebuildTree(deepRows(5000), 'C:/deep')!
    const rows = flattenForIndex(tree, 'C:/deep')
    expect(Array.isArray(rows)).toBe(true)
  })
})
