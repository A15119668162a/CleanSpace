/**
 * 垃圾清扫规则引擎（P2）
 * 三级风险：safe（默认勾选）/ caution（默认不勾，逐项说明）/ expert（默认隐藏，需展开+后果说明）
 * 安全红线：HARD_EXCLUDE 硬排除——聊天记录、浏览器配置（书签/密码）等绝不进入任何扫描结果
 */
import { join } from 'path'
import { homedir } from 'os'
import { isProtected, globToRegExp } from '../../shared/whitelist'

export type RiskLevel = 'safe' | 'caution' | 'expert'

export interface JunkRule {
  id: string
  name: string
  desc: string
  risk: RiskLevel
  /** 结果说明（清理后影响） */
  consequence?: string
  /** 候选目录/文件（返回绝对路径；不存在即跳过） */
  targets: () => string[]
  /** 目录内只清文件不动子目录结构？默认整目录内容可清 */
  filesOnly?: boolean
  /** glob 排除（相对 target 内部），如 *.db */
  excludeGlobs?: string[]
}

/** 硬排除（红线）：这些路径模式绝不进入扫描结果（即使规则命中） */
export const HARD_EXCLUDE: Array<{ pattern: string; why: string }> = [
  // 聊天记录（文档第四章红线 #6）
  { pattern: 'C:/Users/*/Documents/WeChat Files/**', why: '微信聊天记录' },
  { pattern: 'C:/Users/*/Documents/xwechat_files/**', why: '微信聊天记录' },
  { pattern: 'C:/Users/*/Documents/Tencent Files/**', why: 'QQ 聊天记录' },
  { pattern: 'C:/Users/*/AppData/Roaming/DingTalk/**', why: '钉钉数据' },
  // 浏览器书签与密码（红线 #6）
  { pattern: 'C:/Users/*/AppData/Local/Google/Chrome/User Data/*/Bookmarks', why: 'Chrome 书签' },
  { pattern: 'C:/Users/*/AppData/Local/Google/Chrome/User Data/*/Login Data*', why: 'Chrome 密码' },
  { pattern: 'C:/Users/*/AppData/Local/Microsoft/Edge/User Data/*/Bookmarks', why: 'Edge 书签' },
  { pattern: 'C:/Users/*/AppData/Local/Microsoft/Edge/User Data/*/Login Data*', why: 'Edge 密码' },
  { pattern: 'C:/Users/*/AppData/Roaming/Mozilla/Firefox/Profiles/*/places.sqlite*', why: 'Firefox 书签/历史' },
  { pattern: 'C:/Users/*/AppData/Roaming/Mozilla/Firefox/Profiles/*/logins.json*', why: 'Firefox 密码' },
  { pattern: 'C:/Users/*/AppData/Roaming/Mozilla/Firefox/Profiles/*/key4.db', why: 'Firefox 密码库' },
  // 微信/QQ 数据目录整体（只允许其 Cache 子目录通过专门规则，见 rules）
  { pattern: 'C:/Users/*/Documents/WeChat Files', why: '微信数据根（仅 Cache 子目录按规则处理）' }
]

const hd = homedir()

function u(...seg: string[]): string {
  return join(hd, ...seg)
}

/**
 * 微信/QQ 缓存定位：只找明确的 Cache 类子目录，绝不触碰聊天记录
 * 微信 4.x: Documents/xwechat_files/wxid_xxx/attachments/cache 等新版结构较杂，
 * 保守策略：仅当路径段中含 'cache'（小写比较）且不属于 Documents 直属数据时才视为缓存
 */
function wechatCacheDirs(): string[] {
  const out: string[] = []
  const bases = [u('Documents', 'xwechat_files'), u('Documents', 'WeChat Files')]
  void bases
  // 新版微信缓存实际在 AppData：
  out.push(u('AppData', 'Roaming', 'Tencent', 'xwechat', 'files', 'wxid_*', 'cache'))
  return out
}

/** 规则注册表（顺序即展示顺序） */
export function allRules(): JunkRule[] {
  const LOCAL = u('AppData', 'Local')
  return [
    // ---------- 安全级 ----------
    {
      id: 'temp-user',
      name: '系统临时目录',
      desc: 'Windows 与各软件的临时文件（%TEMP%）',
      risk: 'safe',
      targets: () => [u('AppData', 'Local', 'Temp')]
    },
    {
      id: 'thumb-cache',
      name: '缩略图缓存',
      desc: '资源管理器图片/视频缩略图，清除后自动重建',
      risk: 'safe',
      targets: () => [join(LOCAL, 'Microsoft', 'Windows', 'Explorer')]
    },
    {
      id: 'browser-cache-chrome',
      name: 'Chrome 浏览器缓存',
      desc: '网页缓存，不含书签、密码、历史',
      risk: 'safe',
      filesOnly: true,
      excludeGlobs: ['Bookmarks*', 'Login Data*', 'Web Data*', 'History*', 'Cookies*', 'Preferences', 'Secure Preferences', 'Extension*'],
      targets: () => [join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache')]
    },
    {
      id: 'browser-cache-edge',
      name: 'Edge 浏览器缓存',
      desc: '网页缓存，不含书签、密码、历史',
      risk: 'safe',
      filesOnly: true,
      excludeGlobs: ['Bookmarks*', 'Login Data*', 'Web Data*', 'History*', 'Cookies*', 'Preferences', 'Secure Preferences', 'Extension*'],
      targets: () => [join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache')]
    },
    {
      id: 'win-update',
      name: 'Windows 更新缓存',
      desc: '已安装更新的残留下载文件',
      risk: 'safe',
      targets: () => [join('C:', 'Windows', 'SoftwareDistribution', 'Download')]
    },
    {
      id: 'wer',
      name: '错误报告与崩溃转储',
      desc: 'Windows 错误报告（WER）与内存转储',
      risk: 'safe',
      targets: () => [join(LOCAL, 'Microsoft', 'Windows', 'WER'), join(LOCAL, 'CrashDumps'), join('C:', 'Windows', 'Minidump')]
    },
    // ---------- 谨慎级（默认不勾选） ----------
    {
      id: 'wechat-cache',
      name: '微信缓存（不动聊天记录）',
      desc: '仅微信明确的 Cache 目录；聊天记录、图片视频文件绝不触碰',
      risk: 'caution',
      targets: wechatCacheDirs
    },
    {
      id: 'qq-cache',
      name: 'QQ 缓存（不动聊天记录）',
      desc: '仅 NTQQ 的 cache_cache 子目录；聊天记录目录硬排除',
      risk: 'caution',
      targets: () => [join(LOCAL, 'Tencent', 'NTQQ', 'cache_cache')]
    },
    {
      id: 'dns-flush-dir',
      name: 'DNS 客户端缓存目录',
      desc: '系统 DNS 缓存落盘文件',
      risk: 'caution',
      targets: () => [join(LOCAL, 'Microsoft', 'Windows', 'INetCache')]
    },
    // ---------- 专家级（默认隐藏） ----------
    {
      id: 'hiberfil',
      name: '休眠文件 hiberfil.sys',
      desc: '休眠功能占用约等于内存大小',
      consequence: '清除后「休眠」不可用（睡眠不受影响）；可用 powercfg /h on 恢复',
      risk: 'expert',
      targets: () => [join('C:', 'hiberfil.sys')]
    },
    {
      id: 'memdump',
      name: '完整内存转储 MEMORY.DMP',
      desc: '蓝屏时生成的完整内存映像',
      consequence: '清除后无法回溯本次蓝屏细节',
      risk: 'expert',
      targets: () => [join('C:', 'Windows', 'MEMORY.DMP')]
    }
  ]
}

/** 硬排除判定（红线：扫描结果过滤前的最后一道闸） */
export function isHardExcluded(path: string): boolean {
  const np = path.replace(/\\/g, '/').toLowerCase()
  return HARD_EXCLUDE.some((h) => {
    // 目录树模式（** 结尾）
    const rules = [{ id: -1, pattern: h.pattern, enabled: true, builtin: true }]
    if (isProtected(path, rules)) return true
    // 精确/通配文件模式
    if (globToRegExp(h.pattern).test(np)) return true
    return false
  })
}

/** 白名单判定（复用全局白名单规则） */
export function isWhitelisted(
  path: string,
  whitelistRules: Array<{ id: number; pattern: string; enabled: boolean; builtin: boolean; note?: string }>,
  opts?: { safePockets?: boolean }
): boolean {
  return isProtected(path, whitelistRules, opts)
}
