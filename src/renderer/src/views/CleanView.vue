<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { tr, purify } from '../i18n'
import { formatBytes } from '@shared/format'

/* ---------------- 类型 ---------------- */
type RiskLevel = 'safe' | 'caution' | 'expert'
interface JunkFile { path: string; size: number; mtime: number }
interface JunkGroup { ruleId: string; name: string; desc: string; risk: RiskLevel; consequence?: string; files: JunkFile[]; totalBytes: number; note?: string }
interface JunkScanResult { groups: JunkGroup[]; totalBytes: number; totalFiles: number; durationMs: number; hardExcludedCount: number }
interface CleanReport { batchId: string; cleaned: number; failed: number; freedBytes: number; undoable: boolean; errors: Array<{ path: string; message: string }> }
interface RecycleItem { id: number; batch_id: string; recycled_path: string; orig_path: string; size: number; ts: number; expires_at: number; restored: number }

/* ---------------- 状态 ---------------- */
const sub = ref<'clean' | 'recycle' | 'empty' | 'residue' | 'chat' | 'browser' | 'deep'>('clean')

/* 空文件夹（v2.0 F2） */
const emptyRoot = ref('')
const emptyQuasi = ref(false)
const emptyScanning = ref(false)
const emptyResult = ref<{ dirs: Array<{ path: string; quasi: boolean; fileCount: number; size: number }>; totalBytes: number; skippedByAttr: number; durationMs: number } | null>(null)
const emptyChecked = ref<Set<string>>(new Set())
const emptyMsg = ref('')

/* 微信/QQ 专清（v3.1 G11——红线 21：聊天记录物理隔离在引擎层；谨慎级默认不勾） */
interface ChatAccount { app: string; id: string; root: string; size: number }
interface ChatItem { path: string; size: number; mtime: number; zone: string; level: string; what: string; session?: string }
const chatAccounts = ref<ChatAccount[]>([])
const chatItems = ref<ChatItem[]>([])
const chatChecked = ref<Set<string>>(new Set())
const chatBusy = ref(false)
const chatMonths = ref(6)
const chatCur = ref('')
const chatMsg = ref('')

async function switchChat(): Promise<void> {
  sub.value = 'chat'
  if (chatAccounts.value.length || chatBusy.value) return
  await loadChatAccounts()
}
async function loadChatAccounts(): Promise<void> {
  chatBusy.value = true
  try {
    chatAccounts.value = (await window.cs?.chatAccounts()) || []
    chatMsg.value = chatAccounts.value.length ? `发现 ${chatAccounts.value.length} 个账号` : '未发现微信/QQ 数据目录（正常登录使用后会生成）'
  } finally { chatBusy.value = false }
}
async function scanChat(acct: ChatAccount): Promise<void> {
  chatBusy.value = true
  chatCur.value = acct.id
  chatChecked.value = new Set()
  try {
    chatItems.value = (await window.cs?.chatScan(acct, purify(chatMonths.value))) || []
    const safeB = chatItems.value.filter(i => i.level === 'safe').reduce((s, i) => s + i.size, 0)
    const cautB = chatItems.value.filter(i => i.level === 'caution').reduce((s, i) => s + i.size, 0)
    chatMsg.value = `${acct.id}：🟢 缓存 ${(safeB / 1024 ** 2).toFixed(0)}MB · 🟡 聊天内容 ${(cautB / 1024 ** 2).toFixed(0)}MB（默认不勾）`
  } finally { chatBusy.value = false }
}
function toggleChat(path: string): void {
  const s2 = new Set(chatChecked.value)
  if (s2.has(path)) s2.delete(path); else s2.add(path)
  chatChecked.value = s2
}
function toggleZone(zone: string, level: string): void {
  const paths = chatItems.value.filter(i => i.zone === zone).map(i => i.path)
  const allIn = paths.length > 0 && paths.every(p => chatChecked.value.has(p))
  const s2 = new Set(chatChecked.value)
  if (allIn) paths.forEach(p => s2.delete(p))
  else if (level === 'safe') paths.forEach(p => s2.add(p))
  chatChecked.value = s2
}
/* v4.2.7 聊天全选/反选/清空 */
function chatSelectAll(): void {
  const s2 = new Set(chatChecked.value)
  for (const i of chatItems.value) if (i.level === 'safe') s2.add(i.path) // 只加缓存——聊天内容仍需逐项确认（红线 21 精神）
  chatChecked.value = s2
}
function chatInvert(): void {
  const s2 = new Set<string>()
  for (const i of chatItems.value) {
    if (i.level === 'caution') continue // 谨慎项不参与反选（防误选聊天内容）
    if (!chatChecked.value.has(i.path)) s2.add(i.path)
  }
  chatChecked.value = s2
}
function chatClear(): void { chatChecked.value = new Set() }

async function cleanChat(): Promise<void> {
  const victims = chatItems.value.filter(i => chatChecked.value.has(i.path))
  if (!victims.length) { chatMsg.value = '先勾选要清理的项'; return }
  const caut = victims.filter(i => i.level === 'caution').length
  const warn = caut > 0 ? `\n⚠️ 含 ${caut} 项聊天内容：清理后聊天中对应文件/图片将无法查看！` : ''
  if (!window.confirm(`将 ${victims.length} 项移入回收站（可恢复）？${warn}\n建议先关闭微信/QQ。`)) return
  try {
    const r = await window.cs?.junkClean(victims.map(v => ({ path: v.path, size: v.size, mtime: v.mtime })), 'confirmed')
    chatMsg.value = `已软删除（批次 ${r?.batchId}），回收站可恢复`
    const a = chatAccounts.value.find(x => x.id === chatCur.value)
    if (a) void scanChat(a)
  } catch (e) { chatMsg.value = (e as Error).message }
}

/* 浏览器细分专清（v3.2 G6——红线 18：五类数据物理隔离在引擎层） */
interface BProfile { browser: string; name: string; root: string; sizeMB: number }
interface BItem { path: string; size: number; mtime: number; zone: string; level: string; what: string }
const bProfiles = ref<BProfile[]>([])
const bItems = ref<BItem[]>([])
const bChecked = ref<Set<string>>(new Set())
const bBusy = ref(false)
const bCur = ref('')
const bMsg = ref('')

async function switchBrowser(): Promise<void> {
  sub.value = 'browser'
  if (bProfiles.value.length || bBusy.value) return
  bBusy.value = true
  try {
    bProfiles.value = (await window.cs?.browserProfiles()) || []
    bMsg.value = bProfiles.value.length ? `发现 ${bProfiles.value.length} 个浏览器 Profile` : '未发现 Chrome/Edge/Firefox 数据'
  } finally { bBusy.value = false }
}
async function scanBrowser(p: BProfile): Promise<void> {
  bBusy.value = true
  bCur.value = p.name
  bChecked.value = new Set() // 全不预选（caution 不勾；safe 也不预选——用户自己选）
  try {
    const running = await window.cs?.browserRunning(p.browser)
    bItems.value = (await window.cs?.browserScan(p)) || []
    const safeB = bItems.value.filter(i => i.level === 'safe').reduce((s, i) => s + i.size, 0)
    bMsg.value = `${p.name}：🟢 缓存 ${(safeB / 1024 ** 2).toFixed(0)}MB 可清${running ? '（⚠️ 浏览器运行中，建议先关闭——锁定文件会跳过）' : ''}`
  } finally { bBusy.value = false }
}
function toggleB(path: string): void {
  const s2 = new Set(bChecked.value)
  if (s2.has(path)) s2.delete(path); else s2.add(path)
  bChecked.value = s2
}
async function cleanBrowser(): Promise<void> {
  const victims = bItems.value.filter(i => bChecked.value.has(i.path))
  if (!victims.length) { bMsg.value = '先勾选'; return }
  if (!window.confirm(`将 ${victims.length} 项浏览器缓存移入回收站？\n🟡 站点数据清理后部分网站需重新登录。`)) return
  try {
    const r = await window.cs?.junkClean(victims.map(v => ({ path: v.path, size: v.size, mtime: v.mtime })), 'confirmed')
    bMsg.value = `已软删除（批次 ${r?.batchId}）`
    const p = bProfiles.value.find(x => x.name === bCur.value)
    if (p) void scanBrowser(p)
  } catch (e) { bMsg.value = (e as Error).message }
}

/* 深度专清（v3.2 G5——红线 17） */
interface DeepRep { admin: boolean; winSxS: { supported: boolean; actualSizeGB: number | null; reclaimableGB: number | null; raw?: string }; restorePoints: { count: number; totalGB: number | null }; hiberfil: { present: boolean; sizeGB: number | null }; pagefile: { present: boolean; sizeGB: number | null }; dump: { present: boolean; sizeGB: number | null; path?: string } }
const deepRep = ref<DeepRep | null>(null)
const deepBusy = ref(false)
const deepMsg = ref('')
const deepActions = [
  { id: 'winsxs', title: '清理 WinSxS 组件仓库', consequence: '删除已替换的旧组件版本。耗时 5~20 分钟；不会影响已安装更新（绝不使用 /ResetBase）。', reversible: true, typed: false },
  { id: 'restore-oldest', title: '删除旧还原点（保留最近 1 个）', consequence: '被删的还原点无法恢复——删除后不能再回退到那些时间点。保留最近 1 个。', reversible: false, typed: true },
  { id: 'hiberfil-off', title: '关闭休眠（释放 hiberfil.sys）', consequence: '失去休眠与快速启动；开机可能稍慢。重新开启：powercfg /h on。', reversible: true, typed: false }
]
const deepLog = ref('')

async function switchDeep(): Promise<void> {
  sub.value = 'deep'
  if (deepRep.value || deepBusy.value) return
  await deepAnalyze()
}
async function deepAnalyze(): Promise<void> {
  deepBusy.value = true
  deepMsg.value = '正在分析（DISM 组件分析可能需要几分钟）…'
  try {
    deepRep.value = (await window.cs?.deepAnalyze()) || null
    deepMsg.value = ''
  } finally { deepBusy.value = false }
}
async function runDeep(a: { id: string; title: string; consequence: string; reversible: boolean; typed: boolean }): Promise<void> {
  if (deepRep.value && !deepRep.value.admin) {
    if (!window.confirm('深度清理需要管理员权限——现在重启应用并请求授权？（UAC 窗口可拒绝）')) return
    await window.cs?.deepElevate()
    return
  }
  // 后果说明卡（红线 17：白话+影响+可逆性）
  const rev = a.reversible ? '✅ 可逆' : '🔴 不可逆'
  if (!window.confirm(`${a.title}\n\n${a.consequence}\n\n${rev}${a.typed ? '\n\n此操作不可逆！' : ''}\n\n确认执行？`)) return
  if (a.typed) {
    const t = window.prompt(`此操作不可逆。请输入「确认」继续：`)
    if (t !== '确认') { deepMsg.value = '已取消（未输入确认）'; return }
  }
  deepBusy.value = true
  deepMsg.value = `${a.title} 执行中…（可能需要较长时间）`
  try {
    const r = await window.cs?.deepExecute(a.id)
    deepLog.value = `> ${r?.command}\n${r?.output}\n\n${deepLog.value}`
    deepMsg.value = r?.ok ? `${a.title} 完成` : (r?.output || '失败')
    await deepAnalyze()
  } finally { deepBusy.value = false }
}

/* 卸载残留（v2.3 F5——谨慎级：默认不勾，红线 8 双重校验在引擎层） */
interface ResidueItem { path: string; size: number; files: number; mtime: number; guess: string }
const residueItems = ref<ResidueItem[]>([])
const residueChecked = ref<Set<string>>(new Set())
const residueBusy = ref(false)
const residueMsg = ref('')

async function switchResidue(): Promise<void> {
  sub.value = 'residue'
  if (residueItems.value.length || residueBusy.value) return
  await scanResidue()
}
async function scanResidue(): Promise<void> {
  residueBusy.value = true
  residueMsg.value = ''
  residueChecked.value = new Set() // 谨慎级：绝不预选
  try {
    const r = await window.cs?.residueScan()
    residueItems.value = r?.items || []
    residueMsg.value = `比对注册表已装 ${r?.installedCount || 0} 款软件，发现 ${residueItems.value.length} 个疑似残留（${(r!.items.reduce((s2, i) => s2 + i.size, 0) / 1024 ** 2).toFixed(0)}MB）`
  } catch (e) {
    residueMsg.value = (e as Error).message
  } finally {
    residueBusy.value = false
  }
}
function toggleResidue(path: string): void {
  const s2 = new Set(residueChecked.value)
  if (s2.has(path)) s2.delete(path)
  else s2.add(path)
  residueChecked.value = s2
}
async function cleanResidue(): Promise<void> {
  const victims = residueItems.value.filter((i) => residueChecked.value.has(i.path))
  if (!victims.length) { residueMsg.value = '先勾选要清理的残留目录'; return }
  if (!window.confirm(`将 ${victims.length} 个残留目录移入回收站（可恢复）？\n⚠️ 若其中有你仍在用的绿色版/便携版软件，请先取消勾选。`)) return
  try {
    const r = await window.cs?.junkClean(victims.map((v) => ({ path: v.path, size: v.size, mtime: v.mtime })), 'confirmed')
    residueMsg.value = `已软删除 ${r?.cleaned || 0} 项（批次 ${r?.batchId}）`
    void scanResidue()
  } catch (e) {
    residueMsg.value = (e as Error).message
  }
}

async function scanEmpty(): Promise<void> {
  const root = emptyRoot.value.trim()
  if (!root) { emptyMsg.value = '请填写要检查的目录'; return }
  emptyScanning.value = true
  emptyMsg.value = ''
  try {
    emptyResult.value = (await window.cs?.emptydirsScan(root, purify(emptyQuasi.value))) || null
    emptyChecked.value = new Set(emptyResult.value?.dirs.map((d) => d.path) || [])
  } catch (e) {
    emptyMsg.value = (e as Error).message
  } finally {
    emptyScanning.value = false
  }
}

function toggleEmpty(path: string): void {
  const s = new Set(emptyChecked.value)
  if (s.has(path)) s.delete(path)
  else s.add(path)
  emptyChecked.value = s
}

async function cleanEmpty(): Promise<void> {
  const list = [...emptyChecked.value]
  if (!list.length) { emptyMsg.value = '先勾选要删除的空目录'; return }
  if (!window.confirm(`直接删除 ${list.length} 个空目录（含准空标记文件）？\n空目录不进回收站，删除前请确认清单。`)) return
  try {
    const r = await window.cs?.emptydirsDelete(list)
    if (r) {
      emptyMsg.value = `已删除 ${r.ok} 个${r.fail.length ? `，失败 ${r.fail.length} 个（${r.fail[0].reason}）` : ''}`
      void scanEmpty()
    }
  } catch (e) {
    emptyMsg.value = (e as Error).message
  }
}
const scanning = ref(false)
const result = ref<JunkScanResult | null>(null)
const scanError = ref('')
const showExpert = ref(false)
const checked = ref<Set<string>>(new Set()) // ruleId 粒度
const excluded = ref<Set<string>>(new Set()) // 预览时排除的单文件
const big = ref<{ BIG_BYTES: number; BIG_FILES: number }>({ BIG_BYTES: 10 * 1024 ** 3, BIG_FILES: 500 })

/* 预览弹窗 */
const previewOpen = ref(false)
const previewFiles = ref<JunkFile[]>([])
const previewSearch = ref('')

/* 执行确认弹窗 */
const confirmOpen = ref(false)
const confirmText = ref('')
const needText = ref(false)

/* 完成报告弹窗 */
const reportOpen = ref(false)
const report = ref<CleanReport | null>(null)

/* v4.2.4 清理进度浮条（修复确认后无反馈） */
const cleanProg = ref<{ done: number; total: number; phase: string } | null>(null)
let offCleanProg: (() => void) | null = null
async function pickEmptyRoot(): Promise<void> { const d = await window.cs?.pickDir?.('选择要检查空目录的根目录'); if (d) emptyRoot.value = d }

onMounted(() => {
  offCleanProg = window.cs?.onCleanProgress?.((p) => {
    cleanProg.value = p
    if (p.phase === 'done') setTimeout(() => { cleanProg.value = null }, 900)
  }) || null
})
onBeforeUnmount(() => offCleanProg?.())

/* 回收站 */
const recycleItems = ref<RecycleItem[]>([])
const recycleLoading = ref(false)

/* ---------------- 计算属性 ---------------- */
const visibleGroups = computed(() => (result.value?.groups || []).filter((g) => g.risk !== 'expert' || showExpert.value))

const selectedFiles = computed<JunkFile[]>(() => {
  const out: JunkFile[] = []
  for (const g of visibleGroups.value) {
    if (!checked.value.has(g.ruleId)) continue
    for (const f of g.files) if (!excluded.value.has(f.path)) out.push(f)
  }
  return out
})

const selectedBytes = computed(() => selectedFiles.value.reduce((s, f) => s + f.size, 0))

/* v4.2.7 全选/反选/清空（按规则组粒度——与现有勾选模型一致） */
/* v4.2.7 空目录全选/反选/清空（只选真空目录——quasi 伪空不自动选） */
function emptySelectAll(): void {
  const s = new Set<string>()
  for (const d of emptyResult.value?.dirs || []) if (!d.quasi) s.add(d.path)
  emptyChecked.value = s
}
function emptyInvert(): void {
  const s = new Set<string>()
  for (const d of emptyResult.value?.dirs || []) {
    if (d.quasi) continue
    if (!emptyChecked.value.has(d.path)) s.add(d.path)
  }
  emptyChecked.value = s
}
function emptyClear(): void { emptyChecked.value = new Set() }

/* v4.2.7 残留全选/反选/清空（谨慎级——绝不预选原则下，用户主动全选才生效） */
function residueSelectAll(): void {
  const s2 = new Set<string>()
  for (const i of residueItems.value) s2.add(i.path)
  residueChecked.value = s2
}
function residueInvert(): void {
  const s2 = new Set<string>()
  for (const i of residueItems.value) if (!residueChecked.value.has(i.path)) s2.add(i.path)
  residueChecked.value = s2
}
function residueClear(): void { residueChecked.value = new Set() }

function selectAllRules(): void {
  for (const g of visibleGroups.value) {
    if (g.risk === 'expert' && !showExpert.value) continue
    checked.value.add(g.ruleId)
  }
  checked.value = new Set(checked.value)
}
function invertRules(): void {
  const s = new Set<string>()
  for (const g of visibleGroups.value) {
    if (g.risk === 'expert' && !showExpert.value) continue
    if (!checked.value.has(g.ruleId)) s.add(g.ruleId)
  }
  checked.value = s
}
function clearRules(): void {
  checked.value = new Set()
}
const isBigBatch = computed(() => selectedBytes.value > big.value.BIG_BYTES || selectedFiles.value.length > big.value.BIG_FILES)

const filteredPreview = computed(() => {
  const q = previewSearch.value.trim().toLowerCase()
  const list = q ? previewFiles.value.filter((f) => f.path.toLowerCase().includes(q)) : previewFiles.value
  return list.slice(0, 400)
})

/* 回收站按批次分组 */
const recycleBatches = computed(() => {
  const map = new Map<string, { batchId: string; count: number; bytes: number; ts: number; expiresAt: number }>()
  for (const it of recycleItems.value) {
    const b = map.get(it.batch_id) || { batchId: it.batch_id, count: 0, bytes: 0, ts: it.ts, expiresAt: it.expires_at }
    b.count++
    b.bytes += it.size
    map.set(it.batch_id, b)
  }
  return [...map.values()].sort((a, b) => b.ts - a.ts)
})

/* ---------------- 动作 ---------------- */
async function scan(): Promise<void> {
  scanning.value = true
  scanError.value = ''
  try {
    big.value = (await window.cs?.junkThresholds()) || big.value
    const r = await window.cs?.junkScan()
    result.value = r || null
    // 空结果反馈：有可清内容 0 时明示（而非看似无反应）
    if (r && r.totalFiles === 0 && r.durationMs < 50) scanError.value = '未发现可清理垃圾（本次扫描几乎瞬时完成——若刚清理过属正常）'
    // 默认勾选 safe 组
    const sel = new Set<string>()
    for (const g of result.value?.groups || []) if (g.risk === 'safe' && g.files.length > 0) sel.add(g.ruleId)
    checked.value = sel
    excluded.value = new Set()
  } catch (e) {
    scanError.value = (e as Error).message
  } finally {
    scanning.value = false
  }
}

function toggleGroup(ruleId: string): void {
  const s = new Set(checked.value)
  if (s.has(ruleId)) s.delete(ruleId)
  else s.add(ruleId)
  checked.value = s
}

/** 第二级：明细预览 */
function openPreview(): void {
  previewFiles.value = selectedFiles.value
  previewSearch.value = ''
  previewOpen.value = true
}

/** 第三级：执行确认（小批量直接确认；大批量输入"确认"） */
function goConfirm(): void {
  previewOpen.value = false
  needText.value = isBigBatch.value
  confirmText.value = ''
  confirmOpen.value = true
}

async function execute(): Promise<void> {
  const level = needText.value && confirmText.value.trim() !== '确认' ? null : needText.value ? 'text-confirmed' : 'confirmed'
  if (!level) return
  confirmOpen.value = false
  scanning.value = true
  try {
    report.value = (await window.cs?.junkClean(selectedFiles.value.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime })), level)) || null
    reportOpen.value = true
    checked.value = new Set()
    void scan()
  } catch (e) {
    scanError.value = (e as Error).message
  } finally {
    scanning.value = false
  }
}

async function undo(): Promise<void> {
  if (!report.value?.batchId) return
  const r = await window.cs?.junkUndo(report.value.batchId)
  if (r) {
    reportOpen.value = false
    report.value = null
    void scan()
  }
}

async function loadRecycle(): Promise<void> {
  recycleLoading.value = true
  try {
    recycleItems.value = (await window.cs?.recycleList()) || []
  } finally {
    recycleLoading.value = false
  }
}

async function restoreBatchFn(batchId: string): Promise<void> {
  await window.cs?.recycleRestore(batchId)
  void loadRecycle()
}

async function purgeBatchFn(batchId: string): Promise<void> {
  if (!window.confirm('彻底删除该批次？此操作不可恢复！')) return
  await window.cs?.recyclePurge(batchId)
  void loadRecycle()
}

/* ============ v4.2.8 永久删除增强 ============ */
const rcChecked = ref<Set<string>>(new Set()) // 勾选的批次
const sysRecycle = ref<{ files: number; bytes: number } | null>(null)
const sysClearing = ref(false)

function toggleRcBatch(id: string): void {
  const s = new Set(rcChecked.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  rcChecked.value = s
}
function rcSelectAll(): void { rcChecked.value = new Set(recycleBatches.value.map(b => b.batchId)) }
function rcClearSel(): void { rcChecked.value = new Set() }
async function purgeChecked(): Promise<void> {
  const ids = [...rcChecked.value]
  if (!ids.length) return
  if (!window.confirm(`永久删除勾选的 ${ids.length} 个批次？\n此操作不可恢复（磁盘直删，不进任何回收站）！`)) return
  await window.cs?.recyclePurgeMany?.(ids)
  rcChecked.value = new Set()
  void loadRecycle(); void loadSysRecycle()
}
async function purgeAllFn(): Promise<void> {
  const n = recycleBatches.value.length
  if (!n) return
  if (!window.confirm(`清空全部 ${n} 个批次（应用回收站）？\n此操作不可恢复（磁盘直删）！`)) return
  await window.cs?.recyclePurgeAll?.()
  rcChecked.value = new Set()
  void loadRecycle(); void loadSysRecycle()
}
async function loadSysRecycle(): Promise<void> {
  sysRecycle.value = await window.cs?.sysRecycleStats?.() || { files: 0, bytes: 0 }
}
async function clearSysRecycle(): Promise<void> {
  if (!sysRecycle.value?.files) return
  if (!window.confirm(`清空 Windows 回收站（${sysRecycle.value.files.toLocaleString()} 项 / ${formatBytes(sysRecycle.value.bytes)}）？\n此操作不可恢复！`)) return
  sysClearing.value = true
  try {
    const r = await window.cs?.sysRecycleClear?.()
    if (r && !r.ok) window.alert('清空失败：' + (r.error || '未知错误'))
    await loadSysRecycle()
  } finally { sysClearing.value = false }
}

function switchSub(s: 'clean' | 'recycle'): void {
  sub.value = s
  if (s === 'recycle') { void loadRecycle(); void loadSysRecycle() }
}

const fileTime = (t: number): string => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '--')
const daysLeft = (t: number): string => Math.max(0, Math.ceil((t - Date.now()) / 86400000)) + ' 天'

window.addEventListener('cs:recycle', () => { sub.value = 'recycle'; void loadSysRecycle() })
onMounted(() => { void scan() })
</script>

<template>
  <div class="clean">
    <!-- 子页切换 -->
    <!-- v4.2.4 清理/回收站进度浮条 -->
    <section v-if="cleanProg" class="glass clean-prog">
      <template v-if="cleanProg.phase === 'cleaning' || cleanProg.phase === 'start'">
        <span>🧹 正在清理 {{ cleanProg.done }}/{{ cleanProg.total }}…</span>
        <div class="cp-bar"><div class="cp-fill" :style="{ width: (cleanProg.total ? cleanProg.done / cleanProg.total * 100 : 0).toFixed(1) + '%' }"></div></div>
      </template>
      <template v-else-if="cleanProg.phase === 'purge-start' || cleanProg.phase === 'purging'">
        <span>♻️ 正在彻底删除 {{ cleanProg.done }} 项…（不可恢复）</span>
        <div class="cp-bar"><div class="cp-fill danger"></div></div>
      </template>
    </section>

    <div class="tabs">
      <button class="tab" :class="{ active: sub === 'clean' }" @click="switchSub('clean')">{{ tr('tJunk') }}</button>
      <button class="tab" :class="{ active: sub === 'recycle' }" @click="switchSub('recycle')">{{ tr('tRecycle') }}（{{ recycleItems.length || '' }}）</button>
      <button class="tab" :class="{ active: sub === 'empty' }" @click="sub = 'empty'">{{ tr('tEmpty') }}</button>
      <button class="tab" :class="{ active: sub === 'residue' }" @click="switchResidue()">{{ tr('tResidue') }}</button>
      <button class="tab" :class="{ active: sub === 'chat' }" @click="switchChat()">{{ tr('tChat') }}</button>
      <button class="tab" :class="{ active: sub === 'browser' }" @click="switchBrowser()">{{ tr('tBrowser') }}</button>
      <button class="tab" :class="{ active: sub === 'deep' }" @click="switchDeep()">{{ tr('tDeep') }}</button>
    </div>

    <!-- ============ 清扫子页 ============ -->
    <template v-if="sub === 'clean'">
      <section class="glass hero">
        <div class="hero-main">
          <div class="hero-title">
            可释放空间：
            <b class="hl">{{ result ? formatBytes(result.totalBytes) : '…' }}</b>
          </div>
          <div class="hero-desc">
            {{ result ? `共 ${result.totalFiles.toLocaleString()} 个垃圾文件 · 硬排除保护 ${result.hardExcludedCount} 项 · 扫描 ${(result.durationMs / 1000).toFixed(1)}s` : '准备扫描…' }}
          </div>
          <div class="hero-actions">
            <span class="sel-tools">
              <button class="op" @click="selectAllRules">全选</button>
              <button class="op" @click="invertRules">反选</button>
              <button class="op" @click="clearRules">清空</button>
            </span>
            <button class="cs-btn" :disabled="scanning" @click="scan()">{{ scanning ? '扫描中…' : '重新扫描' }}</button>
            <button class="cs-btn primary" :disabled="scanning || selectedFiles.length === 0" @click="openPreview">
              预览清理（{{ selectedFiles.length.toLocaleString() }} 项 / {{ formatBytes(selectedBytes) }}）
            </button>
          </div>
        </div>
      </section>

      <section v-if="scanError" class="glass prog err">⚠️ {{ scanError }}</section>

      <template v-for="g in visibleGroups" :key="g.ruleId">
        <section class="glass grp" :class="g.risk">
          <div class="grp-head" @click="toggleGroup(g.ruleId)">
            <label class="chk" @click.stop>
              <input type="checkbox" :checked="checked.has(g.ruleId)" :disabled="g.files.length === 0" @change="toggleGroup(g.ruleId)" />
            </label>
            <div class="grp-info">
              <div class="grp-name">
                {{ g.name }}
                <span class="lvl" :class="g.risk">{{ { safe: '安全', caution: '谨慎', expert: '专家' }[g.risk] }}</span>
              </div>
              <div class="grp-desc">{{ g.desc }}<template v-if="g.consequence"> · ⚠️ {{ g.consequence }}</template></div>
            </div>
            <div class="grp-stats">
              <b>{{ formatBytes(g.totalBytes) }}</b>
              <span>{{ g.files.length.toLocaleString() }} 个文件</span>
            </div>
          </div>
        </section>
      </template>

      <section v-if="!showExpert" class="glass expert-toggle" @click="showExpert = true">
        🔒 展开专家级项目（休眠文件 / 内存转储，默认隐藏）
      </section>
    </template>

    <!-- ============ 回收站子页 ============ -->
    <template v-else-if="sub === 'recycle'">
      <section class="glass hero small">
        <div class="hero-main">
          <div class="hero-title">应用内回收站</div>
          <div class="hero-desc">清理的文件先到这里，默认保留 15 天，到期自动清除。可按批次恢复到原路径。</div>
        </div>
        <span class="sel-tools">
          <button class="op" @click="rcSelectAll">全选</button>
          <button class="op" @click="rcClearSel">取消勾选</button>
          <button class="op del" :disabled="!rcChecked.size" @click="purgeChecked">永久删除勾选（{{ rcChecked.size }}）</button>
          <button class="op del" :disabled="!recycleBatches.length" @click="purgeAllFn">清空全部</button>
        </span>
        <button class="cs-btn" :disabled="recycleLoading" @click="loadRecycle(); loadSysRecycle()">刷新</button>
      </section>
      <section class="glass card sys-recycle">
        <div class="row">
          <label>🖥️ Windows 回收站</label>
          <span v-if="sysRecycle" class="grow">{{ sysRecycle.files.toLocaleString() }} 项 · {{ formatBytes(sysRecycle.bytes) }}<span v-if="!sysRecycle.files">（系统回收站是空的）</span></span>
          <span v-else class="grow tip">统计中…</span>
          <button class="cs-btn danger sm" :disabled="sysClearing || !sysRecycle?.files" @click="clearSysRecycle">{{ sysClearing ? '清空中…' : '一键清空' }}</button>
        </div>
        <p class="tip">这是 Windows 系统回收站（资源管理器里那个），与上方应用内回收站相互独立。清空 = 永久删除，不可恢复。</p>
      </section>
      <section v-for="b in recycleBatches" :key="b.batchId" class="glass grp">
        <div class="grp-head">
          <label class="chk"><input type="checkbox" :checked="rcChecked.has(b.batchId)" @change="toggleRcBatch(b.batchId)" /></label>
          <div class="grp-info">
            <div class="grp-name">批次 {{ b.batchId }}</div>
            <div class="grp-desc">{{ fileTime(b.ts) }} · 剩余 {{ daysLeft(b.expiresAt) }}</div>
          </div>
          <div class="grp-stats">
            <b>{{ formatBytes(b.bytes) }}</b>
            <span>{{ b.count.toLocaleString() }} 项</span>
          </div>
          <div class="grp-ops">
            <button class="op" @click="restoreBatchFn(b.batchId)">全部恢复</button>
            <button class="op del" @click="purgeBatchFn(b.batchId)">彻底删除</button>
          </div>
        </div>
      </section>
      <section v-if="!recycleBatches.length && !recycleLoading" class="glass empty">回收站是空的</section>
    </template>

    <!-- ============ 微信/QQ 专清（v3.1 G11） ============ -->
    <template v-else-if="sub === 'chat'">
      <section class="glass card">
        <div class="row">
          <label>聊天软件专清</label>
          <span class="tip-inline">只清缓存与接收文件 · 聊天记录数据库物理隔离（永不扫描）</span>
          <div class="grow"></div>
          <label class="tip-inline">只清 {{ chatMonths }} 个月前的</label>
          <input v-model.number="chatMonths" type="range" min="1" max="24" style="width:110px" />
          <button class="cs-btn sm" :disabled="chatBusy" @click="loadChatAccounts">刷新账号</button>
          <span class="sel-tools"><button class="op" @click="chatSelectAll">全选缓存</button><button class="op" @click="chatInvert">反选</button><button class="op" @click="chatClear">清空</button></span>
            <button class="cs-btn danger sm" :disabled="chatBusy || chatChecked.size === 0" @click="cleanChat">清理勾选（{{ chatChecked.size }}）</button>
        </div>
        <p class="tip">🔒 聊天记录（Msg 数据库）不扫描、不展示、无任何清理入口。🟡 聊天图片/视频/文件清理后无法在聊天中查看。</p>
        <section v-if="chatMsg" class="prog">{{ chatMsg }}</section>
      </section>
      <section v-for="a in chatAccounts" :key="a.root" class="glass grp" :class="{ on: chatCur === a.id }">
        <div class="g-info">
          <div class="g-dir">{{ a.app === 'wechat' ? '💚 微信' : '🐧 QQ' }} · {{ a.id }}</div>
          <div class="g-sub">总占用 {{ (a.size / 1024 ** 3).toFixed(2) }} GB</div>
        </div>
        <button class="cs-btn sm" :disabled="chatBusy" @click="scanChat(a)">{{ chatCur === a.id ? '重新扫描' : '扫描' }}</button>
      </section>
      <section v-if="chatItems.length" class="glass card">
        <div v-for="z in [...new Set(chatItems.map(i => i.zone))]" :key="z" class="chat-zone">
          <div class="cz-head" @click="toggleZone(z, chatItems.find(i => i.zone === z)!.level)">
            <b>{{ chatItems.find(i => i.zone === z)?.what }}</b>
            <span class="cz-tag" :class="chatItems.find(i => i.zone === z)?.level">{{ chatItems.find(i => i.zone === z)?.level === 'safe' ? '🟢 缓存（可整区勾选）' : '🟡 聊天内容（逐项勾）' }}</span>
            <span class="cz-size">{{ (chatItems.filter(i => i.zone === z).reduce((s, i) => s + i.size, 0) / 1024 ** 2).toFixed(1) }}MB</span>
          </div>
          <p v-if="chatItems.find(i => i.zone === z)?.level === 'caution'" class="cz-warn">⚠️ 清理后聊天中的对应内容将无法查看</p>
          <div v-for="i in chatItems.filter(x => x.zone === z).slice(0, 60)" :key="i.path" class="chat-row">
            <span class="c-ck"><input type="checkbox" :checked="chatChecked.has(i.path)" @change="toggleChat(i.path)" /></span>
            <span class="cz-path" :title="i.path">{{ i.session ? '【' + i.session + '】' : '' }}{{ i.path.split(/[\\/]/).pop() }}</span>
            <span class="cz-date">{{ new Date(i.mtime).toLocaleDateString('zh-CN') }}</span>
            <span class="cz-size">{{ (i.size / 1024).toFixed(0) }}KB</span>
          </div>
        </div>
      </section>
    </template>

    <!-- ============ 浏览器细分专清（v3.2 G6） ============ -->
    <template v-else-if="sub === 'browser'">
      <section class="glass card">
        <div class="row">
          <label>浏览器细分专清</label>
          <span class="tip-inline">Cache/Code Cache/GPUCache 安全 · 站点数据谨慎 · 书签密码历史扩展自动填充物理隔离</span>
          <div class="grow"></div>
          <button class="cs-btn sm" :disabled="bBusy" @click="switchBrowser()">刷新</button>
          <button class="cs-btn danger sm" :disabled="bBusy || bChecked.size === 0" @click="cleanBrowser">清理勾选（{{ bChecked.size }}）</button>
        </div>
        <section v-if="bMsg" class="prog">{{ bMsg }}</section>
      </section>
      <section v-for="p in bProfiles" :key="p.root" class="glass grp" :class="{ on: bCur === p.name }">
        <div class="g-info">
          <div class="g-dir">{{ { chrome: '🔵 Chrome', edge: '🟢 Edge', firefox: '🟠 Firefox' }[p.browser as 'chrome'] || p.browser }} · {{ p.name }}</div>
          <div class="g-sub">{{ p.sizeMB.toFixed(0) }} MB</div>
        </div>
        <button class="cs-btn sm" :disabled="bBusy" @click="scanBrowser(p)">{{ bCur === p.name ? '重新扫描' : '扫描' }}</button>
      </section>
      <section v-if="bItems.length" class="glass card">
        <div v-for="z in [...new Set(bItems.map(i => i.zone))]" :key="z" class="chat-zone">
          <div class="cz-head" style="cursor: default">
            <b>{{ bItems.find(i => i.zone === z)?.what }}</b>
            <span class="cz-tag" :class="bItems.find(i => i.zone === z)?.level">{{ bItems.find(i => i.zone === z)?.level === 'safe' ? '🟢 安全' : '🟡 谨慎（会登出网站）' }}</span>
            <span class="cz-size">{{ (bItems.filter(i => i.zone === z).reduce((s, i) => s + i.size, 0) / 1024 ** 2).toFixed(1) }}MB</span>
          </div>
          <div v-for="i in bItems.filter(x => x.zone === z).slice(0, 30)" :key="i.path" class="chat-row">
            <span class="c-ck"><input type="checkbox" :checked="bChecked.has(i.path)" @change="toggleB(i.path)" /></span>
            <span class="cz-path" :title="i.path">{{ i.path.split(/[\\/]/).pop() }}</span>
            <span class="cz-date">{{ new Date(i.mtime).toLocaleDateString('zh-CN') }}</span>
            <span class="cz-size">{{ (i.size / 1024).toFixed(0) }}KB</span>
          </div>
          <p v-if="bItems.filter(x => x.zone === z).length > 30" class="tip center">… 其余 {{ bItems.filter(x => x.zone === z).length - 30 }} 项</p>
        </div>
      </section>
    </template>

    <!-- ============ C 盘深度专清（v3.2 G5） ============ -->
    <template v-else-if="sub === 'deep'">
      <section class="glass card">
        <div class="row">
          <label>C 盘深度专清</label>
          <span class="tip-inline">WinSxS · 还原点 · 休眠文件——看得见，引导安全清</span>
          <div class="grow"></div>
          <span v-if="deepRep && !deepRep.admin" class="cz-tag caution">⚠️ 非管理员（只读分析）</span>
          <span v-else-if="deepRep?.admin" class="cz-tag safe">✅ 管理员</span>
          <button class="cs-btn sm" :disabled="deepBusy" @click="deepAnalyze()">{{ deepBusy ? '分析中…' : '重新分析' }}</button>
          <button v-if="deepRep && !deepRep.admin" class="cs-btn primary sm" @click="runDeep(deepActions[0])">🔑 提权</button>
        </div>
        <section v-if="deepMsg" class="prog">{{ deepMsg }}</section>
      </section>
      <section v-if="deepRep" class="glass card deep-stats">
        <div class="ds-item"><b>WinSxS 组件仓库</b><span>{{ deepRep.winSxS.actualSizeGB !== null ? deepRep.winSxS.actualSizeGB + ' GB' + (deepRep.winSxS.reclaimableGB !== null ? '（可回收约 ' + deepRep.winSxS.reclaimableGB + ' GB）' : '') : (deepRep.admin ? '分析不支持' : '需管理员') }}</span></div>
        <div class="ds-item"><b>系统还原点</b><span>{{ deepRep.restorePoints.totalGB !== null ? `${deepRep.restorePoints.count} 个 · 约 ${deepRep.restorePoints.totalGB} GB` : '无 / 不可读' }}</span></div>
        <div class="ds-item"><b>休眠文件 hiberfil.sys</b><span>{{ deepRep.hiberfil.present ? deepRep.hiberfil.sizeGB + ' GB' : '未启用' }}</span></div>
        <div class="ds-item"><b>页面文件 pagefile.sys</b><span>{{ deepRep.pagefile.present ? deepRep.pagefile.sizeGB + ' GB（系统必需，绝不清理）' : '无' }}</span></div>
        <div class="ds-item"><b>内存转储</b><span>{{ deepRep.dump.present ? (deepRep.dump.sizeGB + ' GB' + (deepRep.dump.path ? ' · ' + deepRep.dump.path : '')) : '无' }}</span></div>
      </section>
      <section v-for="a in deepActions" :key="a.id" class="glass card deep-act">
        <div class="da-head">
          <b>{{ a.title }}</b>
          <span class="cz-tag" :class="a.reversible ? 'safe' : 'caution'">{{ a.reversible ? '✅ 可逆' : '🔴 不可逆' }}</span>
        </div>
        <p class="da-why">{{ a.consequence }}</p>
        <button class="cs-btn sm" :disabled="deepBusy || (deepRep && !deepRep.admin as unknown as boolean)" @click="runDeep(a)">{{ deepRep?.admin ? '执行' : '需管理员' }}</button>
      </section>
      <section v-if="deepLog" class="glass card deep-log"><pre>{{ deepLog }}</pre></section>
    </template>

    <!-- ============ 卸载残留子页（v2.3 F5） ============ -->
    <template v-else-if="sub === 'residue'">
      <section class="glass card">
        <div class="row">
          <label>残留扫描</label>
          <span class="tip-inline">已卸载软件残留在 AppData/ProgramData 的孤儿目录</span>
          <div class="grow"></div>
          <button class="cs-btn primary sm" :disabled="residueBusy" @click="scanResidue">{{ residueBusy ? '扫描中…' : '重新扫描' }}</button>
          <span class="sel-tools"><button class="op" @click="residueSelectAll">全选</button><button class="op" @click="residueInvert">反选</button><button class="op" @click="residueClear">清空</button></span>
            <button class="cs-btn danger sm" :disabled="residueBusy || residueChecked.size === 0" @click="cleanResidue">清理勾选（{{ residueChecked.size }}）</button>
        </div>
        <p class="tip">⚠️ <b>谨慎级，默认不勾选</b>。局限：绿色版/便携版软件无注册表记录会被误判为残留——请逐项确认。清理走软删除可恢复。</p>
        <section v-if="residueMsg" class="prog">{{ residueMsg }}</section>
      </section>
      <section v-if="residueItems.length" class="glass card">
        <div class="tbl-head"><span class="c-ck"></span><span class="c-path">残留目录</span><span class="c-quasi">疑似软件</span><span class="c-cnt">大小</span></div>
        <div class="tbl-body">
          <div v-for="i in residueItems.slice(0, 200)" :key="i.path" class="tbl-row">
            <span class="c-ck"><input type="checkbox" :checked="residueChecked.has(i.path)" @change="toggleResidue(i.path)" /></span>
            <span class="c-path" :title="i.path">{{ i.path }}</span>
            <span class="c-quasi">{{ i.guess }}</span>
            <span class="c-cnt">{{ (i.size / 1024 ** 2).toFixed(1) }}MB</span>
          </div>
        </div>
      </section>
      <section v-else-if="!residueBusy" class="glass empty">未发现卸载残留</section>
    </template>

    <!-- ============ 空文件夹子页（v2.0 F2） ============ -->
    <template v-else-if="sub === 'empty'">
      <section class="glass card">
        <div class="row">
          <label>检查目录</label>
          <input v-model="emptyRoot" placeholder="如 D:\\ 或 D:\\资料（递归找空目录树）" spellcheck="false" @keyup.enter="scanEmpty" />
          <button class="cs-btn sm" @click="pickEmptyRoot">📁 浏览…</button>
          <button class="cs-btn primary" :disabled="emptyScanning" @click="scanEmpty">{{ emptyScanning ? '扫描中…' : '🔍 扫描空目录' }}</button>
        </div>
        <div class="row opts">
          <label class="chk"><input v-model="emptyQuasi" type="checkbox" :disabled="emptyScanning" /> 含准空目录（仅 Thumbs.db / desktop.ini 的目录）</label>
          <div class="grow"></div>
          <span class="sel-tools"><button class="op" @click="emptySelectAll">全选</button><button class="op" @click="emptyInvert">反选</button><button class="op" @click="emptyClear">清空</button></span>
            <button class="cs-btn danger" :disabled="emptyScanning || emptyChecked.size === 0" @click="cleanEmpty">
            删除勾选（{{ emptyChecked.size }}）
          </button>
        </div>
        <p class="tip">空目录<b>直接删除不进回收站</b>（无内容恢复成本低）；自动跳过 OneDrive/坚果云等同步占位、隐藏/系统属性目录、.git；删除顺序自底向上。</p>
        <section v-if="emptyMsg" class="prog">{{ emptyMsg }}</section>
        <section v-if="emptyResult" class="prog">
          发现 {{ emptyResult.dirs.length }} 个空目录（准空 {{ emptyResult.dirs.filter(d => d.quasi).length }}）· 属性跳过 {{ emptyResult.skippedByAttr }} 项 · {{ (emptyResult.durationMs / 1000).toFixed(1) }}s
        </section>
      </section>

      <section v-if="emptyResult && emptyResult.dirs.length" class="glass card">
        <div class="tbl-head"><span class="c-ck"></span><span class="c-path">目录</span><span class="c-quasi">类型</span><span class="c-cnt">标记文件</span></div>
        <div class="tbl-body">
          <div v-for="d in emptyResult.dirs.slice(0, 400)" :key="d.path" class="tbl-row">
            <span class="c-ck"><input type="checkbox" :checked="emptyChecked.has(d.path)" @change="toggleEmpty(d.path)" /></span>
            <span class="c-path" :title="d.path">{{ d.path }}</span>
            <span class="c-quasi">{{ d.quasi ? '准空' : '全空' }}</span>
            <span class="c-cnt">{{ d.fileCount || '--' }}</span>
          </div>
          <p v-if="emptyResult.dirs.length > 400" class="tip center">… 其余 {{ emptyResult.dirs.length - 400 }} 个</p>
        </div>
      </section>
    </template>

    <!-- ============ 预览弹窗（第二级确认） ============ -->
    <Teleport to="body">
      <div v-if="previewOpen" class="mask" @click.self="previewOpen = false">
        <div class="glass modal wide">
          <h3>明细预览（{{ previewFiles.length.toLocaleString() }} 项）</h3>
          <input v-model="previewSearch" class="search" placeholder="搜索路径，排除不想要的文件…" spellcheck="false" />
          <div class="pv-list">
            <div v-for="f in filteredPreview" :key="f.path" class="pv-row" :class="{ off: excluded.has(f.path) }">
              <span class="pv-path" :title="f.path">{{ f.path }}</span>
              <span class="pv-size">{{ formatBytes(f.size) }}</span>
              <button class="op" @click="excluded.add(f.path); excluded = new Set(excluded)">{{ excluded.has(f.path) ? '已排除' : '排除' }}</button>
            </div>
            <div v-if="filteredPreview.length < previewFiles.length" class="pv-more">… 其余 {{ (previewFiles.length - filteredPreview.length).toLocaleString() }} 项请搜索定位</div>
          </div>
          <div class="m-foot">
            <span class="pv-total">将清理 {{ (previewFiles.length - excluded.size).toLocaleString() }} 项 / {{ formatBytes(previewFiles.filter(f => !excluded.has(f.path)).reduce((s, f) => s + f.size, 0)) }}</span>
            <button class="cs-btn" @click="previewOpen = false">返回再选</button>
            <button class="cs-btn primary" @click="goConfirm">下一步：执行确认</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ 执行确认弹窗（第三级） ============ -->
    <Teleport to="body">
      <div v-if="confirmOpen" class="mask" @click.self="confirmOpen = false">
        <div class="glass modal">
          <h3>{{ isBigBatch ? '⚠️ 大批量清理确认' : '执行确认' }}</h3>
          <p class="cf-text">
            即将软删除 <b>{{ selectedFiles.length.toLocaleString() }}</b> 个文件（{{ formatBytes(selectedBytes) }}）到应用回收站。
            文件不会被真正删除，可在回收站整批恢复。
          </p>
          <p v-if="isBigBatch" class="cf-text warn">
            本次超过大批量阈值（>10GB 或 >500 文件）。请输入「<b>确认</b>」继续：
          </p>
          <input v-if="isBigBatch" v-model="confirmText" class="search" placeholder="输入：确认" spellcheck="false" @keyup.enter="execute" />
          <div class="m-foot">
            <button class="cs-btn" @click="confirmOpen = false">取消</button>
            <button class="cs-btn danger" :disabled="isBigBatch && confirmText.trim() !== '确认'" @click="execute">确认清理</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ============ 完成报告 ============ -->
    <Teleport to="body">
      <div v-if="reportOpen" class="mask" @click.self="reportOpen = false">
        <div class="glass modal">
          <h3>✅ 清理完成</h3>
          <div class="rp-grid">
            <div class="rp-item"><b class="ok">{{ formatBytes(report?.freedBytes || 0) }}</b><span>释放空间</span></div>
            <div class="rp-item"><b>{{ report?.cleaned || 0 }}</b><span>已清理</span></div>
            <div class="rp-item"><b :class="report?.failed ? 'bad' : ''">{{ report?.failed || 0 }}</b><span>失败</span></div>
          </div>
          <p class="cf-text">文件已进入应用回收站（批次 {{ report?.batchId }}），保留 15 天。</p>
          <div class="m-foot">
            <button class="cs-btn" @click="reportOpen = false">完成</button>
            <button class="cs-btn primary" :disabled="!report?.undoable" @click="undo()">↩️ 撤销本次清理</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sys-recycle .row { align-items: center; gap: 14px; }
.sys-recycle .grow { font-size: 14px; }
.sel-tools { display: inline-flex; gap: 4px; margin-right: 10px; align-items: center; }
.sel-tools .op { font-size: 11.5px; padding: 4px 10px; border-radius: 8px; }

.clean-prog { display: flex; align-items: center; gap: 14px; padding: 12px 20px; font-size: 12.5px; color: #A8C7FF; }
.cp-bar { flex: 1; height: 8px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; }
.cp-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #6EA8FF, #9DB8FF); transition: width .18s; }
.cp-fill.danger { background: linear-gradient(90deg, #FF5D6C, #FF8E9A); }

.clean { display: flex; flex-direction: column; gap: 14px; padding-bottom: 12px; }
.tabs { display: flex; gap: 8px; }
.tab { padding: 8px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.tab.active { color: #0A1128; font-weight: 700; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }

.hero { padding: 24px 28px; display: flex; justify-content: space-between; align-items: center; }
.hero.small { padding: 18px 24px; }
.hero-title { font-size: 19px; font-weight: 700; margin-bottom: 6px; }
.hl { color: #37D399; font-size: 24px; }
.hero-desc { color: var(--text-2); font-size: 12.5px; margin-bottom: 14px; }
.hero-actions { display: flex; gap: 10px; }

.deep-stats { display: flex; flex-direction: column; gap: 10px; }
.ds-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; border-radius: 10px; background: rgba(255,255,255,0.04); font-size: 13px; }
.ds-item span { color: var(--text-2); font-size: 12.5px; }
.deep-act { padding: 16px 20px; }
.da-head { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.da-why { font-size: 12.5px; color: var(--text-2); line-height: 1.7; margin: 8px 0 10px; }
.deep-log pre { font-size: 11.5px; white-space: pre-wrap; color: var(--text-2); max-height: 200px; overflow: auto; }
.chat-zone { margin-bottom: 14px; }
.cz-head { display: flex; align-items: center; gap: 10px; padding: 8px 4px; cursor: pointer; font-size: 13px; }
.cz-tag { font-size: 11px; padding: 2px 10px; border-radius: 999px; background: rgba(255,255,255,0.07); }
.cz-tag.safe { color: #37D399; } .cz-tag.caution { color: #FFB86C; }
.cz-size { margin-left: auto; color: #A8C7FF; font-variant-numeric: tabular-nums; font-size: 12px; }
.cz-warn { font-size: 11px; color: #FFB86C; margin: 2px 4px 8px; }
.chat-row { display: grid; grid-template-columns: 30px 1fr 90px 70px; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 8px; font-size: 12px; }
.chat-row:hover { background: rgba(255,255,255,0.05); }
.cz-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cz-date { color: var(--text-3); font-size: 11px; }
.grp.on { border-color: rgba(110,168,255,0.5); }
.prog { padding: 14px 22px; font-size: 13px; color: var(--text-2); }
.prog.err { color: #FFB86C; }

/* v2.0 空文件夹 */
.card { padding: 20px 24px; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.row label { min-width: 72px; font-size: 13px; color: var(--text-2); flex-shrink: 0; }
.row input:not([type="checkbox"]) { flex: 1; padding: 9px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; }
.row input:focus { border-color: rgba(110,168,255,0.6); }
.opts { align-items: center; }
.grow { flex: 1; }
.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.chk input { accent-color: #6EA8FF; }
.tip { font-size: 11.5px; color: var(--text-3); margin-top: 4px; line-height: 1.6; }
.tip.center { text-align: center; margin-top: 10px; }
.tbl-head, .tbl-row { display: grid; grid-template-columns: 36px 1fr 70px 80px; gap: 10px; align-items: center; }
.tbl-head { padding: 8px 12px; font-size: 11px; color: var(--text-3); border-bottom: 1px solid rgba(255,255,255,0.08); }
.tbl-body { max-height: 480px; overflow-y: auto; }
.tbl-row { padding: 8px 12px; border-radius: 10px; font-size: 12.5px; min-height: 36px; }
.tbl-row:hover { background: rgba(255,255,255,0.05); }
.c-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.c-quasi { font-size: 11px; color: var(--text-3); text-align: center; }
.c-cnt { font-size: 12px; color: var(--text-3); text-align: right; font-variant-numeric: tabular-nums; }
input[type="checkbox"] { accent-color: #6EA8FF; }

.grp { padding: 6px 20px; }
.grp-head { display: flex; align-items: center; gap: 14px; padding: 12px 0; cursor: pointer; }
.chk input { width: 18px; height: 18px; accent-color: #6EA8FF; cursor: pointer; }
.grp-info { flex: 1; min-width: 0; }
.grp-name { font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.lvl { padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
.lvl.safe { color: #37D399; background: rgba(55,211,153,0.12); border: 1px solid rgba(55,211,153,0.35); }
.lvl.caution { color: #FFB86C; background: rgba(255,184,108,0.12); border: 1px solid rgba(255,184,108,0.35); }
.lvl.expert { color: #FF5D6C; background: rgba(255,93,108,0.12); border: 1px solid rgba(255,93,108,0.35); }
.grp-desc { font-size: 12px; color: var(--text-2); margin-top: 4px; line-height: 1.5; }
.grp.expert .grp-name { color: #FF8B96; }
.grp-stats { text-align: right; }
.grp-stats b { display: block; font-size: 16px; color: #A8C7FF; }
.grp-stats span { font-size: 11px; color: var(--text-3); }
.grp-ops { display: flex; gap: 8px; }

.expert-toggle { padding: 14px 22px; text-align: center; font-size: 12.5px; color: var(--text-3); cursor: pointer; }
.expert-toggle:hover { color: #FF8B96; }
.empty { padding: 40px; text-align: center; color: var(--text-3); font-size: 13px; }

.op { padding: 5px 12px; border-radius: 10px; font-size: 12px; color: var(--text-2); background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.op:hover { color: var(--text-1); }
.op.del { color: #FF5D6C; }

.mask { position: fixed; inset: 0; background: rgba(4,7,20,0.6); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { width: 560px; max-width: 92vw; max-height: 82vh; padding: 24px 26px; display: flex; flex-direction: column; }
.modal.wide { width: 780px; }
.modal h3 { font-size: 17px; margin-bottom: 14px; }
.search { padding: 10px 14px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; margin-bottom: 12px; }
.search:focus { border-color: rgba(110,168,255,0.6); }
.pv-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.pv-row { display: grid; grid-template-columns: 1fr 90px 70px; gap: 10px; align-items: center; padding: 7px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); font-size: 12px; }
.pv-row.off { opacity: 0.4; }
.pv-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.pv-size { color: #A8C7FF; text-align: right; }
.pv-more { padding: 10px; text-align: center; color: var(--text-3); font-size: 11.5px; }
.m-foot { display: flex; gap: 10px; align-items: center; justify-content: flex-end; margin-top: 16px; }
.m-foot .cs-btn.danger { border-color: rgba(255,93,108,0.55); color: #FF5D6C; }
.pv-total { margin-right: auto; font-size: 12.5px; color: var(--text-2); }

.cf-text { font-size: 13.5px; color: var(--text-2); line-height: 1.7; margin-bottom: 8px; }
.cf-text.warn { color: #FFB86C; }
.rp-grid { display: flex; gap: 12px; margin: 10px 0 14px; }
.rp-item { flex: 1; padding: 14px; border-radius: 14px; background: rgba(255,255,255,0.05); text-align: center; }
.rp-item b { display: block; font-size: 20px; margin-bottom: 4px; }
.rp-item b.ok { color: #37D399; }
.rp-item b.bad { color: #FF5D6C; }
.rp-item span { font-size: 11px; color: var(--text-3); }
</style>
