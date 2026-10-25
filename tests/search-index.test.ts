import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { ensureIndexTable, rebuildIndex, searchFiles, indexStats, type IndexedFile } from '../src/main/search/index'

let db: Database.Database
const f = (i: number, name: string, size: number, type: string, mtime: number): IndexedFile =>
  ({ path: `D://t//${name}`, root: 'D://t', name, ext: name.split('.').pop() || '', size, mtime, type })

const ROWS: IndexedFile[] = [
  f(1, '照片A.jpg', 3_000_000, '图片', Date.now()),
  f(2, '照片B.png', 2_000_000, '图片', Date.now() - 90 * 24 * 3600e3),
  f(3, '报告2024.pdf', 500_000, '文档', Date.now() - 10 * 24 * 3600e3),
  f(4, 'movie.mp4', 8_000_000_000, '视频', Date.now() - 200 * 24 * 3600e3),
  f(5, 'setup.exe', 100_000, '安装包', Date.now())
]

beforeAll(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  ensureIndexTable(db)
  rebuildIndex(db, 'D://t', ROWS)
})

describe('v2.2 F6 搜索索引', () => {
  it('通配符：*.jpg 只命中 jpg', () => {
    const r = searchFiles(db, { namePattern: '*.jpg' })
    expect(r.length).toBe(1)
    expect(r[0].name).toBe('照片A.jpg')
  })
  it('中文前缀通配：报告*', () => {
    const r = searchFiles(db, { namePattern: '报告*' })
    expect(r.length).toBe(1)
    expect(r[0].name).toBe('报告2024.pdf')
  })
  it('大小范围组合', () => {
    const r = searchFiles(db, { minSize: 1_000_000, maxSize: 4_000_000 })
    expect(r.map((x) => x.name).sort()).toEqual(['照片A.jpg', '照片B.png'])
  })
  it('日期范围：近 30 天', () => {
    const r = searchFiles(db, { after: Date.now() - 30 * 24 * 3600e3 })
    expect(r.some((x) => x.name === '照片A.jpg')).toBe(true)
    expect(r.some((x) => x.name === '照片B.png')).toBe(false)
  })
  it('类型多选 + 大小组合（四条件）', () => {
    const r = searchFiles(db, { types: ['图片', '文档'], minSize: 100_000 })
    expect(r.length).toBe(3) // 两图 + 一文档
  })
  it('结果按大小降序', () => {
    const r = searchFiles(db, {})
    for (let i = 1; i < r.length; i++) expect(r[i - 1].size).toBeGreaterThanOrEqual(r[i].size)
  })
  it('防注入：恶意 pattern 返回空', () => {
    expect(searchFiles(db, { namePattern: "'; DROP TABLE file_index;--" }).length).toBe(0)
    const c = db.prepare('SELECT COUNT(*) c FROM file_index').get() as { c: number }
    expect(c.c).toBe(5) // 表还在
  })
  it('重建幂等（同 root 替换不重复）', () => {
    rebuildIndex(db, 'D://t', ROWS)
    expect(indexStats(db).files).toBe(5)
    rebuildIndex(db, 'E://u', [{ path: 'E://u//x.txt', root: 'E://u', name: 'x.txt', ext: 'txt', size: 1, mtime: Date.now(), type: '文档' }])
    expect(indexStats(db).files).toBe(6)
    expect(indexStats(db).roots.length).toBe(2)
  })
  it('性能：10 万行组合查询 < 1s（验收）', () => {
    const big: IndexedFile[] = []
    for (let i = 0; i < 100_000; i++) {
      big.push({ path: `P://f${i}.bin`, root: 'P://', name: `f${i}.bin`, ext: 'bin', size: i * 10, mtime: Date.now() - i * 1000, type: i % 3 === 0 ? '图片' : '其他' })
    }
    rebuildIndex(db, 'P://', big)
    const t0 = Date.now()
    const r = searchFiles(db, { namePattern: 'f1*', minSize: 100_000, types: ['图片'] })
    const ms = Date.now() - t0
    expect(r.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(1000)
    console.log(`10 万行组合查询: ${ms}ms, 命中 ${r.length}`)
  })
})
