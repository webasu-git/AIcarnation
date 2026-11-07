import type { UsageResponse } from '@aicarnation/shared'
import { apiFetch, errorFromResponse } from './client'

/** 今日の利用回数と上限（/usage） */
export async function fetchUsage(): Promise<UsageResponse> {
  const res = await apiFetch('/usage')
  if (!res.ok) throw await errorFromResponse(res)
  return (await res.json()) as UsageResponse
}
