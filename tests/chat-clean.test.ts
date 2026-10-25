import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanChatAccount, findAccounts, groupBySession, FORBIDDEN, type ChatAccount } from '../src/main/cleaner/chat'

let fx: string

/** 构造模拟微信多账号目录树（含 Msg 禁区 / Cache / File 会话 / Image） */
beforeAll(() => {
  fx = mkdtempSync(join(tmpdir(), 'cs-wx-'))
  const mk = (...seg: string[]): string => {
    const p = join(fx, ...seg)
    mkdirSync(p, { recursive: true })
    return p
  }
  const put = (dir: string, name: string, size: number, daysAgo: number): void => {
    writeFileSync(join(dir, name), Buffer.alloc(size))
    const t = new Date(Date.now() - daysAgo * 86400e3)
    require('fs').utimesSync(join(dir, name), t, t)
  }
  // 账号1：wxid_aaa
  const a1 = mk('wxid_aaa', 'FileStorage')
  mk('wxid_aaa', 'Msg') // 禁区
  writeFileSync(join(fx, 'wxid_aaa', 'Msg', 'MicroMsg.db'), Buffer.alloc(99999)) // 禁区文件——绝不能出现
  put(mk('wxid_aaa', 'FileStorage', 'Cache'), 'img1.dat', 100, 300) // 300 天前 → 6 个月外 ✓
  put(mk('wxid_aaa', 'FileStorage', 'Cache'), 'img2.dat', 50, 10) // 10 天前 → 时间范围内不入
  put(mk('wxid_aaa', 'FileStorage', 'File', '张三', '2024-03'), 'doc.pdf', 500, 200)
  put(mk('wxid_aaa', 'FileStorage', 'File', '项目群', '2024-05'), '报表.xlsx', 800, 190)
  put(mk('wxid_aaa', 'FileStorage', 'Image', 'wxid_bbb'), 'pic1.jpg', 300, 90)
  // 账号2：wxid_ccc
  mk('wxid_ccc', 'FileStorage')
  put(mk('wxid_ccc', 'FileStorage', 'Cache'), 'c1.bin', 700, 400)
  put(mk('wxid_ccc', 'FileStorage', 'Msg'), 'x.db', 55555, 500) // 禁区（Msg 下）
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

const acct = (id: string): ChatAccount => ({ app: 'wechat', id, root: join(fx, id), size: 0 })

describe('v3.1 G11 微信/QQ 专清（红线 21：聊天记录物理隔离）', () => {
  it('分区识别：Cache=safe / File·Image=caution，时间过滤生效', async () => {
    const items = await scanChatAccount(acct('wxid_aaa'), 6)
    const safe = items.filter((i) => i.zone === 'FileStorage/Cache')
    expect(safe.every((i) => i.level === 'safe')).toBe(true)
    expect(safe.some((i) => i.path.includes('img1.dat'))).toBe(true) // 300 天前
    expect(safe.some((i) => i.path.includes('img2.dat'))).toBe(false) // 10 天前被过滤
    const files = items.filter((i) => i.zone === 'FileStorage/File')
    expect(files.every((i) => i.level === 'caution')).toBe(true)
    expect(files.length).toBe(2)
  })

  it('红线 21：Msg 数据库在任何结果中零出现（扫描结果+求和全跳过）', async () => {
    const items1 = await scanChatAccount(acct('wxid_aaa'), 6)
    const items2 = await scanChatAccount(acct('wxid_ccc'), 6)
    const all = [...items1, ...items2]
    expect(all.filter((i) => /\\Msg\\|\/Msg\//.test(i.path) || /\.db$/i.test(i.path))).toEqual([])
    expect(all.some((i) => i.path.includes('MicroMsg.db'))).toBe(false)
  })

  it('按会话聚合：张三/项目群分开统计', async () => {
    const items = await scanChatAccount(acct('wxid_aaa'), 6)
    const g = groupBySession(items.filter((i) => i.zone === 'FileStorage/File'))
    const zs = g.find((x) => x.session === '张三')
    const xm = g.find((x) => x.session === '项目群')
    expect(zs?.bytes).toBe(500)
    expect(xm?.bytes).toBe(800)
    expect(zs?.level).toBe('caution')
  })

  it('多账号隔离：cc 账号扫描不含 aaa 数据', async () => {
    const items = await scanChatAccount(acct('wxid_ccc'), 6)
    expect(items.every((i) => i.path.startsWith(join(fx, 'wxid_ccc')))).toBe(true)
    expect(items.some((i) => i.path.includes('c1.bin'))).toBe(true)
  })

  it('禁区字典含聊天记录核心目录', () => {
    for (const d of ['msg', 'db', 'micro-msg', 'session']) expect(FORBIDDEN).toContain(d)
  })
})
