/** 更新配置与纯函数（与 electron-updater 运行时解耦，测试友好） */
export const UPDATE_URL = 'https://cbxs.top/update/cleanspace/'

/** 滚动保留：给定版本列表返回应删除的旧版本（留新 keep 份） */
export function pruneVersions(existing: string[], keep = 3): string[] {
  const sorted = [...existing].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return sorted.slice(keep)
}
