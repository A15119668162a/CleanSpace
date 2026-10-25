/**
 * 白名单匹配核心（纯逻辑，可独立测试）
 * 安全红线 #1：白名单目录中的文件只允许"定位"，不允许批量删除/移动
 */

export interface WhitelistRule {
  id: number
  pattern: string // glob，支持 * 与 **
  enabled: boolean
  builtin: boolean
  note?: string
}

/** 将 Windows 路径统一为小写、正斜杠，便于匹配 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/** glob → 正则：** 匹配任意层级，* 匹配单层内任意字符 */
export function globToRegExp(glob: string): RegExp {
  const n = normalizePath(glob)
  let re = ''
  let i = 0
  while (i < n.length) {
    const c = n[i]
    if (c === '*') {
      if (n[i + 1] === '*') {
        // "**" —— 匹配任意字符（含 /）
        re += '.*'
        i += 2
        // 吃掉紧随的 "/"
        if (n[i] === '/') i++
      } else {
        // "*" —— 匹配除 / 外任意字符
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return new RegExp('^' + re + '$')
}

/** 默认内置白名单（文档第四章红线，默认开启保护） */
export const BUILTIN_WHITELIST: Array<{ pattern: string; note: string }> = [
  { pattern: 'C:/Windows/**', note: '系统目录' },
  { pattern: 'C:/Program Files/**', note: '系统目录' },
  { pattern: 'C:/Program Files (x86)/**', note: '系统目录' },
  { pattern: 'C:/Program Files (Arm)/**', note: '系统目录' },
  { pattern: 'C:/Users/*/Documents/**', note: '用户文档默认目录' },
  // 聊天记录目录硬保护（即使规则变化，这里永远兜底）
  { pattern: 'C:/Users/*/Documents/WeChat Files/**', note: '微信聊天记录' },
  { pattern: 'C:/Users/*/Documents/xwechat_files/**', note: '微信聊天记录' },
  { pattern: 'C:/Users/*/Documents/Tencent Files/**', note: 'QQ 聊天记录' },
  { pattern: 'C:/Users/*/AppData/Roaming/DingTalk/**', note: '钉钉数据' }
]

/**
 * v4.2.2 安全口袋：保护伞内公认的安全垃圾位置。
 * 这些路径在系统目录里，但属于临时/缓存/更新残留——Windows 自身的磁盘清理也清它们。
 * 命中口袋 = 不视为受保护（清理仍走软删除可撤销；红线 1 的关键是"不破坏系统"，而非"不清临时文件"）。
 * 注意：仅精确目录前缀（支持一个 * 单层通配）；Program Files 内一律不清。
 */
export const SAFE_POCKETS: string[] = [
  'c:/windows/temp',                            // 系统临时
  'c:/windows/softwaredistribution/download',   // 更新残留下载
  'c:/windows/minidump',                        // 崩溃转储
  'c:/windows/prefetch',                        // 预读取缓存（可重建）
  'c:/windows/logs/cbs',                        // 组件日志
  'c:/windows/softwaredistribution/datastore/logs', // 更新服务日志
  'c:/users/*/appdata/local/microsoft/windows/wer', // 错误报告（用户侧）
  'c:/users/*/appdata/local/crashdumps'         // 应用崩溃转储（用户侧）
]

/** 路径是否落在安全口袋内（口袋段支持 * 单层通配；子路径同样命中） */
function pocketMatch(pocket: string, np: string): boolean {
  const re = pocket
    .split('/')
    .map((seg) => (seg === '*' ? '[^/]+' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp('^' + re + '(/|$)').test(np)
}

export function isSafePocket(path: string): boolean {
  const np = normalizePath(path)
  return SAFE_POCKETS.some((pocket) => pocketMatch(pocket, np))
}

/**
 * 判断路径是否受白名单保护
 * v4.2.2：先判安全口袋（口袋内=公认安全垃圾，不受保护伞拦截——解决"垃圾也在保护目录里"）
 */
export function isProtected(path: string, rules: WhitelistRule[], opts?: { safePockets?: boolean }): boolean {
  // v4.2.2 安全口袋（可在设置中整体关闭恢复"全保护"）：命中即不保护（可清，仍软删除可撤销）
  if (opts?.safePockets !== false && isSafePocket(path)) return false
  const np = normalizePath(path)
  for (const r of rules) {
    if (!r.enabled) continue
    if (globToRegExp(r.pattern).test(np)) return true
    // pattern 以 /** 结尾时，目录本身也受保护
    if (r.pattern.endsWith('/**')) {
      const base = normalizePath(r.pattern.slice(0, -3))
      if (np === base) return true
    }
  }
  return false
}

/** 从一组文件路径中过滤出受保护的（用于测试与预览界面警示） */
export function filterProtected(paths: string[], rules: WhitelistRule[]): string[] {
  return paths.filter((p) => isProtected(p, rules))
}
