/** 頭文字の丸いアイコンの色。ID から決めるので、同じキャラクターはいつも同じ色 */
const AVATAR_COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#0ea5e9', '#ef4444', '#22c55e']

export function avatarColor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]!
}
