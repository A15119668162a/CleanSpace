/**
 * 微信/QQ 专清（v3.1 / G11）
 * 中文用户磁盘空间第一大户：微信 FileStorage 动辄 20~80GB。
 * 红线 21（三期最高）：聊天记录（Msg/db）物理隔离——不扫描、不展示、无清理入口。
 * 分区三级：safe(Cache 类) / caution(File/Image/Video 接收内容，默认不勾)
 */
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export type ChatLevel = 'safe' | 'caution'

export interface ChatZone {
  /** 相对账号根的子目录（如 FileStorage/Cache） */
  rel: string
  level: ChatLevel
  what: string
  /** caution 级后果文案（UI 强制展示） */
  consequence?: string
}

/** 微信 FileStorage 分区表（只认官方结构） */
export const WX_ZONES: ChatZone[] = [
  { rel: 'FileStorage/Cache', level: 'safe', what: '图片/视频缓存' },
  { rel: 'FileStorage/Video/Cache', level: 'safe', what: '视频缓存' },
  { rel: 'FileStorage/General/ADR', level: 'safe', what: '广告缓存' },
  { rel: 'FileStorage/Fav', level: 'safe', what: '收藏缓存（内容在收藏里可重新加载）' },
  { rel: 'FileStorage/File', level: 'caution', what: '聊天接收的文件', consequence: '清理后聊天中对应文件将无法查看/另存' },
  { rel: 'FileStorage/Image', level: 'caution', what: '聊天图片', consequence: '清理后聊天中的图片将无法查看' },
  { rel: 'FileStorage/Video', level: 'caution', what: '聊天视频', consequence: '清理后聊天中的视频将无法播放' }
]

/** QQ NTQQ 分区表 */
export const QQ_ZONES: ChatZone[] = [
  { rel: 'nt_qqcache', level: 'safe', what: 'QQ 缓存' },
  { rel: 'nt_data', level: 'caution', what: '聊天数据（图片/文件缓存混合）', consequence: '清理后部分聊天图片/文件需重新加载，可能无法找回' }
]

/** 聊天记录物理隔离目录（红线 21：连 readdir 都不进） */
export const FORBIDDEN = ['msg', 'msgbackup', 'db', 'database', 'micro-msg', 'enmicro-msg', 'session']

export interface ChatAccount {
  app: 'wechat' | 'qq'
  /** wxid_xxx / QQ 号 */
  id: string
  /** 账号数据根目录（含 FileStorage 的上级） */
  root: string
  size: number
}

export interface ChatItem {
  path: string
  size: number
  mtime: number
  zone: string
  level: ChatLevel
  what: string
  /** 会话名（从 File/Image/Video 下按会话分目录提取；Cache 类无会话概念） */
  session?: string
}

/** 探测账号（微信 Documents\WeChat Files\wxid_*；QQ Documents\Tencent Files\NTQQ Data 按账号目录） */
export async function findAccounts(): Promise<ChatAccount[]> {
  const docs = join(homedir(), 'Documents')
  const out: ChatAccount[] = []
  // 微信
  const wxRoot = join(docs, 'WeChat Files')
  try {
    const ds = await readdir(wxRoot, { withFileTypes: true })
    for (const d of ds) {
      if (!d.isDirectory() || !/^wxid_[a-z0-9_]+$/i.test(d.name)) continue
      const acct = join(wxRoot, d.name)
      const s = await dirSum(acct, 0)
      out.push({ app: 'wechat', id: d.name, root: acct, size: s })
    }
  } catch { /* 未装微信 */ }
  // QQ（NTQQ：Documents\Tencent Files\<qq号>\nt_qq_*）
  const qqRoot = join(docs, 'Tencent Files')
  try {
    const ds = await readdir(qqRoot, { withFileTypes: true })
    for (const d of ds) {
      if (!d.isDirectory() || !/^\d{5,12}$/.test(d.name)) continue
      const acct = join(qqRoot, d.name)
      const s = await dirSum(acct, 0)
      if (s > 0) out.push({ app: 'qq', id: d.name, root: acct, size: s })
    }
  } catch { /* 未装 QQ */ }
  return out
}

/** 目录求和（跳过禁区——红线 21：Msg 连统计都不进） */
async function dirSum(p: string, depth: number): Promise<number> {
  if (depth > 3) return 0
  let sum = 0
  let ds: Awaited<ReturnType<typeof readdir>>
  try { ds = await readdir(p, { withFileTypes: true }) } catch { return 0 }
  for (const d of ds) {
    const ln = d.name.toLowerCase()
    if (d.isDirectory() && FORBIDDEN.includes(ln)) continue // 物理隔离
    const f = join(p, d.name)
    try {
      if (d.isDirectory()) sum += await dirSum(f, depth + 1)
      else sum += (await stat(f)).size
    } catch { /* */ }
  }
  return sum
}

/** 扫描某账号分区（monthsOld：只统计 N 个月前的；Msg 永不入结果） */
export async function scanChatAccount(acct: ChatAccount, monthsOld = 6): Promise<ChatItem[]> {
  const zones = acct.app === 'wechat' ? WX_ZONES : QQ_ZONES
  const cutoff = Date.now() - monthsOld * 30 * 86400e3
  const out: ChatItem[] = []
  for (const z of zones) {
    const zonePath = join(acct.root, ...z.rel.split('/'))
    // 深一层看会话目录（微信 File/Image/Video 按会话名分目录：wxid_xxx / 群备注名）
    const isSessionZone = ['FileStorage/File', 'FileStorage/Image', 'FileStorage/Video'].includes(z.rel)
    if (isSessionZone) {
      // 第一层 = 数据类型子目录（如 Image 下有 Image/消息月份…）——直接全层扫但记录相对首层名
      const items = await walkFiles(zonePath, cutoff, 0)
      for (const it of items) {
        const rel = it.path.slice(zonePath.length + 1)
        // 微信结构 FileStorage\File\<wxid或群名>\<日期>；Image\<wxid>\msg\...——会话名取第一段
        const session = rel.split(/[\\/]/)[0]
        out.push({ ...it, zone: z.rel, level: z.level, what: z.what, session })
      }
    } else {
      const items = await walkFiles(zonePath, cutoff, 0)
      for (const it of items) out.push({ ...it, zone: z.rel, level: z.level, what: z.what })
    }
  }
  return out
}

/** 递归收集过期文件（cutoff=0 全部）；禁区目录直接跳过（红线 21 兜底） */
async function walkFiles(p: string, cutoff: number, depth: number): Promise<Array<{ path: string; size: number; mtime: number }>> {
  if (depth > 5) return []
  const out: Array<{ path: string; size: number; mtime: number }> = []
  let ds: Awaited<ReturnType<typeof readdir>>
  try { ds = await readdir(p, { withFileTypes: true }) } catch { return [] }
  for (const d of ds) {
    const ln = d.name.toLowerCase()
    if (d.isDirectory() && FORBIDDEN.includes(ln)) continue
    const f = join(p, d.name)
    try {
      if (d.isDirectory()) out.push(...(await walkFiles(f, cutoff, depth + 1)))
      else {
        const s = await stat(f)
        if (cutoff === 0 || s.mtimeMs < cutoff) out.push({ path: f, size: s.size, mtime: s.mtimeMs })
      }
    } catch { /* */ }
  }
  return out
}

/** 按会话聚合（谨慎级 UI 用：哪个会话多大） */
export function groupBySession(items: ChatItem[]): Array<{ session: string; level: ChatLevel; bytes: number; count: number; what: string }> {
  const m = new Map<string, { session: string; level: ChatLevel; bytes: number; count: number; what: string }>()
  for (const it of items) {
    const key = it.session || '（缓存类，无会话）'
    const g = m.get(key) || { session: key, level: it.level, bytes: 0, count: 0, what: it.what }
    g.bytes += it.size
    g.count++
    m.set(key, g)
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes)
}
