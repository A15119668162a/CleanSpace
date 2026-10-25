<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { tr, purify } from '../i18n'
import { formatBytes } from '@shared/format'

/* ============ 类型 ============ */
interface OrganizeRuleUI { id: number; kind: string; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }
interface PlanItem { src: string; dst: string; size: number; mtime: number; ruleId: number; reason: string }
interface DupFile { path: string; size: number; mtime: number }
interface DupGroup { hash: string; size: number; files: DupFile[]; wasteBytes: number }

/* ============ 状态 ============ */
const sub = ref<'organize' | 'dup' | 'similar' | 'auto'>('organize')

/* 整理 */
const srcDir = ref('')

/* v4.2.4 目录选择器（系统对话框——修复手填路径易错） */
async function pickSrc(): Promise<void> { const d = await window.cs?.pickDir?.('选择要整理的源目录'); if (d) srcDir.value = d }
async function pickDst(): Promise<void> { const d = await window.cs?.pickDir?.('选择整理后存放的目标目录'); if (d) dstDir.value = d }

/* v4.2.5 采用推荐：填目录 + 明示下一步（修复"按了没反应"的语义断层） */
function adoptSuggest(): void {
  if (!suggest.value) return
  dstDir.value = suggest.value.suggestedRoot
  message.value = '已采用推荐目录——点「生成整理预案」查看将移动哪些文件（报告模式不动文件），确认后再执行'
}

/* v4.2.5 整理台账：最近两次可回退 + 流水日志 */
interface OB { id: number; batch_id: string; ts: number; kind: string; items: number; status: string }
const orgRecent = ref<OB[]>([])
const orgHistory = ref<OB[]>([])
const orgLogOpen = ref(false)

async function loadOrgRecent(): Promise<void> {
  orgRecent.value = (await window.cs?.orgRecent()) || []
}
async function rollbackBatch(bid: string): Promise<void> {
  const b = orgRecent.value.find((x) => x.batch_id === bid)
  const kindTxt = b?.kind === 'rollback' ? '恢复（撤回上一次回退）' : '回退这次整理'
  if (!window.confirm(`确认${kindTxt}？批次 ${bid}，${b?.items ?? '?'} 项将反向移动。回退本身也会记账，可再次回退。`)) return
  try {
    const r = await window.cs!.orgRollback(purify(bid))
    message.value = r.ok > 0 ? `已回退 ${r.ok} 项（新批次 ${r.rollbackBatchId}，可再回退恢复）` : `回退失败：${r.errors[0] || '无'}`
    await loadOrgRecent()
  } catch (e) {
    message.value = (e as Error).message
  }
}
async function toggleOrgLog(): Promise<void> {
  orgLogOpen.value = !orgLogOpen.value
  if (orgLogOpen.value) orgHistory.value = (await window.cs?.orgHistory()) || []
}
const dstDir = ref('')
const keepRelative = ref(true)
const rules = ref<OrganizeRuleUI[]>([])
const planning = ref(false)
const planItems = ref<PlanItem[]>([])
const planSkipped = ref(0)
const executing = ref(false)
const execDone = ref(0)
const execTotal = ref(0)
const lastBatch = ref('')
const message = ref('')
const planOpen = ref(false)
const planSearch = ref('')

/* v1.4 推荐目标 */
interface Suggest { suggestedRoot: string; profile: Array<{ category: string; bytes: number; files: number; topFile?: string; topSize?: number }>; totalBytes: number; files: number }
const suggest = ref<Suggest | null>(null)
const suggesting = ref(false)
const suggestErr = ref('')

async function analyze(): Promise<void> {
  const src = srcDir.value.trim()
  if (!src) { suggestErr.value = '先填源目录'; return }
  suggesting.value = true
  suggestErr.value = ''
  suggest.value = null
  try {
    suggest.value = (await window.cs?.orgSuggest(src)) || null
    if (suggest.value && !dstDir.value.trim()) dstDir.value = suggest.value.suggestedRoot
  } catch (e) {
    suggestErr.value = (e as Error).message
  } finally {
    suggesting.value = false
  }
}

/* 规则编辑 */
const ruleModal = ref(false)
const editRule = ref<{ id?: number; kind: string; name: string; config: Record<string, unknown>; enabled: boolean; priority: number }>({ kind: 'type', name: '', config: {}, enabled: true, priority: 5 })

/* 查重 */
const dupRoot = ref('')
const dupScanning = ref(false)
const dupProgress = ref(0)
const dupGroups = ref<DupGroup[]>([])
const dupWaste = ref(0)
const dupMessage = ref('')
const keepChoice = ref<Map<string, string>>(new Map()) // hash -> 保留路径
type Policy = 'earliest' | 'latest' | 'shortest-path'
const globalPolicy = ref<Policy>('earliest')

/** 应用全局策略到全部组 */
function applyPolicyAll(): void {
  const m = new Map<string, string>()
  for (const g of dupGroups.value) {
    const sorted = [...g.files]
    if (globalPolicy.value === 'latest') sorted.sort((a, b) => b.mtime - a.mtime)
    else if (globalPolicy.value === 'shortest-path') sorted.sort((a, b) => a.path.length - b.path.length || a.mtime - b.mtime)
    else sorted.sort((a, b) => a.mtime - b.mtime)
    if (sorted[0]) m.set(g.hash, sorted[0].path)
  }
  keepChoice.value = m
}

let offOrg: (() => void) | null = null
let offDup: (() => void) | null = null

async function pickDupRoot(): Promise<void> { const d = await window.cs?.pickDir?.('选择重复检测的根目录'); if (d) dupRoot.value = d }

async function pickNewWatchDir(): Promise<void> { const d = await window.cs?.pickDir?.('选择要监视的下载目录'); if (d) newWatchDir.value = d }

async function pickSimRoot(): Promise<void> { const d = await window.cs?.pickDir?.('选择相似图片检测目录'); if (d) simRoot.value = d }

onMounted(async () => {
  void loadOrgRecent()
  rules.value = (await window.cs?.orgRules()) || []
  offOrg = window.cs?.onOrgProgress?.((p) => { execDone.value = p.done; execTotal.value = p.total }) || null
  offDup = window.cs?.onDupProgress?.((r) => { dupProgress.value = Math.floor(r * 100) }) || null
  offSim = window.cs?.onSimilarProgress?.((p) => { simProgress.value = p }) || null
})
onBeforeUnmount(() => { offOrg?.(); offDup?.(); offSim?.() })

/* ============ 整理 ============ */
async function genPlan(): Promise<void> {
  if (!srcDir.value || !dstDir.value) { message.value = '请先填写源目录和目标目录'; return }
  planning.value = true
  message.value = ''
  try {
    const r = await window.cs!.orgPlan(srcDir.value.trim(), dstDir.value.trim(), keepRelative.value)
    planItems.value = r.items.slice(0, 500) // UI 只展示前 500（执行仍是全量）
    planSkipped.value = r.skipped.length
    planOpen.value = true
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    planning.value = false
  }
}

const planFiltered = computed(() => {
  const q = planSearch.value.trim().toLowerCase()
  return q ? planItems.value.filter((i) => i.src.toLowerCase().includes(q) || i.dst.toLowerCase().includes(q)) : planItems.value.slice(0, 300)
})

async function execute(): Promise<void> {
  if (!planItems.value.length) return
  if (!window.confirm(`确认执行整理？将移动文件到目标目录（可随时回滚）。`)) return
  planOpen.value = false
  executing.value = true
  execDone.value = 0
  execTotal.value = planItems.value.length
  try {
    const r = await window.cs!.orgExecute(purify(planItems.value))
    lastBatch.value = r.batchId
    message.value = `整理完成：移动 ${r.moved} 个，失败 ${r.failed} 个。批次 ${r.batchId}（可回滚）`
    await loadOrgRecent()
    planItems.value = []
  } catch (e) {
    message.value = (e as Error).message
  } finally {
    executing.value = false
  }
}

async function undo(): Promise<void> {
  if (!lastBatch.value) return
  executing.value = true
  try {
    const r = await window.cs!.orgRollback(purify(lastBatch.value))
    message.value = `回滚完成：还原 ${r.ok} 个，失败 ${r.fail} 个`
    lastBatch.value = ''
  } finally {
    executing.value = false
  }
}

function toggleRule(r: OrganizeRuleUI): void {
  r.enabled = !r.enabled
  void window.cs?.orgRuleSave({ id: r.id, kind: r.kind, name: r.name, config: r.config, enabled: r.enabled, priority: r.priority })
}

function openRuleModal(r?: OrganizeRuleUI): void {
  editRule.value = r ? { ...r, config: { ...r.config } } : { kind: 'type', name: '', config: { targetFolder: '' }, enabled: true, priority: 5 }
  ruleModal.value = true
}

async function saveRule(): Promise<void> {
  const id = await window.cs?.orgRuleSave(purify(editRule.value))
  rules.value = (await window.cs?.orgRules()) || []
  ruleModal.value = false
  void id
}

async function delRule(id: number): Promise<void> {
  if (!window.confirm('删除该规则？')) return
  await window.cs?.orgRuleDelete(id)
  rules.value = (await window.cs?.orgRules()) || []
}

const kindName: Record<string, string> = { type: '按类型', date: '按日期', size: '按大小', custom: '自定义' }

/* ============ 查重 ============ */
async function scanDup(): Promise<void> {
  if (!dupRoot.value.trim()) { dupMessage.value = '请填写要查重的目录'; return }
  dupScanning.value = true
  dupMessage.value = ''
  dupGroups.value = []
  dupProgress.value = 0
  try {
    const r = await window.cs!.dupScan(dupRoot.value.trim())
    dupGroups.value = r.groups.slice(0, 100)
    dupWaste.value = r.wasteBytes
    applyPolicyAll() // 默认策略自动套用
    if (r.groups.length > 100) dupMessage.value = `共 ${r.groups.length} 组重复，仅展示前 100 组（按可释放空间排序）`
  } catch (e) {
    dupMessage.value = (e as Error).message
  } finally {
    dupScanning.value = false
  }
}

function keepOf(g: DupGroup): string {
  return keepChoice.value.get(g.hash) || g.files[0].path
}

function setKeep(g: DupGroup, path: string): void {
  keepChoice.value = new Map(keepChoice.value).set(g.hash, path)
}

/** 「其余进软删除」：把组内非保留文件走 P2 软删除通道 */
async function cleanGroup(g: DupGroup): Promise<void> {
  const keep = keepOf(g)
  const victims = g.files.filter((f) => f.path !== keep)
  if (!victims.length) return
  if (!window.confirm(`将 ${victims.length} 个重复副本移入应用回收站？（保留：${keep}）`)) return
  try {
    const r = await window.cs!.junkClean(victims.map((v) => ({ path: v.path, size: v.size, mtime: v.mtime })), 'confirmed')
    dupMessage.value = `已软删除 ${r.cleaned} 个副本（批次 ${r.batchId}，可在回收站恢复）`
    dupGroups.value = dupGroups.value.filter((x) => x.hash !== g.hash)
  } catch (e) {
    dupMessage.value = (e as Error).message
  }
}

const fileTime = (t: number): string => (t ? new Date(t).toLocaleDateString('zh-CN') : '--')

/* ============ 下载目录自动化（v3.1 G4 · v3.4.1 UI 补闭环） ============ */
interface WatchDir { id: number; dir: string; mode: string }
const watchDirs = ref<WatchDir[]>([])
const wdBusy = ref(false)
const wdMsg = ref('')
const newWatchDir = ref('')

async function switchAuto(): Promise<void> {
  sub.value = 'auto'
  if (watchDirs.value.length || wdBusy.value) return
  await loadWatchDirs()
}
async function loadWatchDirs(): Promise<void> {
  wdBusy.value = true
  try { watchDirs.value = (await window.cs?.watchDirsList()) || [] } finally { wdBusy.value = false }
}
async function addWatch(): Promise<void> {
  const d = newWatchDir.value.trim()
  if (!d) return
  const ok = await window.cs?.watchDirsAdd(d)
  wdMsg.value = ok ? `已添加 ${d}（默认「仅报告」——新文件只建议不移动）` : '添加失败（目录不存在或已添加）'
  if (ok) { newWatchDir.value = ''; await loadWatchDirs() }
}
async function removeWatch(d: string): Promise<void> {
  await window.cs?.watchDirsRemove(d)
  await loadWatchDirs()
}
async function setMode(d: string, mode: string): Promise<void> {
  if (mode === 'auto' && !window.confirm('切换到「自动执行」：新文件落定 30 秒后自动移动到 已整理/ 目录。\n所有移动记录在案、可按日志回滚。确认？')) return
  await window.cs?.watchDirsMode(d, mode)
  await loadWatchDirs()
}
const MODE_TIP: Record<string, string> = {
  report: '仅报告（新文件只建议，不动）',
  auto: '自动执行（移动到 已整理/，可回滚）',
  off: '暂停监视'
}

/* ============ 相似图片（v2.0 F1） ============ */
const simRoot = ref('')
const simThreshold = ref(5)
const simScanning = ref(false)
const simProgress = ref({ done: 0, total: 0 })
const simGroups = ref<Array<Array<{ path: string; size: number; mtime: number }>>>([])
const simThumbs = ref<Record<string, string>>({})
const simMsg = ref('')
/** 红线 7：勾选集——默认空（任何代码路径不得预选） */
const simChecked = ref<Set<string>>(new Set())

let offSim: (() => void) | null = null

async function scanSimilar(): Promise<void> {
  const root = simRoot.value.trim()
  if (!root) { simMsg.value = '请填写要检测的图片目录'; return }
  simScanning.value = true
  simMsg.value = ''
  simGroups.value = []
  simChecked.value = new Set() // 红线 7：清空勾选，绝不预选
  try {
    const r = await window.cs!.similarScan(root, simThreshold.value)
    simGroups.value = r.groups
    simThumbs.value = r.thumbs
    simMsg.value = `已分析 ${r.hashed} 张图片，发现 ${r.groups.length} 组相似（${(r.durationMs / 1000).toFixed(1)}s）。相似≠相同，请人工勾选要清理的项。`
  } catch (e) {
    simMsg.value = (e as Error).message
  } finally {
    simScanning.value = false
  }
}

function cancelSimilar(): void { void window.cs?.similarCancel() }

/* v4.2.7 相似图片全选（勾所有组内推荐清理位：每组除第一张外全选——与"保留这张"默认一致） */
function simSelectAll(): void {
  const s = new Set(simChecked.value)
  for (const g of simGroups.value) {
    for (let i = 1; i < g.length; i++) s.add(g[i].path) // 每组第一张默认保留
  }
  simChecked.value = s
}
function simInvert(): void {
  const s = new Set<string>()
  for (const g of simGroups.value) {
    for (let i = 1; i < g.length; i++) if (!simChecked.value.has(g[i].path)) s.add(g[i].path)
  }
  simChecked.value = s
}
function simClear(): void { simChecked.value = new Set() }

/* v4.2.7 重复/视频：一键采纳全部推荐（每组保留推荐项，其余入清理预案） */
function dupAdoptAll(): void {
  const m = new Map<string, string>()
  for (const g of dupGroups.value) m.set(g.hash, keepOf(g))
  keepChoice.value = m
}

function toggleSimCheck(path: string): void {
  const s = new Set(simChecked.value)
  if (s.has(path)) s.delete(path)
  else s.add(path)
  simChecked.value = s
}

/** 组内保留一张：把组内非保留项加入勾选（用户主动点击才触发——不算预选） */
function keepOneInGroup(group: Array<{ path: string; size: number; mtime: number }>, keepPath: string): void {
  const s = new Set(simChecked.value)
  for (const f of group) if (f.path !== keepPath) s.add(f.path)
  for (const f of group) if (f.path === keepPath) s.delete(f.path)
  simChecked.value = s
}

/** 勾选项走软删除（三级确认由 junkClean 服务端强校验：小批量 confirmed） */
async function cleanSimilar(): Promise<void> {
  const victims = [...simChecked.value].map((p) => findSimFile(p)).filter((x): x is { path: string; size: number; mtime: number } => !!x)
  if (!victims.length) { simMsg.value = '先勾选要清理的相似图片'; return }
  if (!window.confirm(`将 ${victims.length} 张相似图片移入回收站（可恢复）？\n请再次确认勾选的都不要了。`)) return
  try {
    const r = await window.cs!.junkClean(victims.map((v) => ({ path: v.path, size: v.size, mtime: v.mtime })), 'confirmed')
    simMsg.value = `已软删除 ${r.cleaned} 张（批次 ${r.batchId}，可在回收站恢复）`
    // 刷新：重扫该目录
    void scanSimilar()
  } catch (e) {
    simMsg.value = (e as Error).message
  }
}

function findSimFile(path: string): { path: string; size: number; mtime: number } | null {
  for (const g of simGroups.value) {
    const f = g.find((x) => x.path === path)
    if (f) return f
  }
  return null
}
</script>

<template>
  <div class="org">
    <div class="tabs">
      <button class="tab" :class="{ active: sub === 'organize' }" @click="sub = 'organize'">{{ tr('tOrganize') }}</button>
      <button class="tab" :class="{ active: sub === 'dup' }" @click="sub = 'dup'">{{ tr('tDup') }}</button>
      <button class="tab" :class="{ active: sub === 'similar' }" @click="sub = 'similar'">{{ tr('tSimilar') }}</button>
      <button class="tab" :class="{ active: sub === 'auto' }" @click="switchAuto()">{{ tr('tAuto') }}</button>
    </div>

    <section v-if="message" class="glass msg">{{ message }}</section>

    <!-- ============ 整理子页 ============ -->
    <template v-if="sub === 'organize'">
      <section class="glass card">
        <div class="row">
          <label>源目录</label>
          <input v-model="srcDir" placeholder="要整理的目录，如 D:\Downloads" spellcheck="false" @keyup.enter="analyze" />
          <button class="cs-btn sm" @click="pickSrc">📁 浏览…</button>
          <button class="cs-btn" :disabled="suggesting" @click="analyze">{{ suggesting ? '分析中…' : '🔍 分析推荐' }}</button>
        </div>
        <div class="row">
          <label>目标目录</label>
          <input v-model="dstDir" placeholder="整理后放哪（分析后自动推荐）" spellcheck="false" />
          <button class="cs-btn sm" @click="pickDst">📁 浏览…</button>
        </div>

        <!-- 推荐卡（v1.4：按最大文件/最多类型画像） -->
        <div v-if="suggest" class="suggest-card">
          <div class="sg-head">
            📋 内容画像：{{ suggest.files.toLocaleString() }} 个文件 / {{ formatBytes(suggest.totalBytes) }}，建议整理到
            <code class="sg-root">{{ suggest.suggestedRoot }}</code>
            <button class="op" @click="adoptSuggest">采用</button>
            <span class="sg-tip">（同盘移动零拷贝）</span>
          </div>
          <div v-for="p in suggest.profile" :key="p.category" class="sg-row">
            <span class="sg-cat">{{ p.category }}</span>
            <div class="sg-bar"><div class="sg-fill" :style="{ width: (p.bytes / Math.max(suggest!.totalBytes, 1) * 100).toFixed(1) + '%' }"></div></div>
            <span class="sg-bytes">{{ formatBytes(p.bytes) }}</span>
            <span class="sg-files">{{ p.files }} 个</span>
            <span class="sg-top" :title="p.topFile">最大：{{ formatBytes(p.topSize || 0) }}</span>
          </div>
        </div>
        <p v-if="suggestErr" class="wl-err">{{ suggestErr }}</p>
        <div class="row opts">
          <label class="chk"><input v-model="keepRelative" type="checkbox" /> 保留原始相对路径（取消则平铺）</label>
          <div class="grow"></div>
          <button class="cs-btn primary" :disabled="planning || executing" @click="genPlan">{{ planning ? '生成中…' : '生成整理预案（报告模式，不动文件）' }}</button>
        </div>

        <!-- v4.2.5 整理台账：最近两次可回退 -->
        <div class="row">
          <label>↩️ 一键回退</label>
          <span class="tip-inline">只保留最近两次操作可回退；回退也会记账、可再回退（恢复整理）</span>
        </div>
        <div v-for="b in orgRecent" :key="b.batch_id" class="org-batch glass">
          <span class="ob-kind" :class="b.kind">{{ b.kind === 'rollback' ? '↩️ 回退' : '📦 整理' }}</span>
          <span class="ob-info">{{ new Date(b.ts).toLocaleString('zh-CN', { hour12: false }) }} · {{ b.items }} 项</span>
          <code class="ob-id">{{ b.batch_id }}</code>
          <button class="cs-btn sm" @click="rollbackBatch(b.batch_id)">{{ b.kind === 'rollback' ? '再回退（恢复整理）' : '回退' }}</button>
        </div>
        <div v-if="!orgRecent.length" class="org-batch-empty">暂无可回退批次——整理一次试试</div>
        <div class="row">
          <label>📜 整理日志</label>
          <button class="op" @click="toggleOrgLog">{{ orgLogOpen ? '收起' : '查看流水' }}</button>
        </div>
        <div v-if="orgLogOpen" class="org-log">
          <div v-for="h in orgHistory" :key="h.batch_id" class="ol-row">
            <span class="ob-kind" :class="h.kind">{{ h.kind === 'rollback' ? '↩️ 回退' : '📦 整理' }}</span>
            <span class="ob-info">{{ new Date(h.ts).toLocaleString('zh-CN', { hour12: false }) }}</span>
            <span class="ob-items">{{ h.items }} 项</span>
            <span class="ob-status" :class="h.status">{{ h.status === 'active' ? '可回退' : '已回退' }}</span>
            <code class="ob-id">{{ h.batch_id }}</code>
          </div>
          <button v-if="lastBatch" class="cs-btn warn" :disabled="executing" @click="undo">↩️ 回滚上次整理</button>
        </div>
        <p class="tip">报告模式：只生成「哪个文件将去哪里」的预案，不移动任何文件。确认后才真正执行。</p>
      </section>

      <section class="glass card">
        <div class="card-head">
          <h3>整理规则（{{ rules.filter(r => r.enabled).length }}/{{ rules.length }} 启用）</h3>
          <button class="op" @click="openRuleModal()">＋ 新建规则</button>
        </div>
        <div v-for="r in rules" :key="r.id" class="rule-row">
          <label class="chk"><input type="checkbox" :checked="r.enabled" @change="toggleRule(r)" /></label>
          <span class="r-kind">{{ kindName[r.kind] || r.kind }}</span>
          <span class="r-name">{{ r.name }}</span>
          <span class="r-cfg">{{ JSON.stringify(r.config) }}</span>
          <span class="grow"></span>
          <button class="op" @click="openRuleModal(r)">编辑</button>
          <button class="op del" @click="delRule(r.id)">删除</button>
        </div>
      </section>

      <section v-if="executing" class="glass prog">
        执行中 {{ execDone }} / {{ execTotal }}
        <div class="bar"><div class="fill" :style="{ width: (execTotal ? execDone / execTotal * 100 : 0).toFixed(1) + '%' }"></div></div>
      </section>
    </template>

    <!-- ============ 查重子页 ============ -->
    <template v-else-if="sub === 'dup'">
      <section class="glass card">
        <div class="row">
          <label>查重目录</label>
          <input v-model="dupRoot" placeholder="如 D:\资料（含子目录，白名单自动跳过）" spellcheck="false" @keyup.enter="scanDup" />
          <button class="cs-btn sm" @click="pickDupRoot">📁 浏览…</button>
          <button class="cs-btn primary" :disabled="dupScanning" @click="scanDup">{{ dupScanning ? `扫描中 ${dupProgress}%…` : '开始查重' }}</button>
        </div>
        <p class="tip">三层校验：大小分组 → 头尾 4KB 哈希 → 全量 SHA-256，内容完全相同才算重复。</p>
        <div v-if="dupScanning" class="bar full"><div class="fill" :style="{ width: dupProgress + '%' }"></div></div>
        <div v-if="dupGroups.length" class="dup-total">
          <span>发现 <b>{{ dupGroups.length }}</b> 组重复 · 可释放 <b class="ok">{{ formatBytes(dupWaste) }}</b></span>
          <span class="policy-box">
            <button class="op" @click="dupAdoptAll">✅ 一键采纳全部推荐（按策略保留）</button>
            全局策略：
            <select v-model="globalPolicy" class="policy-select" @change="applyPolicyAll">
              <option value="earliest">保留最早（推荐）</option>
              <option value="latest">保留最新</option>
              <option value="shortest-path">保留浅路径</option>
            </select>
          </span>
        </div>
      </section>

      <section v-for="g in dupGroups" :key="g.hash" class="glass grp">
        <div class="grp-head">
          <div class="grp-title">{{ formatBytes(g.size) }} × {{ g.files.length }} 份 · 可释放 {{ formatBytes(g.wasteBytes) }}</div>
        </div>
        <div v-for="f in g.files" :key="f.path" class="dup-row" :class="{ keep: keepOf(g) === f.path }">
          <label class="radio"><input type="radio" :name="g.hash" :checked="keepOf(g) === f.path" @change="setKeep(g, f.path)" /></label>
          <span class="d-path" :title="f.path">{{ f.path }}</span>
          <span class="d-time">{{ fileTime(f.mtime) }}</span>
          <span class="tag">{{ keepOf(g) === f.path ? '保留' : '副本' }}</span>
        </div>
        <div class="grp-ops">
          <button class="cs-btn danger sm" :disabled="dupScanning" @click="cleanGroup(g)">其余进软删除回收站</button>
        </div>
      </section>
    </template>

    <!-- ============ 下载目录自动化（v3.1 G4） ============ -->
    <template v-else-if="sub === 'auto'">
      <section class="glass card">
        <div class="row">
          <label>下载目录自动整理</label>
          <span class="tip-inline">监视你指定的目录 · 30 秒去抖 · 未完成下载绝不触碰 · 移动可回滚</span>
          <div class="grow"></div>
          <input v-model="newWatchDir" class="th-in" placeholder="目录，如 D:\Downloads" style="width: 200px" />
          <button class="cs-btn sm" @click="pickNewWatchDir">📁 浏览…</button>
          <button class="cs-btn sm" :disabled="wdBusy || !newWatchDir.trim()" @click="addWatch">添加监视</button>
        </div>
        <p class="tip">🟢 仅报告（默认）：新文件落定后建议去处，你确认才动 · ⚡ 自动执行：直接移到「已整理/类型/」，可按日志回滚 · 应用重启后监视生效</p>
        <section v-if="wdMsg" class="wd-msg">{{ wdMsg }}</section>
      </section>
      <section v-for="w in watchDirs" :key="w.dir" class="glass wd-row">
        <span class="wd-dir" :title="w.dir">📁 {{ w.dir }}</span>
        <span class="wd-mode-tag" :class="w.mode">{{ MODE_TIP[w.mode] || w.mode }}</span>
        <div class="grow"></div>
        <select class="wd-sel" :value="w.mode" @change="setMode(w.dir, ($event.target as HTMLSelectElement).value)">
          <option value="report">仅报告</option>
          <option value="auto">自动执行</option>
          <option value="off">暂停</option>
        </select>
        <button class="op-mini" @click="removeWatch(w.dir)">移除</button>
      </section>
      <section v-if="!watchDirs.length && !wdBusy" class="glass empty">还没有监视目录——添加你的 Downloads 试试</section>
    </template>

    <!-- ============ 相似图片子页（v2.0 F1） ============ -->
    <template v-else-if="sub === 'similar'">
      <section class="glass card">
        <div class="row">
          <label>图片目录</label>
          <input v-model="simRoot" placeholder="如 D:\照片（递归检测 jpg/png/gif/webp/bmp/tiff，>10KB）" spellcheck="false" @keyup.enter="scanSimilar" />
          <button class="cs-btn primary" :disabled="simScanning" @click="scanSimilar">{{ simScanning ? '检测中…' : '🔍 检测相似' }}</button>
          <button v-if="simScanning" class="cs-btn" @click="cancelSimilar">取消</button>
        </div>
        <div class="row opts">
          <label class="chk">相似度阈值：{{ simThreshold }}（3 严格 ~ 10 宽松，海明距离）</label>
          <input v-model.number="simThreshold" type="range" min="3" max="10" class="range" :disabled="simScanning" />
          <div class="grow"></div>
          <span class="sel-tools">
            <button class="op" @click="simSelectAll">全选推荐位</button>
            <button class="op" @click="simInvert">反选</button>
            <button class="op" @click="simClear">清空</button>
          </span>
          <button class="cs-btn danger" :disabled="simScanning || simChecked.size === 0" @click="cleanSimilar">
            清理勾选项（{{ simChecked.size }}）
          </button>
        </div>
        <p class="tip">⚠️ 相似 ≠ 相同——<b>不会自动勾选任何待删项</b>，请逐张确认。被清理项进软删除回收站可恢复。</p>
        <div v-if="simScanning" class="prog-line">
          进度 {{ simProgress.done }} / {{ simProgress.total }}
          <div class="bar full"><div class="fill" :style="{ width: (simProgress.total ? simProgress.done / simProgress.total * 100 : 0).toFixed(1) + '%' }"></div></div>
        </div>
      </section>

      <section v-for="(g, gi) in simGroups" :key="gi" class="glass grp">
        <div class="grp-title">相似组 {{ gi + 1 }}（{{ g.length }} 张）—— 点卡片勾选要清理的，或「保留这张」</div>
        <div class="sim-grid">
          <div v-for="f in g" :key="f.path" class="sim-card" :class="{ checked: simChecked.has(f.path) }" @click="toggleSimCheck(f.path)">
            <img v-if="simThumbs[f.path]" :src="'file://' + simThumbs[f.path]" loading="lazy" class="sim-img" @click.stop="toggleSimCheck(f.path)" />
            <div v-else class="sim-img placeholder">🖼️</div>
            <div class="sim-meta">
              <div class="sim-name" :title="f.path">{{ f.path.split(/[\\/]/).pop() }}</div>
              <div class="sim-sub">{{ formatBytes(f.size) }} · {{ fileTime(f.mtime) }}</div>
            </div>
            <button class="op keep" @click.stop="keepOneInGroup(g, f.path)">保留这张</button>
            <span class="sim-check">{{ simChecked.has(f.path) ? '✓ 已勾选清理' : '' }}</span>
          </div>
        </div>
      </section>
    </template>

    <!-- 预案弹窗 -->
    <Teleport to="body">
      <div v-if="planOpen" class="mask" @click.self="planOpen = false">
        <div class="glass modal wide">
          <h3>整理预案（{{ planItems.length }} 项移动 · 跳过 {{ planSkipped }}）</h3>
          <input v-model="planSearch" class="search" placeholder="搜索文件名…" spellcheck="false" />
          <div class="pv-list">
            <div v-for="(i, idx) in planFiltered" :key="i.src" class="pv-row">
              <span class="pv-idx">{{ idx + 1 }}</span>
              <span class="pv-src" :title="i.src">{{ i.src }}</span>
              <span class="pv-arrow">→</span>
              <span class="pv-dst" :title="i.dst">{{ i.dst }}</span>
              <span class="pv-size">{{ formatBytes(i.size) }}</span>
            </div>
            <div v-if="planFiltered.length < planItems.length" class="pv-more">… 其余 {{ planItems.length - planFiltered.length }} 项</div>
          </div>
          <div class="m-foot">
            <button class="cs-btn" @click="planOpen = false">返回（不执行）</button>
            <button class="cs-btn primary" @click="execute">确认执行（移动 {{ planItems.length }} 项）</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 规则编辑弹窗 -->
    <Teleport to="body">
      <div v-if="ruleModal" class="mask" @click.self="ruleModal = false">
        <div class="glass modal">
          <h3>{{ editRule.id ? '编辑规则' : '新建规则' }}</h3>
          <div class="row"><label>名称</label><input v-model="editRule.name" placeholder="如：设计稿" /></div>
          <div class="row">
            <label>类型</label>
            <select v-model="editRule.kind">
              <option value="type">按类型（图片/视频/文档…）</option>
              <option value="date">按日期归档（年 / 年-月）</option>
              <option value="size">按大小（大于阈值单列）</option>
              <option value="custom">自定义扩展名</option>
            </select>
          </div>
          <div v-if="editRule.kind === 'type'" class="row">
            <label>类别</label>
            <select v-model="editRule.config.category">
              <option v-for="c in ['图片','视频','音频','文档','压缩包','安装包','代码']" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div v-if="editRule.kind === 'date'" class="row">
            <label>粒度</label>
            <select v-model="editRule.config.granularity"><option value="month">年-月</option><option value="year">年</option></select>
          </div>
          <div v-if="editRule.kind === 'size'" class="row">
            <label>阈值(GB)</label>
            <input type="number" min="0.1" step="0.1" @input="editRule.config.minBytes = Math.round(Number(($event.target as HTMLInputElement).value) * 1024 ** 3)" />
          </div>
          <div v-if="editRule.kind === 'custom'" class="row">
            <label>扩展名</label>
            <input v-model="editRule.config.ext" placeholder="如 psd（不带点）" />
          </div>
          <div class="row"><label>目标文件夹</label><input v-model="editRule.config.targetFolder" placeholder="如 设计稿" /></div>
          <div class="row"><label>优先级</label><input v-model.number="editRule.priority" type="number" min="1" max="99" /></div>
          <div class="m-foot">
            <button class="cs-btn" @click="ruleModal = false">取消</button>
            <button class="cs-btn primary" @click="saveRule">保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sel-tools { display: inline-flex; gap: 4px; margin-right: 10px; align-items: center; }
.sel-tools .op { font-size: 11.5px; padding: 4px 10px; border-radius: 8px; }

.org-batch { display: flex; align-items: center; gap: 12px; padding: 12px 18px; font-size: 12.5px; border-radius: 12px; }
.org-batch-empty { font-size: 12px; color: var(--text-3); padding: 6px 4px; }
.ob-kind { font-size: 11px; padding: 2px 10px; border-radius: 999px; background: rgba(110,168,255,0.12); color: #A8C7FF; }
.ob-kind.rollback { background: rgba(255,184,108,0.12); color: #FFB86C; }
.ob-info { color: var(--text-2); }
.ob-id { font-size: 10.5px; color: var(--text-3); background: rgba(255,255,255,0.05); padding: 1px 8px; border-radius: 6px; }
.org-batch .cs-btn { margin-left: auto; }
.org-log { max-height: 300px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 8px 14px; }
.ol-row { display: flex; align-items: center; gap: 12px; padding: 6px 4px; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.ol-row:last-child { border-bottom: none; }
.ob-items { color: var(--text-3); }
.ob-status { font-size: 10.5px; padding: 1px 8px; border-radius: 999px; }
.ob-status.active { background: rgba(55,211,153,0.12); color: #37D399; }
.ob-status.rolled_back { background: rgba(255,255,255,0.06); color: var(--text-3); }

.org { display: flex; flex-direction: column; gap: 14px; padding-bottom: 12px; }
.tabs { display: flex; gap: 8px; }
.tab { padding: 8px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.tab.active { color: #0A1128; font-weight: 700; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }
.msg { padding: 12px 20px; font-size: 13px; color: #A8C7FF; }

.card { padding: 20px 24px; }
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.row label { min-width: 88px; font-size: 13px; color: var(--text-2); flex-shrink: 0; }
.row input, .row select { flex: 1; padding: 9px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; }
.row input:focus { border-color: rgba(110,168,255,0.6); }
.opts { align-items: center; }
.grow { flex: 1; }
.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.chk input { accent-color: #6EA8FF; }
.tip { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.wd-row { display: flex; align-items: center; gap: 12px; padding: 14px 20px; font-size: 13px; }
.wd-dir { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wd-mode-tag { font-size: 11px; padding: 2px 10px; border-radius: 999px; background: rgba(255,255,255,0.07); }
.wd-mode-tag.report { color: #37D399; }
.wd-mode-tag.auto { color: #6EA8FF; }
.wd-mode-tag.off { color: #9AA5C4; }
.wd-sel { background: rgba(255,255,255,0.08); color: #E8ECFA; border: 1px solid rgba(255,255,255,0.16); border-radius: 8px; padding: 5px 10px; font-size: 12px; outline: none; cursor: pointer; }
.wd-msg { padding: 10px 16px; font-size: 12.5px; color: #A8C7FF; }

/* v1.4 推荐卡 */
.suggest-card { margin: 8px 0 4px; padding: 14px 16px; border-radius: 14px; background: rgba(110,168,255,0.07); border: 1px solid rgba(110,168,255,0.18); }
.sg-head { font-size: 13px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sg-root { padding: 3px 10px; border-radius: 8px; background: rgba(255,255,255,0.09); color: #A8C7FF; font-size: 12px; }
.sg-tip { font-size: 11px; color: var(--text-3); }
.sg-row { display: grid; grid-template-columns: 64px 1fr 80px 60px 140px; gap: 10px; align-items: center; padding: 5px 0; font-size: 12px; }
.sg-cat { color: var(--text-2); font-weight: 600; }
.sg-bar { height: 10px; border-radius: 6px; background: rgba(255,255,255,0.07); overflow: hidden; }
.sg-fill { height: 100%; border-radius: 6px; background: linear-gradient(90deg, #6EA8FF, #B39DFF); }
.sg-bytes { color: #A8C7FF; text-align: right; font-variant-numeric: tabular-nums; }
.sg-files { color: var(--text-3); text-align: right; }
.sg-top { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-btn.warn { border-color: rgba(255,184,108,0.5); color: #FFB86C; }
.cs-btn.danger.sm { padding: 7px 16px; font-size: 12px; }

.rule-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; background: rgba(255,255,255,0.04); margin-bottom: 6px; font-size: 12.5px; }
.r-kind { padding: 2px 10px; border-radius: 999px; font-size: 11px; background: rgba(110,168,255,0.14); color: #6EA8FF; }
.r-name { font-weight: 600; }
.r-cfg { color: var(--text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }

.prog { padding: 16px 22px; font-size: 13px; color: var(--text-2); }
.bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,0.08); overflow: hidden; margin-top: 10px; }
.bar.full { margin: 10px 0 0; }
.fill { height: 100%; border-radius: 6px; background: linear-gradient(90deg, #6EA8FF, #37D399); transition: width 0.3s; }

.dup-total { padding: 12px 4px 0; font-size: 14px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.dup-total b.ok { color: #37D399; }
.policy-box { font-size: 12.5px; color: var(--text-2); display: flex; align-items: center; gap: 6px; }
.policy-select { padding: 6px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 12.5px; outline: none; cursor: pointer; }
.grp { padding: 16px 22px; }
.grp-title { font-size: 13.5px; font-weight: 600; margin-bottom: 10px; }
.dup-row { display: grid; grid-template-columns: 30px 1fr 90px 56px; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); margin-bottom: 5px; font-size: 12px; }
.dup-row.keep { background: rgba(55,211,153,0.10); }
.radio input { accent-color: #37D399; }
.d-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.d-time { color: var(--text-3); text-align: right; }
.tag { font-size: 10.5px; color: var(--text-3); text-align: center; }
.dup-row.keep .tag { color: #37D399; font-weight: 700; }
.grp-ops { display: flex; justify-content: flex-end; margin-top: 8px; }

/* v2.0 相似图片 */
.range { width: 160px; accent-color: #6EA8FF; }
.prog-line { font-size: 12.5px; color: var(--text-2); padding-top: 6px; }
.bar.full { margin-top: 8px; }
.sim-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.sim-card { position: relative; padding: 8px; border-radius: 14px; background: rgba(255,255,255,0.05); border: 2px solid transparent; cursor: pointer; transition: all .15s; }
.sim-card:hover { background: rgba(255,255,255,0.09); }
.sim-card.checked { border-color: #FF5D6C; background: rgba(255,93,108,0.08); }
.sim-img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; display: block; }
.sim-img.placeholder { display: flex; align-items: center; justify-content: center; font-size: 34px; background: rgba(255,255,255,0.06); }
.sim-meta { margin-top: 6px; }
.sim-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sim-sub { font-size: 10.5px; color: var(--text-3); margin-top: 2px; }
.op.keep { position: absolute; top: 12px; right: 12px; padding: 3px 10px; border-radius: 8px; font-size: 11px; color: #37D399; background: rgba(7,11,28,0.72); border: 1px solid rgba(55,211,153,0.4); opacity: 0; transition: opacity .15s; }
.sim-card:hover .op.keep { opacity: 1; }
.sim-check { position: absolute; top: 12px; left: 12px; font-size: 10.5px; color: #FF5D6C; font-weight: 700; background: rgba(7,11,28,0.72); padding: 3px 8px; border-radius: 8px; display: none; }
.sim-card.checked .sim-check { display: block; }

.mask { position: fixed; inset: 0; background: rgba(4,7,20,0.6); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { width: 560px; max-width: 92vw; max-height: 84vh; padding: 24px 26px; display: flex; flex-direction: column; }
.modal.wide { width: 900px; }
.modal h3 { font-size: 16px; margin-bottom: 14px; }
.search { padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; margin-bottom: 12px; }
.pv-list { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 4px; }
.pv-row { display: grid; grid-template-columns: 36px 1fr 24px 1fr 90px; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.04); font-size: 11.5px; }
.pv-idx { color: var(--text-3); }
.pv-src, .pv-dst { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.pv-dst { color: #A8C7FF; }
.pv-arrow { color: var(--text-3); text-align: center; }
.pv-size { color: var(--text-3); text-align: right; }
.pv-more { padding: 10px; text-align: center; color: var(--text-3); font-size: 11.5px; }
.m-foot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.m-foot .cs-btn.danger { border-color: rgba(255,93,108,0.55); color: #FF5D6C; }
.op { padding: 5px 12px; border-radius: 10px; font-size: 12px; color: var(--text-2); background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.op.del { color: #FF5D6C; }
</style>
