/**
 * 大文件体检分析器（v3.0 / G3）
 * 结论链：知识库规则 → 已装清单对照（requiresInstalled）→ 三档/未知
 * 红线 14：拿不准就 unknown；🔴/未知在"按建议处理"中不可勾选（UI 层强制）
 */
import type Database from 'better-sqlite3'
import { KB, ruleMatches, type KbRule, type Advice, type AnalyzeResult } from './kb'
import { stat } from 'fs/promises'

/** 从文件名提取软件名候选（用于已装对照） */
function guessSoftware(fileName: string): string[] {
  const n = fileName.toLowerCase()
  const out = new Set<string>()
  const push = (s: string | undefined): void => { if (s && s.length >= 2) out.add(s) }
  // xxx_setup / xxxsetup / WeChatSetup（去尾 setup/install 后的词）
  const m1 = n.match(/([a-z\u4e00-\u9fa5]+?)[\s_-]*(setup|install)/)
  if (m1) push(m1[1])
  // setup 前整段（wechatsetup → wechat：贪婪最小匹配已处理）
  const m2 = n.match(/(setup|install)[\s_-]*([a-z\u4e00-\u9fa5]+)/)
  if (m2) push(m2[2])
  // 中文名
  const m3 = n.match(/([\u4e00-\u9fa5]{2,})/)
  if (m3) push(m3[1])
  // 版本号前的主体（xxx_1.2.3 → xxx）
  const m4 = n.match(/^([a-z\u4e00-\u9fa5]+)[_\.\-]\d/)
  if (m4) push(m4[1])
  return [...out]
}

/** 软件名与已装清单匹配（复用 F5 的 installedNames 缓存思路，这里直接查 settings 缓存避免重扫注册表） */
function installedHit(guesses: string[], installed: Set<string>): string | null {
  for (const g of guesses) {
    if (g.length < 2) continue
    for (const inst of installed) {
      if (inst.includes(g) || g.includes(inst)) return inst
    }
  }
  return null
}

export interface AnalyzeInput {
  path: string
  name: string
  size: number
}

/** 单文件分析（installed：可选的已装软件名集合——来自 installedNames 的 24h 缓存） */
export async function analyzeFile(input: AnalyzeInput, installed?: Set<string>): Promise<AnalyzeResult> {
  const { name, path } = input
  // 系统路径前缀直接 danger
  const lp = path.toLowerCase()
  if (/(^|[\\/])(windows|program files|program files \(x86\))([\\/]|$)/.test(lp) && !lp.includes('users')) {
    return { what: '系统目录内的文件', advice: 'danger', why: '位于系统/程序目录——可能被正在使用的软件依赖，不建议手动删除。', generic: true }
  }
  // 知识库规则：文件名或父路径命中都算。
  // 优先级设计（分数从高到低）：
  //   ① 目录上下文（仅路径命中、文件名未命中——如 'WeChat Files/video.mp4' 的聊天上下文）+5000
  //      目录归属比扩展名更专属：微信目录里的 mp4 首先是聊天文件，其次才是视频
  //   ② 扩展名模式（. 开头，精确到文件类型）+1000
  //   ③ 模式词长度（长词更具体）
  const hitScore = (r: KbRule, viaPathOnly: boolean): number => {
    const best = Math.max(0, ...r.match.map((m) => m.length))
    const extBonus = r.match.some((m) => m.startsWith('.')) ? 1000 : 0
    return best + extBonus + (viaPathOnly ? 5000 : 0)
  }
  const hits = KB.filter((r) => ruleMatches(r, name) || ruleMatches(r, path))
    .map((r) => ({ r, po: !ruleMatches(r, name) && ruleMatches(r, path) }))
    .sort((a, b) => hitScore(b.r, b.po) - hitScore(a.r, a.po))
  const rule: KbRule | undefined = hits[0]?.r
  if (!rule) {
    // 未知：诚实说不知道 + 通用参考
    let lastAccess = ''
    try {
      const s = await stat(input.path)
      const days = Math.floor((Date.now() - s.mtimeMs) / 86400e3)
      lastAccess = days > 90 ? `该文件已 ${days} 天没改动过。` : ''
    } catch { /* */ }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '（无扩展名）'
    return {
      what: `未能识别的${ext}文件`,
      advice: 'unknown',
      why: `知识库没有覆盖这种文件——不装懂。${lastAccess}建议打开确认内容，或用搜索看看同目录还有什么线索。`,
      generic: true
    }
  }
  // requiresInstalled：安装包场景——已装 → 🟢；未装 → 🟡（可能是待安装的）
  if (rule.requiresInstalled) {
    const guesses = guessSoftware(name)
    const hit = installed ? installedHit(guesses, installed) : null
    if (hit) {
      return { what: rule.what, advice: 'safe', why: `注册表显示「${hit}」已安装——这个安装包已完成使命，可以安全删除（不影响已装软件）。`, kbId: rule.id }
    }
    if (installed && installed.size > 0) {
      return { what: rule.what, advice: 'caution', why: `注册表未找到对应已装软件——可能是还没安装的安装包。确认不需要安装再删。`, kbId: rule.id }
    }
    return { what: rule.what, advice: 'caution', why: '无法读取已安装清单（稍后自动重试）——先按谨慎处理。', kbId: rule.id }
  }
  return { what: rule.what, advice: rule.advice, why: rule.why, kbId: rule.id }
}

/** 批量（TOP 大文件场景；installed 惰性加载一次） */
export async function analyzeFiles(files: Array<AnalyzeInput>, installed?: Set<string>): Promise<Record<string, AnalyzeResult>> {
  const out: Record<string, AnalyzeResult> = {}
  for (const f of files) {
    out[f.path] = await analyzeFile(f, installed)
  }
  return out
}

/** 结论可否勾选（红线 14：🔴/未知不可进"按建议处理"） */
export function selectableAdvice(a: Advice): boolean {
  return a === 'safe' || a === 'caution'
}
