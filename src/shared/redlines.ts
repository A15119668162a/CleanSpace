/**
 * 21 条安全红线（v4.0 / 方向 A）
 * 单一事实源：应用内「安全红线」页与文档共用；编号对应历期计划书。
 */
export interface Redline {
  no: number
  title: string
  /** 白话说明（给用户看的承诺） */
  plain: string
  /** 守护方式 */
  guard: string
  since: string
}

export const REDLINES: Redline[] = [
  { no: 1, title: '系统关键目录永不触碰', plain: 'Windows、Program Files 等系统目录在扫描与清理中一律排除，想删都删不了。', guard: '白名单硬排除 + 注入测试', since: '一期' },
  { no: 2, title: '聊天记录与密码硬排除', plain: '清扫规则内置排除微信/QQ 数据与浏览器密码，任何规则都碰不到。', guard: '规则黑名单测试', since: '一期' },
  { no: 3, title: '删除前必须明细预览', plain: '任何删除动作前都展示完整文件清单，看清楚了才能继续。', guard: 'confirm-gate 测试', since: '一期' },
  { no: 4, title: '一切删除可撤销', plain: '所有清理走应用内回收站（软删除），15 天内随时整批恢复到原路径。', guard: 'softdel-undo 往返测试', since: '一期' },
  { no: 5, title: '启动项只启停不删除', plain: '提速页的启动项只做启用/停用（含 .reg 备份），绝不删除程序本体。', guard: 'startup-roundtrip 测试', since: '一期' },
  { no: 6, title: '系统进程黑名单保护', plain: '进程面板对 28 项系统关键进程禁杀，防止误杀导致系统崩溃。', guard: '进程黑名单常量+测试', since: '一期' },
  { no: 7, title: '整理预案零写入', plain: '整理方案先生成预案（不动任何文件），确认后才执行。', guard: 'org-plan-zerowrite 测试', since: '一期' },
  { no: 8, title: '卸载残留零误判', plain: '注册表已装清单 + 厂商字典双重校验，拿不准的绝不列为残留。', guard: 'residue-guard 测试', since: '二期' },
  { no: 9, title: '相似图片绝不预选', plain: '查重结果默认全部不勾选，删哪个永远由你亲手决定。', guard: 'similar/phash 测试', since: '二期' },
  { no: 10, title: '更新包哈希校验', plain: '自动更新的安装包强制 SHA 校验，被篡改的包拒绝安装。', guard: 'electron-updater 内置校验', since: '二期' },
  { no: 11, title: '重复文件三层哈希', plain: '查重按 大小→头尾哈希→全量 SHA-256 三层校验，杜绝误判。', guard: 'dup-scan 测试', since: '二期' },
  { no: 12, title: '空文件夹只删真空', plain: '空文件夹清理前二次确认为空（跳过含保护文件的目录）。', guard: 'emptydirs 测试', since: '二期' },
  { no: 13, title: '快照只读不回写', plain: '时光机快照只做对比展示，绝不反向修改磁盘。', guard: 'snapshot-diff 测试', since: '二期' },
  { no: 14, title: '大文件建议绝不代删', plain: '体检结论 🔴别动/❓未知的项，物理不可勾选；🟢 也走完整确认。', guard: 'advisor selectableAdvice 测试', since: '三期' },
  { no: 15, title: '自动整理只动指定目录', plain: '下载整理只监视你亲手添加的目录；未完成下载（.crdownload 等）绝不触碰。', guard: 'watcher isIncomplete 测试', since: '三期' },
  { no: 16, title: '自动清理只到软删除', plain: '自动清理规则最多样板是生成预案（软删除），真删永远人工；白名单路径禁选；超 500 文件只报警。', guard: 'autoRules 测试', since: '三期' },
  { no: 17, title: '系统级操作引导式确认', plain: '深度清理绝不 /ResetBase、绝不删页面文件、绝不静默提权；不可逆操作须文字输入确认。', guard: 'deep ACTIONS 测试', since: '三期' },
  { no: 18, title: '浏览器五类数据物理隔离', plain: '书签/密码/历史/扩展/自动填充不仅不删——任何清理代码路径都碰不到这些文件。', guard: 'isForbiddenPath 注入测试', since: '三期' },
  { no: 19, title: '视频查重绝不预选', plain: '与相似图片同规：分组结果默认零勾选。', guard: 'VidGroup 形状测试', since: '三期' },
  { no: 20, title: 'EXIF 只读', plain: '时间线/地点解析只读照片元数据，字节级不回写（解析后文件 mtime 不变）。', guard: 'exif 字节级测试', since: '三期' },
  { no: 21, title: '聊天记录物理隔离', plain: '微信/QQ 的 Msg 数据库不扫描、不展示、无任何清理入口——连体积统计都不进。', guard: 'chat FORBIDDEN 零泄漏测试', since: '三期' }
]
