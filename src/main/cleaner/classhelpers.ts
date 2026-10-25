/** watcher 辅助：按扩展名归档分类（与 classifyFile 口径一致——红线 17） */
export function classifyForMove(path: string): string {
  const name = path.split(/[\\/]/).pop() || ''
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (['exe', 'msi', 'msix'].includes(ext)) return '安装包'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return '压缩包'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return '图片'
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'].includes(ext)) return '视频'
  if (['mp3', 'flac', 'wav', 'aac', 'ogg'].includes(ext)) return '音频'
  if (['doc', 'docx', 'pdf', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'].includes(ext)) return '文档'
  return '其他'
}
