/** 生成 32x32 托盘图标 PNG（纯 Node：手写 PNG 块 + zlib），输出 dataURL 供嵌入 tray.ts */
const zlib = require('zlib')

const W = 32, H = 32
// 圆角矩形参数：margin=2, radius=10；垂直渐变 #9CC2FF → #6EA8FF，描边深蓝
const px = (x, y) => {
  const m = 2, r = 10, x2 = W - 1 - m, y2 = H - 1 - m
  const inRR = (x0, y0) => {
    if (x0 < m || y0 < m || x0 > x2 || y0 > y2) return false
    const cx = Math.max(m + r, Math.min(x0, x2 - r))
    const cy = Math.max(m + r, Math.min(y0, y2 - r))
    return (x0 - cx) ** 2 + (y0 - cy) ** 2 <= r * r
  }
  const inside = inRR(x, y)
  const edge = inside && !(inRR(x + 1, y) && inRR(x - 1, y) && inRR(x, y + 1) && inRR(x, y - 1))
  const t = (y - m) / (H - 1 - 2 * m)
  const lr = (n) => Math.round(156 + (110 - 156) * t + n)
  const lg = (n) => Math.round(194 + (168 - 194) * t + n)
  const lb = (n) => Math.round(255 + (255 - 255) * t + n)
  if (edge) return [90, 140, 230, 255]
  if (inside) return [lr(0), lg(0), lb(0), 255]
  return [0, 0, 0, 0]
}

// 原始扫描线（每行 filter byte 0 + RGBA）
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4)
  raw[row] = 0
  for (let x = 0; x < W; x++) {
    const [r, g, b, a] = px(x, y)
    const o = row + 1 + x * 4
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
  }
}

// PNG 块
function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
console.log('data:image/png;base64,' + png.toString('base64'))
