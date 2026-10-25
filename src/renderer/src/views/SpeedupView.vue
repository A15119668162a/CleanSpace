<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { tr } from '../i18n'
import { formatBytes } from '@shared/format'

/* ============ 类型 ============ */
interface StartupItem { id: string; source: string; name: string; command: string; enabled: boolean; advice?: string; needsAdmin: boolean; backupFile?: string }
interface ProcInfo { pid: number; name: string; memBytes: number; safeToKill: boolean }
interface SysStat { uptimeMs: number | null; cpu: { model: string; usage: number; cores: number }; mem: { totalBytes: number; usedBytes: number; usage: number }; disks: Array<{ drive: string; label: string; totalBytes: number; freeBytes: number; health: string | null }> }

/* ============ 状态 ============ */
const sub = ref<'overview' | 'startup' | 'procs'>('overview')
const message = ref('')

const stat = ref<SysStat | null>(null)
let statTimer: ReturnType<typeof setInterval> | null = null

const startups = ref<StartupItem[]>([])
const startupLoading = ref(false)
const toggling = ref<string>('')

const procs = ref<ProcInfo[]>([])
const procsLoading = ref(false)
const procsSearch = ref('')
const killing = ref(0)
const trimming = ref(false)

const sourceName: Record<string, string> = {
  'registry-hkcu-run': '注册表·用户', 'registry-hkcu-runonce': '注册表·用户 RunOnce',
  'registry-hklm-run': '注册表·系统', 'registry-hklm-runonce': '注册表·系统 RunOnce',
  'folder-user': '启动文件夹·用户', 'folder-common': '启动文件夹·公共', task: '计划任务'
}

onMounted(() => { void refreshStat(); void loadStartup(); statTimer = setInterval(() => void refreshStat(), 4000) })
onBeforeUnmount(() => { if (statTimer) clearInterval(statTimer) })

/* ============ 系统概况 ============ */
async function refreshStat(): Promise<void> {
  try { stat.value = await window.cs?.sysStat() || null } catch { /* 静默 */ }
}
function fmtUptime(ms: number): string {
  const m = Math.floor(ms / 60000)
  const h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d} 天 ${h % 24} 小时`
  if (h > 0) return `${h} 小时 ${m % 60} 分`
  return `${m} 分钟`
}

/* ============ 启动项 ============ */
async function loadStartup(): Promise<void> {
  startupLoading.value = true
  try { startups.value = (await window.cs?.startupList()) || [] } finally { startupLoading.value = false }
}

async function toggle(item: StartupItem): Promise<void> {
  toggling.value = item.id
  message.value = ''
  try {
    const to = !item.enabled
    if (!to && !window.confirm(`禁用「${item.name}」的开机自启？\n原始配置将完整备份，可随时恢复。`)) return
    const r = await window.cs!.startupToggle(item, to)
    message.value = to
      ? `已恢复「${item.name}」的自启（从备份还原）`
      : `已禁用「${item.name}」· 备份：${r.backupFile || ''}`
    await loadStartup()
  } catch (e) {
    message.value = `操作失败：${(e as Error).message}${item.needsAdmin ? '（该项需要管理员权限：请以管理员身份运行净澈）' : ''}`
  } finally {
    toggling.value = ''
  }
}

const enabledCount = computed(() => startups.value.filter((s) => s.enabled).length)

/* ============ 进程 ============ */
async function loadProcs(): Promise<void> {
  procsLoading.value = true
  try { procs.value = (await window.cs?.procsList()) || [] } finally { procsLoading.value = false }
}

const procsFiltered = computed(() => {
  const q = procsSearch.value.trim().toLowerCase()
  const list = q ? procs.value.filter((p) => p.name.toLowerCase().includes(q)) : procs.value
  return list.slice(0, 60)
})

async function kill(p: ProcInfo): Promise<void> {
  if (!window.confirm(`结束进程「${p.name}」(PID ${p.pid})？\n未保存的工作可能丢失。`)) return
  killing.value = p.pid
  try {
    await window.cs?.procsKill(p.pid, p.name)
    message.value = `已结束 ${p.name}`
    await loadProcs()
  } catch (e) {
    message.value = `结束失败：${(e as Error).message}`
  } finally {
    killing.value = 0
  }
}

async function trim(): Promise<void> {
  trimming.value = true
  try {
    const r = await window.cs?.trimMemory()
    message.value = `已请求 ${r?.trimmed || 0} 个进程整理内存工作集（${r?.skipped || 0} 个跳过）。提示：对日常卡顿帮助有限，重启最有效。`
  } finally {
    trimming.value = false
  }
}
</script>

<template>
  <div class="speed">
    <div class="tabs">
      <button class="tab" :class="{ active: sub === 'overview' }" @click="sub = 'overview'">{{ tr('tOverview') }}</button>
      <button class="tab" :class="{ active: sub === 'startup' }" @click="sub = 'startup'">{{ tr('tStartup') }}（{{ enabledCount }}/{{ startups.length }}）</button>
      <button class="tab" :class="{ active: sub === 'procs' }" @click="sub = 'procs'; loadProcs()">{{ tr('tProcess') }}</button>
    </div>

    <section v-if="message" class="glass msg">{{ message }}</section>

    <!-- ============ 系统概况 ============ -->
    <template v-if="sub === 'overview'">
      <section class="glass card">
        <div class="stat-grid">
          <div class="stat-cell">
            <div class="cell-label">开机时长</div>
            <div class="cell-val big">{{ stat?.uptimeMs != null ? fmtUptime(stat.uptimeMs) : '—' }}</div>
          </div>
          <div class="stat-cell">
            <div class="cell-label">CPU</div>
            <div class="cell-val big">{{ stat ? stat.cpu.usage.toFixed(0) + '%' : '—' }}</div>
            <div class="cell-sub">{{ stat?.cpu.cores || '—' }} 核 · {{ stat?.cpu.model?.split('(')[0]?.trim() || '' }}</div>
          </div>
          <div class="stat-cell">
            <div class="cell-label">内存</div>
            <div class="cell-val big">{{ stat ? stat.mem.usage.toFixed(0) + '%' : '—' }}</div>
            <div class="cell-sub">{{ stat ? formatBytes(stat.mem.usedBytes) + ' / ' + formatBytes(stat.mem.totalBytes) : '' }}</div>
          </div>
        </div>
        <div class="bars">
          <div class="bar-row">
            <span class="bar-label">CPU</span>
            <div class="bar"><div class="fill cpu" :style="{ width: (stat?.cpu.usage || 0) + '%' }"></div></div>
            <span class="bar-val">{{ stat?.cpu.usage.toFixed(0) || 0 }}%</span>
          </div>
          <div class="bar-row">
            <span class="bar-label">内存</span>
            <div class="bar"><div class="fill mem" :style="{ width: (stat?.mem.usage || 0) + '%' }"></div></div>
            <span class="bar-val">{{ stat?.mem.usage.toFixed(0) || 0 }}%</span>
          </div>
        </div>
      </section>

      <section class="glass card">
        <div class="card-head"><h3>💾 磁盘</h3></div>
        <div v-for="d in stat?.disks || []" :key="d.drive" class="disk-row">
          <span class="d-drive">{{ d.drive }}</span>
          <div class="d-main">
            <div class="d-label">{{ d.label }}<span v-if="d.health" class="d-health" :class="d.health.toLowerCase() === 'healthy' ? 'ok' : 'warn'">{{ d.health }}</span></div>
            <div class="bar"><div class="fill" :class="{ warn: (1 - d.freeBytes / d.totalBytes) > 0.9 }" :style="{ width: ((1 - d.freeBytes / Math.max(d.totalBytes, 1)) * 100).toFixed(1) + '%' }"></div></div>
          </div>
          <span class="d-free">剩 {{ formatBytes(d.freeBytes) }}</span>
        </div>
      </section>

      <section class="glass card action">
        <div>
          <h3>🧹 一键释放内存</h3>
          <p class="tip">请求各应用整理内存工作集。<b>诚实说明：对日常卡顿帮助有限，重启最有效。</b></p>
        </div>
        <button class="cs-btn" :disabled="trimming" @click="trim">{{ trimming ? '整理中…' : '释放内存' }}</button>
      </section>
    </template>

    <!-- ============ 启动项 ============ -->
    <template v-else-if="sub === 'startup'">
      <section class="glass card tip-card">
        <p class="tip">仅提供「启用 / 禁用」，<b>绝不删除</b>。禁用前自动完整备份（.reg / 快捷方式）到应用数据目录，可随时恢复。系统级项需以管理员身份运行。</p>
        <button class="cs-btn" :disabled="startupLoading" @click="loadStartup">{{ startupLoading ? '读取中…' : '刷新' }}</button>
      </section>

      <section v-for="s in startups" :key="s.id" class="glass s-item" :class="{ off: !s.enabled }">
        <div class="s-main">
          <div class="s-name">{{ s.name }} <span class="s-src">{{ sourceName[s.source] || s.source }}</span><span v-if="s.needsAdmin" class="s-admin">需管理员</span></div>
          <div class="s-cmd" :title="s.command">{{ s.command }}</div>
          <div v-if="s.advice" class="s-advice">💡 {{ s.advice }}</div>
          <div v-if="!s.enabled && s.backupFile" class="s-bak">备份：{{ s.backupFile }}</div>
        </div>
        <button class="switch" :class="{ on: s.enabled }" :disabled="toggling === s.id" @click="toggle(s)">
          <span class="knob"></span>
        </button>
      </section>
      <section v-if="!startups.length && !startupLoading" class="glass empty">没有发现启动项</section>
    </template>

    <!-- ============ 进程 ============ -->
    <template v-else>
      <section class="glass card tip-card">
        <input v-model="procsSearch" class="search" placeholder="搜索进程名…" spellcheck="false" />
        <button class="cs-btn" :disabled="procsLoading" @click="loadProcs">{{ procsLoading ? '读取中…' : '刷新' }}</button>
      </section>
      <section class="glass table-card">
        <div class="tbl-head"><span class="c-name">进程</span><span class="c-pid">PID</span><span class="c-mem">内存</span><span class="c-ops"></span></div>
        <div class="tbl-body">
          <div v-for="p in procsFiltered" :key="p.pid" class="tbl-row">
            <span class="c-name">
              {{ p.name }}
              <span v-if="!p.safeToKill" class="tag sys">系统关键</span>
            </span>
            <span class="c-pid">{{ p.pid }}</span>
            <span class="c-mem">{{ formatBytes(p.memBytes) }}</span>
            <span class="c-ops">
              <button v-if="p.safeToKill" class="op del" :disabled="killing === p.pid" @click="kill(p)">{{ killing === p.pid ? '结束中…' : '结束' }}</button>
            </span>
          </div>
        </div>
        <p class="tip center">标注「系统关键」的进程不提供结束按钮。结束前请确认已保存工作。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.speed { display: flex; flex-direction: column; gap: 14px; padding-bottom: 12px; }
.tabs { display: flex; gap: 8px; }
.tab { padding: 8px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.tab.active { color: #0A1128; font-weight: 700; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }
.msg { padding: 12px 20px; font-size: 13px; color: #A8C7FF; line-height: 1.6; word-break: break-all; }

.card { padding: 20px 24px; }
.card-head { margin-bottom: 12px; }
.stat-grid { display: flex; gap: 14px; margin-bottom: 18px; flex-wrap: wrap; }
.stat-cell { flex: 1; min-width: 150px; padding: 16px; border-radius: 16px; background: rgba(255,255,255,0.05); text-align: center; }
.cell-label { font-size: 11.5px; color: var(--text-3); margin-bottom: 8px; }
.cell-val.big { font-size: 24px; font-weight: 700; }
.cell-sub { font-size: 11px; color: var(--text-3); margin-top: 6px; }
.bars { display: flex; flex-direction: column; gap: 10px; }
.bar-row { display: grid; grid-template-columns: 44px 1fr 60px; gap: 12px; align-items: center; }
.bar-label { font-size: 12px; color: var(--text-2); }
.bar { height: 12px; border-radius: 8px; background: rgba(255,255,255,0.08); overflow: hidden; }
.fill { height: 100%; border-radius: 8px; transition: width .6s ease; background: linear-gradient(90deg, #6EA8FF, #37D399); }
.fill.cpu { background: linear-gradient(90deg, #6EA8FF, #B39DFF); }
.fill.mem { background: linear-gradient(90deg, #37D399, #6EA8FF); }
.fill.warn { background: linear-gradient(90deg, #FFB86C, #FF5D6C); }
.bar-val { font-size: 12px; color: var(--text-2); text-align: right; font-variant-numeric: tabular-nums; }

.disk-row { display: grid; grid-template-columns: 44px 1fr 100px; gap: 12px; align-items: center; padding: 10px 4px; }
.d-drive { font-size: 16px; font-weight: 700; color: #6EA8FF; }
.d-label { font-size: 12.5px; margin-bottom: 6px; display: flex; gap: 8px; align-items: center; }
.d-health { font-size: 10px; padding: 1px 8px; border-radius: 999px; }
.d-health.ok { color: #37D399; background: rgba(55,211,153,0.12); }
.d-health.warn { color: #FFB86C; background: rgba(255,184,108,0.12); }
.d-free { font-size: 11.5px; color: var(--text-3); text-align: right; }

.action { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.action h3 { font-size: 15px; margin-bottom: 6px; }
.tip { font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
.tip.center { text-align: center; margin-top: 10px; }
.tip-card { display: flex; justify-content: space-between; align-items: center; gap: 14px; }

.s-item { display: flex; align-items: center; gap: 16px; padding: 14px 22px; }
.s-item.off { opacity: 0.75; }
.s-main { flex: 1; min-width: 0; }
.s-name { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.s-src { font-size: 10.5px; color: var(--text-3); padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.07); }
.s-admin { font-size: 10.5px; color: #FFB86C; padding: 2px 8px; border-radius: 999px; background: rgba(255,184,108,0.1); }
.s-cmd { font-size: 11.5px; color: var(--text-2); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-advice { font-size: 11.5px; color: #A8C7FF; margin-top: 5px; }
.s-bak { font-size: 10.5px; color: var(--text-3); margin-top: 4px; word-break: break-all; }

.switch { width: 46px; height: 26px; border-radius: 999px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.18); position: relative; cursor: pointer; flex-shrink: 0; transition: all .2s; }
.switch.on { background: linear-gradient(135deg, #6EA8FF, #37D399); border-color: transparent; }
.switch:disabled { opacity: 0.5; cursor: wait; }
.knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .2s; }
.switch.on .knob { left: 22px; }
.empty { padding: 40px; text-align: center; color: var(--text-3); }

.search { flex: 1; padding: 9px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; }
.table-card { padding: 14px 20px; }
.tbl-head, .tbl-row { display: grid; grid-template-columns: 1fr 80px 110px 90px; gap: 10px; align-items: center; }
.tbl-head { padding: 8px 12px; font-size: 11px; color: var(--text-3); border-bottom: 1px solid rgba(255,255,255,0.08); }
.tbl-body { max-height: 480px; overflow-y: auto; }
.tbl-row { padding: 8px 12px; border-radius: 10px; font-size: 12.5px; min-height: 36px; }
.tbl-row:hover { background: rgba(255,255,255,0.05); }
.c-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-pid { color: var(--text-3); font-variant-numeric: tabular-nums; }
.c-mem { color: #A8C7FF; text-align: right; font-variant-numeric: tabular-nums; }
.c-ops { text-align: right; }
.tag.sys { font-size: 10px; color: var(--text-3); background: rgba(255,255,255,0.08); padding: 1px 8px; border-radius: 999px; margin-left: 6px; }
.op.del { padding: 4px 12px; border-radius: 8px; font-size: 11.5px; color: #FF5D6C; background: rgba(255,93,108,0.1); border: 1px solid rgba(255,93,108,0.3); cursor: pointer; }
.op.del:disabled { opacity: 0.5; }
</style>
