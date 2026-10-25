<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { tr, purify } from '../i18n'
import * as echarts from 'echarts'
import { formatBytes } from '@shared/format'
import type { DirNode, FileEntry, ScanStats } from '@shared/scanner-types'

/* ---------------- 状态 ---------------- */
interface DiskInfo { drive: string; label: string; totalBytes: number; freeBytes: number; fsType: string }
interface PendingItem { path: string; isDir: boolean; addedAt: number }

const disks = ref<DiskInfo[]>([])
const customPath = ref('')
const scanning = ref(false)
const scanMsg = ref('')
const scanDone = ref(0)
const scanTotal = ref(0)
const scanError = ref('')
const root = ref<DirNode | null>(null)
const stats = ref<ScanStats | null>(null)
const topFiles = ref<FileEntry[]>([])
const cached = ref(false)
const pending = ref<PendingItem[]>([])
const drawerOpen = ref(false)
const tab = ref<'sunburst' | 'topfiles' | 'topdirs' | 'types' | 'timeMachine'>('sunburst')

/* ============ 多磁盘对比（v3.5） ============ */
interface RootCmp { root: string; totalBytes: number; fileCount: number; dirCount: number; lastScanTs: number | null; topTypes: Array<{ type: string; bytes: number; files: number }> }
const cmpRoots = ref<RootCmp[]>([])
const cmpBusy = ref(false)
const cmpMax = computed(() => Math.max(1, ...cmpRoots.value.map(r => r.totalBytes)))

async function loadCompare(): Promise<void> {
  if (cmpRoots.value.length || cmpBusy.value) return
  cmpBusy.value = true
  try { cmpRoots.value = (await window.cs?.compareRoots()) || [] } finally { cmpBusy.value = false }
}
watch(() => tab.value, (t) => { if (t === 'compare') void loadCompare() })

/* ============ 大文件体检（v3.0 G3） ============ */
interface Advice { what: string; advice: string; why: string; kbId?: string; generic?: boolean }
const advMap = ref<Record<string, Advice>>({})
const advOpen = ref<string | null>(null) // 当前展开分析卡的文件路径
const advBusy = ref(false)

async function checkFile(f: { path: string; name: string; size: number }): Promise<void> {
  if (advMap.value[f.path]) { advOpen.value = advOpen.value === f.path ? null : f.path; return }
  advBusy.value = true
  try {
    const r = await window.cs?.advisorAnalyze([f])
    if (r) advMap.value = { ...advMap.value, ...r }
    advOpen.value = f.path
  } finally {
    advBusy.value = false
  }
}
const badgeOf = (a: Advice | undefined): string =>
  a ? ({ safe: '🟢', caution: '🟡', danger: '🔴', unknown: '❓' }[a.advice] || '❓') : '🩺'
const selectable = (a: Advice | undefined): boolean => !!a && (a.advice === 'safe' || a.advice === 'caution')

/* ============ 全局搜索（v2.2 F6） ============ */
interface SearchHit { path: string; name: string; size: number; mtime: number; type: string }
const sqName = ref('')
const sqMinGB = ref<number | null>(null)
const sqAfter30d = ref(false)
const sqResults = ref<SearchHit[] | null>(null)
const sqBusy = ref(false)
const idxStats = ref<{ files: number; roots: string[]; indexedAt: number | null } | null>(null)

async function runSearch(): Promise<void> {
  sqBusy.value = true
  try {
    idxStats.value = (await window.cs?.searchStats()) || null
    const r = await window.cs?.searchQuery({
      namePattern: sqName.value.trim() || undefined,
      minSize: sqMinGB.value ? sqMinGB.value * 1024 ** 3 : undefined,
      after: sqAfter30d.value ? Date.now() - 30 * 24 * 3600e3 : undefined,
      limit: 500
    })
    sqResults.value = r || []
  } finally {
    sqBusy.value = false
  }
}

/* ============ 时光机（v2.1 F3） ============ */
interface SnapMeta { id: number; ts: number; root: string; totalBytes: number; fileCount: number; dirCount: number }
interface DiffEntry { path: string; delta: number; fromSize: number; toSize: number; kind: string }
const snaps = ref<SnapMeta[]>([])
const selA = ref<number | null>(null)
const selB = ref<number | null>(null)
const diffResult = ref<{ grow: DiffEntry[]; shrink: DiffEntry[]; newDirs: DiffEntry[]; goneDirs: DiffEntry[] } | null>(null)
const snapBusy = ref(false)
const snapMsg = ref('')

async function loadSnaps(): Promise<void> {
  snaps.value = (await window.cs?.snapList()) || []
  // 默认选中最新两份
  if (snaps.value.length >= 2 && selA.value === null) {
    selB.value = snaps.value[0].id
    selA.value = snaps.value[1].id
  }
}

async function takeSnap(): Promise<void> {
  const p = customPath.value.trim() || (root.value?.path ?? '')
  if (!p) { snapMsg.value = '先扫描或填写一个目录再拍快照'; return }
  snapBusy.value = true
  snapMsg.value = ''
  try {
    await window.cs?.snapTake(p)
    snapMsg.value = '快照已保存'
    selA.value = null; selB.value = null
    await loadSnaps()
  } catch (e) {
    snapMsg.value = (e as Error).message
  } finally {
    snapBusy.value = false
  }
}

async function runDiff(): Promise<void> {
  if (selA.value === null || selB.value === null) return
  diffResult.value = (await window.cs?.snapDiff(purify(selA.value), purify(selB.value))) || null
}

async function delSnap(id: number): Promise<void> {
  if (!window.confirm('删除这份快照？')) return
  await window.cs?.snapDelete(id)
  selA.value = null; selB.value = null; diffResult.value = null
  await loadSnaps()
}

const fmtTs = (ts: number): string => new Date(ts).toLocaleString('zh-CN', { hour12: false })

/* 旭日图钻取状态：面包屑存路径（大目录时按需取子节点） */
const crumbs = ref<Array<{ name: string; path: string }>>([])
const curNode = ref<DirNode | null>(null)
const drillChildren = ref<Array<{ path: string; name: string; size: number; isDir: boolean }>>([])

let chart: echarts.ECharts | null = null
let chartEl: HTMLElement | null = null
let offProgress: (() => void) | null = null

/* ---------------- 类型色板（深色玻璃） ---------------- */
const TYPE_COLORS: Record<string, string> = {
  视频: '#FF7A9E', 图片: '#6EA8FF', 音频: '#B39DFF', 文档: '#5EEAD4',
  压缩包: '#FFB86C', 安装包: '#FF5D6C', 代码: '#37D399', 其他: '#8B93B8'
}
const SUN_PALETTE = ['#6EA8FF', '#5EEAD4', '#B39DFF', '#FFB86C', '#FF7A9E', '#37D399', '#FFD166', '#7C90FF', '#4DD0E1', '#F08FB6']

/* ---------------- 初始化 ---------------- */
async function pickCustomPath(): Promise<void> { const d = await window.cs?.pickDir?.('选择要扫描的目录'); if (d) customPath.value = d }

onMounted(async () => {
  disks.value = (await window.cs?.disks()) || []
  pending.value = (await window.cs?.pendingList()) || []
  void loadSnaps()
  // v2.4.1：闪退/强关后自动恢复上次扫描（缓存命中秒回；v3.1.1：目录不存在已由主进程清除记忆，此处 catch 双保险）
  try {
    const last = await window.cs?.scanLast()
    if (last?.root && !root.value && !scanning.value) {
      scanMsg.value = `正在恢复上次扫描（${last.root}）…`
      await scan(last.root, false)
      scanMsg.value = `已恢复上次扫描 · ${new Date(last.ts || 0).toLocaleString('zh-CN', { hour12: false })}`
      setTimeout(() => { if (scanMsg.value.startsWith('已恢复')) scanMsg.value = '' }, 6000)
    }
  } catch {
    // 目录 vanished 竞态：静默放弃恢复，不弹错（用户可手动选目录）
    scanMsg.value = ''
  }
  // 命令面板动作（G7）
  window.addEventListener('cs:scan-c', () => { if (root.value !== 'C:////') void scan('C:////', true) })
  window.addEventListener('cs:search', ((e: CustomEvent<string>) => { const el = document.querySelector('.search-input input') as HTMLInputElement | null; if (el) { el.value = e.detail; el.dispatchEvent(new Event('input')) } }) as EventListener)
  offProgress = window.cs?.onScanProgress?.((p) => {
    if (p.phase === 'start') { scanMsg.value = `正在扫描 ${p.msg || ''} …`; scanDone.value = 0; scanTotal.value = p.total || 0 }
    else if (p.phase === 'shard-done') { scanDone.value = p.done || 0; scanTotal.value = p.total || scanTotal.value }
  }) || null
})

onDeactivated(() => {
  // KeepAlive 切页：释放图表 DOM（扫描在主进程继续，状态 ref 保留）
  chart?.dispose()
  chart = null
})
onActivated(() => {
  // 切回：若有结果重绘
  if (result.value && currentView.value === 'sunburst') void nextTick(() => renderSunburst())
})
onBeforeUnmount(() => {
  offProgress?.()
  chart?.dispose()
})

/* ---------------- 扫描 ---------------- */
async function scan(path: string, force = false): Promise<void> {
  if (!path || scanning.value) return
  scanning.value = true
  scanError.value = ''
  scanMsg.value = '正在启动扫描…'
  try {
    const r = await window.cs!.scanStart(path, force)
    root.value = r.root
    stats.value = r.stats
    topFiles.value = r.topFiles
    cached.value = r.cached
    crumbs.value = []
    curNode.value = r.root
    drillChildren.value = []
    tab.value = 'sunburst'
    await nextTick()
    renderChart()
  } catch (e) {
    scanError.value = (e as Error).message
  } finally {
    scanning.value = false
    scanMsg.value = ''
  }
}

function scanDisk(d: DiskInfo): void { void scan(d.drive + '\\') }
function scanCustom(): void { void scan(customPath.value.trim()) }
function rescan(): void { if (root.value) void scan(root.value.path, true) }

/* ---------------- 旭日图 ---------------- */
let hoverLock = false
function renderChart(): void {
  const node = curNode.value
  if (!node) return
  if (!chart && chartEl) chart = echarts.init(chartEl)
  if (!chart) return
  const total = node.size || 1
  const minSize = Math.max(total * 0.0008, 1)
  const data = sunburstData(node, drillChildren.value, minSize)
  chart.setOption(
    {
      backgroundColor: 'transparent',
      series: [
        {
          type: 'sunburst',
          data,
          radius: [40, '96%'],
          center: ['50%', '50%'],
          nodeClick: false,
          // 鼠标悬停的扇形外扩放大（视觉半径 +5%），小扇形因此可读可点
          emphasis: {
            focus: 'ancestor',
            scale: true,
            scaleSize: 8
          },
          blur: { itemStyle: { opacity: 0.35 } },
          levels: [
            {},
            { r0: 40, r: 92, label: { rotate: 'tangential', fontSize: 12, color: '#F2F5FF', minAngle: 10 } },
            { r0: 92, r: 148, label: { fontSize: 11, color: 'rgba(242,245,255,0.78)', minAngle: 8 }, itemStyle: { borderWidth: 1.5, borderColor: 'rgba(7,11,28,0.6)' } },
            { r0: 148, r: 196, itemStyle: { borderWidth: 1.5, borderColor: 'rgba(7,11,28,0.6)' }, label: { position: 'outside', fontSize: 10.5, color: 'rgba(242,245,255,0.62)', silent: false } }
          ],
          itemStyle: { borderColor: 'rgba(7,11,28,0.55)', borderWidth: 1 },
          label: { minAngle: 8 }
        }
      ],
      color: SUN_PALETTE,
      tooltip: {
        backgroundColor: 'rgba(16,23,64,0.88)',
        borderColor: 'rgba(255,255,255,0.18)',
        borderWidth: 1,
        padding: [10, 14],
        textStyle: { color: '#F2F5FF', fontSize: 12 },
        extraCssText: 'backdrop-filter:blur(14px);border-radius:12px;',
        formatter: (p: { data: { path?: string; isFile?: boolean }; name: string; value: number }) =>
          `<b style="font-size:13px">${escapeHtml(p.name)}</b><br/>${formatBytes(p.value)}<br/><span style="opacity:0.55;font-size:11px">${escapeHtml(p.data.path || '')}</span>${p.data.isFile ? '' : '<br/><span style="opacity:0.45;font-size:11px">点击下钻</span>'}`
      }
    },
    true
  )
  chart.resize()
  chart.off('click')
  chart.off('mouseover')
  chart.off('mouseout')
  chart.on('mouseover', () => { hoverLock = true })
  chart.on('mouseout', () => { hoverLock = false })
  chart.on('click', (p: { data: { path?: string; name?: string; isFile?: boolean } }) => {
    if (p.data.isFile) return
    if (p.data.path) void drillTo(p.data.path, p.data.name || '')
  })
}

function sunburstData(n: DirNode, extraChildren: Array<{ path: string; name: string; size: number; isDir: boolean }>, minSize: number): Array<{ name: string; value?: number; children?: unknown[]; path?: string; isFile?: boolean }> {
  const kids: Array<Record<string, unknown>> = []
  let rest = 0
  // 本地树子项（瘦树目录层，单层展示；下钻由 drillTo 处理）
  for (const c of n.children) {
    if (c.size < minSize) { rest += c.size; continue }
    if ('children' in c) kids.push({ name: c.name, value: c.size, path: c.path })
    else kids.push({ name: c.name, value: c.size, path: c.path, isFile: true })
  }
  // 按需取的子项（本地瘦树被裁/缓存树无明细时）
  const known = new Set(kids.map((k) => String(k.path)))
  for (const c of extraChildren) {
    if (known.has(c.path)) continue
    if (c.size < minSize) { rest += c.size; continue }
    kids.push({ name: c.name, value: c.size, path: c.path, isFile: !c.isDir })
  }
  if (rest > 0) kids.push({ name: '· 较小项', value: rest, path: n.path })
  kids.sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
  if (kids.length > 48) {
    const kept = kids.slice(0, 47)
    const rv = kids.slice(47).reduce((s, k) => s + Number(k.value || 0), 0)
    kept.push({ name: '其他', value: rv, path: n.path, isAgg: true })
    return kept as never
  }
  return kids as never
}

/** 下钻：优先本地树，找不到（瘦树被裁）时按需取子节点 */
async function drillTo(path: string, name: string): Promise<void> {
  let local = root.value ? findNodeLocal(root.value, path) : null
  if (!local) {
    const r = await window.cs?.scanChildren(path)
    if (r && r.node) {
      local = { path: r.node.path, name: r.node.name, size: r.node.size, mtime: 0, fileCount: r.node.fileCount, dirCount: r.node.dirCount, children: [] }
    }
  }
  if (!local) return
  crumbs.value.push({ name: name || local.name, path })
  curNode.value = local
  drillChildren.value = (await window.cs?.scanChildren(path))?.children || []
  renderChart()
}

function findNodeLocal(from: DirNode, path: string): DirNode | null {
  const t = path.toLowerCase()
  const walk = (n: DirNode): DirNode | null => {
    if (n.path.toLowerCase() === t) return n
    for (const c of n.children) if ('children' in c) {
      const r = walk(c)
      if (r) return r
    }
    return null
  }
  return walk(from)
}

function up(): void {
  if (!crumbs.value.length) return
  crumbs.value.pop()
  const cur = crumbs.value.length ? crumbs.value[crumbs.value.length - 1] : { name: root.value?.name || '', path: root.value?.path || '' }
  void refreshDrill(cur.path)
}

async function refreshDrill(path: string): Promise<void> {
  const local = root.value ? findNodeLocal(root.value, path) : null
  if (local && local.children.length) {
    curNode.value = local
    drillChildren.value = []
  } else {
    const r = await window.cs?.scanChildren(path)
    if (r?.node) {
      curNode.value = { path: r.node.path, name: r.node.name, size: r.node.size, mtime: 0, fileCount: r.node.fileCount, dirCount: r.node.dirCount, children: [] }
      drillChildren.value = r.children
    }
  }
  renderChart()
}

function jump(i: number): void {
  if (i < 0) {
    crumbs.value = []
    curNode.value = root.value
    drillChildren.value = []
  } else {
    crumbs.value = crumbs.value.slice(0, i + 1)
    void refreshDrill(crumbs.value[i].path)
  }
  renderChart()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c)
}

/* ---------------- 排行与类型 ---------------- */
const topDirList = computed<Array<{ name: string; path: string; size: number; fileCount: number }>>(() => {
  if (!root.value) return []
  const arr: Array<{ name: string; path: string; size: number; fileCount: number }> = []
  const walk = (d: DirNode): void => {
    for (const c of d.children) if ('children' in c) { arr.push({ name: c.name, path: c.path, size: c.size, fileCount: c.fileCount }); walk(c) }
  }
  walk(root.value)
  return arr.sort((a, b) => b.size - a.size).slice(0, 20)
})

const typeList = computed(() => {
  if (!stats.value) return []
  const rows = Object.entries(stats.value.typeBytes).map(([k, v]) => ({ name: k, bytes: v, files: stats.value!.typeFiles[k] || 0 }))
  return rows.sort((a, b) => b.bytes - a.bytes)
})

const maxTypeBytes = computed(() => Math.max(1, ...typeList.value.map((t) => t.bytes)))

/* ---------------- 待处理清单 ---------------- */
async function addPending(path: string, isDir: boolean): Promise<void> {
  pending.value = (await window.cs?.pendingAdd(path, isDir)) || []
}
async function removePending(path: string): Promise<void> {
  pending.value = (await window.cs?.pendingRemove(path)) || []
}
async function clearPending(): Promise<void> {
  pending.value = (await window.cs?.pendingClear()) || []
}
function locate(path: string): void { void window.cs?.showItem(path) }

function cancelScan(): void { void window.cs?.scanCancelAll() }

/* ---------------- 白名单判定（批量） ---------------- */
const protectedSet = ref<Set<string>>(new Set())
async function refreshProtection(paths: string[]): Promise<void> {
  if (!paths.length) return
  const flags = (await window.cs?.whitelistCheck(paths)) || []
  const s = new Set<string>()
  paths.forEach((p, i) => { if (flags[i]) s.add(p) })
  protectedSet.value = s
}

async function addTopFilePending(f: FileEntry): Promise<void> {
  await addPending(f.path, false)
  await refreshProtection([f.path])
}

const fileTime = (t: number): string => (t ? new Date(t).toLocaleDateString('zh-CN') : '--')

/* 模板引用 */
const setChartEl = (el: unknown): void => { chartEl = (el as HTMLElement) || null }
</script>

<template>
  <div class="insight">
    <!-- 磁盘选择卡 -->
    <section class="glass pick">
      <div class="pick-title">选择要分析的位置</div>
      <div class="disk-row">
        <div
          v-for="d in disks" :key="d.drive"
          class="disk glass-inner"
          :class="{ busy: scanning }"
          @click="!scanning && scanDisk(d)"
        >
          <div class="disk-drive">{{ d.drive }}</div>
          <div class="disk-info">
            <div class="disk-label">{{ d.label }}</div>
            <div class="disk-usage">
              <div class="bar"><div class="used" :style="{ width: (100 - (d.freeBytes / Math.max(d.totalBytes, 1)) * 100).toFixed(1) + '%' }"></div></div>
              <div class="disk-nums">剩余 {{ formatBytes(d.freeBytes) }} / {{ formatBytes(d.totalBytes) }}</div>
            </div>
          </div>
        </div>
        <div v-if="!disks.length && !scanning" class="disk-empty">磁盘信息读取失败（不影响自定义路径扫描）</div>
      </div>
      <div class="custom-row">
        <input v-model="customPath" placeholder="自定义目录路径，如 D:\Downloads" spellcheck="false" @keyup.enter="scanCustom" />
          <button class="cs-btn sm" @click="pickCustomPath">📁 浏览…</button>
        <button class="cs-btn primary" :disabled="scanning || !customPath.trim()" @click="scanCustom">开始扫描</button>
      </div>
    </section>

    <!-- 进度 / 错误 -->
    <section v-if="scanning || scanError" class="glass prog" :class="{ err: !!scanError }">
      <template v-if="scanning">
        <span class="spinner"></span>
        <span class="prog-text">{{ scanMsg || '扫描进行中…' }}</span>
        <span v-if="scanTotal > 0" class="prog-frac">{{ scanDone }} / {{ scanTotal }} 个目录分片</span>
        <button class="cs-btn ghost" @click="cancelScan">取消</button>
      </template>
      <template v-else>
        ⚠️ {{ scanError }}
        <button v-if="root" class="cs-btn" @click="rescan">重试（强制重扫）</button>
      </template>
    </section>

    <!-- 磁盘对比（v3.5：独立可用，不依赖当前扫描） -->
    <section v-if="tab === 'compare'" class="glass table-card">
      <div class="tbl-head" style="grid-template-columns: 180px 1fr 90px 90px 110px">
        <span>磁盘/目录</span><span>占用对比</span><span>文件</span><span>目录</span><span>TOP 类型</span>
      </div>
      <div class="tbl-body">
        <div v-for="r in cmpRoots" :key="r.root" class="cmp-row" :title="'点击切换扫描：' + r.root" @click="scan(r.root, false)">
          <span class="cmp-name">{{ r.root }}</span>
          <span class="cmp-bar-wrap"><span class="cmp-bar" :style="{ width: (r.totalBytes / cmpMax * 100).toFixed(1) + '%' }"></span><span class="cmp-val">{{ formatBytes(r.totalBytes) }}</span></span>
          <span class="cmp-num">{{ r.fileCount.toLocaleString() }}</span>
          <span class="cmp-num">{{ r.dirCount.toLocaleString() }}</span>
          <span class="cmp-types">
            <span v-for="t in r.topTypes.slice(0, 3)" :key="t.type" class="cmp-chip">{{ t.type }} {{ formatBytes(t.bytes) }}</span>
          </span>
        </div>
        <div v-if="!cmpBusy && !cmpRoots.length" class="tbl-empty">还没有扫描数据——先扫描任意磁盘（对比视图跨扫描保留）</div>
      </div>
    </section>

    <!-- 磁盘对比入口（v3.5：独立于扫描状态，任何时候可看多盘） -->
    <button class="tab cmp-entry" :class="{ active: tab === 'compare' }" @click="tab = 'compare'; loadCompare()">💾 磁盘对比</button>

    <!-- 结果区 -->
    <template v-if="tab !== 'compare' && root && stats">
      <section class="glass summary">
        <div class="s-item"><div class="s-num">{{ formatBytes(stats.totalBytes) }}</div><div class="s-label">总占用</div></div>
        <div class="s-item"><div class="s-num">{{ stats.totalFiles.toLocaleString() }}</div><div class="s-label">文件</div></div>
        <div class="s-item"><div class="s-num">{{ stats.totalDirs.toLocaleString() }}</div><div class="s-label">文件夹</div></div>
        <div class="s-item"><div class="s-num" :class="stats.errors ? 'warn' : ''">{{ stats.errors }}</div><div class="s-label">不可访问</div></div>
        <div class="s-item"><div class="s-num">{{ cached ? '缓存' : (stats.durationMs / 1000).toFixed(1) + 's' }}</div><div class="s-label">{{ cached ? '秒级加载' : '扫描耗时' }}</div></div>
        <div class="s-actions">
          <button class="cs-btn" :disabled="scanning" @click="rescan">强制重扫</button>
          <button class="cs-btn" @click="drawerOpen = true">待处理清单（{{ pending.length }}）</button>
        </div>
      </section>

      <div class="tabs" v-if="root">
        <button v-for="t in (['sunburst','topfiles','topdirs','types','compare'] as const)" :key="t" class="tab" :class="{ active: tab === t }" @click="tab = t">
          {{ { sunburst: tr('tSunburst'), topfiles: tr('tTop50'), topdirs: tr('tTopDirs'), types: tr('tTypes'), compare: tr('tCompare') }[t] }}
        </button>
        <button class="tab" :class="{ active: tab === 'timeMachine' }" @click="tab = 'timeMachine'">⏳ 时光机</button>
      </div>

      <!-- 旭日图 -->
      <section v-show="tab === 'sunburst'" class="glass chart-card">
        <div class="crumbs">
          <button class="crumb" @click="jump(-1)">{{ root.name }}</button>
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span class="crumb-sep">›</span>
            <button class="crumb" @click="jump(i)">{{ c.name }}</button>
          </template>
          <button v-if="crumbs.length" class="crumb up" @click="up">⤴ 上级</button>
        </div>
        <div :ref="setChartEl" class="chart-host"></div>
        <div class="chart-tip">点击目录扇区可下钻；外圈为文件。颜色仅作区分，大小 = 空间占用</div>
      </section>

      <!-- TOP 文件 -->
      <section v-show="tab === 'topfiles'" class="glass table-card">
        <div class="tbl-head">
          <span class="c-rank">#</span><span class="c-name">文件</span><span class="c-size">大小</span><span class="c-time">修改时间</span><span class="c-ops"></span>
        </div>
        <div class="tbl-body">
          <template v-for="(f, i) in topFiles" :key="f.path">
            <div class="tbl-row">
              <span class="c-rank">{{ i + 1 }}</span>
              <span class="c-name" :title="f.path">{{ f.path }}</span>
              <span class="c-size">{{ formatBytes(f.size) }}</span>
              <span class="c-time">{{ fileTime(f.mtime) }}</span>
              <span class="c-ops">
                <button class="op check" :class="advMap[f.path]?.advice" :disabled="advBusy" :title="advMap[f.path] ? advMap[f.path].what : '体检：这是什么？能不能删？'" @click="checkFile({ path: f.path, name: f.path.split(/[\\/]/).pop() || f.path, size: f.size })">{{ badgeOf(advMap[f.path]) }} 体检</button>
                <button class="op" @click="locate(f.path)">定位</button>
                <button class="op add" @click="addTopFilePending(f)">加入清单</button>
              </span>
            </div>
            <div v-if="advOpen === f.path && advMap[f.path]" class="advice-card" :class="advMap[f.path].advice">
              <div class="ad-head">
                <b>{{ badgeOf(advMap[f.path]) }} {{ advMap[f.path].what }}</b>
                <span class="ad-tag">{{ { safe: '可以删', caution: '谨慎', danger: '别动', unknown: '未知' }[advMap[f.path].advice] }}</span>
              </div>
              <p class="ad-why">{{ advMap[f.path].why }}</p>
              <p v-if="!selectable(advMap[f.path])" class="ad-note">该项不可加入待处理（安全限制）</p>
              <div v-else class="ad-ops">
                <button class="op add" @click="addTopFilePending(f)">仍要加入清单（三级确认兜底）</button>
              </div>
            </div>
          </template>
          <div v-if="cached && !topFiles.length" class="tbl-empty">缓存结果不含文件明细，请「强制重扫」获取 TOP 50</div>
          <div v-else-if="!topFiles.length" class="tbl-empty">没有文件</div>
        </div>
      </section>

      <!-- TOP 文件夹 -->
      <section v-show="tab === 'topdirs'" class="glass table-card">
        <div class="tbl-head">
          <span class="c-rank">#</span><span class="c-name">文件夹</span><span class="c-size">大小</span><span class="c-time">文件数</span><span class="c-ops"></span>
        </div>
        <div class="tbl-body">
          <div v-for="(d, i) in topDirList" :key="d.path" class="tbl-row">
            <span class="c-rank">{{ i + 1 }}</span>
            <span class="c-name" :title="d.path">{{ d.path }}</span>
            <span class="c-size">{{ formatBytes(d.size) }}</span>
            <span class="c-time">{{ d.fileCount.toLocaleString() }}</span>
            <span class="c-ops">
              <button class="op" @click="locate(d.path)">定位</button>
              <button class="op add" @click="addPending(d.path, true)">加入清单</button>
            </span>
          </div>
        </div>
      </section>

      <!-- 类型分布 -->
      <section v-show="tab === 'types'" class="glass types-card">
        <div v-for="t in typeList" :key="t.name" class="type-row clickable" title="点击在媒体页查看该类型全部文件" @click="$emit('navigate', 'media:' + t.name)">
          <span class="t-dot" :style="{ background: TYPE_COLORS[t.name] || '#8B93B8' }"></span>
          <span class="t-name">{{ t.name }}</span>
          <div class="t-bar"><div class="t-fill" :style="{ width: (t.bytes / maxTypeBytes * 100).toFixed(1) + '%', background: TYPE_COLORS[t.name] || '#8B93B8' }"></div></div>
          <span class="t-num">{{ formatBytes(t.bytes) }}</span>
          <span class="t-files">{{ t.files.toLocaleString() }} 个</span>
        </div>
      </section>

      <!-- 时光机（v2.1 F3） -->
      <section v-show="tab === 'timeMachine'" class="glass tm-card">
        <div class="tm-head">
          <h3>⏳ 时光机 · 磁盘快照对比</h3>
          <div>
            <button class="cs-btn primary sm" :disabled="snapBusy" @click="takeSnap">{{ snapBusy ? '拍摄中…' : '📷 拍快照' }}</button>
          </div>
        </div>
        <p v-if="snapMsg" class="tm-msg">{{ snapMsg }}</p>
        <p class="tm-tip">每次扫描完成会自动保存快照（每目录保留最近 30 份）。选两份对比，看「空间被谁吃了 / 清理战果」。</p>

        <div v-if="snaps.length < 2" class="tm-empty">
          快照不足两份——先扫描一次目录（自动存快照），或点「拍快照」。
        </div>
        <template v-else>
          <div class="tm-select">
            <label>对比：早</label>
            <select v-model="selA"><option v-for="s in snaps" :key="s.id" :value="s.id">{{ fmtTs(s.ts) }} · {{ s.root }} · {{ formatBytes(s.totalBytes) }}</option></select>
            <label>→ 晚</label>
            <select v-model="selB"><option v-for="s in snaps" :key="s.id" :value="s.id">{{ fmtTs(s.ts) }} · {{ s.root }} · {{ formatBytes(s.totalBytes) }}</option></select>
            <button class="cs-btn sm" :disabled="selA === null || selB === null || selA === selB" @click="runDiff">对比</button>
          </div>

          <template v-if="diffResult">
            <h4 class="tm-sec ok">📈 增长 TOP（空间被谁吃了）</h4>
            <div v-for="e in diffResult.grow" :key="'g' + e.path" class="tm-row grow">
              <span class="tm-path" :title="e.path">{{ e.path }}</span>
              <span class="tm-delta">+{{ formatBytes(e.delta) }}</span>
              <span class="tm-sizes">{{ formatBytes(e.fromSize) }} → {{ formatBytes(e.toSize) }}</span>
            </div>
            <p v-if="!diffResult.grow.length" class="tm-none">无增长</p>

            <h4 class="tm-sec ok2">📉 减少 TOP（清理战果）</h4>
            <div v-for="e in diffResult.shrink" :key="'s' + e.path" class="tm-row shrink">
              <span class="tm-path" :title="e.path">{{ e.path }}</span>
              <span class="tm-delta">-{{ formatBytes(e.delta) }}</span>
              <span class="tm-sizes">{{ formatBytes(e.fromSize) }} → {{ formatBytes(e.toSize) }}</span>
            </div>
            <p v-if="!diffResult.shrink.length" class="tm-none">无减少</p>

            <div v-if="diffResult.newDirs.length" class="tm-sub">
              <h4>🆕 新增目录（{{ diffResult.newDirs.length }}）</h4>
              <div v-for="e in diffResult.newDirs.slice(0, 10)" :key="'n' + e.path" class="tm-row">
                <span class="tm-path">{{ e.path }}</span><span class="tm-delta">{{ formatBytes(e.delta) }}</span>
              </div>
            </div>
            <div v-if="diffResult.goneDirs.length" class="tm-sub">
              <h4>💨 消失目录（{{ diffResult.goneDirs.length }}）</h4>
              <div v-for="e in diffResult.goneDirs.slice(0, 10)" :key="'d' + e.path" class="tm-row">
                <span class="tm-path">{{ e.path }}</span><span class="tm-delta">{{ formatBytes(e.delta) }}</span>
              </div>
            </div>
          </template>
        </template>

        <div class="tm-list">
          <h4>全部快照（{{ snaps.length }}）</h4>
          <div v-for="s in snaps.slice(0, 10)" :key="s.id" class="tm-snap">
            <span>{{ fmtTs(s.ts) }}</span>
            <span class="tm-snap-root">{{ s.root }}</span>
            <span>{{ formatBytes(s.totalBytes) }} · {{ s.fileCount.toLocaleString() }} 文件 / {{ s.dirCount.toLocaleString() }} 目录</span>
            <button class="op del" @click="delSnap(s.id)">删除</button>
          </div>
        </div>
      </section>
    </template>

    <!-- 待处理清单抽屉 -->
    <Teleport to="body">
      <div v-if="drawerOpen" class="mask" @click.self="drawerOpen = false">
        <div class="glass drawer">
          <div class="d-head">
            <h3>待处理清单（{{ pending.length }}）</h3>
            <button class="op" @click="drawerOpen = false">关闭</button>
          </div>
          <p class="d-tip">清单跨模块暂存：清扫 / 整理时可统一消费。白名单内路径仅允许定位。</p>
          <div class="d-body">
            <div v-for="it in pending" :key="it.path" class="d-item">
              <span class="d-ico">{{ it.isDir ? '📁' : '📄' }}</span>
              <span class="d-path" :title="it.path">{{ it.path }}</span>
              <button class="op" @click="locate(it.path)">定位</button>
              <button class="op del" @click="removePending(it.path)">移除</button>
            </div>
            <div v-if="!pending.length" class="tbl-empty">清单为空</div>
          </div>
          <div class="d-foot">
            <button class="cs-btn danger" :disabled="!pending.length" @click="clearPending">清空</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.insight { display: flex; flex-direction: column; gap: 16px; padding-bottom: 12px; }

/* 选择卡 */
.pick { padding: 22px 26px; }
.pick-title { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
.disk-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.disk { display: flex; gap: 14px; align-items: center; padding: 14px 18px; cursor: pointer; min-width: 250px; transition: transform .15s ease, background .15s ease; }
.disk:hover { transform: translateY(-2px); background: rgba(255,255,255,0.10); }
.disk.busy { pointer-events: none; opacity: .6; }
.disk-drive { font-size: 22px; font-weight: 800; color: #6EA8FF; }
.disk-label { font-size: 13px; margin-bottom: 6px; }
.bar { height: 6px; border-radius: 4px; background: rgba(255,255,255,0.10); overflow: hidden; width: 160px; }
.used { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #6EA8FF, #B39DFF); }
.disk-nums { font-size: 11px; color: var(--text-3); margin-top: 5px; }
.disk-empty { color: var(--text-3); font-size: 13px; padding: 10px; }
.custom-row { display: flex; gap: 10px; }
.custom-row input {
  flex: 1; padding: 10px 16px; border-radius: 18px;
  border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06);
  color: var(--text-1); font-size: 13px; outline: none;
}
.custom-row input:focus { border-color: rgba(110,168,255,0.6); }

/* 进度 */
.prog { padding: 14px 22px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text-2); }
.prog-frac { color: #6EA8FF; font-variant-numeric: tabular-nums; }
.prog.err { color: #FFB86C; }
.spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.2); border-top-color: #6EA8FF; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.ghost { padding: 6px 14px; font-size: 12px; }

/* 汇总 */
.summary { display: flex; align-items: center; gap: 8px; padding: 18px 26px; flex-wrap: wrap; }
.s-item { min-width: 110px; text-align: center; }
.s-num { font-size: 19px; font-weight: 700; }
.s-num.warn { color: #FFB86C; }
.s-label { font-size: 11px; color: var(--text-3); margin-top: 3px; }
.s-actions { margin-left: auto; display: flex; gap: 10px; }

/* tabs */
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tab { padding: 8px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; transition: all .15s; }
.tab:hover { color: var(--text-1); }
.tab.active { color: #0A1128; font-weight: 700; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }

/* 图表 */
.chart-card { padding: 18px 22px 14px; }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.crumb { padding: 5px 12px; border-radius: 999px; font-size: 12px; color: var(--text-2); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb:hover { color: var(--text-1); }
.crumb-sep { color: var(--text-3); }
.crumb.up { margin-left: auto; color: #6EA8FF; }
.chart-host { width: 100%; height: 620px; }

/* 大文件体检（v3.0 G3） */
.cmp-row { display: grid; grid-template-columns: 180px 1fr 90px 90px 110px; gap: 10px; align-items: center; padding: 10px 14px; border-radius: 10px; cursor: pointer; font-size: 12.5px; }
.cmp-row:hover { background: rgba(255,255,255,0.05); }
.cmp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.cmp-bar-wrap { display: flex; align-items: center; gap: 10px; }
.cmp-bar { height: 14px; border-radius: 7px; background: linear-gradient(90deg, #6EA8FF, #9DB8FF); min-width: 4px; transition: width .4s; }
.cmp-val { color: #A8C7FF; font-variant-numeric: tabular-nums; font-size: 12px; }
.cmp-num { color: var(--text-3); text-align: right; font-variant-numeric: tabular-nums; }
.cmp-types { display: flex; flex-direction: column; gap: 2px; }
.cmp-chip { font-size: 10.5px; color: var(--text-3); background: rgba(255,255,255,0.05); border-radius: 6px; padding: 1px 8px; }
.advice-card { margin: 4px 8px 10px; padding: 14px 18px; border-radius: 14px; background: rgba(255,255,255,0.05); border-left: 3px solid var(--adv, #6EA8FF); }
.advice-card.safe { --adv: #37D399; }
.advice-card.caution { --adv: #FFB86C; }
.advice-card.danger { --adv: #FF5D6C; }
.advice-card.unknown { --adv: #9AA5C4; }
.ad-head { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.ad-tag { font-size: 11px; padding: 2px 10px; border-radius: 999px; background: rgba(255,255,255,0.08); color: var(--text-2); }
.ad-why { margin: 8px 0 4px; font-size: 12.5px; color: var(--text-2); line-height: 1.7; }
.ad-note { font-size: 11px; color: #FF5D6C; }
.ad-ops { margin-top: 8px; }
.op.check.safe { color: #37D399; } .op.check.caution { color: #FFB86C; } .op.check.danger { color: #FF5D6C; } .op.check.unknown { color: #9AA5C4; }

/* 全局搜索（v2.2） */
.search-card { padding: 16px 22px; }
.sq-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.sq-in { flex: 1; min-width: 260px; padding: 9px 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 13px; outline: none; }
.sq-in:focus { border-color: rgba(110,168,255,0.6); }
.sq-chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-2); }
.sq-num { width: 60px; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 12.5px; text-align: right; }
.sq-tip { font-size: 11px; color: var(--text-3); margin-top: 8px; }
.sq-count { font-size: 12.5px; color: var(--text-2); margin-top: 10px; }
.sq-list { max-height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.sq-row-item { display: grid; grid-template-columns: minmax(120px, 1.2fr) 56px 80px minmax(160px, 2fr) 56px 64px; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.04); font-size: 12px; }
.sq-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sq-type { font-size: 10.5px; color: var(--text-3); }
.sq-size { color: #A8C7FF; text-align: right; font-variant-numeric: tabular-nums; }
.sq-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; color: var(--text-3); }
.op { padding: 4px 10px; border-radius: 8px; font-size: 11px; color: var(--text-2); background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }

/* 时光机（v2.1） */
.tm-card { padding: 20px 24px; }
.tm-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.tm-msg { font-size: 12.5px; color: #A8C7FF; }
.tm-tip { font-size: 11.5px; color: var(--text-3); margin-bottom: 14px; }
.tm-empty { padding: 30px; text-align: center; color: var(--text-3); font-size: 13px; }
.tm-select { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.tm-select label { font-size: 12.5px; color: var(--text-2); }
.tm-select select { flex: 1; min-width: 240px; padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); color: var(--text-1); font-size: 12.5px; outline: none; }
.tm-sec { font-size: 13.5px; margin: 14px 0 8px; }
.tm-sec.ok { color: #FF5D6C; }
.tm-sec.ok2 { color: #37D399; }
.tm-row { display: grid; grid-template-columns: 1fr 110px 190px; gap: 10px; padding: 7px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); margin-bottom: 5px; font-size: 12px; align-items: center; }
.tm-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.tm-delta { font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.tm-row.grow .tm-delta { color: #FF5D6C; }
.tm-row.shrink .tm-delta { color: #37D399; }
.tm-sizes { color: var(--text-3); text-align: right; font-variant-numeric: tabular-nums; }
.tm-none { color: var(--text-3); font-size: 12px; padding: 6px 12px; }
.tm-sub h4 { font-size: 12.5px; margin: 12px 0 6px; color: var(--text-2); }
.tm-list { margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; }
.tm-list h4 { font-size: 12.5px; margin-bottom: 8px; color: var(--text-2); }
.tm-snap { display: grid; grid-template-columns: 150px 1fr auto auto; gap: 10px; padding: 7px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); margin-bottom: 5px; font-size: 12px; align-items: center; }
.tm-snap-root { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.op.del { padding: 4px 12px; border-radius: 8px; font-size: 11.5px; color: #FF5D6C; background: rgba(255,93,108,0.1); border: 1px solid rgba(255,93,108,0.3); cursor: pointer; }
.chart-tip { text-align: center; font-size: 11px; color: var(--text-3); margin-top: 6px; }

/* 表格 */
.table-card { padding: 12px 20px 16px; }
.tbl-head, .tbl-row { display: grid; grid-template-columns: 44px minmax(0,1fr) 110px 100px 190px; gap: 10px; align-items: center; }
.tbl-head { padding: 10px 12px; font-size: 11px; color: var(--text-3); border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; }
.tbl-body { max-height: 520px; overflow-y: auto; }
.tbl-row { padding: 10px 12px; border-radius: 12px; font-size: 13px; min-height: 40px; }
.tbl-row:hover { background: rgba(255,255,255,0.05); }
.c-rank { color: var(--text-3); }
.c-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.c-size { color: #A8C7FF; font-variant-numeric: tabular-nums; }
.c-time { color: var(--text-3); font-size: 12px; }
.c-ops { display: flex; gap: 8px; justify-content: flex-end; }
.op { padding: 5px 12px; border-radius: 10px; font-size: 12px; color: var(--text-2); background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.op:hover { color: var(--text-1); background: rgba(255,255,255,0.12); }
.op.add { color: #6EA8FF; }
.op.del { color: #FF5D6C; }
.tbl-empty { padding: 30px; text-align: center; color: var(--text-3); font-size: 13px; }

/* 类型 */
.types-card { padding: 20px 26px; display: flex; flex-direction: column; gap: 12px; }
.type-row { display: grid; grid-template-columns: 14px 70px minmax(100px, 1fr) 110px 90px; gap: 12px; align-items: center; }
.t-dot { width: 10px; height: 10px; border-radius: 3px; }
.t-name { font-size: 13px; }
.type-row.clickable { cursor: pointer; }
.type-row.clickable:hover { background: rgba(255,255,255,0.06); border-radius: 10px; }
.t-bar { height: 14px; border-radius: 8px; background: rgba(255,255,255,0.06); overflow: hidden; }
.t-fill { height: 100%; border-radius: 8px; opacity: .85; }
.t-num { font-size: 13px; color: #A8C7FF; text-align: right; font-variant-numeric: tabular-nums; }
.t-files { font-size: 11px; color: var(--text-3); text-align: right; }

/* 抽屉 */
.mask { position: fixed; inset: 0; background: rgba(4,7,20,0.55); backdrop-filter: blur(6px); display: flex; justify-content: flex-end; z-index: 50; }
.drawer { width: 460px; max-width: 90vw; height: 100%; border-radius: 26px 0 0 26px; display: flex; flex-direction: column; padding: 24px; }
.d-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.d-head h3 { font-size: 16px; }
.d-tip { font-size: 12px; color: var(--text-2); margin-bottom: 14px; line-height: 1.6; }
.d-body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.d-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 14px; background: rgba(255,255,255,0.05); font-size: 12.5px; }
.d-ico { flex-shrink: 0; }
.d-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.d-foot { display: flex; justify-content: flex-end; margin-top: 14px; }
.cs-btn.danger { border-color: rgba(255,93,108,0.5); color: #FF5D6C; }
</style>
