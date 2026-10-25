import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const VIEWS_DIR = resolve(__dirname, '../src/renderer/src/views')
const appVue = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf-8')

/** P0 验收：五个页面可切换（导航完整覆盖六模块） */
describe('导航完整性（六模块）', () => {
  const modules = ['dashboard', 'insight', 'clean', 'organize', 'speedup']

  it.each(modules)('导航包含模块：%s', (m) => {
    expect(appVue).toContain(`id: '${m}'`)
  })

  it('六个视图组件文件均存在且被引入', () => {
    const files = readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.vue'))
    expect(files.length).toBe(6)
    for (const f of files) {
      const name = f.replace('.vue', '')
      expect(appVue).toContain(name)
    }
  })
})

/** 红线自检：占位页不得出现激进「一键深度清理」类文案 */
describe('文案安全', () => {
  it('所有页面不出现激进清理表述', () => {
    for (const f of readdirSync(VIEWS_DIR).filter((x) => x.endsWith('.vue'))) {
      const c = readFileSync(resolve(VIEWS_DIR, f), 'utf-8')
      expect(c).not.toContain('一键深度清理')
      expect(c).not.toContain('强力清扫')
    }
  })
})
