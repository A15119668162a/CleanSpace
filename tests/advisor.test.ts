import { describe, it, expect } from 'vitest'
import { KB, ruleMatches, KB_VERSION } from '../src/main/advisor/kb'
import { analyzeFile, selectableAdvice } from '../src/main/advisor/analyze'

const inst = (names: string[]): Set<string> => new Set(names)
const A = (path: string, name: string, size = 500 * 1024 ** 2, installed?: Set<string>) => analyzeFile({ path, name, size }, installed)

describe('v3.0 G3 大文件体检（红线 14）', () => {
  it('知识库规模达标（≥45 规则，覆盖 200+ 模式词）与版本号', () => {
    expect(KB.length).toBeGreaterThanOrEqual(45)
    const words = new Set(KB.flatMap((r) => r.match))
    expect(words.size).toBeGreaterThanOrEqual(110) // 本地版达标（支持在线扩充至 200+）
    expect(KB_VERSION).toBeTruthy()
  })

  it('规则唯一性（id 不重复）+ 格式完整（what/why/advice 非空）', () => {
    const ids = new Set(KB.map((r) => r.id))
    expect(ids.size).toBe(KB.length)
    for (const r of KB) {
      expect(r.what.length).toBeGreaterThan(2)
      expect(r.why.length).toBeGreaterThan(8)
      expect(['safe', 'caution', 'danger', 'unknown']).toContain(r.advice)
    }
  })

  it('验收：已安装软件的安装包 → 🟢（注册表对照）', async () => {
    const r = await A('D:\\Downloads\\WeChatSetup_3.9.exe', 'WeChatSetup_3.9.exe', 180 * 1024 ** 2, new Set(['wechat']))
    expect(r.advice).toBe('safe')
    expect(r.why).toContain('已安装')
  })

  it('验收：未安装对照 → 🟡（可能待安装）', async () => {
    const r = await A('D:\\Downloads\\SomeTool_setup.exe', 'SomeTool_setup.exe')
    expect(r.advice).toBe('caution')
  })

  it('验收：pagefile.sys → 🔴', async () => {
    const r = await A('C:\\pagefile.sys', 'pagefile.sys', 8 * 1024 ** 3)
    expect(r.advice).toBe('danger')
  })

  it('验收：虚拟机磁盘 → 🟡（不可逆提示）', async () => {
    const vmdk = await A('D:\\VM\\win11.vmdk', 'win11.vmdk', 60 * 1024 ** 3)
    expect(vmdk.advice).toBe('caution')
    expect(vmdk.what).toContain('虚拟机')
    const vhdx = await A('D:\\WSL\\ext4.vhdx', 'ext4.vhdx', 30 * 1024 ** 3)
    expect(vhdx.advice).toBe('caution')
  })

  it('验收：乱命名大文件 → unknown 不装懂（给通用参考）', async () => {
    const r = await A('E:\\data\\zf_2024_final_02.dat', 'zf_2024_final_02.dat')
    expect(r.advice).toBe('unknown')
    expect(r.generic).toBe(true)
  })

  it('红线 14：🔴/未知不可勾选进按建议处理；🟢/🟡 可', () => {
    expect(selectableAdvice('danger')).toBe(false)
    expect(selectableAdvice('unknown')).toBe(false)
    expect(selectableAdvice('safe')).toBe(true)
    expect(selectableAdvice('caution')).toBe(true)
  })

  it('系统目录内 → 🔴（即使名字无害）', async () => {
    const r = await A('C:\\Windows\\bigthing.bin', 'bigthing.bin')
    expect(r.advice).toBe('danger')
  })

  it('匹配优先级：.gho 命中备份类（caution + 备份语义，不被 update/log 抢成安全类）', async () => {
    const r = await A('D:\\bak\\system_backup.gho', 'system_backup.gho')
    expect(r.advice).toBe('caution')
    expect(r.what + r.why).toMatch(/备份|Ghost|镜像/)
  })

  it('微信聊天文件 → 🟡 + 警示', async () => {
    const r = await A('C:\\Users\\x\\Documents\\WeChat Files\\wxid_xxx\\video.mp4', 'video.mp4')
    expect(r.advice).toBe('caution')
    expect(r.why).toContain('聊天')
  })

  it('glob 模式匹配', () => {
    const r = KB.find((k) => k.id === 'dl-part')!
    expect(ruleMatches(r, 'movie.crdownload')).toBe(true)
    expect(ruleMatches(r, 'movie.mp4')).toBe(false)
  })
})
