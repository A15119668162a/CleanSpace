import { describe, it, expect } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { NAV } from '../src/renderer/src/i18n/dict'

describe('v3.4 i18n 响应性（语言切换即时生效）', () => {
  it('模拟 setLang：lang ref 变更 → computed 标签联动', async () => {
    const lang = ref<'zh' | 'en'>('zh')
    const t = (k: string): string => (lang.value === 'en' ? NAV.en[k as keyof typeof NAV.en] : NAV.zh[k as keyof typeof NAV.zh]) ?? k
    const label = computed(() => t('home'))
    expect(label.value).toBe('管家')
    lang.value = 'en'
    await nextTick()
    expect(label.value).toBe('Butler')
    lang.value = 'zh'
    await nextTick()
    expect(label.value).toBe('管家')
  })
})
