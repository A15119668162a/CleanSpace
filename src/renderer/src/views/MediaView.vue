<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { tr, purify } from '../i18n'
import { formatBytes } from '@shared/format'

interface Hit { path: string; name: string; size: number; mtime: number; type: string }
interface Group { dir: string; count: number; bytes: number }
interface VideoMeta { thumb?: string; durationSec?: number; width?: number; height?: number }

const props = defineProps<{ initialType?: string }>()

const mediaTab = ref<'image' | 'video'>('image')
const sub = ref<'collect' | 'grid' | 'timeline' | 'geo'>('collect')
const groups = ref<Group[]>([])
/* v3.1.1：盘根过滤（chips 常驻跨盘入口） */
const roots = ref<string[]>([])
const rootFilter = ref('')
async function loadRoots(): Promise<void> {
  const st = await window.cs?.searchStats()
  roots.value = st?.roots || []
}
function setRootFilter(r: string): void {
  rootFilter.value = r
  if (sub.value === 'grid') void loadGrid()
}
watch(rootFilter, () => { if (sub.value === 'collect') void loadCollect() })
const hits = ref<Hit[]>([])
const thumbs = ref<Record<string, string>>({})
const vmetas = ref<Record<string, VideoMeta>>({})
const loading = ref(false)
const msg = ref('')
const currentDir = ref('')
const stats = ref<{ files: number; roots: string[]; indexedAt: number | null } | null>(null)

/* 类型筛选（多选）+ 排序 + 视图 */
const ALL_TYPES = ['图片', '视频', '音频', '文档', '压缩包', '安装包', '代码', '其他']
const typeFilter = ref<Set<string>>(new Set())
const sortKey = ref<'size' | 'name' | 'mtime' | 'type'>('size')
const sortAsc = ref(false)
const viewMode = ref<'grid' | 'list'>('grid')

/* 灯箱 */
const lightbox = ref<{ hit: Hit; scale: number } | null>(null)
const lbIndex = ref(0)
const lbList = ref<Hit[]>([])

/* 视频点播 */
const player = ref<{ hit: Hit; pos: number } | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const pRate = ref(1)
const askResume = ref<number | null>(null)

/* 相册时间线（v3.0 G1） */
interface TlHit extends Hit { t: number; approx: boolean }
const tlGroups = ref<Array<{ year: number; months: Array<{ month: number; hits: TlHit[] }> }>>([])
const tlBusy = ref(false)
const tlTotal = ref(0)
const tlSpan = ref('')
const todayHits = ref<TlHit[] | null>(null)
const tlFilter = ref<TlHit[] | null>(null)

async function loadTimeline(): Promise<void> {
  sub.value = 'timeline'
  if (tlGroups.value.length || tlBusy.value) return
  tlBusy.value = true
  try {
    const r = await window.cs?.searchQuery({ types: ['图片'], limit: 2000 })
    const hits = r || []
    // 批量 EXIF（渐进：先文件时间占位再刷新——这里一次拿，2000 张 Worker 内秒级）
    const t = await window.cs?.exifTimes(hits.map((h) => ({ path: h.path, mtime: h.mtime })))
    const enriched: TlHit[] = hits.map((h) => {
      const e = t?.[h.path]
      const tsv = e?.ts ?? h.mtime
      return { ...h, t: tsv, approx: e?.ts == null }
    })
    buildTimeline(enriched)
  } finally {
    tlBusy.value = false
  }
}

function buildTimeline(all: TlHit[]): void {
  const by = new Map<string, TlHit[]>()
  for (const h of all) {
    const d = new Date(h.t)
    if (Number.isNaN(d.getTime())) continue
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const arr = by.get(k) || []
    arr.push(h)
    by.set(k, arr)
  }
  const keys = [...by.keys()].sort((a, b) => b.localeCompare(a))
  const years: Array<{ year: number; months: Array<{ month: number; hits: TlHit[] }> }> = []
  for (const k of keys) {
    const [y, m] = k.split('-').map(Number)
    let Y = years.find((x) => x.year === y)
    if (!Y) { Y = { year: y, months: [] }; years.push(Y) }
    const hits = by.get(k)!.sort((a, b) => b.t - a.t)
    Y.months.push({ month: m, hits })
  }
  tlGroups.value = years
  tlTotal.value = all.length
  tlSpan.value = keys.length ? `${keys[keys.length - 1]} ~ ${keys[0]}` : ''
  computeToday(all)
  applyTlFilter()
}

function computeToday(all: TlHit[]): void {
  const now = new Date()
  const hits = all.filter((h) => {
    const d = new Date(h.t)
    return d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() !== now.getFullYear()
  })
  todayHits.value = hits.length ? hits : null
}

function applyTlFilter(): void {
  tlFilter.value = null // 全量视图（预留）
}

function jumpToYear(y: number): void {
  document.getElementById(`tl-${y}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* EXIF 地点相册（v3.6——红线 20 只读；纯坐标聚类，不做地图渲染规避合规风险） */
interface GeoCluster { lat: number; lon: number; items: string[] }
const geoClusters = ref<GeoCluster[]>([])
const geoBusy = ref(false)
const geoMsg = ref('')
const geoOpen = ref<GeoCluster | null>(null)

async function loadGeo(): Promise<void> {
  sub.value = 'geo'
  if (geoClusters.value.length || geoBusy.value) return
  geoBusy.value = true
  try {
    const r = await window.cs?.searchQuery({ types: TYPES_FOR('image'), limit: 2000 })
    const hits = r || []
    const g = await window.cs?.exifGps(hits.map((h) => ({ path: h.path, mtime: h.mtime })))
    geoClusters.value = g?.clusters || []
    geoMsg.value = geoClusters.value.length
      ? `${(g?.points.length) || 0} 张含定位 · 聚成 ${geoClusters.value.length} 个地点`
      : '暂无含 GPS 定位的照片（手机拍摄通常会带）'
  } finally { geoBusy.value = false }
}

/* 媒体标签（v3.6） */
const tagChips = ref<Array<{ tag: string; count: number }>>([])
const tagFilter = ref('')
const lightboxTags = ref<string[]>([])
const tagInput = ref('')

async function loadTags(): Promise<void> {
  tagChips.value = (await window.cs?.tagStats()) || []
}
async function addTag(): Promise<void> {
  const t = tagInput.value.trim()
  const lb = lightbox.value?.hit
  if (!t || !lb) return
  await window.cs?.tagAdd(lb.path, t)
  tagInput.value = ''
  lightboxTags.value = (await window.cs?.tagsOf(lb.path)) || []
  await loadTags()
}
async function removeTag(t: string): Promise<void> {
  const lb = lightbox.value?.hit
  if (!lb) return
  await window.cs?.tagRemove(lb.path, t)
  lightboxTags.value = (await window.cs?.tagsOf(lb.path)) || []
  await loadTags()
}
async function openLightboxTags(): Promise<void> {
  const lb = lightbox.value?.hit
  if (lb) lightboxTags.value = (await window.cs?.tagsOf(lb.path)) || []
}
function setTagFilter(t: string): void {
  tagFilter.value = tagFilter.value === t ? '' : t
  void applyTagFilter()
}
async function applyTagFilter(): Promise<void> {
  if (!tagFilter.value) { await loadGrid(); return }
  const paths = new Set(await window.cs?.tagBy(tagFilter.value) || [])
  const all = (await window.cs?.searchQuery(purify({ types: typeFilter.value.size ? [...typeFilter.value] : TYPES_FOR(mediaTab.value), limit: 2000 }))) || []
  hits.value = all.filter((h) => paths.has(h.path))
}

/* 右键菜单 */
const ctxMenu = ref<{ x: number; y: number; hit: Hit } | null>(null)

const TYPES_FOR = (t: 'image' | 'video'): string[] => (t === 'image' ? ['图片'] : ['视频'])
const fmtT = (t: number): string => (t ? new Date(t).toLocaleDateString('zh-CN') : '--')
const fmtDur = (s?: number): string => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '--')

const sortedHits = computed(() => {
  const arr = [...hits.value]
  const dir = sortAsc.value ? 1 : -1
  arr.sort((a, b) => {
    let r = 0
    if (sortKey.value === 'size') r = a.size - b.size
    else if (sortKey.value === 'name') r = a.name.localeCompare(b.name, 'zh')
    else if (sortKey.value === 'mtime') r = a.mtime - b.mtime
    else r = a.type.localeCompare(b.type, 'zh')
    return r * dir
  })
  return arr
})

async function loadCollect(): Promise<void> {
  loading.value = true
  msg.value = ''
  try {
    stats.value = (await window.cs?.searchStats()) || null
    if (!stats.value || stats.value.files === 0) {
      msg.value = '索引为空——先去「透视」扫描磁盘（扫描完成自动建索引）'
      groups.value = []
      return
    }
    const types = typeFilter.value.size ? [...typeFilter.value] : TYPES_FOR(mediaTab.value)
    const r = await window.cs?.searchMedia(types, true, rootFilter.value || undefined)
    groups.value = r?.groups || []
  } catch (e) {
    msg.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function openDir(dir: string): Promise<void> {
  currentDir.value = dir
  sub.value = 'grid'
  await loadGrid()
}

/** 展示全部（v3.1.1：清目录过滤，看全盘索引的该类型全部） */
async function showAll(): Promise<void> {
  currentDir.value = ''
  sub.value = 'grid'
  await loadGrid()
}

async function loadGrid(): Promise<void> {
  loading.value = true
  try {
    const types = typeFilter.value.size ? [...typeFilter.value] : TYPES_FOR(mediaTab.value)
    const r = await window.cs?.searchQuery({ types, limit: 2000 })
    const all = r || []
    const dir = currentDir.value
    const rf = rootFilter.value
    hits.value = all.filter((h) => {
      if (dir && h.path.slice(0, h.path.lastIndexOf('\\')) !== dir && h.path.slice(0, h.path.lastIndexOf('/')) !== dir) return false
      if (rf && !h.path.toLowerCase().startsWith(rf.toLowerCase())) return false
      return true
    })
    // 缩略图/元数据（图片 vs 视频两路）
    const sample = hits.value.slice(0, 120).map((h) => ({ path: h.path, mtime: h.mtime }))
    if (mediaTab.value === 'image') {
      thumbs.value = (await window.cs?.mediaThumbs(sample)) || {}
    } else {
      vmetas.value = (await window.cs?.videoProbe(sample)) || {}
    }
  } finally {
    loading.value = false
  }
}

function switchTab(t: 'image' | 'video'): void {
  mediaTab.value = t
  sub.value = 'collect'
  typeFilter.value = new Set()
  void loadCollect()
}

function toggleType(t: string): void {
  const s = new Set(typeFilter.value)
  if (s.has(t)) s.delete(t)
  else s.add(t)
  typeFilter.value = s
  if (sub.value === 'collect') void loadCollect()
  else void loadGrid()
}

function toggleSort(k: 'size' | 'name' | 'mtime' | 'type'): void {
  if (sortKey.value === k) sortAsc.value = !sortAsc.value
  else { sortKey.value = k; sortAsc.value = false }
}

/* 灯箱 */
function openLightbox(h: Hit, list?: Hit[]): void {
  // v4.1.1 修复：按【文件类型】而非页面 tab 分流——
  // 场景：视频 tab 下打开时间线/收藏点里的图片，旧逻辑误走视频播放器→error→系统画图
  const isVid = /\.(mp4|mkv|avi|mov|wmv|flv|webm|rmvb|ts|m4v|mpg|mpeg|3gp)$/i.test(h.path)
  if (isVid) { void openPlayer(h); return }
  // v3.1.1 修复：翻页列表 = 打开来源列表（时间线传该月列表；网格用当前排序结果）
  lbList.value = list && list.length ? list : (sortedHits.value.length ? sortedHits.value : [h])
  lbIndex.value = lbList.value.findIndex((x) => x.path === h.path)
  if (lbIndex.value < 0) { lbList.value = [h, ...lbList.value]; lbIndex.value = 0 }
  lightbox.value = { hit: h, scale: 1 }
  void openLightboxTags()
}
function lbNav(d: number): void {
  const n = lbIndex.value + d
  if (n < 0 || n >= lbList.value.length) return
  lbIndex.value = n
  lightbox.value = { hit: lbList.value[n], scale: 1 }
}
function lbZoom(d: number): void {
  if (!lightbox.value) return
  lightbox.value.scale = Math.max(0.1, Math.min(32, lightbox.value.scale * d))
}

/* 视频点播 */
async function openPlayer(h: Hit): Promise<void> {
  const last = await window.cs?.videoPlayposGet(h.path)
  if (last && last > 10) {
    askResume.value = last
    player.value = { hit: h, pos: 0 }
  } else {
    player.value = { hit: h, pos: 0 }
  }
}
function resumeAt(pos: number): void {
  askResume.value = null
  if (videoEl.value) videoEl.value.currentTime = pos
}
function onVideoTime(): void {
  if (!player.value || !videoEl.value) return
  // 节流存进度（每 5 秒实际写入一次由 pause/unload 承担，这里只存内存）
  player.value.pos = videoEl.value.currentTime
}
function saveProgress(): void {
  if (!player.value || !videoEl.value) return
  const d = videoEl.value.duration || 0
  void window.cs?.videoPlayposSet(player.value.hit.path, videoEl.value.currentTime, d)
}
function closePlayer(): void {
  saveProgress()
  player.value = null
  askResume.value = null
  pRate.value = 1
}
function setRate(r: number): void {
  pRate.value = r
  if (videoEl.value) videoEl.value.playbackRate = r
}
function onVideoError(): void {
  msg.value = '该编码不支持软件内播放——已为你调用系统默认播放器'
  void window.cs?.videoOpen(player.value?.hit.path || '')
  closePlayer()
}

/* 通用操作 */
async function addToPending(path: string): Promise<void> {
  await window.cs?.pendingAdd(path, false)
  msg.value = '已加入待处理清单'
}
async function locate(path: string): Promise<void> {
  await window.cs?.showItem(path)
}
async function softDelete(hit: Hit): Promise<void> {
  if (!window.confirm(`将「${hit.name}」移入回收站（可恢复）？`)) return
  try {
    await window.cs?.junkClean([{ path: hit.path, size: hit.size, mtime: hit.mtime }], 'confirmed')
    hits.value = hits.value.filter((h) => h.path !== hit.path)
    if (lightbox.value) lightbox.value = null
    if (player.value) closePlayer()
    msg.value = '已软删除'
  } catch (e) {
    msg.value = (e as Error).message
  }
}
function copyPath(p: string): void {
  void navigator.clipboard.writeText(p)
  msg.value = '路径已复制'
}

/* 右键 */
function onCtx(e: MouseEvent, h: Hit): void {
  e.preventDefault()
  ctxMenu.value = { x: e.clientX, y: e.clientY, hit: h }
}
function ctxAction(a: string): void {
  const h = ctxMenu.value?.hit
  ctxMenu.value = null
  if (!h) return
  if (a === 'preview' || a === 'play') openLightbox(h)
  else if (a === 'locate') void locate(h.path)
  else if (a === 'pending') void addToPending(h.path)
  else if (a === 'copy') copyPath(h.path)
  else if (a === 'delete') void softDelete(h)
}

function onKey(e: KeyboardEvent): void {
  if (player.value && e.key === 'Escape') { closePlayer(); return }
  if (!lightbox.value) return
  if (e.key === 'Escape') lightbox.value = null
  else if (e.key === 'ArrowLeft') lbNav(-1)
  else if (e.key === 'ArrowRight') lbNav(1)
}
function onGlobalClick(): void {
  ctxMenu.value = null
}

onMounted(() => {
  if (props.initialType) typeFilter.value = new Set([props.initialType])
  void loadCollect()
  void loadRoots()
  void loadTags()
  window.addEventListener('keydown', onKey)
  window.addEventListener('click', onGlobalClick)
})
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', onGlobalClick) })
</script>

<template>
  <div class="media">
    <div class="tabs">
      <button class="tab" :class="{ active: mediaTab === 'image' }" @click="switchTab('image')">{{ tr('tImages') }}</button>
      <button class="tab" :class="{ active: mediaTab === 'video' }" @click="switchTab('video')">{{ tr('tVideos') }}</button>
      <button class="tab" @click="loadTimeline">{{ tr('tTimeline') }}</button>
      <button class="tab" :class="{ active: sub === 'geo' }" @click="loadGeo">{{ tr('tGeo') }}</button>
      <span class="grow"></span>
      <button v-if="sub === 'grid'" class="cs-btn sm" @click="sub = 'collect'">← 收藏点</button>
      <button v-if="sub === 'grid'" class="cs-btn sm" @click="showAll()">🌐 展示全部</button>
    </div>

    <!-- v3.6 标签过滤 -->
    <div v-if="tagChips.length && sub !== 'geo' && sub !== 'timeline'" class="root-chips">
      <span class="rc-label">🏷️ 标签：</span>
      <button class="chip" :class="{ on: tagFilter === '' }" @click="setTagFilter('')">全部</button>
      <button v-for="t in tagChips.slice(0, 12)" :key="t.tag" class="chip" :class="{ on: tagFilter === t.tag }" @click="setTagFilter(t.tag)">{{ t.tag }}（{{ t.count }}）</button>
    </div>

    <!-- v3.1.1：已索引盘根 chips（跨盘切换入口常驻——点盘过滤/再点回全部） -->
    <div v-if="roots.length > 1" class="root-chips">
      <span class="rc-label">📦 已索引的盘：</span>
      <button class="chip" :class="{ on: rootFilter === '' }" @click="setRootFilter('')">全部</button>
      <button v-for="r in roots" :key="r" class="chip" :class="{ on: rootFilter === r }" :title="r" @click="setRootFilter(r)">{{ r.replace(/[\\/]+$/, '') }}</button>
    </div>

    <section v-if="msg" class="glass msg">{{ msg }}<button class="op" style="margin-left:10px" @click="msg = ''">知道了</button></section>

    <!-- 工具栏：类型筛选 + 排序 + 视图 -->
    <section class="glass toolbar">
      <div class="tb-row">
        <span class="tb-label">类型</span>
        <button v-for="t in ALL_TYPES" :key="t" class="chip" :class="{ on: typeFilter.has(t) }" @click="toggleType(t)">{{ t }}</button>
        <span class="grow"></span>
        <template v-if="sub === 'grid'">
          <button v-for="sk in (['size','name','mtime','type'] as const)" :key="sk" class="chip sort" :class="{ on: sortKey === sk }" @click="toggleSort(sk)">
            {{ { size: '大小', name: '名称', mtime: '日期', type: '类型' }[sk] }}{{ sortKey === sk ? (sortAsc ? '↑' : '↓') : '' }}
          </button>
          <button class="chip" @click="viewMode = viewMode === 'grid' ? 'list' : 'grid'">{{ viewMode === 'grid' ? '☰ 列表' : '▦ 网格' }}</button>
        </template>
      </div>
    </section>

    <!-- 相册时间线（v3.0 G1） -->
    <template v-if="sub === 'timeline'">
      <section class="glass card tip-card">
        <span>{{ tlTotal.toLocaleString() }} 张 · {{ tlSpan }}</span>
        <button class="cs-btn sm" :disabled="tlBusy" @click="tlGroups = []; loadTimeline()">{{ tlBusy ? '整理中…' : '刷新' }}</button>
        <span v-if="tlBusy" class="tip-inline">正在解析拍摄时间（EXIF），已缓存的秒开</span>
        <div class="grow"></div>
        <button v-for="Y in tlGroups" :key="Y.year" class="chip" @click="jumpToYear(Y.year)">{{ Y.year }}</button>
      </section>
      <section v-if="todayHits" class="glass card today-card">
        <b>💌 那年今天</b>
        <div class="today-grid">
          <img v-for="h in todayHits.slice(0, 12)" :key="h.path" class="today-thumb" :title="new Date(h.t).toLocaleDateString('zh-CN') + ' · ' + h.name" @click="openLightbox(h, todayHits)" />
        </div>
      </section>
      <section v-for="Y in tlGroups" :id="'tl-' + Y.year" :key="Y.year" class="glass card tl-year">
        <h3 class="tl-y">{{ Y.year }} 年</h3>
        <div v-for="M in Y.months" :key="M.month" class="tl-month">
          <div class="tl-m sticky-head">{{ M.month }} 月 · {{ M.hits.length.toLocaleString() }} 张</div>
          <div class="grid">
            <div v-for="h in M.hits.slice(0, 400)" :key="h.path" class="card-item" @click="openLightbox(h, M.hits)" @contextmenu="onCtx($event, h)">
              <div class="thumb vwrap">
                <img v-if="thumbs[h.path]" :src="'file://' + thumbs[h.path]" loading="lazy" class="thumb" />
                <div v-else class="ph">🖼️</div>
                <span v-if="h.approx" class="approx" title="无拍摄时间，按文件时间归位">≈</span>
              </div>
              <div class="meta"><div class="sub">{{ new Date(h.t).getDate() }} 日 · {{ formatBytes(h.size) }}</div></div>
            </div>
          </div>
        </div>
      </section>
      <section v-if="!tlBusy && !tlGroups.length" class="glass empty">没有照片——先扫描含图片的目录</section>
    </template>

    <!-- EXIF 地点相册（v3.6） -->
    <template v-if="sub === 'geo'">
      <section class="glass card">
        <div class="row">
          <label>📍 地点相册</label>
          <span class="tip-inline">按拍摄地自动聚类（3km 内为一地）· 纯坐标不渲染地图</span>
          <div class="grow"></div>
          <button class="cs-btn sm" :disabled="geoBusy" @click="geoClusters = []; loadGeo()">{{ geoBusy ? '解析中…' : '刷新' }}</button>
        </div>
        <section v-if="geoMsg" class="geo-msg">{{ geoMsg }}</section>
      </section>
      <section v-for="(c, i) in geoClusters.slice(0, 50)" :key="i" class="glass grp" @click="geoOpen = geoOpen === c ? null : c">
        <div class="g-info">
          <div class="g-dir">📌 {{ c.lat.toFixed(3) }}°, {{ c.lon.toFixed(3) }}°</div>
          <div class="g-sub">{{ c.items.length }} 张照片</div>
        </div>
        <span class="op">{{ geoOpen === c ? '收起' : '展开' }}</span>
      </section>
      <section v-if="geoOpen" class="glass card">
        <div class="grid">
          <div v-for="pt in geoOpen.items.slice(0, 200)" :key="pt" class="card-item" @click="openLightbox(hits.find(h => h.path === pt) || { path: pt, name: pt.split(/[\\/]/).pop() || pt, size: 0, mtime: 0, type: '图片' })">
            <div class="thumb vwrap"><img :src="'file://' + pt" loading="lazy" class="thumb" /></div>
          </div>
        </div>
      </section>
      <section v-if="!geoBusy && !geoClusters.length && geoMsg" class="glass empty">暂无定位照片</section>
    </template>

    <!-- 收藏点 -->
    <template v-if="sub === 'collect'">
      <section v-if="stats" class="glass card tip-card">
        <span>索引 {{ stats.files.toLocaleString() }} 个文件（{{ stats.roots.length }} 根）{{ stats.indexedAt ? ` · 索引于 ${new Date(stats.indexedAt).toLocaleString('zh-CN', { hour12: false })}` : '' }}</span>
        <button class="cs-btn sm" :disabled="loading" @click="loadCollect">{{ loading ? '加载中…' : '刷新' }}</button>
      </section>
      <section v-for="g in groups.slice(0, 60)" :key="g.dir" class="glass grp" @click="openDir(g.dir)" @contextmenu.prevent="void 0">
        <div class="g-info">
          <div class="g-dir" :title="g.dir">📁 {{ g.dir }}</div>
          <div class="g-sub">{{ g.count.toLocaleString() }} 个 · {{ formatBytes(g.bytes) }}</div>
        </div>
        <button class="cs-btn sm">进入 →</button>
      </section>
      <section v-if="!loading && !groups.length && !msg" class="glass empty">没有内容——先扫描</section>
    </template>

    <!-- 网格/列表 -->
    <template v-else>
      <section class="glass card tip-card">
        <span>{{ hits.length.toLocaleString() }} 个结果{{ currentDir ? ' · ' + currentDir : '' }}</span>
        <span class="tip-inline">{{ mediaTab === 'video' ? '双击点播 · ' : '' }}右键更多操作 · 只读预览</span>
      </section>
      <!-- 网格视图 -->
      <section v-if="viewMode === 'grid'" class="glass card">
        <div class="grid">
          <div v-for="h in sortedHits.slice(0, 300)" :key="h.path" class="card-item" @click="openLightbox(h)" @dblclick="mediaTab === 'video' && openLightbox(h)" @contextmenu="onCtx($event, h)">
            <!-- 图片 -->
            <img v-if="mediaTab === 'image' && thumbs[h.path]" :src="'file://' + thumbs[h.path]" loading="lazy" class="thumb" />
            <div v-else-if="mediaTab === 'image'" class="thumb ph">🖼️</div>
            <!-- 视频 -->
            <div v-else class="thumb vwrap">
              <img v-if="vmetas[h.path]?.thumb" :src="'file://' + vmetas[h.path]!.thumb" loading="lazy" class="thumb" />
              <div v-else class="ph">🎞️</div>
              <span class="vdur">{{ fmtDur(vmetas[h.path]?.durationSec) }}</span>
            </div>
            <div class="meta">
              <div class="name" :title="h.path">{{ h.name }}</div>
              <div class="sub">{{ formatBytes(h.size) }} · {{ fmtT(h.mtime) }}<template v-if="mediaTab === 'video' && vmetas[h.path]?.width"> · {{ vmetas[h.path]!.width }}×{{ vmetas[h.path]!.height }}</template></div>
            </div>
          </div>
        </div>
        <p v-if="hits.length > 300" class="tip center">… 其余 {{ hits.length - 300 }} 个（可加类型/排序筛选）</p>
      </section>
      <!-- 列表视图 -->
      <section v-else class="glass card">
        <div class="lrow head"><span>名称</span><span>类型</span><span>大小</span><span>日期</span><span></span></div>
        <div class="lbody">
          <div v-for="h in sortedHits.slice(0, 500)" :key="h.path" class="lrow" @dblclick="openLightbox(h)" @contextmenu="onCtx($event, h)">
            <span class="l-name" :title="h.path">{{ h.name }}</span>
            <span class="l-type">{{ h.type }}</span>
            <span class="l-size">{{ formatBytes(h.size) }}</span>
            <span class="l-date">{{ fmtT(h.mtime) }}</span>
            <span class="l-ops"><button class="op" @click="openLightbox(h)">{{ /\.(mp4|mkv|avi|mov|wmv|flv|webm|rmvb|ts|m4v|mpg|mpeg|3gp)$/i.test(h.path) ? '播放' : '预览' }}</button></span>
          </div>
        </div>
      </section>
    </template>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div v-if="ctxMenu" class="ctx" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <button @click="ctxAction(mediaTab === 'video' ? 'play' : 'preview')">{{ mediaTab === 'video' ? '▶ 播放' : '🔍 预览' }}</button>
        <button @click="ctxAction('locate')">📁 定位到文件夹</button>
        <button @click="ctxAction('pending')">📝 加入清单</button>
        <button @click="ctxAction('copy')">📋 复制完整路径</button>
        <button class="del" @click="ctxAction('delete')">🗑 删除（软删除）</button>
      </div>
    </Teleport>

    <!-- 灯箱（图片） -->
    <Teleport to="body">
      <div v-if="lightbox" class="lb-mask" @click.self="lightbox = null">
        <img :src="'file://' + lightbox.hit.path" class="lb-img" :style="{ transform: `scale(${lightbox.scale})` }" @wheel.prevent="lbZoom($event.deltaY < 0 ? 1.2 : 1/1.2)" @dblclick="lightbox.scale = lightbox.scale === 1 ? 3 : 1" />
        <button class="lb-nav left" @click="lbNav(-1)">‹</button>
        <button class="lb-nav right" @click="lbNav(1)">›</button>
        <div class="lb-bar">
          <span class="lb-name">{{ lightbox.hit.name }}</span>
          <span class="lb-info">{{ formatBytes(lightbox.hit.size) }} · {{ fmtT(lightbox.hit.mtime) }} · {{ Math.round(lightbox.scale * 100) }}%</span>
          <span class="lb-path" @click="copyPath(lightbox!.hit.path)">{{ lightbox.hit.path }}</span>
          <span class="lb-tags">
            <span v-for="t in lightboxTags" :key="t" class="lb-tag" @click.stop="removeTag(t)">🏷️{{ t }} ✕</span>
            <input v-model="tagInput" class="lb-tag-in" placeholder="+标签" @keyup.enter="addTag" />
          </span>
          <span class="grow"></span>
          <button class="op" @click="locate(lightbox!.hit.path)">定位</button>
          <button class="op" @click="addToPending(lightbox!.hit.path)">加入清单</button>
          <button class="op del" @click="softDelete(lightbox!.hit)">删除</button>
          <button class="op" @click="lightbox = null">Esc</button>
        </div>
      </div>
    </Teleport>

    <!-- 视频点播浮层 -->
    <Teleport to="body">
      <div v-if="player" class="lb-mask vplayer" @click.self="closePlayer">
        <video ref="videoEl" :src="'file://' + player.hit.path" controls autoplay class="v-video" @timeupdate="onVideoTime" @error="onVideoError" @ended="closePlayer" />
        <div class="v-bar">
          <span class="lb-name">{{ player.hit.name }}</span>
          <span class="lb-info">{{ formatBytes(player.hit.size) }}<template v-if="vmetas[player.hit.path]?.width"> · {{ vmetas[player.hit.path]!.width }}×{{ vmetas[player.hit.path]!.height }}</template></span>
          <span class="grow"></span>
          <span class="rate-group">
            <button v-for="r in [0.5, 1, 1.5, 2, 4]" :key="r" class="chip rate" :class="{ on: pRate === r }" @click="setRate(r)">{{ r }}x</button>
          </span>
          <button class="op" @click="locate(player!.hit.path)">定位</button>
          <button class="op" @click="addToPending(player!.hit.path)">加清单</button>
          <button class="op del" @click="softDelete(player!.hit)">删除</button>
          <button class="op" @click="closePlayer">关闭</button>
        </div>
        <!-- 续播询问 -->
        <div v-if="askResume !== null" class="resume-card glass">
          <p>上次看到 {{ fmtDur(askResume) }}，继续播放？</p>
          <div>
            <button class="cs-btn primary sm" @click="resumeAt(askResume)">▶ 续播</button>
            <button class="cs-btn sm" @click="resumeAt(0); askResume = null">从头播</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.media { display: flex; flex-direction: column; gap: 14px; padding-bottom: 12px; }
.geo-msg { font-size: 12.5px; color: #A8C7FF; padding: 8px 0; }
.lb-tags { display: inline-flex; gap: 6px; align-items: center; margin-left: 8px; }
.lb-tag { font-size: 10.5px; padding: 2px 8px; border-radius: 6px; background: rgba(110,168,255,0.15); color: #A8C7FF; cursor: pointer; }
.lb-tag-in { width: 64px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #E8ECFA; font-size: 11px; padding: 2px 8px; outline: none; }
.root-chips { display: flex; gap: 8px; align-items: center; padding: 10px 18px; margin-top: 10px; border-radius: 14px; background: rgba(255,255,255,0.035); font-size: 12px; }
.rc-label { color: var(--text-3); }
.tabs { display: flex; gap: 8px; align-items: center; }
.tab { padding: 8px 18px; border-radius: 999px; font-size: 13px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.tab.active { color: #0A1128; font-weight: 700; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }
.grow { flex: 1; }
.msg { padding: 12px 20px; font-size: 13px; color: #A8C7FF; }
.card { padding: 18px 22px; }
.tip-card { display: flex; align-items: center; gap: 14px; font-size: 12.5px; color: var(--text-2); }
.tip-inline { font-size: 11px; color: var(--text-3); }
.toolbar { padding: 12px 22px; }
.tb-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tb-label { font-size: 12px; color: var(--text-3); }
.chip { padding: 5px 13px; border-radius: 999px; font-size: 12px; color: var(--text-2); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.chip.on { color: #0A1128; font-weight: 600; background: linear-gradient(135deg, #9CC2FF, #6EA8FF); border-color: transparent; }
.chip.sort { font-variant-numeric: tabular-nums; }
.grp { display: flex; align-items: center; gap: 14px; padding: 14px 22px; cursor: pointer; }
.grp:hover { background: rgba(255,255,255,0.07); }
.g-info { flex: 1; min-width: 0; }
.g-dir { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-sub { font-size: 12px; color: var(--text-3); margin-top: 3px; }
.empty { padding: 40px; text-align: center; color: var(--text-3); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.card-item { cursor: pointer; border-radius: 14px; padding: 8px; background: rgba(255,255,255,0.04); transition: background .15s; }
.card-item:hover { background: rgba(255,255,255,0.09); }
.thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; display: block; }
.thumb.ph, .vwrap .ph { display: flex; align-items: center; justify-content: center; font-size: 34px; background: rgba(255,255,255,0.06); }
.vwrap { position: relative; }
.vdur { position: absolute; right: 8px; bottom: 8px; font-size: 11px; color: #fff; background: rgba(0,0,0,0.72); padding: 2px 8px; border-radius: 6px; font-variant-numeric: tabular-nums; }
.meta { margin-top: 6px; }
.name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { font-size: 10.5px; color: var(--text-3); margin-top: 2px; }
.tip.center { text-align: center; color: var(--text-3); font-size: 11.5px; padding-top: 8px; }
.lrow { display: grid; grid-template-columns: 1fr 56px 90px 90px 70px; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 10px; font-size: 12.5px; }
.lrow.head { font-size: 11px; color: var(--text-3); border-bottom: 1px solid rgba(255,255,255,0.08); }
.lrow:not(.head):hover { background: rgba(255,255,255,0.05); }
.lbody { max-height: 520px; overflow-y: auto; }
.l-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l-type, .l-date { color: var(--text-3); font-size: 11.5px; }
.l-size { color: #A8C7FF; text-align: right; font-variant-numeric: tabular-nums; }
.l-ops { text-align: right; }
.today-card { padding: 14px 22px; display: flex; flex-direction: column; gap: 10px; }
.today-grid { display: flex; gap: 8px; overflow-x: auto; }
.today-thumb { width: 84px; height: 84px; border-radius: 12px; object-fit: cover; background: rgba(255,255,255,0.06); cursor: pointer; }
.tl-year { padding: 18px 22px; }
.tl-y { margin: 0 0 8px; font-size: 18px; }
.tl-month { margin-bottom: 18px; }
.tl-m { font-size: 13px; font-weight: 600; color: #A8C7FF; padding: 6px 0 10px; position: sticky; top: 0; background: linear-gradient(rgba(16,23,64,0.92), rgba(16,23,64,0.75)); backdrop-filter: blur(12px); border-radius: 8px; z-index: 5; }
.approx { position: absolute; right: 8px; top: 8px; font-size: 13px; color: #FFB86C; background: rgba(0,0,0,0.6); border-radius: 6px; padding: 0 6px; }
.ctx { position: fixed; z-index: 95; background: rgba(16,23,64,0.95); border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; padding: 6px; display: flex; flex-direction: column; gap: 2px; min-width: 170px; backdrop-filter: blur(16px); }
.ctx button { padding: 8px 14px; border: none; background: transparent; color: #E8ECFA; font-size: 12.5px; text-align: left; border-radius: 8px; cursor: pointer; }
.ctx button:hover { background: rgba(255,255,255,0.09); }
.ctx button.del { color: #FF5D6C; }
.lb-mask { position: fixed; inset: 0; background: rgba(2,4,12,0.92); z-index: 90; display: flex; align-items: center; justify-content: center; }
.lb-img { max-width: 88vw; max-height: 82vh; object-fit: contain; transition: transform .12s; border-radius: 8px; }
.lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 52px; height: 80px; border-radius: 14px; font-size: 30px; color: #fff; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); cursor: pointer; }
.lb-nav.left { left: 18px; } .lb-nav.right { right: 18px; }
.lb-bar, .v-bar { position: absolute; bottom: 0; left: 0; right: 0; display: flex; align-items: center; gap: 12px; padding: 14px 22px; background: linear-gradient(transparent, rgba(2,4,12,0.92)); font-size: 12.5px; color: #E8ECFA; flex-wrap: wrap; }
.lb-name { font-weight: 700; }
.lb-info { color: rgba(232,236,250,0.65); }
.lb-path { color: rgba(232,236,250,0.5); cursor: pointer; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-path:hover { color: #A8C7FF; }
.op { padding: 5px 12px; border-radius: 10px; font-size: 12px; color: var(--text-2); background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; }
.op.del { color: #FF5D6C; }
.v-video { max-width: 90vw; max-height: 80vh; border-radius: 10px; background: #000; }
.rate-group { display: flex; gap: 4px; }
.chip.rate { padding: 3px 9px; font-size: 11px; background: rgba(255,255,255,0.06); color: #C9D4F5; }
.chip.rate.on { background: #6EA8FF; color: #0A1128; }
.resume-card { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 26px 30px; display: flex; flex-direction: column; gap: 14px; text-align: center; border-radius: 18px; }
.resume-card p { font-size: 14px; color: #E8ECFA; }
.cs-btn.sm { padding: 7px 14px; font-size: 12px; }
</style>
