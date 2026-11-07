import type { MotionRole } from '../vrm/motion/clips'

/**
 * ファイル名の先頭の印（「(待機)Idle.fbx」「【あいさつ】Wave.vrma」「喜ぶ_Clap.fbx」など）から、動きの役を決める。
 * 印の言葉は、役の表示名とその言い換え。印が無い・知らない言葉なら null（利用者に選んでもらう）
 */
const ROLE_WORDS: Record<MotionRole, string[]> = {
  idle: ['待機', 'idle'],
  thinking: ['考え中', '考える', 'thinking', 'think'],
  working: ['作業中', '作業', 'working', 'work'],
  talking: ['話している', '話す', '会話', 'talking', 'talk'],
  greet: ['あいさつ', '挨拶', 'greet', 'greeting'],
  joy: ['喜ぶ', '喜び', 'joy'],
  play: ['気まぐれ', 'play'],
}

const BRACKETED = /^\s*[(（[【〔]\s*([^)）\]】〕]+?)\s*[)）\]】〕]/
const PREFIXED = /^\s*([^_\-\s・]+)[_\-\s・]/

export function roleFromFileName(name: string): MotionRole | null {
  const tag = (BRACKETED.exec(name) ?? PREFIXED.exec(name))?.[1]?.toLowerCase()
  if (!tag) return null
  for (const [role, words] of Object.entries(ROLE_WORDS) as [MotionRole, string[]][]) {
    if (words.includes(tag)) return role
  }
  return null
}

/** 動きのファイルとして受け付ける拡張子か */
export function isMotionFileName(name: string): boolean {
  return /\.(vrma|fbx)$/i.test(name)
}
