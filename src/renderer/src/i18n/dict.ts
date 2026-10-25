/**
 * i18n 词典（v3.4 / G8）
 * zh-CN 为源语言（键=中文文案直用），en-US 全量对照。
 * 红线：en 必须与 zh key 树完全一致（tests/i18n.test.ts 递归校验 0 缺失）。
 */

/** v4.2：各页 tabs（六页高频） */
export const TABS = {
  zh: {
    tImages: '🖼️ 图片', tVideos: '🎬 视频', tTimeline: '🗓️ 时间线', tGeo: '📍 地点',
    tSunburst: '旭日图', tTop50: 'TOP 50 大文件', tTopDirs: 'TOP 20 文件夹', tTypes: '类型分布', tCompare: '磁盘对比',
    tJunk: '🧹 垃圾清扫', tRecycle: '♻️ 回收站', tEmpty: '📂 空文件夹', tResidue: '🧟 卸载残留', tChat: '💬 聊天软件', tBrowser: '🌐 浏览器', tDeep: '🤿 深度',
    tOrganize: '🗂️ 智能整理', tDup: '👥 重复检测', tSimilar: '🖼️ 相似图片', tAuto: '📥 自动化',
    tStartup: '启动项', tProcess: '进程', tSnapshot: '⏳ 时光机',
    tHealth: '体检', tSettings: '⚙️ 设置中心', tRedlines: '📜 安全红线', tSunburst: '🌞 旭日图', tTop50: '🏆 TOP 50 大文件', tTopDirs: '📁 TOP 20 文件夹', tTypes: '📊 类型分布', tCompare: '💾 磁盘对比', tOverview: '📊 系统概况', tStartup: '🚀 启动项', tProcess: '🧠 进程内存'
  },
  en: {
    tImages: '🖼️ Images', tVideos: '🎬 Videos', tTimeline: '🗓️ Timeline', tGeo: '📍 Places',
    tSunburst: 'Sunburst', tTop50: 'Top 50 files', tTopDirs: 'Top 20 folders', tTypes: 'By type', tCompare: 'Compare drives',
    tJunk: '🧹 Junk', tRecycle: '♻️ Recycle bin', tEmpty: '📂 Empty folders', tResidue: '🧟 Leftovers', tChat: '💬 Chat apps', tBrowser: '🌐 Browsers', tDeep: '🤿 Deep clean',
    tOrganize: '🗂️ Smart organize', tDup: '👥 Duplicates', tSimilar: '🖼️ Similar photos', tAuto: '📥 Automation',
    tStartup: 'Startup', tProcess: 'Processes', tSnapshot: '⏳ Time machine',
    tHealth: 'Checkup', tSettings: '⚙️ Settings', tRedlines: '📜 Safety guardrails', tSunburst: '🌞 Sunburst', tTop50: '🏆 Top 50 files', tTopDirs: '📁 Top 20 folders', tTypes: '📊 By type', tCompare: '💾 Compare drives', tOverview: '📊 Overview', tStartup: '🚀 Startup', tProcess: '🧠 Processes'
  }
}

/** v4.2：高频按钮/通用 */
export const BUTTONS = {
  zh: {
    bScan: '开始扫描', bRescan: '强制重扫', bRefresh: '刷新', bBack: '返回', bConfirm: '确认', bCancel: '取消',
    bClose: '关闭', bDelete: '删除', bLocate: '定位', bPreview: '预览', bPlay: '播放', bAll: '全部',
    bAdd: '添加监视', bRemove: '移除', bSave: '保存', bEdit: '编辑', bDone: '完成', bClean: '确认清理',
    bUndo: '撤销本次清理', bRollback: '回滚上次整理', bRestoreAll: '全部恢复', bShowAll: '展示全部',
    bCollect: '收藏点', bUp: '上级', bEnter: '进入 →', bEmpty: '暂无数据', bLoading: '加载中…'
  },
  en: {
    bScan: 'Scan now', bRescan: 'Force rescan', bRefresh: 'Refresh', bBack: 'Back', bConfirm: 'Confirm', bCancel: 'Cancel',
    bClose: 'Close', bDelete: 'Delete', bLocate: 'Locate', bPreview: 'Preview', bPlay: 'Play', bAll: 'All',
    bAdd: 'Add watch', bRemove: 'Remove', bSave: 'Save', bEdit: 'Edit', bDone: 'Done', bClean: 'Clean now',
    bUndo: 'Undo this clean', bRollback: 'Rollback last organize', bRestoreAll: 'Restore all', bShowAll: 'Show all',
    bCollect: 'Folders', bUp: 'Up', bEnter: 'Enter →', bEmpty: 'No data yet', bLoading: 'Loading…'
  }
}

/** 导航与页面骨架 */
export const NAV = {
  zh: {
    home: '管家', insight: '透视', clean: '清扫', organize: '整理', speed: '提速', media: '媒体',
    scanC: '开始扫描 C 盘', checkup: '一键体检', recycle: '打开回收站', update: '检查更新',
    search: '搜索', bootTime: '开机时长', cDiskFree: 'C 盘剩余', all: '全部',
    empty: '暂无数据', loading: '加载中…', confirm: '确认', cancel: '取消', close: '关闭',
    undo: '撤销', restore: '恢复', delete: '删除', locate: '定位', preview: '预览',
    play: '播放', settings: '设置', language: '界面语言', done: '完成', failed: '失败',
    safetyOn: '安全红线已启用', brandBanner: '点击查看大图'
  },
  en: {
    home: 'Butler', insight: 'Insight', clean: 'Clean', organize: 'Organize', speed: 'Speed', media: 'Media',
    scanC: 'Scan C: drive', checkup: 'One-click checkup', recycle: 'Open recycle bin', update: 'Check for updates',
    search: 'Search', bootTime: 'Uptime', cDiskFree: 'C: free', all: 'All',
    empty: 'No data', loading: 'Loading…', confirm: 'Confirm', cancel: 'Cancel', close: 'Close',
    undo: 'Undo', restore: 'Restore', delete: 'Delete', locate: 'Locate', preview: 'Preview',
    play: 'Play', settings: 'Settings', language: 'Language', done: 'Done', failed: 'Failed',
    safetyOn: 'Safety guardrails on', brandBanner: 'Click to enlarge'
  }
}

/** 清扫/清理通用 */
export const CLEAN = {
  zh: {
    junk: '垃圾清扫', browser: '浏览器', chat: '聊天软件', deep: '深度',
    residue: '卸载残留', emptyDirs: '空文件夹', safe: '安全', caution: '谨慎',
    softDeleted: '已软删除（回收站可恢复）', previewFirst: '删除前预览明细',
    winSxs: 'WinSxS 组件仓库', restorePoints: '系统还原点', hiberfil: '休眠文件',
    pagefile: '页面文件（永不清理）', irreversible: '不可逆操作——请输入"确认"',
    bookmarks: '书签', passwords: '密码', history: '历史记录', physicallyIsolated: '物理隔离'
  },
  en: {
    junk: 'Junk', browser: 'Browsers', chat: 'Chat apps', deep: 'Deep clean',
    residue: 'Uninstall leftovers', emptyDirs: 'Empty folders', safe: 'Safe', caution: 'Caution',
    softDeleted: 'Soft-deleted (recoverable in bin)', previewFirst: 'Preview before deleting',
    winSxs: 'WinSxS component store', restorePoints: 'Restore points', hiberfil: 'Hibernation file',
    pagefile: 'Page file (never touched)', irreversible: 'Irreversible — type "confirm"',
    bookmarks: 'Bookmarks', passwords: 'Passwords', history: 'History', physicallyIsolated: 'physically isolated'
  }
}

/** 媒体 */
export const MEDIA = {
  zh: {
    images: '图片', videos: '视频', timeline: '时间线', showAll: '展示全部',
    collectPoints: '收藏点', thatDay: '那年今天', indexedRoots: '已索引的盘',
    noExif: '无拍摄时间，按文件时间归位', indexEmpty: '索引为空——先去「透视」扫描磁盘'
  },
  en: {
    images: 'Images', videos: 'Videos', timeline: 'Timeline', showAll: 'Show all',
    collectPoints: 'Folders', thatDay: 'On this day', indexedRoots: 'Indexed roots',
    noExif: 'No EXIF, placed by file time', indexEmpty: 'Index empty — scan a drive in Insight first'
  }
}

export type Lang = 'zh' | 'en'

/** 全词典合并视图（测试 key 一致性用） */
export function dict(lang: Lang): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const sec of [NAV, TABS, BUTTONS, CLEAN, MEDIA]) {
    for (const [k, v] of Object.entries(sec[lang])) merged[k] = v
  }
  return merged
}
