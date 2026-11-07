import type {
  AgentDefinition,
  GenerateAgentRequest,
  GeneratedAgent,
  SuggestVoiceRequest,
  SuggestVoiceResponse,
} from '@aicarnation/shared'
import { ApiError, apiFetch, errorFromResponse } from './client'
import { IS_COMPANION, companionHeaders } from '../runtime'

/**
 * 同梱版では、モデルを使う依頼を同梱サーバー経由で Claude Code（mod）に頼む。
 * Claude Code のモデルで答えるので API キーは要らない
 */
async function askCompanion<T>(op: string, payload: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch('/companion/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...companionHeaders() },
      body: JSON.stringify({ op, payload }),
    })
  } catch {
    throw new ApiError('network', 'Claude Code に接続できません')
  }
  if (!res.ok) throw await errorFromResponse(res)
  return (await res.json()) as T
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await errorFromResponse(res)
  return (await res.json()) as T
}

/** 説明文・画像からエージェント定義を作る（/agents/generate） */
export function generateAgent(req: GenerateAgentRequest): Promise<GeneratedAgent> {
  return IS_COMPANION ? askCompanion('generate-agent', req) : postJson('/agents/generate', req)
}

/** エージェントに合う声を推薦してもらう（/agents/suggest-voice） */
export function suggestVoice(req: SuggestVoiceRequest): Promise<SuggestVoiceResponse> {
  return IS_COMPANION ? askCompanion('suggest-voice', req) : postJson('/agents/suggest-voice', req)
}

/** 台詞帳を作ってもらう依頼（同梱版だけ。Claude Code のモデルで作る） */
export interface GenerateLinesRequest {
  agent: Pick<AgentDefinition, 'name' | 'firstPerson' | 'tone' | 'personality' | 'background'>
  /** 場面の名前 → 説明 */
  scenes: Record<string, string>
}

/** 場面ごとの台詞（感情タグ付き）。検証は呼び出し側で行う */
export function generateLines(req: GenerateLinesRequest): Promise<unknown> {
  if (!IS_COMPANION) return Promise.reject(new ApiError('not_found', '台詞帳は同梱版でのみ作成できます'))
  return askCompanion('generate-lines', req)
}

/** 定義JSONを D1 に同期する。ローカルが正なので、失敗しても呼び出し側の処理は続ける */
export async function syncAgent(agent: AgentDefinition): Promise<void> {
  // 同梱版は端末の中だけで完結し、D1 への同期は無い
  if (IS_COMPANION) return
  const res = await apiFetch(`/agents/${encodeURIComponent(agent.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  })
  if (!res.ok) throw await errorFromResponse(res)
}

export async function deleteRemoteAgent(id: string): Promise<void> {
  if (IS_COMPANION) return
  const res = await apiFetch(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw await errorFromResponse(res)
}
