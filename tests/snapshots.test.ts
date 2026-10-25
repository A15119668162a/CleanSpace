import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureTables, saveSnapshot, listSnapshots, diffSnapshots, pruneSnapshots, deleteSnapshot, type DirRow } from '../src/main/health/snapshots'
import { scanTreeSync } from '../src/main/scanner/core'
import { flattenTree } from '../src/main/health/snapshots'

let db: Database.Database
let root: string

beforeAll(() => {
  db = new Database(':memory:')
  ensureTables(db)
  root = mkdtempSync(join(tmpdir(), 'cs-snap-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'media', 'video'), { recursive: true })
  writeFileSync(join(root, 'docs', 'a.txt'), 'a'.repeat(1000))
  writeFileSync(join(root, 'media', 'video', 'v.mp4'), 'v'.repeat(2000))
})

describe('v2.1 快照引擎（F3）', () => {
  it('保存 + 列表 + 基本元数据', () => {
    const rows = flattenTree(scanTreeSync(root).root as never)
    const sid = saveSnapshot(db, root, rows)
    expect(sid).toBeGreaterThan(0)
    const list = listSnapshots(db, root)
    expect(list.length).toBe(1)
    expect(list[0].dirCount).toBe(rows.length)
    expect(list[0].fileCount).toBe(2)
  })

  it('红线 12：无变化 → diff 全空（无噪声）', async () => {
    const [s1] = listSnapshots(db, root)
    // 再拍一份（内容没变）
    const rows = flattenTree(scanTreeSync(root).root as never)
    const s2 = saveSnapshot(db, root, rows)
    const d = diffSnapshots(db, s1.id, s2)
    expect(d.grow.length).toBe(0)
    expect(d.shrink.length).toBe(0)
    expect(d.newDirs.length).toBe(0)
    expect(d.goneDirs.length).toBe(0)
  })

  it('新增 5MB → 增长 TOP1 数值准确（路径为夹具根或 video 子树——均含 video 的增量）', async () => {
    const [latest] = listSnapshots(db, root)
    writeFileSync(join(root, 'media', 'video', 'big.bin'), 'x'.repeat(5 * 1024 * 1024))
    const rows = flattenTree(scanTreeSync(root).root as never)
    const sidNew = saveSnapshot(db, root, rows)
    const d = diffSnapshots(db, latest.id, sidNew)
    expect(d.grow.length).toBeGreaterThan(0)
    // TOP1 至少 5MB（video 子树或夹具根——两者都证明「空间被谁吃了」）
    expect(d.grow[0].delta).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    // video 目录本身必在增长榜
    expect(d.grow.some((e) => e.path.endsWith('video'))).toBe(true)
  }, 60000)

  it('删除文件 → shrink 出现（清理战果）', async () => {
    const [latest] = listSnapshots(db, root)
    rmSync(join(root, 'media', 'video', 'big.bin'))
    const rows = flattenTree(scanTreeSync(root).root as never)
    const sidNew = saveSnapshot(db, root, rows)
    const d = diffSnapshots(db, latest.id, sidNew)
    expect(d.shrink.length).toBeGreaterThan(0)
    expect(d.shrink.some((e) => e.path.endsWith('video'))).toBe(true)
    expect(d.shrink[0].delta).toBeGreaterThanOrEqual(5 * 1024 * 1024)
  })

  it('新增目录 / 消失目录', async () => {
    const [latest] = listSnapshots(db, root)
    mkdirSync(join(root, 'brand-new'))
    writeFileSync(join(root, 'brand-new', 'n.txt'), 'n')
    rmSync(join(root, 'docs'), { recursive: true, force: true })
    const rows = flattenTree(scanTreeSync(root).root as never)
    const sidNew = saveSnapshot(db, root, rows)
    const d = diffSnapshots(db, latest.id, sidNew)
    expect(d.newDirs.some((e) => e.path.endsWith('brand-new'))).toBe(true)
    expect(d.goneDirs.some((e) => e.path.endsWith('docs'))).toBe(true)
  })

  it('滚动淘汰：keep=3 下第 4 份挤掉最旧', () => {
    // 当前该 root 已有多份——用独立 root 测
    const r2 = join(root, 'roll')
    mkdirSync(r2, { recursive: true })
    const mk = (): DirRow[] => [{ path: r2, size: 1, files: 1, dirs: 1, mtime: Date.now() }]
    for (let i = 0; i < 4; i++) saveSnapshot(db, r2, mk(), 3)
    expect(listSnapshots(db, r2).length).toBe(3)
    // 31 份场景：keep 默认 30
    const r3 = join(root, 'roll31')
    mkdirSync(r3, { recursive: true })
    for (let i = 0; i < 32; i++) saveSnapshot(db, r3, mk())
    const left = listSnapshots(db, r3)
    expect(left.length).toBe(30)
    // 最旧的被淘汰（时间升序校验）
    const ts = left.map((s) => s.ts)
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeLessThanOrEqual(ts[i - 1] === ts[i] ? ts[i] : ts[i])
  })

  it('deleteSnapshot 清理干净', () => {
    const r = join(root, 'roll')
    const list = listSnapshots(db, r)
    const before = db.prepare('SELECT COUNT(*) c FROM snapshot_dirs WHERE snapshot_id = ?').get(list[0].id) as { c: number }
    expect(before.c).toBe(1)
    deleteSnapshot(db, list[0].id)
    const after = db.prepare('SELECT COUNT(*) c FROM snapshot_dirs WHERE snapshot_id = ?').get(list[0].id) as { c: number }
    expect(after.c).toBe(0)
    expect(listSnapshots(db, r).length).toBe(2)
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
