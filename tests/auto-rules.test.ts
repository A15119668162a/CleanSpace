import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureAutoRules, planRule, validateRuleDir, patternToRegex, saveRule, listRules, type AutoRule } from '../src/main/cleaner/autoRules'
import type { WhitelistRule } from '../src/shared/whitelist'

let db: Database.Database
let fx: string
const WL: WhitelistRule[] = [{ id: 1, pattern: 'C:\\Windows/**', enabled: true, builtin: true }]

const daysAgo = (p: string, n: number): void => utimesSync(p, new Date(Date.now() - n * 86400e3), new Date(Date.now() - n * 86400e3))

beforeAll(() => {
  db = new Database(':memory:')
  ensureAutoRules(db)
  fx = mkdtempSync(join(tmpdir(), 'cs-ar-'))
  mkdirSync(join(fx, '安装包'), { recursive: true })
  writeFileSync(join(fx, '安装包', 'old_setup.exe'), 'x'.repeat(1000)); daysAgo(join(fx, '安装包', 'old_setup.exe'), 120)
  writeFileSync(join(fx, '安装包', 'new_setup.exe'), 'y'.repeat(1000)); daysAgo(join(fx, '安装包', 'new_setup.exe'), 10)
  writeFileSync(join(fx, '安装包', 'old_doc.pdf'), 'z'.repeat(500)); daysAgo(join(fx, '安装包', 'old_doc.pdf'), 200)
})
afterAll(() => rmSync(fx, { recursive: true, force: true }))

describe('v3.1 G10 自动清理规则（红线 16）', () => {
  it('glob 多模式：*.exe;*.msi 命中 exe 不命中 pdf', () => {
    const re = patternToRegex('*.exe;*.msi')
    expect(re.test('a.exe')).toBe(true)
    expect(re.test('b.MSI')).toBe(true)
    expect(re.test('c.pdf')).toBe(false)
  })

  it('预案命中：90 天规则命中 old_setup 不命中 new_setup/pdf', async () => {
    const rule: AutoRule = { id: 1, dir: join(fx, '安装包'), pattern: '*.exe', keepDays: 90, enabled: 1 }
    const r = await planRule(db, rule, WL)
    expect(r.hits.length).toBe(1)
    expect(r.hits[0].path).toContain('old_setup.exe')
    expect(r.overflow).toBe(false)
  })

  it('红线 16a：白名单目录禁选', () => {
    expect(validateRuleDir('C:\\Windows\\Temp', WL).ok).toBe(false)
    expect(validateRuleDir('C:\\Windows', WL).ok).toBe(false)
    expect(validateRuleDir(join(fx), WL).ok).toBe(true)
  })

  it('红线 16b：>500 文件只报警不执行', async () => {
    // 不真造 500 文件——造 501 个 0 字节文件最快
    const dir = join(fx, 'many')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 501; i++) {
      const p = join(dir, `f${i}.tmp`)
      writeFileSync(p, ''); daysAgo(p, 300)
    }
    const rule: AutoRule = { id: 2, dir, pattern: '*.tmp', keepDays: 90, enabled: 1 }
    const r = await planRule(db, rule, WL)
    expect(r.hits.length).toBe(501)
    expect(r.overflow).toBe(true)
    expect(r.overflowReason).toContain('500')
  })

  it('CRUD：保存/列表；推荐规则默认停用', () => {
    const r1 = saveRule(db, { dir: join(fx, '安装包'), pattern: '*.exe', keepDays: 90, enabled: 0 }, WL)
    expect(r1.ok).toBe(true)
    const all = listRules(db)
    expect(all.length).toBe(1)
    expect(all[0].enabled).toBe(0) // 默认停用（红线：用户逐条开启）
  })
})
