import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createApp } from '../src/app'
import type { ChatModel, ChatStreamParams } from '../src/claude'
import { SAFETY_GUARD } from '../src/guard'
import { createMockGenerator } from '../src/generator'
import { createMockVoiceSuggester } from '../src/voice'

const ORIGIN = 'http://localhost:5173'

/** 受け取った引数を記録し、決めた文字列を流すモック */
function mockModel(chunks: string[], stopReason = 'end_turn') {
  const calls: ChatStreamParams[] = []
  const model: ChatModel = {
    async stream(params, onText) {
      calls.push(params)
      for (const c of chunks) await onText(c)
      return { stopReason, inputTokens: 10, outputTokens: 5 }
    },
  }
  return { model, calls }
}

function throwingModel(err: unknown): ChatModel {
  return {
    async stream() {
      throw err
    },
  }
}

function appWith(model: ChatModel) {
  return createApp({ getModel: () => model, getGenerator: () => createMockGenerator(), getVoiceSuggester: () => createMockVoiceSuggester() })
}

async function registeredId(app: ReturnType<typeof appWith>): Promise<string> {
  const id = crypto.randomUUID()
  const res = await app.request('/auth/anon', { method: 'POST', headers: { Authorization: `Bearer ${id}` } }, env)
  expect(res.status).toBe(200)
  return id
}

function chatRequest(anonId: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${anonId}`, 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  }
}

const validBody = {
  agentId: 'default',
  systemPrompt: 'あなたはミナです。',
  messages: [{ role: 'user', content: 'こんにちは' }],
}

function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? ''
      const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? 'null'
      return { event, data: JSON.parse(data) }
    })
}

describe('認証', () => {
  it('Authorization が無いと 401', async () => {
    const res = await appWith(mockModel([]).model).request('/chat', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('未登録の匿名IDは 401', async () => {
    const app = appWith(mockModel([]).model)
    const res = await app.request('/chat', chatRequest(crypto.randomUUID(), validBody), env)
    expect(res.status).toBe(401)
  })

  it('UUID でない値は 401', async () => {
    const app = appWith(mockModel([]).model)
    const res = await app.request('/auth/anon', { method: 'POST', headers: { Authorization: 'Bearer abc' } }, env)
    expect(res.status).toBe(401)
  })
})

describe('/chat の入力検証', () => {
  const cases: [string, unknown][] = [
    ['messages が空', { ...validBody, messages: [] }],
    ['4000文字を超える', { ...validBody, messages: [{ role: 'user', content: 'あ'.repeat(4001) }] }],
    ['最後がアシスタント', { ...validBody, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }],
    ['41件を超える', { ...validBody, messages: Array.from({ length: 43 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) }],
    ['role が不正', { ...validBody, messages: [{ role: 'system', content: 'x' }] }],
  ]
  it.each(cases)('%s なら 400', async (_, body) => {
    const app = appWith(mockModel([]).model)
    const id = await registeredId(app)
    const res = await app.request('/chat', chatRequest(id, body), env)
    expect(res.status).toBe(400)
  })
})

describe('/chat のストリーミング', () => {
  it('テキストを delta で流し、done で終わる。安全ガード文を末尾に付ける', async () => {
    const { model, calls } = mockModel(['[happy]こん', 'にちは！'])
    const app = appWith(model)
    const id = await registeredId(app)

    const res = await app.request('/chat', chatRequest(id, validBody), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)

    const events = parseSse(await res.text())
    expect(events).toEqual([
      { event: 'delta', data: { text: '[happy]こん' } },
      { event: 'delta', data: { text: 'にちは！' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ])
    expect(calls[0]?.system.startsWith('<character_definition>\nあなたはミナです。')).toBe(true)
    expect(calls[0]?.system.endsWith(SAFETY_GUARD)).toBe(true)
    expect(calls[0]?.messages).toEqual(validBody.messages)
  })

  it('完了ごとに利用回数を数え、上限を超えると 429', async () => {
    const app = appWith(mockModel(['はい']).model)
    const id = await registeredId(app)
    const auth = { headers: { Authorization: `Bearer ${id}` } }

    for (let i = 0; i < 2; i++) {
      const res = await app.request('/chat', chatRequest(id, validBody), env)
      await res.text()
    }
    expect(await (await app.request('/usage', auth, env)).json()).toMatchObject({ used: 2, limit: 2 })

    const res = await app.request('/chat', chatRequest(id, validBody), env)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'usage_limit' })
  })

  it('refusal で止まったら error(refusal) を流す', async () => {
    const app = appWith(mockModel(['…'], 'refusal').model)
    const id = await registeredId(app)
    const events = parseSse(await (await app.request('/chat', chatRequest(id, validBody), env)).text())
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'refusal' } })
  })

  it('Claude API の 429 は upstream_busy、それ以外は upstream_error', async () => {
    const busy = new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers())
    for (const [err, code] of [
      [busy, 'upstream_busy'],
      [new Error('boom'), 'upstream_error'],
    ] as const) {
      const app = appWith(throwingModel(err))
      const id = await registeredId(app)
      const events = parseSse(await (await app.request('/chat', chatRequest(id, validBody), env)).text())
      expect(events).toEqual([{ event: 'error', data: expect.objectContaining({ code }) }])
    }
  })
})
