/** 扫描结果类型（preload / renderer 共用，与 main/scanner/core 对应） */
export interface FileEntry { path: string; size: number; mtime: number }

export interface DirNode {
  path: string
  name: string
  size: number
  mtime: number
  children: Array<DirNode | FileEntry>
  fileCount: number
  dirCount: number
}

export interface ScanStats {
  totalFiles: number
  totalDirs: number
  totalBytes: number
  errors: number
  skipped: Array<{ path: string; reason: 'denied' | 'error' }>
  durationMs: number
  typeBytes: Record<string, number>
  typeFiles: Record<string, number>
}
