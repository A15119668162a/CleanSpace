/**
 * i18n 运行时（v3.4 / G8）：轻量自制（项目词典量可控，免引 vue-i18n 运行时依赖）
 * zh 源语言；语言持久化 localStorage + settings 表；响应式全局 lang。
 */
import { ref, computed } from 'vue'
import { dict, type Lang } from './dict'

/**
 * 初始语言（v4.2 修复）：
 * 1) 用户手动选过 → 尊重选择（localStorage）
 * 2) 否则 → 自动识别系统语言（navigator.language 以 zh 开头→中文，其余→英文）
 */
export const lang = ref<Lang>(((): Lang => {
  try {
    const v = localStorage.getItem('cs-lang')
    if (v === 'en' || v === 'zh') return v
  } catch { /* */ }
  const sys = (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh'
  return /^zh/i.test(sys) ? 'zh' : 'en'
})())

export function setLang(l: Lang): void {
  lang.value = l
  try { localStorage.setItem('cs-lang', l) } catch { /* */ }
  void window.cs?.settingsSet?.('ui_lang', l).catch?.(() => undefined)
}

/** 翻译函数：t('scanC') → 当前语言文案；未知 key 原样返回（可发现漏词） */
export function t(key: string): string {
  const d = dict(lang.value) as Record<string, string>
  return d[key] ?? key
}

export const tr = computed(() => (key: string): string => t(key))

/* ---------- v4.2.1：IPC 参数净化（contextBridge 桥前置） ----------
 * 桥会先对参数结构化克隆——Vue 响应式 Proxy 在桥上就炸（"An object
 * could not be cloned"），preload 里的净化来不及。故在页面侧包一层
 * window.cs 代理：每个调用的对象参数先剥成纯数据再过桥。
 */

/** 递归剥 Proxy/Class 为纯数据（可结构化克隆） */
export function purify<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => purify(x)) as unknown as T
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>)) {
    out[k] = purify((v as Record<string, unknown>)[k])
  }
  return out as T
}

/** 包装 window.cs：所有方法参数过 purify 再调用原实现 */
export function installIpcGuard(): void {
  const cs = (window as unknown as { cs?: Record<string, unknown> }).cs
  if (!cs || (cs as unknown as { __guard?: boolean }).__guard) return
  const wrapped: Record<string, unknown> = { __guard: true }
  for (const key of Object.keys(cs)) {
    const fn = cs[key]
    if (typeof fn !== 'function') { wrapped[key] = fn; continue }
    wrapped[key] = (...args: unknown[]): unknown =>
      (fn as (...a: unknown[]) => unknown).apply(cs, args.map((a) => (a && typeof a === 'object' ? purify(a) : a)))
  }
  Object.defineProperty(window, 'cs', { value: wrapped, configurable: true, writable: true })
}
