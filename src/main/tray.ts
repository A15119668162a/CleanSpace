/**
 * 系统托盘（v1.3）
 * 常驻托盘：显示主窗、一键体检、每周体检开关、退出
 * 关闭行为：close_to_tray 设置开启时点 X 最小化到托盘（默认开）
 */
import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'

let tray: Tray | null = null

/** 32x32 圆角渐变蓝图标（dataURL 内嵌，免资源文件） */
const ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA5UlEQVR42u3XSQrCMBTGcc/pKRQRRRRRRBQHRBHRGziPdR4v4zU+eYvuzNA27y3EwG/TpM1/FdJY7D8CjnjzDR32DUcvaDkL8j8wfCKSUCH0wuABp6wjaGH/DhZWEbSodwMLYwAt6F7BShtBk50LWBkD2mewMga0TmClDKCJxhEivkbQw/oBIpQBtT1EKAOqHkQoAyoeRCgDyjuIUAaUthChDChuIEJ7FhTWYGU8CfMrsDIG5JZgZQzILsDK6k6QmYOF9Y0oPQOLQPfC1BROhboZk+QEkTj7P/AlxtAS/1Ni3/DnxwfUHikVYq27XgAAAABJRU5ErkJggg=='
)
/** 预警态图标：整体偏红（同源像素级转换） */
const ICON_ALERT = ICON.createFromBuffer(
  (() => {
    const buf = ICON.toBitmap() // BGRA raw
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] === 0) continue // 透明跳过
      // 蓝色调 → 红色调：B 降 R 升
      const b = buf[i], g = buf[i + 1], r = buf[i + 2]
      buf[i] = Math.min(255, r + 60)      // B ← 提亮
      buf[i + 1] = Math.round(g * 0.55)   // G 压暗
      buf[i + 2] = Math.max(30, Math.round(b * 0.85)) // R ← 原蓝
    }
    return buf
  })(),
  { width: 32, height: 32 }
)

/** 预警模式：托盘图标变红 + tooltip（v2.1 F4） */
export function setTrayAlert(on: boolean): void {
  if (!tray) return
  tray.setImage(on ? ICON_ALERT : ICON)
  tray.setToolTip(on ? '净澈 CleanSpace · ⚠️ 磁盘空间告急' : '净澈 CleanSpace')
}

export interface TrayHandlers {
  onCheckup: () => void
  weeklyScanEnabled: () => boolean
  onToggleWeekly: (on: boolean) => void
  closeToTrayEnabled: () => boolean
}

export function createTray(h: TrayHandlers): Tray {
  if (tray) return tray
  tray = new Tray(ICON)
  tray.setToolTip('净澈 CleanSpace')

  const rebuild = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: '显示净澈', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '立即体检', click: () => { showMainWindow(); h.onCheckup() } },
      { label: '每周自动体检', type: 'checkbox', checked: h.weeklyScanEnabled(), click: (mi) => h.onToggleWeekly(mi.checked) },
      { label: '关闭时最小化到托盘', type: 'checkbox', checked: h.closeToTrayEnabled(), click: () => { /* 由设置页管理，此处仅展示状态 */ } },
      { type: 'separator' },
      { label: '退出', click: () => { app.exit(0) } }
    ])
    tray!.setContextMenu(menu)
  }
  rebuild()
  tray.on('double-click', () => showMainWindow())
  // 每次显示菜单前刷新勾选态
  tray.on('right-click', () => rebuild())
  return tray
}

export function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/** 关闭行为判定：true = 最小化到托盘；false = 真退出 */
export function shouldKeepInTray(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('close_to_tray') as { value: string } | undefined
  return row ? row.value === '1' : true // 默认开
}
