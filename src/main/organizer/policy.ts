/**
 * 查重保留策略（v1.1 / M3 规格补齐）
 * earliest（默认建议）/ latest / shortest-path
 */
export type Policy = 'earliest' | 'latest' | 'shortest-path'

export interface PickResult {
  keep: { path: string; size: number; mtime: number } | null
  victims: Array<{ path: string; size: number; mtime: number }>
}

export function pickByPolicy(
  files: Array<{ path: string; size: number; mtime: number }>,
  policy: Policy
): PickResult {
  if (files.length === 0) return { keep: null, victims: [] }
  const sorted = [...files]
  switch (policy) {
    case 'latest':
      sorted.sort((a, b) => b.mtime - a.mtime || pathLen(a.path) - pathLen(b.path))
      break
    case 'shortest-path':
      sorted.sort((a, b) => pathLen(a.path) - pathLen(b.path) || a.mtime - b.mtime)
      break
    case 'earliest':
    default:
      sorted.sort((a, b) => a.mtime - b.mtime || pathLen(a.path) - pathLen(b.path))
      break
  }
  const [keep, ...victims] = sorted
  return { keep, victims }
}

function pathLen(p: string): number {
  return p.length
}

export const POLICY_LABEL: Record<Policy, string> = {
  earliest: '保留最早',
  latest: '保留最新',
  'shortest-path': '保留浅路径'
}
