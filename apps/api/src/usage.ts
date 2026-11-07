import type { UsageResponse } from '@aicarnation/shared'
import type { Env } from './env'

const TTL_SECONDS = 60 * 60 * 24 * 2
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** DAILY_CHAT_LIMIT が読めないときの上限 */
const FALLBACK_LIMIT = 100

export const USAGE_LIMIT_MESSAGE = '今日の利用回数の上限に達しました。日本時間の0時にリセットされます'

/** 利用者は日本向けなので、日付の区切りは日本時間にする */
export function todayJst(now = Date.now()): string {
  return new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 次に利用回数がリセットされる時刻（日本時間の0時）を ISO8601 で返す */
export function nextResetJst(now = Date.now()): string {
  const jstMidnight = Math.floor((now + JST_OFFSET_MS) / DAY_MS) * DAY_MS
  return new Date(jstMidnight + DAY_MS - JST_OFFSET_MS).toISOString()
}

export function dailyLimit(env: Env): number {
  const limit = Number(env.DAILY_CHAT_LIMIT)
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : FALLBACK_LIMIT
}

function usageKey(anonId: string): string {
  return `usage:${anonId}:${todayJst()}`
}

export async function getUsage(env: Env, anonId: string): Promise<UsageResponse> {
  const used = Number((await env.USAGE.get(usageKey(anonId))) ?? 0)
  return { used, limit: dailyLimit(env), resetsAt: nextResetJst() }
}

/** すべての利用者を合わせた1日の上限が読めないときの値 */
const FALLBACK_GLOBAL_LIMIT = 1000
/** 声の推薦（作成画面から自動で呼ぶ軽い処理）の、利用者ごとの1日の上限。会話の回数とは別に数える */
export const DAILY_VOICE_SUGGEST_LIMIT = 50

export function globalLimit(env: Env): number {
  const limit = Number(env.DAILY_GLOBAL_LIMIT)
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : FALLBACK_GLOBAL_LIMIT
}

async function count(env: Env, key: string): Promise<number> {
  return Number((await env.USAGE.get(key)) ?? 0)
}

async function bump(env: Env, key: string, used: number): Promise<void> {
  await env.USAGE.put(key, String(used + 1), { expirationTtl: TTL_SECONDS })
}

/**
 * モデルを呼ぶ前に、1回分の利用を確保する（上限を超えていれば null）。
 * 呼んだあとに数えると、途中で接続を切る・失敗させるなどで数え漏れて上限を逃れられるため、先に数えて戻さない。
 * 利用者ごとの上限に加えて、すべての利用者を合わせた上限も見る（匿名 ID を作り直しても、ここで止まる）。
 * KV は読み書きが原子的でないため、同時に送られると少し多めに通ることがある（目安としては許容する）
 */
export async function reserveUsage(env: Env, anonId: string): Promise<UsageResponse | null> {
  const key = usageKey(anonId)
  const globalKey = `usage:global:${todayJst()}`
  const [used, globalUsed] = await Promise.all([count(env, key), count(env, globalKey)])
  const limit = dailyLimit(env)
  if (used >= limit || globalUsed >= globalLimit(env)) return null
  await Promise.all([bump(env, key, used), bump(env, globalKey, globalUsed)])
  return { used: used + 1, limit, resetsAt: nextResetJst() }
}

/** 声の推薦を1回分確保する（利用者ごとに1日 DAILY_VOICE_SUGGEST_LIMIT 回まで。超えたら false） */
export async function reserveVoiceSuggestion(env: Env, anonId: string): Promise<boolean> {
  const key = `voice:${anonId}:${todayJst()}`
  const used = await count(env, key)
  if (used >= DAILY_VOICE_SUGGEST_LIMIT) return false
  await bump(env, key, used)
  return true
}
