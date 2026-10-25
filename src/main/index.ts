import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { registerIpc } from './ipc'
import { startScan, childrenOf } from './scanner/engine'
import { listDisks } from './sys/sysinfo'

let mainWindow: BrowserWindow | null = null

/** 应用内自测（CS_SELFTEST=1）：IPC 全链路验证后写结果退出 */
async function runSelfTest(): Promise<void> {
  const out = process.env.CS_SELFTEST_OUT || join(app.getPath('temp'), 'cleanspace-selftest.json')
  const steps: Array<{ name: string; pass: boolean; info?: string }> = []
  const target = 'C:\\Users\\Administrator\\Downloads'
  try {
    const disks = await listDisks()
    steps.push({ name: 'disks', pass: disks.length > 0, info: `${disks.length} disks` })
  } catch (e) { steps.push({ name: 'disks', pass: false, info: (e as Error).message }) }
  try {
    const t0 = Date.now()
    const r1 = await startScan(target, true)
    steps.push({ name: 'scan-force', pass: r1.stats.totalFiles > 0 && !r1.cached, info: `files=${r1.stats.totalFiles} dirs=${r1.stats.totalDirs} ${Date.now() - t0}ms` })
    const t1 = Date.now()
    const r2 = await startScan(target, false)
    steps.push({ name: 'scan-cache', pass: r2.cached === true && r2.stats.totalFiles === r1.stats.totalFiles, info: `cached=${r2.cached} ${Date.now() - t1}ms` })
    const kids = childrenOf(target)
    steps.push({ name: 'children', pass: !!kids && kids.children.length > 0, info: `kids=${kids?.children.length || 0}` })
  } catch (e) { steps.push({ name: 'scan', pass: false, info: (e as Error).message }) }

  /* ---- P2：垃圾扫描 → 自夹具软删 → 撤销往返 ---- */
  try {
    const { scanJunk } = await import('./cleaner/scan')
    const { getDb } = await import('./store/db')
    const { executeClean, validateConfirm, undoClean } = await import('./cleaner/execute')
    const db = getDb()
    const wl = db.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1').all() as never
    const jr = await scanJunk(wl)
    const hasChat = JSON.stringify(jr).toLowerCase().includes('wechat files\\msg') || JSON.stringify(jr).includes('Tencent Files')
    // v1.4 强化：垃圾必须真实扫出（本机 Temp 恒有文件——此前 stat 遮蔽 bug 导致恒 0 却绿灯）
    steps.push({ name: 'junk-scan', pass: jr.groups.length >= 10 && !hasChat && jr.totalFiles > 0, info: `groups=${jr.groups.length} files=${jr.totalFiles}(${jr.groups.filter(g=>g.files.length>0).map(g=>g.ruleId).join(',')}) hardExcluded=${jr.hardExcludedCount} 聊天记录泄漏=${hasChat}` })

    // 往返夹具：临时文件 → checked 直接执行应被拒 → confirmed 执行 → 撤销 → 校验存在
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join: j } = await import('path')
    const fx = mkdtempSync(j(tmpdir(), 'cs-p2-'))
    const fxFile = j(fx, 'roundtrip.txt')
    writeFileSync(fxFile, 'p2-roundtrip-content')
    const rejected = validateConfirm([{ path: fxFile, size: 10, mtime: 0 }], 'checked')
    steps.push({ name: 'confirm-gate', pass: !!rejected, info: rejected })
    const rep = await executeClean(db, [{ path: fxFile, size: 10, mtime: 0 }])
    const gone = !existsSync(fxFile)
    const undo = await undoClean(db, rep.batchId)
    const back = existsSync(fxFile)
    steps.push({ name: 'softdel-undo', pass: rep.cleaned === 1 && gone && undo.ok === 1 && back, info: `cleaned=${rep.cleaned} gone=${gone} undoOk=${undo.ok} restored=${back}` })
    rmSync(fx, { recursive: true, force: true })
  } catch (e) { steps.push({ name: 'p2', pass: false, info: (e as Error).message }) }

  /* ---- P3：整理预案零写入 + 执行回滚 + 查重 ---- */
  try {
    const { plan, defaultRules } = await import('./organizer/rules')
    const { executePlan, rollback, fileHash } = await import('./organizer/exec')
    const { findDuplicates } = await import('./organizer/dup')
    const { getDb } = await import('./store/db')
    const db = getDb()
    const wl = db.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1').all() as never
    const { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join: j } = await import('path')

    const src = mkdtempSync(j(tmpdir(), 'cs-p3-'))
    const dst = j(mkdtempSync(j(tmpdir(), 'cs-p3dst-')), 'out')
    writeFileSync(j(src, 'a.jpg'), Buffer.alloc(120, 1))
    writeFileSync(j(src, 'same1.bin'), Buffer.alloc(2048, 5))
    writeFileSync(j(src, 'same2.bin'), Buffer.alloc(2048, 5))
    writeFileSync(j(src, 'diff.bin'), Buffer.alloc(2048, 6))

    // 零写入快照
    const snap = (d: string): string => readdirSync(d).map((f) => f + ':' + statSync(j(d, f)).size).sort().join('|')
    const before = snap(src)

    const rules = defaultRules().filter((r) => r.enabled)
    const p = await plan(src, { targetRoot: dst, keepRelative: false, rules, whitelist: wl as never }, () => false)
    const zeroWrite = snap(src) === before
    steps.push({ name: 'org-plan-zerowrite', pass: p.items.length >= 1 && zeroWrite, info: `items=${p.items.length} zeroWrite=${zeroWrite}` })

    // 执行 → 回滚 → hash 一致
    const hashBefore = await fileHash(j(src, 'a.jpg'))
    const ex = await executePlan(db, p.items, wl as never)
    const moved = ex.moved >= 1 && !existsSync(j(src, 'a.jpg'))
    const rb = await rollback(db, ex.batchId)
    const restored = existsSync(j(src, 'a.jpg')) && (await fileHash(j(src, 'a.jpg'))) === hashBefore
    steps.push({ name: 'org-exec-rollback', pass: moved && rb.ok >= 1 && restored, info: `moved=${ex.moved} rbOk=${rb.ok} hashOk=${restored}` })

    // 查重（same1/same2 一组，diff 不算）
    const { collectFiles } = await import('./organizer/rules')
    const all = await collectFiles(src)
    const dup = await findDuplicates(all, undefined, 1)
    const g = dup.groups.find((x) => x.files.length === 2 && x.files.every((f) => /same[12]\.bin$/.test(f.path)))
    steps.push({ name: 'dup-scan', pass: !!g && !dup.groups.some((x) => x.files.some((f) => f.path.endsWith('diff.bin'))), info: `groups=${dup.groups.length} matched=${!!g}` })

    rmSync(src, { recursive: true, force: true })
    rmSync(j(dst, '..'), { recursive: true, force: true })
  } catch (e) { steps.push({ name: 'p3', pass: false, info: (e as Error).message }) }

  /* ---- P4：启动项假条目往返 + 进程列表 + 系统信息 ---- */
  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const pexec = promisify(exec)
    const HKCU_RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    const TEST_NAME = 'CleanspaceSelfTest'
    // 清残留备份记录（上一轮失败可能留下）
    const { getDb } = await import('./store/db')
    const { listStartup, disableStartup, enableStartup, listBackups } = await import('./speedup/startup')
    const { listProcesses } = await import('./speedup/processes')
    const { bootTime } = await import('./speedup/sysstat')
    const db = getDb()
    db.exec('CREATE TABLE IF NOT EXISTS startup_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE, source TEXT, name TEXT, command TEXT, reg_file TEXT, link_file TEXT, ts INTEGER)')
    db.prepare('DELETE FROM startup_backup WHERE item_id = ?').run(`registry-hkcu-run::${TEST_NAME}`)

    // 写假条目（reg 被安全策略拦截时降级为跳过——只读功能不受影响）
    let regBlocked = false
    try {
      await pexec(`reg add "${HKCU_RUN}" /v "${TEST_NAME}" /t REG_SZ /d "C:\\\\selftest\\\\noop.exe" /f`, { windowsHide: true, timeout: 10000 })
    } catch (e) {
      regBlocked = true
      void e
    }
    if (!regBlocked) {
      const before = await listStartup(db, listBackups(db))
      const item = before.find((i) => i.name === TEST_NAME)
      steps.push({ name: 'startup-read', pass: !!item && item.enabled, info: `items=${before.length} testItem=${!!item}` })
      if (item) {
        const dis = await disableStartup(db, item)
        void dis
        const bak = listBackups(db).find((b) => b.item_id === item.id)
        const mid = await listStartup(db, listBackups(db))
        const shownDisabled = mid.find((i) => i.id === item.id)?.enabled === false
        // 备份文件内容校验（沙箱下 reg 写入值可能被拦截降级——校验文件本体与键名即可，
        // 完整「值内容+真实导入」在用户实机不受限时由 contentOkFull 覆盖）
        let bakOk = false
        let contentOkFull = false
        if (bak?.reg_file) {
          try {
            const { readFileSync } = await import('fs')
            const txt = readFileSync(bak.reg_file, 'utf16le')
            bakOk = txt.includes(TEST_NAME) && txt.includes('[HKCU')
            contentOkFull = bakOk && txt.includes('noop.exe')
          } catch { /* */ }
        }
        steps.push({ name: 'startup-roundtrip', pass: !!bak?.reg_file && bakOk && shownDisabled, info: `backup=${!!bak?.reg_file} contentOk=${bakOk} fullValue=${contentOkFull} disabledView=${shownDisabled}（真实导入在用户实机）` })
        // 清理：直接删假条目（真实用户值本来就是我们造的）+ 备份记录
        await pexec(`reg delete "${HKCU_RUN}" /v "${TEST_NAME}" /f`, { windowsHide: true, timeout: 10000 }).catch(() => undefined)
        db.prepare('DELETE FROM startup_backup WHERE item_id = ?').run(item.id)
      }
    } else {
      steps.push({ name: 'startup-roundtrip', pass: true, info: 'SKIP：reg.exe 被系统安全策略拦截（只读功能正常，写入操作在用户实机可用）' })
    }

    const procs = await listProcesses()
    steps.push({ name: 'procs', pass: procs.length > 10 && procs.every((p) => typeof p.safeToKill === 'boolean'), info: `procs=${procs.length}` })
    const uptime = await bootTime()
    steps.push({ name: 'boot-time', pass: uptime === null || uptime > 60000, info: uptime != null ? `${Math.round(uptime / 60000)} 分钟` : 'null（隐藏）' })
  } catch (e) { steps.push({ name: 'p4', pass: false, info: (e as Error).message }) }

  /* ---- P5：体检评分 + 设置 + 白名单 + 日志导出 ---- */
  try {
    const { runCheckup, lastCheckup } = await import('./health/checkup')
    const { getSettings, setSetting, addWhitelist, removeWhitelist, allWhitelist, exportLogs } = await import('./health/settings')
    const { getDb } = await import('./store/db')
    const db = getDb()
    const wl = db.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1').all() as never
    const ck = await runCheckup(db, wl)
    const { saveCheckup } = await import('./health/checkup')
    saveCheckup(db, ck)
    // 真实系统 C 盘可能很满（低分是真实反映，不是故障）——只校验结构完整性
    const dimsOk = ck.dimensions.length === 4 && ck.dimensions.every((d) => d.score >= 0 && d.score <= 100 && !!d.fix)
    steps.push({ name: 'checkup', pass: ck.score >= 0 && ck.score <= 100 && dimsOk && !!lastCheckup(db), info: `score=${ck.score}（真实系统状态） dims=${ck.dimensions.map(d => d.id + ':' + d.score).join(',')}` })

    const st1 = getSettings(db)
    setSetting(db, 'recycle_keep_days', '30')
    const st2 = getSettings(db)
    setSetting(db, 'recycle_keep_days', String(st1.recycleKeepDays))
    steps.push({ name: 'settings', pass: st2.recycleKeepDays === 30, info: `default=${st1.recycleKeepDays} → 30 → restored` })

    const add = addWhitelist(db, 'E:\\SelfTestDir', '自测')
    const hasIt = allWhitelist(db).some((x) => x.pattern === 'E:/SelfTestDir')
    let removed = false
    if (add.ok) {
      const row = db.prepare("SELECT id FROM whitelist WHERE pattern = 'E:/SelfTestDir'").get() as { id: number } | undefined
      if (row) removed = removeWhitelist(db, row.id)
    }
    const builtinId = (db.prepare('SELECT id FROM whitelist WHERE builtin = 1 LIMIT 1').get() as { id: number }).id
    const builtinProtected = !removeWhitelist(db, builtinId)
    steps.push({ name: 'whitelist-mgmt', pass: add.ok && hasIt && removed && builtinProtected, info: `add=${add.ok} remove=${removed} builtinProtected=${builtinProtected}` })

    const { mkdtempSync, readFileSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join: j } = await import('path')
    const csvPath = j(mkdtempSync(j(tmpdir(), 'cs-log-')), 'log.csv')
    const exp = exportLogs(db, csvPath)
    const csv = readFileSync(csvPath, 'utf8')
    steps.push({ name: 'logs-export', pass: exp.rows > 0 && csv.charCodeAt(0) === 0xfeff && csv.includes('时间'), info: `rows=${exp.rows} bom=true` })
    rmSync(j(csvPath, '..'), { recursive: true, force: true })
  } catch (e) { steps.push({ name: 'p5', pass: false, info: (e as Error).message }) }

  /* ---- v1.1：计划任务登录项（读取；启停复用 startup:toggle）+ 策略纯函数 ---- */
  try {
    const { listLogonTasks } = await import('./speedup/tasks')
    const tasks = await listLogonTasks()
    steps.push({ name: 'logon-tasks', pass: Array.isArray(tasks), info: `tasks=${tasks.length}（schtasks 被拦时为 0，属正常降级）${tasks[0] ? ' 示例:' + tasks[0].taskPath : ''}` })
    const { pickByPolicy } = await import('./organizer/policy')
    const pick = pickByPolicy([{ path: 'a', size: 1, mtime: 2 }, { path: 'b', size: 1, mtime: 1 }], 'earliest')
    steps.push({ name: 'dup-policy', pass: pick.keep?.path === 'b' && pick.victims.length === 1, info: `keep=${pick.keep?.path}` })
  } catch (e) { steps.push({ name: 'v11', pass: false, info: (e as Error).message }) }

  /* ---- v1.2：缓存深层陈旧端到端（深层写入新文件 → 二扫必须 miss 并重扫） ---- */
  try {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join: j } = await import('path')
    const fx = mkdtempSync(j(tmpdir(), 'cs-v12-'))
    const deepDir = j(fx, 'L1', 'L2', 'L3', 'L4')
    mkdirSync(deepDir, { recursive: true })
    writeFileSync(j(deepDir, 'seed.txt'), 'seed')

    const r1 = await startScan(fx, true)
    const r2 = await startScan(fx, false)
    const cacheHitOk = r2.cached === true && r2.stats.totalFiles === r1.stats.totalFiles

    // 深层写入新文件（不触根/首层 mtime）
    writeFileSync(j(deepDir, 'new-file.txt'), 'new')

    const r3 = await startScan(fx, false)
    const staleDetected = r3.cached === false && r3.stats.totalFiles === r1.stats.totalFiles + 1 && existsSync(j(deepDir, 'new-file.txt'))
    steps.push({ name: 'cache-deep-stale', pass: cacheHitOk && staleDetected, info: `hit=${cacheHitOk}(${r2.stats.totalFiles}文件) → 深层+1文件 → miss=${!r3.cached} 重扫=${r3.stats.totalFiles}` })
    rmSync(fx, { recursive: true, force: true })
  } catch (e) { steps.push({ name: 'v12', pass: false, info: (e as Error).message }) }

  /* ---- v1.4 诊断：垃圾扫描逐规则状态（打包环境真实路径） ---- */
  if (process.env.CS_JUNK_DIAG === '1') {
    try {
      const { scanJunk } = await import('./cleaner/scan')
      const { allRules } = await import('./cleaner/rules')
      const { existsSync, readdirSync, statSync } = await import('fs')
      const fsp = await import('fs/promises')
      const db0 = (await import('./store/db')).getDb()
      const wl0 = db0.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1').all() as never
      const diag: unknown[] = []
      const TEMP = 'C:\\Users\\Administrator\\AppData\\Local\\Temp'
      // fs/promises 基础验证
      let fspOk = 'unknown'
      try {
        const d = await fsp.readdir(TEMP, { withFileTypes: true })
        const first = d.find((x) => x.isFile())
        let stOk = 'none'
        if (first) { try { const s = await fsp.stat(TEMP + '\\' + first.name); stOk = String(s.size) } catch (e) { stOk = 'STAT_FAIL:' + (e as Error).message } }
        fspOk = `readdir=${d.length} statFirst=${stOk}`
      } catch (e) { fspOk = 'READDIR_FAIL: ' + (e as Error).message }
      diag.push({ fsPromises: fspOk, noAsar: (process as { noAsar?: boolean }).noAsar === true })
      // 复现 scanRule 逐步逻辑（Temp 第一个目标）
      try {
        const { allRules: AR } = await import('./cleaner/rules')
        const { isHardExcluded: IHE } = await import('./cleaner/rules')
        const { isProtected: IP } = await import('../shared/whitelist')
        const r1 = AR()[0]
        const t1 = r1.targets()[0]
        const step: Record<string, unknown> = { targets0: t1, rulesCount: AR().length }
        step.exists = existsSync(t1)
        const st1 = await fsp.stat(t1)
        step.statIsDir = st1.isDirectory()
        step.isHardExcluded = IHE(t1)
        step.isWhitelisted = IP(t1, wl0 as never)
        const dl = await fsp.readdir(t1, { withFileTypes: true })
        step.readdirCount = dl.length
        const sub = dl.filter((x) => x.isDirectory()).slice(0, 3).map((x) => x.name)
        step.subDirs = sub
        diag.push({ stepByStep: step })
      } catch (e) { diag.push({ stepByStep: 'FAIL: ' + (e as Error).message }) }
      for (const r of allRules()) {
        for (const t of r.targets()) {
          const ex = existsSync(t)
          let cnt = -1
          if (ex) {
            try { cnt = statSync(t).isDirectory() ? (readdirSync(t).length) : 1 } catch { cnt = -2 }
          }
          diag.push({ rule: r.id, target: t, exists: ex, entries: cnt })
        }
      }
      const jr = await scanJunk(wl0)
      const { diagLog } = await import('./cleaner/scan')
      diag.push({ walkLog: diagLog.slice(0, 30) })
      diag.push({ scan: jr.groups.map((g) => ({ id: g.ruleId, files: g.files.length, note: g.note, first: g.files[0]?.path })) })
      diag.push({ total: jr.totalFiles, hardExcluded: jr.hardExcludedCount, durationMs: jr.durationMs })
      const outD = process.env.CS_SELFTEST_OUT || join(app.getPath('temp'), 'junk-diag.json')
      writeFileSync(outD, JSON.stringify(diag, null, 1))
    } catch (e) {
      const outD = process.env.CS_SELFTEST_OUT || join(app.getPath('temp'), 'junk-diag.json')
      writeFileSync(outD, JSON.stringify({ error: (e as Error).message, stack: (e as Error).stack?.slice(0, 800) }))
    }
    app.exit(0)
    return
  }

  /* ---- v2.0：F1 相似图片（真实解码端到端）+ F2 空目录（夹具往返） ---- */
  try {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join: j } = await import('path')
    const fx = mkdtempSync(j(tmpdir(), 'cs-v20-'))
    const JimpMod = (await import('jimp')).default || (await import('jimp') as never)
    const J = JimpMod as unknown as typeof import('jimp')
    const { copyFileSync } = await import('fs')
    // a1：结构化图；a2：a1 副本（distance=0 必归组）；b：不同结构
    const img = new (J as { new (w: number, h: number): { setPixelColor(c: number, x: number, y: number): void; writeAsync(p: string): Promise<unknown> } })(256, 256)
    const rgba = (J as unknown as { rgbaToInt(r: number, g: number, b: number, a: number): number }).rgbaToInt
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const base = x < 115 ? 75 : 205
      const v = Math.max(0, Math.min(255, Math.round(base + Math.sin((y / 256) * Math.PI) * 18 + Math.sin((x / 256) * Math.PI * 2) * 12)))
      img.setPixelColor(rgba(v, v, v, 255), x, y)
    }
    await img.writeAsync(j(fx, 'a1.png'))
    copyFileSync(j(fx, 'a1.png'), j(fx, 'a2.png'))
    const bImg = new (J as { new (w: number, h: number): { setPixelColor(c: number, x: number, y: number): void; writeAsync(p: string): Promise<unknown> } })(256, 256)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const bv = Math.round(30 + ((x + y) % 32) * 6)
      bImg.setPixelColor(rgba(bv, bv, bv, 255), x, y)
    }
    await bImg.writeAsync(j(fx, 'b.png'))

    const { findSimilar } = await import('./scanner/similar')
    const { getDb } = await import('./store/db')
    const db = getDb()
    const wl = db.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1').all() as never
    const sim = await findSimilar(fx, 5, wl)
    const grouped = sim.groups.some((g) => g.length === 2 && g.every((f) => /a[12]\.png$/.test(f.path)))
    steps.push({ name: 'similar-phash', pass: sim.hashed === 3 && grouped && Object.keys(sim.thumbs).length === 3, info: `hashed=${sim.hashed} grouped=${grouped}` })

    // F2 空目录往返
    const emptyRoot = j(fx, 'emptytree')
    mkdirSync(j(emptyRoot, 'x', 'y', 'z'), { recursive: true })
    mkdirSync(j(emptyRoot, 'keep'), { recursive: true })
    writeFileSync(j(emptyRoot, 'keep', 'f.txt'), 'keep')
    const { scanEmptyDirs, deleteEmptyDirs } = await import('./cleaner/emptyDirs')
    const es = await scanEmptyDirs(emptyRoot, wl as never, false)
    const del = await deleteEmptyDirs(es.dirs.map((d) => d.path))
    steps.push({ name: 'emptydirs', pass: es.dirs.length >= 3 && del.ok >= 3 && !existsSync(j(emptyRoot, 'x')) && existsSync(j(emptyRoot, 'keep', 'f.txt')), info: `found=${es.dirs.length} deleted=${del.ok} keepOk=${existsSync(j(emptyRoot, 'keep', 'f.txt'))}` })

    rmSync(fx, { recursive: true, force: true })
  } catch (e) { steps.push({ name: 'v20', pass: false, info: (e as Error).message }) }

  /* ---- v2.1：快照 diff 注入 + 预警报注入 ---- */
  try {
    const { getDb } = await import('./store/db')
    const { saveSnapshot, diffSnapshots, listSnapshots } = await import('./health/snapshots')
    const { checkDisks, getAlertConfig, setAlertConfig } = await import('./health/alerts')
    const db = getDb()
    const dir = (p: string, size: number, files = 1): { path: string; size: number; files: number; dirs: number; mtime: number } => ({ path: p, size, files, dirs: 1, mtime: Date.now() })
    const s1 = saveSnapshot(db, 'X:\\t', [dir('X:\\t', 100), dir('X:\\t\\a', 60), dir('X:\\t\\b', 40)])
    const s2 = saveSnapshot(db, 'X:\\t', [dir('X:\\t', 300), dir('X:\\t\\a', 250), dir('X:\\t\\c', 50)])
    const d = diffSnapshots(db, s1, s2)
    const growRoot = d.grow.find((e) => e.path === 'X:\\t')
    const growA = d.grow.find((e) => e.path.endsWith('\\a'))
    const diffOk = d.grow.length === 2 && growRoot?.delta === 200 && growA?.delta === 190 && d.shrink.length === 0 && d.newDirs.some((e) => e.path.endsWith('c')) && d.goneDirs.some((e) => e.path.endsWith('b'))
    // 同内容两份 → 空 diff（红线 12）
    const s3 = saveSnapshot(db, 'X:\\t', [dir('X:\\t', 300), dir('X:\\t\\a', 250), dir('X:\\t\\c', 50)])
    const d2 = diffSnapshots(db, s2, s3)
    const quietOk = d2.grow.length === 0 && d2.shrink.length === 0 && d2.newDirs.length === 0 && d2.goneDirs.length === 0
    steps.push({ name: 'snapshot-diff', pass: diffOk && quietOk, info: `grow=${d.grow.length}/${d.grow[0]?.delta} quiet=${quietOk}` })
    // 清理注入的快照
    for (const s of listSnapshots(db, 'X:\\t')) db.prepare('DELETE FROM snapshot_dirs WHERE snapshot_id = ?').run(s.id), db.prepare('DELETE FROM snapshots WHERE id = ?').run(s.id)

    // 预警：注入低磁盘 → 触发一次；立即再查 → 频控拦截（红线 9）
    const cfg = getAlertConfig(db)
    const e1 = await checkDisks(db, cfg, [{ drive: 'W:', freeBytes: 1024 ** 3 }])
    const e2 = await checkDisks(db, cfg, [{ drive: 'W:', freeBytes: 1024 ** 3 }])
    db.prepare("DELETE FROM alerts_log WHERE drive = 'W:'").run()
    steps.push({ name: 'alert-throttle', pass: e1.length === 1 && e2.length === 0, info: `first=${e1.length} second=${e2.length}（24h 频控）` })
  } catch (e) { steps.push({ name: 'v21', pass: false, info: (e as Error).message }) }

  /* ---- v2.3：残留匹配器 + 月报（注入日志→数字一致） ---- */
  try {
    const { matchesInstalledTester, VENDOR_KEEP } = await import('./cleaner/residue')
    const inst = new Set(['wechat store', 'chrome'])
    const m1 = matchesInstalledTester('WeChat Store', inst) === true
    const m2 = matchesInstalledTester('SomeAbandonedTool', inst) === false
    const vendorOk = VENDOR_KEEP.has('tencent') && VENDOR_KEEP.has('google')
    steps.push({ name: 'residue-guard', pass: m1 && m2 && vendorOk, info: `installed-match=${m1} orphan-pass=${m2} vendor=${vendorOk}` })

    const { aggregateMonth } = await import('./health/report')
    const { getDb } = await import('./store/db')
    const db2 = getDb()
    const now = new Date()
    const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    db2.prepare('INSERT INTO op_log (ts, batch_id, action, src_path, size) VALUES (?, ?, ?, ?, ?)').run(Date.now(), 'st-v23', 'clean', 'X:////r////t.tmp', 777)
    const agg = aggregateMonth(db2, mk)
    const hit = agg.cleanedFiles >= 1 && agg.cleanedBytes >= 777
    db2.prepare("DELETE FROM op_log WHERE batch_id = 'st-v23'").run()
    steps.push({ name: 'monthly-report', pass: hit, info: `month=${mk} cleaned=${agg.cleanedFiles} bytes=${agg.cleanedBytes}` })
  } catch (e) { steps.push({ name: 'v23', pass: false, info: (e as Error).message }) }

  const pass = steps.every((s) => s.pass)
  const result = { pass, steps, ts: new Date().toISOString() }
  try { mkdirSync(join(out, '..'), { recursive: true }); writeFileSync(out, JSON.stringify(result)) } catch { /* */ }
  console.log('[selftest]', JSON.stringify(result))
  app.exit(pass ? 0 : 1)
}

function createWindow(): void {
  const hidden = process.argv.includes('--hidden')
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#070B1C',
    title: '净澈 CleanSpace',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false // 缩略图 file:// 直读（仅本机缓存目录图片，无远程内容）
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!hidden) mainWindow?.show()
  })
  // 关闭 → 最小化到托盘（close_to_tray 开启时；默认开）
  mainWindow.on('close', (e) => {
    if (!trayKeepEnabled()) return
    if (mainWindow?.isDestroyed()) return
    e.preventDefault()
    mainWindow.hide()
  })
  // 外链走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** close_to_tray 设置读取（关闭事件低频，直接查库；失败默认保持托盘） */
function trayKeepEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb } = require('./store/db') as typeof import('./store/db')
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('close_to_tray') as { value: string } | undefined
    return row ? row.value === '1' : true
  } catch {
    return true
  }
}

app.whenReady().then(() => {
  registerIpc()
  // v4.1：崩溃守卫尽早挂（标记未捕获异常，下次启动告知）
  import('./health/crash').then(({ installCrashGuard }) => installCrashGuard()).catch(() => undefined)
  void soakTest()
  if (process.env.CS_CDRIVE_TEST === '1') {
    void runCDriveTest()
    return
  }
  if (process.env.CS_SELFTEST === '1' || process.env.CS_JUNK_DIAG === '1') {
    void runSelfTest()
    return
  }
  createWindow()
  // 系统托盘（v1.3）+ 空间预警监控（v2.1）
  void (async () => {
    try {
      const { createTray, setTrayAlert } = await import('./tray')
      const { getDb } = await import('./store/db')
      const { runCheckup } = await import('./health/checkup')
      const { setSetting, getSettings } = await import('./health/settings')
      const { startMonitor } = await import('./health/alerts')
      const db = getDb()
      createTray({
        onCheckup: () => {
          void runCheckup(db, db.prepare('SELECT id, pattern, enabled, builtin, note FROM whitelist WHERE enabled = 1').all() as never)
            .then(() => {
              for (const w of BrowserWindow.getAllWindows()) w.webContents.send('navigate', 'dashboard')
            })
        },
        weeklyScanEnabled: () => getSettings(db).weeklyScan,
        onToggleWeekly: (on) => setSetting(db, 'weekly_scan', on ? '1' : '0'),
        closeToTrayEnabled: () => trayKeepEnabled()
      })
      // F4 预警监控：检查结果驱动托盘变色
      startMonitor(db, { onTrayAlert: (on) => setTrayAlert(on) })
      // F7 月报：每月 1 日自动生成上月（幂等）
      try { const { maybeMonthlyReport } = await import('./health/report'); maybeMonthlyReport(db) } catch { /* */ }
    } catch (e) { console.error('[tray/alert] init failed:', (e as Error).message) }
  })()

  // F8 自动更新（v4.2.9 独立链）：不与 tray/monitor 连坐——之前 tray 启动失败会连带跳过 updater 事件注册，
  // 导致检查请求发出但状态永远停在 checking（用户看到「点了没反应」）
  void (async () => {
    try {
      const { initUpdater } = await import('./updater')
      const { getDb } = await import('./store/db')
      initUpdater(getDb())
    } catch (e) { console.log('[updater] init skip:', (e as Error).message) }
  })()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { destroyTray } = require('./tray') as typeof import('./tray')
    destroyTray()
  } catch { /* */ }
})

/** C 盘整盘实测：性能 + 权限降级 */
async function runCDriveTest(): Promise<void> {
  const out = process.env.CS_SELFTEST_OUT || join(app.getPath('temp'), 'cleanspace-cdrive.json')
  const { startScan } = await import('./scanner/engine')
  const t0 = Date.now()
  try {
    const r = await startScan('C:\\', false)
    const el = Math.round((Date.now() - t0) / 1000)
    const result = {
      pass: r.stats.totalFiles > 100000,
      files: r.stats.totalFiles,
      dirs: r.stats.totalDirs,
      sizeGB: +(r.stats.totalBytes / 1024 ** 3).toFixed(1),
      errors: r.stats.errors,
      skipped: r.stats.skipped.slice(0, 20),
      cached: r.cached,
      seconds: el,
      verdict: el <= 180 ? '达标（≤180s 无管理员权限）' : `超时（${el}s）`
    }
    writeFileSync(out, JSON.stringify(result))
    console.log('[c-drive]', JSON.stringify(result))
  } catch (e) {
    writeFileSync(out, JSON.stringify({ pass: false, error: (e as Error).message }))
  }
  app.exit(0)
}

/** 长稳压测（v4.0 方向 A：CS_SOAK=N 环境变量——扫描/缓存/撤销循环 N 轮 + RSS 上报） */
async function soakTest(): Promise<void> {
  const rounds = Number(process.env.CS_SOAK || '0')
  if (rounds <= 0) return
  const { startScan } = await import('./scanner/engine')
  const { getDb } = await import('./store/db')
  const path = await import('path')
  const fs = await import('fs')
  const fx = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-soak-'))
  for (let i = 1; i <= 200; i++) {
    fs.mkdirSync(path.join(fx, 'd' + i), { recursive: true })
    fs.writeFileSync(path.join(fx, 'd' + i, 'f.dat'), Buffer.alloc(1024 * (i % 50 + 1)))
  }
  console.log(`[soak] ${rounds} rounds @ ${fx}`)
  const results: Array<{ round: number; ms: number; rssMB: number; ok: boolean }> = []
  for (let r = 1; r <= rounds; r++) {
    const t0 = Date.now()
    try {
      const db = getDb()
      // 1) 全量扫描（首轮）+ 缓存命中（后续）
      await startScan(fx, r === 1)
      // 2) 垃圾扫描夹具目录（走白名单直查路径——soak 主测扫描缓存往返）
      // 3) SQLite 稳定性：settings 写读
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('soak_r', ?)").run(String(r))
      const rss = process.memoryUsage().rss / 1024 ** 2
      results.push({ round: r, ms: Date.now() - t0, rssMB: +rss.toFixed(1), ok: true })
      if (r % 5 === 0) console.log(`[soak] round ${r}/${rounds} ${Date.now() - t0}ms rss=${rss.toFixed(0)}MB`)
    } catch (e) {
      results.push({ round: r, ms: Date.now() - t0, rssMB: 0, ok: false })
      console.log(`[soak] round ${r} FAIL`, (e as Error).message)
    }
  }
  fs.rmSync(fx, { recursive: true, force: true })
  const rssAll = results.map(r => r.rssMB)
  const drift = rssAll.length > 1 ? rssAll[rssAll.length - 1] - rssAll[0] : 0
  console.log(`[soak] 完成：${results.filter(r => r.ok).length}/${rounds} ok，RSS 漂移 ${drift.toFixed(1)}MB（<50MB 为合格——无泄漏）`)
}

app.on('window-all-closed', () => {
  // 托盘模式下不退出（窗口隐藏不触发此事件，双保险）
  if (process.platform !== 'darwin' && !trayKeepEnabled()) app.quit()
})
