<script setup lang="ts">
/**
 * 命令面板（v3.3 / G7）：全局 Ctrl+K
 * 混合命令源：导航 / 动作 / 搜索透传 / 小数据（开机时长·C盘剩余）
 * 模糊匹配 + 使用频率记忆（localStorage）
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { lang, t } from '../i18n'

interface Cmd {
  id: string
  label: string
  hint?: string
  kind: 'nav' | 'action' | 'data' | 'search'
  run: () => void
}

const emit = defineEmits<{ (e: 'navigate', page: string): void }>()

const open = ref(false)
const q = ref('')
const sel = ref(0)
const dataCache = ref<Record<string, string>>({})

const bootText = computed(() => dataCache.value.boot || '')
const cDiskText = computed(() => dataCache.value.cdisk || '')

const nav = (page: string): void => { emit('navigate', page); open.value = false }

async function refreshData(): Promise<void> {
  try {
    const infos = (await window.cs?.sysInfo?.()) || ({} as { bootSec?: number })
    if (infos?.bootSec) dataCache.value.boot = `开机 ${Math.floor(infos.bootSec / 60)} 分钟`
    const disks = (await window.cs?.disks?.()) || []
    const c = disks.find((d: { mount?: string }) => d.mount === 'C:') as { free?: number } | undefined
    if (c) dataCache.value.cdisk = `C 盘剩余 ${(((c.free) || 0) / 1024 ** 3).toFixed(1)} GB`
  } catch { /* */ }
}

const commands = computed<Cmd[]>(() => [
  { id: 'nav-insight', label: computed(() => `${t('home') === 'Butler' ? 'Go ' : '去 '}${t('insight')}`).value, hint: 'Insight', kind: 'nav', run: () => nav('insight') },
  { id: 'nav-clean', label: '去 清扫', hint: '垃圾/聊天/浏览器/深度', kind: 'nav', run: () => nav('clean') },
  { id: 'nav-organize', label: '去 整理', hint: '查重/归档', kind: 'nav', run: () => nav('organize') },
  { id: 'nav-media', label: '去 媒体', hint: '图片/视频/时间线', kind: 'nav', run: () => nav('media') },
  { id: 'nav-speed', label: '去 提速', hint: '启动项/进程', kind: 'nav', run: () => nav('speed') },
  { id: 'nav-home', label: '去 管家', hint: '体检/设置', kind: 'nav', run: () => nav('home') },
  { id: 'act-scan', label: '开始扫描 C 盘', hint: '透视·全量', kind: 'action', run: () => { nav('insight'); setTimeout(() => window.dispatchEvent(new CustomEvent('cs:scan-c')), 300) } },
  { id: 'act-checkup', label: '一键体检', hint: '六维评分', kind: 'action', run: () => { nav('home'); setTimeout(() => window.dispatchEvent(new CustomEvent('cs:checkup')), 300) } },
  { id: 'act-recycle', label: '打开应用回收站', hint: '软删除恢复', kind: 'action', run: () => { nav('clean'); setTimeout(() => window.dispatchEvent(new CustomEvent('cs:recycle')), 300) } },
  { id: 'act-update', label: '检查更新', kind: 'action', run: () => { nav('home'); setTimeout(() => window.dispatchEvent(new CustomEvent('cs:update')), 300) } },
  ...(bootText.value ? [{ id: 'data-boot', label: `开机时长 · ${bootText.value}`, kind: 'data' as const, run: () => {} }] : []),
  ...(cDiskText.value ? [{ id: 'data-cdisk', label: `磁盘余量 · ${cDiskText.value}`, kind: 'data' as const, run: () => {} }] : []),
  ...(q.value.trim() ? [{ id: 'search', label: `搜索「${q.value.trim()}」`, hint: '全局文件搜索', kind: 'search' as const, run: () => { nav('insight'); setTimeout(() => window.dispatchEvent(new CustomEvent('cs:search', { detail: q.value.trim() })), 300) } }] : [])
])

/** 频率记忆 */
const freq = ref<Record<string, number>>({})
try { freq.value = JSON.parse(localStorage.getItem('cs-palette-freq') || '{}') } catch { /* */ }
function bump(id: string): void {
  freq.value[id] = (freq.value[id] || 0) + 1
  try { localStorage.setItem('cs-palette-freq', JSON.stringify(freq.value)) } catch { /* */ }
}

/** 模糊匹配（子序列 + 包含加权） */
function fuzzy(label: string, query: string): boolean {
  if (!query) return true
  const l = label.toLowerCase()
  const qq = query.toLowerCase()
  if (l.includes(qq)) return true
  let i = 0
  for (const ch of l) { if (ch === qq[i]) i++; if (i >= qq.length) return true }
  return false
}

const filtered = computed(() => {
  const f = commands.value.filter((c) => fuzzy(c.label, q.value))
  return f.sort((a, b) => (freq.value[b.id] || 0) - (freq.value[a.id] || 0))
})

watch(q, () => { sel.value = 0 })

function exec(c: Cmd): void {
  bump(c.id)
  c.run()
}

function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    open.value = !open.value
    if (open.value) { q.value = ''; void refreshData() }
    return
  }
  if (!open.value) return
  if (e.key === 'Escape') open.value = false
  else if (e.key === 'ArrowDown') { e.preventDefault(); sel.value = Math.min(sel.value + 1, filtered.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel.value = Math.max(sel.value - 1, 0) }
  else if (e.key === 'Enter') { const c = filtered.value[sel.value]; if (c) exec(c) }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cp-mask" @click.self="open = false">
      <div class="cp glass">
        <input v-model="q" class="cp-input" placeholder="输入命令或搜索…（导航 / 动作 / 搜索 / 数据）" autofocus />
        <div class="cp-list">
          <div
            v-for="(c, i) in filtered"
            :key="c.id"
            class="cp-item"
            :class="{ sel: i === sel }"
            @mouseenter="sel = i"
            @click="exec(c)"
          >
            <span class="cp-kind">{{ { nav: '🧭', action: '⚡', data: '📊', search: '🔎' }[c.kind] }}</span>
            <span class="cp-label">{{ c.label }}</span>
            <span v-if="c.hint" class="cp-hint">{{ c.hint }}</span>
            <span v-if="freq[c.id]" class="cp-freq">{{ freq[c.id] }}×</span>
          </div>
          <div v-if="!filtered.length" class="cp-empty">无匹配命令</div>
        </div>
        <div class="cp-foot">↑↓ 选择 · Enter 执行 · Esc 关闭 · Ctrl+K 呼出</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cp-mask { position: fixed; inset: 0; z-index: 120; background: rgba(2,4,12,0.55); backdrop-filter: blur(6px); display: flex; justify-content: center; align-items: flex-start; padding-top: 14vh; }
.cp { width: min(620px, 92vw); border-radius: 20px; overflow: hidden; animation: cpIn .14s ease-out; background: rgba(16,23,64,0.85); border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 24px 80px rgba(0,0,0,0.55); }
@keyframes cpIn { from { transform: translateY(-8px) scale(.98); opacity: 0 } to { transform: none; opacity: 1 } }
.cp-input { width: 100%; padding: 16px 20px; font-size: 15px; background: transparent; border: none; outline: none; color: #E8ECFA; border-bottom: 1px solid rgba(255,255,255,0.1); }
.cp-input::placeholder { color: rgba(232,236,250,0.35); }
.cp-list { max-height: 46vh; overflow-y: auto; padding: 6px; }
.cp-item { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 12px; cursor: pointer; font-size: 14px; }
.cp-item.sel { background: rgba(110,168,255,0.18); }
.cp-kind { width: 20px; text-align: center; }
.cp-hint { color: rgba(232,236,250,0.4); font-size: 12px; }
.cp-freq { margin-left: auto; color: rgba(168,199,255,0.55); font-size: 11px; }
.cp-empty { padding: 24px; text-align: center; color: rgba(232,236,250,0.4); font-size: 13px; }
.cp-foot { padding: 10px 18px; font-size: 11px; color: rgba(232,236,250,0.35); border-top: 1px solid rgba(255,255,255,0.08); }
</style>
