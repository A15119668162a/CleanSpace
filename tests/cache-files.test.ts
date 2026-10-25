import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateScanCache, saveCache, loadSubtree, rebuildTree, cacheHasFileRows } from '../src/main/scanner/cache'
import { flattenForIndex } from '../src/main/search/index'
import type { DirNode } from '../src/main/scanner/core'

let db: Database.Database
let fx: string
let tree: DirNode

beforeAll(() => {
  db = new Database(':memory:')
  migrateScanCache(db)
  fx = mkdtempSync(join(tmpdir(), 'cs-cache-'))
  mkdirSync(join(fx, 'docs'), { recursive: true })
  writeFileSync(join(fx, 'docs', 'a.pdf'), 'x'.repeat(100))
  writeFileSync(join(fx, 'b.jpg'), 'y'.repeat(50))
  // 手工组树（模拟引擎产物：目录带 files）
  const docs: DirNode = {
    path: join(fx, 'docs'), name: 'docs', size: 100, mtime: Date.now(),
    children: [], files: [{ path: join(fx, 'docs', 'a.pdf'), name: 'a.pdf', size: 100, mtime: Date.now(), type: '文档' }],
    fileCount: 1, dirCount: 0
  }
  tree = {
    path: fx, name: 'root', size: 150, mtime: Date.now(),
    children: [docs],
    files: [{ path: join(fx, 'b.jpg'), name: 'b.jpg', size: 50, mtime: Date.now(), type: '图片' }],
    fileCount: 2, dirCount: 1
  }
})

afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v2.4.1 缓存文件行（索引为空根因修复）', () => {
  it('saveCache → loadSubtree：文件行在（is_dir=0）', () => {
    saveCache(db, tree)
    const rows = loadSubtree(db, fx)
    expect(rows.size).toBe(4) // root + docs（目录行）+ a.pdf + b.jpg（文件行）
    expect(cacheHasFileRows(rows)).toBe(true)
    const fileRows = [...rows.values()].filter((r) => r.is_dir === 0)
    expect(fileRows.length).toBe(2)
  })

  it('rebuildTree：树带 files（目录与文件都挂对）', () => {
    const rows = loadSubtree(db, fx)
    const t = rebuildTree(rows, fx)
    expect(t).toBeTruthy()
    expect(t!.files?.length).toBe(1) // b.jpg
    expect(t!.children[0].files?.length).toBe(1) // docs/a.pdf
    expect(t!.files![0].name).toBe('b.jpg')
    expect(t!.children[0].files![0].type).toBe('文档')
  })

  it('缓存重建的树 → flattenForIndex 能产出索引行（端到端闭环）', () => {
    const rows = loadSubtree(db, fx)
    const t = rebuildTree(rows, fx)!
    const idx = flattenForIndex(t as never, fx)
    expect(idx.length).toBe(2)
    expect(idx.some((i) => i.name === 'a.pdf' && i.type === '文档')).toBe(true)
    expect(idx.some((i) => i.name === 'b.jpg' && i.type === '图片')).toBe(true)
  })

  it('旧格式缓存（无文件行）被识别 → 引擎将全量重扫', () => {
    const fake = new Map([['c:/x', { path: 'c:/x', root_path: 'c:/x', mtime: 1, size: 1, is_dir: 1, file_count: 1, dir_count: 0, parent: null }]])
    expect(cacheHasFileRows(fake)).toBe(false)
  })
})
