<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Dashboard from './views/DashboardView.vue'
import Insight from './views/InsightView.vue'
import Clean from './views/CleanView.vue'
import Organize from './views/OrganizeView.vue'
import Speedup from './views/SpeedupView.vue'
import Media from './views/MediaView.vue'

type PageId = 'dashboard' | 'insight' | 'clean' | 'organize' | 'speedup' | 'media'

/** v3.4：导航文案 i18n（label 动态取词） */
const NAV_BASE: Array<{ id: PageId; icon: string; key: string; sub: string; subEn: string }> = [
  { id: 'dashboard', icon: '🛡️', key: 'home', sub: '体检 · 总览', subEn: 'Checkup · Overview' },
  { id: 'insight', icon: '🔭', key: 'insight', sub: '空间分析', subEn: 'Space analysis' },
  { id: 'clean', icon: '🧹', key: 'clean', sub: '垃圾清理', subEn: 'Junk cleaning' },
  { id: 'organize', icon: '🗂️', key: 'organize', sub: '智能归档', subEn: 'Smart organize' },
  { id: 'speedup', icon: '⚡', key: 'speed', sub: '启动 · 进程', subEn: 'Startup · Processes' },
  { id: 'media', icon: '📷', key: 'media', sub: '图片 · 预览', subEn: 'Images · Preview' }
]
const NAV = computed(() => NAV_BASE.map(n => ({ ...n, label: t(n.key), sub: L.value === 'en' ? n.subEn : n.sub })))

const page = ref<PageId>('dashboard')
const transitioning = ref(false)

function go(id: PageId): void {
  if (page.value === id || transitioning.value) return
  transitioning.value = true
  page.value = id
  setTimeout(() => (transitioning.value = false), 200)
}

const current = computed(() => NAV.find((n) => n.id === page.value))

const mediaInitialType = ref<string | undefined>(undefined)
function goFixPage(p: string): void {
  // 支持 'media:类型' 形式（透视类型分布下钻，红线 17：类型口径同 classifyFile）
  if (p.startsWith('media:')) {
    mediaInitialType.value = p.slice(6)
    go('media')
    return
  }
  if (p === 'media') mediaInitialType.value = undefined
  if (['dashboard', 'insight', 'clean', 'organize', 'speedup', 'media'].includes(p)) go(p as PageId)
}

const views: Record<PageId, unknown> = { dashboard: Dashboard, insight: Insight, clean: Clean, organize: Organize, speedup: Speedup, media: Media }

const appVersion = ref('0.1.0')
import CommandPalette from './components/CommandPalette.vue'
import { lang, t } from './i18n'
const L = lang
const paletteNav = (page: string): void => { go(page as never) }
import brandImg from './assets/brand.jpg'
const brandBig = ref(false)
onMounted(() => {
  void window.cs?.appVersion?.().then((v) => { if (v) appVersion.value = v })
  // 通知点击等跨页导航
  window.cs?.onNavigate?.((p) => {
    if (['dashboard', 'insight', 'clean', 'organize', 'speedup', 'media'].includes(p)) go(p as PageId)
  })
})
</script>

<template>
  <div class="layout">
    <!-- 左侧玻璃导航 -->
    <nav class="glass nav fade-up">
      <div class="brand">
        <div class="brand-mark">澈</div>
        <div class="brand-text">
          <div class="brand-name">净澈</div>
          <div class="brand-sub">CleanSpace</div>
        </div>
      </div>
      <button
        v-for="n in NAV"
        :key="n.id"
        class="nav-item"
        :class="{ active: page === n.id }"
        @click="go(n.id)"
      >
        <span class="nav-icon">{{ n.icon }}</span>
        <span class="nav-label">
          <span class="nav-title">{{ n.label }}</span>
          <span class="nav-sub">{{ n.sub }}</span>
        </span>
      </button>
      <div class="nav-footer">
        <img :src="brandImg" class="brand-banner" title="点击查看大图" @click="brandBig = true" />
        <div class="nav-foot-row">
          <span class="ver">v{{ appVersion }}</span>
          <span class="safety">安全红线已启用</span>
        </div>
      </div>
    </nav>

    <CommandPalette @navigate="paletteNav" />

    <!-- 品牌大图预览 -->
    <Teleport to="body">
      <div v-if="brandBig" class="brand-mask" @click.self="brandBig = false">
        <img :src="brandImg" class="brand-big" @click="brandBig = false" />
        <button class="brand-close" @click="brandBig = false">✕</button>
      </div>
    </Teleport>

    <!-- 右侧内容区 -->
    <main class="content" :class="{ 'page-enter': transitioning }">
      <header class="page-head">
        <h1>{{ current?.label }} <span class="head-sub">{{ current?.sub }}</span></h1>
      </header>
      <div class="page-body">
        <KeepAlive>
          <component :is="views[page]" :key="page" class="fade-up" :initial-type="mediaInitialType" @navigate="goFixPage" />
        </KeepAlive>
      </div>
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
  padding: 18px;
  gap: 18px;
}

/* ---------- 导航栏 ---------- */
.nav {
  width: 208px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 14px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 14px;
}
.brand-mark {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 700;
  color: #0a1128;
  background: linear-gradient(135deg, #9cc2ff, #6ea8ff);
  box-shadow: 0 6px 18px rgba(110, 168, 255, 0.35);
}
.brand-name { font-size: 17px; font-weight: 700; letter-spacing: 1px; }
.brand-sub { font-size: 11px; color: var(--text-3); letter-spacing: 2px; }

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  transition: all 0.18s ease;
  margin-bottom: 4px;
}
.nav-item:hover { background: rgba(255, 255, 255, 0.07); color: var(--text-1); }
.nav-item.active {
  background: rgba(110, 168, 255, 0.16);
  border-color: rgba(110, 168,  ipc255, 0.4);
  color: var(--text-1);
}
.nav-icon { font-size: 20px; width: 26px; text-align: center; }
.nav-title { display: block; font-size: 14px; font-weight: 600; }
.nav-sub { display: block; font-size: 11px; color: var(--text-3); margin-top: 1px; }

.brand-banner { display: block; width: 100%; border-radius: 16px; cursor: zoom-in; margin-bottom: 10px; border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 8px 24px rgba(0,0,0,0.35); transition: transform .18s; }
.brand-banner:hover { transform: translateY(-2px); }
.nav-foot-row { display: flex; justify-content: space-between; align-items: center; }
.brand-mask { position: fixed; inset: 0; z-index: 99; background: rgba(2,4,12,0.9); display: flex; align-items: center; justify-content: center; animation: fade .18s; }
.brand-big { max-width: 92vw; max-height: 90vh; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,0.6); cursor: zoom-out; }
.brand-close { position: absolute; top: 22px; right: 26px; width: 40px; height: 40px; border-radius: 50%; font-size: 17px; color: #E8ECFA; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); cursor: pointer; }
.brand-close:hover { background: rgba(255,255,255,0.2); }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.nav-footer {
  margin-top: auto;
  padding: 10px 8px 2px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.safety { color: rgba(55, 211, 153, 0.8); }

/* ---------- 内容区 ---------- */
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.page-head {
  padding: 10px 6px 14px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1px;
}
.head-sub {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-3);
  margin-left: 10px;
}
.page-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 2px 8px;
}
.page-enter .page-body { opacity: 0.4; }
</style>
