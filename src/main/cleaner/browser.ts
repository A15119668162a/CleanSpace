/**
 * 浏览器专清增强（v3.2 / G6）
 * Chrome/Edge/Firefox 分 Profile 细分：Cache 安全 / 站点数据谨慎。
 * 红线 18：书签/密码/历史/扩展/自动填充——不仅不删，任何代码路径不可达（物理隔离）。
 */
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

/** 物理隔离：这些名字的文件/目录在任何浏览器清理路径中都不可触碰（红线 18） */
export const FORBIDDEN_BROWSER = [
  // 书签
  'bookmarks', 'bookmarks.bak', 'bookmarks.json', 'places.sqlite', 'bookmarks.html',
  // 密码
  'login data', 'login data for account', 'logins.json', 'key4.db', 'key3.db',
  // 历史
  'history', 'history.json', 'visited links', 'formhistory.sqlite',
  // 扩展
  'extensions', 'extension state', 'extension rules', 'extension scripts', 'extension activities', 'secure preferences',
  // 自动填充
  'web data'
]

/** 红线 18 校验：路径任何一段命中禁区名 → 拒绝（所有收集函数出口统一调用） */
export function isForbiddenPath(p: string): boolean {
  const segs = p.toLowerCase().split(/[\\/]+/).filter(Boolean)
  return segs.some((s) => {
    const bare = s.replace(/\.(json|sqlite|bak|html|db)$/i, '')
    return FORBIDDEN_BROWSER.includes(s) || FORBIDDEN_BROWSER.includes(bare)
  })
}

export type BrowserLevel = 'safe' | 'caution'

export interface BrowserZone {
  rel: string
  level: BrowserLevel
  what: string
  consequence?: string
}

/** Chromium 系（Chrome/Edge）Profile 内分区 */
export const CHROMIUM_ZONES: BrowserZone[] = [
  { rel: 'Cache', level: 'safe', what: '网页缓存' },
  { rel: 'Code Cache', level: 'safe', what: 'JS 编译缓存' },
  { rel: 'GPUCache', level: 'safe', what: 'GPU 缓存' },
  { rel: 'Media Cache', level: 'safe', what: '媒体缓存' },
  { rel: 'Service Worker/CacheStorage', level: 'caution', what: 'Service Worker 站点数据', consequence: '部分离线网站需重新加载' },
  { rel: 'Local Storage/leveldb', level: 'caution', what: '站点本地存储', consequence: '部分网站需重新登录' }
]

/** Firefox Profile 内分区 */
export const FIREFOX_ZONES: BrowserZone[] = [
  { rel: 'cache2', level: 'safe', what: '网页缓存' },
  { rel: 'startupCache', level: 'safe', what: '启动缓存' },
  { rel: 'shader-cache', level: 'safe', what: '着色器缓存' },
  { rel: 'storage/default', level: 'caution', what: '站点存储（含部分登录态）', consequence: '部分网站需重新登录' }
]

export interface BrowserProfile {
  browser: 'chrome' | 'edge' | 'firefox'
  name: string // Default / Profile 1 / xxx.default-release
  root: string
  sizeMB: number
}

export interface BrowserItem {
  path: string
  size: number
  mtime: number
  zone: string
  level: BrowserLevel
  what: string
}

/** 发现三浏览器全部 Profile */
export async function findProfiles(): Promise<BrowserProfile[]> {
  const out: BrowserProfile[] = []
  const local = join(homedir(), 'AppData', 'Local')
  const roaming = join(homedir(), 'AppData', 'Roaming')
  const roots: Array<{ browser: BrowserProfile['browser']; base: string; chromium: boolean }> = [
    { browser: 'chrome', base: join(local, 'Google', 'Chrome', 'User Data'), chromium: true },
    { browser: 'edge', base: join(local, 'Microsoft', 'Edge', 'User Data'), chromium: true },
    { browser: 'firefox', base: join(roaming, 'Mozilla', 'Firefox'), chromium: false }
  ]
  for (const r of roots) {
    let ds: Awaited<ReturnType<typeof readdir>>
    try { ds = await readdir(r.base, { withFileTypes: true }) } catch { continue }
    for (const d of ds) {
      if (!d.isDirectory()) continue
      const n = d.name
      const isProfile = r.chromium
        ? n === 'Default' || /^Profile \d+$/.test(n)
        : /\.(default|dev-edition)-[a-z0-9]+$/i.test(n)
      if (!isProfile) continue
      const root = join(r.base, n)
      // 存在性双校验：Chromium Profile 必有 Preferences；FF Profile 必有 prefs.js
      const marker = r.chromium ? 'Preferences' : 'prefs.js'
      try { await stat(join(root, marker)) } catch { continue }
      const sizeMB = await dirSumMB(root)
      if (sizeMB > 0) out.push({ browser: r.browser, name: n, root, sizeMB: +sizeMB.toFixed(1) })
    }
  }
  return out
}

async function dirSumMB(p: string, depth = 0): Promise<number> {
  if (depth > 4) return 0
  let sum = 0
  let ds: Awaited<ReturnType<typeof readdir>>
  try { ds = await readdir(p, { withFileTypes: true }) } catch { return 0 }
  for (const d of ds) {
    if (isForbiddenPath(d.name)) continue // 禁区连统计都不进（红线 18）
    const f = join(p, d.name)
    try {
      if (d.isDirectory()) sum += await dirSumMB(f, depth + 1)
      else sum += (await stat(f)).size
    } catch { /* */ }
  }
  return sum / 1024 / 1024
}

/** 扫描某 Profile 的可清分区（红线 18：收集出口统一过滤） */
export async function scanProfile(prof: BrowserProfile): Promise<BrowserItem[]> {
  const zones = prof.browser === 'firefox' ? FIREFOX_ZONES : CHROMIUM_ZONES
  const out: BrowserItem[] = []
  for (const z of zones) {
    const zp = join(prof.root, ...z.rel.split('/'))
    const files = await walk(zp, 0)
    for (const f of files) {
      if (isForbiddenPath(f.path)) continue // 双保险
      out.push({ ...f, zone: z.rel, level: z.level, what: z.what })
    }
  }
  return out
}

async function walk(p: string, depth: number): Promise<Array<{ path: string; size: number; mtime: number }>> {
  if (depth > 5) return []
  const out: Array<{ path: string; size: number; mtime: number }> = []
  let ds: Awaited<ReturnType<typeof readdir>>
  try { ds = await readdir(p, { withFileTypes: true }) } catch { return [] }
  for (const d of ds) {
    if (isForbiddenPath(d.name)) continue
    const f = join(p, d.name)
    try {
      if (d.isDirectory()) out.push(...(await walk(f, depth + 1)))
      else {
        const s = await stat(f)
        out.push({ path: f, size: s.size, mtime: s.mtimeMs })
      }
    } catch { /* */ }
  }
  return out
}

/** 浏览器是否在运行（提示关闭） */
export async function browserRunning(browser: BrowserProfile['browser']): Promise<boolean> {
  const { execFile } = await import('child_process')
  const exe = browser === 'chrome' ? 'chrome.exe' : browser === 'edge' ? 'msedge.exe' : 'firefox.exe'
  return new Promise((res) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exe}`], { windowsHide: true }, (e, out) => {
      res(!e && String(out).toLowerCase().includes(exe))
    })
  })
}
