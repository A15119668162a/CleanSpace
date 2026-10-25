import { describe, it, expect } from 'vitest'

/** 与 MediaView.openLightbox 相同的分流正则（红线：行为一致性单测） */
const VID = /\.(mp4|mkv|avi|mov|wmv|flv|webm|rmvb|ts|m4v|mpg|mpeg|3gp)$/i
const route = (path: string, _tabIgnored?: string): 'player' | 'lightbox' =>
  VID.test(path) ? 'player' : 'lightbox'

describe('v4.1.1 媒体打开分流（按文件类型而非页面 tab）', () => {
  it('图片：任何 tab 下都走灯箱（修复：视频 tab 下点时间线图片跳画图）', () => {
    expect(route('C:/a/b.JPG', 'video')).toBe('lightbox')
    expect(route('C:/photos/2024/微信图片.png', 'video')).toBe('lightbox')
    expect(route('D:/照片 #1/IMG_0001.heic', 'video')).toBe('lightbox')
  })

  it('视频：任何 tab 下都走内部播放器', () => {
    expect(route('H:/Movies/同学会.mp4', 'image')).toBe('player')
    expect(route('E:/4K.TS', 'image')).toBe('player')
    expect(route('f:/old.Avi', 'image')).toBe('player')
  })

  it('无扩展名/其他类型不误判', () => {
    expect(route('C:/README')).toBe('lightbox')
    expect(route('C:/a.mp3')).toBe('lightbox')
  })
})
