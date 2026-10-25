/** 验证 isProtected 是否误拦 Temp */
const { isProtected, globToRegExp } = require('../out/main/../src/shared/whitelist')
const rules = [
  { id: 1, pattern: 'C:/Windows/**', enabled: true, builtin: true },
  { id: 5, pattern: 'C:/Users/*/Documents/**', enabled: true, builtin: true },
  { id: 6, pattern: 'C:/Users/*/Documents/WeChat Files/**', enabled: true, builtin: true },
  { id: 9, pattern: 'C:/Users/*/AppData/Roaming/DingTalk/**', enabled: true, builtin: true }
]
const tests = [
  'C:\\Users\\Administrator\\AppData\\Local\\Temp\\abc.tmp',
  'C:\\Users\\Administrator\\AppData\\Local\\Temp',
  'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_wb.db',
  'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_001',
  'C:\\Windows\\SoftwareDistribution\\Download\\x.msu',
  'C:\\Users\\Administrator\\AppData\\Local\\CrashDumps\\a.dmp'
]
for (const t of tests) {
  console.log(isProtected(t, rules) ? '【拦截】' : '  放行 ', t)
}
// glob 行为打印
for (const p of rules.map((r) => r.pattern)) {
  console.log(p, '=>', globToRegExp(p).source.slice(0, 90))
}
