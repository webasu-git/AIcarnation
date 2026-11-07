import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { allowedOrigins, createApp } from '../src/app'
import { createMockModel } from '../src/claude'
import { createMockGenerator } from '../src/generator'
import { createMockVoiceSuggester } from '../src/voice'
import { dailyLimit, nextResetJst, todayJst } from '../src/usage'
import type { Env } from '../src/env'

const app = createApp({
  getModel: () => createMockModel(),
  getGenerator: () => createMockGenerator(),
  getVoiceSuggester: () => createMockVoiceSuggester(),
})
const ALLOWED = 'http://localhost:5173'

describe('CORS', () => {
  it('許可したオリジンのプリフライトには許可ヘッダーを返す', async () => {
    const res = await app.request(
      '/chat',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      },
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED)
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization')
  })

  it('許可していないオリジンのプリフライトには許可ヘッダーを返さない', async () => {
    const res = await app.request(
      '/chat',
      { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } },
      env,
    )
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('許可していないオリジンからのリクエストは 403', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } }, env)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'forbidden_origin' })
  })

  it('Origin の無いリクエスト（同一オリジンのプロキシ経由）は通す', async () => {
    expect((await app.request('/health', {}, env)).status).toBe(200)
  })

  it('ALLOWED_ORIGINS は空要素と末尾のスラッシュを除いて読む', () => {
    expect(allowedOrigins(' http://a.example/, ,https://b.example ')).toEqual(['http://a.example', 'https://b.example'])
    expect(allowedOrigins(undefined)).toEqual([])
  })
})

describe('利用回数', () => {
  it('日付の区切りは日本時間', () => {
    // 2026-10-24 14:59 UTC = 23:59 JST、15:00 UTC = 翌 0:00 JST
    expect(todayJst(Date.UTC(2026, 9, 24, 14, 59))).toBe('2026-10-24')
    expect(todayJst(Date.UTC(2026, 9, 24, 15, 0))).toBe('2026-10-25')
  })

  it('次のリセットは日本時間の0時', () => {
    expect(nextResetJst(Date.UTC(2026, 9, 24, 3, 0))).toBe('2026-10-24T15:00:00.000Z')
    expect(nextResetJst(Date.UTC(2026, 9, 24, 15, 0))).toBe('2026-10-25T15:00:00.000Z')
  })

  it('上限の設定が読めなければ 100 回にする', () => {
    const withLimit = (DAILY_CHAT_LIMIT: string) => ({ DAILY_CHAT_LIMIT }) as Env
    expect(dailyLimit(withLimit('30'))).toBe(30)
    expect(dailyLimit(withLimit('abc'))).toBe(100)
    expect(dailyLimit(withLimit('-1'))).toBe(100)
  })
})
