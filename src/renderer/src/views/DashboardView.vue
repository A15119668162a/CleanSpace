<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { formatBytes } from '@shared/format'

/* ---------- 事件总线（去处理跳转） ---------- */
const props = defineProps<{ onNavigate?: (page: string) => void }>()
const emit = defineEmits<{ (e: 'navigate', page: string): void }>()

interface Dim { id: string; name: string; score: number; display: string; advice: string; fix: string }
interface Checkup { score: number; ts: number; dimensions: Dim[] }

const sub = ref<'health' | 'redlines' | 'settings'>('health')
const checking = ref(false)
const result = ref<Checkup | null>(null)
const history = ref<Array<{ ts: number; score: number }>>([])
const message = ref('')

/* 设置 */
const settings = ref<{ recycleKeepDays: number; autoStart: boolean; weeklyScan: boolean; closeToTray?: boolean } | null>(null)
const wlList = ref<Array<{ id: number; pattern: string; enabled: boolean; builtin: boolean; note?: string }>>([])
const wlPattern = ref('')
const wlNote = ref('')
const wlError = ref('')

/* 自动更新（v2.4 F8） */
const updStatus = ref<{ state: string; version?: string; progress?: number; error?: string } | null>(null)
const updChecking = ref(false)
let offUpd: (() => void) | null = null

async function checkUpdate(): Promise<void> {
  updChecking.value = true
  try {
    await window.cs?.updateCheck() // 主进程 15s 硬超时——不再悬挂
    const st = (await window.cs?.updateStatus()) || null
    // v4.2.9：陈旧 error 不显示（上次运行的错误状态残留在 DB——「点了没反应」观感根因）
    if (st && st.state === 'error' && st.ts && Date.now() - st.ts > 60000) {
      updStatus.value = null
    } else {
      updStatus.value = st
    }
    if (!updStatus.value && st === null) updStatus.value = { state: 'error', error: 'timeout' }
  } catch {
    updStatus.value = { state: 'error' }
  } finally {
    updChecking.value = false
  }
}
async function installUpdate(): Promise<void> {
  if (!window.confirm('立即重启并安装新版本？')) return
  await window.cs?.updateInstall()
}

/* 界面语言（v3.4 G8） */
import { lang as uiLangRef, setLang, tr } from '../i18n'
const uiLang = uiLangRef
function onLangChange(e: Event): void { setLang((e.target as HTMLSelectElement).value as 'zh' | 'en') }

/* 崩溃恢复横幅 + 启动自检（v4.1） */
const crashInfo = ref<{ version: string; ts: number; kindText: string; summary: string } | null>(null)
const checks = ref<Array<{ id: string; label: string; ok: boolean; note?: string }>>([])
const checksOpen = ref(false)

async function loadCrashAndChecks(): Promise<void> {
  try { crashInfo.value = await window.cs?.crashLast() || null } catch { /* */ }
}

/* v4.2.2 安全口袋开关（系统目录内公认安全垃圾可清） */
const safePockets = ref(true)
async function loadSafePockets(): Promise<void> {
  safePockets.value = (await window.cs?.safePocketsGet()) ?? true
}
async function toggleSafePockets(): Promise<void> {
  safePockets.value = !safePockets.value
  await window.cs?.safePocketsSet(safePockets.value)
}

/* 安全红线（v4.0 方向 A：用户可读可验证的承诺清单） */
interface Rl { no: number; title: string; plain: string; guard: string; since: string }
const redlines = ref<Rl[]>([])
async function switchRedlines(): Promise<void> {
  sub.value = 'redlines'
  if (!redlines.value.length) redlines.value = (await window.cs?.redlinesList()) || []
}

/* 自动清理规则（v3.1 G10——红线 16：只到软删除、白名单禁选、超限只报警） */
interface AutoRule { id: number; dir: string; pattern: string; keepDays: number; enabled: number; builtin: number; note?: string }
const autoRules = ref<AutoRule[]>([])
const arBusy = ref(false)
const arMsg = ref('')
const newRuleDir = ref('')
const newRulePattern = ref('*.exe')
const newRuleDays = ref(90)

async function loadAutoRules(): Promise<void> {
  autoRules.value = (await window.cs?.autoRulesList()) || []
}
async function addAutoRule(): Promise<void> {
  arBusy.value = true
  arMsg.value = ''
  try {
    const r = await window.cs?.autoRulesSave({ dir: newRuleDir.value.trim(), pattern: newRulePattern.value.trim(), keepDays: newRuleDays.value, enabled: 0 })
    arMsg.value = r?.ok ? '已添加（默认停用，预览命中后开启）' : (r?.reason || '添加失败')
    if (r?.ok) { newRuleDir.value = ''; await loadAutoRules() }
  } finally { arBusy.value = false }
}
async function previewRule(id: number): Promise<void> {
  const r = await window.cs?.autoRulesPlan(id)
  if (!r) return
  if (r.overflow) { arMsg.value = `⚠️ ${r.overflowReason}`; return }
  arMsg.value = `命中 ${r.hits.length} 个文件 · ${(r.totalBytes / 1024 ** 2).toFixed(1)}MB（下周体检生成软删除预案，回收站确认）`
}
async function toggleRule(r0: AutoRule): Promise<void> {
  // 红线 16：开启前强制预览——先 preview 再允许 enable
  if (r0.enabled === 0 && !confirm('开启前请先「预览命中」确认范围。确认已了解并开启？')) return
  await window.cs?.autoRulesSave({ id: r0.id, dir: r0.dir, pattern: r0.pattern, keepDays: r0.keepDays, enabled: r0.enabled === 0 ? 1 : 0 })
  await loadAutoRules()
}

/* 月度报告（v2.3 F7） */
const reports = ref<Array<{ month: string; file: string }>>([])
const reportMonth = ref('')

async function loadReports(): Promise<void> {
  reports.value = (await window.cs?.reportList()) || []
}
async function genReport(): Promise<void> {
  const m = reportMonth.value.trim() || new Date().toISOString().slice(0, 7)
  const p = await window.cs?.reportGenerate(m)
  if (p) message.value = `已生成 ${m} 报告：${p}`
  await loadReports()
}

/* 空间预警（v2.1 F4） */
const alertCfg = ref<{ intervalMin: number; cThresholdGB: number; otherThresholdGB: number; enabled: boolean } | null>(null)

async function saveAlert(cfg: { enabled?: boolean; cThresholdGB?: number; otherThresholdGB?: number; intervalMin?: number }): Promise<void> {
  await window.cs?.alertSet(cfg)
  alertCfg.value = (await window.cs?.alertConfig()) || null
  void loadReports()
  void loadAutoRules()
}

const scoreColor = computed(() => {
  const s = result.value?.score ?? 100
  return s >= 80 ? '#37D399' : s >= 60 ? '#6EA8FF' : s >= 40 ? '#FFB86C' : '#FF5D6C'
})
const scoreText = computed(() => {
  const s = result.value?.score ?? 100
  return s >= 90 ? '优秀' : s >= 80 ? '良好' : s >= 60 ? '一般' : s >= 40 ? '较差' : '需要处理'
})

const fixPage: Record<string, string> = { clean: '清扫垃圾', insight: '空间透视', speedup: '提速中心', recycle: '回收站' }

function goFix(fix: string): void {
  const pageMap: Record<string, string> = { clean: 'clean', insight: 'insight', speedup: 'speedup', recycle: 'clean' }
  emit('navigate', pageMap[fix] || 'clean')
  props.onNavigate?.(pageMap[fix] || 'clean')
}

async function runCheck(): Promise<void> {
  checking.value = true
  message.value = ''
  try {
    result.value = (await window.cs?.checkupRun()) || null
    history.value = (await window.cs?.checkupHistory()) || []
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    checking.value = false
  }
}

async function loadSettings(): Promise<void> {
  settings.value = (await window.cs?.settingsGet()) || null
  wlList.value = (await window.cs?.whitelistAll()) || []
  alertCfg.value = (await window.cs?.alertConfig()) || null
  void loadReports()
  void loadAutoRules()
}

async function setSetting(key: string, value: string): Promise<void> {
  await window.cs?.settingsSet(key, value)
  await loadSettings()
}

async function addWl(): Promise<void> {
  wlError.value = ''
  const r = await window.cs?.whitelistAdd(wlPattern.value.trim(), wlNote.value.trim())
  if (!r?.ok) { wlError.value = r?.error || '添加失败'; return }
  wlPattern.value = ''
  wlNote.value = ''
  await loadSettings()
}

async function delWl(id: number): Promise<void> {
  const ok = await window.cs?.whitelistRemove(id)
  if (!ok) { wlError.value = '内置规则不可删除（可停用）'; return }
  await loadSettings()
}

async function toggleWl(item: { id: number; enabled: boolean }): Promise<void> {
  await window.cs?.whitelistToggle(item.id, !item.enabled)
  await loadSettings()
}

async function exportLogs(): Promise<void> {
  const r = await window.cs?.logsExport()
  if (r) message.value = `已导出 ${r.rows} 条操作日志`
}

const fmtTime = (ts: number): string => new Date(ts).toLocaleString('zh-CN', { hour12: false })

window.addEventListener('cs:checkup', () => { void runCheckup?.() })
window.addEventListener('cs:update', () => { void checkUpdate?.() })
async function pickNewRuleDir(): Promise<void> { const d = await window.cs?.pickDir?.('选择自动清理的目标目录'); if (d) newRuleDir.value = d }

async function pickWlPattern(): Promise<void> { const d = await window.cs?.pickDir?.('选择要保护的目录'); if (d) wlPattern.value = d }

onMounted(async () => {
  offUpd = window.cs?.onUpdateStatus?.((s) => { updStatus.value = s }) || null
  result.value = (await window.cs?.checkupLast()) || null
  history.value = (await window.cs?.checkupHistory()) || []
  void loadSettings()
  void loadCrashAndChecks()
  void loadSafePockets()
})
</script>

<template>
  <div class="dash">
    <div class="tabs">
      <button class="tab" :class="{ active: sub === 'health' }" @click="sub = 'health'">{{ tr('tHealth') }}</button>
      <button class="tab" :class="{ active: sub === 'settings' }" @click="sub = 'settings'; loadSettings()">{{ tr('tSettings') }}</button>
      <button class="tab" :class="{ active: sub === 'redlines' }" @click="switchRedlines()">{{ tr('tRedlines') }}</button>
    </div>

    <section v-if="message" class="glass msg">{{ message }}</section>

    <!-- v4.1 崩溃恢复横幅 -->
    <section v-if="crashInfo" class="glass crash-banner">
      <span>🔧 检测到上次异常退出（{{ crashInfo.kindText }} · v{{ crashInfo.version }} · {{ new Date(crashInfo.ts).toLocaleString('zh-CN', { hour12: false }) }}）</span>
      <span class="crash-sum" :title="crashInfo.summary">{{ crashInfo.summary.slice(0, 60) }}</span>
      <button class="op" @click="crashInfo = null">知道了</button>
    </section>

    <!-- v4.1 启动自检 -->
    <section class="glass sc-bar">
      <span>🩺 启动自检</span>
      <button class="op" @click="checksOpen = !checksOpen; if (checksOpen && !checks.length) void (async () => { checks = (await window.cs?.selfcheckRun()) || [] })()">{{ checksOpen ? '收起' : '查看' }}</button>
    </section>
    <section v-if="checksOpen" class="glass card sc-card">
      <div v-for="c in checks" :key="c.id" class="sc-row">
        <span class="sc-dot" :class="c.ok ? 'ok' : 'bad'">{{ c.ok ? '✓' : '!' }}</span>
        <span>{{ c.label }}</span>
        <span v-if="!c.ok && c.note" class="sc-note">{{ c.note }}</span>
      </div>
    </section>

    <!-- ============ 体检 ============ -->
    <template v-if="sub === 'health'">
      <section class="glass hero">
        <div class="ring-wrap">
          <svg class="ring" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" class="ring-bg" />
            <circle cx="60" cy="60" r="52" class="ring-fg" :style="{ strokeDashoffset: 327 - 327 * (result?.score ?? 0) / 100, stroke: scoreColor }" />
          </svg>
          <div class="ring-center">
            <div class="score-num" :style="{ color: scoreColor }">{{ result ? result.score : '—' }}</div>
            <div class="score-label">{{ result ? scoreText : '未体检' }}</div>
          </div>
        </div>
        <div class="hero-info">
          <h2>电脑体检</h2>
          <p class="sub">{{ result ? `上次体检：${fmtTime(result.ts)}` : '全面检查垃圾、磁盘、启动项与回收站' }}</p>
          <button class="cs-btn primary big" :disabled="checking" @click="runCheck">{{ checking ? '体检中…（约 10-30 秒）' : result ? '重新体检' : '一键体检' }}</button>
        </div>
      </section>

      <template v-if="result">
        <section v-for="d in result.dimensions" :key="d.id" class="glass dim" :class="{ bad: d.score < 60 }">
          <div class="d-info">
            <div class="d-name">{{ d.name }} <span class="d-score" :style="{ color: d.score >= 80 ? '#37D399' : d.score >= 60 ? '#6EA8FF' : '#FF5D6C' }">{{ d.score }}</span></div>
            <div class="d-display">{{ d.display }}</div>
            <div class="d-advice">{{ d.advice }}</div>
          </div>
          <div class="d-bar"><div class="d-fill" :style="{ width: d.score + '%', background: d.score >= 80 ? '#37D399' : d.score >= 60 ? '#6EA8FF' : '#FF5D6C' }"></div></div>
          <button class="cs-btn sm" @click="goFix(d.fix)">去处理 · {{ fixPage[d.fix] }}</button>
        </section>

        <section v-if="history.length > 1" class="glass card">
          <div class="card-head"><h3>📈 体检趋势</h3></div>
          <div class="trend">
            <div v-for="(h, i) in [...history].reverse()" :key="h.ts" class="t-point">
              <div class="t-bar" :style="{ height: Math.max(6, h.score * 0.5) + 'px', background: h.score >= 80 ? '#37D399' : h.score >= 60 ? '#6EA8FF' : '#FF5D6C' }"></div>
              <div class="t-score">{{ h.score }}</div>
              <div class="t-date">{{ i === history.length - 1 ? '最新' : fmtTime(h.ts).slice(5, 10) }}</div>
            </div>
          </div>
        </section>
      </template>
    </template>

    <!-- ============ 安全红线（v4.0） ============ -->
    <template v-else-if="sub === 'redlines'">
      <section class="glass card">
        <div class="row">
          <label>📜 安全红线（{{ redlines.length }} 条）</label>
          <span class="tip-inline">每条都有自动化测试守护——这不是口号，是代码里写死的承诺</span>
        </div>
      </section>
      <section v-for="r in redlines" :key="r.no" class="glass rl-card">
        <div class="rl-head">
          <span class="rl-no">#{{ r.no }}</span>
          <b>{{ r.title }}</b>
          <span class="rl-since">{{ r.since }}</span>
        </div>
        <p class="rl-plain">{{ r.plain }}</p>
        <p class="rl-guard">🛡 守护：{{ r.guard }}</p>
      </section>
    </template>

    <!-- ============ 设置 ============ -->
    <template v-else>
      <section class="glass card">
        <div class="s-row">
          <div class="s-info"><b>回收站保留天数</b><span>软删除文件保留时长，到期自动彻底清除</span></div>
          <select :value="settings?.recycleKeepDays" @change="setSetting('recycle_keep_days', ($event.target as HTMLSelectElement).value)">
            <option value="7">7 天</option><option value="15">15 天（默认）</option><option value="30">30 天</option>
          </select>
        </div>
        <div class="s-row">
          <div class="s-info"><b>开机自启</b><span>开机时自动启动净澈（静默最小化）</span></div>
          <button class="switch" :class="{ on: settings?.autoStart }" @click="setSetting('auto_start', settings?.autoStart ? '0' : '1')"><span class="knob"></span></button>
        </div>
        <div class="s-row">
          <div class="s-info"><b>界面语言 / Language</b><span>切换后界面即时生效（导航·命令面板·常用按钮）</span></div>
          <select class="lang-sel" :value="uiLang" @change="onLangChange">
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div class="s-row">
          <div class="s-info"><b>每周自动体检</b><span>每 7 天自动扫描垃圾（只扫描不清理）并通知</span></div>
          <button class="switch" :class="{ on: settings?.weeklyScan }" @click="setSetting('weekly_scan', settings?.weeklyScan ? '0' : '1')"><span class="knob"></span></button>
        </div>
        <div class="s-row">
          <div class="s-info"><b>关闭时最小化到托盘</b><span>点窗口 ✕ 不退出，常驻托盘（托盘右键可退出）</span></div>
          <button class="switch" :class="{ on: settings?.closeToTray }" @click="setSetting('close_to_tray', settings?.closeToTray ? '0' : '1')"><span class="knob"></span></button>
        </div>
        <div class="s-row">
          <div class="s-info"><b>自动清理规则</b><span>目录+模式+保留天数 → 每周体检生成软删除预案（绝不真删）</span></div>
        </div>
        <div class="ar-new">
          <input v-model="newRuleDir" class="th-in" placeholder="目录，如 D://Downloads" style="width:200px" />
          <button class="cs-btn sm" @click="pickNewRuleDir">📁 浏览…</button>
          <input v-model="newRulePattern" class="th-in" placeholder="*.exe" style="width:90px" />
          <input v-model.number="newRuleDays" class="th-in" type="number" min="7" style="width:70px" /> 天
          <button class="cs-btn sm" :disabled="arBusy || !newRuleDir.trim()" @click="addAutoRule">添加</button>
        </div>
        <div v-if="arMsg" class="ar-msg">{{ arMsg }}</div>
        <div v-for="r in autoRules" :key="r.id" class="ar-row">
          <span class="ar-dir" :title="r.dir">{{ r.dir }}</span>
          <code class="ar-pat">{{ r.pattern }}</code>
          <span class="ar-days">{{ r.keepDays }} 天</span>
          <button class="op-mini" @click="previewRule(r.id)">预览命中</button>
          <button class="op-mini" @click="toggleRule(r)">{{ r.enabled ? '✅ 启用中·停用' : '已停用·开启' }}</button>
        </div>
                <div class="s-row">
          <div class="s-info"><b>月度清理报告</b><span>玻璃风 HTML 战报（清理量/趋势/空间变化），本地生成不上传</span></div>
          <input v-model="reportMonth" class="th-in" placeholder="yyyy-MM" style="width:90px" />
          <button class="cs-btn sm" @click="genReport">生成本月</button>
        </div>
        <div v-if="reports.length" class="report-list">
          <div v-for="r in reports" :key="r.month" class="report-row" @click="window.cs?.showItem(r.file)">
            📄 {{ r.month }} 报告<span class="grow2"></span><span class="op-mini">打开</span>
          </div>
        </div>
        <div class="s-row">
          <div class="s-info"><b>空间预警监控</b><span>磁盘剩余低于阈值时托盘变红并通知（同一盘 24h 只提醒一次）</span></div>
          <button class="switch" :class="{ on: alertCfg?.enabled }" @click="saveAlert({ enabled: !alertCfg?.enabled })"><span class="knob"></span></button>
        </div>
        <div class="s-row">
          <div class="s-info"><b>预警阈值</b><span>C 盘 / 其他盘剩余低于此值触发</span></div>
          <span class="th-wrap">C:<input type="number" min="1" class="th-in" :value="alertCfg?.cThresholdGB" @change="saveAlert({ cThresholdGB: Number(($event.target as HTMLInputElement).value) })" />GB</span>
          <span class="th-wrap">其他:<input type="number" min="1" class="th-in" :value="alertCfg?.otherThresholdGB" @change="saveAlert({ otherThresholdGB: Number(($event.target as HTMLInputElement).value) })" />GB</span>
        </div>
        <div class="s-row">
          <div class="s-info"><b>检查频率</b><span>每 10~120 分钟检查一次磁盘剩余（睡眠唤醒后立即补查）</span></div>
          <span class="th-wrap">每<input type="number" min="10" max="120" class="th-in" :value="alertCfg?.intervalMin" @change="saveAlert({ intervalMin: Number(($event.target as HTMLInputElement).value) })" />分钟</span>
        </div>
        <div class="s-row">
          <div class="s-info"><b>软件更新</b><span>自建更新源（cbxs.top）；启动 30 秒后自动静默检查</span></div>
          <button class="cs-btn sm" :disabled="updChecking" @click="checkUpdate">{{ updChecking ? '检查中…' : '检查更新' }}</button>
        </div>
        <div v-if="updStatus || updChecking" class="upd-banner" :class="updChecking ? 'checking' : updStatus.state">
          <template v-if="updChecking">⏳ 正在检查更新…</template>
          <template v-else-if="updStatus.state === 'downloading'">⬇ 下载新版本 v{{ updStatus.version }}… {{ (updStatus.progress || 0).toFixed(0) }}%</template>
          <template v-else-if="updStatus.state === 'ready'">✅ v{{ updStatus.version }} 已就绪 <button class="cs-btn primary sm" @click="installUpdate">立即重启安装</button></template>
          <template v-else-if="updStatus.state === 'uptodate'">✓ 已是最新版本</template>
          <template v-else-if="updStatus.state === 'available'">🎁 发现新版本 v{{ updStatus.version }}，下载中…</template>
          <template v-else-if="updStatus.state === 'error'">⚠ 检查失败（无网络或更新源不可达，不影响使用）</template>
        </div>
        <div class="s-row">
          <div class="s-info"><b>导出操作日志</b><span>全部删除/移动/禁用记录导出为 CSV</span></div>
          <button class="cs-btn sm" @click="exportLogs">导出</button>
        </div>
      </section>

      <section class="glass card">
        <div class="card-head"><h3>🛡️ 安全保护白名单</h3><span class="tip-inline">白名单内文件只允许定位，不提供批量删除/移动</span></div>
        <div class="s-row">
          <div class="s-info"><b>系统目录安全清理（安全口袋）</b><span>允许清理 Windows 内公认安全垃圾（Temp·更新缓存·错误报告·Prefetch），全部软删除可撤销；关闭后恢复完全保护</span></div>
          <button class="switch" :class="{ on: safePockets }" @click="toggleSafePockets"><span class="knob"></span></button>
        </div>
        <div class="wl-add">
          <input v-model="wlPattern" placeholder="绝对路径，如 D:\资料 或 D:\资料\**" spellcheck="false" @keyup.enter="addWl" />
          <button class="cs-btn sm" @click="pickWlPattern">📁 浏览…</button>
          <input v-model="wlNote" class="note" placeholder="备注" @keyup.enter="addWl" />
          <button class="cs-btn sm" @click="addWl">添加</button>
        </div>
        <p v-if="wlError" class="wl-err">{{ wlError }}</p>
        <div class="wl-list">
          <div v-for="w in wlList" :key="w.id" class="wl-row" :class="{ off: !w.enabled }">
            <label class="chk"><input type="checkbox" :checked="w.enabled" @change="toggleWl(w)" /></label>
            <code>{{ w.pattern }}</code>
            <span class="wl-note">{{ w.note }}</span>
            <button v-if="!w.builtin" class="op del" @click="delWl(w.id)">删除</button>
            <span v-else class="tag">内置</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 14px; padding-bottom: 12px; }
.tabs { display: flex; gap: 8px; }
.tab { padding: 8px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.tab.active { color: #0A1128; font-weight: 700; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }
.msg { padding: 12px 20px; font-size: 13px; color: #A8C7FF; }

.hero { display: flex; align-items: center; gap: 34px; padding: 30px 36px; }
.ring-wrap { position: relative; width: 150px; height: 150px; flex-shrink: 0; }
.ring { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: rgba(255,255,255,0.08); stroke-width: 10; }
.ring-fg { fill: none; stroke-width: 10; stroke-linecap: round; stroke-dasharray: 327; transition: stroke-dashoffset .8s ease, stroke .4s; }
.ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.score-num { font-size: 40px; font-weight: 800; }
.score-label { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.hero-info h2 { font-size: 21px; margin-bottom: 8px; }
.hero-info .sub { font-size: 12.5px; color: var(--text-2); margin-bottom: 18px; }
.cs-btn.big { padding: 12px 28px; font-size: 14px; }

.dim { display: flex; align-items: center; gap: 18px; padding: 18px 24px; }
.d-info { flex: 1; min-width: 0; }
.d-name { font-size: 14.5px; font-weight: 600; display: flex; gap: 10px; align-items: center; }
.d-score { font-weight: 800; }
.d-display { font-size: 12.5px; color: #A8C7FF; margin-top: 4px; }
.d-advice { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.d-bar { width: 120px; height: 8px; border-radius: 6px; background: rgba(255,255,255,0.08); overflow: hidden; flex-shrink: 0; }
.d-fill { height: 100%; border-radius: 6px; transition: width .6s; }
.cs-btn.sm { padding: 8px 16px; font-size: 12px; flex-shrink: 0; }

.card { padding: 20px 24px; }
.card-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.tip-inline { font-size: 11px; color: var(--text-3); }
.trend { display: flex; gap: 14px; align-items: flex-end; padding: 8px 6px 0; overflow-x: auto; }
.t-point { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 44px; }
.t-bar { width: 22px; border-radius: 6px 6px 0 0; }
.t-score { font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.t-date { font-size: 10px; color: var(--text-3); }

.s-row { display: flex; align-items: center; gap: 16px; padding: 13px 4px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.s-row:last-child { border-bottom: none; }
.s-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.s-info b { font-size: 13.5px; }
.s-info span { font-size: 11.5px; color: var(--text-3); }
.s-row select { padding: 8px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; }

.switch { width: 46px; height: 26px; border-radius: 999px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.18); position: relative; cursor: pointer; flex-shrink: 0; transition: all .2s; }
.switch.on { background: linear-gradient(135deg, #6EA8FF, #37D399); border-color: transparent; }
.knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .2s; }
.switch.on .knob { left: 22px; }

.wl-add { display: flex; gap: 10px; margin-bottom: 12px; }
.wl-add input { flex: 1; padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 12.5px; outline: none; }
.wl-add input.note { flex: 0 0 140px; }
.wl-add input:focus { border-color: rgba(110,168,255,0.6); }
.wl-err { font-size: 12px; color: #FF5D6C; margin-bottom: 10px; }
.wl-list { display: flex; flex-direction: column; gap: 6px; }
.wl-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); font-size: 12.5px; }
.wl-row.off { opacity: 0.5; }
.wl-row code { color: #A8C7FF; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-note { font-size: 11px; color: var(--text-3); }
.chk input { accent-color: #6EA8FF; }
.tag { font-size: 10px; color: var(--text-3); background: rgba(255,255,255,0.08); padding: 2px 10px; border-radius: 999px; }
.op.del { padding: 4px 12px; border-radius: 8px; font-size: 11.5px; color: #FF5D6C; background: rgba(255,93,108,0.1); border: 1px solid rgba(255,93,108,0.3); cursor: pointer; }
.crash-banner { display: flex; align-items: center; gap: 12px; padding: 12px 20px; font-size: 12.5px; color: #FFB86C; }
.crash-sum { color: var(--text-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.sc-bar { display: flex; align-items: center; gap: 10px; padding: 8px 20px; font-size: 12.5px; color: var(--text-2); }
.sc-card { padding: 10px 20px; }
.sc-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 12.5px; }
.sc-dot { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
.sc-dot.ok { background: rgba(55,211,153,0.15); color: #37D399; }
.sc-dot.bad { background: rgba(255,93,108,0.15); color: #FF5D6C; }
.sc-note { color: #FFB86C; font-size: 11.5px; margin-left: auto; }
.rl-card { padding: 14px 20px; }
.rl-head { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.rl-no { color: #FF5D6C; font-weight: 700; font-variant-numeric: tabular-nums; }
.rl-since { margin-left: auto; font-size: 10.5px; color: var(--text-3); background: rgba(255,255,255,0.06); padding: 1px 8px; border-radius: 999px; }
.rl-plain { margin: 8px 0 4px; font-size: 12.5px; color: var(--text-2); line-height: 1.7; }
.rl-guard { font-size: 11px; color: #37D399; }
.lang-sel { background: rgba(255,255,255,0.08); color: #E8ECFA; border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; padding: 7px 12px; font-size: 12.5px; outline: none; cursor: pointer; }
.ar-new { display: flex; gap: 8px; align-items: center; margin: 8px 0; font-size: 12.5px; }
.ar-msg { font-size: 12px; color: #A8C7FF; margin: 6px 0; }
.ar-row { display: flex; gap: 10px; align-items: center; padding: 7px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); font-size: 12.5px; margin-bottom: 4px; }
.ar-dir { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-pat { font-size: 11.5px; color: #FFB86C; background: rgba(255,184,108,0.08); padding: 1px 8px; border-radius: 6px; }
.ar-days { color: var(--text-3); font-size: 11.5px; }
.report-list { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 4px; }
.report-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 10px; background: rgba(255,255,255,0.04); font-size: 12.5px; cursor: pointer; }
.report-row:hover { background: rgba(255,255,255,0.08); }
.grow2 { flex: 1; }
.op-mini { font-size: 11px; color: #A8C7FF; }
.upd-banner { margin: 8px 0; padding: 12px 16px; border-radius: 12px; font-size: 12.5px; display: flex; align-items: center; gap: 10px; }
.upd-banner.ready { background: rgba(55,211,153,0.12); color: #37D399; }
.upd-banner.downloading, .upd-banner.available { background: rgba(110,168,255,0.12); color: #A8C7FF; }
.upd-banner.uptodate { background: rgba(255,255,255,0.05); color: var(--text-2); }
.upd-banner.error { background: rgba(255,184,108,0.1); color: #FFB86C; }
.th-wrap { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-2); }
.th-in { width: 56px; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 12.5px; text-align: right; outline: none; }
</style>
