import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { plan, defaultRules, type OrganizeRule } from '../src/main/organizer/rules'
import { findDuplicates } from '../src/main/organizer/dup'
import { executePlan, rollback, fileHash } from '../src/main/organizer/exec'
import { BUILTIN_WHITELIST } from '../src/shared/whitelist'

let src: string
let dst: string
let db: Database.Database
const wl = BUILTIN_WHITELIST.map((w, i) => ({ id: i + 1, pattern: w.pattern, enabled: true, builtin: true, note: w.note }))

/** 目录快照（路径→size），用于「报告模式零写入」验收 */
function snapshot(root: string): Map<string, number> {
  const m = new Map<string, number>()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else m.set(full, statSync(full).size)
    }
  }
  walk(root)
  return m
}

beforeAll(() => {
  src = mkdtempSync(join(tmpdir(), 'cs-org-src-'))
  dst = mkdtempSync(join(tmpdir(), 'cs-org-dst-'))
  db = new Database(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS op_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, batch_id TEXT, action TEXT, src_path TEXT, dst_path TEXT, size INTEGER, detail TEXT)')
  // 夹具
  mkdirSync(join(src, 'photos'), { recursive: true })
  writeFileSync(join(src, 'photos', 'a.jpg'), Buffer.alloc(100, 1))
  writeFileSync(join(src, 'photos', 'b.png'), Buffer.alloc(200, 2))
  writeFileSync(join(src, 'video.mp4'), Buffer.alloc(300, 3))
  writeFileSync(join(src, 'report.pdf'), Buffer.alloc(150, 4))
  writeFileSync(join(src, 'setup.exe'), Buffer.alloc(500, 5))
  writeFileSync(join(src, 'notes.txt'), Buffer.alloc(50, 6))
  // 重复文件
  writeFileSync(join(src, 'dup1.bin'), Buffer.alloc(1024, 7))
  writeFileSync(join(src, 'dup2.bin'), Buffer.alloc(1024, 7))       // 同内容
  writeFileSync(join(src, 'dup3.bin'), Buffer.alloc(1024, 8))       // 同大小不同内容——不应误判
  writeFileSync(join(src, 'photos', 'dup1.bin'), Buffer.alloc(1024, 7)) // 与 dup1 同内容（跨目录）
})

afterAll(() => {
  rmSync(src, { recursive: true, force: true })
  rmSync(dst, { recursive: true, force: true })
})

describe('P3 规则引擎与预案（零写入）', () => {
  it('plan() 生成正确预案且磁盘零改动（快照 diff 为空）', async () => {
    const before = snapshot(src)
    const rules = defaultRules().filter((r) => r.enabled)
    const r = await plan(src, { targetRoot: dst, keepRelative: true, rules, whitelist: wl }, () => false)
    // a.jpg b.png video.mp4 report.pdf setup.exe notes.txt = 6 个匹配（dup* 为「其他」类无规则）
    expect(r.items.length).toBeGreaterThanOrEqual(6)
    // 类型正确
    const jpg = r.items.find((i) => i.src.endsWith('a.jpg'))
    expect(jpg?.dst).toContain(join('图片'))
    expect(jpg?.dst).toContain(join('photos', 'a.jpg')) // 保留相对路径
    const mp4 = r.items.find((i) => i.src.endsWith('video.mp4'))
    expect(mp4?.dst).toContain(join('视频'))
    // 零写入（验收红线）
    const after = snapshot(src)
    expect([...after.entries()].toString()).toBe([...before.entries()].toString())
  })

  it('平铺模式 + 冲突预演后缀', async () => {
    const rules: OrganizeRule[] = [{ id: 1, kind: 'type', name: '图片', config: { category: '图片', targetFolder: 'P' }, enabled: true, priority: 1 }]
    // 两目录同名图片（photos/a.jpg 与 p2/a.jpg）
    mkdirSync(join(src, 'p2'), { recursive: true })
    writeFileSync(join(src, 'p2', 'a.jpg'), Buffer.alloc(10, 9))
    const r = await plan(src, { targetRoot: dst, keepRelative: false, rules, whitelist: wl }, () => false)
    const flatA = r.items.filter((i) => i.src.endsWith('a.jpg'))
    expect(flatA.length).toBe(2)
    const names = flatA.map((i) => i.dst)
    expect(names.some((n) => /-1\.jpg$/.test(n))).toBe(true)
  })

  it('白名单路径不出现在预案中', async () => {
    const rules = defaultRules().filter((r) => r.enabled)
    const r = await plan(src, { targetRoot: dst, keepRelative: true, rules, whitelist: wl }, () => false)
    for (const it of r.items) {
      expect(it.src.toLowerCase()).not.toContain('c:\\windows')
      expect(it.src.toLowerCase()).not.toContain('documents')
    }
  })
})

describe('P3 重复文件检测（无误报验收）', () => {
  it('同内容分组正确；同大小不同内容不误判', async () => {
    const files = [
      { path: join(src, 'dup1.bin'), size: 1024, mtime: 1 },
      { path: join(src, 'dup2.bin'), size: 1024, mtime: 2 },
      { path: join(src, 'dup3.bin'), size: 1024, mtime: 3 },
      { path: join(src, 'photos', 'dup1.bin'), size: 1024, mtime: 4 }
    ]
    const r = await findDuplicates(files, undefined, 1)
    expect(r.groups.length).toBe(1) // dup1/dup2/photos/dup1 一组；dup3 不在
    const g = r.groups[0]
    expect(g.files.length).toBe(3)
    expect(g.files.map((f) => f.path)).not.toContain(join(src, 'dup3.bin'))
    expect(g.wasteBytes).toBe(2048)
  })

  it('小于 minSize 的跳过', async () => {
    const files = [
      { path: join(src, 'notes.txt'), size: 50, mtime: 1 },
      { path: join(src, 'report.pdf'), size: 50, mtime: 2 }
    ]
    const r = await findDuplicates(files, undefined, 1024)
    expect(r.groups.length).toBe(0)
  })

  it('mtime 排序：组内最早的排第一（保留最早策略基础）', async () => {
    const files = [
      { path: join(src, 'dup2.bin'), size: 1024, mtime: 200 },
      { path: join(src, 'dup1.bin'), size: 1024, mtime: 100 }
    ]
    const r = await findDuplicates(files, undefined, 1)
    expect(r.groups[0].files[0].path).toBe(join(src, 'dup1.bin'))
  })
})

describe('P3 执行与回滚', () => {
  it('执行 → 文件到位 → 回滚 → 原路径恢复且 hash 一致', async () => {
    const rules: OrganizeRule[] = [{ id: 99, kind: 'custom', name: 'psd', config: { ext: 'jpg', targetFolder: '设计' }, enabled: true, priority: 1 }]
    const p = await plan(src, { targetRoot: dst, keepRelative: false, rules, whitelist: wl }, () => false)
    expect(p.items.length).toBeGreaterThanOrEqual(1)
    const target = p.items[0]
    const hashBefore = await fileHash(target.src)

    const ex = await executePlan(db, p.items, wl)
    expect(ex.moved).toBe(p.items.length)
    expect(existsSync(target.dst)).toBe(true)
    expect(existsSync(target.src)).toBe(false)

    const rb = await rollback(db, ex.batchId)
    expect(rb.ok).toBe(p.items.length)
    expect(rb.fail).toBe(0)
    expect(existsSync(target.src)).toBe(true)
    expect(await fileHash(target.src)).toBe(hashBefore)
  })

  it('执行时目标被占 → 自动 -1 后缀', async () => {
    const rules: OrganizeRule[] = [{ id: 98, kind: 'custom', name: 'png', config: { ext: 'png', targetFolder: 'PNG' }, enabled: true, priority: 1 }]
    const p = await plan(src, { targetRoot: dst, keepRelative: false, rules, whitelist: wl }, () => false)
    expect(p.items.length).toBe(1)
    // 预占 plan 给出的原始 dst（无后缀名）
    const origDst = p.items[0].dst.replace(/-1\.png$/, '.png')
    mkdirSync(join(dst, 'PNG'), { recursive: true })
    writeFileSync(origDst, 'occupied')
    const ex = await executePlan(db, p.items, wl)
    expect(ex.moved).toBe(1)
    // 实际落地带 -1 后缀
    expect(ex.movedMap[0].dst).toMatch(/-1\.png$/)
    // 清理
    await rollback(db, ex.batchId)
  })

  it('白名单文件执行被拦截', async () => {
    const evil = [{ src: 'C:\\Windows\\System32\\x.dll', dst: 'D:\\o\\x.dll', size: 1, mtime: 0, ruleId: 1, reason: 'test' }]
    const ex = await executePlan(db, evil, wl)
    expect(ex.moved).toBe(0)
    expect(ex.failed).toBe(1)
    expect(ex.errors[0].message).toContain('拦截')
  })

  it('分批执行不卡事件循环（100+ 文件 yield）', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ src: join(src, `dup1.bin`), dst: join(dst, `m${i}.bin`), size: 1, mtime: 0, ruleId: 1, reason: 'x' }))
    // 全部会失败（src 只有一个会被第一个移走）——仅验证批量循环与进度回调不抛
    let lastDone = 0
    const ex = await executePlan(db, many, wl, (d) => { lastDone = Math.max(lastDone, d) })
    expect(ex.failed).toBe(249) // 第一个成功，其余 src 不存在
    expect(ex.moved + ex.failed).toBe(250)
    expect(lastDone).toBeGreaterThan(0)
    // 回滚第一个成功的
    await rollback(db, ex.batchId)
  })
})
