import type { UsageResponse } from '@aicarnation/shared'
import type { Env } from './env'

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
  const row = await env.DB.prepare('SELECT count FROM usage_counters WHERE key = ?1').bind(usageKey(anonId)).first<{ count: number }>()
  return { used: row?.count ?? 0, limit: dailyLimit(env), resetsAt: nextResetJst() }
}

/** すべての利用者を合わせた1日の上限が読めないときの値 */
const FALLBACK_GLOBAL_LIMIT = 1000
/** 声の推薦（作成画面から自動で呼ぶ軽い処理）の、利用者ごとの1日の上限。会話の回数とは別に数える */
export const DAILY_VOICE_SUGGEST_LIMIT = 50

export function globalLimit(env: Env): number {
  const limit = Number(env.DAILY_GLOBAL_LIMIT)
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : FALLBACK_GLOBAL_LIMIT
}

function globalKey(): string {
  return `usage:global:${todayJst()}`
}

/** 古い日の数を、ときどき消す割合（数えるたびに消すと無駄なので、たまにだけ） */
const CLEANUP_CHANCE = 0.02

/**
 * 数を 1 つ増やす。上限に達していれば増やさずに null、増やせたら増やしたあとの数を返す。
 * 「上限より少なければ増やす」を 1 つの SQL で行うので、同時に大量に送られても上限を超えて通らない
 * （読んでから書く作りだと、同時に読んだ全員が同じ数を見て通ってしまう）
 */
async function take(env: Env, key: string, limit: number): Promise<number | null> {
  if (limit <= 0) return null
  const row = await env.DB.prepare(
    `INSERT INTO usage_counters (key, count, day) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE usage_counters.count < ?3
     RETURNING count`,
  )
    .bind(key, todayJst(), limit)
    .first<{ count: number }>()
  return row?.count ?? null
}

/** 前の日までの数を消す（失敗しても、数えるほうには影響させない） */
async function cleanupOldCounters(env: Env): Promise<void> {
  if (Math.random() >= CLEANUP_CHANCE) return
  await env.DB.prepare('DELETE FROM usage_counters WHERE day < ?1')
    .bind(todayJst())
    .run()
    .catch(() => undefined)
}

/**
 * モデルを呼ぶ前に、1回分の利用を確保する（上限を超えていれば null）。
 * 呼んだあとに数えると、途中で接続を切る・失敗させるなどで数え漏れて上限を逃れられるため、先に数えて戻さない。
 * 利用者ごとの上限に加えて、すべての利用者を合わせた上限も見る（匿名 ID を作り直しても、ここで止まる）。
 * 先に利用者ごとの数を取る：全体の数を先に取ると、自分の上限に達した利用者が送り続けるだけで、全体の枠を使い切れてしまう
 */
export async function reserveUsage(env: Env, anonId: string): Promise<UsageResponse | null> {
  const limit = dailyLimit(env)
  const used = await take(env, usageKey(anonId), limit)
  if (used === null) return null
  if ((await take(env, globalKey(), globalLimit(env))) === null) return null
  await cleanupOldCounters(env)
  return { used, limit, resetsAt: nextResetJst() }
}

/**
 * 声の推薦を1回分確保する（利用者ごとに1日 DAILY_VOICE_SUGGEST_LIMIT 回まで。超えたら false）。
 * 全体の上限にも数える：利用者ごとの数だけだと、匿名 ID を作り直すたびに枠が増え、全体の上限の外でモデルを呼べてしまう
 */
export async function reserveVoiceSuggestion(env: Env, anonId: string): Promise<boolean> {
  if ((await take(env, `voice:${anonId}:${todayJst()}`, DAILY_VOICE_SUGGEST_LIMIT)) === null) return false
  return (await take(env, globalKey(), globalLimit(env))) !== null
}
