import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isIncomplete, enqueue, processBatch, addWatchDir, listWatchDirs, setWatchMode, archiveFile, ensureWatchDirs } from '../src/main/cleaner/watcher'

let db: Database.Database
let fx: string

beforeAll(() => {
  db = new Database(':memory:')
  ensureWatchDirs(db)
  fx = mkdtempSync(join(tmpdir(), 'cs-g4-'))
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v3.1 G4 下载目录自动整理（红线 15）', () => {
  it('未完成下载识别：.crdownload/.part/.tmp 全命中', () => {
    for (const n of ['a.exe.crdownload', 'b.zip.part', 'c.tmp', 'd.downloading', 'e.partial']) {
      expect(isIncomplete(n)).toBe(true)
    }
    expect(isIncomplete('a.exe')).toBe(false)
    expect(isIncomplete('report.pdf')).toBe(false)
  })

  it('去抖合并：连续事件 30s 后一批处理（压缩 debounce 验证）', async () => {
    const batches: string[][] = []
    enqueue(fx, 'f1.zip', async (_d, fs) => { batches.push(fs) }, 50)
    enqueue(fx, 'f2.zip', async (_d, fs) => { batches.push(fs) }, 50)
    enqueue(fx, 'f3.zip', async (_d, fs) => { batches.push(fs) }, 50)
    await new Promise(r => setTimeout(r, 200))
    expect(batches.length).toBe(1) // 三连事件合并成一批
    expect(batches[0].length).toBe(3)
  })

  it('红线 15：未完成文件连队列都不进', async () => {
    const batches: string[][] = []
    enqueue(fx, 'movie.mp4.crdownload', async (_d, fs) => { batches.push(fs) }, 50)
    await new Promise(r => setTimeout(r, 150))
    expect(batches.flat().some(f => f.includes('crdownload'))).toBe(false)
  })

  it('report 模式零移动（只建议）；auto 模式真归档+类型目录+冲突后缀', async () => {
    const dl = join(fx, 'dl')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'app_setup.exe'), 'x')
    writeFileSync(join(dl, 'app_setup.exe'), 'x') // 同名占位（冲突测试）
    // report
    const r1 = await processBatch(dl, [join(dl, 'app_setup.exe')], 'report')
    expect(r1.moved.length).toBe(0)
    expect((r1.suggestions || []).length).toBe(1)
    expect(existsSync(join(dl, 'app_setup.exe'))).toBe(true)
    // auto：再放一个同名（同批两条同路径会冲突——分两批）
    writeFileSync(join(dl, 'photo.jpg'), 'y')
    const r2 = await processBatch(dl, [join(dl, 'app_setup.exe'), join(dl, 'photo.jpg')], 'auto')
    expect(r2.moved.length).toBe(2)
    expect(existsSync(join(dl, '已整理', '安装包', 'app_setup.exe'))).toBe(true)
    expect(existsSync(join(dl, '已整理', '图片', 'photo.jpg'))).toBe(true)
    // 冲突后缀
    writeFileSync(join(dl, 'app_setup.exe'), 'z')
    const r3 = await processBatch(dl, [join(dl, 'app_setup.exe')], 'auto')
    expect(r3.moved[0].to).toContain('app_setup-1.exe')
  })

  it('off 模式不处理任何文件', async () => {
    const dl = join(fx, 'dl2')
    mkdirSync(dl, { recursive: true })
    writeFileSync(join(dl, 'a.zip'), 'x')
    const r = await processBatch(dl, [join(dl, 'a.zip')], 'off')
    expect(r.moved.length).toBe(0)
    expect(existsSync(join(dl, 'a.zip'))).toBe(true)
  })

  it('CRUD：目录增删查+模式切换', () => {
    expect(addWatchDir(db, 'D:\\Downloads')).toBe(true)
    expect(addWatchDir(db, 'D:\\Downloads')).toBe(false) // 重复
    setWatchMode(db, 'D:\\Downloads', 'auto')
    const l = listWatchDirs(db)
    expect(l[0].mode).toBe('auto')
  })
})
