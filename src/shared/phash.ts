/**
 * pHash 感知哈希（v2.0 / F1）
 * 32×32 灰度 → DCT-II → 左上 8×8 低频 → 64bit 指纹
 * 海明距离 ≤ 阈值 = 像素级相似（连拍/缩放/多备份）
 * 纯函数实现（无 IO），worker 与测试共用
 */

/** 从 32×32=1024 灰度数组计算 64bit 指纹（hex 16 字符） */
export function phashFromGray(gray: Float64Array): string {
  const N = 32
  // DCT-II 行变换
  const rows = new Float64Array(N * N)
  for (let u = 0; u < N; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1
    for (let x = 0; x < N; x++) {
      let s = 0
      for (let y = 0; y < N; y++) s += gray[y * N + x] * Math.cos((2 * y + 1) * u * Math.PI / (2 * N))
      rows[u * N + x] = cu * s
    }
  }
  // 列变换（复用缓存 cos）
  const cos = new Float64Array(N * N)
  for (let v = 0; v < N; v++) for (let y = 0; y < N; y++) cos[v * N + y] = Math.cos((2 * y + 1) * v * Math.PI / (2 * N))
  const dct = new Float64Array(N * N)
  for (let v = 0; v < N; v++) {
    const cv = v === 0 ? Math.SQRT1_2 : 1
    for (let u = 0; u < N; u++) {
      let s = 0
      for (let x = 0; x < N; x++) s += rows[v * N + x] * cos[u * N + x]
      dct[v * N + u] = cv * s
    }
  }
  // 8×8 低频（跳过 [0,0] DC）均值阈值 → bit
  const flat: number[] = []
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { if (u === 0 && v === 0) continue; flat.push(dct[v * N + u]) }
  flat.sort((a, b) => a - b)
  const median = (flat[31] + flat[32]) / 2
  let bits = ''
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    if (u === 0 && v === 0) continue
    bits += dct[v * N + u] > median ? '1' : '0'
  }
  // bit → hex
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** 海明距离（hex 指纹间） */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

/* ---------------- Union-Find 分组 ---------------- */
export interface HashItem { path: string; hash: string; size: number; mtime: number }

/** 传递闭包分组：a~b 且 b~c ⇒ 同组（比两两直接比较更符合"连拍序列"直觉） */
export function groupSimilar(items: HashItem[], threshold: number): Array<Array<{ path: string; size: number; mtime: number }>> {
  const parent = items.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (hamming(items[i].hash, items[j].hash) <= threshold) union(i, j)
    }
  }
  const groups = new Map<number, Array<{ path: string; size: number; mtime: number }>>()
  items.forEach((it, i) => {
    const r = find(i)
    const arr = groups.get(r) || []
    arr.push({ path: it.path, size: it.size, mtime: it.mtime })
    groups.set(r, arr)
  })
  // 只返回 ≥2 的组，组内按 mtime 升序（保留最早策略基础）
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => g.sort((a, b) => a.mtime - b.mtime))
}
